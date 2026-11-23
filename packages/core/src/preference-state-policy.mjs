import { memoryWorldScope, commonMemoryWorld } from './ontology.mjs';
import { enqueueMemoryMaintenanceTasks, MAINTENANCE_TASK_TYPES } from './maintenance-tasks.mjs';
import { createHash } from "node:crypto";
import { readStateAnalysisSemanticMemory, recordStateClosure } from './reported-state-policy.mjs';
import { syncMemoryRelationshipMemberships } from './relationship-structure.mjs';
import { updateAssociationGraph } from './association-graph.mjs';
import { invalidatePreferenceEvidenceMemories } from './preference-evidence-memory.mjs';

import {
  NON_STATE_SCOPE_KEY,
  ROOT_STATE_SCOPE_KEY,
  isValidStateScopeKey,
} from "./state-scope.mjs";

const LEVELS = Object.freeze([
  "situational_tolerance",
  "selection_tendency",
  "stable_preference",
  "direct_preference",
  "explicit_rejection",
  "no_conclusion",
]);

const POSITIVE_LEVEL_RANK = Object.freeze({
  no_conclusion: 0,
  situational_tolerance: 1,
  selection_tendency: 2,
  stable_preference: 3,
  direct_preference: 4,
});

const DIRECT_LEVELS = new Set(["direct_preference", "explicit_rejection"]);
const CHALLENGE_PREVIEWS = new Set([
  "conflicting-evidence",
  "state-change-review-required",
]);
const SUPPORT_SIGNALS = new Set([
  "explicit_preference",
  "active_choice",
  "repeated_behavior",
  "active_sharing",
  "voluntary_acceptance",
]);
const OPPOSITION_SIGNALS = new Set(["explicit_rejection", "counter_behavior"]);

export class PreferenceStateValidationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PreferenceStateValidationError';
    this.code = 'MEMORY_PREFERENCE_STATE_VALIDATION_FAILED';
  }
}

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");
}

function cleanStringList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : []).map(clean).filter(Boolean),
  )];
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(clean(value)));
}

function latestTimestamp(values, fallback = new Date().toISOString()) {
  const timestamps = values.map(clean).filter(validTimestamp).map((value) => new Date(value).toISOString());
  return timestamps.sort().at(-1) || fallback;
}

function stateKind(level) {
  return DIRECT_LEVELS.has(level) ? "preference" : "derived_hypothesis";
}

function representationLayerForLevel(level) {
  return DIRECT_LEVELS.has(level) ? "reported" : "inferred";
}

function inferredLevel(memory) {
  const stored = clean(memory?.metadata?.preferenceStateLevel);
  if (LEVELS.includes(stored)) return stored;
  if (memory?.kind === "preference") {
    return memory.evidence_mode === "explicit" ? "direct_preference" : "stable_preference";
  }
  return "";
}

function directionForEvidence(item) {
  if (clean(item?.ignoredReason)) return "neutral";
  const explicit = clean(item?.direction);
  if (["support", "opposition", "neutral"].includes(explicit)) return explicit;
  const signal = clean(item?.signal);
  if (SUPPORT_SIGNALS.has(signal)) return "support";
  if (OPPOSITION_SIGNALS.has(signal)) return "opposition";
  return "neutral";
}

export function preferenceEvidenceSnapshot(detail, { memoryId, sourceIds }) {
  if (!detail?.memory) throw new PreferenceStateValidationError(`Preference proposal evidence ${memoryId} is unavailable.`);
  const sources = new Map(detail.sources.map((source) => [source.id, source]));
  if (sourceIds.some((sourceId) => !sources.has(sourceId))) {
    throw new PreferenceStateValidationError(`Preference proposal evidence ${memoryId} references an unrelated source.`);
  }
  const memory = detail.memory;
  return canonicalHash({
    memory: {
      id: memory.id,
      agentId: memory.agent_id,
      kind: memory.kind,
      content: memory.content,
      subjectRole: memory.subject_role,
      subjectKey: memory.subject_key,
      canonicalKey: memory.canonical_key,
      reality: memory.reality,
      evidenceMode: memory.evidence_mode,
      representationLayer: memory.representation_layer,
      stateFamily: memory.state_family,
      temporalState: memory.temporal_state,
      eventStart: memory.event_start,
      eventEnd: memory.event_end,
      knownAt: memory.known_at,
      validFrom: memory.valid_from,
      validTo: memory.valid_to,
      status: memory.status,
    },
    roles: detail.roles.map((role) => ({
      role: role.role,
      actorRole: role.actor_role,
      actorKey: role.actor_key,
      isPrimary: role.is_primary,
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    sources: sourceIds.map((sourceId) => {
      const source = sources.get(sourceId);
      return {
        id: source.id,
        sourceKind: source.source_kind,
        externalId: source.external_id,
        occurredAt: source.occurred_at,
        knownAt: source.known_at,
        speaker: source.speaker,
        content: source.content,
        authority: source.authority,
        sourceTrust: source.source_trust,
        evidenceStrength: source.evidence_strength,
      };
    }).sort((left, right) => left.id.localeCompare(right.id)),
  });
}

function normalizeEvidence(repository, { agentId, subjectRole, subjectKey, canonicalKey, evidence, observationHashes }) {
  const seen = new Set();
  return (Array.isArray(evidence) ? evidence : []).map((item, index) => {
    const memoryId = clean(item?.memoryId ?? item?.memory_id);
    const memory = repository.getMemory(memoryId);
    if (!memoryId || !memory || memory.agent_id !== agentId || memory.status === "deleted") {
      throw new PreferenceStateValidationError(`Preference proposal evidence ${index} must exist for the same Agent.`);
    }
    if (seen.has(memoryId)) {
      throw new PreferenceStateValidationError(`Preference proposal evidence repeats memoryId: ${memoryId}`);
    }
    seen.add(memoryId);
    const evidenceGroupId = clean(item?.evidenceGroupId ?? item?.evidence_group_id);
    const signal = clean(item?.signal);
    const sourceIds = cleanStringList(item?.sourceIds ?? item?.source_ids).sort();
    if (!evidenceGroupId || !signal || !sourceIds.length) {
      throw new PreferenceStateValidationError(`Preference proposal evidence ${memoryId} requires a group, signal, and direct sources.`);
    }
    const direction = directionForEvidence(item);
    const confidence = bounded(item?.confidence, 0.5);
    if (memory.subject_role !== subjectRole || memory.subject_key !== subjectKey) {
      // Raw speech retains its speaker. A qualified observation can establish
      // a different holder for the accumulated behavior and its exact sources.
      const observationId = clean(item?.observationId);
      const expectedHash = observationHashes?.get(observationId);
      const observation = expectedHash ? repository.getStateEvidenceObservation(agentId, observationId) : null;
      if (memory.status !== "active" || !observation || observation.observation_hash !== expectedHash
        || observation.lifecycle !== "current" || observation.qualification !== "qualified"
        || observation.state_family !== "preference" || observation.scope?.currentRepresentationLayer !== "inferred"
        || observation.subject_role !== subjectRole || observation.subject_key !== subjectKey
        || observation.canonical_key !== canonicalKey || observation.memory_id !== memoryId
        || signal.startsWith("explicit_") || observation.signal !== signal
        || observation.effective_direction !== direction || observation.confidence !== confidence
        || observation.sourceIds.length !== sourceIds.length
        || observation.sourceIds.some(sourceId => !sourceIds.includes(sourceId))) {
        throw new PreferenceStateValidationError(`Preference proposal evidence ${memoryId} belongs to a different subject.`);
      }
    }
    const evidenceSnapshotHash = preferenceEvidenceSnapshot(repository.getMemoryDetail(agentId, memoryId), {
      memoryId,
      sourceIds,
    });
    return {
      memoryId,
      evidenceGroupId,
      contextId: clean(item?.contextId ?? item?.context_id),
      signal,
      direction,
      confidence,
      sourceIds,
      evidenceSnapshotHash,
      knownAt: memory.known_at || memory.event_start || memory.recorded_at,
      label: { ...object(item) },
    };
  });
}

function transitionFor({ currentLevel, proposedLevel, previewStatus, evidenceReviewMode, scopeChange }) {
  if (!currentLevel) return "create";
  if (proposedLevel === "no_conclusion" && evidenceReviewMode === "full_canonical") return "downgrade";
  if (CHALLENGE_PREVIEWS.has(previewStatus)) return "challenge";
  if (previewStatus === "behavioral-opposition" && evidenceReviewMode !== "full_canonical") {
    return "challenge";
  }
  if (DIRECT_LEVELS.has(proposedLevel)) {
    return proposedLevel === currentLevel ? "reinforce" : "replace_explicit";
  }
  if (DIRECT_LEVELS.has(currentLevel)) return "challenge";
  if (proposedLevel === currentLevel) {
    if (scopeChange === "narrower") {
      return evidenceReviewMode === "full_canonical" ? "narrow_scope" : "challenge";
    }
    return "reinforce";
  }
  const currentRank = POSITIVE_LEVEL_RANK[currentLevel];
  const proposedRank = POSITIVE_LEVEL_RANK[proposedLevel];
  if (!Number.isFinite(currentRank) || !Number.isFinite(proposedRank)) return "challenge";
  if (proposedRank > currentRank) return "promote";
  return evidenceReviewMode === "full_canonical" ? "downgrade" : "challenge";
}

function formatState({ level, subjectLabel, objectLabel, scopeLabel }) {
  const scope = clean(scopeLabel) ? `在${clean(scopeLabel)}中` : "";
  const holder = clean(subjectLabel);
  const target = clean(objectLabel);
  const title = `${holder}对${target}的偏好认识`;
  const contentByLevel = {
    situational_tolerance: `${holder}${scope}对${target}表现为可以接受，但现有证据不足以说明喜欢。`,
    selection_tendency: `${holder}${scope}表现出对${target}的选择倾向。`,
    stable_preference: `${holder}${scope}对${target}表现出稳定偏好。`,
    direct_preference: `${holder}明确表示${scope}喜欢${target}。`,
    explicit_rejection: `${holder}明确表示${scope}不喜欢${target}。`,
    no_conclusion: `目前没有足够证据判断${holder}${scope}是否偏好${target}。`,
  };
  return { title, content: contentByLevel[level] };
}

function proposalHash(candidate) {
  return canonicalHash({
    agentId: candidate.agentId,
    subjectRole: candidate.subjectRole,
    subjectKey: candidate.subjectKey,
    canonicalKey: candidate.canonicalKey,
    representationLayer: candidate.representationLayer,
    stateScopeKey: candidate.stateScopeKey,
    previousMemoryId: candidate.previousMemoryId,
    subjectLabel: candidate.subjectLabel,
    objectLabel: candidate.objectLabel,
    scopeLabel: candidate.scopeLabel,
    proposedLevel: candidate.proposedLevel,
    transition: candidate.transition,
    scope: candidate.scope,
    evidenceReviewMode: candidate.evidenceReviewMode,
    policyVersion: candidate.policyVersion,
    evidence: candidate.evidence.map((item) => ({
      memoryId: item.memoryId,
      evidenceGroupId: item.evidenceGroupId,
      contextId: item.contextId,
      signal: item.signal,
      direction: item.direction,
      confidence: item.confidence,
      sourceIds: item.sourceIds,
      evidenceSnapshotHash: item.evidenceSnapshotHash,
      agency: item.label.agency,
      constraint: item.label.constraint,
      alternatives: item.label.alternatives,
      instrumentalGoal: item.label.instrumentalGoal,
      opportunityCost: item.label.opportunityCost,
      topicInitiation: item.label.topicInitiation,
      affectiveExpression: item.label.affectiveExpression,
      canDecline: item.label.canDecline,
      ignoredReason: item.label.ignoredReason,
    })),
    metadata: candidate.metadata,
  });
}

function validateStateEvidence({ proposedLevel, transition, evidence }) {
  const support = evidence.filter((item) => item.direction === "support");
  const opposition = evidence.filter((item) => item.direction === "opposition");
  if (transition === "challenge") {
    if (!opposition.length) {
      throw new PreferenceStateValidationError("A preference challenge requires opposition evidence.");
    }
    return;
  }
  if (["direct_preference"].includes(proposedLevel)
    && !support.some((item) => item.signal === "explicit_preference")) {
    throw new PreferenceStateValidationError("A direct preference proposal requires explicit preference evidence.");
  }
  if (proposedLevel === "explicit_rejection"
    && !opposition.some((item) => item.signal === "explicit_rejection")) {
    throw new PreferenceStateValidationError("An explicit rejection proposal requires explicit rejection evidence.");
  }
  if (["situational_tolerance", "selection_tendency", "stable_preference"].includes(proposedLevel)
    && !support.length) {
    throw new PreferenceStateValidationError("A positive preference state proposal requires supporting evidence.");
  }
}

export function proposePreferenceState(repository, input = {}) {
  if (!repository) throw new Error("Preference state proposal requires a repository.");
  const agentId = clean(input.agentId);
  const subjectRole = clean(input.subjectRole);
  const subjectKey = clean(input.subjectKey);
  const canonicalKey = clean(input.canonicalKey).toLocaleLowerCase("en-US");
  const proposedLevel = clean(input.proposedLevel);
  const subjectLabel = clean(input.subjectLabel);
  const objectLabel = clean(input.objectLabel);
  const policyVersion = clean(input.policyVersion);
  const previewStatus = clean(input.previewStatus);
  const evidenceReviewMode = clean(input.evidenceReviewMode) || "bounded";
  const expectedRepresentationLayer = representationLayerForLevel(proposedLevel);
  const representationLayer = clean(input.representationLayer) || expectedRepresentationLayer;
  const stateScopeKey = clean(input.stateScopeKey) || ROOT_STATE_SCOPE_KEY;
  if (!agentId || !["user", "agent", "shared", "other"].includes(subjectRole)
    || !subjectKey || !canonicalKey || !LEVELS.includes(proposedLevel)
    || !subjectLabel || !objectLabel || !policyVersion || !previewStatus
    || !["bounded", "full_canonical"].includes(evidenceReviewMode)
    || representationLayer !== expectedRepresentationLayer
    || !isValidStateScopeKey(stateScopeKey) || stateScopeKey === NON_STATE_SCOPE_KEY) {
    throw new PreferenceStateValidationError("Preference state proposal target is incomplete.");
  }
  if (representationLayer === "established") {
    throw new Error("Established preference requires the dedicated cross-layer promotion policy.");
  }
  const metadata = object(input.metadata);
  const observationHashes = representationLayer === "inferred" && evidenceReviewMode === "full_canonical"
    && metadata.accumulatedPreference === true && Array.isArray(metadata.observationHashes)
    ? new Map(metadata.observationHashes.map(item => [item?.id, item?.hash])) : null;
  const evidence = normalizeEvidence(repository, {
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    evidence: input.evidence,
    observationHashes,
  });
  if (!evidence.length) throw new PreferenceStateValidationError("Preference state proposal requires evidence.");
  const world = preferenceProposalWorld(repository, { agent_id: agentId, subject_role: subjectRole, subject_key: subjectKey, canonical_key: canonicalKey, metadata, evidence });
  const current = repository.getCurrentCanonicalMemory({
    ...world,
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer,
    stateFamily: "preference",
    stateScopeKey,
  });
  const requestedPreviousMemoryId = clean(input.previousMemoryId);
  if (requestedPreviousMemoryId && requestedPreviousMemoryId !== current?.id) {
    throw new PreferenceStateValidationError("Preference state proposal does not target the current canonical state.");
  }
  const currentLevel = inferredLevel(current);
  const transition = transitionFor({
    currentLevel,
    proposedLevel,
    previewStatus,
    evidenceReviewMode,
    scopeChange: clean(input.scopeChange),
  });
  const expectedTransition = clean(input.expectedTransition);
  if (expectedTransition && transition !== expectedTransition) {
    throw new Error(
      `Preference transition changed after review: expected ${expectedTransition}, got ${transition}.`,
    );
  }
  if (["challenge", "reinforce", "promote", "downgrade", "narrow_scope", "replace_explicit"]
    .includes(transition) && !current) {
    throw new PreferenceStateValidationError(`Preference transition ${transition} requires a current state.`);
  }
  if (["downgrade", "narrow_scope"].includes(transition)
    && evidenceReviewMode !== "full_canonical") {
    throw new PreferenceStateValidationError("Preference downgrade requires a full canonical evidence review.");
  }
  validateStateEvidence({ proposedLevel, transition, evidence });
  const timestamps = evidence.map((item) => item.knownAt);
  const knownAt = latestTimestamp([input.knownAt, ...timestamps]);
  const validFrom = latestTimestamp([input.validFrom, knownAt], knownAt);
  if (current?.valid_from && validFrom < current.valid_from) {
    throw new PreferenceStateValidationError("Preference proposal cannot predate the current state validity.");
  }
  const proposedKind = stateKind(proposedLevel);
  const scope = object(input.scope);
  const formatted = formatState({
    level: proposedLevel,
    subjectLabel,
    objectLabel,
    scopeLabel: input.scopeLabel,
  });
  const confidenceFallback = evidence.length
    ? evidence.reduce((sum, item) => sum + item.confidence, 0) / evidence.length
    : 0.5;
  const confidence = proposedKind === "derived_hypothesis"
    ? Math.min(0.65, bounded(input.confidence, confidenceFallback))
    : bounded(input.confidence, confidenceFallback);
  const candidate = {
    agentId,
    batchId: clean(input.batchId),
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    objectLabel,
    scopeLabel: clean(input.scopeLabel),
    scope,
    representationLayer,
    stateScopeKey,
    previousMemoryId: current?.id || null,
    proposedLevel,
    transition,
    proposedKind,
    title: formatted.title,
    content: formatted.content,
    evidenceReviewMode,
    confidence,
    knownAt,
    validFrom,
    policyVersion,
    previewStatus,
    metrics: object(input.metrics),
    rationale: clean(input.rationale),
    provenance: clean(input.provenance) || "preference-state-proposal-v1",
    evidence,
    metadata,
    createdAt: clean(input.createdAt) || new Date().toISOString(),
  };
  const hash = proposalHash(candidate);
  const id = clean(input.id) || `preference-proposal-${createHash("sha256")
    .update(`${agentId}\u001f${hash}`)
    .digest("hex")
    .slice(0, 24)}`;
  return repository.transaction(() => {
    const saved = repository.recordPreferenceStateProposal({ ...candidate, id, proposalHash: hash });
    const result = applyPreferenceState(repository, saved, { recompute: true });
    return { ...result.proposal, wasInserted: saved.wasInserted };
  });
}

function preferenceProposalWorld(repository, proposal) {
  const semantic = readStateAnalysisSemanticMemory(repository, proposal);
  if (semantic) return memoryWorldScope(semantic);
  const observationIds = cleanStringList([
    ...(proposal.metadata?.observationIds || []),
    ...(proposal.metadata?.canonicalReview?.observationSnapshots || []).map(item => item.id),
    ...proposal.evidence.map(item => item.label?.observationId || item.observationId),
  ]);
  if (observationIds.length) {
    const observations = observationIds.map(id => repository.getStateEvidenceObservation(proposal.agent_id, id));
    if (observations.some(item => !item || item.state_family !== 'preference' || item.subject_role !== proposal.subject_role
      || item.subject_key !== proposal.subject_key || item.canonical_key !== proposal.canonical_key)) {
      throw new PreferenceStateValidationError('Preference proposal observation escaped its fixed target.');
    }
    const world = commonMemoryWorld(observations.map(item => item.world));
    if (!world) throw new PreferenceStateValidationError('Preference proposal observations cross incompatible worlds.');
    return world;
  }
  const memories = proposal.evidence.map(item => repository.getMemory(item.memoryId));
  const world = commonMemoryWorld(memories, semantic);
  if (!world) throw new PreferenceStateValidationError('Preference proposal evidence crosses incompatible worlds.');
  return world;
}

function currentStateForProposal(repository, proposal) {
  const current = repository.getCurrentCanonicalMemory({
    ...preferenceProposalWorld(repository, proposal),
    agentId: proposal.agent_id,
    subjectRole: proposal.subject_role,
    subjectKey: proposal.subject_key,
    canonicalKey: proposal.canonical_key,
    representationLayer: proposal.representation_layer,
    stateFamily: "preference",
    stateScopeKey: proposal.state_scope_key,
  });
  if ((current?.id || "") !== (proposal.previousMemoryId || "")) {
    throw new PreferenceStateValidationError("Preference state changed after proposal creation; review it again.");
  }
  return current;
}

function validateCanonicalReviewSnapshot(repository, proposal) {
  const review = proposal.metadata?.canonicalReview;
  if (!review) return;
  if (proposal.representation_layer !== "inferred"
    || proposal.state_scope_key !== ROOT_STATE_SCOPE_KEY
    || review.representationLayer !== "inferred"
    || review.stateScopeKey !== ROOT_STATE_SCOPE_KEY
    || review.establishedPromotionAllowed !== false) {
    throw new Error("Canonical preference review crossed its approved representation boundary.");
  }
  const observationSnapshots = Array.isArray(review.observationSnapshots)
    ? review.observationSnapshots
    : [];
  if (!observationSnapshots.length
    || observationSnapshots.some((item) => (
      !clean(item?.id) || !/^[0-9a-f]{64}$/u.test(clean(item?.hash))
    ))) {
    throw new Error("Canonical preference review snapshot is incomplete; review it again.");
  }
  const world = preferenceProposalWorld(repository, proposal);
  const currentObservations = repository.listStateEvidenceObservations(proposal.agent_id, {
    world,
    stateFamily: "preference",
    subjectRole: proposal.subject_role,
    subjectKey: proposal.subject_key,
    canonicalKey: proposal.canonical_key,
    lifecycles: ["current"],
    limit: 1000,
  });
  const expectedIds = observationSnapshots.map((item) => clean(item.id)).sort();
  const currentIds = currentObservations.map((item) => item.id).sort();
  if (JSON.stringify(currentIds) !== JSON.stringify(expectedIds)) {
    throw new Error("Preference evidence set changed after canonical review; review it again.");
  }
  const currentById = new Map(currentObservations.map((item) => [item.id, item]));
  if (observationSnapshots.some((item) => (
    currentById.get(clean(item.id))?.observation_hash !== clean(item.hash)
  ))) {
    throw new Error("Preference evidence observation changed after canonical review; review it again.");
  }
  for (const [role, runId] of [
    ["preference-state-synthesizer", clean(review.synthesisRunId)],
    ["preference-state-critic", clean(review.criticRunId)],
  ]) {
    const run = runId ? repository.getStateAnalysisRun(proposal.agent_id, runId) : null;
    if (!run || run.status !== "completed" || run.state_family !== "preference"
      || run.analyzer_role !== role || run.subject_role !== proposal.subject_role
      || run.subject_key !== proposal.subject_key
      || run.canonical_key !== proposal.canonical_key) {
      throw new Error("Canonical preference review audit run is unavailable; review it again.");
    }
  }
}

function attachEvidence(repository, proposal, targetMemory) {
  const provenance = 'preference-state-proposal-v1';
  const attachedSources = repository.listMemorySources(targetMemory.id);
  const entityIds = new Set();
  for (const item of proposal.evidence) {
    const evidenceDetail = repository.getMemoryDetail(proposal.agent_id, item.memoryId);
    const currentSnapshotHash = preferenceEvidenceSnapshot(evidenceDetail, {
      memoryId: item.memoryId,
      sourceIds: item.sourceIds,
    });
    if (!item.evidenceSnapshotHash || currentSnapshotHash !== item.evidenceSnapshotHash) {
      throw new Error("Preference proposal evidence changed after review; review it again.");
    }
    if (item.direction === "neutral" || item.memoryId === targetMemory.id) continue;
    const relation = item.direction === "support" ? "supported_by" : "challenged_by";
    for (const entity of evidenceDetail.entities) entityIds.add(entity.id);
    const sources = new Map((evidenceDetail?.sources || []).map((source) => [source.id, source]));
    for (const sourceId of item.sourceIds) {
      const source = sources.get(sourceId);
      const existing = attachedSources.find(link => link.id === sourceId
        && link.relation === `preference_${item.direction}`);
      if (existing && existing.evidenceMetadata?.preferenceProposalId !== proposal.id) continue;
      repository.linkSource(targetMemory.id, sourceId, `preference_${item.direction}`, {
        authority: clean(source?.authority) || "model_inference",
        sourceTrust: bounded(source?.source_trust, 0.5),
        evidenceStrength: bounded(item.confidence, 0.5),
        provenance,
        metadata: {
          preferenceProposalId: proposal.id,
          evidenceMemoryId: item.memoryId,
          signal: item.signal,
          direction: item.direction,
        },
      });
    }
    const existingEdge = repository.findEdge({ agentId: proposal.agent_id, fromMemoryId: targetMemory.id,
      toMemoryId: item.memoryId, relation });
    if (existingEdge && existingEdge.metadata?.preferenceProposalId !== proposal.id) continue;
    repository.upsertEdge({
      agentId: proposal.agent_id,
      fromMemoryId: targetMemory.id,
      toMemoryId: item.memoryId,
      relation,
      direction: "directed",
      weight: item.direction === "support" ? 0.85 : 0.7,
      confidence: item.confidence,
      provenance,
      metadata: {
        preferenceProposalId: proposal.id,
        signal: item.signal,
        evidenceGroupId: item.evidenceGroupId,
        contextId: item.contextId,
      },
    });
  }
  repository.linkMemoryEntities({ memoryId: targetMemory.id, entityIds: [...entityIds] });
}


function provisionalPreferenceId(proposal) {
  return 'pending-preference-' + canonicalHash([proposal.agent_id, proposal.id]).slice(0, 24);
}

function preferenceVersion(memory) {
  return canonicalHash([memory.id, memory.title, memory.content, memory.layer, memory.kind,
    memory.subject_role, memory.subject_key, memory.canonical_key, memory.state_scope_key,
    memory.representation_layer, memoryWorldScope(memory), memory.valid_from,
    memory.metadata?.preferenceStateLevel, memory.metadata?.observationHashes]);
}

export function appliedPreferenceStateMemory(repository, proposal, { includeDeleted = false } = {}) {
  if (!proposal?.resultMemoryId || proposal.review_state === 'dismissed') return null;
  const memory = repository.getMemory(proposal.resultMemoryId);
  if (!memory || memory.agent_id !== proposal.agent_id || (!includeDeleted && memory.status === 'deleted')) return null;
  const application = proposal.metadata?.preferenceApplication;
  if (application?.version) return !memory.metadata?.manuallyEdited
    && application.version === preferenceVersion(memory) ? memory : null;
  if (application) return memory;
  return memory.metadata?.preferenceProposalId === proposal.id && memory.title === proposal.title
    && memory.content === proposal.content && !memory.metadata?.manuallyEdited ? memory : null;
}

function preserveLegacyPreferenceApplication(repository, proposal, memory) {
  if (!proposal || proposal.review_state !== 'accepted' || proposal.metadata?.preferenceApplication
    || appliedPreferenceStateMemory(repository, proposal)?.id !== memory.id) return;
  let transition = null;
  const previous = proposal.previousMemoryId ? repository.getMemory(proposal.previousMemoryId) : null;
  const edge = previous && repository.findEdge({ agentId: proposal.agent_id, fromMemoryId: memory.id,
    toMemoryId: previous.id, relation: 'supersedes' });
  const earlier = previous?.metadata?.preferenceProposalId
    ? repository.getPreferenceStateProposal(proposal.agent_id, previous.metadata.preferenceProposalId) : null;
  if (previous?.status === 'superseded' && previous.valid_to === memory.valid_from
    && !previous.metadata?.reportedStateTransitionId && edge?.metadata?.preferenceProposalId === proposal.id
    && earlier?.review_state === 'accepted' && appliedPreferenceStateMemory(repository, earlier)?.id === previous.id) {
    preserveLegacyPreferenceApplication(repository, earlier, previous);
    const fields = { layer: previous.layer, status: previous.status, state_phase: previous.state_phase,
      temporal_state: previous.temporal_state, valid_to: previous.valid_to };
    transition = { memoryId: previous.id,
      before: { ...fields, status: 'active', temporal_state: 'current', valid_to: null, transitionId: '' },
      applied: fields };
    repository.updateMemoryMetadata({ agentId: proposal.agent_id, memoryId: previous.id,
      metadata: { ...previous.metadata, reportedStateTransitionId: proposal.id },
      reason: 'Recover the owner of the recorded legacy preference closure.' });
  }
  repository.database.prepare(`UPDATE memory_preference_state_proposals
    SET metadata_json=json_set(metadata_json, '$.preferenceApplication', json(?)) WHERE agent_id=? AND id=?`)
    .run(JSON.stringify({ version: preferenceVersion(memory), ...(transition ? { transition } : {}) }),
      proposal.agent_id, proposal.id);
}

function applyPreferenceState(repository, proposal, { recompute = false } = {}) {
  if (proposal.review_state === 'dismissed') return { status: 'skipped', proposal, memory: null };
  const applied = appliedPreferenceStateMemory(repository, proposal);
  const reapply = recompute && proposal.metadata?.preferenceApplication?.invalidated
    || proposal.metadata?.accumulatedPreference && applied?.status === 'superseded'
    && !repository.getCurrentCanonicalMemory({ ...memoryWorldScope(applied), agentId: proposal.agent_id,
      subjectRole: proposal.subject_role, subjectKey: proposal.subject_key, canonicalKey: proposal.canonical_key,
      stateFamily: 'preference', representationLayer: proposal.representation_layer, stateScopeKey: proposal.state_scope_key });
  if (proposal.metadata?.preferenceApplication && !reapply) return { status: 'existing', proposal, memory: applied };
  if (proposal.review_state !== 'pending' && !reapply) return { status: 'existing', proposal, memory: applied };
  const current = currentStateForProposal(repository, proposal);
  validateCanonicalReviewSnapshot(repository, proposal);
  for (const expected of proposal.metadata?.observationHashes || []) {
    const observation = repository.getStateEvidenceObservation(proposal.agent_id, expected.id);
    if (!observation || observation.lifecycle !== 'current' || observation.observation_hash !== expected.hash) {
      throw new PreferenceStateValidationError('Preference evidence changed after accumulation; recompute it.');
    }
  }
  const createsVersion = proposal.metadata?.accumulatedPreference || !['challenge', 'reinforce'].includes(proposal.transition);
  if (current && createsVersion && repository.listCurrentScopedExceptions({ agentId: proposal.agent_id, rootMemoryId: current.id }).length) {
    throw new PreferenceStateValidationError('Preference root state has active scoped exceptions; reconcile their evidence before replacing it.');
  }
  let memory = current;
  let transition = null;
  if (createsVersion) {
    const preview = repository.getMemory(provisionalPreferenceId(proposal));
    if (preview?.status === 'deleted' && !reapply) return { status: 'skipped', proposal, memory: null };
    const memoryId = applied?.id || preview?.id || 'preference-state-' + canonicalHash([proposal.agent_id, proposal.id]).slice(0, 24);
    memory = repository.upsertMemory({
      id: memoryId, agentId: proposal.agent_id, kind: proposal.proposed_kind, layer: 'semantic', status: 'active',
      title: proposal.title, content: proposal.content, subjectRole: proposal.subject_role, subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key, ...preferenceProposalWorld(repository, proposal),
      evidenceMode: DIRECT_LEVELS.has(proposal.proposed_level) ? 'explicit' : 'inferred',
      representationLayer: proposal.representation_layer, stateFamily: 'preference', stateScopeKey: proposal.state_scope_key,
      statePhase: 'active', temporalState: 'current', revisionAction: current ? 'update' : 'add',
      knownAt: proposal.known_at, validFrom: proposal.valid_from,
      confidence: proposal.proposed_kind === 'derived_hypothesis' ? Math.min(0.65, proposal.confidence) : proposal.confidence,
      importance: 0.6,
      actorRoles: [{ role: 'preference_holder', actorRole: proposal.subject_role, actorKey: proposal.subject_key,
        isPrimary: true, confidence: proposal.confidence, provenance: 'preference-state-proposal-v1' }],
      metadata: { ...proposal.metadata, preferenceStateLevel: proposal.proposed_level,
        preferenceScope: proposal.scope, preferenceScopeLabel: proposal.scope_label, preferenceProposalId: proposal.id,
        preferencePolicyVersion: proposal.policy_version, preferencePreviewStatus: proposal.preview_status,
        preferenceTransition: proposal.transition, preferenceMetrics: proposal.metrics },
    });
    if (current) {
      const previousProposal = current.metadata?.preferenceProposalId
        ? repository.getPreferenceStateProposal(proposal.agent_id, current.metadata.preferenceProposalId) : null;
      preserveLegacyPreferenceApplication(repository, previousProposal, current);
      transition = recordStateClosure(repository, proposal, current, () => repository.closeCurrentMemoryState({
        agentId: proposal.agent_id, memoryId: current.id, validTo: proposal.valid_from,
      }));
      repository.upsertEdge({ agentId: proposal.agent_id, fromMemoryId: memory.id, toMemoryId: current.id,
        relation: 'supersedes', direction: 'directed', weight: 1, confidence: proposal.confidence,
        provenance: 'preference-state-proposal-v1', metadata: { preferenceProposalId: proposal.id, transition: proposal.transition } });
    }
  }
  attachEvidence(repository, proposal, memory);
  const application = { ...(createsVersion ? { version: preferenceVersion(memory) } : {}),
    ...(transition ? { transition } : {}) };
  repository.database.prepare(
    "UPDATE memory_preference_state_proposals SET result_memory_id=?, metadata_json=json_set(metadata_json, '$.preferenceApplication', json(?)), updated_at=? WHERE agent_id=? AND id=? AND review_state IN ('pending','accepted')"
  ).run(memory.id, JSON.stringify(application), new Date().toISOString(), proposal.agent_id, proposal.id);
  if (createsVersion) {
    const maintenance = { repository, agentId: proposal.agent_id, memoryIds: [memory.id] };
    syncMemoryRelationshipMemberships(maintenance);
    updateAssociationGraph(maintenance);
    enqueueMemoryMaintenanceTasks({ ...maintenance, batchId: 'preference-state:' + proposal.id,
      taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding, MAINTENANCE_TASK_TYPES.structureProposal] });
  }
  return { status: proposal.transition === 'challenge' ? 'challenge-accepted'
    : proposal.transition === 'reinforce' ? 'reinforced' : proposal.transition,
    proposal: repository.getPreferenceStateProposal(proposal.agent_id, proposal.id), memory: repository.getMemory(memory.id), previous: current };
}

export function materializePreferenceStateProposal(repository, { agentId, proposalId } = {}) {
  const proposal = repository.getPreferenceStateProposal(clean(agentId), proposalId);
  if (!proposal) throw new Error('Preference state proposal does not exist for this Agent.');
  if (proposal.representation_layer !== 'inferred') throw new Error('Preference materialization requires an inferred proposal.');
  return repository.transaction(() => {
    const result = applyPreferenceState(repository, proposal);
    return { ...result, status: ['existing', 'skipped'].includes(result.status) ? result.status : 'created' };
  });
}

function undoPreferenceState(repository, proposal, memory, erasing) {
  if (!memory) return null;
  repository.database.prepare("DELETE FROM memory_edges WHERE agent_id=? AND from_memory_id=? AND json_extract(metadata_json, '$.preferenceProposalId')=?")
    .run(proposal.agent_id, memory.id, proposal.id);
  repository.database.prepare("DELETE FROM memory_sources WHERE memory_id=? AND json_extract(metadata_json, '$.preferenceProposalId')=?")
    .run(memory.id, proposal.id);
  const application = proposal.metadata?.preferenceApplication;
  const ownsVersion = application?.version || memory.metadata?.preferenceProposalId === proposal.id;
  if (ownsVersion) repository.setMemoryDeleted({ agentId: proposal.agent_id, memoryId: memory.id,
    actor: 'preference-review', reason: 'Preference state withdrawn.' });
  let owner = proposal;
  let change = application?.transition;
  while (change) {
    const previous = repository.getMemory(change.memoryId);
    if (!previous) return null;
    if (previous.status !== 'deleted' && !erasing?.has(previous.id)) return repository.restoreReportedStateTransition({
      agentId: proposal.agent_id, proposalId: owner.id, ...change, actor: 'preference-review', reason: 'Restore the surviving preference version.',
    });
    owner = repository.getPreferenceStateProposal(proposal.agent_id, previous.metadata?.preferenceProposalId);
    change = owner?.metadata?.preferenceApplication?.transition;
  }
  return null;
}

export function invalidatePreferenceStateEvidence(repository, { agentId, memoryIds = [], observationIds = [], proposalIds = [] }) {
  if (!memoryIds.length && !observationIds.length && !proposalIds.length) return;
  invalidatePreferenceEvidenceMemories(repository, { agentId, memoryIds, observationIds });
  const affected = repository.database.prepare(`SELECT proposal.id FROM memory_preference_state_proposals proposal
    WHERE proposal.agent_id=? AND proposal.review_state IN ('pending','accepted') AND proposal.result_memory_id IS NOT NULL
      AND (EXISTS (SELECT 1 FROM memory_preference_proposal_evidence evidence WHERE evidence.proposal_id=proposal.id
        AND evidence.memory_id IN (SELECT value FROM json_each(?)))
      OR EXISTS (SELECT 1 FROM json_each(proposal.metadata_json, '$.observationHashes') ref
        WHERE json_extract(ref.value, '$.id') IN (SELECT value FROM json_each(?)))
      OR EXISTS (SELECT 1 FROM json_each(proposal.metadata_json, '$.canonicalReview.observationSnapshots') ref
        WHERE json_extract(ref.value, '$.id') IN (SELECT value FROM json_each(?)))
      OR proposal.id IN (SELECT value FROM json_each(?)))
    ORDER BY proposal.created_at DESC, proposal.id DESC`)
    .all(agentId, JSON.stringify(memoryIds), JSON.stringify(observationIds), JSON.stringify(observationIds), JSON.stringify(proposalIds))
    .map(({ id }) => repository.getPreferenceStateProposal(agentId, id));
  const erasing = new Set(affected.filter(proposal => proposal.metadata?.preferenceApplication?.version
    || repository.getMemory(proposal.resultMemoryId)?.metadata?.preferenceProposalId === proposal.id).map(proposal => proposal.resultMemoryId));
  for (const proposal of affected) {
    const memory = appliedPreferenceStateMemory(repository, proposal);
    repository.database.prepare(`UPDATE memory_preference_state_proposals SET result_memory_id=NULL,
      metadata_json=json_set(metadata_json, '$.preferenceApplication.invalidated', json('true')), updated_at=?
      WHERE agent_id=? AND id=?`).run(new Date().toISOString(), agentId, proposal.id);
    undoPreferenceState(repository, proposal, memory, erasing);
  }
}

export function resolvePreferenceStateProposal(repository, { agentId, proposalId, action, resolvedBy = 'human', note = '' } = {}) {
  if (!repository) throw new Error('Resolving a preference state proposal requires a repository.');
  if (!['accept', 'dismiss'].includes(action)) throw new Error('Unknown preference state proposal action.');
  return repository.transaction(() => {
    let proposal = repository.getPreferenceStateProposal(clean(agentId), proposalId);
    if (!proposal) throw new Error('Preference state proposal does not exist for this Agent.');
    const applied = appliedPreferenceStateMemory(repository, proposal);
    if (proposal.review_state !== 'pending' && !(action === 'dismiss' && proposal.review_state === 'accepted' && applied)) {
      throw new Error('Preference state proposal is already ' + proposal.review_state + '.');
    }
    if (action === 'dismiss') {
      const resolved = repository.resolvePreferenceStateProposal({ agentId, proposalId, resolution: 'dismissed', resolvedBy, note });
      const restored = undoPreferenceState(repository, proposal, applied);
      const preview = repository.getMemory(provisionalPreferenceId(proposal));
      if (preview && preview.id !== applied?.id && preview.status !== 'deleted') repository.setMemoryDeleted({
        agentId, memoryId: preview.id, actor: resolvedBy, reason: 'Preference state withdrawn.',
      });
      return { status: 'dismissed', proposal: resolved, memory: null, restored,
        previous: proposal.previousMemoryId ? repository.getMemory(proposal.previousMemoryId) : null };
    }
    const result = applied ? { memory: applied } : applyPreferenceState(repository, proposal);
    if (!result.memory) throw new Error('Preference state has no valid result to confirm.');
    proposal = repository.resolvePreferenceStateProposal({ agentId, proposalId, resolution: 'accepted',
      resultMemoryId: result.memory.id, resolvedBy, note });
    return { status: proposal.transition === 'challenge' ? 'challenge-accepted'
      : proposal.transition === 'reinforce' ? 'reinforced' : proposal.transition,
      proposal, memory: result.memory, previous: proposal.previousMemoryId ? repository.getMemory(proposal.previousMemoryId) : null };
  });
}

export const PREFERENCE_STATE_LEVELS = LEVELS;
