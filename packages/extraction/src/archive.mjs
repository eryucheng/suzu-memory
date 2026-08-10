import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyMemoryCandidate,
  isStatefulMemoryKind,
  normalizeStateAnalysisTargetSpec,
} from "@suzu-memory/core";
import {
  isRetentionReasonCompatible,
} from "./prompt.mjs";
import {
  DIRECT_USER_AGENT_DM_TOPOLOGY,
  buildArchivedUtteranceIdentity,
} from "./utterance-evidence.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "resources", "system-prompt.md");

export function loadLongTermExtractionSystemPrompt(systemPromptPath = DEFAULT_PROMPT_PATH) {
  return fs.readFileSync(systemPromptPath, "utf8").trim();
}

function clean(value) {
  return String(value ?? "").trim();
}

function sourceLanguage(value) {
  const normalized = clean(value).toLowerCase();
  return ["zh", "en", "mixed", "unknown"].includes(normalized)
    ? normalized
    : "unknown";
}

function referencedSourceLanguage(referenced = []) {
  const languages = new Set(referenced
    .map((item) => sourceLanguage(item?.message?.sourceLanguage))
    .filter((value) => value !== "unknown"));
  if (languages.size === 1) return [...languages][0];
  return languages.size > 1 ? "mixed" : "unknown";
}

function stableId(prefix, ...parts) {
  const digest = createHash("sha256")
    .update(parts.map(clean).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${digest}`;
}

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, "utf8");
  fs.renameSync(temporary, filePath);
}

function writeJsonAtomic(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isoTimestamp(value, fallback = null) {
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : fallback;
}

function actorKeyFor(actorRole, actorName, agentId, identity = {}) {
  const primaryUserId = clean(identity?.primaryUserId) || "user";
  const companionId = clean(identity?.companionId) || clean(agentId);
  switch (actorRole) {
    case "user": return primaryUserId;
    case "agent": return companionId;
    case "shared": return `shared:${companionId}:${primaryUserId}`;
    case "other": return clean(actorName).toLocaleLowerCase("zh-CN");
    case "world": return "";
    default: return "";
  }
}

function actorIdentityKeys(agentId, identity = {}) {
  return {
    primaryUserId: clean(identity?.primaryUserId) || "user",
    companionId: clean(identity?.companionId) || clean(agentId),
  };
}

function subjectKeyFor(candidate, agentId, identity) {
  return actorKeyFor(candidate.subjectRole, candidate.subjectName, agentId, identity);
}

function requestTargetSpec(candidate, agentId, identity) {
  const target = candidate.stateTarget || {};
  if (candidate.stateFamily === "identity") {
    return normalizeStateAnalysisTargetSpec("identity", {
      identityField: target.identityField,
      fieldCardinality: target.fieldCardinality,
    }, { allowEmpty: false });
  }
  if (candidate.stateFamily === "belief") {
    return normalizeStateAnalysisTargetSpec("belief", {
      objectRole: target.objectRole,
      objectKey: actorKeyFor(target.objectRole, target.objectName, agentId, identity),
      objectLabel: target.objectName,
    }, { allowEmpty: false });
  }
  if (candidate.stateFamily === "relationship") {
    return normalizeStateAnalysisTargetSpec("relationship", {
      counterpartRole: target.counterpartRole,
      counterpartKey: actorKeyFor(
        target.counterpartRole,
        target.counterpartName,
        agentId,
        identity,
      ),
      counterpartLabel: target.counterpartName,
      direction: target.direction,
    }, { allowEmpty: false });
  }
  if (candidate.stateFamily === "affective_association") {
    return normalizeStateAnalysisTargetSpec("affective_association", {
      triggerRole: target.triggerRole,
      triggerKey: actorKeyFor(target.triggerRole, target.triggerName, agentId, identity),
      triggerLabel: target.triggerName,
    }, { allowEmpty: false });
  }
  return {};
}

function structuredActorRoles(candidate, agentId, identity) {
  const roles = (Array.isArray(candidate.actorRoles) ? candidate.actorRoles : []).map((actor) => ({
    role: actor.role,
    actorRole: actor.actorRole,
    actorKey: actorKeyFor(actor.actorRole, actor.actorName, agentId, identity),
    isPrimary: false,
    confidence: actor.confidence,
    provenance: "suzu-memory-extraction-v1",
    metadata: { actorName: clean(actor.actorName) },
  }));
  const holderRole = candidate.kind === "belief_state"
    ? "belief_holder"
    : candidate.kind === "preference" ? "preference_holder" : "";
  if (holderRole && candidate.subjectRole !== "unknown") {
    const subjectKey = subjectKeyFor(candidate, agentId, identity);
    if (!roles.some((actor) => (
      actor.role === holderRole
      && actor.actorRole === candidate.subjectRole
      && actor.actorKey === subjectKey
    ))) {
      roles.push({
        role: holderRole,
        actorRole: candidate.subjectRole,
        actorKey: subjectKey,
        isPrimary: true,
        confidence: candidate.confidence,
        provenance: "suzu-memory-extraction-v1-kind-subject",
        metadata: { actorName: clean(candidate.subjectName) },
      });
    }
  }
  return roles;
}

function firstEvidenceTime(referenced, fallback) {
  return referenced.reduce((earliest, item) => {
    const timestamp = isoTimestamp(item.message.timestamp);
    return timestamp && (!earliest || timestamp < earliest) ? timestamp : earliest;
  }, "") || fallback;
}

function decisionForResult(result) {
  if (result.status === "review") return "review";
  if (result.status === "reject") return "reject";
  if (result.stateAnalysisRequestId) return "store";
  return result.memoryId ? "store" : "reject";
}

function sameNamedActor(candidate, actor) {
  if (actor.actorRole !== candidate.subjectRole) return false;
  if (candidate.subjectRole !== "other") return true;
  return clean(actor.actorName).toLocaleLowerCase("zh-CN")
    === clean(candidate.subjectName).toLocaleLowerCase("zh-CN");
}

function evidenceAlignmentProblems(candidate, referencedMessages) {
  const problems = new Set();
  const hasUserEvidence = referencedMessages.some((message) => message.role === "user");
  const hasAgentEvidence = referencedMessages.some((message) => message.role === "assistant");
  if (!isRetentionReasonCompatible(candidate.kind, candidate.retentionReason)) {
    problems.add("retention-reason-kind-mismatch");
  }
  if (candidate.subjectRole === "user" && !referencedMessages.some((message) => message.role === "user")) {
    problems.add("user-memory-without-user-source");
  }
  if (candidate.subjectRole === "agent" && !referencedMessages.some((message) => message.role === "assistant")) {
    problems.add("agent-memory-without-agent-source");
  }
  if (candidate.subjectRole === "other" && !clean(candidate.subjectName)) {
    problems.add("other-memory-without-subject-name");
  }
  if (
    candidate.kind === "commitment"
    && candidate.subjectRole === "shared"
    && (!hasUserEvidence || !hasAgentEvidence)
  ) {
    problems.add("shared-commitment-without-bilateral-source");
  }

  const holderRole = candidate.kind === "belief_state"
    ? "belief_holder"
    : candidate.kind === "preference" ? "preference_holder" : "";
  for (const actor of Array.isArray(candidate.actorRoles) ? candidate.actorRoles : []) {
    if (
      actor.actorRole === "user"
      && !hasUserEvidence
      && candidate.subjectRole !== "user"
    ) problems.add("user-actor-without-user-source");
    if (
      actor.actorRole === "agent"
      && !hasAgentEvidence
      && candidate.subjectRole !== "agent"
    ) problems.add("agent-actor-without-agent-source");
    if (holderRole && actor.role === holderRole && !sameNamedActor(candidate, actor)) {
      problems.add("holder-conflicts-with-subject");
    }
  }
  return [...problems];
}

const PROVISIONAL_IMPRESSION_REASONS = new Set([
  "user-memory-without-user-source",
  "agent-memory-without-agent-source",
  "user-actor-without-user-source",
  "agent-actor-without-agent-source",
  "state-analysis-awaits-inferred-specialist",
  "state-analysis-specialist-fallback",
]);

function provisionalReviewAllowed(reasons) {
  const normalized = Array.isArray(reasons) ? reasons.map(clean).filter(Boolean) : [];
  return normalized.length > 0
    && normalized.every((reason) => PROVISIONAL_IMPRESSION_REASONS.has(reason));
}

function storeProvisionalImpression({
  repository,
  agentId,
  batchId,
  candidateIndex,
  generated,
  reasons,
  referenced,
  recordedAt,
  identity = {},
}) {
  if (!provisionalReviewAllowed(reasons)) return null;
  const decisionId = stableId("ingest", agentId, batchId, candidateIndex);
  const memoryId = stableId("provisional", agentId, batchId, candidateIndex);
  const actorKeys = actorIdentityKeys(agentId, identity);
  const actorRoles = structuredActorRoles(generated, agentId, actorKeys);
  if (!actorRoles.some((role) => (
    role.role === "observer" && role.actorRole === "agent" && role.actorKey === actorKeys.companionId
  ))) {
    actorRoles.push({
      role: "observer",
      actorRole: "agent",
      actorKey: actorKeys.companionId,
      isPrimary: false,
      confidence: generated.confidence,
      provenance: "suzu-memory-provisional-impression-v1",
      metadata: { epistemicHolder: true },
    });
  }
  const memory = repository.upsertMemory({
    id: memoryId,
    agentId,
    kind: generated.kind,
    layer: "provisional",
    title: generated.title,
    content: generated.content,
    subjectRole: generated.subjectRole,
    subjectKey: subjectKeyFor(generated, agentId, actorKeys),
    canonicalKey: generated.canonicalKey,
    reality: generated.reality,
    worldId: clean(referenced[0]?.message?.worldId) || "primary",
    worldFrame: clean(referenced[0]?.message?.worldFrame) || "unknown",
    evidenceMode: "inferred",
    representationLayer: isStatefulMemoryKind(generated.kind) ? "inferred" : "unspecified",
    stateFamily: isStatefulMemoryKind(generated.kind)
      ? generated.stateFamily
      : "not_applicable",
    temporalState: generated.temporalState,
    revisionAction: "add",
    eventDate: generated.eventDate || null,
    eventStart: generated.eventStart || null,
    eventEnd: generated.eventEnd || null,
    knownAt: firstEvidenceTime(referenced, recordedAt),
    recordedAt,
    status: "archived",
    confidence: generated.confidence,
    importance: generated.importance,
    perspective: "agent",
    actorRoles,
    metadata: {
      provisional: true,
      reviewState: "pending",
      epistemicStatus: "agent_impression",
      epistemicHolderRole: "agent",
      epistemicHolderKey: actorKeys.companionId,
      describedSubjectRole: generated.subjectRole,
      describedSubjectKey: subjectKeyFor(generated, agentId, actorKeys),
      actorIdentity: actorKeys,
      ingestionDecisionId: decisionId,
      reviewReasonCodes: reasons,
      subjectName: generated.subjectName,
      retentionReason: generated.retentionReason,
      sourceEvidenceMode: generated.evidenceMode,
      sourceRefs: generated.sourceRefs,
      extractionBatchId: batchId,
      archiveWindowId: clean(referenced[0]?.message?.archiveWindowId),
      sourceLanguage: referencedSourceLanguage(referenced),
      generator: "suzu-memory-provisional-impression-v1",
    },
  });
  for (const item of referenced) {
    repository.linkSource(memory.id, item.source.id, "evidence", {
      authority: "model_inference",
      sourceTrust: 0.45,
      evidenceStrength: 0.65,
      provenance: "suzu-memory-provisional-impression-v1",
      metadata: {
        provisional: true,
        ingestionDecisionId: decisionId,
      },
    });
  }
  return memory;
}

export function fallbackStateAnalysisToProvisionalReview({
  repository,
  request,
  reason = "state-analysis-specialist-failed",
  recordedAt = new Date().toISOString(),
} = {}) {
  if (!repository || !request) {
    throw new Error("State analysis fallback requires repository and request.");
  }
  const decision = repository.getIngestionDecisionByBatchCandidate(
    request.agent_id,
    request.batch_id,
    request.candidate_index,
  );
  if (!decision) {
    throw new Error("State analysis fallback could not find its ingestion decision.");
  }
  const generated = decision.candidate;
  const referenced = decision.sourceIds.map((sourceId, index) => {
    const source = repository.getSource(sourceId);
    if (!source) throw new Error(`State analysis fallback source is missing: ${sourceId}`);
    const memoryId = request.memoryIds[index] || request.memoryIds[0] || "";
    return {
      source,
      memoryId,
      memory: memoryId ? repository.getMemory(memoryId) : null,
      message: {
        timestamp: source.occurred_at || source.known_at || source.recorded_at,
        worldId: source.world_id,
        worldFrame: source.world_frame,
        archiveWindowId: source.metadata?.archiveWindowId,
        sourceLanguage: source.metadata?.sourceLanguage,
      },
    };
  });
  const fallbackReason = "state-analysis-specialist-fallback";
  const actorIdentity = request.metadata?.actorIdentity && typeof request.metadata.actorIdentity === "object"
    ? request.metadata.actorIdentity
    : {};
  return repository.transaction(() => {
    const provisional = storeProvisionalImpression({
      repository,
      agentId: request.agent_id,
      batchId: request.batch_id,
      candidateIndex: request.candidate_index,
      generated,
      reasons: [fallbackReason],
      referenced,
      recordedAt,
      identity: actorIdentity,
    });
    if (!provisional) throw new Error("State analysis fallback did not create a provisional memory.");
    const updatedDecision = repository.deferIngestionDecisionForReview({
      agentId: request.agent_id,
      decisionId: decision.id,
      reasonCodes: [fallbackReason],
      provisionalMemoryId: provisional.id,
    });
    const resolvedRequest = repository.resolveStateAnalysisRequest({
      agentId: request.agent_id,
      requestId: request.id,
      status: "completed",
      errorMessage: clean(reason),
      metadata: {
        outcome: "provisional-review",
        fallbackReason,
        provisionalMemoryId: provisional.id,
        ingestionDecisionId: decision.id,
      },
    });
    return {
      provisional,
      decision: updatedDecision,
      request: resolvedRequest,
    };
  });
}

export function archiveLongTermEvidence({
  repository,
  agentId,
  sourceLocator = "",
  sourceKind = "conversation-event",
  messages,
  generatedMemories,
  batchId,
  recordedAt,
  conversationTopology,
  identity = {},
}) {
  const sourceByRef = new Map();
  const messageMemories = [];
  const results = [];
  repository.transaction(() => {
    const keepResult = (candidateIndex, generated, result, referenced = []) => {
      const recorded = {
        candidateIndex,
        ...result,
        sourceRefs: generated.sourceRefs,
        candidate: generated,
      };
      const provisional = recorded.status === "review"
        ? storeProvisionalImpression({
            repository,
            agentId,
            batchId,
            candidateIndex,
            generated,
            reasons: recorded.reasons,
            referenced,
            recordedAt,
            identity,
          })
        : null;
      const decision = repository.recordIngestionDecision({
        agentId,
        batchId,
        candidateIndex,
        decision: decisionForResult(recorded),
        resultStatus: recorded.status,
        reasonCodes: recorded.reasons,
        candidate: generated,
        sourceRefs: generated.sourceRefs,
        sourceIds: referenced.map((item) => item.source.id),
        knownAt: firstEvidenceTime(referenced, null),
        memoryId: recorded.memoryId || null,
        provisionalMemoryId: provisional?.id || null,
      });
      recorded.ingestionDecisionId = decision.id;
      recorded.provisionalMemoryId = provisional?.id || "";
      results.push(recorded);
    };
    for (const message of messages) {
      const utteranceIdentity = buildArchivedUtteranceIdentity({
        messageRole: message.role,
        agentId,
        primaryUserId: identity.primaryUserId,
        companionId: identity.companionId,
        conversationTopology,
        provenance: "suzu-memory-extraction-v1-utterance",
      });
      const source = repository.upsertSource({
        agentId,
        sourceKind: clean(message.sourceRecordKind) || sourceKind,
        sourceLocator: clean(message.sourceLocator) || clean(sourceLocator),
        externalId: clean(message.externalId) || message.id,
        occurredAt: isoTimestamp(message.occurredAt || message.timestamp),
        knownAt: isoTimestamp(message.knownAt || message.timestamp),
        recordedAt,
        speaker: message.speaker,
        worldId: clean(message.worldId) || "primary",
        worldFrame: clean(message.worldFrame) || "unknown",
        content: message.text,
        metadata: {
          role: message.role,
          sourceUuid: message.sourceUuid,
          sourceIndex: message.sourceIndex,
          sourceKind: message.sourceKind,
          extractionBatchId: batchId,
          memoryRef: message.memoryRef,
          archiveWindowId: clean(message.archiveWindowId),
          archiveContinuityId: clean(message.archiveContinuityId),
          participants: Array.isArray(message.participants) ? message.participants : [],
          inputEventId: clean(message.inputEventId),
          inputEventIds: Array.isArray(message.inputEventIds)
            ? message.inputEventIds.map(clean).filter(Boolean)
            : [clean(message.inputEventId)].filter(Boolean),
          ...(message.sourceMetadata && typeof message.sourceMetadata === "object"
            ? message.sourceMetadata
            : {}),
          sourceLanguage: sourceLanguage(message.sourceLanguage),
        },
      });
      const memoryId = stableId("mem", agentId, "utterance", message.id);
      repository.upsertMemory({
        id: memoryId,
        agentId,
        kind: "utterance",
        layer: "evidence",
        content: message.text,
        subjectRole: utteranceIdentity.subjectRole,
        subjectKey: utteranceIdentity.subjectKey,
        reality: "real",
        evidenceMode: "imported",
        temporalState: "historical",
        eventStart: isoTimestamp(message.occurredAt || message.timestamp),
        knownAt: isoTimestamp(message.knownAt || message.timestamp),
        recordedAt,
        perspective: message.role,
        worldId: clean(message.worldId) || "primary",
        worldFrame: clean(message.worldFrame) || "unknown",
        importance: 0.25,
        actorRoles: utteranceIdentity.actorRoles,
        metadata: {
          sourceKind: message.sourceKind,
          speaker: message.speaker,
          extractionBatchId: batchId,
          archiveWindowId: clean(message.archiveWindowId),
          archiveContinuityId: clean(message.archiveContinuityId),
          sourceLanguage: sourceLanguage(message.sourceLanguage),
          inputEventIds: Array.isArray(message.inputEventIds)
            ? message.inputEventIds.map(clean).filter(Boolean)
            : [clean(message.inputEventId)].filter(Boolean),
          ...(message.logicalEvent ? { logicalEvent: message.logicalEvent } : {}),
        },
      });
      repository.linkSource(memoryId, source.id, "verbatim", {
        authority: "verbatim_record",
        sourceTrust: 1,
        evidenceStrength: 1,
        provenance: "suzu-memory-extraction-v1",
      });
      sourceByRef.set(message.memoryRef, { source, message, memoryId });
      messageMemories.push({
        memoryId,
        archiveWindowId: clean(message.archiveWindowId),
        archiveContinuityId: clean(message.archiveContinuityId),
      });
    }
    for (let index = 1; index < messageMemories.length; index += 1) {
      const previous = messageMemories[index - 1];
      const current = messageMemories[index];
      const sameWindow = previous.archiveWindowId === current.archiveWindowId;
      const sameExplicitContinuity = previous.archiveContinuityId
        && previous.archiveContinuityId === current.archiveContinuityId;
      if (!sameWindow && !sameExplicitContinuity) continue;
      repository.upsertEdge({
        agentId,
        fromMemoryId: previous.memoryId,
        toMemoryId: current.memoryId,
        relation: "followed_by",
        direction: "directed",
        weight: 1,
        confidence: 1,
        provenance: "suzu-memory-extraction-v1",
      });
    }

    for (const [candidateIndex, generated] of generatedMemories.entries()) {
      const referenced = generated.sourceRefs
        .map((reference) => sourceByRef.get(reference))
        .filter(Boolean);
      const missingRefs = generated.sourceRefs.filter((reference) => !sourceByRef.has(reference));
      if (missingRefs.length) {
        keepResult(candidateIndex, generated, {
          status: "reject",
          reasons: ["unknown-source-ref"],
          missingRefs,
        }, referenced);
        continue;
      }
      const referencedArchiveWindows = new Set(referenced.map(({ message }) => (
        clean(message.archiveWindowId) || "__legacy_single_window__"
      )));
      if (referencedArchiveWindows.size > 1) {
        keepResult(candidateIndex, generated, {
          status: "reject",
          reasons: ["cross-window-evidence"],
        }, referenced);
        continue;
      }
      const referencedWorlds = new Set(referenced.map(({ message }) => (
        `${clean(message.worldFrame) || "unknown"}\u001f${clean(message.worldId) || "primary"}`
      )));
      if (referencedWorlds.size > 1) {
        keepResult(candidateIndex, generated, {
          status: "review",
          reasons: ["mixed-world-evidence-needs-resolution"],
        }, referenced);
        continue;
      }
      const alignmentProblems = evidenceAlignmentProblems(
        generated,
        referenced.map((item) => item.message),
      );
      if (alignmentProblems.length) {
        keepResult(candidateIndex, generated, {
          status: "review",
          reasons: alignmentProblems,
        }, referenced);
        continue;
      }
      if (isStatefulMemoryKind(generated.kind)) {
        const subjectKey = subjectKeyFor(generated, agentId, identity);
        if (!["user", "agent", "shared", "other"].includes(generated.subjectRole)
          || !subjectKey) {
          keepResult(candidateIndex, generated, {
            status: "review",
            reasons: ["state-analysis-needs-fixed-personal-subject"],
          }, referenced);
          continue;
        }
        if (generated.subjectRole === "shared") {
          keepResult(candidateIndex, generated, {
            status: "review",
            reasons: ["state-analysis-needs-individual-subject"],
          }, referenced);
          continue;
        }
        if (generated.evidenceMode !== "explicit") {
          keepResult(candidateIndex, generated, {
            status: "review",
            reasons: ["state-analysis-awaits-inferred-specialist"],
          }, referenced);
          continue;
        }
        const targetSpec = requestTargetSpec(generated, agentId, identity);
        if (generated.stateFamily === "relationship"
          && targetSpec.counterpartRole === generated.subjectRole
          && targetSpec.counterpartKey === subjectKey) {
          keepResult(candidateIndex, generated, {
            status: "review",
            reasons: ["state-analysis-relationship-counterpart-matches-holder"],
          }, referenced);
          continue;
        }
        const request = repository.recordStateAnalysisRequest({
          agentId,
          batchId,
          candidateIndex,
          stateFamily: generated.stateFamily,
          subjectRole: generated.subjectRole,
          subjectKey,
          canonicalKey: generated.canonicalKey,
          targetLabel: generated.stateLabel,
          targetSpec,
          representationLayer: generated.evidenceMode === "explicit" ? "reported" : "inferred",
          evidenceMode: generated.evidenceMode,
          memoryIds: referenced.map((item) => item.memoryId),
          sourceIds: referenced.map((item) => item.source.id),
          metadata: {
            candidateKind: generated.kind,
            subjectName: generated.subjectName,
            retentionReason: generated.retentionReason,
            revisionAction: generated.revisionAction,
            temporalState: generated.temporalState,
            extractionBatchId: batchId,
            archiveWindowId: clean(referenced[0]?.message?.archiveWindowId),
            sourceLanguage: referencedSourceLanguage(referenced),
            generator: "suzu-memory-extraction-v1-state-target",
            actorIdentity: actorIdentityKeys(agentId, identity),
          },
          createdAt: recordedAt,
        });
        keepResult(candidateIndex, generated, {
          status: "analysis_pending",
          reasons: [],
          stateAnalysisRequestId: request.id,
          stateAnalysisRequestInserted: request.wasInserted,
        }, referenced);
        continue;
      }
      const result = applyMemoryCandidate(repository, {
        agentId,
        kind: generated.kind,
        title: generated.title,
        content: generated.content,
        subjectRole: generated.subjectRole,
        subjectKey: subjectKeyFor(generated, agentId, identity),
        canonicalKey: generated.canonicalKey,
        reality: generated.reality,
        worldId: clean(referenced[0]?.message?.worldId) || "primary",
        worldFrame: clean(referenced[0]?.message?.worldFrame) || "unknown",
        evidenceMode: generated.evidenceMode,
        temporalState: generated.temporalState,
        revisionAction: generated.revisionAction,
        eventDate: generated.eventDate || null,
        eventStart: generated.eventStart || null,
        eventEnd: generated.eventEnd || null,
        knownAt: firstEvidenceTime(referenced, recordedAt),
        confidence: generated.confidence,
        importance: generated.importance,
        actorRoles: structuredActorRoles(generated, agentId, identity),
        evidenceLinks: referenced.map((item) => {
          const sameSubject = (
            (generated.subjectRole === "user" && item.message.role === "user")
            || (generated.subjectRole === "agent" && item.message.role === "assistant")
          );
          const authority = generated.evidenceMode === "inferred"
            ? "model_inference"
            : sameSubject ? "subject_firsthand"
              : generated.evidenceMode === "observed" ? "direct_observation" : "unknown";
          return {
            sourceId: item.source.id,
            relation: "evidence",
            authority,
            sourceTrust: authority === "subject_firsthand" ? 0.9
              : authority === "direct_observation" ? 0.8
                : authority === "model_inference" ? 0.5 : 0.5,
            evidenceStrength: 1,
            provenance: "suzu-memory-extraction-v1",
          };
        }),
        metadata: {
          subjectName: generated.subjectName,
          retentionReason: generated.retentionReason,
          sourceRefs: generated.sourceRefs,
          inputEventTypes: [...new Set(referenced.map((item) => clean(item.message.sourceKind))
            .filter(Boolean))],
          extractionBatchId: batchId,
          archiveWindowId: clean(referenced[0]?.message?.archiveWindowId),
          sourceLanguage: referencedSourceLanguage(referenced),
          generator: "suzu-memory-extraction-v1",
        },
      }, { recordedAt });
      if (result.memory) {
        for (const evidence of referenced) {
          repository.upsertEdge({
            agentId,
            fromMemoryId: result.memory.id,
            toMemoryId: evidence.memoryId,
            relation: "supported_by",
            direction: "directed",
            weight: 1,
            confidence: generated.confidence,
            provenance: "suzu-memory-extraction-v1",
          });
        }
      }
      keepResult(candidateIndex, generated, {
        status: result.status,
        reasons: result.reasons,
        memoryId: result.memory?.id || "",
      }, referenced);
    }
  });
  return {
    messagesArchived: messages.length,
    utteranceMemoryIds: messageMemories.map((item) => item.memoryId),
    candidateResults: results,
    memoriesStored: results.filter((result) => (
      ["created", "reinforced", "update", "correct", "contradict", "complete", "cancel"]
        .includes(result.status)
    )).length,
    memoriesForReview: results.filter((result) => result.status === "review").length,
    memoriesRejected: results.filter((result) => result.status === "reject").length,
    stateAnalysisRequestsQueued: results.filter((result) => result.stateAnalysisRequestId).length,
  };
}
