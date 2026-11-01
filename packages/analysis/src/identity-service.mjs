import { invokeEvidenceAnalyzer, recordAnalyzerInvocations, priorAnalyzerRuns } from "./related-analyzer-batch.mjs";
import { modelCalendarFields, STATE_IDENTITY_FIELDS, normalizeStateAnalysisTargetSpec } from '@suzu-memory/core';
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDENTITY_ANALYZERS,
  buildIdentityGenerationInput,
  parseIdentityGeneration,
} from "./identity-contracts.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(ROOT, "resources");
const CARDINALITIES = new Set(["single", "multi_item", "sequence"]);

function clean(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function batchId(args) {
  const raw = [
    args.agentId,
    args.subjectRole,
    args.subjectKey,
    args.identityField,
    args.fieldCardinality,
    clean(args.canonicalKey).toLocaleLowerCase("en-US"),
    args.currentRepresentationLayer,
    unique(args.memoryIds).sort().join("\u001f"),
  ].map(clean).join("\u001e");
  return `identity-analysis-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}

function currentView(repository, agentId, subjectRole, subjectKey, canonicalKey, representationLayer) {
  const current = repository.getCurrentCanonicalMemory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer,
    stateFamily: "identity",
  });
  if (!current) return null;
  if (current.kind !== "fact") {
    throw new Error("Identity canonicalKey resolves to a non-fact current memory.");
  }
  return {
    id: current.id,
    kind: current.kind,
    content: String(current.content ?? ""),
    subjectRole: current.subject_role,
    subjectKey: current.subject_key,
    canonicalKey: current.canonical_key,
    representationLayer: current.representation_layer,
    temporalState: current.temporal_state,
    ...modelCalendarFields(current, ['knownAt', 'validFrom', 'validTo'], repository.listMemorySources(current.id)),
  };
}

function hasSubject(memory, target, roles, allowPrimary = true) {
  return (allowPrimary
    && memory.subjectRole === target.subjectRole
    && memory.subjectKey === target.subjectKey)
    || memory.actorRoles.some((role) => (
      roles.has(role.role)
      && role.actorRole === target.subjectRole
      && role.actorKey === target.subjectKey
    ));
}

function enforce(role, item, snapshot) {
  const memory = snapshot.memories.find((candidate) => candidate.id === item.memoryId);
  if (!memory) throw new Error("Identity analysis memory must come from the bounded snapshot.");
  const sourceIds = new Set(memory.sourceIds);
  if (item.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
    throw new Error("Identity analysis source must directly support its memory.");
  }
  if (role === "field-value" && item.valueRelations.some(peer => !snapshot.memories.some(memory => memory.id === peer.memoryId))) {
    throw new Error("Identity value relation must stay within the bounded evidence snapshot.");
  }
  if (role === "field-value" && item.identityField !== snapshot.target.identityField) {
    throw new Error("Identity analyzer changed the caller-fixed identityField.");
  }
  if (role === "subject-attribution" && item.attribution === "explicit_self_report") {
    if (!hasSubject(memory, snapshot.target, new Set(["speaker"]), false)) {
      throw new Error("Explicit identity self report requires the fixed subject as speaker.");
    }
  } else if (!(memory.kind === "utterance"
    && snapshot.inputPolicy.identityTargetIsRequestBound
    && snapshot.inputPolicy.requestBoundUtteranceEvidence
    && snapshot.inputPolicy.sourceIdsAreCallerBounded)
    && !hasSubject(memory, snapshot.target, new Set(["subject", "speaker", "participant"]))) {
    throw new Error("Identity analysis does not identify the fixed subject.");
  }
  if (role === "current-relation") {
    const exists = Boolean(snapshot.currentState);
    if (item.currentStatePresent !== exists) {
      throw new Error("Identity current-state presence does not match the read-only snapshot.");
    }
    if (exists && item.relation === "no_current_state") {
      throw new Error("Identity relation omitted an available current state.");
    }
    if (!exists && item.relation !== "no_current_state") {
      throw new Error("Identity relation invented a current state.");
    }
  }
  return item;
}



async function invoke(options) {
  return invokeEvidenceAnalyzer({ ...options, buildInput: buildIdentityGenerationInput, prepareInputSnapshot: (view, definition) => {
    const ids = new Set(view.memories.map(memory => memory.id));
    const peers = definition.role === "field-value" ? options.snapshot.memories
      .filter(memory => !ids.has(memory.id)).map(memory => ({ memoryId: memory.id, content: memory.content })) : [];
    return peers.length ? { ...view, comparisonMemories: peers } : view;
  }, parseGeneration: parseIdentityGeneration, enforceBoundary: enforce });
}

function mapBy(items) {
  return new Map((items || []).map((item) => [item.memoryId, item]));
}

function gate({ field, subject, boundary, time, relation, current, cardinality }) {
  if (!field) return { qualification: "unresolved", reason: "missing-identity-field-analysis" };
  if (["none", "contextual"].includes(field.targetMatch) || field.statementPolarity === "no_fact") {
    return { qualification: "excluded", reason: "memory-does-not-express-the-fixed-identity-fact" };
  }
  if (["unknown", "broader_category"].includes(field.targetMatch)
    || field.identityField === "unknown" || field.statementPolarity === "unknown" || !field.valueText) {
    return { qualification: "unresolved", reason: "identity-field-or-value-is-not-exact-enough" };
  }
  if (!subject) return { qualification: "unresolved", reason: "missing-identity-subject-analysis" };
  if (subject.subjectMatch === "no") return { qualification: "excluded", reason: "identity-fact-belongs-to-another-subject" };
  if (subject.subjectMatch === "unknown" || subject.attribution === "unknown") {
    return { qualification: "unresolved", reason: "identity-subject-or-source-is-unknown" };
  }
  if (subject.attribution === "quoted_or_roleplay") {
    return { qualification: "excluded", reason: "identity-content-is-quoted-or-roleplay" };
  }
  if (["third_party_report", "model_inference"].includes(subject.attribution)) {
    return { qualification: "unresolved", reason: "identity-fact-is-not-firsthand-or-direct-record" };
  }
  if (!boundary) return { qualification: "unresolved", reason: "missing-identity-family-boundary-analysis" };
  if (boundary.classification === "credential_or_secret" || boundary.sensitivity === "credential") {
    return { qualification: "excluded", reason: "credentials-and-secrets-never-enter-identity-memory" };
  }
  if (boundary.classification === "unknown" || boundary.sensitivity === "unknown") {
    return { qualification: "unresolved", reason: "identity-family-or-sensitivity-is-unknown" };
  }
  if (boundary.classification !== "identity_fact") {
    return { qualification: "excluded", reason: `content-belongs-to-${boundary.classification.replaceAll("_", "-")}` };
  }
  if (!time) return { qualification: "unresolved", reason: "missing-identity-time-analysis" };
  if (["future", "temporary"].includes(time.factTime)) {
    return { qualification: "excluded", reason: "future-or-temporary-content-is-not-current-identity" };
  }
  if (time.factTime === "unknown" || time.revisionCue === "unknown") {
    return { qualification: "unresolved", reason: "identity-time-or-revision-is-unknown" };
  }
  if (!relation) return { qualification: "unresolved", reason: "missing-identity-current-relation-analysis" };
  if (Boolean(current) !== relation.currentStatePresent) {
    return { qualification: "unresolved", reason: "identity-current-state-presence-conflict" };
  }
  if (relation.relation === "unknown") {
    return { qualification: "unresolved", reason: "identity-current-relation-unknown" };
  }
  if (current && relation.relation === "unrelated") {
    return { qualification: "excluded", reason: "identity-fact-is-unrelated-to-current-key" };
  }
  if (current && relation.relation === "additional_value" && cardinality !== "multi_item") {
    return { qualification: "unresolved", reason: "additional-identity-value-conflicts-with-field-cardinality" };
  }
  const cueByRelation = { value_changed: "changed", narrows: "clarified", retires: "ended" };
  if (cueByRelation[relation.relation] && time.revisionCue !== cueByRelation[relation.relation]) {
    return { qualification: "unresolved", reason: "identity-relation-lacks-matching-revision-cue" };
  }
  return null;
}

function action({ qualification, field, time, relation, current, cardinality }) {
  const base = {
    action: "no_conclusion",
    proposedKind: "fact",
    reason: qualification === "qualified" ? "no-safe-identity-action" : "evidence-not-qualified",
    automaticStateWriteAllowed: false,
    automaticExternalVerificationAllowed: false,
  };
  if (qualification !== "qualified" || !field || !time || !relation) return base;
  if (time.factTime === "historical") {
    return { ...base, reason: "historical-identity-fact-does-not-create-current-state" };
  }
  if (!current) {
    if (field.statementPolarity === "denies") {
      return { ...base, reason: "identity-denial-cannot-create-current-state" };
    }
    return { ...base, action: "accumulate_evidence", reason: "identity-evidence-awaits-layer-specific-review" };
  }
  if (["equivalent", "supports"].includes(relation.relation)) {
    return { ...base, action: "reinforce", reason: "same-identity-fact-supports-current-state" };
  }
  if (relation.relation === "additional_value") {
    return { ...base, action: cardinality === "multi_item" ? "accumulate_evidence" : "review_required",
      reason: cardinality === "multi_item" ? "additional-identity-value-awaits-lossless-set-review"
        : "additional-value-does-not-match-field-cardinality" };
  }
  if (relation.relation === "value_changed") {
    return { ...base, action: "supersede", reason: "subject-explicitly-reports-a-current-identity-change" };
  }
  if (relation.relation === "narrows") {
    return { ...base, action: "narrow_scope", reason: "identity-scope-is-explicitly-clarified" };
  }
  if (relation.relation === "broadens") {
    return { ...base, action: "review_required", reason: "identity-scope-broadening-needs-review" };
  }
  if (relation.relation === "retires") {
    return { ...base, action: "retire", reason: "subject-explicitly-reports-identity-state-ended" };
  }
  if (relation.relation === "same_scope_conflict") {
    if (time.revisionCue === "denies_prior_state") {
      return { ...base, action: "correct_attribution", reason: "subject-denies-prior-identity-attribution" };
    }
    return { ...base, action: "contradict", reason: "same-scope-identity-conflict-without-safe-transition" };
  }
  return base;
}

function merge({ evaluation, persistEvidenceLedger }) {
  const maps = Object.fromEntries(
    Object.entries(evaluation.analyses).map(([key, value]) => [key, mapBy(value)]),
  );
  const memoryIds = unique(Object.values(evaluation.analyses).flat().map((item) => item.memoryId));
  const observations = [];
  const previews = [];
  for (const memoryId of memoryIds) {
    if (Object.values(maps).some(map => !map.has(memoryId))) continue;
    const memory = evaluation.snapshot.memories.find((item) => item.id === memoryId);
    const field = maps.fieldValue?.get(memoryId) || null;
    const subject = maps.subjectAttribution?.get(memoryId) || null;
    const boundary = maps.familyBoundary?.get(memoryId) || null;
    const time = maps.timeRevision?.get(memoryId) || null;
    const relation = maps.currentRelation?.get(memoryId) || null;
    const blocked = gate({
      field,
      subject,
      boundary,
      time,
      relation,
      current: evaluation.snapshot.currentState,
      cardinality: evaluation.snapshot.target.fieldCardinality,
    });
    const qualification = blocked?.qualification || "qualified";
    const analyses = [field, subject, boundary, time, relation].filter(Boolean);
    const sourceIds = unique(analyses.flatMap((item) => item.sourceIds)).sort();
    const runIds = Object.entries(maps)
      .filter(([, map]) => map.has(memoryId))
      .map(([key]) => evaluation.runs[key])
      .filter((run) => run?.status === "completed")
      .map((run) => run.id)
      .sort();
    let observation = null;
    if (persistEvidenceLedger && sourceIds.length && runIds.length) {
      const opposition = ["value_changed", "narrows", "retires", "same_scope_conflict"].includes(relation?.relation);
      observation = evaluation.repository.recordStateEvidenceObservation({
        agentId: evaluation.snapshot.agentId,
        batchId: evaluation.batchId,
        stateFamily: "identity",
        subjectRole: evaluation.snapshot.target.subjectRole,
        subjectKey: evaluation.snapshot.target.subjectKey,
        canonicalKey: evaluation.snapshot.target.canonicalKey,
        memoryId,
        evidenceGroupId: memory.evidenceGroupId,
        contextId: memory.contextId,
        signal: field?.statementPolarity === "denies" ? "identity_denial" : "identity_assertion",
        claimedDirection: opposition ? "opposition" : "support",
        effectiveDirection: qualification === "qualified"
          ? (opposition ? "opposition" : "support")
          : "neutral",
        qualification,
        confidence: Math.min(...analyses.map((item) => item.confidence)),
        origin: "llm",
        scope: {
          identityField: evaluation.snapshot.target.identityField,
          identityLabel: evaluation.snapshot.target.identityLabel,
          fieldCardinality: evaluation.snapshot.target.fieldCardinality,
          currentRepresentationLayer: evaluation.snapshot.target.currentRepresentationLayer,
          valueText: field?.valueText || "",
          valueScope: field?.valueScope || "",
          sensitivity: boundary?.sensitivity || "unknown",
          factTime: time?.factTime || "unknown",
          currentRelation: relation?.relation || "unknown",
          valueOverlap: relation?.valueOverlap || "unknown",
        },
        payloadSchemaVersion: "identity-merged-evidence-v1",
        payload: { field, subject, boundary, time, relation },
        excludedReason: blocked?.reason || "",
        sourceIds,
        analysisRunIds: runIds,
        observedAt: memory.eventStart || memory.eventDate || memory.knownAt,
      });
      observations.push(observation);
    }
    previews.push({
      memoryId,
      observationId: observation?.id || "",
      qualification,
      gateReason: blocked?.reason || "",
      ...action({
        qualification,
        field,
        time,
        relation,
        current: evaluation.snapshot.currentState,
        cardinality: evaluation.snapshot.target.fieldCardinality,
      }),
    });
  }
  return { observations, previews };
}

export async function evaluateIdentityEvidence({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  subjectLabel = "",
  canonicalKey,
  identityField,
  identityLabel,
  fieldCardinality,
  memoryIds = [],
  analyzers = {},
  currentRepresentationLayer = "",
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {},
  maximumAnalyses = Infinity,
  persistEvidenceLedger = true,
} = {}) {
  if (!repository) throw new Error("Identity evaluation requires a repository.");
  if (clean(subjectRole) === "shared") {
    throw new Error("Identity evaluation requires an individual fixed subject.");
  }
  if (!STATE_IDENTITY_FIELDS.includes(clean(identityField)) || !clean(identityLabel)) {
    throw new Error("Identity evaluation requires a fixed identity field and readable label.");
  }
  if (!CARDINALITIES.has(clean(fieldCardinality))) {
    throw new Error("Identity evaluation requires an explicit field cardinality policy.");
  }
  normalizeStateAnalysisTargetSpec("identity", { identityField: clean(identityField), fieldCardinality: clean(fieldCardinality) }, { allowEmpty: false });
  for (const key of Object.keys(IDENTITY_ANALYZERS)) {
    if (typeof analyzers[key] !== "function") {
      throw new Error(`Identity evaluation requires analyzers.${key}.`);
    }
  }
  const normalizedIds = unique(memoryIds);
  const batch = batchId({
    agentId,
    subjectRole,
    subjectKey,
    identityField,
    fieldCardinality,
    canonicalKey,
    currentRepresentationLayer,
    memoryIds: normalizedIds,
  });
  const base = buildPreferenceEvidenceSnapshot({
    repository,
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    memoryIds: normalizedIds,
    ...snapshotOptions,
  });
  const snapshot = {
    ...base,
    agentId: clean(agentId),
    target: {
      ...base.target,
      subjectLabel: clean(subjectLabel) || clean(subjectKey),
      stateFamily: "identity",
      identityField: clean(identityField),
      identityLabel: clean(identityLabel),
      fieldCardinality: clean(fieldCardinality),
      currentRepresentationLayer: clean(currentRepresentationLayer),
    },
    currentState: currentView(
      repository,
      clean(agentId),
      base.target.subjectRole,
      base.target.subjectKey,
      base.target.canonicalKey,
      clean(currentRepresentationLayer),
    ),
    inputPolicy: {
      ...base.inputPolicy,
      // Request-bound raw speech may discuss or quote someone other than its speaker.
      // Attribution decides whether the fixed target is actually described.
      identityTargetIsRequestBound: Boolean(clean(snapshotOptions.analysisRequestId)),
      identityTargetIsFixedByCaller: true,
      fieldCardinalityIsFixedByCaller: true,
      currentStateIsReadOnly: true,
      currentStateLayerIsFixedByCaller: Boolean(clean(currentRepresentationLayer)),
      modelCanChooseCanonicalKey: false,
      modelCanChooseStateAction: false,
      credentialMemoryAllowed: false,
      automaticStateWriteAllowed: false,
    },
  };
  snapshotOptions.prepareStateSnapshot?.(snapshot);
  const limit = Math.min(
    250000,
    Math.max(4000, Math.trunc(Number(snapshotOptions.maxSnapshotChars) || 64000)),
  );
  if (JSON.stringify(snapshot).length > limit) {
    throw new Error(`Identity evidence snapshot exceeds the ${limit}-character privacy budget.`);
  }
  if (!snapshot.memories.length) {
    return {
      status: "skipped",
      reason: "no-eligible-memories-with-direct-sources",
      batchId: batch,
      snapshot,
      runs: {},
      analyses: {},
      rejected: {},
      observations: [],
      actionPreviews: [],
      failedRoles: [],
      warnings: [],
      automaticStateWriteAllowed: false,
      automaticExternalVerificationAllowed: false,
    };
  }
  const definitions = Object.entries(IDENTITY_ANALYZERS);
  const previousRuns = priorAnalyzerRuns(repository, snapshot, batch, definitions, snapshotOptions);
  const invocations = await Promise.all(definitions.map(async ([key, definition]) => [
    key,
    await invoke({
      definition,
      generator: analyzers[key],
      snapshot,
      promptDirectory,
      maximumAnalyses, previousRuns,
    }),
  ]));
  const { runs, analyses, rejected, warnings, failedRoles } = await recordAnalyzerInvocations({
    repository, agentId, batchId: batch, stateFamily: 'identity', snapshot, invocations, usageLedgerPath,
    metadata: { stateAnalysisRequestId: clean(snapshotOptions.analysisRequestId), identityField: clean(identityField), fieldCardinality: clean(fieldCardinality), currentRepresentationLayer: clean(currentRepresentationLayer), automaticStateWriteAllowed: false },
  });
  const evaluation = { repository, batchId: batch, snapshot, runs, analyses };
  const merged = repository.transaction(() => merge({ evaluation, persistEvidenceLedger }));
  const any = Object.values(analyses).some((items) => items.length);
  return {
    status: failedRoles.length ? "incomplete" : any ? "analyzed" : "abstained",
    reason: failedRoles.length ? "required-identity-analyzer-failed-or-rejected" : "",
    batchId: batch,
    snapshot,
    runs,
    analyses,
    rejected,
    observations: merged.observations,
    actionPreviews: merged.previews,
    failedRoles,
    warnings,
    automaticStateWriteAllowed: false,
    automaticExternalVerificationAllowed: false,
  };
}
