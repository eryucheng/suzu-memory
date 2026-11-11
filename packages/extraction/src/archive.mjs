import { createExtractionEntityBinder } from './entity-bindings.mjs';
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyMemoryCandidate,
  enqueueMemoryMaintenanceTasks,
  isStatefulMemoryKind,
  MAINTENANCE_TASK_TYPES,
  normalizeStateAnalysisTargetSpec,
} from "@suzu-memory/core";
import {
  buildArchivedUtteranceIdentity,
} from "./utterance-evidence.mjs";
import { buildExtractionParticipants, resolveExtractionActor } from './participant-identity.mjs';
import { createExtractionTimeValidator } from './temporal-evidence.mjs';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "resources", "system-prompt.md");

export function loadLongTermExtractionSystemPrompt(systemPromptPath = DEFAULT_PROMPT_PATH) {
  return fs.readFileSync(systemPromptPath, "utf8").trim();
}

function clean(value) {
  return String(value ?? "").trim();
}

function sourceTimeMetadata(generated, referenced) {
  return !generated.eventDate && !generated.eventStart && !generated.eventEnd
    && referenced.some(item => item.message.sourceMetadata?.sourceTimeKnown === false)
    ? { sourceTimeKnown: false } : {};
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

function isoTimestamp(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : fallback;
}

function actorKeyFor(actorRole, actorName, agentId, identity = {}, actorKey, status) {
  return resolveExtractionActor({ role: actorRole, name: actorName, key: actorKey, status }, { ...identity, agentId }).key;
}

function actorIdentityKeys(agentId, identity = {}) {
  return {
    primaryUserId: clean(identity?.primaryUserId ?? "user"),
    companionId: clean(identity?.companionId) || clean(agentId),
    participants: identity.participants || [],
    unresolvedActorScope: clean(identity.unresolvedActorScope),
    ...(identity.eventSourceIdentity ? { eventSourceIdentity: true } : {}),
  };
}

function subjectKeyFor(candidate, agentId, identity) {
  if (candidate.subjectRole === 'shared' && identity?.eventSourceIdentity) {
    const actors = [...new Set(candidate.actorRoles.filter(actor => ['experiencer', 'participant'].includes(actor.role))
      .map(actor => ({ role: actor.actorRole, key: actorKeyFor(actor.actorRole, actor.actorName, agentId, identity, actor.actorKey, actor.identityStatus) }))
      .filter(actor => actor.key)
      .map(actor => `${actor.role}:${encodeURIComponent(actor.key)}`))].sort();
    return actors.length >= 2 ? `shared:${actors.join('|')}` : '';
  }
  return actorKeyFor(candidate.subjectRole, candidate.subjectName, agentId, identity, candidate.subjectKey, candidate.subjectIdentityStatus);
}

export function resolveExtractedCandidateStateTarget(candidate, agentId, identity) {
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
      objectKey: actorKeyFor(target.objectRole, target.objectName, agentId, identity, target.objectKey, target.objectIdentityStatus),
      objectLabel: target.objectName,
      ...(target.objectEntityId ? { objectEntityId: target.objectEntityId, objectKind: target.objectKind } : {}),
    }, { allowEmpty: false });
  }
  if (candidate.stateFamily === "relationship") {
    return normalizeStateAnalysisTargetSpec("relationship", {
      counterpartRole: target.counterpartRole,
      counterpartKey: actorKeyFor(
        target.counterpartRole,
        target.counterpartName,
        agentId,
        identity, target.counterpartKey, target.counterpartIdentityStatus,
      ),
      counterpartLabel: target.counterpartName,
      direction: "holder_to_counterpart",
      ...(target.counterpartEntityId ? { counterpartEntityId: target.counterpartEntityId, counterpartKind: target.counterpartKind } : {}),
      ...(target.relationshipDimension ? { relationshipDimension: target.relationshipDimension } : {}),
    }, { allowEmpty: false });
  }
  if (candidate.stateFamily === "affective_association") {
    return normalizeStateAnalysisTargetSpec("affective_association", {
      triggerRole: target.triggerRole,
      triggerKey: actorKeyFor(target.triggerRole, target.triggerName, agentId, identity, target.triggerKey, target.triggerIdentityStatus),
      triggerLabel: target.triggerName,
      ...(target.triggerEntityId ? { triggerEntityId: target.triggerEntityId, triggerKind: target.triggerKind } : {}),
    }, { allowEmpty: false });
  }
  return {};
}

function structuredActorRoles(candidate, agentId, identity) {
  const roles = (Array.isArray(candidate.actorRoles) ? candidate.actorRoles : []).map((actor) => ({
    ...actor,
    role: actor.role,
    actorRole: actor.actorRole,
    actorKey: actorKeyFor(actor.actorRole, actor.actorName || actor.metadata?.actorName, agentId, identity, actor.actorKey, actor.identityStatus),
    isPrimary: false,
    confidence: actor.confidence,
    provenance: "suzu-memory-extraction-v1",
    metadata: { actorName: clean(actor.actorName),
      ...(actor.identityStatus === 'unresolved'
        ? { identityStatus: 'unresolved', evidenceScope: clean(identity.unresolvedActorScope) } : {}) },
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
        ...(candidate.subjectEntityRef ? { entityRef: candidate.subjectEntityRef, identityStatus: candidate.subjectIdentityStatus } : {}),
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

/** Resolve candidate identities against the captured host participants. */
export function resolveExtractedCandidateIdentity(candidate, agentId, identity) {
  return { subjectKey: subjectKeyFor(candidate, agentId, identity),
    actorRoles: structuredActorRoles(candidate, agentId, identity) };
}

function extractionSourceEvidence(candidate, message, agentId, identity) {
  const speaker = message.speakerIdentity || (message.role === "user"
    ? { actorRole: "user", actorKey: clean(identity.primaryUserId ?? "user") }
    : message.role === "assistant"
      ? { actorRole: "agent", actorKey: clean(identity.companionId) || clean(agentId) } : null);
  const sameSubject = speaker && candidate.subjectRole === speaker.actorRole
    && subjectKeyFor(candidate, agentId, identity) === speaker.actorKey;
  const participant = speaker && structuredActorRoles(candidate, agentId, identity).some(actor =>
    ["participant", "experiencer"].includes(actor.role)
    && actor.actorRole === speaker.actorRole && actor.actorKey === speaker.actorKey);
  const authority = candidate.evidenceMode === "inferred" ? "model_inference"
    : candidate.evidenceMode === "observed" ? "direct_observation"
      : sameSubject ? "subject_firsthand"
        : participant ? "participant_firsthand" : speaker ? "hearsay" : "unknown";
  return { authority, sourceTrust: authority === "subject_firsthand" ? 0.9
    : authority === "direct_observation" ? 0.8 : 0.5, evidenceStrength: 1 };
}

function firstEvidenceKnownAt(referenced, fallback) {
  return referenced.reduce((earliest, item) => {
    const timestamp = isoTimestamp(item.source.known_at);
    return timestamp && (!earliest || timestamp < earliest) ? timestamp : earliest;
  }, "") || fallback;
}

function decisionForResult(result) {
  if (result.status === "review") return "review";
  if (result.status === "reject") return "reject";
  if (result.stateAnalysisRequestId) return "store";
  return result.memoryId ? "store" : "reject";
}

function sameActor(candidate, actor) {
  return actor.actorRole === candidate.subjectRole && actor.actorKey === candidate.subjectKey;
}

function evidenceAlignmentProblems(candidate, referencedMessages, identity = {}) {
  const problems = new Set();
  const hasUserEvidence = referencedMessages.some((message) => message.role === "user");
  const hasAgentEvidence = referencedMessages.some((message) => message.role === "assistant");
  if (candidate.subjectRole === "other" && !clean(candidate.subjectName)) {
    problems.add("other-memory-without-subject-name");
  }
  if (
    !identity.eventSourceIdentity && candidate.kind === "commitment"
    && candidate.subjectRole === "shared"
    && (!hasUserEvidence || !hasAgentEvidence)
  ) {
    problems.add("shared-commitment-without-bilateral-source");
  }

  const holderRole = candidate.kind === "belief_state"
    ? "belief_holder"
    : candidate.kind === "preference" ? "preference_holder" : "";
  for (const actor of Array.isArray(candidate.actorRoles) ? candidate.actorRoles : []) {
    if (holderRole && actor.role === holderRole && !sameActor(candidate, actor)) {
      problems.add("holder-conflicts-with-subject");
    }
  }
  if (identity.eventSourceIdentity) {
    const people = [[candidate.subjectKey, candidate.subjectRole, candidate.subjectIdentityStatus], ...candidate.actorRoles.map(actor => [actor.actorKey, actor.actorRole, actor.identityStatus]),
      ...['object', 'counterpart', 'trigger'].map(prefix => [candidate.stateTarget?.[`${prefix}Key`], candidate.stateTarget?.[`${prefix}Role`], candidate.stateTarget?.[`${prefix}IdentityStatus`]])];
    for (const [key, role, status] of people) {
      if (!role || role === 'world' || role === 'shared') continue;
      if (status === 'ambiguous') problems.add('ambiguous-participant-identity');
      if (status === 'conflict' || ['user', 'agent'].includes(role) && !identity.participants.some(person => person.actorRole === role && person.actorKey === key)) problems.add('participant-identity-mismatch');
    }
    if (candidate.subjectRole === 'shared' && !subjectKeyFor(candidate, '', identity)) problems.add('shared-memory-needs-explicit-participants');
  }
  return [...problems];
}

const PROVISIONAL_EVIDENCE_REASONS = new Set([
  "state-analysis-specialist-fallback",
]);

function provisionalReviewAllowed(reasons) {
  const normalized = Array.isArray(reasons) ? reasons.map(clean).filter(Boolean) : [];
  return normalized.length > 0
    && normalized.every((reason) => PROVISIONAL_EVIDENCE_REASONS.has(reason));
}

function storeProvisionalEvidence({
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
    evidenceMode: generated.evidenceMode,
    representationLayer: generated.evidenceMode === "inferred" && isStatefulMemoryKind(generated.kind)
      ? "inferred" : "unspecified",
    stateFamily: isStatefulMemoryKind(generated.kind)
      ? generated.stateFamily
      : "not_applicable",
    temporalState: generated.temporalState,
    revisionAction: "add",
    eventDate: generated.eventDate || null,
    eventStart: generated.eventStart || null,
    eventEnd: generated.eventEnd || null,
    knownAt: firstEvidenceKnownAt(referenced, recordedAt),
    recordedAt,
    status: "archived",
    confidence: generated.confidence,
    importance: generated.importance,
    perspective: "agent",
    actorRoles,
    metadata: {
      provisional: true,
      ...sourceTimeMetadata(generated, referenced),
      reviewState: "pending",
      epistemicStatus: generated.evidenceMode === "inferred" ? "agent_impression" : "source_record",
      epistemicHolderRole: "agent",
      epistemicHolderKey: actorKeys.companionId,
      describedSubjectRole: generated.subjectRole,
      describedSubjectKey: subjectKeyFor(generated, agentId, actorKeys),
      actorIdentity: actorKeys,
      ingestionDecisionId: decisionId,
      reviewReasonCodes: reasons,
      subjectName: generated.subjectName,
      sourceEvidenceMode: generated.evidenceMode,
      sourceRefs: generated.sourceRefs,
      extractionBatchId: batchId,
      archiveWindowId: clean(referenced[0]?.message?.archiveWindowId),
      sourceLanguage: referencedSourceLanguage(referenced),
      generator: "suzu-memory-provisional-evidence-v2",
    },
  });
  repository.linkMemoryEntities({ memoryId: memory.id, entityIds: generated.entityIds || [] });
  for (const item of referenced) {
    repository.linkSource(memory.id, item.source.id, "evidence", {
      ...extractionSourceEvidence(generated, item.message, agentId, identity),
      provenance: "suzu-memory-provisional-evidence-v2",
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
  const generated = { ...decision.candidate, canonicalKey: request.canonical_key };
  const referenced = decision.sourceIds.map((sourceId, index) => {
    const source = repository.getSource(sourceId);
    if (!source) throw new Error(`State analysis fallback source is missing: ${sourceId}`);
    const memoryId = request.memoryIds[index] || request.memoryIds[0] || "";
    const speaker = memoryId ? repository.listMemoryRoles(memoryId).find(role => role.role === "speaker") : null;
    return {
      source,
      memoryId,
      message: {
        role: source.metadata?.role,
        speakerIdentity: speaker ? { actorRole: speaker.actor_role, actorKey: speaker.actor_key } : null,
        worldId: source.world_id,
        worldFrame: source.world_frame,
        archiveWindowId: source.metadata?.archiveWindowId,
        sourceLanguage: source.metadata?.sourceLanguage,
      },
    };
  });
  const fallbackReason = "state-analysis-specialist-fallback";
  // Preserve the extraction decision's identity when an invalid request binding
  // is sent back to review; never reassign the original candidate's subject.
  const actorIdentity = decision.candidate.metadata?.actorIdentity || request.metadata?.actorIdentity || {};
  return repository.transaction(() => {
    const provisional = storeProvisionalEvidence({
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
    if (request.metadata?.stateIdentityResolution?.resolution === 'matched') {
      repository.upsertEdge({ agentId: request.agent_id, fromMemoryId: provisional.id,
        toMemoryId: request.metadata.stateIdentityResolution.candidateId, relation: 'associated_with',
        direction: 'directed', weight: 1, confidence: generated.confidence,
        provenance: 'state-identity-resolution-v1',
        metadata: { stateAnalysisRequestId: request.id, reviewRequired: true } });
    }
    const updatedDecision = repository.deferIngestionDecisionForReview({
      agentId: request.agent_id,
      decisionId: decision.id,
      reasonCodes: [fallbackReason],
      provisionalMemoryId: provisional.id,
    });
    enqueueMemoryMaintenanceTasks({
      repository,
      agentId: request.agent_id,
      batchId: request.batch_id,
      memoryIds: [provisional.id],
      taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding],
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
  candidateIndexOffset = 0,
  batchId,
  recordedAt,
  conversationTopology,
  identity = {},
  timeZone,
}) {
  const validateTime = createExtractionTimeValidator(messages, timeZone);
  identity = { ...identity, participants: identity.participants || buildExtractionParticipants(messages, { ...identity, agentId }) };
  if (messages.some(message => message.eventSource)) {
    identity = { ...identity, eventSourceIdentity: true };
  }
  const sourceByRef = new Map();
  const messageMemories = [];
  const results = [];
  repository.transaction(() => {
    const bindEntities = createExtractionEntityBinder(repository, agentId, generatedMemories, identity.participants, batchId);
    const keepResult = (candidateIndex, generated, result, referenced = []) => {
      const recorded = {
        candidateIndex,
        ...result,
        sourceRefs: generated.sourceRefs,
        candidate: { ...generated, metadata: { ...generated.metadata, actorIdentity: actorIdentityKeys(agentId, identity) } },
      };
      const provisional = recorded.status === "review"
        ? storeProvisionalEvidence({
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
      for (const memoryId of new Set([...referenced.map(item => item.memoryId), result.memoryId, provisional?.id].filter(Boolean))) {
        repository.linkMemoryEntities({ memoryId, entityIds: generated.entityIds || [] });
      }
      const decision = repository.recordIngestionDecision({
        agentId,
        batchId,
        candidateIndex,
        decision: decisionForResult(recorded),
        resultStatus: recorded.status,
        reasonCodes: recorded.reasons,
        candidate: recorded.candidate,
        sourceRefs: generated.sourceRefs,
        sourceIds: referenced.map((item) => item.source.id),
        knownAt: firstEvidenceKnownAt(referenced, null),
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
        conversationTopology: message.conversationTopology ?? conversationTopology,
        actualSpeaker: message.speakerIdentity || null,
        actualParticipants: message.eventSource ? message.participants : [],
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
          causalExcerpt: message.causalExcerpt,
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
          ...(message.sourceMetadata?.sourceTimeKnown === false ? { sourceTimeKnown: false } : {}),
          speaker: message.speaker,
          extractionBatchId: batchId,
          archiveWindowId: clean(message.archiveWindowId),
          archiveContinuityId: clean(message.archiveContinuityId),
          sourceLanguage: sourceLanguage(message.sourceLanguage),
          inputEventIds: Array.isArray(message.inputEventIds)
            ? message.inputEventIds.map(clean).filter(Boolean)
            : [clean(message.inputEventId)].filter(Boolean),
          ...(message.logicalEvent ? { logicalEvent: message.logicalEvent } : {}),
          ...(message.eventSource ? { eventSource: message.eventSource, conversationTopology: message.conversationTopology } : {}),
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

    if (!Number.isSafeInteger(candidateIndexOffset) || candidateIndexOffset < 0
      || !Number.isSafeInteger(candidateIndexOffset + generatedMemories.length)) {
      throw new Error('Extraction archive requires a non-negative safe integer offset.');
    }
    for (const [position, rawCandidate] of generatedMemories.entries()) {
      const candidateIndex = candidateIndexOffset + position;
      let generated = rawCandidate.kind === 'event'
        ? { ...rawCandidate, canonicalKey: stableId('event', agentId, batchId, candidateIndex) } : rawCandidate;
      const referenced = generated.sourceRefs
        .map((reference) => sourceByRef.get(reference))
        .filter(Boolean);
      const referencedWorlds = new Set(referenced.map(({ message }) => (
        `${clean(message.worldFrame) || "unknown"}\u001f${clean(message.worldId) || "primary"}`
      )));
      if (referencedWorlds.size === 1) generated = { ...generated,
        worldId: clean(referenced[0].message.worldId) || 'primary',
        worldFrame: clean(referenced[0].message.worldFrame) || 'unknown' };
      identity = { ...identity, unresolvedActorScope: stableId('evidence', agentId,
        ...referenced.map(item => item.source.id).sort()) };
      generated = { ...generated, subjectKey: subjectKeyFor(generated, agentId, identity),
        subjectIdentityStatus: resolveExtractionActor({ role: generated.subjectRole, key: generated.subjectKey, name: generated.subjectName, status: generated.subjectIdentityStatus }, { ...identity, agentId }).status,
        actorRoles: generated.actorRoles.map(actor => { const person = resolveExtractionActor({ role: actor.actorRole, key: actor.actorKey, name: actor.actorName, status: actor.identityStatus }, { ...identity, agentId });
          return { ...actor, actorKey: person.key, identityStatus: person.status }; }),
        ...(generated.stateTarget ? { stateTarget: { ...generated.stateTarget } } : {}) };
      for (const prefix of ['object', 'counterpart', 'trigger']) {
        if (!generated.stateTarget || !Object.hasOwn(generated.stateTarget, `${prefix}Role`)) continue;
        const person = resolveExtractionActor({ role: generated.stateTarget[`${prefix}Role`], key: generated.stateTarget[`${prefix}Key`], name: generated.stateTarget[`${prefix}Name`], status: generated.stateTarget[`${prefix}IdentityStatus`] }, { ...identity, agentId });
        generated.stateTarget[`${prefix}Key`] = person.key; generated.stateTarget[`${prefix}IdentityStatus`] = person.status;
      }
      const missingRefs = generated.sourceRefs.filter((reference) => !sourceByRef.has(reference));
      if (missingRefs.length) {
        keepResult(candidateIndex, generated, {
          status: "reject",
          reasons: ["unknown-source-ref"],
          missingRefs,
        }, referenced);
        continue;
      }
      try {
        validateTime(generated);
      } catch (error) {
        if (error.code !== 'MEMORY_EXTRACTION_TIME_CONFLICT') throw error;
        keepResult(candidateIndex, generated, {
          status: 'review', reasons: ['source-time-conflict'], timeConflict: error.message,
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
      if (referencedWorlds.size > 1) {
        keepResult(candidateIndex, generated, {
          status: "review",
          reasons: ["mixed-world-evidence-needs-resolution"],
        }, referenced);
        continue;
      }
      generated = bindEntities(generated, { reality: generated.reality,
        world_id: generated.worldId, world_frame: generated.worldFrame });
      const alignmentProblems = evidenceAlignmentProblems(
        generated,
        referenced.map((item) => item.message),
        identity,
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
        const targetSpec = resolveExtractedCandidateStateTarget(generated, agentId, identity);
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
            entityIds: generated.entityIds,
            subjectName: generated.subjectName,
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
        worldId: generated.worldId,
        worldFrame: generated.worldFrame,
        evidenceMode: generated.evidenceMode,
        temporalState: generated.temporalState,
        revisionAction: generated.revisionAction,
        eventDate: generated.eventDate || null,
        eventStart: generated.eventStart || null,
        eventEnd: generated.eventEnd || null,
        knownAt: firstEvidenceKnownAt(referenced, recordedAt),
        confidence: generated.confidence,
        importance: generated.importance,
        actorRoles: structuredActorRoles(generated, agentId, identity),
        evidenceLinks: referenced.map(item => ({
          sourceId: item.source.id,
          relation: "evidence",
          ...extractionSourceEvidence(generated, item.message, agentId, identity),
          provenance: "suzu-memory-extraction-v1",
        })),
        metadata: {
          entityIds: generated.entityIds,
          subjectName: generated.subjectName,
          ...sourceTimeMetadata(generated, referenced),
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
