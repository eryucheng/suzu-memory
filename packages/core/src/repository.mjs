import { createHash, randomUUID } from "node:crypto";
import { DEFAULT_MEMORY_TIME_ZONE, dateKeyInTimeZone } from './calendar-time.mjs';
import { normalizedSearchDocument, removeSearchRows } from './search-index.mjs';
import { cachedEmbeddingRows } from './embedding-cache.mjs';
import { eventContinuityFingerprint, invalidateEventContinuity } from './event-continuity-policy.mjs';
import { guardSourceEpoch, advanceEventSourceEpoch } from './event-source-state.mjs';
import { currentEventSourceExecution, executionEventSourceView } from './event-source-execution.mjs';

import { shiftedPowerLawRetention } from "./access-dynamics.mjs";

import {
  MEMORY_ACTOR_ROLES,
  MEMORY_STATE_FAMILIES,
  MEMORY_STATE_FAMILY_STORAGE_VALUES,
  MEMORY_STATE_PHASES,
  REPRESENTATION_LAYERS,
  REPORTED_STATE_PROPOSAL_ACTIONS,
  RETRIEVAL_FEEDBACK_SIGNALS,
  SOURCE_AUTHORITIES,
  SUBJECT_ROLES,
  TEMPORAL_STATES,
  WORLD_FRAMES,
  memoryWorldsCompatible,
  isMemoryKindAllowedForStateFamily,
  isReportedStateActionAllowedForFamily,
  isStatefulMemoryKind,
} from "./ontology.mjs";
import {
  NON_STATE_SCOPE_KEY,
  ROOT_STATE_SCOPE_KEY,
  isValidStateScopeKey,
  reportedStateScopeKeyFromDraft,
} from "./state-scope.mjs";
import { normalizeStateAnalysisTargetSpec } from "./state-analysis-target.mjs";
import { memoryRetrievalContextSourceHash } from "./retrieval-context.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function json(value, fallback) {
  return JSON.stringify(value ?? fallback);
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

function canonicalJson(value, fallback) {
  return JSON.stringify(canonicalJsonValue(value ?? fallback));
}

function canonicalHash(value) {
  return createHash("sha256").update(canonicalJson(value, {})).digest("hex");
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function bounded(value, fallback, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function unitInterval(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${name} must be between 0 and 1.`);
  }
  return number;
}

function cleanStringList(values) {
  return [...new Set(
    (Array.isArray(values) ? values : []).map(clean).filter(Boolean),
  )];
}

function stableId(prefix, ...parts) {
  const hash = createHash("sha256")
    .update(parts.map((part) => clean(part)).join("\u001f"))
    .digest("hex")
    .slice(0, 24);
  return `${prefix}-${hash}`;
}

function validIsoDate(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(clean(value)));
}

function normalizeTimeWindow(windowStart = "", windowEnd = "") {
  const rawStart = clean(windowStart);
  const rawEnd = clean(windowEnd);
  if (rawStart && !validTimestamp(rawStart)) throw new Error("windowStart is not a valid timestamp.");
  if (rawEnd && !validTimestamp(rawEnd)) throw new Error("windowEnd is not a valid timestamp.");
  const start = rawStart ? new Date(rawStart).toISOString() : "";
  const end = rawEnd ? new Date(rawEnd).toISOString() : "";
  if (start && end && start >= end) throw new Error("windowStart must be before windowEnd.");
  return { start, end };
}

function normalizeNode(row) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence),
    importance: Number(row.importance),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeSource(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeEvidenceSource(row) {
  if (!row) return null;
  return {
    ...normalizeSource(row),
    source_trust: Number(row.source_trust),
    evidence_strength: Number(row.evidence_strength),
    evidenceMetadata: parseJson(row.link_metadata_json, {}),
  };
}

function normalizeMemoryRole(row) {
  if (!row) return null;
  return {
    ...row,
    is_primary: Boolean(row.is_primary),
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeEntity(row) {
  if (!row) return null;
  return {
    ...row,
    aliases: parseJson(row.aliases_json, []),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeInputEvent(row) {
  if (!row) return null;
  return {
    ...row,
    protocol_version: Number(row.protocol_version),
    participants: parseJson(row.participants_json, []),
    content: parseJson(row.content_json, {}),
    source: parseJson(row.source_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeInputEventRevision(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function inputEventFragment(event) {
  const raw = event?.metadata?.suzuMemoryFragment;
  if (raw === undefined || raw === null) return null;
  const descriptor = {
    parentEventId: clean(raw.parentEventId),
    index: Number(raw.index),
    count: Number(raw.count),
    originalCharacters: Number(raw.originalCharacters),
    startCharacter: Number(raw.startCharacter),
    endCharacter: Number(raw.endCharacter),
  };
  const contentCharacters = String(event?.content?.text ?? "").length;
  const valid = descriptor.parentEventId
    && Number.isInteger(descriptor.index)
    && Number.isInteger(descriptor.count)
    && descriptor.index >= 1
    && descriptor.count >= 2
    && descriptor.index <= descriptor.count
    && Number.isInteger(descriptor.originalCharacters)
    && descriptor.originalCharacters > 0
    && Number.isInteger(descriptor.startCharacter)
    && descriptor.startCharacter >= 0
    && Number.isInteger(descriptor.endCharacter)
    && descriptor.endCharacter > descriptor.startCharacter
    && descriptor.endCharacter <= descriptor.originalCharacters
    && descriptor.endCharacter - descriptor.startCharacter === contentCharacters;
  return { ...descriptor, valid: Boolean(valid) };
}

function normalizeActorEntityBinding(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeMemoryActorEntity(row) {
  if (!row) return null;
  return {
    role: row.memory_role,
    actorRole: row.actor_role,
    actorKey: row.actor_key,
    displayName: row.actor_display_name || row.canonical_name,
    isPrimary: Boolean(row.is_primary),
    confidence: Number(row.confidence),
    entity: normalizeEntity({
      id: row.entity_id,
      agent_id: row.entity_agent_id,
      kind: row.entity_kind,
      canonical_name: row.canonical_name,
      aliases_json: row.aliases_json,
      metadata_json: row.entity_metadata_json,
      created_at: row.entity_created_at,
      updated_at: row.entity_updated_at,
    }),
  };
}

function normalizeRelationship(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRelationshipMember(row) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.membership_metadata_json ?? row.metadata_json, {}),
    entity: row.entity_id ? normalizeEntity({
      id: row.entity_id,
      agent_id: row.entity_agent_id ?? row.agent_id,
      kind: row.entity_kind,
      canonical_name: row.canonical_name,
      aliases_json: row.aliases_json,
      metadata_json: row.entity_metadata_json,
      created_at: row.entity_created_at,
      updated_at: row.entity_updated_at,
    }) : null,
  };
}

function normalizeMemoryRelationshipMembership(row) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence),
    metadata: parseJson(row.membership_metadata_json ?? row.metadata_json, {}),
  };
}

function normalizeInputBatch(row) {
  if (!row) return null;
  return {
    ...row,
    event_count: Number(row.event_count),
    input_character_count: Number(row.input_character_count || 0),
    eventIds: parseJson(row.event_ids_json, []),
    output: parseJson(row.output_json, {}),
  };
}

function normalizeMaintenanceTask(row) {
  if (!row) return null;
  return {
    ...row,
    priority: Number(row.priority),
    attempt_count: Number(row.attempt_count),
    max_attempts: Number(row.max_attempts),
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, {}),
    failureHistory: parseJson(row.failure_history_json, []),
  };
}

function normalizeRetrievalContext(row) {
  if (!row) return null;
  return {
    ...row,
    queryTerms: parseJson(row.query_terms_json, []),
    usage: parseJson(row.usage_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizedEntityName(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function entityNameKey(value) {
  return normalizedEntityName(value).toLocaleLowerCase("zh-CN");
}

function normalizeIngestionDecision(row) {
  if (!row) return null;
  return {
    ...row,
    reasonCodes: parseJson(row.reason_codes_json, []),
    candidate: parseJson(row.candidate_json, {}),
    sourceRefs: parseJson(row.source_refs_json, []),
    sourceIds: parseJson(row.source_ids_json, []),
    resolvedCandidate: parseJson(row.resolved_candidate_json, {}),
  };
}

function normalizeSubjectAttributionProposal(row, sourceIds = []) {
  if (!row) return null;
  return {
    ...row,
    confidence: Number(row.confidence),
    actorRoles: parseJson(row.actor_roles_json, []),
    allowedActors: parseJson(row.allowed_actors_json, []),
    sourceIds,
  };
}

function normalizeStateAnalysisRequest(row, memoryIds = [], sourceIds = []) {
  if (!row) return null;
  return {
    ...row,
    metadata: parseJson(row.metadata_json, {}),
    targetSpec: parseJson(row.target_spec_json, {}),
    memoryIds,
    sourceIds,
  };
}

function normalizeRetrievalTrace(row) {
  if (!row) return null;
  return {
    ...row,
    seedIds: parseJson(row.seed_ids_json, []),
    selectedIds: parseJson(row.selected_ids_json, []),
    paths: parseJson(row.paths_json, []),
    matchedEntityIds: parseJson(row.matched_entity_ids_json, []),
    context_chars: Number(row.context_chars),
    candidate_count: Number(row.candidate_count),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRetrievalFeedback(row) {
  if (!row) return null;
  return {
    ...row,
    targetMemoryIds: parseJson(row.target_memory_ids_json, []),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRetrievalUsageRequest(row) {
  if (!row) return null;
  return {
    ...row,
    result: parseJson(row.result_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRetrievalUsageAnalysisRun(row) {
  if (!row) return null;
  return {
    ...row,
    output: parseJson(row.output_json, {}),
    usage: parseJson(row.usage_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRewardObservation(row) {
  if (!row) return null;
  return {
    ...row,
    result: parseJson(row.result_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRewardAnalysisRun(row) {
  if (!row) return null;
  return {
    ...row,
    output: parseJson(row.output_json, {}),
    usage: parseJson(row.usage_json, {}),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRewardCreditProposal(row) {
  if (!row) return null;
  return {
    ...row,
    contribution_share: Number(row.contribution_share),
    reward_value: Number(row.reward_value),
    proposed_consolidation_delta: Number(row.proposed_consolidation_delta),
    proposed_utility_delta: Number(row.proposed_utility_delta),
    evidence: parseJson(row.evidence_json, {}),
  };
}

function normalizeRewardPathCreditProposal(row) {
  if (!row) return null;
  return {
    ...row,
    path_position: Number(row.path_position),
    distance_from_target: Number(row.distance_from_target),
    eligibility_weight: Number(row.eligibility_weight),
    reward_value: Number(row.reward_value),
    proposed_utility_delta: Number(row.proposed_utility_delta),
    evidence: parseJson(row.evidence_json, {}),
  };
}

function normalizeAffectiveActivationDecision(row) {
  if (!row) return null;
  return {
    ...row,
    memoryId: clean(row.memory_id),
    policyVersion: clean(row.policy_version),
    enabled: Boolean(row.enabled),
  };
}

function normalizeStructureProposal(row) {
  if (!row) return null;
  return {
    ...row,
    operation: clean(row.operation) || "create",
    targetMemoryId: clean(row.target_memory_id),
    memberIds: parseJson(row.member_ids_json, []),
    actorRoles: parseJson(row.actor_roles_json, []),
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeRelationProposal(row, evidence = []) {
  if (!row) return null;
  return {
    ...row,
    weight: Number(row.weight),
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
    evidence: evidence.map((item) => ({
      ...normalizeSource(item),
      endpointCoverage: item.endpoint_coverage,
    })),
  };
}

function normalizePreferenceStateProposal(row, evidence = []) {
  if (!row) return null;
  return {
    ...row,
    previousMemoryId: clean(row.previous_memory_id),
    resultMemoryId: clean(row.result_memory_id),
    representationLayer: clean(row.representation_layer) || "inferred",
    stateScopeKey: clean(row.state_scope_key) || ROOT_STATE_SCOPE_KEY,
    scope: parseJson(row.scope_json, {}),
    confidence: Number(row.confidence),
    metrics: parseJson(row.metrics_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    evidence: evidence.map((item) => ({
      memoryId: item.memory_id,
      evidenceGroupId: item.evidence_group_id,
      contextId: item.context_id,
      signal: item.signal,
      direction: item.direction,
      confidence: Number(item.confidence),
      sourceIds: parseJson(item.source_ids_json, []),
      evidenceSnapshotHash: clean(item.evidence_snapshot_hash),
      label: parseJson(item.label_json, {}),
      createdAt: item.created_at,
    })),
  };
}

function normalizeStatePromotionProposal(row) {
  if (!row) return null;
  return {
    ...row,
    sourceMemoryId: clean(row.source_memory_id),
    resultMemoryId: clean(row.result_memory_id),
    stateScopeKey: clean(row.state_scope_key) || ROOT_STATE_SCOPE_KEY,
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeStateAnalysisRun(row, memoryIds = [], sourceIds = []) {
  if (!row) return null;
  return {
    ...row,
    memoryIds,
    sourceIds,
    output: parseJson(row.output_json, {}),
    rejected: parseJson(row.rejected_json, []),
    usage: parseJson(row.usage_json, {}),
    costAmount: Number(row.cost_amount),
    durationMs: Number(row.duration_ms),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function normalizeStateEvidenceObservation(row, sourceIds = [], analysisRunIds = []) {
  if (!row) return null;
  return {
    ...row,
    sourceIds,
    analysisRunIds,
    supersedesObservationId: clean(row.supersedes_observation_id),
    confidence: Number(row.confidence),
    scope: parseJson(row.scope_json, {}),
    payload: parseJson(row.payload_json, {}),
  };
}

function normalizeReportedStateProposal(row, observations = []) {
  if (!row) return null;
  return {
    ...row,
    previousMemoryId: clean(row.previous_memory_id),
    resultMemoryId: clean(row.result_memory_id),
    targetScopeKey: clean(row.target_scope_key) || ROOT_STATE_SCOPE_KEY,
    proposedScopeKey: clean(row.proposed_scope_key) || ROOT_STATE_SCOPE_KEY,
    draft: parseJson(row.draft_json, {}),
    metadata: parseJson(row.metadata_json, {}),
    selectedObservationId: observations.find((item) => item.evidence_role === "selected")
      ?.observation_id || "",
    consideredObservationIds: [...observations]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((item) => item.observation_id),
  };
}

function normalizeConsolidationRun(row) {
  if (!row) return null;
  return {
    ...row,
    triggerIds: parseJson(row.trigger_ids_json, []),
    candidateIds: parseJson(row.candidate_ids_json, []),
    candidateReasons: parseJson(row.candidate_reasons_json, {}),
    graphEdgeIds: parseJson(row.graph_edge_ids_json, []),
    structureProposalIds: parseJson(row.structure_proposal_ids_json, []),
    relationProposalIds: parseJson(row.relation_proposal_ids_json, []),
    failureHistory: parseJson(row.failure_history_json, []),
    metadata: parseJson(row.metadata_json, {}),
    attempt_count: Number(row.attempt_count || 0),
    max_attempts: Number(row.max_attempts || 3),
  };
}

function normalizeAccessibilityState(row) {
  if (!row) return null;
  return {
    ...row,
    value: Number(row.value),
  };
}

function normalizeRecallReactivationState(row) {
  if (!row) return null;
  return {
    ...row,
    value: Number(row.value),
    activation_count: Number(row.activation_count),
  };
}

function normalizeConsolidationState(row) {
  if (!row) return null;
  return {
    ...row,
    value: Number(row.value),
  };
}

function normalizeContextUtilityState(row) {
  if (!row) return null;
  return {
    ...row,
    value: Number(row.value),
  };
}

function normalizeEdgeRelationUtilityState(row) {
  if (!row) return null;
  return {
    ...row,
    value: Number(row.value),
  };
}

function normalizePlasticityShadowChange(row) {
  if (!row) return null;
  return {
    ...row,
    blocked: Boolean(row.blocked),
    currentValue: Number(row.current_value),
    decayedValue: Number(row.decayed_value),
    positiveStep: Number(row.positive_step),
    negativeStep: Number(row.negative_step),
    proposedValue: Number(row.proposed_value),
    targetPolicyVersion: row.target_policy_version || "",
    baseState: {
      exists: Boolean(row.base_state_exists),
      value: row.base_state_value === null ? null : Number(row.base_state_value),
      policyVersion: row.base_state_policy_version || "",
      observationWindowId: row.base_state_observation_window_id || "",
      appliedAt: row.base_state_applied_at || null,
    },
    evidence: parseJson(row.evidence_json, {}),
  };
}

function normalizePlasticityShadowRun(row, changes = []) {
  if (!row) return null;
  return {
    ...row,
    candidateCount: Number(row.candidate_count),
    metadata: parseJson(row.metadata_json, {}),
    changes,
  };
}

function normalizePlasticityApplicationChange(row) {
  if (!row) return null;
  return {
    ...row,
    previousExists: Boolean(row.previous_exists),
    previousValue: row.previous_value === null ? null : Number(row.previous_value),
    appliedValue: Number(row.applied_value),
  };
}

function normalizePlasticityApplication(row, changes = []) {
  if (!row) return null;
  return {
    ...row,
    appliedCount: Number(row.applied_count),
    skippedCount: Number(row.skipped_count),
    changes,
  };
}

function normalizeRewardApplicationChange(row) {
  if (!row) return null;
  return {
    ...row,
    sourceProposalIds: parseJson(row.source_proposal_ids_json, []),
    previousExists: Boolean(row.previous_exists),
    previousValue: row.previous_value === null ? null : Number(row.previous_value),
    appliedValue: Number(row.applied_value),
  };
}

function normalizeRewardApplication(row, changes = []) {
  if (!row) return null;
  return {
    ...row,
    appliedCount: Number(row.applied_count),
    skippedCount: Number(row.skipped_count),
    changes,
  };
}

function sameNumericValue(left, right) {
  return Math.abs(Number(left) - Number(right)) <= 1e-12;
}

function normalizeRewardStatePolicySection(section, label, { allowNegative }) {
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    throw new Error(`Reward application policy requires ${label}.`);
  }
  const floor = unitInterval(section.floor, `${label}.floor`);
  const ceiling = unitInterval(section.ceiling, `${label}.ceiling`);
  const initialValue = unitInterval(section.initialValue, `${label}.initialValue`);
  const maximumPositiveStep = unitInterval(
    section.maximumPositiveStep,
    `${label}.maximumPositiveStep`,
  );
  const maximumNegativeStep = allowNegative
    ? unitInterval(section.maximumNegativeStep, `${label}.maximumNegativeStep`)
    : 0;
  if (floor >= ceiling || initialValue < floor || initialValue > ceiling) {
    throw new Error(`Reward application policy ${label} bounds are invalid.`);
  }
  return {
    floor,
    ceiling,
    initialValue,
    maximumPositiveStep,
    maximumNegativeStep,
  };
}

function normalizeRewardApplicationPolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("Reward application requires an explicit versioned policy.");
  }
  const version = clean(policy.version);
  if (!version) throw new Error("Reward application policy requires version.");
  const allowedCreditPolicyVersions = cleanStringList(policy.allowedCreditPolicyVersions);
  const allowedPathPolicyVersions = cleanStringList(policy.allowedPathPolicyVersions);
  if (!allowedCreditPolicyVersions.length || !allowedPathPolicyVersions.length) {
    throw new Error("Reward application policy must explicitly allow credit and path policy versions.");
  }
  return {
    version,
    allowedCreditPolicyVersions,
    allowedPathPolicyVersions,
    consolidation: normalizeRewardStatePolicySection(
      policy.consolidation,
      "consolidation",
      { allowNegative: false },
    ),
    contextUtility: normalizeRewardStatePolicySection(
      policy.contextUtility,
      "contextUtility",
      { allowNegative: true },
    ),
    relationUtility: normalizeRewardStatePolicySection(
      policy.relationUtility,
      "relationUtility",
      { allowNegative: true },
    ),
  };
}

function boundedRewardStateChange(currentValue, delta, policy) {
  const signed = Number(delta) || 0;
  const boundedDelta = signed >= 0
    ? Math.min(signed, policy.maximumPositiveStep)
    : Math.max(signed, -policy.maximumNegativeStep);
  return Math.min(policy.ceiling, Math.max(policy.floor, currentValue + boundedDelta));
}

function normalizeEdge(row) {
  if (!row) return null;
  return {
    ...row,
    weight: Number(row.weight),
    confidence: Number(row.confidence),
    metadata: parseJson(row.metadata_json, {}),
  };
}

function nodeSnapshot(node) {
  if (!node) return {};
  const {
    metadata_json: _metadataJson,
    ...snapshot
  } = node;
  return snapshot;
}

export class MemoryRepository {
  constructor(database, { timeZone = DEFAULT_MEMORY_TIME_ZONE } = {}) {
    this.timeZone = timeZone;
    this.sourceEpoch = guardSourceEpoch(database, () => currentEventSourceExecution()?.signal?.throwIfAborted());
    this.database = this.sourceEpoch.database;
    this.transactionDepth = 0;
  }

  transaction(callback) {
    const depth = this.transactionDepth;
    const sourceEpoch = this.sourceEpoch.checkpoint();
    const savepoint = `memory_nested_${depth}`;
    this.database.exec(depth === 0 ? "BEGIN IMMEDIATE" : `SAVEPOINT ${savepoint}`);
    this.transactionDepth += 1;
    try {
      const result = callback();
      this.transactionDepth -= 1;
      this.database.exec(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.transactionDepth -= 1;
      if (depth === 0) {
        this.database.exec("ROLLBACK");
      } else {
        this.database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.database.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      this.sourceEpoch.restore(sourceEpoch);
      throw error;
    }
  }

  upsertSource({
    id = "",
    agentId,
    sourceKind,
    sourceLocator = "",
    externalId,
    occurredAt = null,
    knownAt = occurredAt,
    recordedAt = nowIso(),
    speaker = "",
    worldId = "primary",
    worldFrame = "unknown",
    content,
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedKind = clean(sourceKind);
    const normalizedExternalId = clean(externalId);
    const normalizedWorldId = clean(worldId) || "primary";
    const normalizedWorldFrame = clean(worldFrame) || "unknown";
    const normalizedContent = String(content ?? "");
    if (!normalizedAgentId || !normalizedKind || !normalizedExternalId) {
      throw new Error("Source requires agentId, sourceKind, and externalId.");
    }
    if (!normalizedContent.trim()) throw new Error("Source content cannot be empty.");
    if (!WORLD_FRAMES.includes(normalizedWorldFrame)) {
      throw new Error("Source worldFrame is invalid.");
    }

    const sourceId = clean(id) || stableId(
      "src",
      normalizedAgentId,
      normalizedKind,
      normalizedExternalId,
    );
    const createdAt = nowIso();
    const contentHash = createHash("sha256").update(normalizedContent).digest("hex");
    this.database.prepare(`
      INSERT INTO source_records (
        id, agent_id, source_kind, source_locator, external_id,
        occurred_at, known_at, recorded_at, speaker, world_id, world_frame, content, content_hash,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, source_kind, external_id) DO UPDATE SET
        source_locator = excluded.source_locator,
        occurred_at = excluded.occurred_at,
        known_at = excluded.known_at,
        recorded_at = excluded.recorded_at,
        speaker = excluded.speaker,
        world_id = excluded.world_id,
        world_frame = excluded.world_frame,
        content = excluded.content,
        content_hash = excluded.content_hash,
        metadata_json = excluded.metadata_json
    `).run(
      sourceId,
      normalizedAgentId,
      normalizedKind,
      clean(sourceLocator),
      normalizedExternalId,
      occurredAt || null,
      knownAt || occurredAt || recordedAt,
      recordedAt,
      clean(speaker),
      normalizedWorldId,
      normalizedWorldFrame,
      normalizedContent,
      contentHash,
      json(metadata, {}),
      createdAt,
    );
    return this.getSourceByExternalId(
      normalizedAgentId,
      normalizedKind,
      normalizedExternalId,
    );
  }

  getSource(id) {
    return normalizeSource(
      this.database.prepare("SELECT * FROM source_records WHERE id = ?").get(id),
    );
  }

  getSourceByExternalId(agentId, sourceKind, externalId) {
    return normalizeSource(this.database.prepare(`
      SELECT * FROM source_records
      WHERE agent_id = ? AND source_kind = ? AND external_id = ?
    `).get(agentId, sourceKind, externalId));
  }

  appendInputEvent({
    id = "",
    agentId,
    externalId,
    protocolVersion = 1,
    eventType,
    actorRole,
    actorKey,
    participants = [],
    worldId = "relationship",
    worldFrame = "relational",
    occurredAt,
    knownAt = occurredAt,
    recordedAt = nowIso(),
    content,
    source = {},
    metadata = {},
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedExternalId = clean(externalId);
    const normalizedEventType = clean(eventType);
    const normalizedActorRole = clean(actorRole);
    const normalizedActorKey = clean(actorKey);
    const normalizedWorldId = clean(worldId) || "relationship";
    const normalizedWorldFrame = clean(worldFrame) || "relational";
    const normalizedContent = content && typeof content === "object" && !Array.isArray(content)
      ? canonicalJsonValue(content)
      : null;
    const normalizedSource = source && typeof source === "object" && !Array.isArray(source)
      ? canonicalJsonValue(source)
      : {};
    const normalizedMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? canonicalJsonValue(metadata)
      : {};
    const normalizedParticipants = Array.isArray(participants)
      ? participants.map(canonicalJsonValue)
      : null;
    if (!normalizedAgentId || !normalizedExternalId || !normalizedEventType
      || !normalizedActorRole || !normalizedActorKey) {
      throw new Error("Input event requires agentId, externalId, eventType, actorRole, and actorKey.");
    }
    if (![1, 2].includes(Number(protocolVersion))) throw new Error("Input event protocolVersion must be 1 or 2.");
    if (!(Number(protocolVersion) === 2 ? ["user", "companion", "other", "system", "world", "unknown"] : ["user", "companion"]).includes(normalizedActorRole)) {
      throw new Error("Input event actorRole must be user or companion.");
    }
    if (!WORLD_FRAMES.includes(normalizedWorldFrame)) {
      throw new Error("Input event worldFrame is invalid.");
    }
    if (!normalizedParticipants) throw new Error("Input event participants must be an array.");
    if (!normalizedContent || !clean(normalizedContent.text)) {
      throw new Error("Input event content.text is required.");
    }
    const normalizedOccurredAt = new Date(clean(occurredAt));
    const normalizedKnownAt = new Date(clean(knownAt));
    const normalizedRecordedAt = new Date(clean(recordedAt));
    if (![normalizedOccurredAt, normalizedKnownAt, normalizedRecordedAt]
      .every((value) => Number.isFinite(value.getTime()))) {
      throw new Error("Input event timestamps are invalid.");
    }
    const semanticPayload = {
      protocolVersion: Number(protocolVersion),
      eventType: normalizedEventType,
      actor: { role: normalizedActorRole, key: normalizedActorKey },
      participants: normalizedParticipants,
      world: { id: normalizedWorldId, frame: normalizedWorldFrame },
      occurredAt: normalizedOccurredAt.toISOString(),
      knownAt: normalizedKnownAt.toISOString(),
      content: normalizedContent,
      source: normalizedSource,
      metadata: normalizedMetadata,
    };
    const inputHash = canonicalHash(semanticPayload);
    const existing = this.getInputEventByExternalId(normalizedAgentId, normalizedExternalId);
    if (existing) {
      if (existing.input_hash !== inputHash) {
        const error = new Error("Input event id was replayed with different content.");
        error.code = "INPUT_EVENT_CONFLICT";
        throw error;
      }
      return { event: existing, wasInserted: false };
    }
    const eventId = clean(id) || stableId("input", normalizedAgentId, normalizedExternalId);
    const timestamp = nowIso();
    const insertion = this.database.prepare(`
      INSERT INTO memory_input_events (
        id, agent_id, external_id, protocol_version, event_type,
        actor_role, actor_key, participants_json, world_id, world_frame,
        occurred_at, known_at, recorded_at, content_json, source_json,
        metadata_json, input_hash, status, batch_id, last_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', ?, ?)
      ON CONFLICT(agent_id, external_id) DO NOTHING
    `).run(
      eventId,
      normalizedAgentId,
      normalizedExternalId,
      Number(protocolVersion),
      normalizedEventType,
      normalizedActorRole,
      normalizedActorKey,
      canonicalJson(normalizedParticipants, []),
      normalizedWorldId,
      normalizedWorldFrame,
      normalizedOccurredAt.toISOString(),
      normalizedKnownAt.toISOString(),
      normalizedRecordedAt.toISOString(),
      canonicalJson(normalizedContent, {}),
      canonicalJson(normalizedSource, {}),
      canonicalJson(normalizedMetadata, {}),
      inputHash,
      timestamp,
      timestamp,
    );
    const stored = this.getInputEventByExternalId(normalizedAgentId, normalizedExternalId);
    if (!stored) throw new Error("Input event could not be stored.");
    if (stored.input_hash !== inputHash) {
      const error = new Error("Input event id was replayed with different content.");
      error.code = "INPUT_EVENT_CONFLICT";
      throw error;
    }
    return { event: stored, wasInserted: Number(insertion.changes || 0) === 1 };
  }

  getInputEvent(agentId, eventId) {
    return normalizeInputEvent(this.database.prepare(`
      SELECT * FROM memory_input_events WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(eventId)));
  }

  getInputEventByExternalId(agentId, externalId) {
    return normalizeInputEvent(this.database.prepare(`
      SELECT * FROM memory_input_events WHERE agent_id = ? AND external_id = ?
    `).get(clean(agentId), clean(externalId)));
  }

  reviseInputEvent({
    id = "",
    agentId,
    targetExternalId,
    action,
    replacementExternalId = "",
    reason = "",
    metadata = {},
    createdAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedTargetExternalId = clean(targetExternalId);
    const normalizedAction = clean(action).toLowerCase();
    const normalizedReplacementExternalId = clean(replacementExternalId);
    const normalizedMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : null;
    const recordedAt = new Date(clean(createdAt));
    if (!normalizedAgentId || !normalizedTargetExternalId
      || !["amend", "supersede", "retract"].includes(normalizedAction)) {
      throw new Error("Input event revision requires agentId, targetExternalId, and a valid action.");
    }
    if (!Number.isFinite(recordedAt.getTime())) {
      throw new Error("Input event revision createdAt is invalid.");
    }
    if (!normalizedMetadata) {
      throw new Error("Input event revision metadata must be an object.");
    }
    if (normalizedAction === "retract" && normalizedReplacementExternalId) {
      throw new Error("A retraction cannot reference a replacement event.");
    }
    if (normalizedAction !== "retract" && !normalizedReplacementExternalId) {
      throw new Error("An amendment or supersession requires a replacement event.");
    }
    const target = this.getInputEventByExternalId(
      normalizedAgentId,
      normalizedTargetExternalId,
    );
    if (!target) throw new Error("The target input event does not exist for this Agent.");
    const replacement = normalizedReplacementExternalId
      ? this.getInputEventByExternalId(normalizedAgentId, normalizedReplacementExternalId)
      : null;
    if (normalizedReplacementExternalId && !replacement) {
      throw new Error("The replacement input event does not exist for this Agent.");
    }
    if (replacement && replacement.lifecycle !== "active") {
      throw new Error("The replacement input event must still be active.");
    }
    if (replacement?.id === target.id) {
      throw new Error("An input event cannot replace itself.");
    }
    const targetFragment = inputEventFragment(target);
    const logicalTargetId = targetFragment?.parentEventId || target.external_id;
    const revisionId = clean(id) || stableId(
      "input-revision",
      normalizedAgentId,
      logicalTargetId,
      normalizedAction,
      normalizedReplacementExternalId,
      canonicalHash({ reason: clean(reason), metadata: canonicalJsonValue(normalizedMetadata) }),
    );
    const timestamp = recordedAt.toISOString();
    return this.transaction(() => {
      const existing = this.database.prepare(`
        SELECT * FROM memory_input_event_revisions WHERE agent_id = ? AND id = ?
      `).get(normalizedAgentId, revisionId);
      if (existing) {
        return { revision: normalizeInputEventRevision(existing), wasInserted: false };
      }
      const targetEvents = this.database.prepare(`
        SELECT * FROM memory_input_events
        WHERE agent_id = ? AND (
          external_id = ?
          OR json_extract(metadata_json, '$.suzuMemoryFragment.parentEventId') = ?
        )
        ORDER BY external_id ASC
      `).all(normalizedAgentId, logicalTargetId, logicalTargetId).map(normalizeInputEvent);
      if (targetEvents.some((event) => event.status === "processing")) {
        const error = new Error("An input event cannot be revised while its batch is processing.");
        error.code = "INPUT_EVENT_REVISION_RACE";
        throw error;
      }
      if (targetEvents.some((event) => event.lifecycle !== "active")) {
        throw new Error("The target input event is already inactive.");
      }
      const currentReplacement = replacement
        ? this.getInputEvent(normalizedAgentId, replacement.id)
        : null;
      if (replacement && currentReplacement?.lifecycle !== "active") {
        throw new Error("The replacement input event must still be active.");
      }
      if (target.protocol_version === 2) advanceEventSourceEpoch(this);
      this.database.prepare(`
        INSERT INTO memory_input_event_revisions (
          id, agent_id, action, target_event_id, replacement_event_id,
          reason, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        revisionId,
        normalizedAgentId,
        normalizedAction,
        target.id,
        currentReplacement?.id || null,
        clean(reason),
        canonicalJson(normalizedMetadata, {}),
        timestamp,
      );
      const lifecycle = normalizedAction === "retract" ? "retracted" : "superseded";
      const targetIds = targetEvents.map((event) => event.id);
      const placeholders = targetIds.map(() => "?").join(", ");
      this.database.prepare(`
        UPDATE memory_input_events
        SET lifecycle = ?, superseded_by_event_id = ?, revision_id = ?,
            invalidated_at = ?, last_error = '', updated_at = ?
        WHERE agent_id = ? AND id IN (${placeholders}) AND lifecycle = 'active'
      `).run(
        lifecycle,
        currentReplacement?.id || null,
        revisionId,
        timestamp,
        timestamp,
        normalizedAgentId,
        ...targetIds,
      );
      const sourceRows = this.database.prepare(`
        SELECT DISTINCT source.*
        FROM source_records AS source
        JOIN json_each(source.metadata_json, '$.inputEventIds') AS input_event
        WHERE source.agent_id = ?
          AND CAST(input_event.value AS TEXT) IN (${placeholders})
      `).all(normalizedAgentId, ...targetIds).map(normalizeSource);
      for (const source of sourceRows) {
        this.database.prepare(`
          UPDATE source_records
          SET lifecycle = ?, invalidated_at = ?, revision_id = ?
          WHERE agent_id = ? AND id = ? AND lifecycle = 'active'
        `).run(lifecycle, timestamp, revisionId, normalizedAgentId, source.id);
        const memories = this.database.prepare(`
          SELECT DISTINCT memory.*
          FROM memory_nodes AS memory
          JOIN memory_sources AS link ON link.memory_id = memory.id
          WHERE memory.agent_id = ? AND link.source_id = ?
        `).all(normalizedAgentId, source.id).map(normalizeNode);
        for (const memory of memories) {
          const activeSourceCount = Number(this.database.prepare(`
            SELECT COUNT(DISTINCT link.source_id) AS count
            FROM memory_sources AS link
            JOIN source_records AS supporting ON supporting.id = link.source_id
            WHERE link.memory_id = ? AND supporting.agent_id = ?
              AND supporting.lifecycle = 'active'
          `).get(memory.id, normalizedAgentId).count || 0);
          let after = memory;
          if (memory.status === "active" && activeSourceCount === 0) {
            after = this.updateMemoryStatus(memory.id, "deleted");
            this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memory.id);
            this.recordMutation({
              agentId: normalizedAgentId,
              memoryId: memory.id,
              action: "delete",
              actor: "input-event-revision",
              reason: clean(reason) || `Source event was ${lifecycle}.`,
              before: memory,
              after,
            });
          }
          this.database.prepare(`
            INSERT INTO memory_input_event_revision_effects (
              revision_id, agent_id, source_id, memory_id,
              previous_memory_status, resulting_memory_status, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            revisionId,
            normalizedAgentId,
            source.id,
            memory.id,
            memory.status,
            after.status,
            timestamp,
          );
        }
      }
      const revision = normalizeInputEventRevision(this.database.prepare(`
        SELECT * FROM memory_input_event_revisions WHERE agent_id = ? AND id = ?
      `).get(normalizedAgentId, revisionId));
      return {
        revision,
        wasInserted: true,
        targetEvents: targetIds.length,
        invalidatedSources: sourceRows.length,
        affectedMemories: Number(this.database.prepare(`
          SELECT COUNT(*) AS count FROM memory_input_event_revision_effects
          WHERE agent_id = ? AND revision_id = ?
        `).get(normalizedAgentId, revisionId).count || 0),
      };
    });
  }

  listInputEvents(agentId, {
    statuses = ["pending"],
    eventTypes = [],
    lifecycles = ["active"],
    hostId = "",
    sessionId = "",
    limit = 100,
    offset = 0,
    sourceOrder = false,
    descending = false,
    beforeSourceEvent = null,
    eligibleIds = null,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listInputEvents requires agentId.");
    const selectedStatuses = cleanStringList(statuses);
    const selectedTypes = cleanStringList(eventTypes);
    const selectedLifecycles = cleanStringList(lifecycles);
    const normalizedHostId = clean(hostId);
    const normalizedSessionId = clean(sessionId);
    if (selectedLifecycles.some((value) => !["active", "superseded", "retracted"].includes(value))) {
      throw new Error("Unknown input event lifecycle.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const sourceSequence = "COALESCE(json_extract(metadata_json, '$.eventSource.observation.commitSequence'), json_extract(metadata_json, '$.eventSource.commitSequence'), 0)";
    if (eligibleIds !== null) {
      clauses.push('id IN (SELECT value FROM json_each(?))');
      parameters.push(JSON.stringify([...eligibleIds]));
    }
    if (beforeSourceEvent !== null) {
      const source = beforeSourceEvent.metadata?.eventSource || {};
      if (!beforeSourceEvent.metadata?.eventSource) {
        clauses.push('(occurred_at, external_id) < (?, ?)');
        parameters.push(beforeSourceEvent.occurred_at, beforeSourceEvent.external_id);
      } else {
        clauses.push(`(${sourceSequence}, COALESCE(json_extract(metadata_json, '$.eventSource.commitSequence'), 0),
          COALESCE(json_extract(metadata_json, '$.suzuMemoryFragment.index'), 0), external_id) < (?, ?, ?, ?)`);
        parameters.push(source.observation?.commitSequence ?? source.commitSequence ?? 0,
          source.commitSequence ?? 0, beforeSourceEvent.metadata?.suzuMemoryFragment?.index || 0, beforeSourceEvent.external_id);
      }
    }
    if (selectedStatuses.length) {
      clauses.push(`status IN (${selectedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...selectedStatuses);
    }
    if (selectedTypes.length) {
      clauses.push(`event_type IN (${selectedTypes.map(() => "?").join(", ")})`);
      parameters.push(...selectedTypes);
    }
    if (selectedLifecycles.length) {
      clauses.push(`lifecycle IN (${selectedLifecycles.map(() => "?").join(", ")})`);
      parameters.push(...selectedLifecycles);
    }
    if (normalizedHostId) {
      clauses.push("json_extract(metadata_json, '$.host.id') = ?");
      parameters.push(normalizedHostId);
    }
    if (normalizedSessionId) {
      clauses.push("json_extract(metadata_json, '$.host.sessionId') = ?");
      parameters.push(normalizedSessionId);
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    const where = clauses.join(" AND ");
    const direction = descending ? 'DESC' : 'ASC';
    const order = sourceOrder
      ? `${sourceSequence} ${direction}, json_extract(metadata_json, '$.eventSource.commitSequence') ${direction}, COALESCE(json_extract(metadata_json, '$.suzuMemoryFragment.index'), 0) ${direction}, external_id ${direction}`
      : `occurred_at ${direction}, external_id ${direction}`;
    const items = this.database.prepare(`
      SELECT * FROM memory_input_events
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ? OFFSET ?
    `).all(...parameters, maximum, skip).map(normalizeInputEvent);
    const total = Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM memory_input_events WHERE ${where}
    `).get(...parameters).count || 0);
    return { items, total, limit: maximum, offset: skip };
  }

  inspectInputPipeline(agentId, {
    now = nowIso(),
    limit = 50,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const inspectedAt = new Date(clean(now));
    if (!normalizedAgentId || !Number.isFinite(inspectedAt.getTime())) {
      throw new Error("inspectInputPipeline requires agentId and a valid time.");
    }
    const timestamp = inspectedAt.toISOString();
    const maximum = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 50)));
    const eventCounts = Object.fromEntries(this.database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM memory_input_events
      WHERE agent_id = ? AND lifecycle = 'active'
      GROUP BY status
    `).all(normalizedAgentId).map((row) => [row.status, Number(row.count || 0)]));
    const lifecycleCounts = Object.fromEntries(this.database.prepare(`
      SELECT lifecycle, COUNT(*) AS count
      FROM memory_input_events
      WHERE agent_id = ?
      GROUP BY lifecycle
    `).all(normalizedAgentId).map((row) => [row.lifecycle, Number(row.count || 0)]));
    const batchCounts = Object.fromEntries(this.database.prepare(`
      SELECT status, COUNT(*) AS count
      FROM memory_input_batches
      WHERE agent_id = ?
      GROUP BY status
    `).all(normalizedAgentId).map((row) => [row.status, Number(row.count || 0)]));
    const blockedEvents = this.database.prepare(`
      SELECT * FROM memory_input_events
      WHERE agent_id = ? AND lifecycle = 'active'
        AND (
          (status = 'pending' AND last_error <> '')
          OR processing_disposition = 'quarantined'
        )
      ORDER BY updated_at DESC, occurred_at ASC, external_id ASC
      LIMIT ?
    `).all(normalizedAgentId, maximum).map(normalizeInputEvent);
    const blockedTotal = Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM memory_input_events
      WHERE agent_id = ? AND lifecycle = 'active'
        AND (
          (status = 'pending' AND last_error <> '')
          OR processing_disposition = 'quarantined'
        )
    `).get(normalizedAgentId).count || 0);
    const activeBatches = this.database.prepare(`
      SELECT * FROM memory_input_batches
      WHERE agent_id = ? AND status = 'processing'
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(normalizedAgentId, maximum).map(normalizeInputBatch).map((batch) => ({
      ...batch,
      leaseExpired: !batch.lease_expires_at || batch.lease_expires_at <= timestamp,
    }));
    const failedBatches = this.database.prepare(`
      SELECT * FROM memory_input_batches
      WHERE agent_id = ? AND status = 'failed'
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(normalizedAgentId, maximum).map(normalizeInputBatch);
    return {
      inspectedAt: timestamp,
      eventCounts: {
        pending: eventCounts.pending || 0,
        processing: eventCounts.processing || 0,
        archived: eventCounts.archived || 0,
      },
      quarantinedEvents: Number(this.database.prepare(`
        SELECT COUNT(*) AS count FROM memory_input_events
        WHERE agent_id = ? AND lifecycle = 'active'
          AND processing_disposition = 'quarantined'
      `).get(normalizedAgentId).count || 0),
      lifecycleCounts: {
        active: lifecycleCounts.active || 0,
        superseded: lifecycleCounts.superseded || 0,
        retracted: lifecycleCounts.retracted || 0,
      },
      batchCounts: {
        processing: batchCounts.processing || 0,
        completed: batchCounts.completed || 0,
        failed: batchCounts.failed || 0,
      },
      blockedEvents: {
        total: blockedTotal,
        items: blockedEvents,
      },
      activeBatches,
      expiredBatchCount: activeBatches.filter((batch) => batch.leaseExpired).length,
      failedBatches,
    };
  }

  recoverProcessingInputBatches(agentId, {
    batchId = "",
    force = false,
    recoveredAt = nowIso(),
    errorMessage = "Input batch lease expired before completion.",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedBatchId = clean(batchId);
    const timestamp = new Date(clean(recoveredAt));
    if (!normalizedAgentId || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Recovering input batches requires agentId and valid time.");
    }
    const recoveredIso = timestamp.toISOString();
    return this.transaction(() => {
      const clauses = ["agent_id = ?", "status = 'processing'"];
      const parameters = [normalizedAgentId];
      if (normalizedBatchId) {
        clauses.push("id = ?");
        parameters.push(normalizedBatchId);
      }
      if (!force) {
        clauses.push("(lease_expires_at IS NULL OR lease_expires_at <= ?)");
        parameters.push(recoveredIso);
      }
      const batches = this.database.prepare(`
        SELECT id FROM memory_input_batches
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at ASC, id ASC
      `).all(...parameters);
      const recovered = [];
      for (const batch of batches) {
        const message = clean(errorMessage) || "Input batch was recovered before completion.";
        const update = this.database.prepare(`
          UPDATE memory_input_batches
          SET status = 'failed', error_message = ?, lease_owner = '',
              lease_expires_at = NULL, completed_at = ?, updated_at = ?
          WHERE agent_id = ? AND id = ? AND status = 'processing'
        `).run(message, recoveredIso, recoveredIso, normalizedAgentId, batch.id);
        if (Number(update.changes || 0) !== 1) continue;
        this.database.prepare(`
          UPDATE memory_input_events
          SET status = 'pending', batch_id = '', last_error = ?,
              processing_disposition = 'pending', updated_at = ?
          WHERE agent_id = ? AND batch_id = ? AND status = 'processing'
        `).run(message, recoveredIso, normalizedAgentId, batch.id);
        recovered.push(this.getInputBatch(normalizedAgentId, batch.id));
      }
      return { recovered: recovered.length, batches: recovered };
    });
  }

  claimPendingInputEvents(agentId, {
    maximumEvents = 100,
    maximumContentCharacters = 48_000,
    candidateEventIds = [],
    validateLogicalEvent = null,
    workerId = randomUUID(),
    leaseSeconds = 1800,
    createdAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedWorkerId = clean(workerId);
    if (!normalizedAgentId || !normalizedWorkerId) {
      throw new Error("claimPendingInputEvents requires agentId and workerId.");
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(maximumEvents) || 100)));
    const scopedCandidateIds = cleanStringList(candidateEventIds);
    if (scopedCandidateIds.length > 500) {
      throw new Error("claimPendingInputEvents candidateEventIds cannot exceed 500 events.");
    }
    const characterBudget = Math.min(
      10_000_000,
      Math.max(1, Math.trunc(Number(maximumContentCharacters) || 48_000)),
    );
    const leaseDuration = Math.min(86_400, Math.max(60, Math.trunc(Number(leaseSeconds) || 1800)));
    const claimedAt = new Date(clean(createdAt));
    if (!Number.isFinite(claimedAt.getTime())) throw new Error("Input batch createdAt is invalid.");
    return this.transaction(() => {
      const timestamp = claimedAt.toISOString();
      this.recoverProcessingInputBatches(normalizedAgentId, { recoveredAt: timestamp });
      const candidateScope = scopedCandidateIds.length
        ? `AND id IN (${scopedCandidateIds.map(() => "?").join(", ")})`
        : "";
      const sourceView = executionEventSourceView(this, normalizedAgentId);
      const candidates = this.database.prepare(`
        SELECT * FROM memory_input_events
        WHERE agent_id = ? AND status = 'pending' AND lifecycle = 'active'
          ${candidateScope}
          ${sourceView ? 'AND id IN (SELECT value FROM json_each(?))' : ''}
        ORDER BY occurred_at ASC, external_id ASC
        LIMIT ?
      `).all(
        normalizedAgentId,
        ...scopedCandidateIds,
        ...(sourceView ? [JSON.stringify([...sourceView.inputIds])] : []),
        scopedCandidateIds.length ? scopedCandidateIds.length : 500,
      ).map(normalizeInputEvent);
      const events = [];
      const selectedLogicalEvents = new Set();
      const quarantined = [];
      let inputCharacterCount = 0;
      const quarantineGroup = (group, code, message, details = {}) => {
        const ids = [...new Set(group.events.map((event) => clean(event.id)).filter(Boolean))];
        if (!ids.length) return null;
        const placeholders = ids.map(() => "?").join(", ");
        const quarantine = {
          code,
          message,
          details,
          quarantinedAt: timestamp,
        };
        for (const event of group.events) {
          const metadata = event.metadata && typeof event.metadata === "object"
            && !Array.isArray(event.metadata)
            ? event.metadata
            : {};
          const processing = metadata.suzuMemoryProcessing
            && typeof metadata.suzuMemoryProcessing === "object"
            && !Array.isArray(metadata.suzuMemoryProcessing)
            ? metadata.suzuMemoryProcessing
            : {};
          this.database.prepare(`
            UPDATE memory_input_events
            SET status = 'archived', batch_id = '', last_error = ?,
                processing_disposition = 'quarantined', metadata_json = ?, updated_at = ?
            WHERE agent_id = ? AND id = ? AND status = 'pending'
          `).run(
            message,
            canonicalJson({
              ...metadata,
              suzuMemoryProcessing: { ...processing, quarantine },
            }, {}),
            timestamp,
            normalizedAgentId,
            event.id,
          );
        }
        const task = this.recordExhaustedMaintenanceFailure({
          agentId: normalizedAgentId,
          lane: "semantic",
          taskType: "input-event-quarantine",
          payload: {
            inputEventIds: ids,
            externalId: group.logicalEventId,
            code,
            details,
            stage: "input-validation",
          },
          result: {
            status: "manual-review-required",
            failures: [{
              stage: "input-validation",
              inputEventIds: ids,
              externalId: group.logicalEventId,
              code,
              error: message,
              details,
            }],
          },
          errorMessage: message,
          errorDetails: { code, stage: "input-validation", ...details },
          attempts: 1,
          failedAt: timestamp,
        });
        const record = {
          code,
          eventIds: ids,
          externalId: group.logicalEventId,
          message,
          details,
          reviewTaskId: clean(task?.id),
        };
        quarantined.push(record);
        return record;
      };
      const fragmentGroup = (event) => {
        const descriptor = inputEventFragment(event);
        if (!descriptor) {
          return {
            logicalEventId: event.external_id,
            events: [event],
            descriptor: null,
          };
        }
        if (!descriptor.valid) {
          return {
            logicalEventId: descriptor.parentEventId || event.external_id,
            events: [event],
            descriptor,
            invalid: true,
          };
        }
        const prefix = `${descriptor.parentEventId}#suzu-memory-fragment=`;
        const matching = this.database.prepare(`
          SELECT * FROM memory_input_events
          WHERE agent_id = ? AND status = 'pending' AND lifecycle = 'active'
            AND (external_id = ? OR substr(external_id, 1, ?) = ?)
          ORDER BY external_id ASC
        `).all(
          normalizedAgentId,
          descriptor.parentEventId,
          prefix.length,
          prefix,
        ).map(normalizeInputEvent).map((item) => ({
          event: item,
          fragment: inputEventFragment(item),
        })).filter(({ fragment }) => (
          fragment?.parentEventId === descriptor.parentEventId
        ));
        matching.sort((left, right) => left.fragment.index - right.fragment.index);
        const complete = matching.length === descriptor.count
          && matching.every(({ fragment }, index) => (
            fragment.valid
            && fragment.count === descriptor.count
            && fragment.originalCharacters === descriptor.originalCharacters
            && fragment.index === index + 1
            && (index === 0
              ? fragment.startCharacter === 0
              : fragment.startCharacter === matching[index - 1].fragment.endCharacter)
          ))
          && matching.at(-1)?.fragment.endCharacter === descriptor.originalCharacters;
        return {
          logicalEventId: descriptor.parentEventId,
          events: matching.map(({ event: item }) => item),
          descriptor,
          invalid: !complete,
        };
      };
      for (const event of candidates) {
        const group = fragmentGroup(event);
        if (selectedLogicalEvents.has(group.logicalEventId)) continue;
        selectedLogicalEvents.add(group.logicalEventId);
        if (group.invalid) {
          const message = `Input event fragment group ${group.logicalEventId} is incomplete or inconsistent and cannot be sent to the extraction model.`;
          quarantineGroup(group, "INPUT_EVENT_FRAGMENT_GROUP_INCOMPLETE", message, {
            expectedFragments: group.descriptor?.count || 0,
            availableFragments: group.events.length,
          });
          continue;
        }
        const validation = validateLogicalEvent?.(group.events);
        if (validation) {
          quarantineGroup(group, validation.code, validation.message, validation.details || {});
          continue;
        }
        const characterCount = group.events.reduce(
          (total, item) => total + String(item.content?.text ?? "").length,
          0,
        );
        if (group.events.length > maximum) {
          const message = `Logical input event ${group.logicalEventId} contains ${group.events.length} fragments, exceeding the ${maximum}-event batch limit.`;
          quarantineGroup(group, "INPUT_EVENT_FRAGMENT_GROUP_TOO_LARGE", message, {
            fragmentCount: group.events.length,
            maximumEvents: maximum,
            characterCount,
            maximumContentCharacters: characterBudget,
          });
          continue;
        }
        if (characterCount > characterBudget) {
          const fragmented = Boolean(group.descriptor);
          const message = fragmented
            ? `Logical input event ${group.logicalEventId} contains ${characterCount} characters across ${group.events.length} fragments, exceeding the ${characterBudget}-character batch budget.`
            : `Input event ${event.external_id} contains ${characterCount} characters, exceeding the ${characterBudget}-character batch budget. Re-ingest it with event fragmentation enabled.`;
          quarantineGroup(
            group,
            fragmented ? "INPUT_EVENT_FRAGMENT_GROUP_TOO_LARGE" : "INPUT_EVENT_TOO_LARGE",
            message,
            {
              characterCount,
              maximumContentCharacters: characterBudget,
              ...(fragmented ? { fragmentCount: group.events.length } : {}),
            },
          );
          continue;
        }
        if (events.length && (
          events.length + group.events.length > maximum
          || inputCharacterCount + characterCount > characterBudget
        )) break;
        events.push(...group.events);
        inputCharacterCount += characterCount;
      }
      if (!events.length) return { batch: null, events: [], quarantined };
      const batchId = `input-batch-${randomUUID()}`;
      const eventIds = events.map((event) => event.id);
      const inputHash = canonicalHash(events.map((event) => ({
        id: event.id,
        inputHash: event.input_hash,
      })));
      const leaseExpiresAt = new Date(claimedAt.getTime() + leaseDuration * 1000).toISOString();
      this.database.prepare(`
        INSERT INTO memory_input_batches (
          id, agent_id, status, input_hash, event_count, event_ids_json,
          output_json, error_message, created_at, completed_at,
          lease_owner, lease_expires_at, updated_at, input_character_count
        ) VALUES (?, ?, 'processing', ?, ?, ?, '{}', '', ?, NULL, ?, ?, ?, ?)
      `).run(
        batchId,
        normalizedAgentId,
        inputHash,
        eventIds.length,
        canonicalJson(eventIds, []),
        timestamp,
        normalizedWorkerId,
        leaseExpiresAt,
        timestamp,
        inputCharacterCount,
      );
      const placeholders = eventIds.map(() => "?").join(", ");
      const changed = this.database.prepare(`
        UPDATE memory_input_events
        SET status = 'processing', batch_id = ?, last_error = '', updated_at = ?
        WHERE agent_id = ? AND status = 'pending' AND lifecycle = 'active'
          AND id IN (${placeholders})
      `).run(batchId, timestamp, normalizedAgentId, ...eventIds);
      if (Number(changed.changes) !== eventIds.length) {
        throw new Error("Input events changed while claiming the batch.");
      }
      return {
        batch: this.getInputBatch(normalizedAgentId, batchId),
        events: eventIds.map((eventId) => this.getInputEvent(normalizedAgentId, eventId)),
        quarantined,
      };
    });
  }

  getInputBatch(agentId, batchId) {
    return normalizeInputBatch(this.database.prepare(`
      SELECT * FROM memory_input_batches WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(batchId)));
  }

  assertInputBatchLease(agentId, batchId, leaseOwner) {
    const batch = this.getInputBatch(agentId, batchId);
    if (!batch || batch.status !== "processing" || batch.lease_owner !== clean(leaseOwner)) {
      const error = new Error("Input batch changed or its lease is owned by another worker.");
      error.code = "INPUT_BATCH_LEASE_LOST";
      throw error;
    }
    return batch;
  }

  recordInputBatchProcessingFailure(agentId, batchId, {
    leaseOwner,
    failure = {},
    maximumAttempts = 3,
    attemptIncrement = 1,
    failedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedBatchId = clean(batchId);
    const normalizedLeaseOwner = clean(leaseOwner);
    const timestamp = new Date(clean(failedAt));
    if (!normalizedAgentId || !normalizedBatchId || !normalizedLeaseOwner
      || !Number.isFinite(timestamp.getTime())) {
      throw new Error("recordInputBatchProcessingFailure requires agentId, batchId, leaseOwner, and valid failedAt.");
    }
    const maximum = Math.min(20, Math.max(1, Math.trunc(Number(maximumAttempts) || 3)));
    const increment = Math.min(maximum, Math.max(1, Math.trunc(Number(attemptIncrement) || 1)));
    const diagnostic = {
      stage: clean(failure?.stage) || "processing",
      errorCode: clean(failure?.errorCode || failure?.code),
      errorName: clean(failure?.errorName || failure?.name) || "Error",
      errorMessage: clean(failure?.errorMessage || failure?.message) || "Unknown input processing failure.",
      failedAt: timestamp.toISOString(),
    };
    return this.transaction(() => {
      this.assertInputBatchLease(normalizedAgentId, normalizedBatchId, normalizedLeaseOwner);
      const events = this.database.prepare(`
        SELECT * FROM memory_input_events
        WHERE agent_id = ? AND batch_id = ? AND status = 'processing'
        ORDER BY occurred_at ASC, external_id ASC
      `).all(normalizedAgentId, normalizedBatchId).map(normalizeInputEvent);
      const updated = [];
      for (const event of events) {
        const metadata = event.metadata && typeof event.metadata === "object"
          && !Array.isArray(event.metadata)
          ? event.metadata
          : {};
        const prior = metadata.suzuMemoryProcessing
          && typeof metadata.suzuMemoryProcessing === "object"
          && !Array.isArray(metadata.suzuMemoryProcessing)
          ? metadata.suzuMemoryProcessing
          : {};
        const priorAttempts = Math.max(0, Math.trunc(Number(prior.attemptCount) || 0));
        const attemptCount = Math.min(maximum, priorAttempts + increment);
        const failureHistory = Array.isArray(prior.failureHistory)
          ? prior.failureHistory.slice(-4)
          : [];
        failureHistory.push({ ...diagnostic, attempt: attemptCount });
        const nextMetadata = {
          ...metadata,
          suzuMemoryProcessing: {
            ...prior,
            attemptCount,
            maximumAttempts: maximum,
            lastFailure: { ...diagnostic, attempt: attemptCount },
            failureHistory,
          },
        };
        this.database.prepare(`
          UPDATE memory_input_events
          SET metadata_json = ?, last_error = ?, updated_at = ?
          WHERE agent_id = ? AND id = ? AND batch_id = ? AND status = 'processing'
        `).run(
          canonicalJson(nextMetadata, {}),
          diagnostic.errorMessage,
          timestamp.toISOString(),
          normalizedAgentId,
          event.id,
          normalizedBatchId,
        );
        updated.push(this.getInputEvent(normalizedAgentId, event.id));
      }
      const attempts = updated.length
        ? Math.max(...updated.map((event) => (
          Math.max(0, Math.trunc(Number(event.metadata?.suzuMemoryProcessing?.attemptCount) || 0))
        )))
        : 0;
      return {
        batch: this.getInputBatch(normalizedAgentId, normalizedBatchId),
        events: updated,
        attempts,
        maximumAttempts: maximum,
        exhausted: Boolean(updated.length) && updated.every((event) => (
          Number(event.metadata?.suzuMemoryProcessing?.attemptCount || 0) >= maximum
        )),
        diagnostic,
      };
    });
  }

  releaseInputBatchForSplit(agentId, batchId, { leaseOwner, maximumCoreMessages, recordLimit = true,
    errorMessage = "Extraction requires a smaller batch after reaching its output limit.", completedAt = nowIso() } = {}) {
    if (!Number.isSafeInteger(maximumCoreMessages) || maximumCoreMessages < 1 || maximumCoreMessages > 500) {
      throw new Error("Splitting an input batch requires a positive bounded message limit.");
    }
    agentId = clean(agentId);
    batchId = clean(batchId);
    leaseOwner = clean(leaseOwner);
    return this.transaction(() => {
      this.assertInputBatchLease(agentId, batchId, leaseOwner);
      const events = recordLimit ? this.database.prepare(`SELECT id, metadata_json FROM memory_input_events
        WHERE agent_id = ? AND batch_id = ? AND status = 'processing'`).all(agentId, batchId) : [];
      for (const event of events) {
        const metadata = parseJson(event.metadata_json, {});
        const prior = metadata.suzuMemoryProcessing;
        const processing = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {};
        const priorLimit = processing.extractionMaximumMessages;
        this.database.prepare(`UPDATE memory_input_events SET metadata_json = ?
          WHERE agent_id = ? AND id = ? AND batch_id = ? AND status = 'processing'`).run(
          canonicalJson({ ...metadata, suzuMemoryProcessing: { ...processing,
            extractionMaximumMessages: Math.min(maximumCoreMessages,
              Number.isSafeInteger(priorLimit) && priorLimit > 0 ? priorLimit : maximumCoreMessages) } }, {}),
          agentId, event.id, batchId,
        );
      }
      return this.completeInputBatch(agentId, batchId, { success: false, leaseOwner,
        output: { status: 'split', maximumCoreMessages }, errorMessage, completedAt });
    });
  }

  completeInputBatch(agentId, batchId, {
    success,
    leaseOwner,
    output = {},
    errorMessage = "",
    completedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedBatchId = clean(batchId);
    const normalizedLeaseOwner = clean(leaseOwner);
    const timestamp = new Date(clean(completedAt));
    if (!normalizedAgentId || !normalizedBatchId || !normalizedLeaseOwner
      || typeof success !== "boolean") {
      throw new Error("completeInputBatch requires agentId, batchId, leaseOwner, and success.");
    }
    if (!Number.isFinite(timestamp.getTime())) throw new Error("Input batch completedAt is invalid.");
    return this.transaction(() => {
      const batch = this.getInputBatch(normalizedAgentId, normalizedBatchId);
      if (!batch) throw new Error("Input batch was not found.");
      if (batch.status !== "processing") {
        if (success && batch.status === "completed") return batch;
        const error = new Error("Input batch is not processing.");
        error.code = "INPUT_BATCH_LEASE_LOST";
        throw error;
      }
      this.assertInputBatchLease(normalizedAgentId, normalizedBatchId, normalizedLeaseOwner);
      const finishedAt = timestamp.toISOString();
      const status = success ? "completed" : "failed";
      const batchUpdate = this.database.prepare(`
        UPDATE memory_input_batches
        SET status = ?, output_json = ?, error_message = ?, completed_at = ?,
            lease_owner = '', lease_expires_at = NULL, updated_at = ?
        WHERE agent_id = ? AND id = ? AND status = 'processing' AND lease_owner = ?
      `).run(
        status,
        canonicalJson(output, {}),
        success ? "" : clean(errorMessage),
        finishedAt,
        finishedAt,
        normalizedAgentId,
        normalizedBatchId,
        normalizedLeaseOwner,
      );
      if (Number(batchUpdate.changes || 0) !== 1) {
        const error = new Error("Input batch changed or its lease is owned by another worker.");
        error.code = "INPUT_BATCH_LEASE_LOST";
        throw error;
      }
      if (success) {
        this.database.prepare(`
          UPDATE memory_input_events
          SET status = 'archived', last_error = '', processing_disposition = 'processed',
              updated_at = ?
          WHERE agent_id = ? AND batch_id = ? AND status = 'processing'
        `).run(finishedAt, normalizedAgentId, normalizedBatchId);
      } else {
        this.database.prepare(`
          UPDATE memory_input_events
          SET status = 'pending', batch_id = '', last_error = ?,
              processing_disposition = 'pending', updated_at = ?
          WHERE agent_id = ? AND batch_id = ? AND status = 'processing'
        `).run(clean(errorMessage), finishedAt, normalizedAgentId, normalizedBatchId);
      }
      return this.getInputBatch(normalizedAgentId, normalizedBatchId);
    });
  }

  requeueArchivedInputEventsForHumanRetry({
    agentId,
    eventIds = [],
    retryTaskId = "",
    reason = "",
    retriedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedEventIds = cleanStringList(eventIds);
    const normalizedTaskId = clean(retryTaskId);
    const timestamp = new Date(clean(retriedAt));
    if (!normalizedAgentId || !normalizedEventIds.length || !normalizedTaskId
      || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Requeueing archived input events requires Agent, event ids, review task, and valid time.");
    }
    return this.transaction(() => {
      const placeholders = normalizedEventIds.map(() => "?").join(", ");
      const events = this.database.prepare(`
        SELECT * FROM memory_input_events
        WHERE agent_id = ? AND id IN (${placeholders})
        ORDER BY occurred_at ASC, external_id ASC
      `).all(normalizedAgentId, ...normalizedEventIds).map(normalizeInputEvent);
      if (events.length !== normalizedEventIds.length) {
        throw new Error("Every retry input event must exist for this Agent.");
      }
      if (events.some((event) => event.lifecycle !== "active" || event.status !== "archived")) {
        throw new Error("Only active archived input events can be retried from human review.");
      }
      const retriedIso = timestamp.toISOString();
      for (const event of events) {
        const metadata = event.metadata && typeof event.metadata === "object" && !Array.isArray(event.metadata)
          ? event.metadata
          : {};
        const processing = metadata.suzuMemoryProcessing
          && typeof metadata.suzuMemoryProcessing === "object"
          && !Array.isArray(metadata.suzuMemoryProcessing)
          ? metadata.suzuMemoryProcessing
          : {};
        const {
          attemptCount: _attemptCount,
          maximumAttempts: _maximumAttempts,
          lastFailure: _lastFailure,
          failureHistory: _failureHistory,
          ...retryableProcessing
        } = processing;
        const humanRetries = Array.isArray(processing.humanRetries)
          ? processing.humanRetries.slice(-9)
          : [];
        humanRetries.push({
          taskId: normalizedTaskId,
          retriedAt: retriedIso,
          reason: clean(reason),
        });
        this.database.prepare(`
          UPDATE memory_input_events
          SET status = 'pending', batch_id = '', last_error = '',
              processing_disposition = 'pending', metadata_json = ?, updated_at = ?
          WHERE agent_id = ? AND id = ? AND status = 'archived' AND lifecycle = 'active'
        `).run(
          canonicalJson({
            ...metadata,
            suzuMemoryProcessing: {
              ...retryableProcessing,
              attemptCount: 0,
              humanRetries,
              retryRequestedBy: normalizedTaskId,
            },
          }, {}),
          retriedIso,
          normalizedAgentId,
          event.id,
        );
      }
      return normalizedEventIds.map((id) => this.getInputEvent(normalizedAgentId, id));
    });
  }

  listInputBatches(agentId, { limit = 100, offset = 0 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listInputBatches requires agentId.");
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.database.prepare(`
      SELECT * FROM memory_input_batches
      WHERE agent_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(normalizedAgentId, maximum, skip).map(normalizeInputBatch);
  }

  enqueueMaintenanceTask({
    agentId,
    lane,
    taskType,
    payload = {},
    priority = 0,
    maxAttempts = 3,
    availableAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedLane = clean(lane);
    const normalizedTaskType = clean(taskType);
    const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : null;
    const timestamp = new Date(clean(availableAt));
    const normalizedPriority = Math.trunc(Number(priority) || 0);
    const normalizedMaxAttempts = Math.trunc(Number(maxAttempts) || 0);
    if (!normalizedAgentId || !["embedding", "semantic"].includes(normalizedLane)
      || !normalizedTaskType || !normalizedPayload) {
      throw new Error("Enqueuing a maintenance task requires agentId, lane, taskType, and payload.");
    }
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error("Maintenance task availableAt is invalid.");
    }
    if (normalizedMaxAttempts < 1 || normalizedMaxAttempts > 20) {
      throw new Error("Maintenance task maxAttempts must be between 1 and 20.");
    }
    const inputHash = canonicalHash({
      lane: normalizedLane,
      taskType: normalizedTaskType,
      payload: normalizedPayload,
    });
    const id = stableId(
      "maintenance-task",
      normalizedAgentId,
      normalizedLane,
      normalizedTaskType,
      inputHash,
    );
    const createdAt = nowIso();
    const insertion = this.database.prepare(`
      INSERT OR IGNORE INTO memory_maintenance_tasks (
        id, agent_id, lane, task_type, status, priority, input_hash,
        payload_json, result_json, attempt_count, max_attempts, available_at,
        lease_owner, lease_expires_at, error_message, created_at, updated_at,
        completed_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, '{}', 0, ?, ?, '', NULL, '', ?, ?, NULL)
    `).run(
      id,
      normalizedAgentId,
      normalizedLane,
      normalizedTaskType,
      normalizedPriority,
      inputHash,
      canonicalJson(normalizedPayload, {}),
      normalizedMaxAttempts,
      timestamp.toISOString(),
      createdAt,
      createdAt,
    );
    return {
      ...this.getMaintenanceTask(normalizedAgentId, id),
      wasInserted: Number(insertion.changes || 0) === 1,
    };
  }

  recordExhaustedMaintenanceFailure({
    agentId,
    lane,
    taskType,
    payload = {},
    result = {},
    errorMessage,
    errorDetails = {},
    attempts = 3,
    failedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedLane = clean(lane);
    const normalizedTaskType = clean(taskType);
    const normalizedPayload = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : null;
    const normalizedResult = result && typeof result === "object" && !Array.isArray(result)
      ? result
      : {};
    const normalizedDetails = errorDetails && typeof errorDetails === "object"
      && !Array.isArray(errorDetails)
      ? errorDetails
      : {};
    const normalizedAttempts = Math.trunc(Number(attempts) || 0);
    const timestamp = new Date(clean(failedAt));
    if (!normalizedAgentId || !["embedding", "semantic"].includes(normalizedLane)
      || !normalizedTaskType || !normalizedPayload || !clean(errorMessage)) {
      throw new Error("Recording an exhausted maintenance failure requires Agent, lane, task type, payload, and error.");
    }
    if (normalizedAttempts < 1 || normalizedAttempts > 20) {
      throw new Error("Exhausted maintenance failure attempts must be between 1 and 20.");
    }
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error("Exhausted maintenance failure time is invalid.");
    }
    const failedIso = timestamp.toISOString();
    const inputHash = canonicalHash({
      lane: normalizedLane,
      taskType: normalizedTaskType,
      payload: normalizedPayload,
    });
    const id = stableId(
      "maintenance-task",
      normalizedAgentId,
      normalizedLane,
      normalizedTaskType,
      inputHash,
    );
    const failureHistory = [{
      attempt: normalizedAttempts,
      failedAt: failedIso,
      error: clean(errorMessage),
      details: normalizedDetails,
    }];
    const insertion = this.database.prepare(`
      INSERT OR IGNORE INTO memory_maintenance_tasks (
        id, agent_id, lane, task_type, status, priority, input_hash,
        payload_json, result_json, attempt_count, max_attempts, available_at,
        lease_owner, lease_expires_at, error_message, created_at, updated_at,
        completed_at, review_state, failure_history_json, reviewed_by,
        review_note, reviewed_at
      ) VALUES (
        ?, ?, ?, ?, 'failed', 0, ?, ?, ?, ?, ?, ?, '', NULL, ?, ?, ?, ?,
        'pending', ?, '', '', NULL
      )
    `).run(
      id,
      normalizedAgentId,
      normalizedLane,
      normalizedTaskType,
      inputHash,
      canonicalJson(normalizedPayload, {}),
      canonicalJson(normalizedResult, {}),
      normalizedAttempts,
      normalizedAttempts,
      failedIso,
      clean(errorMessage),
      failedIso,
      failedIso,
      failedIso,
      canonicalJson(failureHistory, []),
    );
    return {
      ...this.getMaintenanceTask(normalizedAgentId, id),
      wasInserted: Number(insertion.changes || 0) === 1,
    };
  }

  getMaintenanceTask(agentId, taskId) {
    return normalizeMaintenanceTask(this.database.prepare(`
      SELECT * FROM memory_maintenance_tasks WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(taskId)));
  }

  listMaintenanceTasks(agentId, {
    lanes = [],
    taskTypes = [],
    statuses = [],
    reviewStates = [],
    limit = 100,
    offset = 0,
    order = "asc",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listMaintenanceTasks requires agentId.");
    const normalizedLanes = cleanStringList(Array.isArray(lanes) ? lanes : [lanes]);
    const normalizedTaskTypes = cleanStringList(Array.isArray(taskTypes) ? taskTypes : [taskTypes]);
    const normalizedStatuses = cleanStringList(Array.isArray(statuses) ? statuses : [statuses]);
    const normalizedReviewStates = cleanStringList(
      Array.isArray(reviewStates) ? reviewStates : [reviewStates],
    );
    const normalizedOrder = clean(order).toLowerCase();
    if (normalizedLanes.some((item) => !["embedding", "semantic"].includes(item))) {
      throw new Error("Unknown maintenance task lane.");
    }
    if (normalizedStatuses.some((item) => (
      !["pending", "running", "completed", "failed", "cancelled"].includes(item)
    ))) throw new Error("Unknown maintenance task status.");
    if (normalizedReviewStates.some((item) => (
      !["not-required", "pending", "accepted", "dismissed"].includes(item)
    ))) throw new Error("Unknown maintenance task review state.");
    if (!["asc", "desc"].includes(normalizedOrder)) {
      throw new Error("Maintenance task order must be asc or desc.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    for (const [column, values] of [
      ["lane", normalizedLanes],
      ["task_type", normalizedTaskTypes],
      ["status", normalizedStatuses],
      ["review_state", normalizedReviewStates],
    ]) {
      if (!values.length) continue;
      clauses.push(`${column} IN (${values.map(() => "?").join(", ")})`);
      parameters.push(...values);
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.database.prepare(`
      SELECT * FROM memory_maintenance_tasks
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ${normalizedOrder.toUpperCase()}, id ${normalizedOrder.toUpperCase()}
      LIMIT ? OFFSET ?
    `).all(...parameters, maximum, skip).map(normalizeMaintenanceTask);
  }

  claimMaintenanceTasks({
    agentId,
    lane,
    taskTypes = [],
    taskIds = null,
    maximumTasks = 10,
    workerId = randomUUID(),
    leaseSeconds = 300,
    claimedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedLane = clean(lane);
    const normalizedTaskTypes = cleanStringList(
      Array.isArray(taskTypes) ? taskTypes : [taskTypes],
    );
    const normalizedWorkerId = clean(workerId);
    const maximum = Math.min(100, Math.max(1, Math.trunc(Number(maximumTasks) || 10)));
    const leaseDuration = Math.min(3600, Math.max(30, Math.trunc(Number(leaseSeconds) || 300)));
    const timestamp = new Date(clean(claimedAt));
    if (!normalizedAgentId || !["embedding", "semantic"].includes(normalizedLane)
      || !normalizedWorkerId || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Claiming maintenance tasks requires agentId, lane, workerId, and valid time.");
    }
    const claimedIso = timestamp.toISOString();
    const leaseExpiresAt = new Date(timestamp.getTime() + leaseDuration * 1000).toISOString();
    return this.transaction(() => {
      const clauses = [
        "agent_id = ?",
        "lane = ?",
        "attempt_count < max_attempts",
        "available_at <= ?",
        "(status = 'pending' OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))",
      ];
      const parameters = [normalizedAgentId, normalizedLane, claimedIso, claimedIso];
      if (normalizedTaskTypes.length) {
        clauses.push(`task_type IN (${normalizedTaskTypes.map(() => "?").join(", ")})`);
        parameters.push(...normalizedTaskTypes);
      }
      if (Array.isArray(taskIds)) {
        clauses.push("id IN (SELECT value FROM json_each(?))");
        parameters.push(JSON.stringify(cleanStringList(taskIds)));
      }
      const sourceView = executionEventSourceView(this, normalizedAgentId);
      if (sourceView) {
        clauses.push(`json_array_length(payload_json, '$.memoryIds') > 0 AND NOT EXISTS (
          SELECT 1 FROM json_each(payload_json, '$.memoryIds') AS member
          WHERE member.value NOT IN (SELECT value FROM json_each(?)))`);
        parameters.push(JSON.stringify([...sourceView.memoryIds]));
      }
      const candidates = this.database.prepare(`
        SELECT id FROM memory_maintenance_tasks
        WHERE ${clauses.join(" AND ")}
        ORDER BY priority DESC, available_at ASC, created_at ASC, id ASC
        LIMIT ?
      `).all(...parameters, maximum);
      const claimed = [];
      for (const candidate of candidates) {
        const update = this.database.prepare(`
          UPDATE memory_maintenance_tasks
          SET status = 'running', attempt_count = attempt_count + 1,
              lease_owner = ?, lease_expires_at = ?, error_message = '', updated_at = ?
          WHERE agent_id = ? AND id = ? AND attempt_count < max_attempts
            AND available_at <= ?
            AND (status = 'pending'
              OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
        `).run(
          normalizedWorkerId,
          leaseExpiresAt,
          claimedIso,
          normalizedAgentId,
          candidate.id,
          claimedIso,
          claimedIso,
        );
        if (Number(update.changes || 0) === 1) {
          claimed.push(this.getMaintenanceTask(normalizedAgentId, candidate.id));
        }
      }
      return { workerId: normalizedWorkerId, leaseExpiresAt, tasks: claimed };
    });
  }

  recoverRunningMaintenanceTasks(agentId, {
    force = false,
    recoveredAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const timestamp = new Date(clean(recoveredAt));
    if (!normalizedAgentId || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Recovering maintenance tasks requires Agent and valid time.");
    }
    const recoveredIso = timestamp.toISOString();
    return this.transaction(() => {
      const candidates = this.database.prepare(`
        SELECT *
        FROM memory_maintenance_tasks
        WHERE agent_id = ? AND status = 'running'
          AND (? = 1 OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY created_at ASC, id ASC
      `).all(normalizedAgentId, force ? 1 : 0, recoveredIso).map(normalizeMaintenanceTask);
      const requeued = [];
      const failed = [];
      for (const task of candidates) {
        const requiresHumanReview = task.task_type !== "memory-embedding";
        const history = [
          ...(Array.isArray(task.failureHistory) ? task.failureHistory : []),
          {
            attempt: task.attempt_count,
            failedAt: recoveredIso,
            error: force
              ? "Maintenance task was interrupted by a local application restart."
              : "Maintenance task lease expired before completion.",
            details: {
              stage: "maintenance-recovery",
              reason: force ? "desktop-restart" : "lease-expired",
              leaseOwner: clean(task.lease_owner),
              leaseExpiredAt: clean(task.lease_expires_at),
            },
          },
        ];
        if (task.attempt_count < task.max_attempts) {
          const update = this.database.prepare(`
            UPDATE memory_maintenance_tasks
            SET status = 'pending', available_at = ?, lease_owner = '', lease_expires_at = NULL,
                error_message = '', failure_history_json = ?, review_state = 'not-required',
                reviewed_by = '', review_note = '', reviewed_at = NULL,
                completed_at = NULL, updated_at = ?
            WHERE agent_id = ? AND id = ? AND status = 'running'
          `).run(
            recoveredIso,
            canonicalJson(history, []),
            recoveredIso,
            normalizedAgentId,
            task.id,
          );
          if (Number(update.changes || 0) === 1) {
            requeued.push(this.getMaintenanceTask(normalizedAgentId, task.id));
          }
          continue;
        }
        const update = this.database.prepare(`
          UPDATE memory_maintenance_tasks
          SET status = 'failed', lease_owner = '', lease_expires_at = NULL,
              error_message = ?, failure_history_json = ?, review_state = ?,
              reviewed_by = '', review_note = '', reviewed_at = NULL,
              completed_at = ?, updated_at = ?
          WHERE agent_id = ? AND id = ? AND status = 'running'
        `).run(
          force
            ? "Maintenance task was interrupted by a local application restart after its final attempt."
            : "Maintenance task lease expired after maximum attempts.",
          canonicalJson(history, []),
          requiresHumanReview ? "pending" : "not-required",
          recoveredIso,
          recoveredIso,
          normalizedAgentId,
          task.id,
        );
        if (Number(update.changes || 0) === 1) {
          failed.push(this.getMaintenanceTask(normalizedAgentId, task.id));
        }
      }
      return { requeued: requeued.length, failed: failed.length, tasks: [...requeued, ...failed] };
    });
  }

  checkpointMaintenanceTask({ agentId, taskId, workerId, result }) {
    const update = this.database.prepare(`
      UPDATE memory_maintenance_tasks SET result_json = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'running' AND lease_owner = ?
        AND lease_expires_at > ?
    `).run(canonicalJson(result, {}), nowIso(), clean(agentId), clean(taskId), clean(workerId), nowIso());
    if (Number(update.changes || 0) !== 1) throw new Error("Maintenance checkpoint requires the current lease owner.");
    return this.getMaintenanceTask(agentId, taskId);
  }

  finishMaintenanceTask({
    agentId,
    taskId,
    workerId,
    result = {},
    completedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedTaskId = clean(taskId);
    const normalizedWorkerId = clean(workerId);
    const timestamp = new Date(clean(completedAt));
    if (!normalizedAgentId || !normalizedTaskId || !normalizedWorkerId
      || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Finishing a maintenance task requires task, worker, Agent, and valid time.");
    }
    const completedIso = timestamp.toISOString();
    const update = this.database.prepare(`
      UPDATE memory_maintenance_tasks
      SET status = 'completed', result_json = ?, lease_owner = '', lease_expires_at = NULL,
          error_message = '', completed_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'running' AND lease_owner = ?
    `).run(
      canonicalJson(result && typeof result === "object" && !Array.isArray(result) ? result : {}, {}),
      completedIso,
      completedIso,
      normalizedAgentId,
      normalizedTaskId,
      normalizedWorkerId,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("Maintenance task changed or its lease is owned by another worker.");
    }
    return this.getMaintenanceTask(normalizedAgentId, normalizedTaskId);
  }

  failMaintenanceTask({
    agentId,
    taskId,
    workerId,
    errorMessage,
    errorDetails = {},
    result = null,
    retry = true,
    retryDelaySeconds = 0,
    failedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedTaskId = clean(taskId);
    const normalizedWorkerId = clean(workerId);
    const timestamp = new Date(clean(failedAt));
    if (!normalizedAgentId || !normalizedTaskId || !normalizedWorkerId
      || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Failing a maintenance task requires task, worker, Agent, and valid time.");
    }
    const current = this.getMaintenanceTask(normalizedAgentId, normalizedTaskId);
    if (!current || current.status !== "running" || current.lease_owner !== normalizedWorkerId) {
      throw new Error("Maintenance task changed or its lease is owned by another worker.");
    }
    const shouldRetry = Boolean(retry) && current.attempt_count < current.max_attempts;
    const requiresHumanReview = !shouldRetry && current.task_type !== "memory-embedding";
    const failedIso = timestamp.toISOString();
    const availableAt = new Date(
      timestamp.getTime() + Math.max(0, Math.trunc(Number(retryDelaySeconds) || 0)) * 1000,
    ).toISOString();
    const normalizedDetails = errorDetails && typeof errorDetails === "object"
      && !Array.isArray(errorDetails)
      ? errorDetails
      : {};
    const history = [
      ...(Array.isArray(current.failureHistory) ? current.failureHistory : []),
      {
        attempt: current.attempt_count,
        failedAt: failedIso,
        error: clean(errorMessage),
        details: normalizedDetails,
      },
    ];
    const partialResult = result && typeof result === "object" && !Array.isArray(result)
      ? result
      : current.result;
    this.database.prepare(`
      UPDATE memory_maintenance_tasks
      SET status = ?, available_at = ?, lease_owner = '', lease_expires_at = NULL,
          error_message = ?, result_json = ?, failure_history_json = ?,
          review_state = CASE WHEN ? = 1 THEN 'pending' ELSE 'not-required' END,
          reviewed_by = '', review_note = '', reviewed_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'running' AND lease_owner = ?
    `).run(
      shouldRetry ? "pending" : "failed",
      shouldRetry ? availableAt : current.available_at,
      clean(errorMessage),
      canonicalJson(partialResult, {}),
      canonicalJson(history, []),
      requiresHumanReview ? 1 : 0,
      shouldRetry ? null : failedIso,
      failedIso,
      normalizedAgentId,
      normalizedTaskId,
      normalizedWorkerId,
    );
    return this.getMaintenanceTask(normalizedAgentId, normalizedTaskId);
  }

  reviewMaintenanceTaskFailure({
    agentId,
    taskId,
    action,
    reviewedBy = "human",
    note = "",
    reviewedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedTaskId = clean(taskId);
    const normalizedAction = clean(action).toLowerCase();
    const timestamp = new Date(clean(reviewedAt));
    if (!normalizedAgentId || !normalizedTaskId || !["accept", "dismiss"].includes(normalizedAction)
      || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Reviewing a maintenance failure requires Agent, task, action, and valid time.");
    }
    const current = this.getMaintenanceTask(normalizedAgentId, normalizedTaskId);
    if (!current || current.status !== "failed" || current.review_state !== "pending") {
      throw new Error("Maintenance failure is not awaiting human review.");
    }
    const reviewedIso = timestamp.toISOString();
    const accepted = normalizedAction === "accept";
    const update = this.database.prepare(`
      UPDATE memory_maintenance_tasks
      SET status = ?, available_at = ?,
          lease_owner = '', lease_expires_at = NULL,
          review_state = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?,
          completed_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'failed' AND review_state = 'pending'
    `).run(
      accepted ? "completed" : "cancelled",
      current.available_at,
      accepted ? "accepted" : "dismissed",
      clean(reviewedBy) || "human",
      clean(note),
      reviewedIso,
      reviewedIso,
      reviewedIso,
      normalizedAgentId,
      normalizedTaskId,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("Maintenance failure changed before the review decision was stored.");
    }
    return this.getMaintenanceTask(normalizedAgentId, normalizedTaskId);
  }

  upsertMemory({
    id = "",
    agentId,
    kind,
    layer,
    title = "",
    content,
    subjectRole = "unknown",
    subjectKey = "",
    canonicalKey = "",
    reality = "real",
    worldId = "primary",
    worldFrame = "unknown",
    evidenceMode = "imported",
    representationLayer = "unspecified",
    stateFamily = "",
    statePhase = "",
    stateScopeKey = "",
    temporalState = "historical",
    revisionAction = "add",
    eventDate = null,
    eventStart = null,
    eventEnd = null,
    knownAt = null,
    validFrom = null,
    validTo = null,
    recordedAt = nowIso(),
    status = "active",
    confidence = 1,
    importance = 0.5,
    perspective = "",
    actorRoles = [],
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedKind = clean(kind);
    const normalizedLayer = clean(layer);
    const normalizedContent = String(content ?? "");
    const normalizedRepresentationLayer = clean(representationLayer) || "unspecified";
    const normalizedWorldId = clean(worldId) || "primary";
    const normalizedWorldFrame = clean(worldFrame) || "unknown";
    const stateful = isStatefulMemoryKind(normalizedKind);
    const normalizedStateFamily = clean(stateFamily)
      || (stateful ? "unspecified" : "not_applicable");
    const normalizedStatePhase = clean(statePhase)
      || (stateful ? "unspecified" : "not_applicable");
    const normalizedStateScopeKey = clean(stateScopeKey)
      || (stateful ? ROOT_STATE_SCOPE_KEY : NON_STATE_SCOPE_KEY);
    if (!normalizedAgentId || !normalizedKind || !normalizedLayer) {
      throw new Error("Memory requires agentId, kind, and layer.");
    }
    if (!normalizedContent.trim()) throw new Error("Memory content cannot be empty.");
    if (!WORLD_FRAMES.includes(normalizedWorldFrame)) {
      throw new Error("Memory worldFrame is invalid.");
    }
    if (!REPRESENTATION_LAYERS.includes(normalizedRepresentationLayer)) {
      throw new Error("Memory representationLayer is invalid.");
    }
    if (!MEMORY_STATE_FAMILY_STORAGE_VALUES.includes(normalizedStateFamily)) {
      throw new Error("Memory stateFamily is invalid.");
    }
    if (!MEMORY_STATE_PHASES.includes(normalizedStatePhase)) {
      throw new Error("Memory statePhase is invalid.");
    }
    if (!isValidStateScopeKey(normalizedStateScopeKey)) {
      throw new Error("Memory stateScopeKey is invalid.");
    }
    if (!stateful && (normalizedStateFamily !== "not_applicable"
      || normalizedStatePhase !== "not_applicable"
      || normalizedStateScopeKey !== NON_STATE_SCOPE_KEY)) {
      throw new Error("Non-state memory cannot carry stateFamily or statePhase or stateScopeKey.");
    }
    if (stateful && normalizedStateFamily === "not_applicable") {
      throw new Error("Stateful memory cannot use a not_applicable stateFamily.");
    }
    if (stateful && normalizedStatePhase === "not_applicable") {
      throw new Error("Stateful memory cannot use a not_applicable statePhase.");
    }
    if (stateful && normalizedStateScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Stateful memory cannot use a not_applicable stateScopeKey.");
    }
    if (stateful && normalizedStateFamily !== "unspecified"
      && !isMemoryKindAllowedForStateFamily(normalizedKind, normalizedStateFamily)) {
      throw new Error(`Memory kind ${normalizedKind} is not allowed for stateFamily ${normalizedStateFamily}.`);
    }

    const memoryId = clean(id) || `mem-${randomUUID()}`;
    const existingMemory = this.getMemory(memoryId);
    if (existingMemory && existingMemory.agent_id !== normalizedAgentId) {
      throw new Error("Memory id already belongs to another Agent.");
    }
    if (existingMemory && existingMemory.state_scope_key !== normalizedStateScopeKey) {
      throw new Error("A memory node cannot change its state scope identity.");
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_nodes (
        id, agent_id, kind, layer, title, content, event_date, event_start, event_end,
        known_at, recorded_at, status, confidence, importance, perspective,
        metadata_json, created_at, updated_at, subject_role, subject_key,
        canonical_key, reality, world_id, world_frame, evidence_mode, representation_layer, state_family, state_phase,
        state_scope_key,
        temporal_state, revision_action,
        valid_from, valid_to
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        layer = excluded.layer,
        title = excluded.title,
        content = excluded.content,
        event_date = excluded.event_date,
        event_start = excluded.event_start,
        event_end = excluded.event_end,
        known_at = excluded.known_at,
        recorded_at = excluded.recorded_at,
        status = excluded.status,
        confidence = excluded.confidence,
        importance = excluded.importance,
        perspective = excluded.perspective,
        metadata_json = excluded.metadata_json,
        subject_role = excluded.subject_role,
        subject_key = excluded.subject_key,
        canonical_key = excluded.canonical_key,
        reality = excluded.reality,
        world_id = excluded.world_id,
        world_frame = excluded.world_frame,
        evidence_mode = excluded.evidence_mode,
        representation_layer = excluded.representation_layer,
        state_family = excluded.state_family,
        state_phase = excluded.state_phase,
        state_scope_key = excluded.state_scope_key,
        temporal_state = excluded.temporal_state,
        revision_action = excluded.revision_action,
        valid_from = excluded.valid_from,
        valid_to = excluded.valid_to,
        updated_at = excluded.updated_at
    `).run(
      memoryId,
      normalizedAgentId,
      normalizedKind,
      normalizedLayer,
      clean(title),
      normalizedContent,
      eventDate || null,
      eventStart || null,
      eventEnd || null,
      knownAt || recordedAt,
      recordedAt,
      status,
      bounded(confidence, 1),
      bounded(importance, 0.5),
      clean(perspective),
      json(metadata, {}),
      timestamp,
      timestamp,
      clean(subjectRole) || "unknown",
      clean(subjectKey),
      clean(canonicalKey),
      clean(reality) || "real",
      normalizedWorldId,
      normalizedWorldFrame,
      clean(evidenceMode) || "imported",
      normalizedRepresentationLayer,
      normalizedStateFamily,
      normalizedStatePhase,
      normalizedStateScopeKey,
      clean(temporalState) || "historical",
      clean(revisionAction) || "add",
      validFrom || null,
      validTo || null,
    );
    this.syncPrimarySubjectRole({
      memoryId,
      agentId: normalizedAgentId,
      actorRole: clean(subjectRole) || "unknown",
      actorKey: clean(subjectKey),
    });
    for (const role of Array.isArray(actorRoles) ? actorRoles : []) {
      this.upsertMemoryRole({
        memoryId,
        agentId: normalizedAgentId,
        ...role,
      });
    }
    this.syncSearch(memoryId);
    return this.getMemory(memoryId);
  }

  getMemory(id) {
    return normalizeNode(
      this.database.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id),
    );
  }

  upsertEpisode({
    agentId,
    eventDate = null,
    eventStart = null,
    eventEnd = null,
    evidenceMode = "manual",
    temporalState = eventEnd ? "completed" : "historical",
    ...memory
  }) {
    const normalizedDate = clean(eventDate);
    const normalizedStart = clean(eventStart);
    const normalizedEnd = clean(eventEnd);
    if (!normalizedDate && !normalizedStart) {
      throw new Error("Episode requires eventDate or eventStart.");
    }
    if (normalizedDate && !validIsoDate(normalizedDate)) {
      throw new Error("Episode eventDate must be a valid YYYY-MM-DD date.");
    }
    if (normalizedStart && !validTimestamp(normalizedStart)) {
      throw new Error("Episode eventStart must be a valid timestamp.");
    }
    if (normalizedEnd && !validTimestamp(normalizedEnd)) {
      throw new Error("Episode eventEnd must be a valid timestamp.");
    }
    if (normalizedEnd && !normalizedStart) {
      throw new Error("Episode eventEnd requires eventStart.");
    }
    if (normalizedStart && normalizedEnd && Date.parse(normalizedEnd) < Date.parse(normalizedStart)) {
      throw new Error("Episode eventEnd cannot be before eventStart.");
    }
    return this.upsertMemory({
      ...memory,
      agentId,
      kind: "episode",
      layer: "episodic",
      eventDate: normalizedDate || null,
      eventStart: normalizedStart || null,
      eventEnd: normalizedEnd || null,
      evidenceMode: clean(evidenceMode) || "manual",
      temporalState: clean(temporalState) || "historical",
    });
  }

  upsertTopic({
    agentId,
    eventDate = null,
    eventStart = null,
    eventEnd = null,
    evidenceMode = "manual",
    temporalState = "timeless",
    ...memory
  }) {
    if (clean(eventDate) || clean(eventStart) || clean(eventEnd)) {
      throw new Error("Topic cannot carry event time; link time-bearing memories instead.");
    }
    return this.upsertMemory({
      ...memory,
      agentId,
      kind: "topic",
      layer: "semantic",
      eventDate: null,
      eventStart: null,
      eventEnd: null,
      evidenceMode: clean(evidenceMode) || "manual",
      temporalState: clean(temporalState) || "timeless",
    });
  }

  linkMemoryToEpisode({
    agentId,
    memoryId,
    episodeId,
    weight = 0.95,
    confidence = 1,
    provenance = "manual-structure",
    metadata = {},
  }) {
    return this.linkMemoryContainer({
      agentId,
      memoryId,
      containerId: episodeId,
      containerKind: "episode",
      relation: "part_of_episode",
      weight,
      confidence,
      provenance,
      metadata,
    });
  }

  linkMemoryToTopic({
    agentId,
    memoryId,
    topicId,
    weight = 0.9,
    confidence = 1,
    provenance = "manual-structure",
    metadata = {},
  }) {
    return this.linkMemoryContainer({
      agentId,
      memoryId,
      containerId: topicId,
      containerKind: "topic",
      relation: "supports_topic",
      weight,
      confidence,
      provenance,
      metadata,
    });
  }

  linkMemoryContainer({
    agentId,
    memoryId,
    containerId,
    containerKind,
    relation,
    weight,
    confidence,
    provenance,
    metadata,
  }) {
    const normalizedAgentId = clean(agentId);
    const source = this.getMemory(clean(memoryId));
    const container = this.getMemory(clean(containerId));
    if (!normalizedAgentId || !source || source.agent_id !== normalizedAgentId) {
      throw new Error("Membership source must exist for this Agent.");
    }
    if (!container || container.agent_id !== normalizedAgentId) {
      throw new Error("Membership target must exist for this Agent.");
    }
    if (source.status === "deleted" || container.status === "deleted") {
      throw new Error("Deleted memories cannot participate in active membership.");
    }
    if (container.kind !== containerKind) {
      throw new Error(`Membership target must be a ${containerKind} node.`);
    }
    if (containerKind === "episode" && ["episode", "topic", "topic_or_episode"].includes(source.kind)) {
      throw new Error("Only concrete memories can be members of an episode.");
    }
    if (containerKind === "topic" && ["topic", "topic_or_episode"].includes(source.kind)) {
      throw new Error("A topic cannot support another topic in the current model.");
    }
    return this.upsertEdge({
      agentId: normalizedAgentId,
      fromMemoryId: source.id,
      toMemoryId: container.id,
      relation,
      direction: "directed",
      weight,
      confidence,
      provenance,
      metadata,
    });
  }

  listEpisodeMembers({ agentId, episodeId, statuses = ["active"] }) {
    return this.listContainerMembers({
      agentId,
      containerId: episodeId,
      containerKind: "episode",
      relation: "part_of_episode",
      statuses,
    });
  }

  listTopicMembers({ agentId, topicId, statuses = ["active"] }) {
    return this.listContainerMembers({
      agentId,
      containerId: topicId,
      containerKind: "topic",
      relation: "supports_topic",
      statuses,
    });
  }

  expandEpisodeToMemories({ agentId, episodeId, memoryIds = [] }) {
    const normalizedAgentId = clean(agentId);
    const episode = this.getMemory(clean(episodeId));
    if (!normalizedAgentId || !episode || episode.agent_id !== normalizedAgentId) {
      throw new Error("Episode expansion target must exist for this Agent.");
    }
    if (episode.kind !== "episode" || episode.status === "deleted") {
      throw new Error("Episode expansion target must be a non-deleted episode.");
    }
    const members = cleanStringList(memoryIds).map((id) => this.getMemory(id));
    if (members.some((memory) => !memory || memory.agent_id !== normalizedAgentId)) {
      throw new Error("Episode expansion members must exist for the same Agent.");
    }
    if (members.some((memory) => (
      memory.status === "deleted"
      || ["episode", "topic", "topic_or_episode"].includes(memory.kind)
    ))) {
      throw new Error("Episode expansion accepts only non-deleted concrete memories.");
    }

    const memories = [episode, ...members];
    const exactStarts = memories.map((memory) => clean(memory.event_start)).filter(validTimestamp);
    const exactEnds = memories.flatMap((memory) => [memory.event_end, memory.event_start])
      .map(clean)
      .filter(validTimestamp);
    const calendarDates = memories.flatMap((memory) => [
      clean(memory.event_date),
      dateKeyInTimeZone(memory.event_start, this.timeZone),
      dateKeyInTimeZone(memory.event_end, this.timeZone),
    ]).filter(validIsoDate);
    const eventDate = calendarDates.sort()[0] || null;
    const eventStart = exactStarts.sort()[0] || null;
    const latestExact = exactEnds.sort().at(-1) || null;
    const eventEnd = eventStart && latestExact && Date.parse(latestExact) > Date.parse(eventStart)
      ? latestExact
      : clean(episode.event_end) || null;
    if (eventStart && eventEnd && Date.parse(eventEnd) < Date.parse(eventStart)) {
      throw new Error("Expanded episode boundary is invalid.");
    }

    this.database.prepare(`
      UPDATE memory_nodes
      SET event_date = ?, event_start = ?, event_end = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND kind = 'episode' AND status <> 'deleted'
    `).run(
      eventDate,
      eventStart,
      eventEnd,
      nowIso(),
      normalizedAgentId,
      episode.id,
    );
    return this.getMemory(episode.id);
  }

  listContainerMembers({
    agentId,
    containerId,
    containerKind,
    relation,
    statuses = ["active"],
  }) {
    const normalizedAgentId = clean(agentId);
    const container = this.getMemory(clean(containerId));
    if (!normalizedAgentId || !container || container.agent_id !== normalizedAgentId) {
      throw new Error("Membership target must exist for this Agent.");
    }
    if (container.kind !== containerKind) {
      throw new Error(`Membership target must be a ${containerKind} node.`);
    }
    const normalizedStatuses = [...new Set(
      (Array.isArray(statuses) ? statuses : [statuses]).map(clean).filter(Boolean),
    )];
    if (!normalizedStatuses.length) return [];
    const edges = this.database.prepare(`
      SELECT edge.*
      FROM memory_edges AS edge
      JOIN memory_nodes AS member ON member.id = edge.from_memory_id
      WHERE edge.agent_id = ? AND edge.to_memory_id = ? AND edge.relation = ?
        AND member.agent_id = ?
        AND member.status IN (${normalizedStatuses.map(() => "?").join(", ")})
      ORDER BY COALESCE(member.event_start, member.event_date, member.recorded_at) ASC,
        member.id ASC
    `).all(
      normalizedAgentId,
      container.id,
      relation,
      normalizedAgentId,
      ...normalizedStatuses,
    ).map(normalizeEdge);
    return edges.map((edge) => ({
      ...this.getMemory(edge.from_memory_id),
      membership: edge,
    }));
  }

  unlinkMemoryFromEpisode({ agentId, memoryId, episodeId }) {
    return this.unlinkMemoryContainer({
      agentId,
      memoryId,
      containerId: episodeId,
      relation: "part_of_episode",
    });
  }

  unlinkMemoryFromTopic({ agentId, memoryId, topicId }) {
    return this.unlinkMemoryContainer({
      agentId,
      memoryId,
      containerId: topicId,
      relation: "supports_topic",
    });
  }

  unlinkMemoryContainer({ agentId, memoryId, containerId, relation }) {
    return Number(this.database.prepare(`
      DELETE FROM memory_edges
      WHERE agent_id = ? AND from_memory_id = ? AND to_memory_id = ? AND relation = ?
    `).run(
      clean(agentId),
      clean(memoryId),
      clean(containerId),
      clean(relation),
    ).changes || 0);
  }

  recordStructureProposal({
    id,
    agentId,
    batchId = "",
    operation = "create",
    targetMemoryId = null,
    kind,
    title = "",
    content,
    subjectRole = "unknown",
    subjectKey = "",
    eventDate = null,
    eventStart = null,
    eventEnd = null,
    memberIds = [],
    actorRoles = [],
    confidence = 0.5,
    rationale = "",
    provenance = "",
    proposalHash,
    metadata = {},
    createdAt = nowIso(),
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedOperation = clean(operation) || "create";
    const normalizedTargetMemoryId = clean(targetMemoryId) || null;
    const normalizedKind = clean(kind);
    const normalizedContent = clean(content);
    const normalizedProposalHash = clean(proposalHash);
    const proposalId = clean(id);
    if (
      !proposalId
      || !normalizedAgentId
      || !["create", "attach"].includes(normalizedOperation)
      || !["episode", "topic"].includes(normalizedKind)
      || !normalizedContent
      || !normalizedProposalHash
    ) {
      throw new Error("Structure proposal record is incomplete.");
    }
    const idOwner = this.database.prepare(`
      SELECT agent_id FROM memory_structure_proposals WHERE id = ?
    `).get(proposalId);
    if (idOwner && idOwner.agent_id !== normalizedAgentId) {
      throw new Error("Structure proposal id already belongs to another Agent.");
    }
    const timestamp = clean(createdAt) || nowIso();
    const insertion = this.database.prepare(`
      INSERT INTO memory_structure_proposals (
        id, agent_id, batch_id, operation, target_memory_id, kind, title, content,
        subject_role, subject_key, event_date, event_start, event_end,
        member_ids_json, actor_roles_json, confidence, rationale, provenance,
        proposal_hash, review_state, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      ON CONFLICT(agent_id, proposal_hash) DO NOTHING
    `).run(
      proposalId,
      normalizedAgentId,
      clean(batchId),
      normalizedOperation,
      normalizedTargetMemoryId,
      normalizedKind,
      clean(title),
      normalizedContent,
      clean(subjectRole) || "unknown",
      clean(subjectKey),
      clean(eventDate) || null,
      clean(eventStart) || null,
      clean(eventEnd) || null,
      json(memberIds, []),
      json(actorRoles, []),
      bounded(confidence, 0.5),
      clean(rationale),
      clean(provenance),
      normalizedProposalHash,
      json(metadata, {}),
      timestamp,
      timestamp,
    );
    const proposal = normalizeStructureProposal(this.database.prepare(`
      SELECT * FROM memory_structure_proposals
      WHERE agent_id = ? AND proposal_hash = ?
    `).get(normalizedAgentId, normalizedProposalHash));
    return {
      ...proposal,
      wasInserted: Number(insertion.changes || 0) === 1,
    };
  }

  getStructureProposal(agentId, proposalId) {
    return normalizeStructureProposal(this.database.prepare(`
      SELECT * FROM memory_structure_proposals WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(proposalId)));
  }

  listStructureProposals(agentId, {
    reviewStates = [],
    batchId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStructureProposals requires agentId.");
    const states = [...new Set(
      (Array.isArray(reviewStates) ? reviewStates : [reviewStates]).map(clean).filter(Boolean),
    )];
    if (states.some((state) => !["pending", "accepted", "dismissed"].includes(state))) {
      throw new Error("Unknown structure proposal review state.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (clean(batchId)) {
      clauses.push("batch_id = ?");
      parameters.push(clean(batchId));
    }
    return this.database.prepare(`
      SELECT * FROM memory_structure_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      ...parameters,
      Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))),
    ).map(normalizeStructureProposal);
  }

  resolveStructureProposal({
    agentId,
    proposalId,
    resolution,
    resultMemoryId = null,
    resolvedBy = "human",
    note = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedResolution = clean(resolution);
    const proposal = this.getStructureProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Structure proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`Structure proposal is already ${proposal.review_state}.`);
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown structure proposal resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const normalizedMemoryId = clean(resultMemoryId) || null;
    if (normalizedResolution === "accepted") {
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.kind !== proposal.kind) {
        throw new Error("Accepted structure proposal requires a matching result memory.");
      }
    } else if (normalizedMemoryId) {
      throw new Error("Dismissed structure proposal cannot reference a result memory.");
    }
    const resolvedAt = nowIso();
    const resolutionResult = this.database.prepare(`
      UPDATE memory_structure_proposals
      SET review_state = ?, result_memory_id = ?, resolution_note = ?, resolved_by = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedMemoryId,
      clean(note),
      clean(resolvedBy) || "human",
      resolvedAt,
      resolvedAt,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(resolutionResult.changes || 0) !== 1) {
      throw new Error("Structure proposal changed while it was being resolved.");
    }
    return this.getStructureProposal(normalizedAgentId, proposal.id);
  }

  setPendingStructureProposalResult({
    agentId,
    proposalId,
    resultMemoryId,
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedProposalId = clean(proposalId);
    const normalizedMemoryId = clean(resultMemoryId);
    const proposal = this.getStructureProposal(normalizedAgentId, normalizedProposalId);
    if (!proposal) throw new Error("Structure proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`Only a pending structure proposal can receive a provisional result; it is ${proposal.review_state}.`);
    }
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId || memory.kind !== proposal.kind) {
      throw new Error("Provisional structure proposal result requires a matching memory.");
    }
    if (proposal.result_memory_id) {
      if (proposal.result_memory_id !== memory.id) {
        throw new Error("Structure proposal already points to another result memory.");
      }
      return proposal;
    }
    const timestamp = nowIso();
    const updated = this.database.prepare(`
      UPDATE memory_structure_proposals
      SET result_memory_id = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending' AND result_memory_id IS NULL
    `).run(memory.id, timestamp, normalizedAgentId, proposal.id);
    if (Number(updated.changes || 0) !== 1) {
      throw new Error("Structure proposal changed while its provisional result was being recorded.");
    }
    return this.getStructureProposal(normalizedAgentId, proposal.id);
  }

  removeStructureProposalMemberships({ agentId, proposalId }) {
    const normalizedAgentId = clean(agentId);
    const normalizedProposalId = clean(proposalId);
    if (!normalizedAgentId || !normalizedProposalId) {
      throw new Error("Removing proposal memberships requires Agent and proposal id.");
    }
    return Number(this.database.prepare(`
      DELETE FROM memory_edges
      WHERE agent_id = ?
        AND relation IN ('part_of_episode', 'supports_topic')
        AND json_extract(metadata_json, '$.structureProposalId') = ?
    `).run(normalizedAgentId, normalizedProposalId).changes || 0);
  }

  updateStructureProposalMembershipReviewState({
    agentId,
    proposalId,
    reviewState,
    reviewedBy = "",
    reviewedAt = nowIso(),
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedProposalId = clean(proposalId);
    const normalizedReviewState = clean(reviewState);
    const timestamp = new Date(clean(reviewedAt));
    if (!normalizedAgentId || !normalizedProposalId || !["pending", "accepted"].includes(normalizedReviewState)
      || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Updating structure proposal memberships requires Agent, proposal, review state, and valid time.");
    }
    const edges = this.database.prepare(`
      SELECT id, metadata_json
      FROM memory_edges
      WHERE agent_id = ?
        AND relation IN ('part_of_episode', 'supports_topic')
        AND json_extract(metadata_json, '$.structureProposalId') = ?
    `).all(normalizedAgentId, normalizedProposalId);
    const update = this.database.prepare(`
      UPDATE memory_edges
      SET metadata_json = ?
      WHERE agent_id = ? AND id = ?
    `);
    for (const edge of edges) {
      const metadata = parseJson(edge.metadata_json, {});
      update.run(canonicalJson({
        ...metadata,
        structureReviewState: normalizedReviewState,
        ...(normalizedReviewState === "accepted" ? {
          structureReviewedBy: clean(reviewedBy) || "human",
          structureReviewedAt: timestamp.toISOString(),
        } : {}),
      }, {}), normalizedAgentId, edge.id);
    }
    return edges.length;
  }

  recordRelationProposal({
    id,
    agentId,
    batchId = "",
    relation,
    fromMemoryId,
    toMemoryId,
    weight = 0.5,
    confidence = 0.5,
    rationale = "",
    provenance = "",
    proposalHash,
    evidence = [],
    metadata = {},
    createdAt = nowIso(),
  }) {
    const proposalId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedRelation = clean(relation);
    const normalizedFromMemoryId = clean(fromMemoryId);
    const normalizedToMemoryId = clean(toMemoryId);
    const normalizedProposalHash = clean(proposalHash);
    if (
      !proposalId
      || !normalizedAgentId
      || normalizedRelation !== "causes"
      || !normalizedFromMemoryId
      || !normalizedToMemoryId
      || normalizedFromMemoryId === normalizedToMemoryId
      || !normalizedProposalHash
    ) {
      throw new Error("Relation proposal record is incomplete.");
    }
    const endpoints = this.database.prepare(`
      SELECT id FROM memory_nodes
      WHERE agent_id = ? AND id IN (?, ?) AND status <> 'deleted'
    `).all(normalizedAgentId, normalizedFromMemoryId, normalizedToMemoryId);
    if (endpoints.length !== 2) {
      throw new Error("Relation proposal endpoints must exist for the same Agent.");
    }
    const normalizedEvidence = (Array.isArray(evidence) ? evidence : []).map((item) => ({
      sourceId: clean(item?.sourceId ?? item?.source_id),
      endpointCoverage: clean(item?.endpointCoverage ?? item?.endpoint_coverage),
    }));
    if (!normalizedEvidence.length
      || normalizedEvidence.some((item) => (
        !item.sourceId || !["from", "to", "both"].includes(item.endpointCoverage)
      ))) {
      throw new Error("Relation proposal requires validated source evidence.");
    }
    const uniqueEvidence = new Map();
    for (const item of normalizedEvidence) uniqueEvidence.set(item.sourceId, item);
    const sources = this.database.prepare(`
      SELECT id FROM source_records
      WHERE agent_id = ? AND id IN (${[...uniqueEvidence].map(() => "?").join(", ")})
    `).all(normalizedAgentId, ...uniqueEvidence.keys());
    if (sources.length !== uniqueEvidence.size) {
      throw new Error("Relation proposal evidence must belong to the same Agent.");
    }
    const idOwner = this.database.prepare(`
      SELECT agent_id FROM memory_relation_proposals WHERE id = ?
    `).get(proposalId);
    if (idOwner && idOwner.agent_id !== normalizedAgentId) {
      throw new Error("Relation proposal id already belongs to another Agent.");
    }
    const timestamp = clean(createdAt) || nowIso();
    return this.transaction(() => {
      const insertion = this.database.prepare(`
        INSERT INTO memory_relation_proposals (
          id, agent_id, batch_id, relation, from_memory_id, to_memory_id,
          direction, weight, confidence, rationale, provenance, proposal_hash,
          review_state, metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'directed', ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(agent_id, proposal_hash) DO NOTHING
      `).run(
        proposalId,
        normalizedAgentId,
        clean(batchId),
        normalizedRelation,
        normalizedFromMemoryId,
        normalizedToMemoryId,
        bounded(weight, 0.5),
        bounded(confidence, 0.5),
        clean(rationale),
        clean(provenance),
        normalizedProposalHash,
        json(metadata, {}),
        timestamp,
        timestamp,
      );
      const stored = this.database.prepare(`
        SELECT id FROM memory_relation_proposals
        WHERE agent_id = ? AND proposal_hash = ?
      `).get(normalizedAgentId, normalizedProposalHash);
      if (Number(insertion.changes || 0) === 1) {
        const insertEvidence = this.database.prepare(`
          INSERT INTO memory_relation_proposal_evidence (
            proposal_id, agent_id, source_id, endpoint_coverage, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const item of uniqueEvidence.values()) {
          insertEvidence.run(
            stored.id,
            normalizedAgentId,
            item.sourceId,
            item.endpointCoverage,
            timestamp,
          );
        }
      }
      return {
        ...this.getRelationProposal(normalizedAgentId, stored.id),
        wasInserted: Number(insertion.changes || 0) === 1,
      };
    });
  }

  getRelationProposal(agentId, proposalId) {
    const normalizedAgentId = clean(agentId);
    const row = this.database.prepare(`
      SELECT * FROM memory_relation_proposals WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, clean(proposalId));
    if (!row) return null;
    const evidence = this.database.prepare(`
      SELECT source.*, evidence.endpoint_coverage
      FROM memory_relation_proposal_evidence AS evidence
      JOIN source_records AS source ON source.id = evidence.source_id
      WHERE evidence.agent_id = ? AND evidence.proposal_id = ?
      ORDER BY source.occurred_at ASC, source.recorded_at ASC, source.id ASC
    `).all(normalizedAgentId, row.id);
    return normalizeRelationProposal(row, evidence);
  }

  listRelationProposals(agentId, {
    reviewStates = [],
    batchId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRelationProposals requires agentId.");
    const states = cleanStringList(Array.isArray(reviewStates) ? reviewStates : [reviewStates]);
    if (states.some((state) => !["pending", "accepted", "dismissed", "revoked"].includes(state))) {
      throw new Error("Unknown relation proposal review state.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (clean(batchId)) {
      clauses.push("batch_id = ?");
      parameters.push(clean(batchId));
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_relation_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      ...parameters,
      Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))),
    );
    return rows.map((row) => this.getRelationProposal(normalizedAgentId, row.id));
  }

  resolveRelationProposal({
    agentId,
    proposalId,
    resolution,
    resultEdgeId = null,
    resultEdgeUpdatedAt = null,
    resolvedBy = "human",
    note = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedResolution = clean(resolution);
    const proposal = this.getRelationProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Relation proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`Relation proposal is already ${proposal.review_state}.`);
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown relation proposal resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const normalizedEdgeId = clean(resultEdgeId) || null;
    const normalizedEdgeUpdatedAt = clean(resultEdgeUpdatedAt) || null;
    if (normalizedResolution === "accepted") {
      const edge = normalizedEdgeId ? this.getEdge(normalizedAgentId, normalizedEdgeId) : null;
      if (!edge
        || edge.from_memory_id !== proposal.from_memory_id
        || edge.to_memory_id !== proposal.to_memory_id
        || edge.relation !== proposal.relation
        || edge.updated_at !== normalizedEdgeUpdatedAt) {
        throw new Error("Accepted relation proposal requires the exact resulting edge version.");
      }
    } else if (normalizedEdgeId || normalizedEdgeUpdatedAt) {
      throw new Error("Dismissed relation proposal cannot reference a result edge.");
    }
    const resolvedAt = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_relation_proposals
      SET review_state = ?, result_edge_id = ?, result_edge_updated_at = ?,
          resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedEdgeId,
      normalizedEdgeUpdatedAt,
      clean(note),
      clean(resolvedBy) || "human",
      resolvedAt,
      resolvedAt,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Relation proposal changed while it was being resolved.");
    }
    return this.getRelationProposal(normalizedAgentId, proposal.id);
  }

  revokeRelationProposal({
    agentId,
    proposalId,
    revokedBy = "human",
    note = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const proposal = this.getRelationProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Relation proposal does not exist for this Agent.");
    if (proposal.review_state !== "accepted") {
      throw new Error(`Only an accepted relation proposal can be revoked; it is ${proposal.review_state}.`);
    }
    const edge = this.getEdge(normalizedAgentId, proposal.result_edge_id);
    if (!edge || edge.updated_at !== proposal.result_edge_updated_at) {
      throw new Error("Accepted relation edge has changed and cannot be revoked safely.");
    }
    const revokedAt = nowIso();
    return this.transaction(() => {
      const deletion = this.database.prepare(`
        DELETE FROM memory_edges
        WHERE agent_id = ? AND id = ? AND updated_at = ?
      `).run(normalizedAgentId, edge.id, proposal.result_edge_updated_at);
      if (Number(deletion.changes || 0) !== 1) {
        throw new Error("Accepted relation edge changed while it was being revoked.");
      }
      const update = this.database.prepare(`
        UPDATE memory_relation_proposals
        SET review_state = 'revoked', revoked_by = ?, revocation_note = ?,
            revoked_at = ?, updated_at = ?
        WHERE agent_id = ? AND id = ? AND review_state = 'accepted'
      `).run(
        clean(revokedBy) || "human",
        clean(note),
        revokedAt,
        revokedAt,
        normalizedAgentId,
        proposal.id,
      );
      if (Number(update.changes || 0) !== 1) {
        throw new Error("Relation proposal changed while it was being revoked.");
      }
      return this.getRelationProposal(normalizedAgentId, proposal.id);
    });
  }

  materializeStateAnalysisMemory(agentId, requestId) {
    const request = this.getStateAnalysisRequest(agentId, requestId);
    if (!request || request.status !== 'pending') throw new Error('State embedding requires a pending analysis request.');
    const decision = this.getIngestionDecisionByBatchCandidate(agentId, request.batch_id, request.candidate_index);
    if (!decision?.candidate?.content) return null;
    const id = stableId('state-analysis-memory', agentId, requestId);
    const existing = this.getMemory(id);
    if (existing) return existing;
    const candidate = decision.candidate;
    const evidence = this.getMemory(request.memoryIds[0]);
    const view = executionEventSourceView(this, agentId);
    if (view && request.memoryIds.some(memoryId => !view.allows(this.getMemory(memoryId)))) {
      throw Object.assign(new Error('State embedding awaits eligible evidence.'), { code: 'EVENT_SOURCE_TASK_DEFERRED' });
    }
    return this.transaction(() => {
      const memory = this.upsertMemory({
        id, agentId, kind: candidate.kind, layer: 'provisional', status: 'archived',
        title: candidate.title, content: candidate.content,
        subjectRole: request.subject_role, subjectKey: request.subject_key,
        canonicalKey: request.canonical_key, stateFamily: request.state_family,
        representationLayer: request.representation_layer, evidenceMode: request.evidence_mode,
        reality: candidate.reality, worldId: evidence.world_id, worldFrame: evidence.world_frame,
        eventDate: candidate.eventDate || null, eventStart: candidate.eventStart || null,
        knownAt: evidence.known_at, recordedAt: request.created_at,
        metadata: { stateAnalysisDraft: true, stateAnalysisRequestId: request.id },
      });
      for (const sourceId of request.sourceIds) this.linkSource(id, sourceId, 'evidence', {
        authority: 'model_inference', provenance: 'state-analysis-semantic-memory-v1',
      });
      return memory;
    });
  }

  bindStateAnalysisTarget({ agentId, requestId, canonicalKey, metadata = {} }) {
    const request = this.getStateAnalysisRequest(agentId, requestId);
    const key = clean(canonicalKey).toLocaleLowerCase('en-US');
    if (!request || request.status !== 'pending' || !key) throw new Error('State target binding requires a pending request and key.');
    // input_hash continues to identify the immutable extraction input for retries.
    this.database.prepare(`UPDATE memory_state_analysis_requests
      SET canonical_key = ?, metadata_json = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'pending'`).run(key,
      canonicalJson({ ...request.metadata, originalCanonicalKey: request.metadata.originalCanonicalKey || request.canonical_key,
        ...metadata }, {}), nowIso(), agentId, requestId);
    return this.getStateAnalysisRequest(agentId, requestId);
  }

  recordStateAnalysisRequest({
    id = "",
    agentId,
    batchId,
    candidateIndex,
    stateFamily,
    subjectRole,
    subjectKey,
    canonicalKey,
    targetLabel,
    targetSpec = {},
    representationLayer,
    evidenceMode,
    memoryIds = [],
    sourceIds = [],
    status = "pending",
    metadata = {},
    createdAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedBatchId = clean(batchId);
    const normalizedCandidateIndex = Number(candidateIndex);
    const normalizedFamily = clean(stateFamily);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedTargetLabel = clean(targetLabel);
    const normalizedTargetSpec = normalizeStateAnalysisTargetSpec(
      normalizedFamily,
      targetSpec,
      { allowEmpty: true },
    );
    const normalizedLayer = clean(representationLayer);
    const normalizedEvidenceMode = clean(evidenceMode);
    const normalizedStatus = clean(status);
    const normalizedMemoryIds = cleanStringList(memoryIds);
    const normalizedSourceIds = cleanStringList(sourceIds);
    const timestamp = clean(createdAt);
    if (!normalizedAgentId || !normalizedBatchId
      || !Number.isInteger(normalizedCandidateIndex) || normalizedCandidateIndex < 0
      || !MEMORY_STATE_FAMILIES.includes(normalizedFamily)
      || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
      || !normalizedSubjectKey || !normalizedCanonicalKey || !normalizedTargetLabel
      || !["reported", "inferred"].includes(normalizedLayer)
      || !["explicit", "observed", "inferred"].includes(normalizedEvidenceMode)
      || !["pending", "blocked"].includes(normalizedStatus)
      || !normalizedMemoryIds.length || !normalizedSourceIds.length
      || !validTimestamp(timestamp)) {
      throw new Error("State analysis request is incomplete.");
    }
    if ((normalizedEvidenceMode === "explicit") !== (normalizedLayer === "reported")) {
      throw new Error("State analysis request representation layer does not match its evidence mode.");
    }
    for (const memoryId of normalizedMemoryIds) {
      const memory = this.getMemory(memoryId);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.status === "deleted") {
        throw new Error("State analysis request memory must belong to the same Agent and be available.");
      }
    }
    const linkedSources = new Set(this.database.prepare(`
      SELECT DISTINCT source_id FROM memory_sources
      WHERE memory_id IN (${normalizedMemoryIds.map(() => "?").join(", ")})
    `).all(...normalizedMemoryIds).map((row) => row.source_id));
    if (normalizedSourceIds.some((sourceId) => !linkedSources.has(sourceId))) {
      throw new Error("State analysis request source must support one of its input memories.");
    }
    const inputHash = canonicalHash({
      agentId: normalizedAgentId,
      stateFamily: normalizedFamily,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      targetLabel: normalizedTargetLabel,
      targetSpec: normalizedTargetSpec,
      representationLayer: normalizedLayer,
      evidenceMode: normalizedEvidenceMode,
      memoryIds: [...normalizedMemoryIds].sort(),
      sourceIds: [...normalizedSourceIds].sort(),
    });
    const existingByInput = this.database.prepare(`
      SELECT id FROM memory_state_analysis_requests
      WHERE agent_id = ? AND input_hash = ?
    `).get(normalizedAgentId, inputHash);
    if (existingByInput) {
      return { ...this.getStateAnalysisRequest(normalizedAgentId, existingByInput.id), wasInserted: false };
    }
    const existingAtCandidate = this.database.prepare(`
      SELECT id, input_hash FROM memory_state_analysis_requests
      WHERE agent_id = ? AND batch_id = ? AND candidate_index = ?
    `).get(normalizedAgentId, normalizedBatchId, normalizedCandidateIndex);
    if (existingAtCandidate) {
      const existing = this.getStateAnalysisRequest(normalizedAgentId, existingAtCandidate.id);
      const sameRequest = existing
        && existing.state_family === normalizedFamily
        && existing.subject_role === normalizedSubjectRole
        && existing.subject_key === normalizedSubjectKey
        && existing.canonical_key === normalizedCanonicalKey
        && existing.target_label === normalizedTargetLabel
        && canonicalJson(existing.targetSpec, {}) === canonicalJson(normalizedTargetSpec, {})
        && existing.representation_layer === normalizedLayer
        && existing.evidence_mode === normalizedEvidenceMode
        && canonicalJson([...existing.memoryIds].sort(), [])
          === canonicalJson([...normalizedMemoryIds].sort(), [])
        && canonicalJson([...existing.sourceIds].sort(), [])
          === canonicalJson([...normalizedSourceIds].sort(), []);
      if (sameRequest) return { ...existing, wasInserted: false };
      throw new Error("State analysis request candidate already exists with different contents.");
    }
    const requestId = clean(id) || stableId(
      "state-request",
      normalizedAgentId,
      normalizedBatchId,
      normalizedCandidateIndex,
    );
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_state_analysis_requests WHERE id = ?
    `).get(requestId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("State analysis request id already belongs to another Agent.");
    }
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_state_analysis_requests (
          id, agent_id, batch_id, candidate_index, state_family,
          subject_role, subject_key, canonical_key, target_label,
          target_spec_json,
          representation_layer, evidence_mode, status, input_hash,
          metadata_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        requestId,
        normalizedAgentId,
        normalizedBatchId,
        normalizedCandidateIndex,
        normalizedFamily,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        normalizedTargetLabel,
        canonicalJson(normalizedTargetSpec, {}),
        normalizedLayer,
        normalizedEvidenceMode,
        normalizedStatus,
        inputHash,
        canonicalJson(metadata, {}),
        new Date(timestamp).toISOString(),
        new Date(timestamp).toISOString(),
      );
      const insertMemory = this.database.prepare(`
        INSERT INTO memory_state_analysis_request_memories (
          request_id, agent_id, memory_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedMemoryIds.forEach((memoryId, ordinal) => {
        insertMemory.run(requestId, normalizedAgentId, memoryId, ordinal);
      });
      const insertSource = this.database.prepare(`
        INSERT INTO memory_state_analysis_request_sources (
          request_id, agent_id, source_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedSourceIds.forEach((sourceId, ordinal) => {
        insertSource.run(requestId, normalizedAgentId, sourceId, ordinal);
      });
      return { ...this.getStateAnalysisRequest(normalizedAgentId, requestId), wasInserted: true };
    });
  }

  getStateAnalysisRequest(agentId, requestId) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(requestId);
    const row = this.database.prepare(`
      SELECT * FROM memory_state_analysis_requests WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedRequestId);
    if (!row) return null;
    const memoryIds = this.database.prepare(`
      SELECT memory_id FROM memory_state_analysis_request_memories
      WHERE agent_id = ? AND request_id = ? ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedRequestId).map((item) => item.memory_id);
    const sourceIds = this.database.prepare(`
      SELECT source_id FROM memory_state_analysis_request_sources
      WHERE agent_id = ? AND request_id = ? ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedRequestId).map((item) => item.source_id);
    return normalizeStateAnalysisRequest(row, memoryIds, sourceIds);
  }

  listStateAnalysisRequests(agentId, {
    statuses = [],
    stateFamily = "",
    stateFamilies = [],
    representationLayer = "",
    evidenceMode = "",
    batchId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStateAnalysisRequests requires agentId.");
    const normalizedStatuses = cleanStringList(Array.isArray(statuses) ? statuses : [statuses]);
    if (normalizedStatuses.some((item) => (
      !["pending", "completed", "blocked", "failed", "cancelled"].includes(item)
    ))) throw new Error("Unknown state analysis request status.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const normalizedFamilies = cleanStringList(
      Array.isArray(stateFamilies) ? stateFamilies : [stateFamilies],
    );
    if (clean(stateFamily) && normalizedFamilies.length) {
      throw new Error("Filter state analysis requests by stateFamily or stateFamilies, not both.");
    }
    if (normalizedFamilies.some((item) => !MEMORY_STATE_FAMILIES.includes(item))) {
      throw new Error("Unknown state analysis request family.");
    }
    if (clean(stateFamily)) {
      if (!MEMORY_STATE_FAMILIES.includes(clean(stateFamily))) {
        throw new Error("Unknown state analysis request family.");
      }
      clauses.push("state_family = ?");
      parameters.push(clean(stateFamily));
    } else if (normalizedFamilies.length) {
      clauses.push(`state_family IN (${normalizedFamilies.map(() => "?").join(", ")})`);
      parameters.push(...normalizedFamilies);
    }
    if (clean(representationLayer)) {
      if (!["reported", "inferred", "established"].includes(clean(representationLayer))) {
        throw new Error("Unknown state analysis request representation layer.");
      }
      clauses.push("representation_layer = ?");
      parameters.push(clean(representationLayer));
    }
    if (clean(evidenceMode)) {
      if (!["explicit", "observed", "inferred"].includes(clean(evidenceMode))) {
        throw new Error("Unknown state analysis request evidence mode.");
      }
      clauses.push("evidence_mode = ?");
      parameters.push(clean(evidenceMode));
    }
    if (clean(batchId)) {
      clauses.push("batch_id = ?");
      parameters.push(clean(batchId));
    }
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    const sourceView = executionEventSourceView(this, normalizedAgentId);
    if (sourceView) {
      clauses.push(`EXISTS (SELECT 1 FROM memory_state_analysis_request_memories AS link
        WHERE link.request_id = memory_state_analysis_requests.id)
        AND NOT EXISTS (SELECT 1 FROM memory_state_analysis_request_memories AS link
          WHERE link.request_id = memory_state_analysis_requests.id
            AND link.memory_id NOT IN (SELECT value FROM json_each(?)))
        AND NOT EXISTS (SELECT 1 FROM memory_state_analysis_request_sources AS link
          WHERE link.request_id = memory_state_analysis_requests.id
            AND link.source_id NOT IN (SELECT value FROM json_each(?)))`);
      parameters.push(JSON.stringify([...sourceView.memoryIds]), JSON.stringify([...sourceView.sourceIds]));
      clauses.push(`NOT EXISTS (SELECT 1 FROM memory_nodes current
        WHERE current.agent_id=memory_state_analysis_requests.agent_id
          AND current.subject_role=memory_state_analysis_requests.subject_role
          AND current.subject_key=memory_state_analysis_requests.subject_key
          AND current.canonical_key=memory_state_analysis_requests.canonical_key
          AND current.state_family=memory_state_analysis_requests.state_family
          AND current.representation_layer=memory_state_analysis_requests.representation_layer
          AND current.state_scope_key=? AND current.status='active'
          AND current.id NOT IN (SELECT value FROM json_each(?)))`);
      parameters.push(ROOT_STATE_SCOPE_KEY, JSON.stringify([...sourceView.memoryIds]));
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    const rows = this.database.prepare(`
      SELECT id FROM memory_state_analysis_requests
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, candidate_index ASC LIMIT ?
    `).all(...parameters, maximum);
    return rows.map((row) => this.getStateAnalysisRequest(normalizedAgentId, row.id));
  }

  recordStateAnalysisRequestFailure({
    agentId,
    requestId,
    errorMessage,
    errorDetails = {},
    maxAttempts = 3,
    failedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(requestId);
    const timestamp = clean(failedAt);
    const maximum = Math.min(20, Math.max(1, Math.trunc(Number(maxAttempts) || 3)));
    if (!normalizedAgentId || !normalizedRequestId || !validTimestamp(timestamp)) {
      throw new Error("Recording a state analysis failure requires Agent, request, and valid time.");
    }
    const current = this.getStateAnalysisRequest(normalizedAgentId, normalizedRequestId);
    if (!current) throw new Error("State analysis request was not found.");
    if (current.status !== "pending") {
      throw new Error("Only a pending state analysis request can record a processing failure.");
    }
    const previousHistory = Array.isArray(current.metadata?.failureHistory)
      ? current.metadata.failureHistory
      : [];
    const previousAttempts = Math.max(
      Number(current.metadata?.attemptCount) || 0,
      previousHistory.length,
    );
    const attemptCount = previousAttempts + 1;
    const failedIso = new Date(timestamp).toISOString();
    const details = errorDetails && typeof errorDetails === "object" && !Array.isArray(errorDetails)
      ? errorDetails
      : {};
    const failure = {
      attempt: attemptCount,
      failedAt: failedIso,
      error: clean(errorMessage) || "state-analysis-request-failed",
      details,
    };
    const metadata = {
      ...current.metadata,
      attemptCount,
      maxAttempts: maximum,
      failureHistory: [...previousHistory, failure],
      lastFailure: failure,
    };
    this.database.prepare(`
      UPDATE memory_state_analysis_requests
      SET error_message = ?, metadata_json = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'pending'
    `).run(
      failure.error,
      canonicalJson(metadata, {}),
      failedIso,
      normalizedAgentId,
      normalizedRequestId,
    );
    return {
      request: this.getStateAnalysisRequest(normalizedAgentId, normalizedRequestId),
      attemptCount,
      maxAttempts: maximum,
      exhausted: attemptCount >= maximum,
      failure,
    };
  }

  resolveStateAnalysisRequest({
    agentId,
    requestId,
    status,
    analysisBatchId = "",
    errorMessage = "",
    metadata = {},
    resolvedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(requestId);
    const normalizedStatus = clean(status);
    const timestamp = clean(resolvedAt);
    if (!normalizedAgentId || !normalizedRequestId
      || !["completed", "blocked", "failed", "cancelled"].includes(normalizedStatus)
      || !validTimestamp(timestamp)) {
      throw new Error("Resolving a state analysis request requires a final status and valid time.");
    }
    const current = this.getStateAnalysisRequest(normalizedAgentId, normalizedRequestId);
    if (!current) throw new Error("State analysis request was not found.");
    if (current.status !== "pending") {
      const same = current.status === normalizedStatus
        && current.analysis_batch_id === clean(analysisBatchId)
        && current.error_message === clean(errorMessage);
      if (same) return { ...current, wasUpdated: false };
      throw new Error("State analysis request is already resolved.");
    }
    this.database.prepare(`
      UPDATE memory_state_analysis_requests
      SET status = ?, analysis_batch_id = ?, error_message = ?, metadata_json = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'pending'
    `).run(
      normalizedStatus,
      clean(analysisBatchId),
      clean(errorMessage),
      canonicalJson({ ...current.metadata, ...metadata }, {}),
      new Date(timestamp).toISOString(),
      normalizedAgentId,
      normalizedRequestId,
    );
    return { ...this.getStateAnalysisRequest(normalizedAgentId, normalizedRequestId), wasUpdated: true };
  }

  recordStateAnalysisRun({
    id = randomUUID(),
    agentId,
    batchId = "",
    stateFamily,
    analyzerRole,
    subjectRole,
    subjectKey,
    canonicalKey,
    provider = "",
    model = "",
    promptVersion,
    schemaVersion,
    inputHash,
    status,
    memoryIds = [],
    sourceIds = [],
    output = {},
    rejected = [],
    usage = {},
    costAmount = 0,
    costCurrency = "",
    requestId = "",
    durationMs = 0,
    errorMessage = "",
    metadata = {},
    sourceMaterial = null,
    createdAt = nowIso(),
  } = {}) {
    const runId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedFamily = clean(stateFamily);
    const normalizedRole = clean(analyzerRole);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedPromptVersion = clean(promptVersion);
    const normalizedSchemaVersion = clean(schemaVersion);
    const normalizedInputHash = clean(inputHash);
    const normalizedStatus = clean(status);
    const normalizedMemoryIds = cleanStringList(memoryIds);
    const normalizedSourceIds = cleanStringList(sourceIds);
    const normalizedDurationMs = Math.trunc(Number(durationMs));
    const normalizedCostAmount = Number(costAmount);
    const timestamp = clean(createdAt);
    if (
      !runId || !normalizedAgentId || !MEMORY_STATE_FAMILIES.includes(normalizedFamily) || !normalizedRole
      || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
      || !normalizedSubjectKey || !normalizedCanonicalKey
      || !normalizedPromptVersion || !normalizedSchemaVersion || !normalizedInputHash
      || !["completed", "abstained", "rejected", "failed"].includes(normalizedStatus)
      || !normalizedMemoryIds.length || !normalizedSourceIds.length
      || !Number.isFinite(normalizedDurationMs) || normalizedDurationMs < 0
      || !Number.isFinite(normalizedCostAmount) || normalizedCostAmount < 0
      || !validTimestamp(timestamp)
    ) {
      throw new Error("State analysis run record is incomplete.");
    }
    for (const memoryId of normalizedMemoryIds) {
      const memory = this.getMemory(memoryId);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.status === "deleted") {
        throw new Error("State analysis run memory must belong to the same Agent and be available.");
      }
    }
    const linkedSources = new Set(this.database.prepare(`
      SELECT DISTINCT source_id FROM memory_sources
      WHERE memory_id IN (${normalizedMemoryIds.map(() => "?").join(", ")})
    `).all(...normalizedMemoryIds).map((row) => row.source_id));
    if (normalizedSourceIds.some((sourceId) => !linkedSources.has(sourceId))) {
      throw new Error("State analysis run source must support one of its input memories.");
    }
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_state_analysis_runs WHERE id = ?
    `).get(runId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("State analysis run id already belongs to another Agent.");
    }
    const existing = this.getStateAnalysisRun(normalizedAgentId, runId);
    if (existing) {
      const same = existing.state_family === normalizedFamily
        && existing.analyzer_role === normalizedRole
        && existing.subject_role === normalizedSubjectRole
        && existing.subject_key === normalizedSubjectKey
        && existing.canonical_key === normalizedCanonicalKey
        && existing.prompt_version === normalizedPromptVersion
        && existing.schema_version === normalizedSchemaVersion
        && existing.input_hash === normalizedInputHash
        && existing.status === normalizedStatus
        && canonicalJson(existing.memoryIds, []) === canonicalJson(normalizedMemoryIds, [])
        && canonicalJson(existing.sourceIds, []) === canonicalJson(normalizedSourceIds, [])
        && canonicalJson(existing.output, {}) === canonicalJson(output, {})
        && canonicalJson(existing.rejected, []) === canonicalJson(rejected, []);
      if (!same) throw new Error("State analysis run id already exists with different contents.");
      return { ...existing, wasInserted: false };
    }
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_state_analysis_runs (
          id, agent_id, batch_id, state_family, analyzer_role,
          subject_role, subject_key, canonical_key, provider, model,
          prompt_version, schema_version, input_hash, status, output_json,
          rejected_json, usage_json, cost_amount, cost_currency, request_id,
          duration_ms, error_message, metadata_json, created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
      `).run(
        runId,
        normalizedAgentId,
        clean(batchId),
        normalizedFamily,
        normalizedRole,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        clean(provider),
        clean(model),
        normalizedPromptVersion,
        normalizedSchemaVersion,
        normalizedInputHash,
        normalizedStatus,
        canonicalJson(output, {}),
        canonicalJson(rejected, []),
        canonicalJson(usage, {}),
        normalizedCostAmount,
        clean(costCurrency),
        clean(requestId),
        normalizedDurationMs,
        clean(errorMessage),
        canonicalJson({ ...metadata, ...(sourceMaterial ? { eventSourceMaterial: sourceMaterial } : {}) }, {}),
        new Date(timestamp).toISOString(),
      );
      const insertMemory = this.database.prepare(`
        INSERT INTO memory_state_analysis_run_memories (
          analysis_run_id, agent_id, memory_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedMemoryIds.forEach((memoryId, index) => {
        insertMemory.run(runId, normalizedAgentId, memoryId, index);
      });
      const insertSource = this.database.prepare(`
        INSERT INTO memory_state_analysis_run_sources (
          analysis_run_id, agent_id, source_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedSourceIds.forEach((sourceId, index) => {
        insertSource.run(runId, normalizedAgentId, sourceId, index);
      });
      return { ...this.getStateAnalysisRun(normalizedAgentId, runId), wasInserted: true };
    });
  }

  getStateAnalysisRun(agentId, analysisRunId) {
    const normalizedAgentId = clean(agentId);
    const normalizedRunId = clean(analysisRunId);
    const row = this.database.prepare(`
      SELECT * FROM memory_state_analysis_runs WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedRunId);
    if (!row) return null;
    const memoryIds = this.database.prepare(`
      SELECT memory_id FROM memory_state_analysis_run_memories
      WHERE agent_id = ? AND analysis_run_id = ? ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedRunId).map((item) => item.memory_id);
    const sourceIds = this.database.prepare(`
      SELECT source_id FROM memory_state_analysis_run_sources
      WHERE agent_id = ? AND analysis_run_id = ? ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedRunId).map((item) => item.source_id);
    return normalizeStateAnalysisRun(row, memoryIds, sourceIds);
  }

  listStateAnalysisRuns(agentId, {
    stateFamily = "",
    analyzerRole = "",
    canonicalKey = "",
    batchId = "",
    statuses = [],
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStateAnalysisRuns requires agentId.");
    const normalizedStatuses = cleanStringList(Array.isArray(statuses) ? statuses : [statuses]);
    if (normalizedStatuses.some((item) => !["completed", "abstained", "rejected", "failed"].includes(item))) {
      throw new Error("Unknown state analysis run status.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const filters = [
      ["state_family", clean(stateFamily)],
      ["analyzer_role", clean(analyzerRole)],
      ["canonical_key", clean(canonicalKey).toLocaleLowerCase("en-US")],
      ["batch_id", clean(batchId)],
    ];
    for (const [column, value] of filters) {
      if (!value) continue;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_state_analysis_runs
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...parameters, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))));
    return rows.map((row) => this.getStateAnalysisRun(normalizedAgentId, row.id));
  }

  recordStateEvidenceObservation({
    id = randomUUID(),
    agentId,
    batchId = "",
    stateFamily,
    subjectRole,
    subjectKey,
    canonicalKey,
    memoryId,
    evidenceGroupId,
    contextId = "",
    signal,
    claimedDirection,
    effectiveDirection,
    qualification,
    confidence = 0.5,
    origin = "llm",
    scope = {},
    payloadSchemaVersion,
    payload = {},
    excludedReason = "",
    sourceIds = [],
    analysisRunIds = [],
    observedAt = "",
    createdAt = nowIso(),
  } = {}) {
    const observationId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedFamily = clean(stateFamily);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedMemoryId = clean(memoryId);
    const normalizedGroupId = clean(evidenceGroupId);
    const normalizedSignal = clean(signal);
    const normalizedClaimedDirection = clean(claimedDirection);
    const normalizedEffectiveDirection = clean(effectiveDirection);
    const normalizedQualification = clean(qualification);
    const normalizedOrigin = clean(origin);
    const normalizedPayloadSchemaVersion = clean(payloadSchemaVersion);
    const normalizedExcludedReason = clean(excludedReason);
    const normalizedSourceIds = cleanStringList(sourceIds).sort();
    const normalizedRunIds = cleanStringList(analysisRunIds).sort();
    const timestamp = clean(createdAt);
    const memory = this.getMemory(normalizedMemoryId);
    const normalizedObservedAt = clean(observedAt)
      || memory?.known_at || memory?.event_start || memory?.recorded_at || "";
    if (
      !observationId || !normalizedAgentId || !MEMORY_STATE_FAMILIES.includes(normalizedFamily)
      || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
      || !normalizedSubjectKey || !normalizedCanonicalKey || !normalizedMemoryId
      || !normalizedGroupId || !normalizedSignal
      || !["support", "opposition", "neutral"].includes(normalizedClaimedDirection)
      || !["support", "opposition", "neutral"].includes(normalizedEffectiveDirection)
      || !["qualified", "excluded", "unresolved"].includes(normalizedQualification)
      || !["llm", "deterministic", "manual", "imported"].includes(normalizedOrigin)
      || !normalizedPayloadSchemaVersion || !normalizedSourceIds.length
      || !validTimestamp(normalizedObservedAt) || !validTimestamp(timestamp)
    ) {
      throw new Error("State evidence observation record is incomplete.");
    }
    if (normalizedQualification !== "qualified" && normalizedEffectiveDirection !== "neutral") {
      throw new Error("Excluded or unresolved state evidence cannot affect a state direction.");
    }
    if (normalizedQualification === "excluded" && !normalizedExcludedReason) {
      throw new Error("Excluded state evidence requires a reason.");
    }
    if (normalizedQualification === "qualified" && normalizedExcludedReason) {
      throw new Error("Qualified state evidence cannot carry an exclusion reason.");
    }
    if (normalizedOrigin === "llm" && !normalizedRunIds.length) {
      throw new Error("LLM state evidence requires at least one analysis run.");
    }
    if (!memory || memory.agent_id !== normalizedAgentId || memory.status === "deleted") {
      throw new Error("State evidence memory must belong to the same Agent and be available.");
    }
    const memoryDetail = this.getMemoryDetail(normalizedAgentId, normalizedMemoryId);
    const targetIsPrimarySubject = memory.subject_role === normalizedSubjectRole
      && memory.subject_key === normalizedSubjectKey;
    const targetHasStructuredRole = memoryDetail?.roles.some((role) => (
      role.actor_role === normalizedSubjectRole && role.actor_key === normalizedSubjectKey
    ));
    const linkedSourceIds = new Set(memoryDetail?.sources.map((item) => item.id) || []);
    if (normalizedSourceIds.some((sourceId) => !linkedSourceIds.has(sourceId))) {
      throw new Error("State evidence source must already support its evidence memory.");
    }
    const requestIds = new Set();
    for (const runId of normalizedRunIds) {
      const run = this.getStateAnalysisRun(normalizedAgentId, runId);
      if (!run || run.state_family !== normalizedFamily
        || run.subject_role !== normalizedSubjectRole
        || run.subject_key !== normalizedSubjectKey
        || run.canonical_key !== normalizedCanonicalKey
        || run.status !== "completed"
        || !run.memoryIds.includes(normalizedMemoryId)
        || normalizedSourceIds.some((sourceId) => !run.sourceIds.includes(sourceId))) {
        throw new Error("State evidence analysis run does not cover the same target and sources.");
      }
      requestIds.add(clean(run.metadata?.stateAnalysisRequestId));
    }
    if (!targetIsPrimarySubject && !targetHasStructuredRole) {
      // Raw speech retains its real speaker. A pending identity task can bind
      // that speech to a different analysis target without changing the archive.
      const request = normalizedFamily === 'identity' && memory.kind === 'utterance'
        && memory.status === 'active' && requestIds.size === 1 && !requestIds.has('')
        ? this.getStateAnalysisRequest(normalizedAgentId, [...requestIds][0]) : null;
      const verbatimIds = new Set(memoryDetail.sources.filter(source => source.relation === 'verbatim').map(source => source.id));
      if (!request || request.status !== 'pending' || request.state_family !== normalizedFamily
        || request.subject_role !== normalizedSubjectRole || request.subject_key !== normalizedSubjectKey
        || request.canonical_key !== normalizedCanonicalKey || !request.memoryIds.includes(normalizedMemoryId)
        || normalizedSourceIds.some(sourceId => !request.sourceIds.includes(sourceId) || !verbatimIds.has(sourceId))) {
        throw new Error("State evidence memory does not identify the evaluated subject.");
      }
    }
    const normalizedConfidence = unitInterval(confidence, "state evidence confidence");
    const hash = createHash("sha256").update(canonicalJson({
      agentId: normalizedAgentId,
      stateFamily: normalizedFamily,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      memoryId: normalizedMemoryId,
      evidenceGroupId: normalizedGroupId,
      contextId: clean(contextId),
      signal: normalizedSignal,
      claimedDirection: normalizedClaimedDirection,
      effectiveDirection: normalizedEffectiveDirection,
      qualification: normalizedQualification,
      confidence: normalizedConfidence,
      origin: normalizedOrigin,
      scope,
      payloadSchemaVersion: normalizedPayloadSchemaVersion,
      payload,
      excludedReason: normalizedExcludedReason,
      sourceIds: normalizedSourceIds,
      observedAt: new Date(normalizedObservedAt).toISOString(),
    }, {})).digest("hex");
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_state_evidence_observations WHERE id = ?
    `).get(observationId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("State evidence observation id already belongs to another Agent.");
    }
    return this.transaction(() => {
      const duplicate = this.database.prepare(`
        SELECT id FROM memory_state_evidence_observations
        WHERE agent_id = ? AND observation_hash = ?
      `).get(normalizedAgentId, hash);
      if (duplicate) {
        const linkRun = this.database.prepare(`
          INSERT OR IGNORE INTO memory_state_observation_runs (
            observation_id, analysis_run_id, agent_id, created_at
          ) VALUES (?, ?, ?, ?)
        `);
        for (const runId of normalizedRunIds) {
          linkRun.run(duplicate.id, runId, normalizedAgentId, new Date(timestamp).toISOString());
        }
        return {
          ...this.getStateEvidenceObservation(normalizedAgentId, duplicate.id),
          wasInserted: false,
        };
      }
      if (owner) {
        throw new Error("State evidence observation id already exists with different contents.");
      }
      const previous = this.database.prepare(`
        SELECT id FROM memory_state_evidence_observations
        WHERE agent_id = ? AND state_family = ? AND subject_role = ?
          AND subject_key = ? AND canonical_key = ? AND memory_id = ?
          AND lifecycle = 'current'
      `).get(
        normalizedAgentId,
        normalizedFamily,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        normalizedMemoryId,
      );
      const normalizedTimestamp = new Date(timestamp).toISOString();
      if (previous) {
        const update = this.database.prepare(`
          UPDATE memory_state_evidence_observations
          SET lifecycle = 'superseded', updated_at = ?
          WHERE agent_id = ? AND id = ? AND lifecycle = 'current'
        `).run(normalizedTimestamp, normalizedAgentId, previous.id);
        if (Number(update.changes || 0) !== 1) {
          throw new Error("State evidence observation changed while being superseded.");
        }
      }
      this.database.prepare(`
        INSERT INTO memory_state_evidence_observations (
          id, agent_id, batch_id, state_family, subject_role, subject_key,
          canonical_key, memory_id, evidence_group_id, context_id, signal,
          claimed_direction, effective_direction, qualification, confidence,
          origin, scope_json, payload_schema_version, payload_json, excluded_reason,
          observation_hash, lifecycle, supersedes_observation_id, observed_at,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'current', ?, ?, ?, ?
        )
      `).run(
        observationId,
        normalizedAgentId,
        clean(batchId),
        normalizedFamily,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        normalizedMemoryId,
        normalizedGroupId,
        clean(contextId),
        normalizedSignal,
        normalizedClaimedDirection,
        normalizedEffectiveDirection,
        normalizedQualification,
        normalizedConfidence,
        normalizedOrigin,
        canonicalJson(scope, {}),
        normalizedPayloadSchemaVersion,
        canonicalJson(payload, {}),
        normalizedExcludedReason,
        hash,
        previous?.id || null,
        new Date(normalizedObservedAt).toISOString(),
        normalizedTimestamp,
        normalizedTimestamp,
      );
      const insertSource = this.database.prepare(`
        INSERT INTO memory_state_observation_sources (
          observation_id, agent_id, source_id, created_at
        ) VALUES (?, ?, ?, ?)
      `);
      for (const sourceId of normalizedSourceIds) {
        insertSource.run(observationId, normalizedAgentId, sourceId, normalizedTimestamp);
      }
      const insertRun = this.database.prepare(`
        INSERT INTO memory_state_observation_runs (
          observation_id, analysis_run_id, agent_id, created_at
        ) VALUES (?, ?, ?, ?)
      `);
      for (const runId of normalizedRunIds) {
        insertRun.run(observationId, runId, normalizedAgentId, normalizedTimestamp);
      }
      return {
        ...this.getStateEvidenceObservation(normalizedAgentId, observationId),
        wasInserted: true,
      };
    });
  }

  getStateEvidenceObservation(agentId, observationId) {
    const normalizedAgentId = clean(agentId);
    const normalizedObservationId = clean(observationId);
    const row = this.database.prepare(`
      SELECT * FROM memory_state_evidence_observations WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedObservationId);
    if (!row) return null;
    const sourceIds = this.database.prepare(`
      SELECT source_id FROM memory_state_observation_sources
      WHERE agent_id = ? AND observation_id = ? ORDER BY source_id ASC
    `).all(normalizedAgentId, normalizedObservationId).map((item) => item.source_id);
    const analysisRunIds = this.database.prepare(`
      SELECT analysis_run_id FROM memory_state_observation_runs
      WHERE agent_id = ? AND observation_id = ? ORDER BY analysis_run_id ASC
    `).all(normalizedAgentId, normalizedObservationId).map((item) => item.analysis_run_id);
    return normalizeStateEvidenceObservation(row, sourceIds, analysisRunIds);
  }

  listStateEvidenceObservations(agentId, {
    stateFamily = "",
    subjectRole = "",
    subjectKey = "",
    canonicalKey = "",
    memoryId = "",
    qualifications = [],
    lifecycles = ["current"],
    limit = 200,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStateEvidenceObservations requires agentId.");
    const normalizedQualifications = cleanStringList(
      Array.isArray(qualifications) ? qualifications : [qualifications],
    );
    const normalizedLifecycles = cleanStringList(
      Array.isArray(lifecycles) ? lifecycles : [lifecycles],
    );
    if (normalizedQualifications.some((item) => !["qualified", "excluded", "unresolved"].includes(item))) {
      throw new Error("Unknown state evidence qualification.");
    }
    if (normalizedLifecycles.some((item) => !["current", "superseded", "withdrawn"].includes(item))) {
      throw new Error("Unknown state evidence lifecycle.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const filters = [
      ["state_family", clean(stateFamily)],
      ["subject_role", clean(subjectRole)],
      ["subject_key", clean(subjectKey)],
      ["canonical_key", clean(canonicalKey).toLocaleLowerCase("en-US")],
      ["memory_id", clean(memoryId)],
    ];
    for (const [column, value] of filters) {
      if (!value) continue;
      clauses.push(`${column} = ?`);
      parameters.push(value);
    }
    if (normalizedQualifications.length) {
      clauses.push(`qualification IN (${normalizedQualifications.map(() => "?").join(", ")})`);
      parameters.push(...normalizedQualifications);
    }
    if (normalizedLifecycles.length) {
      clauses.push(`lifecycle IN (${normalizedLifecycles.map(() => "?").join(", ")})`);
      parameters.push(...normalizedLifecycles);
    }
    const sourceView = executionEventSourceView(this, normalizedAgentId);
    if (sourceView) {
      clauses.push('id IN (SELECT value FROM json_each(?))');
      parameters.push(JSON.stringify([...sourceView.observationIds]));
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_state_evidence_observations
      WHERE ${clauses.join(" AND ")}
      ORDER BY observed_at DESC, created_at DESC, id DESC LIMIT ?
    `).all(...parameters, Math.min(1000, Math.max(1, Math.trunc(Number(limit) || 200))));
    return rows.map((row) => this.getStateEvidenceObservation(normalizedAgentId, row.id));
  }

  withdrawStateEvidenceObservation({ agentId, observationId } = {}) {
    const normalizedAgentId = clean(agentId);
    const observation = this.getStateEvidenceObservation(normalizedAgentId, observationId);
    if (!observation) throw new Error("State evidence observation does not exist for this Agent.");
    if (observation.lifecycle !== "current") {
      throw new Error(`Only current state evidence can be withdrawn; it is ${observation.lifecycle}.`);
    }
    const timestamp = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_state_evidence_observations
      SET lifecycle = 'withdrawn', updated_at = ?
      WHERE agent_id = ? AND id = ? AND lifecycle = 'current'
    `).run(timestamp, normalizedAgentId, observation.id);
    if (Number(result.changes || 0) !== 1) {
      throw new Error("State evidence observation changed while being withdrawn.");
    }
    return this.getStateEvidenceObservation(normalizedAgentId, observation.id);
  }

  recordReportedStateProposal({
    id = "",
    agentId,
    batchId = "",
    stateFamily,
    subjectRole,
    subjectKey,
    canonicalKey,
    action,
    previousMemoryId = null,
    targetScopeKey = ROOT_STATE_SCOPE_KEY,
    proposedState = null,
    reviewVersion,
    inputHash,
    selectedObservationId,
    consideredObservationIds = [],
    metadata = {},
    createdAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedFamily = clean(stateFamily);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedAction = clean(action);
    const normalizedPreviousMemoryId = clean(previousMemoryId) || null;
    const normalizedTargetScopeKey = clean(targetScopeKey) || ROOT_STATE_SCOPE_KEY;
    const normalizedReviewVersion = clean(reviewVersion);
    const normalizedInputHash = clean(inputHash);
    const normalizedSelectedObservationId = clean(selectedObservationId);
    const normalizedConsideredObservationIds = cleanStringList(consideredObservationIds);
    const stateDraftActions = new Set([
      "create", "reinforce", "narrow_scope", "add_scoped_exception",
      "supersede", "pause", "resume",
    ]);
    const draft = proposedState && typeof proposedState === "object" && !Array.isArray(proposedState)
      ? canonicalJsonValue(proposedState)
      : null;
    if (!normalizedAgentId || !MEMORY_STATE_FAMILIES.includes(normalizedFamily)
      || !SUBJECT_ROLES.includes(normalizedSubjectRole) || !normalizedSubjectKey
      || !normalizedCanonicalKey || !REPORTED_STATE_PROPOSAL_ACTIONS.includes(normalizedAction)
      || !normalizedReviewVersion || !normalizedInputHash || !normalizedSelectedObservationId) {
      throw new Error("Reported state proposal is incomplete.");
    }
    if (!isValidStateScopeKey(normalizedTargetScopeKey)
      || normalizedTargetScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Reported state proposal target scope is invalid.");
    }
    if (!isReportedStateActionAllowedForFamily(normalizedAction, normalizedFamily)) {
      throw new Error("Reported state proposal action is invalid for its state family.");
    }
    if (!normalizedConsideredObservationIds.includes(normalizedSelectedObservationId)) {
      throw new Error("Selected reported-state observation must be included in considered observations.");
    }
    if (normalizedAction === "create" && normalizedPreviousMemoryId) {
      throw new Error("Reported state create proposal cannot reference a previous state.");
    }
    if (normalizedAction === "create" && normalizedTargetScopeKey !== ROOT_STATE_SCOPE_KEY) {
      throw new Error("Reported state create proposal must target the root scope.");
    }
    if (normalizedAction !== "create" && !normalizedPreviousMemoryId) {
      throw new Error("Reported state transition proposal requires the exact previous state.");
    }
    if (stateDraftActions.has(normalizedAction) !== Boolean(draft)) {
      throw new Error(stateDraftActions.has(normalizedAction)
        ? `Reported state ${normalizedAction} proposal requires a normalized state draft.`
        : `Reported state ${normalizedAction} proposal must not carry a replacement state draft.`);
    }

    let proposedKind = "";
    let statePhase = "unspecified";
    let temporalState = "unknown";
    if (draft) {
      proposedKind = clean(draft.kind);
      statePhase = clean(draft.statePhase) || "unspecified";
      temporalState = clean(draft.temporalState) || "unknown";
      if (clean(draft.stateFamily) !== normalizedFamily
        || clean(draft.representationLayer) !== "reported"
        || clean(draft.subjectRole) !== normalizedSubjectRole
        || clean(draft.subjectKey) !== normalizedSubjectKey
        || clean(draft.canonicalKey).toLocaleLowerCase("en-US") !== normalizedCanonicalKey) {
        throw new Error("Reported state draft does not match the fixed proposal target.");
      }
      if (!proposedKind || !isMemoryKindAllowedForStateFamily(proposedKind, normalizedFamily)) {
        throw new Error("Reported state draft kind is invalid for its state family.");
      }
      if (!MEMORY_STATE_PHASES.includes(statePhase) || statePhase === "not_applicable") {
        throw new Error("Reported state draft has an invalid state phase.");
      }
      if (!TEMPORAL_STATES.includes(temporalState)) {
        throw new Error("Reported state draft has an invalid temporal state.");
      }
      if (!validTimestamp(draft.validFrom)) {
        throw new Error("Reported state draft requires a valid validity start.");
      }
      if (normalizedAction === "pause" && statePhase !== "paused") {
        throw new Error("Reported state pause draft must use the paused state phase.");
      }
      if (normalizedAction === "resume" && statePhase !== "active") {
        throw new Error("Reported state resume draft must use the active state phase.");
      }
    }

    const normalizedProposedScopeKey = normalizedAction === "add_scoped_exception"
      ? reportedStateScopeKeyFromDraft(normalizedFamily, draft)
      : normalizedTargetScopeKey;
    if (!isValidStateScopeKey(normalizedProposedScopeKey)
      || normalizedProposedScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Reported state proposal result scope is invalid.");
    }
    if (normalizedAction === "add_scoped_exception"
      && (normalizedTargetScopeKey !== ROOT_STATE_SCOPE_KEY
        || normalizedProposedScopeKey === normalizedTargetScopeKey)) {
      throw new Error("Scoped reported-state exceptions require a root target and a distinct local scope.");
    }

    const observations = normalizedConsideredObservationIds.map((observationId, ordinal) => {
      const observation = this.getStateEvidenceObservation(normalizedAgentId, observationId);
      if (!observation || observation.lifecycle !== "current"
        || observation.state_family !== normalizedFamily
        || observation.subject_role !== normalizedSubjectRole
        || observation.subject_key !== normalizedSubjectKey
        || observation.canonical_key !== normalizedCanonicalKey
        || clean(observation.scope?.currentRepresentationLayer) !== "reported") {
        throw new Error("Reported state proposal observation is outside the reviewed target or layer.");
      }
      const memoryId = clean(observation.memory_id || observation.memoryId);
      const detail = this.getMemoryDetail(normalizedAgentId, memoryId);
      if (!detail || detail.memory.status === "deleted") {
        throw new Error("Reported state proposal observation lost its evidence memory.");
      }
      const sourceById = new Map(detail.sources.map((source) => [source.id, source]));
      if (!observation.sourceIds.length
        || observation.sourceIds.some((sourceId) => !sourceById.has(sourceId))) {
        throw new Error("Reported state proposal observation lost its direct evidence source.");
      }
      const sourceFingerprints = [...observation.sourceIds].sort().map((sourceId) => {
        const source = sourceById.get(sourceId);
        if (source.lifecycle !== "active") {
          throw new Error("Reported state proposal observation source is no longer active.");
        }
        return {
          id: sourceId,
          fingerprint: canonicalHash({
            id: source.id,
            agentId: source.agent_id,
            sourceKind: source.source_kind,
            externalId: source.external_id,
            occurredAt: source.occurred_at,
            knownAt: source.known_at,
            speaker: source.speaker,
            content: source.content,
          }),
        };
      });
      return {
        id: observation.id,
        evidenceRole: observation.id === normalizedSelectedObservationId ? "selected" : "considered",
        ordinal,
        snapshot: {
          observationId: observation.id,
          observationHash: clean(observation.observation_hash),
          memoryId,
          memoryFingerprint: canonicalHash({
            id: detail.memory.id,
            title: detail.memory.title,
            content: detail.memory.content,
            subjectRole: detail.memory.subject_role,
            subjectKey: detail.memory.subject_key,
            knownAt: detail.memory.known_at,
            eventStart: detail.memory.event_start,
            roles: detail.roles.map((role) => ({
              role: role.role,
              actorRole: role.actor_role,
              actorKey: role.actor_key,
              isPrimary: role.is_primary,
            })),
          }),
          sourceFingerprints,
        },
      };
    });

    const selected = observations.find((observation) => observation.evidenceRole === "selected");
    const selectedMemory = this.getMemory(selected?.snapshot.memoryId);
    if (!selected || !selectedMemory) {
      throw new Error("Reported state proposal cannot snapshot its selected evidence.");
    }
    const evidenceSnapshot = {
      version: "reported-state-evidence-snapshot-v1",
      selectedContent: selectedMemory.content,
      observations: observations.map((observation) => observation.snapshot),
    };
    const proposalMetadata = canonicalJsonValue({
      ...(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}),
      reportedStateEvidenceSnapshot: evidenceSnapshot,
    });

    const normalizedCreatedAt = new Date(createdAt).toISOString();
    const proposalHash = createHash("sha256").update(canonicalJson({
      agentId: normalizedAgentId,
      stateFamily: normalizedFamily,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      representationLayer: "reported",
      targetScopeKey: normalizedTargetScopeKey,
      proposedScopeKey: normalizedProposedScopeKey,
      action: normalizedAction,
      previousMemoryId: normalizedPreviousMemoryId,
      proposedState: draft || {},
      reviewVersion: normalizedReviewVersion,
      inputHash: normalizedInputHash,
      observations,
      evidenceSnapshot,
    }, {})).digest("hex");
    const proposalId = clean(id) || stableId(
      "reported-state-proposal",
      normalizedAgentId,
      proposalHash,
    );
    const existingOwner = this.database.prepare(`
      SELECT agent_id FROM memory_reported_state_proposals WHERE id = ?
    `).get(proposalId);
    if (existingOwner && existingOwner.agent_id !== normalizedAgentId) {
      throw new Error("Reported state proposal id already belongs to another Agent.");
    }

    const ownPendingState = this.database.prepare(`SELECT memory.id
      FROM memory_nodes memory JOIN memory_reported_state_proposals proposal
        ON proposal.agent_id = memory.agent_id
        AND proposal.id = json_extract(memory.metadata_json, '$.reportedStateProposalId')
      WHERE proposal.agent_id = ? AND proposal.proposal_hash = ? AND memory.layer = 'provisional'
      LIMIT 1`).get(normalizedAgentId, proposalHash);
    const currentState = this.getCurrentCanonicalMemory({
      agentId: normalizedAgentId, subjectRole: normalizedSubjectRole, subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey, representationLayer: "reported", stateFamily: normalizedFamily,
      stateScopeKey: normalizedTargetScopeKey, includePending: true, excludeMemoryId: ownPendingState?.id,
      includeHistorical: normalizedAction !== "create",
    });
    if ((currentState?.id || null) !== normalizedPreviousMemoryId) {
      throw new Error("Reported state changed after review; rebuild the proposal from current evidence.");
    }

    return this.transaction(() => {
      const insertion = this.database.prepare(`
        INSERT OR IGNORE INTO memory_reported_state_proposals (
          id, agent_id, batch_id, state_family, subject_role, subject_key,
          canonical_key, representation_layer, target_scope_key, proposed_scope_key,
          action, previous_memory_id,
          proposed_kind, state_phase, temporal_state, draft_json,
          review_version, input_hash, proposal_hash, review_state,
          metadata_json, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'pending', ?, ?, ?
        )
      `).run(
        proposalId,
        normalizedAgentId,
        clean(batchId),
        normalizedFamily,
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        normalizedTargetScopeKey,
        normalizedProposedScopeKey,
        normalizedAction,
        normalizedPreviousMemoryId,
        proposedKind,
        statePhase,
        temporalState,
        canonicalJson(draft || {}, {}),
        normalizedReviewVersion,
        normalizedInputHash,
        proposalHash,
        canonicalJson(proposalMetadata, {}),
        normalizedCreatedAt,
        normalizedCreatedAt,
      );
      const stored = this.database.prepare(`
        SELECT id, proposal_hash FROM memory_reported_state_proposals
        WHERE agent_id = ? AND proposal_hash = ?
      `).get(normalizedAgentId, proposalHash);
      if (!stored) throw new Error("Reported state proposal could not be stored.");
      if (existingOwner && stored.id !== proposalId) {
        throw new Error("Reported state proposal id already exists with different contents.");
      }
      if (Number(insertion.changes || 0) === 1) {
        const insertObservation = this.database.prepare(`
          INSERT INTO memory_reported_state_proposal_observations (
            proposal_id, agent_id, observation_id, evidence_role, ordinal, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `);
        for (const observation of observations) {
          insertObservation.run(
            stored.id,
            normalizedAgentId,
            observation.id,
            observation.evidenceRole,
            observation.ordinal,
            normalizedCreatedAt,
          );
        }
      }
      return {
        ...this.getReportedStateProposal(normalizedAgentId, stored.id),
        wasInserted: Number(insertion.changes || 0) === 1,
      };
    });
  }

  getReportedStateProposal(agentId, proposalId) {
    const normalizedAgentId = clean(agentId);
    const row = this.database.prepare(`
      SELECT * FROM memory_reported_state_proposals WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, clean(proposalId));
    if (!row) return null;
    const observations = this.database.prepare(`
      SELECT observation_id, evidence_role, ordinal
      FROM memory_reported_state_proposal_observations
      WHERE agent_id = ? AND proposal_id = ?
      ORDER BY ordinal ASC, observation_id ASC
    `).all(normalizedAgentId, row.id);
    return normalizeReportedStateProposal(row, observations);
  }

  listReportedStateProposals(agentId, {
    reviewStates = [],
    stateFamily = "",
    canonicalKey = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listReportedStateProposals requires agentId.");
    const states = cleanStringList(Array.isArray(reviewStates) ? reviewStates : [reviewStates]);
    if (states.some((state) => !["pending", "accepted", "dismissed"].includes(state))) {
      throw new Error("Unknown reported state proposal review state.");
    }
    const normalizedFamily = clean(stateFamily);
    if (normalizedFamily && !MEMORY_STATE_FAMILIES.includes(normalizedFamily)) {
      throw new Error("Unknown reported state proposal family.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (normalizedFamily) {
      clauses.push("state_family = ?");
      parameters.push(normalizedFamily);
    }
    if (clean(canonicalKey)) {
      clauses.push("canonical_key = ?");
      parameters.push(clean(canonicalKey).toLocaleLowerCase("en-US"));
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_reported_state_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...parameters, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))));
    return rows.map((row) => this.getReportedStateProposal(normalizedAgentId, row.id));
  }

  resolveReportedStateProposalRecord({
    agentId,
    proposalId,
    resolution,
    resultMemoryId = null,
    resolvedBy = "human",
    note = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedResolution = clean(resolution);
    const proposal = this.getReportedStateProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Reported state proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`Reported state proposal is already ${proposal.review_state}.`);
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown reported state proposal resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const normalizedMemoryId = clean(resultMemoryId) || null;
    if (normalizedResolution === "accepted") {
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId
        || memory.subject_role !== proposal.subject_role
        || memory.subject_key !== proposal.subject_key
        || memory.canonical_key !== proposal.canonical_key
        || memory.representation_layer !== "reported"
        || memory.state_family !== proposal.state_family
        || memory.state_scope_key !== proposal.proposed_scope_key) {
        throw new Error("Accepted reported state proposal requires its exact resulting state memory.");
      }
      const sameMemoryActions = new Set([
        "reinforce", "progress_update", "complete", "cancel", "end", "retire",
        "interrupt", "stop", "revoke", "correct_attribution",
      ]);
      const replacementActions = new Set(["narrow_scope", "supersede", "pause", "resume"]);
      if (sameMemoryActions.has(proposal.action) && memory.id !== proposal.previousMemoryId) {
        throw new Error("This reported state action must resolve against the reviewed current state.");
      }
      if (proposal.action === "create" && proposal.previousMemoryId) {
        throw new Error("A reported state create proposal cannot replace a previous state.");
      }
      if (replacementActions.has(proposal.action) && memory.id === proposal.previousMemoryId) {
        throw new Error("This reported state action requires a new resulting state memory.");
      }
      if (proposal.action === "add_scoped_exception") {
        const root = this.getMemory(proposal.previousMemoryId);
        const edge = root && this.findEdge({
          agentId: normalizedAgentId,
          fromMemoryId: memory.id,
          toMemoryId: root.id,
          relation: "scoped_exception_to",
        });
        if (!root || root.status !== "active"
          || root.state_scope_key !== proposal.target_scope_key
          || proposal.target_scope_key !== ROOT_STATE_SCOPE_KEY
          || proposal.proposed_scope_key === ROOT_STATE_SCOPE_KEY
          || memory.id === root.id
          || !edge) {
          throw new Error("Scoped reported-state acceptance requires an active root and its explicit scope edge.");
        }
      }
    } else if (normalizedMemoryId) {
      throw new Error("Dismissed reported state proposal cannot reference a result memory.");
    }
    const resolvedAt = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_reported_state_proposals
      SET review_state = ?, result_memory_id = ?, resolution_note = ?, resolved_by = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedMemoryId,
      clean(note),
      clean(resolvedBy) || "human",
      resolvedAt,
      resolvedAt,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Reported state proposal changed while it was being resolved.");
    }
    return this.getReportedStateProposal(normalizedAgentId, proposal.id);
  }

  dismissReportedStateProposal({
    agentId,
    proposalId,
    resolvedBy = "human",
    note = "",
  } = {}) {
    return this.resolveReportedStateProposalRecord({
      agentId,
      proposalId,
      resolution: "dismissed",
      resolvedBy,
      note,
    });
  }

  recordPreferenceStateProposal({
    id,
    agentId,
    batchId = "",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    objectLabel,
    scopeLabel = "",
    scope = {},
    representationLayer = "inferred",
    stateScopeKey = ROOT_STATE_SCOPE_KEY,
    previousMemoryId = null,
    proposedLevel,
    transition,
    proposedKind,
    title = "",
    content,
    evidenceReviewMode = "bounded",
    confidence = 0.5,
    knownAt,
    validFrom,
    policyVersion,
    previewStatus,
    metrics = {},
    rationale = "",
    provenance = "",
    proposalHash,
    evidence = [],
    metadata = {},
    createdAt = nowIso(),
  }) {
    const proposalId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedRepresentationLayer = clean(representationLayer) || "inferred";
    const normalizedStateScopeKey = clean(stateScopeKey) || ROOT_STATE_SCOPE_KEY;
    const normalizedPreviousMemoryId = clean(previousMemoryId) || null;
    const normalizedLevel = clean(proposedLevel);
    const normalizedTransition = clean(transition);
    const normalizedKind = clean(proposedKind);
    const normalizedReviewMode = clean(evidenceReviewMode) || "bounded";
    const normalizedKnownAt = clean(knownAt);
    const normalizedValidFrom = clean(validFrom);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedPreviewStatus = clean(previewStatus);
    const normalizedContent = clean(content);
    const normalizedProposalHash = clean(proposalHash);
    if (
      !proposalId || !normalizedAgentId
      || !["user", "agent", "shared", "other"].includes(normalizedSubjectRole)
      || !normalizedSubjectKey || !normalizedCanonicalKey
      || !clean(subjectLabel) || !clean(objectLabel)
      || !["reported", "inferred", "established"].includes(normalizedRepresentationLayer)
      || !isValidStateScopeKey(normalizedStateScopeKey)
      || normalizedStateScopeKey === NON_STATE_SCOPE_KEY
      || ![
        "situational_tolerance", "selection_tendency", "stable_preference",
        "direct_preference", "explicit_rejection", "no_conclusion",
      ].includes(normalizedLevel)
      || ![
        "create", "reinforce", "promote", "downgrade", "narrow_scope",
        "replace_explicit", "challenge",
      ].includes(normalizedTransition)
      || !["derived_hypothesis", "preference"].includes(normalizedKind)
      || !["bounded", "full_canonical"].includes(normalizedReviewMode)
      || !normalizedKnownAt || !validTimestamp(normalizedKnownAt)
      || !normalizedValidFrom || !validTimestamp(normalizedValidFrom)
      || !normalizedPolicyVersion || !normalizedPreviewStatus
      || !normalizedContent || !normalizedProposalHash
    ) {
      throw new Error("Preference state proposal record is incomplete.");
    }
    if (["downgrade", "narrow_scope"].includes(normalizedTransition)
      && normalizedReviewMode !== "full_canonical") {
      throw new Error("Preference downgrade and scope narrowing require a full canonical evidence review.");
    }
    const expectedRepresentationLayer = ["direct_preference", "explicit_rejection"]
      .includes(normalizedLevel) ? "reported" : "inferred";
    if (normalizedRepresentationLayer !== expectedRepresentationLayer) {
      throw new Error("Preference proposal level does not match its representation layer.");
    }
    if (normalizedPreviousMemoryId) {
      const previous = this.getMemory(normalizedPreviousMemoryId);
      if (!previous || previous.agent_id !== normalizedAgentId
        || previous.subject_role !== normalizedSubjectRole
        || previous.subject_key !== normalizedSubjectKey
        || previous.canonical_key !== normalizedCanonicalKey
        || previous.representation_layer !== normalizedRepresentationLayer
        || previous.state_family !== "preference"
        || previous.state_scope_key !== normalizedStateScopeKey) {
        throw new Error("Preference state proposal previous memory must match its exact state identity.");
      }
    }
    const normalizedEvidence = (Array.isArray(evidence) ? evidence : []).map((item) => ({
      memoryId: clean(item?.memoryId ?? item?.memory_id),
      evidenceGroupId: clean(item?.evidenceGroupId ?? item?.evidence_group_id),
      contextId: clean(item?.contextId ?? item?.context_id),
      signal: clean(item?.signal),
      direction: clean(item?.direction),
      confidence: unitInterval(item?.confidence, "preference evidence confidence"),
      sourceIds: cleanStringList(item?.sourceIds ?? item?.source_ids).sort(),
      evidenceSnapshotHash: clean(
        item?.evidenceSnapshotHash ?? item?.evidence_snapshot_hash,
      ),
      label: item?.label && typeof item.label === "object" && !Array.isArray(item.label)
        ? item.label
        : {},
    }));
    if (!normalizedEvidence.length
      || normalizedEvidence.some((item) => (
        !item.memoryId || !item.evidenceGroupId || !item.signal
        || !/^[0-9a-f]{64}$/u.test(item.evidenceSnapshotHash)
        || !["support", "opposition", "neutral"].includes(item.direction)
      ))) {
      throw new Error("Preference state proposal requires normalized evidence.");
    }
    const uniqueEvidence = new Map();
    for (const item of normalizedEvidence) {
      if (uniqueEvidence.has(item.memoryId)) {
        throw new Error("Preference state proposal cannot repeat an evidence memory.");
      }
      uniqueEvidence.set(item.memoryId, item);
      const memory = this.getMemory(item.memoryId);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.status === "deleted") {
        throw new Error("Preference evidence memory must belong to the same Agent and be available.");
      }
      const linkedSourceIds = new Set(
        this.getMemoryDetail(normalizedAgentId, item.memoryId)?.sources.map((source) => source.id) || [],
      );
      if (item.sourceIds.some((sourceId) => !linkedSourceIds.has(sourceId))) {
        throw new Error("Preference evidence source must already support its evidence memory.");
      }
    }
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_preference_state_proposals WHERE id = ?
    `).get(proposalId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("Preference state proposal id already belongs to another Agent.");
    }
    const timestamp = clean(createdAt) || nowIso();
    return this.transaction(() => {
      const insertion = this.database.prepare(`
        INSERT INTO memory_preference_state_proposals (
          id, agent_id, batch_id, subject_role, subject_key, canonical_key,
          subject_label, object_label, scope_label, scope_json,
          representation_layer, state_scope_key, previous_memory_id,
          proposed_level, transition, proposed_kind, title, content,
          evidence_review_mode, confidence, known_at, valid_from, policy_version,
          preview_status, metrics_json, rationale, provenance, proposal_hash,
          review_state, metadata_json, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'pending', ?, ?, ?
        )
        ON CONFLICT(agent_id, proposal_hash) DO NOTHING
      `).run(
        proposalId,
        normalizedAgentId,
        clean(batchId),
        normalizedSubjectRole,
        normalizedSubjectKey,
        normalizedCanonicalKey,
        clean(subjectLabel),
        clean(objectLabel),
        clean(scopeLabel),
        json(scope, {}),
        normalizedRepresentationLayer,
        normalizedStateScopeKey,
        normalizedPreviousMemoryId,
        normalizedLevel,
        normalizedTransition,
        normalizedKind,
        clean(title),
        normalizedContent,
        normalizedReviewMode,
        unitInterval(confidence, "preference proposal confidence"),
        new Date(normalizedKnownAt).toISOString(),
        new Date(normalizedValidFrom).toISOString(),
        normalizedPolicyVersion,
        normalizedPreviewStatus,
        json(metrics, {}),
        clean(rationale),
        clean(provenance),
        normalizedProposalHash,
        json(metadata, {}),
        timestamp,
        timestamp,
      );
      const stored = this.database.prepare(`
        SELECT id FROM memory_preference_state_proposals
        WHERE agent_id = ? AND proposal_hash = ?
      `).get(normalizedAgentId, normalizedProposalHash);
      if (Number(insertion.changes || 0) === 1) {
        const insertEvidence = this.database.prepare(`
          INSERT INTO memory_preference_proposal_evidence (
            proposal_id, agent_id, memory_id, evidence_group_id, context_id,
            signal, direction, confidence, source_ids_json, evidence_snapshot_hash,
            label_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of uniqueEvidence.values()) {
          insertEvidence.run(
            stored.id,
            normalizedAgentId,
            item.memoryId,
            item.evidenceGroupId,
            item.contextId,
            item.signal,
            item.direction,
            item.confidence,
            json(item.sourceIds, []),
            item.evidenceSnapshotHash,
            json(item.label, {}),
            timestamp,
          );
        }
      }
      return {
        ...this.getPreferenceStateProposal(normalizedAgentId, stored.id),
        wasInserted: Number(insertion.changes || 0) === 1,
      };
    });
  }

  getPreferenceStateProposal(agentId, proposalId) {
    const normalizedAgentId = clean(agentId);
    const row = this.database.prepare(`
      SELECT * FROM memory_preference_state_proposals WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, clean(proposalId));
    if (!row) return null;
    const evidence = this.database.prepare(`
      SELECT * FROM memory_preference_proposal_evidence
      WHERE agent_id = ? AND proposal_id = ?
      ORDER BY direction ASC, evidence_group_id ASC, memory_id ASC
    `).all(normalizedAgentId, row.id);
    return normalizePreferenceStateProposal(row, evidence);
  }

  listPreferenceStateProposals(agentId, {
    reviewStates = [],
    canonicalKey = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listPreferenceStateProposals requires agentId.");
    const states = cleanStringList(Array.isArray(reviewStates) ? reviewStates : [reviewStates]);
    if (states.some((state) => !["pending", "accepted", "dismissed"].includes(state))) {
      throw new Error("Unknown preference state proposal review state.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (clean(canonicalKey)) {
      clauses.push("canonical_key = ?");
      parameters.push(clean(canonicalKey).toLocaleLowerCase("en-US"));
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_preference_state_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...parameters, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))));
    return rows.map((row) => this.getPreferenceStateProposal(normalizedAgentId, row.id));
  }

  resolvePreferenceStateProposal({
    agentId,
    proposalId,
    resolution,
    resultMemoryId = null,
    resolvedBy = "human",
    note = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedResolution = clean(resolution);
    const proposal = this.getPreferenceStateProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("Preference state proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`Preference state proposal is already ${proposal.review_state}.`);
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown preference state proposal resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const normalizedMemoryId = clean(resultMemoryId) || null;
    if (normalizedResolution === "accepted") {
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId
        || memory.subject_role !== proposal.subject_role
        || memory.subject_key !== proposal.subject_key
        || memory.canonical_key !== proposal.canonical_key
        || memory.representation_layer !== proposal.representation_layer
        || memory.state_family !== "preference"
        || memory.state_scope_key !== proposal.state_scope_key
        || clean(memory.metadata?.preferenceStateLevel) !== proposal.proposed_level) {
        throw new Error("Accepted preference state proposal requires its exact resulting state memory.");
      }
      if (["challenge", "reinforce"].includes(proposal.transition)
        && memory.id !== proposal.previousMemoryId) {
        throw new Error("Accepted preference challenge or reinforcement must remain attached to the reviewed current state.");
      }
    } else if (normalizedMemoryId) {
      throw new Error("Dismissed preference state proposal cannot reference a result memory.");
    }
    const resolvedAt = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_preference_state_proposals
      SET review_state = ?, result_memory_id = ?, resolution_note = ?, resolved_by = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedMemoryId,
      clean(note),
      clean(resolvedBy) || "human",
      resolvedAt,
      resolvedAt,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Preference state proposal changed while it was being resolved.");
    }
    return this.getPreferenceStateProposal(normalizedAgentId, proposal.id);
  }

  recordStatePromotionProposal({
    id,
    agentId,
    stateFamily,
    subjectRole,
    subjectKey,
    canonicalKey,
    stateScopeKey = ROOT_STATE_SCOPE_KEY,
    sourceMemoryId,
    proposedKind,
    title = "",
    content,
    confidence = 0.5,
    knownAt,
    validFrom,
    policyVersion,
    sourceSnapshotHash,
    proposalHash,
    metadata = {},
    createdAt = nowIso(),
  } = {}) {
    const proposalId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedFamily = clean(stateFamily);
    const normalizedSubjectRole = clean(subjectRole);
    const normalizedSubjectKey = clean(subjectKey);
    const normalizedCanonicalKey = clean(canonicalKey).toLocaleLowerCase("en-US");
    const normalizedStateScopeKey = clean(stateScopeKey) || ROOT_STATE_SCOPE_KEY;
    const normalizedSourceMemoryId = clean(sourceMemoryId);
    const normalizedKind = clean(proposedKind);
    const normalizedContent = clean(content);
    const normalizedKnownAt = clean(knownAt);
    const normalizedValidFrom = clean(validFrom);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedSourceSnapshotHash = clean(sourceSnapshotHash);
    const normalizedProposalHash = clean(proposalHash);
    if (!proposalId || !normalizedAgentId || !MEMORY_STATE_FAMILIES.includes(normalizedFamily)
      || !SUBJECT_ROLES.includes(normalizedSubjectRole) || !normalizedSubjectKey
      || !normalizedCanonicalKey || !isValidStateScopeKey(normalizedStateScopeKey)
      || normalizedStateScopeKey === NON_STATE_SCOPE_KEY || !normalizedSourceMemoryId
      || !normalizedKind || !isMemoryKindAllowedForStateFamily(normalizedKind, normalizedFamily)
      || !normalizedContent || !validTimestamp(normalizedKnownAt)
      || !validTimestamp(normalizedValidFrom) || !normalizedPolicyVersion
      || !/^[0-9a-f]{64}$/u.test(normalizedSourceSnapshotHash)
      || !/^[0-9a-f]{64}$/u.test(normalizedProposalHash)) {
      throw new Error("State promotion proposal record is incomplete.");
    }
    const source = this.getMemory(normalizedSourceMemoryId);
    if (!source || source.agent_id !== normalizedAgentId || source.status !== "active"
      || source.subject_role !== normalizedSubjectRole || source.subject_key !== normalizedSubjectKey
      || source.canonical_key !== normalizedCanonicalKey || source.state_family !== normalizedFamily
      || source.representation_layer !== "inferred"
      || source.state_scope_key !== normalizedStateScopeKey) {
      throw new Error("State promotion source must be the exact active inferred state.");
    }
    const established = this.getCurrentCanonicalMemory({
      agentId: normalizedAgentId,
      subjectRole: normalizedSubjectRole,
      subjectKey: normalizedSubjectKey,
      canonicalKey: normalizedCanonicalKey,
      representationLayer: "established",
      stateFamily: normalizedFamily,
      stateScopeKey: normalizedStateScopeKey,
    });
    if (established) {
      throw new Error("State promotion target already has an established current state.");
    }
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_state_promotion_proposals WHERE id = ?
    `).get(proposalId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("State promotion proposal id already belongs to another Agent.");
    }
    const timestamp = new Date(createdAt).toISOString();
    const insertion = this.database.prepare(`
      INSERT INTO memory_state_promotion_proposals (
        id, agent_id, state_family, subject_role, subject_key, canonical_key,
        state_scope_key, source_memory_id, source_representation_layer,
        target_representation_layer, proposed_kind, title, content, confidence,
        known_at, valid_from, policy_version, source_snapshot_hash, proposal_hash,
        review_state, metadata_json, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, 'inferred', 'established', ?, ?, ?, ?, ?, ?, ?, ?, ?,
        'pending', ?, ?, ?
      )
      ON CONFLICT(agent_id, proposal_hash) DO NOTHING
    `).run(
      proposalId,
      normalizedAgentId,
      normalizedFamily,
      normalizedSubjectRole,
      normalizedSubjectKey,
      normalizedCanonicalKey,
      normalizedStateScopeKey,
      normalizedSourceMemoryId,
      normalizedKind,
      clean(title),
      normalizedContent,
      unitInterval(confidence, "state promotion confidence"),
      new Date(normalizedKnownAt).toISOString(),
      new Date(normalizedValidFrom).toISOString(),
      normalizedPolicyVersion,
      normalizedSourceSnapshotHash,
      normalizedProposalHash,
      canonicalJson(metadata, {}),
      timestamp,
      timestamp,
    );
    const stored = this.database.prepare(`
      SELECT id FROM memory_state_promotion_proposals
      WHERE agent_id = ? AND proposal_hash = ?
    `).get(normalizedAgentId, normalizedProposalHash);
    return {
      ...this.getStatePromotionProposal(normalizedAgentId, stored.id),
      wasInserted: Number(insertion.changes || 0) === 1,
    };
  }

  getStatePromotionProposal(agentId, proposalId) {
    return normalizeStatePromotionProposal(this.database.prepare(`
      SELECT * FROM memory_state_promotion_proposals WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(proposalId)));
  }

  listStatePromotionProposals(agentId, {
    reviewStates = [],
    stateFamily = "",
    canonicalKey = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listStatePromotionProposals requires agentId.");
    const states = cleanStringList(Array.isArray(reviewStates) ? reviewStates : [reviewStates]);
    if (states.some((state) => !["pending", "accepted", "dismissed", "revoked"].includes(state))) {
      throw new Error("Unknown state promotion proposal review state.");
    }
    const normalizedFamily = clean(stateFamily);
    if (normalizedFamily && !MEMORY_STATE_FAMILIES.includes(normalizedFamily)) {
      throw new Error("Unknown state promotion proposal family.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (normalizedFamily) {
      clauses.push("state_family = ?");
      parameters.push(normalizedFamily);
    }
    if (clean(canonicalKey)) {
      clauses.push("canonical_key = ?");
      parameters.push(clean(canonicalKey).toLocaleLowerCase("en-US"));
    }
    const rows = this.database.prepare(`
      SELECT id FROM memory_state_promotion_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(...parameters, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))));
    return rows.map((row) => this.getStatePromotionProposal(normalizedAgentId, row.id));
  }

  resolveStatePromotionProposalRecord({
    agentId,
    proposalId,
    resolution,
    resultMemoryId = null,
    resolvedBy = "human",
    note = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const proposal = this.getStatePromotionProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("State promotion proposal does not exist for this Agent.");
    if (proposal.review_state !== "pending") {
      throw new Error(`State promotion proposal is already ${proposal.review_state}.`);
    }
    const normalizedResolution = clean(resolution);
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error("Unknown state promotion proposal resolution.");
    }
    const normalizedResultMemoryId = clean(resultMemoryId) || null;
    if (normalizedResolution === "accepted") {
      const result = this.getMemory(normalizedResultMemoryId);
      if (!result || result.agent_id !== normalizedAgentId
        || result.subject_role !== proposal.subject_role
        || result.subject_key !== proposal.subject_key
        || result.canonical_key !== proposal.canonical_key
        || result.state_family !== proposal.state_family
        || result.state_scope_key !== proposal.state_scope_key
        || result.representation_layer !== "established"
        || result.status !== "active") {
        throw new Error("Accepted state promotion requires its exact established result.");
      }
    } else if (normalizedResultMemoryId) {
      throw new Error("Dismissed state promotion cannot reference a result memory.");
    }
    const timestamp = nowIso();
    const update = this.database.prepare(`
      UPDATE memory_state_promotion_proposals
      SET review_state = ?, result_memory_id = ?, resolution_note = ?, resolved_by = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedResultMemoryId,
      clean(note),
      clean(resolvedBy) || "human",
      timestamp,
      timestamp,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("State promotion proposal changed while being resolved.");
    }
    return this.getStatePromotionProposal(normalizedAgentId, proposal.id);
  }

  revokeStatePromotionProposalRecord({
    agentId,
    proposalId,
    revokedBy = "human",
    note = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const proposal = this.getStatePromotionProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error("State promotion proposal does not exist for this Agent.");
    if (proposal.review_state !== "accepted") {
      throw new Error(`Only an accepted state promotion can be revoked; it is ${proposal.review_state}.`);
    }
    const timestamp = nowIso();
    const update = this.database.prepare(`
      UPDATE memory_state_promotion_proposals
      SET review_state = 'revoked', revoked_by = ?, revocation_note = ?,
          revoked_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'accepted'
    `).run(
      clean(revokedBy) || "human",
      clean(note),
      timestamp,
      timestamp,
      normalizedAgentId,
      proposal.id,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("State promotion proposal changed while being revoked.");
    }
    return this.getStatePromotionProposal(normalizedAgentId, proposal.id);
  }

  recordConsolidationRun({
    id,
    agentId,
    policyVersion,
    triggerIds = [],
    candidateIds = [],
    candidateReasons = {},
    graphEdgeIds = [],
    inputHash,
    metadata = {},
    maxAttempts = 3,
    createdAt = nowIso(),
  }) {
    const runId = clean(id);
    const normalizedAgentId = clean(agentId);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedInputHash = clean(inputHash);
    const normalizedTriggers = cleanStringList(triggerIds).sort();
    const normalizedCandidates = cleanStringList(candidateIds).sort();
    const normalizedEdges = cleanStringList(graphEdgeIds).sort();
    if (!runId || !normalizedAgentId || !normalizedPolicyVersion
      || !normalizedInputHash || !normalizedTriggers.length) {
      throw new Error("Consolidation run record is incomplete.");
    }
    const triggerSet = new Set(normalizedTriggers);
    if (normalizedCandidates.some((id) => triggerSet.has(id))) {
      throw new Error("Consolidation candidates cannot repeat trigger memories.");
    }
    const memoryIds = [...normalizedTriggers, ...normalizedCandidates];
    if (memoryIds.length) {
      const rows = this.database.prepare(`
        SELECT id FROM memory_nodes
        WHERE agent_id = ? AND status <> 'deleted'
          AND id IN (${memoryIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...memoryIds);
      if (rows.length !== memoryIds.length) {
        throw new Error("Every consolidation memory must exist for the same Agent.");
      }
    }
    if (normalizedEdges.length) {
      const rows = this.database.prepare(`
        SELECT id FROM memory_edges
        WHERE agent_id = ? AND id IN (${normalizedEdges.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...normalizedEdges);
      if (rows.length !== normalizedEdges.length) {
        throw new Error("Every consolidation graph edge must belong to the same Agent.");
      }
    }
    const normalizedReasons = candidateReasons && typeof candidateReasons === "object"
      && !Array.isArray(candidateReasons) ? candidateReasons : {};
    if (Object.keys(normalizedReasons).some((id) => !normalizedCandidates.includes(id))) {
      throw new Error("Consolidation reasons can reference only selected candidates.");
    }
    const owner = this.database.prepare(`
      SELECT agent_id FROM memory_consolidation_runs WHERE id = ?
    `).get(runId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("Consolidation run id already belongs to another Agent.");
    }
    const timestamp = clean(createdAt) || nowIso();
    const normalizedMaxAttempts = Math.trunc(Number(maxAttempts));
    if (!Number.isInteger(normalizedMaxAttempts)
      || normalizedMaxAttempts < 1 || normalizedMaxAttempts > 20) {
      throw new Error("Consolidation maxAttempts must be an integer from 1 to 20.");
    }
    const insertion = this.database.prepare(`
      INSERT INTO memory_consolidation_runs (
        id, agent_id, policy_version, trigger_ids_json, candidate_ids_json,
        candidate_reasons_json, graph_edge_ids_json, input_hash, status,
        metadata_json, max_attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, policy_version, input_hash) DO NOTHING
    `).run(
      runId,
      normalizedAgentId,
      normalizedPolicyVersion,
      json(normalizedTriggers, []),
      json(normalizedCandidates, []),
      json(normalizedReasons, {}),
      json(normalizedEdges, []),
      normalizedInputHash,
      json(metadata, {}),
      normalizedMaxAttempts,
      timestamp,
      timestamp,
      timestamp,
    );
    const stored = this.database.prepare(`
      SELECT id FROM memory_consolidation_runs
      WHERE agent_id = ? AND policy_version = ? AND input_hash = ?
    `).get(normalizedAgentId, normalizedPolicyVersion, normalizedInputHash);
    return {
      ...this.getConsolidationRun(normalizedAgentId, stored.id),
      wasInserted: Number(insertion.changes || 0) === 1,
    };
  }

  getConsolidationRun(agentId, runId) {
    return normalizeConsolidationRun(this.database.prepare(`
      SELECT * FROM memory_consolidation_runs WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(runId)));
  }

  listConsolidationRuns(agentId, { statuses = [], limit = 100, order = "desc" } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listConsolidationRuns requires agentId.");
    const normalizedOrder = clean(order).toLowerCase();
    if (!["asc", "desc"].includes(normalizedOrder)) {
      throw new Error("Consolidation run order must be asc or desc.");
    }
    const normalizedStatuses = cleanStringList(Array.isArray(statuses) ? statuses : [statuses]);
    const allowed = new Set(["planned", "running", "completed", "no_proposals", "failed", "cancelled"]);
    if (normalizedStatuses.some((status) => !allowed.has(status))) {
      throw new Error("Unknown consolidation run status.");
    }
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    return this.database.prepare(`
      SELECT * FROM memory_consolidation_runs
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ${normalizedOrder.toUpperCase()}, id ${normalizedOrder.toUpperCase()}
      LIMIT ?
    `).all(
      ...parameters,
      Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))),
    ).map(normalizeConsolidationRun);
  }

  recoverExpiredConsolidationRuns(agentId, { now = nowIso() } = {}) {
    const normalizedAgentId = clean(agentId);
    const inspectedAt = new Date(clean(now));
    if (!normalizedAgentId || !Number.isFinite(inspectedAt.getTime())) {
      throw new Error("recoverExpiredConsolidationRuns requires agentId and a valid time.");
    }
    const timestamp = inspectedAt.toISOString();
    const exhausted = this.database.prepare(`
      SELECT * FROM memory_consolidation_runs
      WHERE agent_id = ? AND status = 'running'
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        AND attempt_count >= max_attempts
      ORDER BY created_at ASC, id ASC
    `).all(normalizedAgentId, timestamp).map(normalizeConsolidationRun);
    const update = this.database.prepare(`
      UPDATE memory_consolidation_runs
      SET status = 'failed', lease_owner = '', lease_expires_at = NULL,
          error_message = ?, failure_history_json = ?, review_state = 'pending',
          reviewed_by = '', review_note = '', reviewed_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'running'
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        AND attempt_count >= max_attempts
    `);
    let failed = 0;
    this.transaction(() => {
      for (const run of exhausted) {
        const errorMessage = clean(run.error_message)
          || "Consolidation lease expired after maximum attempts.";
        const failureHistory = [
          ...(Array.isArray(run.failureHistory) ? run.failureHistory : []),
          {
            attempt: run.attempt_count,
            failedAt: timestamp,
            error: errorMessage,
            details: {
              stage: "retrospective-consolidation",
              reason: "lease-expired-after-maximum-attempts",
              leaseOwner: clean(run.lease_owner),
              leaseExpiredAt: clean(run.lease_expires_at),
            },
            structureProposalIds: run.structureProposalIds,
            relationProposalIds: run.relationProposalIds,
          },
        ];
        const result = update.run(
          errorMessage,
          canonicalJson(failureHistory, []),
          timestamp,
          timestamp,
          normalizedAgentId,
          run.id,
          timestamp,
        );
        failed += Number(result.changes || 0);
      }
    });
    return { failed };
  }

  recoverRunningConsolidationRuns(agentId, {
    force = false,
    recoveredAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const timestamp = new Date(clean(recoveredAt));
    if (!normalizedAgentId || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Recovering consolidation runs requires Agent and valid time.");
    }
    const recoveredIso = timestamp.toISOString();
    return this.transaction(() => {
      const candidates = this.database.prepare(`
        SELECT *
        FROM memory_consolidation_runs
        WHERE agent_id = ? AND status = 'running'
          AND (? = 1 OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY created_at ASC, id ASC
      `).all(normalizedAgentId, force ? 1 : 0, recoveredIso).map(normalizeConsolidationRun);
      const requeued = [];
      const failed = [];
      for (const run of candidates) {
        const history = [
          ...(Array.isArray(run.failureHistory) ? run.failureHistory : []),
          {
            attempt: run.attempt_count,
            failedAt: recoveredIso,
            error: force
              ? "Consolidation run was interrupted by a local application restart."
              : "Consolidation lease expired before completion.",
            details: {
              stage: "retrospective-consolidation-recovery",
              reason: force ? "desktop-restart" : "lease-expired",
              leaseOwner: clean(run.lease_owner),
              leaseExpiredAt: clean(run.lease_expires_at),
            },
            structureProposalIds: run.structureProposalIds,
            relationProposalIds: run.relationProposalIds,
          },
        ];
        if (run.attempt_count < run.max_attempts) {
          const update = this.database.prepare(`
            UPDATE memory_consolidation_runs
            SET status = 'planned', available_at = ?, lease_owner = '', lease_expires_at = NULL,
                error_message = '', failure_history_json = ?, review_state = 'not-required',
                reviewed_by = '', review_note = '', reviewed_at = NULL,
                completed_at = NULL, updated_at = ?
            WHERE agent_id = ? AND id = ? AND status = 'running'
          `).run(
            recoveredIso,
            canonicalJson(history, []),
            recoveredIso,
            normalizedAgentId,
            run.id,
          );
          if (Number(update.changes || 0) === 1) {
            requeued.push(this.getConsolidationRun(normalizedAgentId, run.id));
          }
          continue;
        }
        const update = this.database.prepare(`
          UPDATE memory_consolidation_runs
          SET status = 'failed', lease_owner = '', lease_expires_at = NULL,
              error_message = ?, failure_history_json = ?, review_state = 'pending',
              reviewed_by = '', review_note = '', reviewed_at = NULL,
              completed_at = ?, updated_at = ?
          WHERE agent_id = ? AND id = ? AND status = 'running'
        `).run(
          force
            ? "Consolidation run was interrupted by a local application restart after its final attempt."
            : "Consolidation lease expired after maximum attempts.",
          canonicalJson(history, []),
          recoveredIso,
          recoveredIso,
          normalizedAgentId,
          run.id,
        );
        if (Number(update.changes || 0) === 1) {
          failed.push(this.getConsolidationRun(normalizedAgentId, run.id));
        }
      }
      return { requeued: requeued.length, failed: failed.length, runs: [...requeued, ...failed] };
    });
  }

  listClaimableConsolidationRuns(agentId, { now = nowIso(), limit = 100 } = {}) {
    const normalizedAgentId = clean(agentId);
    const inspectedAt = new Date(clean(now));
    if (!normalizedAgentId || !Number.isFinite(inspectedAt.getTime())) {
      throw new Error("listClaimableConsolidationRuns requires agentId and a valid time.");
    }
    const timestamp = inspectedAt.toISOString();
    this.recoverExpiredConsolidationRuns(normalizedAgentId, { now: timestamp });
    const sourceView = executionEventSourceView(this, normalizedAgentId);
    const sourceFilter = sourceView ? `AND NOT EXISTS (
      SELECT 1 FROM json_each(trigger_ids_json) AS member
      WHERE member.value NOT IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (SELECT 1 FROM json_each(candidate_ids_json) AS member
      WHERE member.value NOT IN (SELECT value FROM json_each(?)))` : '';
    return this.database.prepare(`
      SELECT * FROM memory_consolidation_runs
      WHERE agent_id = ? AND attempt_count < max_attempts AND (
        (status = 'planned' AND available_at <= ?)
        OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
      ${sourceFilter}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(
      normalizedAgentId,
      timestamp,
      timestamp,
      ...(sourceView ? [JSON.stringify([...sourceView.memoryIds]), JSON.stringify([...sourceView.memoryIds])] : []),
      Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))),
    ).map(normalizeConsolidationRun);
  }

  claimConsolidationRun({
    agentId,
    runId,
    workerId,
    leaseSeconds = 900,
    now = nowIso(),
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedWorkerId = clean(workerId);
    const leaseDuration = Math.trunc(Number(leaseSeconds));
    const claimedAt = new Date(clean(now));
    if (!normalizedWorkerId) throw new Error("Consolidation claim requires workerId.");
    if (!Number.isInteger(leaseDuration) || leaseDuration < 1 || leaseDuration > 86400) {
      throw new Error("Consolidation leaseSeconds must be an integer from 1 to 86400.");
    }
    if (!Number.isFinite(claimedAt.getTime())) {
      throw new Error("Consolidation claim requires a valid time.");
    }
    const run = this.getConsolidationRun(normalizedAgentId, runId);
    if (!run) throw new Error("Consolidation run does not exist for this Agent.");
    const sourceView = executionEventSourceView(this, normalizedAgentId);
    if (sourceView && [...run.triggerIds, ...run.candidateIds].some(id => !sourceView.memoryIds.has(id))) {
      throw Object.assign(new Error('Consolidation sources are outside this fixed scope.'), { code: 'EVENT_SOURCE_TASK_DEFERRED' });
    }
    const timestamp = claimedAt.toISOString();
    const leaseExpiresAt = new Date(claimedAt.getTime() + leaseDuration * 1000).toISOString();
    const result = this.database.prepare(`
      UPDATE memory_consolidation_runs
      SET status = 'running', attempt_count = attempt_count + 1,
          lease_owner = ?, lease_expires_at = ?, error_message = '', updated_at = ?
      WHERE agent_id = ? AND id = ? AND attempt_count < max_attempts AND (
        (status = 'planned' AND available_at <= ?)
        OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
      )
    `).run(
      normalizedWorkerId,
      leaseExpiresAt,
      timestamp,
      normalizedAgentId,
      run.id,
      timestamp,
      timestamp,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error(`Consolidation run is not claimable from ${run.status}.`);
    }
    return this.getConsolidationRun(normalizedAgentId, run.id);
  }

  checkpointConsolidationRun({ agentId, runId, workerId, progress, structureProposalIds = [], relationProposalIds = [] }) {
    const run = this.getConsolidationRun(agentId, runId);
    const update = this.database.prepare(`
      UPDATE memory_consolidation_runs SET metadata_json = ?, structure_proposal_ids_json = ?,
        relation_proposal_ids_json = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'running' AND lease_owner = ? AND lease_expires_at > ?
    `).run(canonicalJson({ ...run?.metadata, organizationProgress: progress }, {}),
      json(cleanStringList(structureProposalIds), []), json(cleanStringList(relationProposalIds), []), nowIso(),
      clean(agentId), clean(runId), clean(workerId), nowIso());
    if (Number(update.changes || 0) !== 1) throw new Error("Consolidation checkpoint requires the current lease owner.");
    return this.getConsolidationRun(agentId, runId);
  }

  failConsolidationRun({
    agentId,
    runId,
    workerId,
    errorMessage,
    errorDetails = {},
    structureProposalIds = [],
    relationProposalIds = [],
    retry = true,
    retryDelaySeconds = 0,
    now = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedWorkerId = clean(workerId);
    const failedAt = new Date(clean(now));
    if (!normalizedAgentId || !clean(runId) || !normalizedWorkerId
      || !Number.isFinite(failedAt.getTime())) {
      throw new Error("Failing a consolidation run requires run, worker, Agent, and valid time.");
    }
    const run = this.getConsolidationRun(normalizedAgentId, runId);
    if (!run || run.status !== "running" || run.lease_owner !== normalizedWorkerId) {
      throw new Error("Consolidation run changed or its lease is owned by another worker.");
    }
    const failedIso = failedAt.toISOString();
    if (!clean(run.lease_expires_at) || run.lease_expires_at <= failedIso) {
      throw new Error("Consolidation run lease is no longer owned by this worker.");
    }
    const structureIds = cleanStringList([
      ...run.structureProposalIds,
      ...structureProposalIds,
    ]);
    const relationIds = cleanStringList([
      ...run.relationProposalIds,
      ...relationProposalIds,
    ]);
    const shouldRetry = Boolean(retry) && run.attempt_count < run.max_attempts;
    const availableAt = new Date(
      failedAt.getTime() + Math.max(0, Math.trunc(Number(retryDelaySeconds) || 0)) * 1000,
    ).toISOString();
    const normalizedDetails = errorDetails && typeof errorDetails === "object"
      && !Array.isArray(errorDetails)
      ? errorDetails
      : {};
    const history = [
      ...(Array.isArray(run.failureHistory) ? run.failureHistory : []),
      {
        attempt: run.attempt_count,
        failedAt: failedIso,
        error: clean(errorMessage),
        details: normalizedDetails,
        structureProposalIds: structureIds,
        relationProposalIds: relationIds,
      },
    ];
    const update = this.database.prepare(`
      UPDATE memory_consolidation_runs
      SET status = ?, structure_proposal_ids_json = ?, relation_proposal_ids_json = ?,
          error_message = ?, failure_history_json = ?, available_at = ?,
          lease_owner = '', lease_expires_at = NULL,
          review_state = CASE WHEN ? = 1 THEN 'pending' ELSE 'not-required' END,
          reviewed_by = '', review_note = '', reviewed_at = NULL,
          completed_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'running'
        AND lease_owner = ? AND lease_expires_at > ?
    `).run(
      shouldRetry ? "planned" : "failed",
      json(structureIds, []),
      json(relationIds, []),
      clean(errorMessage),
      canonicalJson(history, []),
      shouldRetry ? availableAt : run.available_at,
      shouldRetry ? 0 : 1,
      shouldRetry ? null : failedIso,
      failedIso,
      normalizedAgentId,
      run.id,
      normalizedWorkerId,
      failedIso,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("Consolidation run changed while its failure was being recorded.");
    }
    return this.getConsolidationRun(normalizedAgentId, run.id);
  }

  finishConsolidationRun({
    agentId,
    runId,
    status,
    structureProposalIds = [],
    relationProposalIds = [],
    errorMessage = "",
    workerId,
    now = nowIso(),
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedStatus = clean(status);
    if (!["completed", "no_proposals", "cancelled"].includes(normalizedStatus)) {
      throw new Error("A consolidation run failure must use failConsolidationRun so retries and review are preserved.");
    }
    const run = this.getConsolidationRun(normalizedAgentId, runId);
    if (!run) throw new Error("Consolidation run does not exist for this Agent.");
    if (run.status !== "running") {
      throw new Error(`Consolidation run is already ${run.status}.`);
    }
    const normalizedWorkerId = clean(workerId);
    const finishedAt = new Date(clean(now));
    if (!normalizedWorkerId || !Number.isFinite(finishedAt.getTime())) {
      throw new Error("Finishing a consolidation run requires workerId and a valid time.");
    }
    const timestamp = finishedAt.toISOString();
    if (run.lease_owner !== normalizedWorkerId
      || !clean(run.lease_expires_at) || run.lease_expires_at <= timestamp) {
      throw new Error("Consolidation run lease is no longer owned by this worker.");
    }
    const structureIds = cleanStringList([...run.structureProposalIds, ...structureProposalIds]);
    const relationIds = cleanStringList([...run.relationProposalIds, ...relationProposalIds]);
    if (normalizedStatus === "completed" && !structureIds.length && !relationIds.length) {
      throw new Error("Completed consolidation run requires at least one proposal.");
    }
    if (["no_proposals", "cancelled"].includes(normalizedStatus)
      && (structureIds.length || relationIds.length)) {
      throw new Error(`${normalizedStatus} consolidation run cannot reference proposals.`);
    }
    if (structureIds.length) {
      const rows = this.database.prepare(`
        SELECT id FROM memory_structure_proposals
        WHERE agent_id = ? AND id IN (${structureIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...structureIds);
      if (rows.length !== structureIds.length) {
        throw new Error("Consolidation structure proposals must belong to the same Agent.");
      }
    }
    if (relationIds.length) {
      const rows = this.database.prepare(`
        SELECT id FROM memory_relation_proposals
        WHERE agent_id = ? AND id IN (${relationIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...relationIds);
      if (rows.length !== relationIds.length) {
        throw new Error("Consolidation relation proposals must belong to the same Agent.");
      }
    }
    const result = this.database.prepare(`
      UPDATE memory_consolidation_runs
      SET status = ?, structure_proposal_ids_json = ?, relation_proposal_ids_json = ?,
          error_message = ?, completed_at = ?, lease_owner = '', lease_expires_at = NULL,
          updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'running'
        AND lease_owner = ? AND lease_expires_at > ?
    `).run(
      normalizedStatus,
      json(structureIds, []),
      json(relationIds, []),
      clean(errorMessage),
      timestamp,
      timestamp,
      normalizedAgentId,
      run.id,
      normalizedWorkerId,
      timestamp,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Consolidation run changed while it was being finished.");
    }
    return this.getConsolidationRun(normalizedAgentId, run.id);
  }

  reviewConsolidationFailure({
    agentId,
    runId,
    action,
    reviewedBy = "human",
    note = "",
    reviewedAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedAction = clean(action).toLowerCase();
    const timestamp = new Date(clean(reviewedAt));
    if (!normalizedAgentId || !clean(runId) || !["accept", "dismiss"].includes(normalizedAction)
      || !Number.isFinite(timestamp.getTime())) {
      throw new Error("Reviewing a consolidation failure requires Agent, run, action, and valid time.");
    }
    const run = this.getConsolidationRun(normalizedAgentId, runId);
    if (!run || run.status !== "failed" || run.review_state !== "pending") {
      throw new Error("Consolidation failure is not awaiting human review.");
    }
    const hasPartialProposals = run.structureProposalIds.length > 0
      || run.relationProposalIds.length > 0;
    if (normalizedAction === "accept" && !hasPartialProposals) {
      throw new Error("Consolidation failure has no completed proposal to accept.");
    }
    const reviewedIso = timestamp.toISOString();
    const update = this.database.prepare(`
      UPDATE memory_consolidation_runs
      SET status = ?, review_state = ?, reviewed_by = ?, review_note = ?, reviewed_at = ?,
          completed_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'failed' AND review_state = 'pending'
    `).run(
      normalizedAction === "accept" ? "completed" : "cancelled",
      normalizedAction === "accept" ? "accepted" : "dismissed",
      clean(reviewedBy) || "human",
      clean(note),
      reviewedIso,
      reviewedIso,
      reviewedIso,
      normalizedAgentId,
      run.id,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("Consolidation failure changed before the review decision was stored.");
    }
    return this.getConsolidationRun(normalizedAgentId, run.id);
  }

  upsertMemoryRole({
    memoryId,
    agentId,
    role,
    actorRole,
    actorKey = "",
    isPrimary = false,
    confidence = 1,
    provenance = "",
    metadata = {},
  }) {
    const normalizedMemoryId = clean(memoryId);
    const normalizedAgentId = clean(agentId);
    const normalizedRole = clean(role);
    const normalizedActorRole = clean(actorRole);
    const normalizedActorKey = clean(actorKey);
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Memory role requires an existing memory for the same Agent.");
    }
    if (!MEMORY_ACTOR_ROLES.includes(normalizedRole)) {
      throw new Error(`Unknown memory actor role: ${normalizedRole || "(empty)"}.`);
    }
    if (!SUBJECT_ROLES.includes(normalizedActorRole)) {
      throw new Error(`Unknown actor identity role: ${normalizedActorRole || "(empty)"}.`);
    }
    if (!["world", "unknown"].includes(normalizedActorRole) && !normalizedActorKey) {
      throw new Error("Memory actor role requires actorKey.");
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_actor_roles (
        memory_id, agent_id, role, actor_role, actor_key,
        is_primary, confidence, provenance, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, role, actor_role, actor_key) DO UPDATE SET
        is_primary = excluded.is_primary,
        confidence = excluded.confidence,
        provenance = excluded.provenance,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      normalizedMemoryId,
      normalizedAgentId,
      normalizedRole,
      normalizedActorRole,
      normalizedActorKey,
      isPrimary ? 1 : 0,
      bounded(confidence, 1),
      clean(provenance),
      json(metadata, {}),
      timestamp,
      timestamp,
    );
    return normalizeMemoryRole(this.database.prepare(`
      SELECT * FROM memory_actor_roles
      WHERE memory_id = ? AND role = ? AND actor_role = ? AND actor_key = ?
    `).get(normalizedMemoryId, normalizedRole, normalizedActorRole, normalizedActorKey));
  }

  syncPrimarySubjectRole({ memoryId, agentId, actorRole, actorKey = "" }) {
    this.database.prepare(`
      DELETE FROM memory_actor_roles
      WHERE memory_id = ? AND role = 'subject' AND is_primary = 1
    `).run(memoryId);
    if (!SUBJECT_ROLES.includes(actorRole) || actorRole === "unknown") return null;
    return this.upsertMemoryRole({
      memoryId,
      agentId,
      role: "subject",
      actorRole,
      actorKey,
      isPrimary: true,
      confidence: 1,
      provenance: "memory-node-subject",
    });
  }

  listMemoryRoles(memoryId) {
    return this.database.prepare(`
      SELECT * FROM memory_actor_roles
      WHERE memory_id = ?
      ORDER BY is_primary DESC, role ASC, actor_role ASC, actor_key ASC
    `).all(memoryId).map(normalizeMemoryRole);
  }

  deleteMemoryRoles({
    agentId,
    memoryId,
    role = "",
    actorRole = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    if (!normalizedAgentId || !normalizedMemoryId) {
      throw new Error("Deleting memory roles requires agentId and memoryId.");
    }
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Memory roles can only be deleted from the same Agent.");
    }
    const clauses = ["agent_id = ?", "memory_id = ?"];
    const parameters = [normalizedAgentId, normalizedMemoryId];
    if (clean(role)) {
      clauses.push("role = ?");
      parameters.push(clean(role));
    }
    if (clean(actorRole)) {
      clauses.push("actor_role = ?");
      parameters.push(clean(actorRole));
    }
    return Number(this.database.prepare(`
      DELETE FROM memory_actor_roles WHERE ${clauses.join(" AND ")}
    `).run(...parameters).changes || 0);
  }

  recordIngestionDecision({
    id = "",
    agentId,
    batchId,
    candidateIndex,
    decision,
    resultStatus,
    reasonCodes = [],
    candidate = {},
    sourceRefs = [],
    sourceIds = [],
    knownAt = null,
    memoryId = null,
    provisionalMemoryId = null,
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedBatchId = clean(batchId);
    const normalizedDecision = clean(decision);
    const normalizedResultStatus = clean(resultStatus);
    const index = Number(candidateIndex);
    if (!normalizedAgentId || !normalizedBatchId || !Number.isInteger(index) || index < 0) {
      throw new Error("Ingestion decision requires agentId, batchId, and candidateIndex.");
    }
    if (!["store", "review", "reject"].includes(normalizedDecision)) {
      throw new Error(`Unknown ingestion decision: ${normalizedDecision || "(empty)"}.`);
    }
    if (!normalizedResultStatus) throw new Error("Ingestion decision requires resultStatus.");
    const normalizedMemoryId = clean(memoryId) || null;
    if (normalizedMemoryId) {
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId) {
        throw new Error("Ingestion decision memory must belong to the same Agent.");
      }
    }
    const normalizedProvisionalMemoryId = clean(provisionalMemoryId) || null;
    if (normalizedProvisionalMemoryId) {
      const provisional = this.getMemory(normalizedProvisionalMemoryId);
      if (!provisional
        || provisional.agent_id !== normalizedAgentId
        || provisional.layer !== "provisional") {
        throw new Error("Ingestion decision provisional memory must belong to the same Agent and use the provisional layer.");
      }
      if (normalizedDecision !== "review") {
        throw new Error("Only review decisions can link provisional memory.");
      }
    }
    const decisionId = clean(id) || stableId(
      "ingest",
      normalizedAgentId,
      normalizedBatchId,
      index,
    );
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_ingestion_decisions (
        id, agent_id, batch_id, candidate_index, decision,
        result_status, review_state, reason_codes_json,
        candidate_json, source_refs_json, source_ids_json,
        known_at, memory_id, provisional_memory_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, batch_id, candidate_index) DO NOTHING
    `).run(
      decisionId,
      normalizedAgentId,
      normalizedBatchId,
      index,
      normalizedDecision,
      normalizedResultStatus,
      normalizedDecision === "review" ? "pending" : "not_applicable",
      json(Array.isArray(reasonCodes) ? reasonCodes.map(clean).filter(Boolean) : [], []),
      json(candidate && typeof candidate === "object" ? candidate : {}, {}),
      json(Array.isArray(sourceRefs) ? sourceRefs.map(clean).filter(Boolean) : [], []),
      json(Array.isArray(sourceIds) ? sourceIds.map(clean).filter(Boolean) : [], []),
      clean(knownAt) || null,
      normalizedMemoryId,
      normalizedProvisionalMemoryId,
      timestamp,
      timestamp,
    );
    return normalizeIngestionDecision(this.database.prepare(`
      SELECT * FROM memory_ingestion_decisions
      WHERE agent_id = ? AND batch_id = ? AND candidate_index = ?
    `).get(normalizedAgentId, normalizedBatchId, index));
  }

  listIngestionDecisions(agentId, {
    batchId = "",
    reviewState = "",
    limit = 100,
  } = {}) {
    const clauses = ["agent_id = ?"];
    const parameters = [clean(agentId)];
    if (!parameters[0]) throw new Error("listIngestionDecisions requires agentId.");
    if (clean(batchId)) {
      clauses.push("batch_id = ?");
      parameters.push(clean(batchId));
    }
    if (clean(reviewState)) {
      clauses.push("review_state = ?");
      parameters.push(clean(reviewState));
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.database.prepare(`
      SELECT * FROM memory_ingestion_decisions
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, candidate_index ASC
      LIMIT ?
    `).all(...parameters, maximum).map(normalizeIngestionDecision);
  }

  getIngestionDecision(agentId, decisionId) {
    return normalizeIngestionDecision(this.database.prepare(`
      SELECT * FROM memory_ingestion_decisions
      WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(decisionId)));
  }

  getIngestionDecisionByBatchCandidate(agentId, batchId, candidateIndex) {
    const normalizedAgentId = clean(agentId);
    const normalizedBatchId = clean(batchId);
    const index = Number(candidateIndex);
    if (!normalizedAgentId || !normalizedBatchId || !Number.isInteger(index) || index < 0) {
      throw new Error("Reading an ingestion decision requires agentId, batchId, and candidateIndex.");
    }
    return normalizeIngestionDecision(this.database.prepare(`
      SELECT * FROM memory_ingestion_decisions
      WHERE agent_id = ? AND batch_id = ? AND candidate_index = ?
    `).get(normalizedAgentId, normalizedBatchId, index));
  }

  deferIngestionDecisionForReview({
    agentId,
    decisionId,
    reasonCodes = [],
    provisionalMemoryId,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedDecisionId = clean(decisionId);
    const normalizedProvisionalMemoryId = clean(provisionalMemoryId);
    if (!normalizedAgentId || !normalizedDecisionId || !normalizedProvisionalMemoryId) {
      throw new Error("Deferring an ingestion decision requires agentId, decisionId, and provisionalMemoryId.");
    }
    const existing = this.getIngestionDecision(normalizedAgentId, normalizedDecisionId);
    if (!existing) throw new Error("Ingestion decision does not exist for this Agent.");
    if (!["not_applicable", "pending"].includes(existing.review_state)) {
      throw new Error(`Ingestion decision is already ${existing.review_state}.`);
    }
    const provisional = this.getMemory(normalizedProvisionalMemoryId);
    if (!provisional
      || provisional.agent_id !== normalizedAgentId
      || provisional.layer !== "provisional") {
      throw new Error("Deferred review memory must belong to the same Agent and use the provisional layer.");
    }
    const normalizedReasons = Array.isArray(reasonCodes)
      ? reasonCodes.map(clean).filter(Boolean)
      : [];
    this.database.prepare(`
      UPDATE memory_ingestion_decisions
      SET decision = 'review',
          result_status = 'review',
          review_state = 'pending',
          reason_codes_json = ?,
          provisional_memory_id = ?,
          updated_at = ?
      WHERE agent_id = ? AND id = ?
    `).run(
      json(normalizedReasons, []),
      normalizedProvisionalMemoryId,
      nowIso(),
      normalizedAgentId,
      normalizedDecisionId,
    );
    return this.getIngestionDecision(normalizedAgentId, normalizedDecisionId);
  }

  listPendingProvisionalMemories(agentId, { limit = 500 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) {
      throw new Error("listPendingProvisionalMemories requires agentId.");
    }
    const maximum = Math.min(5_000, Math.max(1, Math.trunc(Number(limit) || 500)));
    return this.database.prepare(`
      SELECT memory.*,
             decision.id AS provisional_decision_id,
             decision.reason_codes_json AS provisional_reason_codes_json,
             decision.created_at AS provisional_created_at
      FROM memory_ingestion_decisions AS decision
      JOIN memory_nodes AS memory
        ON memory.id = decision.provisional_memory_id
       AND memory.agent_id = decision.agent_id
      WHERE decision.agent_id = ?
        AND decision.decision = 'review'
        AND decision.review_state = 'pending'
        AND memory.layer = 'provisional'
        AND memory.status <> 'deleted'
      UNION ALL
      SELECT memory.*, proposal.id AS provisional_decision_id,
             '[]' AS provisional_reason_codes_json, proposal.created_at AS provisional_created_at
      FROM memory_reported_state_proposals proposal
      JOIN memory_nodes memory ON memory.agent_id = proposal.agent_id
        AND json_extract(memory.metadata_json, '$.reportedStateProposalId') = proposal.id
      WHERE proposal.agent_id = ? AND proposal.review_state = 'pending'
        AND memory.layer = 'provisional' AND memory.status <> 'deleted'
      UNION ALL
      SELECT memory.*, proposal.id AS provisional_decision_id,
             '[]' AS provisional_reason_codes_json, proposal.created_at AS provisional_created_at
      FROM memory_preference_state_proposals proposal
      JOIN memory_nodes memory ON memory.agent_id = proposal.agent_id
        AND json_extract(memory.metadata_json, '$.preferenceProposalId') = proposal.id
      WHERE proposal.agent_id = ? AND proposal.review_state = 'pending'
        AND memory.layer = 'provisional' AND memory.status <> 'deleted'
      ORDER BY provisional_created_at DESC, provisional_decision_id ASC
      LIMIT ?
    `).all(normalizedAgentId, normalizedAgentId, normalizedAgentId, maximum).map((row) => ({
      ...normalizeNode(row),
      provisionalDecisionId: clean(row.provisional_decision_id),
      provisionalReasonCodes: parseJson(row.provisional_reason_codes_json, []),
      provisionalCreatedAt: clean(row.provisional_created_at),
    }));
  }

  resolveIngestionDecision({
    agentId,
    decisionId,
    resolution,
    memoryId = null,
    resolvedCandidate = {},
    note = "",
    resolvedBy = "human",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedDecisionId = clean(decisionId);
    const normalizedResolution = clean(resolution);
    if (!normalizedAgentId || !normalizedDecisionId) {
      throw new Error("Resolving an ingestion decision requires agentId and decisionId.");
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error(`Unknown ingestion resolution: ${normalizedResolution || "(empty)"}.`);
    }
    const existing = this.getIngestionDecision(normalizedAgentId, normalizedDecisionId);
    if (!existing) throw new Error("Ingestion decision does not exist for this Agent.");
    if (existing.review_state !== "pending") {
      throw new Error(`Ingestion decision is already ${existing.review_state}.`);
    }
    const normalizedMemoryId = clean(memoryId) || null;
    if (normalizedResolution === "accepted") {
      if (!normalizedMemoryId) throw new Error("Accepted ingestion decision requires memoryId.");
      const memory = this.getMemory(normalizedMemoryId);
      if (!memory || memory.agent_id !== normalizedAgentId) {
        throw new Error("Accepted memory must belong to the same Agent.");
      }
    } else if (normalizedMemoryId) {
      throw new Error("Dismissed ingestion decision cannot link a memory.");
    }
    const timestamp = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_ingestion_decisions
      SET review_state = ?, memory_id = ?, resolved_candidate_json = ?,
          resolution_note = ?, resolved_by = ?, resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      normalizedMemoryId,
      json(resolvedCandidate && typeof resolvedCandidate === "object" ? resolvedCandidate : {}, {}),
      clean(note),
      clean(resolvedBy) || "human",
      timestamp,
      timestamp,
      normalizedAgentId,
      normalizedDecisionId,
    );
    if (Number(result.changes) !== 1) {
      throw new Error("Ingestion decision changed before it could be resolved.");
    }
    return this.getIngestionDecision(normalizedAgentId, normalizedDecisionId);
  }

  recordSubjectAttributionProposal({
    id = "",
    agentId,
    memoryId,
    proposedSubjectRole,
    proposedSubjectKey = "",
    actorRoles = [],
    allowedActors = [],
    sourceIds = [],
    sourceSnapshotHash,
    proposalHash = "",
    policyVersion,
    confidence,
    rationale,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedSubjectRole = clean(proposedSubjectRole);
    const normalizedSubjectKey = clean(proposedSubjectKey);
    const normalizedSourceIds = cleanStringList(sourceIds);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedRationale = clean(rationale);
    const normalizedSnapshotHash = clean(sourceSnapshotHash);
    if (!normalizedAgentId || !normalizedMemoryId) {
      throw new Error("Subject attribution proposal requires agentId and memoryId.");
    }
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Subject attribution target must exist for the same Agent.");
    }
    if (!["user", "agent", "shared", "other", "world"].includes(normalizedSubjectRole)) {
      throw new Error("Subject attribution proposal requires a concrete subject role.");
    }
    if (normalizedSubjectRole !== "world" && !normalizedSubjectKey) {
      throw new Error("Subject attribution proposal requires proposedSubjectKey.");
    }
    if (!normalizedSourceIds.length || normalizedSnapshotHash.length !== 64) {
      throw new Error("Subject attribution proposal requires an evidence snapshot.");
    }
    if (!normalizedPolicyVersion || !normalizedRationale) {
      throw new Error("Subject attribution proposal requires policyVersion and rationale.");
    }
    const evidenceRows = this.database.prepare(`
      SELECT source.id
      FROM memory_sources AS link
      JOIN source_records AS source ON source.id = link.source_id
      WHERE link.memory_id = ? AND source.agent_id = ?
    `).all(normalizedMemoryId, normalizedAgentId);
    const linkedSources = new Set(evidenceRows.map((row) => row.id));
    if (normalizedSourceIds.some((sourceId) => !linkedSources.has(sourceId))) {
      throw new Error("Subject attribution evidence must already be linked to the target memory.");
    }
    const normalizedRoles = Array.isArray(actorRoles) ? actorRoles : [];
    const normalizedAllowedActors = Array.isArray(allowedActors) ? allowedActors : [];
    const normalizedProposalHash = clean(proposalHash) || canonicalHash({
      agentId: normalizedAgentId,
      memoryId: normalizedMemoryId,
      proposedSubjectRole: normalizedSubjectRole,
      proposedSubjectKey: normalizedSubjectKey,
      actorRoles: normalizedRoles,
      allowedActors: normalizedAllowedActors,
      sourceIds: normalizedSourceIds,
      sourceSnapshotHash: normalizedSnapshotHash,
      policyVersion: normalizedPolicyVersion,
    });
    if (normalizedProposalHash.length !== 64) {
      throw new Error("Subject attribution proposalHash must be a SHA-256 hash.");
    }
    const proposalId = clean(id) || `subject-attribution-${randomUUID()}`;
    const timestamp = nowIso();
    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_subject_attribution_proposals (
          id, memory_id, agent_id, proposed_subject_role, proposed_subject_key,
          actor_roles_json, allowed_actors_json, source_snapshot_hash,
          proposal_hash, policy_version, confidence, rationale,
          review_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
        ON CONFLICT(agent_id, proposal_hash) DO NOTHING
      `).run(
        proposalId,
        normalizedMemoryId,
        normalizedAgentId,
        normalizedSubjectRole,
        normalizedSubjectKey,
        canonicalJson(normalizedRoles, []),
        canonicalJson(normalizedAllowedActors, []),
        normalizedSnapshotHash,
        normalizedProposalHash,
        normalizedPolicyVersion,
        unitInterval(confidence, "Subject attribution confidence"),
        normalizedRationale,
        timestamp,
        timestamp,
      );
      const stored = this.database.prepare(`
        SELECT id FROM memory_subject_attribution_proposals
        WHERE agent_id = ? AND proposal_hash = ?
      `).get(normalizedAgentId, normalizedProposalHash);
      const insertEvidence = this.database.prepare(`
        INSERT OR IGNORE INTO memory_subject_attribution_proposal_evidence (
          proposal_id, agent_id, source_id, ordinal
        ) VALUES (?, ?, ?, ?)
      `);
      normalizedSourceIds.forEach((sourceId, ordinal) => {
        insertEvidence.run(stored.id, normalizedAgentId, sourceId, ordinal);
      });
    });
    return this.database.prepare(`
      SELECT id FROM memory_subject_attribution_proposals
      WHERE agent_id = ? AND proposal_hash = ?
    `).get(normalizedAgentId, normalizedProposalHash)?.id;
  }

  getSubjectAttributionProposal(agentId, proposalId) {
    const normalizedAgentId = clean(agentId);
    const normalizedProposalId = clean(proposalId);
    const row = this.database.prepare(`
      SELECT * FROM memory_subject_attribution_proposals
      WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedProposalId);
    if (!row) return null;
    const sourceIds = this.database.prepare(`
      SELECT source_id FROM memory_subject_attribution_proposal_evidence
      WHERE agent_id = ? AND proposal_id = ?
      ORDER BY ordinal ASC
    `).all(normalizedAgentId, normalizedProposalId).map((item) => item.source_id);
    return normalizeSubjectAttributionProposal(row, sourceIds);
  }

  listSubjectAttributionProposals(agentId, {
    reviewStates = [],
    memoryId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listSubjectAttributionProposals requires agentId.");
    const states = cleanStringList(reviewStates);
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (states.length) {
      clauses.push(`review_state IN (${states.map(() => "?").join(", ")})`);
      parameters.push(...states);
    }
    if (clean(memoryId)) {
      clauses.push("memory_id = ?");
      parameters.push(clean(memoryId));
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.database.prepare(`
      SELECT id FROM memory_subject_attribution_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(...parameters, maximum).map((row) => (
      this.getSubjectAttributionProposal(normalizedAgentId, row.id)
    ));
  }

  resolveSubjectAttributionProposalRecord({
    agentId,
    proposalId,
    resolution,
    resolvedBy = "human",
    note = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedProposalId = clean(proposalId);
    const normalizedResolution = clean(resolution);
    if (!normalizedAgentId || !normalizedProposalId) {
      throw new Error("Resolving subject attribution requires agentId and proposalId.");
    }
    if (!["accepted", "dismissed"].includes(normalizedResolution)) {
      throw new Error("Subject attribution resolution must be accepted or dismissed.");
    }
    const timestamp = nowIso();
    const result = this.database.prepare(`
      UPDATE memory_subject_attribution_proposals
      SET review_state = ?, resolved_by = ?, resolution_note = ?,
          resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending'
    `).run(
      normalizedResolution,
      clean(resolvedBy) || "human",
      clean(note),
      timestamp,
      timestamp,
      normalizedAgentId,
      normalizedProposalId,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Subject attribution proposal changed before it could be resolved.");
    }
    return this.getSubjectAttributionProposal(normalizedAgentId, normalizedProposalId);
  }

  recordRetrievalTrace({
    id = "",
    agentId,
    queryText = "",
    recallIntent = "",
    chainMode = "",
    resultStatus,
    retrievalMode = "",
    seedIds = [],
    selectedIds = [],
    paths = [],
    matchedEntityIds = [],
    contextChars = 0,
    candidateCount = 0,
    vectorStatus = "",
    metadata = {},
    createdAt = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedStatus = clean(resultStatus);
    if (!normalizedAgentId || !normalizedStatus) {
      throw new Error("Retrieval trace requires agentId and resultStatus.");
    }
    const normalizedQuery = clean(queryText);
    const traceId = clean(id) || `trace-${randomUUID()}`;
    const timestamp = clean(createdAt) || nowIso();
    this.database.prepare(`
      INSERT INTO memory_retrieval_traces (
        id, agent_id, query_text, query_hash, recall_intent, chain_mode,
        result_status, retrieval_mode, seed_ids_json, selected_ids_json,
        paths_json, matched_entity_ids_json, context_chars, candidate_count,
        vector_status, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      traceId,
      normalizedAgentId,
      normalizedQuery,
      createHash("sha256").update(normalizedQuery).digest("hex"),
      clean(recallIntent),
      clean(chainMode),
      normalizedStatus,
      clean(retrievalMode),
      json(cleanStringList(seedIds), []),
      json(cleanStringList(selectedIds), []),
      json(Array.isArray(paths) ? paths : [], []),
      json(cleanStringList(matchedEntityIds), []),
      Math.max(0, Math.trunc(Number(contextChars) || 0)),
      Math.max(0, Math.trunc(Number(candidateCount) || 0)),
      clean(vectorStatus),
      json(metadata && typeof metadata === "object" ? metadata : {}, {}),
      timestamp,
    );
    return this.getRetrievalTrace(normalizedAgentId, traceId);
  }

  getRetrievalTrace(agentId, traceId) {
    return normalizeRetrievalTrace(this.database.prepare(`
      SELECT * FROM memory_retrieval_traces
      WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(traceId)));
  }

  listRetrievalTraces(agentId, {
    resultStatus = "",
    limit = 100,
    offset = 0,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRetrievalTraces requires agentId.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (clean(resultStatus)) {
      clauses.push("result_status = ?");
      parameters.push(clean(resultStatus));
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.database.prepare(`
      SELECT * FROM memory_retrieval_traces
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, maximum, skip).map(normalizeRetrievalTrace);
  }

  applyRecallReactivation({
    agentId,
    traceId = "",
    activationId = "",
    memoryIds: requestedMemoryIds = [],
    activatedAt = "",
    policy = {},
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedTraceId = clean(traceId);
    const normalizedActivationId = clean(activationId) || normalizedTraceId;
    if (!normalizedAgentId || !normalizedActivationId) {
      throw new Error("Recall reactivation requires agentId and a stable activationId or traceId.");
    }
    if (!policy || policy.enabled !== true) {
      return Object.freeze({ status: "disabled", applied: 0, states: [] });
    }
    const policyVersion = clean(policy.configurationVersion);
    if (!policyVersion) {
      throw new Error("Recall reactivation requires configurationVersion.");
    }
    const activationGain = unitInterval(policy.activationGain, "activationGain");
    if (!(activationGain > 0)) throw new Error("activationGain must be greater than 0.");
    const scaleDays = Number(policy.scaleDays);
    if (!Number.isFinite(scaleDays) || scaleDays <= 0) {
      throw new Error("scaleDays must be greater than 0.");
    }
    const decayExponent = Number(policy.decayExponent);
    if (!Number.isFinite(decayExponent) || decayExponent <= 0) {
      throw new Error("decayExponent must be greater than 0.");
    }
    const maximumActivation = unitInterval(
      policy.maximumActivation,
      "maximumActivation",
    );
    if (!(maximumActivation > 0)) {
      throw new Error("maximumActivation must be greater than 0.");
    }
    if (activationGain > maximumActivation) {
      throw new Error("activationGain cannot exceed maximumActivation.");
    }
    const timestamp = clean(activatedAt) || nowIso();
    if (!validTimestamp(timestamp)) {
      throw new Error("activatedAt must be a valid timestamp.");
    }
    const normalizedTimestamp = new Date(timestamp).toISOString();
    const trace = normalizedTraceId ? this.getRetrievalTrace(normalizedAgentId, normalizedTraceId) : null;
    if (normalizedTraceId && !trace) throw new Error("Recall reactivation trace does not exist for this Agent.");
    const recalledMemoryIds = cleanStringList(trace ? [
      ...trace.selectedIds,
      ...(Array.isArray(trace.metadata?.recalledMemoryIds)
        ? trace.metadata.recalledMemoryIds
        : []),
    ] : requestedMemoryIds);
    if ((trace && trace.result_status !== "ready") || !recalledMemoryIds.length) {
      return Object.freeze({ status: "skipped", applied: 0, states: [] });
    }
    const memoryIds = recalledMemoryIds;
    return this.transaction(() => {
      if (this.database.prepare(`
        SELECT 1 FROM memory_recall_reactivation_receipts
        WHERE activation_id = ? AND agent_id = ?
      `).get(normalizedActivationId, normalizedAgentId)) {
        return Object.freeze({ status: "unchanged", applied: 0, activationId: normalizedActivationId, states: [] });
      }
      const selectState = this.database.prepare(`
        SELECT * FROM memory_recall_reactivation_state
        WHERE agent_id = ? AND memory_id = ?
      `);
      const upsertState = this.database.prepare(`
        INSERT INTO memory_recall_reactivation_state (
          memory_id, agent_id, value, activation_count, policy_version,
          last_trace_id, last_activated_at, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          value = excluded.value,
          activation_count = memory_recall_reactivation_state.activation_count + 1,
          policy_version = excluded.policy_version,
          last_trace_id = excluded.last_trace_id,
          last_activated_at = excluded.last_activated_at,
          updated_at = excluded.updated_at
      `);
      const changed = [];
      const validMemoryIds = [];
      for (const memoryId of memoryIds) {
        const memory = this.getMemory(memoryId);
        if (!memory || memory.agent_id !== normalizedAgentId) continue;
        validMemoryIds.push(memoryId);
        const previous = normalizeRecallReactivationState(
          selectState.get(normalizedAgentId, memoryId),
        );
        if (normalizedTraceId && previous?.last_trace_id === normalizedTraceId) continue;
        const previousTime = Date.parse(previous?.last_activated_at || "");
        const elapsedDays = Number.isFinite(previousTime)
          ? Math.max(0, (Date.parse(normalizedTimestamp) - previousTime) / 86_400_000)
          : 0;
        const compatiblePreviousValue = previous?.policy_version === policyVersion
          ? previous.value
          : 0;
        const decayedValue = compatiblePreviousValue * shiftedPowerLawRetention(
          elapsedDays,
          { scaleDays, decayExponent },
        );
        const remainingCapacityRatio = 1 - decayedValue / maximumActivation;
        const nextValue = Math.min(maximumActivation, Math.max(
          0,
          decayedValue + activationGain * Math.max(0, remainingCapacityRatio),
        ));
        upsertState.run(
          memoryId,
          normalizedAgentId,
          nextValue,
          policyVersion,
          normalizedTraceId || null,
          normalizedTimestamp,
          previous?.created_at || normalizedTimestamp,
          normalizedTimestamp,
        );
        changed.push(this.getMemoryRecallReactivationState(normalizedAgentId, memoryId));
      }
      this.database.prepare(`
        INSERT INTO memory_recall_reactivation_receipts
          (activation_id, agent_id, memory_ids_json, policy_version, trace_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(normalizedActivationId, normalizedAgentId, json(validMemoryIds, []), policyVersion,
        normalizedTraceId || null, normalizedTimestamp);
      return Object.freeze({
        status: changed.length ? "applied" : "unchanged",
        applied: changed.length,
        activationId: normalizedActivationId,
        traceId: normalizedTraceId || null,
        states: changed,
      });
    });
  }

  recordRetrievalFeedback({
    id = "",
    agentId,
    traceId,
    signal,
    targetMemoryIds = [],
    note = "",
    metadata = {},
    createdAt = "",
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedTraceId = clean(traceId);
    const normalizedSignal = clean(signal);
    if (!normalizedAgentId || !normalizedTraceId || !normalizedSignal) {
      throw new Error("Retrieval feedback requires agentId, traceId, and signal.");
    }
    if (!RETRIEVAL_FEEDBACK_SIGNALS.includes(normalizedSignal)) {
      throw new Error(`Unknown retrieval feedback signal: ${normalizedSignal}.`);
    }
    if (!this.getRetrievalTrace(normalizedAgentId, normalizedTraceId)) {
      throw new Error("Retrieval trace does not exist for this Agent.");
    }
    const normalizedTargetIds = cleanStringList(targetMemoryIds);
    if (normalizedTargetIds.some((memoryId) => {
      const memory = this.getMemory(memoryId);
      return !memory || memory.agent_id !== normalizedAgentId;
    })) {
      throw new Error("Retrieval feedback targets must exist for the same Agent.");
    }
    const feedbackId = clean(id) || `feedback-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO memory_retrieval_feedback (
        id, trace_id, agent_id, signal, target_memory_ids_json,
        note, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      feedbackId,
      normalizedTraceId,
      normalizedAgentId,
      normalizedSignal,
      json(normalizedTargetIds, []),
      clean(note),
      json(metadata && typeof metadata === "object" ? metadata : {}, {}),
      clean(createdAt) || nowIso(),
    );
    return normalizeRetrievalFeedback(this.database.prepare(`
      SELECT * FROM memory_retrieval_feedback WHERE id = ?
    `).get(feedbackId));
  }

  listRetrievalFeedback(agentId, traceId) {
    const normalizedAgentId = clean(agentId);
    const normalizedTraceId = clean(traceId);
    if (!normalizedAgentId || !normalizedTraceId) {
      throw new Error("listRetrievalFeedback requires agentId and traceId.");
    }
    return this.database.prepare(`
      SELECT * FROM memory_retrieval_feedback
      WHERE agent_id = ? AND trace_id = ?
      ORDER BY created_at ASC
    `).all(normalizedAgentId, normalizedTraceId).map(normalizeRetrievalFeedback);
  }

  findLatestUnboundRetrievalTrace(agentId, sessionId) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) {
      throw new Error("Finding an unbound retrieval trace requires agentId and sessionId.");
    }
    return normalizeRetrievalTrace(this.database.prepare(`
      SELECT trace.*
      FROM memory_retrieval_traces AS trace
      WHERE trace.agent_id = ?
        AND trace.result_status = 'ready'
        AND json_array_length(trace.selected_ids_json) > 0
        AND COALESCE(
          json_extract(trace.metadata_json, '$.runtimeSessionKey'),
          json_extract(trace.metadata_json, '$.runtimeSessionId')
        ) = ?
        AND NOT EXISTS (
          SELECT 1 FROM memory_retrieval_usage_requests AS request
          WHERE request.agent_id = trace.agent_id AND request.trace_id = trace.id
        )
      ORDER BY trace.created_at DESC, trace.id DESC
      LIMIT 1
    `).get(normalizedAgentId, normalizedSessionId));
  }

  setRetrievalSessionHead({ agentId, sessionId, traceId = "", updatedAt = "" } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    const normalizedTraceId = clean(traceId);
    if (!normalizedAgentId || !normalizedSessionId) {
      throw new Error("Retrieval session head requires agentId and sessionId.");
    }
    if (!normalizedTraceId) {
      this.database.prepare(`
        DELETE FROM memory_retrieval_session_heads WHERE agent_id = ? AND session_id = ?
      `).run(normalizedAgentId, normalizedSessionId);
      return null;
    }
    const trace = this.getRetrievalTrace(normalizedAgentId, normalizedTraceId);
    if (!trace || trace.result_status !== "ready" || !trace.selectedIds.length) {
      throw new Error("Retrieval session head requires a ready trace with selected memories.");
    }
    const traceSessionId = clean(
      trace.metadata?.runtimeSessionKey || trace.metadata?.runtimeSessionId,
    );
    if (traceSessionId && traceSessionId !== normalizedSessionId) {
      throw new Error("Retrieval session head does not match its trace session.");
    }
    this.database.prepare(`
      INSERT INTO memory_retrieval_session_heads (agent_id, session_id, trace_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, session_id) DO UPDATE SET
        trace_id = excluded.trace_id,
        updated_at = excluded.updated_at
    `).run(
      normalizedAgentId,
      normalizedSessionId,
      normalizedTraceId,
      clean(updatedAt) || nowIso(),
    );
    return this.getRetrievalSessionHead(normalizedAgentId, normalizedSessionId);
  }

  getRetrievalSessionHead(agentId, sessionId) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) return null;
    const row = this.database.prepare(`
      SELECT * FROM memory_retrieval_session_heads
      WHERE agent_id = ? AND session_id = ?
    `).get(normalizedAgentId, normalizedSessionId);
    return row ? { ...row } : null;
  }

  bindRetrievalUsageResponse({
    agentId,
    sessionId,
    responseText,
    metadata = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) {
      throw new Error("Binding retrieval usage requires agentId and sessionId.");
    }
    return this.transaction(() => {
      const head = this.getRetrievalSessionHead(normalizedAgentId, normalizedSessionId);
      if (!head) return null;
      const request = this.recordRetrievalUsageRequest({
        agentId: normalizedAgentId,
        traceId: head.trace_id,
        sessionId: normalizedSessionId,
        responseText,
        metadata,
        createdAt,
      });
      this.setRewardSessionHead({
        agentId: normalizedAgentId,
        sessionId: normalizedSessionId,
        usageRequestId: request.id,
        updatedAt: createdAt,
      });
      this.setRetrievalSessionHead({
        agentId: normalizedAgentId,
        sessionId: normalizedSessionId,
        traceId: "",
      });
      return request;
    });
  }

  recordRetrievalUsageRequest({
    id = "",
    agentId,
    traceId,
    sessionId,
    responseText,
    metadata = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedTraceId = clean(traceId);
    const normalizedSessionId = clean(sessionId);
    const normalizedResponse = clean(responseText);
    if (!normalizedAgentId || !normalizedTraceId || !normalizedSessionId || !normalizedResponse) {
      throw new Error("Retrieval usage request requires agentId, traceId, sessionId, and responseText.");
    }
    const trace = this.getRetrievalTrace(normalizedAgentId, normalizedTraceId);
    if (!trace || trace.result_status !== "ready" || !trace.selectedIds.length) {
      throw new Error("Retrieval usage request requires a ready trace with selected memories.");
    }
    const traceSessionId = clean(
      trace.metadata?.runtimeSessionKey || trace.metadata?.runtimeSessionId,
    );
    if (traceSessionId && traceSessionId !== normalizedSessionId) {
      throw new Error("Retrieval usage request session does not match its trace.");
    }
    const responseHash = createHash("sha256").update(normalizedResponse).digest("hex");
    const existing = normalizeRetrievalUsageRequest(this.database.prepare(`
      SELECT * FROM memory_retrieval_usage_requests
      WHERE agent_id = ? AND trace_id = ?
    `).get(normalizedAgentId, normalizedTraceId));
    if (existing) {
      if (existing.session_id !== normalizedSessionId || existing.response_hash !== responseHash) {
        throw new Error("Retrieval trace is already bound to a different response.");
      }
      return { ...existing, wasInserted: false };
    }
    const requestId = clean(id) || stableId(
      "retrieval-usage-request",
      normalizedAgentId,
      normalizedTraceId,
    );
    const timestamp = clean(createdAt) || nowIso();
    this.database.prepare(`
      INSERT INTO memory_retrieval_usage_requests (
        id, trace_id, agent_id, session_id, response_text, response_hash,
        status, result_json, error_message, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '{}', '', ?, ?, ?)
    `).run(
      requestId,
      normalizedTraceId,
      normalizedAgentId,
      normalizedSessionId,
      normalizedResponse,
      responseHash,
      canonicalJson(metadata, {}),
      timestamp,
      timestamp,
    );
    return { ...this.getRetrievalUsageRequest(normalizedAgentId, requestId), wasInserted: true };
  }

  getRetrievalUsageRequest(agentId, requestId) {
    return normalizeRetrievalUsageRequest(this.database.prepare(`
      SELECT * FROM memory_retrieval_usage_requests
      WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(requestId)));
  }

  listRetrievalUsageRequests(agentId, {
    statuses = [],
    sessionId = "",
    limit = 100,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRetrievalUsageRequests requires agentId.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const normalizedStatuses = cleanStringList(statuses);
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    if (clean(sessionId)) {
      clauses.push("session_id = ?");
      parameters.push(clean(sessionId));
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.database.prepare(`
      SELECT * FROM memory_retrieval_usage_requests
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...parameters, maximum).map(normalizeRetrievalUsageRequest);
  }

  recordRetrievalUsageAnalysisRun({
    id = "",
    agentId,
    requestId,
    traceId,
    provider = "",
    model = "",
    promptVersion,
    schemaVersion,
    inputHash,
    status,
    output = {},
    usage = {},
    requestExternalId = "",
    durationMs = 0,
    errorMessage = "",
    metadata = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(requestId);
    const normalizedTraceId = clean(traceId);
    const normalizedStatus = clean(status);
    const normalizedInputHash = clean(inputHash);
    if (!normalizedAgentId || !normalizedRequestId || !normalizedTraceId
      || !clean(promptVersion) || !clean(schemaVersion)
      || normalizedInputHash.length !== 64
      || !["completed", "rejected", "failed"].includes(normalizedStatus)) {
      throw new Error("Retrieval usage analysis run is incomplete.");
    }
    const request = this.getRetrievalUsageRequest(normalizedAgentId, normalizedRequestId);
    if (!request || request.trace_id !== normalizedTraceId) {
      throw new Error("Retrieval usage analysis run does not match its request.");
    }
    const runId = clean(id) || `retrieval-usage-run-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO memory_retrieval_usage_analysis_runs (
        id, request_id, trace_id, agent_id, provider, model,
        prompt_version, schema_version, input_hash, status,
        output_json, usage_json, request_external_id, duration_ms,
        error_message, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      normalizedRequestId,
      normalizedTraceId,
      normalizedAgentId,
      clean(provider),
      clean(model),
      clean(promptVersion),
      clean(schemaVersion),
      normalizedInputHash,
      normalizedStatus,
      canonicalJson(output, {}),
      canonicalJson(usage, {}),
      clean(requestExternalId),
      Math.max(0, Math.trunc(Number(durationMs) || 0)),
      clean(errorMessage),
      canonicalJson(metadata, {}),
      clean(createdAt) || nowIso(),
    );
    return normalizeRetrievalUsageAnalysisRun(this.database.prepare(`
      SELECT * FROM memory_retrieval_usage_analysis_runs WHERE id = ?
    `).get(runId));
  }

  resolveRetrievalUsageRequest({
    agentId,
    requestId,
    status,
    result = {},
    errorMessage = "",
    resolvedAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(requestId);
    const normalizedStatus = clean(status);
    if (!normalizedAgentId || !normalizedRequestId
      || !["completed", "blocked", "cancelled"].includes(normalizedStatus)) {
      throw new Error("Resolving retrieval usage request requires a terminal status.");
    }
    const timestamp = clean(resolvedAt) || nowIso();
    const update = this.database.prepare(`
      UPDATE memory_retrieval_usage_requests
      SET status = ?, result_json = ?, error_message = ?, resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'pending'
    `).run(
      normalizedStatus,
      canonicalJson(result, {}),
      clean(errorMessage),
      timestamp,
      timestamp,
      normalizedAgentId,
      normalizedRequestId,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("Retrieval usage request is missing or no longer pending.");
    }
    return this.getRetrievalUsageRequest(normalizedAgentId, normalizedRequestId);
  }

  setRewardSessionHead({ agentId, sessionId, usageRequestId = "", updatedAt = "" } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    const normalizedRequestId = clean(usageRequestId);
    if (!normalizedAgentId || !normalizedSessionId) {
      throw new Error("Reward session head requires agentId and sessionId.");
    }
    if (!normalizedRequestId) {
      this.database.prepare(`
        DELETE FROM memory_reward_session_heads WHERE agent_id = ? AND session_id = ?
      `).run(normalizedAgentId, normalizedSessionId);
      return null;
    }
    const request = this.getRetrievalUsageRequest(normalizedAgentId, normalizedRequestId);
    if (!request || request.session_id !== normalizedSessionId) {
      throw new Error("Reward session head does not match its retrieval usage request.");
    }
    this.database.prepare(`
      INSERT INTO memory_reward_session_heads (agent_id, session_id, usage_request_id, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, session_id) DO UPDATE SET
        usage_request_id = excluded.usage_request_id,
        updated_at = excluded.updated_at
    `).run(
      normalizedAgentId,
      normalizedSessionId,
      normalizedRequestId,
      clean(updatedAt) || nowIso(),
    );
    return this.getRewardSessionHead(normalizedAgentId, normalizedSessionId);
  }

  getRewardSessionHead(agentId, sessionId) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    if (!normalizedAgentId || !normalizedSessionId) return null;
    const row = this.database.prepare(`
      SELECT * FROM memory_reward_session_heads
      WHERE agent_id = ? AND session_id = ?
    `).get(normalizedAgentId, normalizedSessionId);
    return row ? { ...row } : null;
  }

  bindRewardObservation({
    agentId,
    sessionId,
    feedbackText,
    metadata = {},
    observedAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedSessionId = clean(sessionId);
    const normalizedFeedback = clean(feedbackText);
    if (!normalizedAgentId || !normalizedSessionId || !normalizedFeedback) return null;
    return this.transaction(() => {
      const head = this.getRewardSessionHead(normalizedAgentId, normalizedSessionId);
      if (!head) return null;
      const observation = this.recordRewardObservation({
        agentId: normalizedAgentId,
        usageRequestId: head.usage_request_id,
        sessionId: normalizedSessionId,
        feedbackText: normalizedFeedback,
        metadata,
        observedAt,
      });
      this.setRewardSessionHead({
        agentId: normalizedAgentId,
        sessionId: normalizedSessionId,
        usageRequestId: "",
      });
      return observation;
    });
  }

  recordRewardObservation({
    id = "",
    agentId,
    usageRequestId,
    sessionId = "",
    feedbackText,
    metadata = {},
    observedAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRequestId = clean(usageRequestId);
    const normalizedFeedback = clean(feedbackText);
    if (!normalizedAgentId || !normalizedRequestId || !normalizedFeedback) {
      throw new Error("Reward observation requires agentId, usageRequestId, and feedbackText.");
    }
    const request = this.getRetrievalUsageRequest(normalizedAgentId, normalizedRequestId);
    if (!request) throw new Error("Reward observation retrieval usage request was not found.");
    const normalizedSessionId = clean(sessionId) || request.session_id;
    if (request.session_id !== normalizedSessionId) {
      throw new Error("Reward observation session does not match its retrieval usage request.");
    }
    const feedbackHash = createHash("sha256").update(normalizedFeedback).digest("hex");
    const existing = normalizeRewardObservation(this.database.prepare(`
      SELECT * FROM memory_reward_observations
      WHERE agent_id = ? AND usage_request_id = ? AND feedback_hash = ?
    `).get(normalizedAgentId, normalizedRequestId, feedbackHash));
    if (existing) return { ...existing, wasInserted: false };
    const observationId = clean(id) || stableId(
      "reward-observation",
      normalizedAgentId,
      normalizedRequestId,
      feedbackHash,
    );
    const timestamp = clean(observedAt) || nowIso();
    this.database.prepare(`
      INSERT INTO memory_reward_observations (
        id, agent_id, usage_request_id, trace_id, session_id,
        feedback_text, feedback_hash, status, result_json,
        error_message, metadata_json, observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '{}', '', ?, ?, ?, ?)
    `).run(
      observationId,
      normalizedAgentId,
      normalizedRequestId,
      request.trace_id,
      normalizedSessionId,
      normalizedFeedback,
      feedbackHash,
      canonicalJson(metadata, {}),
      timestamp,
      timestamp,
      timestamp,
    );
    return { ...this.getRewardObservation(normalizedAgentId, observationId), wasInserted: true };
  }

  getRewardObservation(agentId, observationId) {
    return normalizeRewardObservation(this.database.prepare(`
      SELECT * FROM memory_reward_observations
      WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(observationId)));
  }

  listRewardObservations(agentId, { statuses = [], limit = 100 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRewardObservations requires agentId.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    const normalizedStatuses = cleanStringList(statuses);
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    return this.database.prepare(`
      SELECT * FROM memory_reward_observations
      WHERE ${clauses.join(" AND ")}
      ORDER BY observed_at ASC, id ASC
      LIMIT ?
    `).all(...parameters, maximum).map(normalizeRewardObservation);
  }

  recordRewardAnalysisRun({
    id = "",
    observationId,
    agentId,
    analyzerRole,
    provider = "",
    model = "",
    promptVersion,
    schemaVersion,
    inputHash,
    status,
    output = {},
    usage = {},
    requestExternalId = "",
    durationMs = 0,
    errorMessage = "",
    metadata = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedObservationId = clean(observationId);
    const normalizedRole = clean(analyzerRole);
    const normalizedStatus = clean(status);
    const normalizedInputHash = clean(inputHash);
    if (!normalizedAgentId || !normalizedObservationId
      || !["outcome", "target", "credit"].includes(normalizedRole)
      || !clean(promptVersion) || !clean(schemaVersion)
      || normalizedInputHash.length !== 64
      || !["completed", "rejected", "failed"].includes(normalizedStatus)) {
      throw new Error("Reward analysis run is incomplete.");
    }
    if (!this.getRewardObservation(normalizedAgentId, normalizedObservationId)) {
      throw new Error("Reward analysis run observation was not found.");
    }
    const runId = clean(id) || `reward-analysis-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO memory_reward_analysis_runs (
        id, observation_id, agent_id, analyzer_role, provider, model,
        prompt_version, schema_version, input_hash, status, output_json,
        usage_json, request_external_id, duration_ms, error_message,
        metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      normalizedObservationId,
      normalizedAgentId,
      normalizedRole,
      clean(provider),
      clean(model),
      clean(promptVersion),
      clean(schemaVersion),
      normalizedInputHash,
      normalizedStatus,
      canonicalJson(output, {}),
      canonicalJson(usage, {}),
      clean(requestExternalId),
      Math.max(0, Math.trunc(Number(durationMs) || 0)),
      clean(errorMessage),
      canonicalJson(metadata, {}),
      clean(createdAt) || nowIso(),
    );
    return normalizeRewardAnalysisRun(this.database.prepare(`
      SELECT * FROM memory_reward_analysis_runs WHERE id = ?
    `).get(runId));
  }

  listRewardAnalysisRuns(agentId, observationId) {
    return this.database.prepare(`
      SELECT * FROM memory_reward_analysis_runs
      WHERE agent_id = ? AND observation_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(clean(agentId), clean(observationId)).map(normalizeRewardAnalysisRun);
  }

  recordRewardCreditProposal({
    id = "",
    observationId,
    agentId,
    memoryId,
    contextKey = "",
    outcomeClass,
    feedbackTarget,
    contributionClass,
    contributionShare = 0,
    evidenceTier,
    rewardDirection,
    rewardValue = 0,
    proposedConsolidationDelta = 0,
    proposedUtilityDelta = 0,
    status,
    policyVersion,
    rationale,
    evidence = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedObservationId = clean(observationId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedContextKey = clean(contextKey);
    if (!normalizedAgentId || !normalizedObservationId || !normalizedMemoryId
      || !["direct", "partial", "none", "uncertain"].includes(clean(contributionClass))
      || !["increase", "decrease", "hold"].includes(clean(rewardDirection))
      || !["eligible", "pending", "blocked"].includes(clean(status))
      || !clean(outcomeClass) || !clean(feedbackTarget) || !clean(evidenceTier)
      || !clean(policyVersion) || !clean(rationale)) {
      throw new Error("Reward credit proposal is incomplete.");
    }
    const observation = this.getRewardObservation(normalizedAgentId, normalizedObservationId);
    const memory = this.getMemory(normalizedMemoryId);
    if (!observation || !memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Reward credit proposal exceeded its Agent boundary.");
    }
    const share = unitInterval(contributionShare, "Reward contribution share");
    const reward = bounded(rewardValue, 0, -1, 1);
    const consolidationDelta = bounded(proposedConsolidationDelta, 0, -1, 1);
    const utilityDelta = bounded(proposedUtilityDelta, 0, -1, 1);
    const existing = normalizeRewardCreditProposal(this.database.prepare(`
      SELECT * FROM memory_reward_credit_proposals
      WHERE observation_id = ? AND memory_id = ? AND context_key = ?
    `).get(normalizedObservationId, normalizedMemoryId, normalizedContextKey));
    if (existing) return { ...existing, wasInserted: false };
    const proposalId = clean(id) || stableId(
      "reward-credit-proposal",
      normalizedObservationId,
      normalizedMemoryId,
      normalizedContextKey,
    );
    this.database.prepare(`
      INSERT INTO memory_reward_credit_proposals (
        id, observation_id, agent_id, memory_id, context_key,
        outcome_class, feedback_target, contribution_class,
        contribution_share, evidence_tier, reward_direction, reward_value,
        proposed_consolidation_delta, proposed_utility_delta, status,
        policy_version, rationale, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposalId,
      normalizedObservationId,
      normalizedAgentId,
      normalizedMemoryId,
      normalizedContextKey,
      clean(outcomeClass),
      clean(feedbackTarget),
      clean(contributionClass),
      share,
      clean(evidenceTier),
      clean(rewardDirection),
      reward,
      consolidationDelta,
      utilityDelta,
      clean(status),
      clean(policyVersion),
      clean(rationale),
      canonicalJson(evidence, {}),
      clean(createdAt) || nowIso(),
    );
    return { ...this.getRewardCreditProposal(normalizedAgentId, proposalId), wasInserted: true };
  }

  getRewardCreditProposal(agentId, proposalId) {
    return normalizeRewardCreditProposal(this.database.prepare(`
      SELECT * FROM memory_reward_credit_proposals
      WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(proposalId)));
  }

  listRewardCreditProposals(agentId, {
    observationId = "",
    statuses = [],
    limit = 200,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRewardCreditProposals requires agentId.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (clean(observationId)) {
      clauses.push("observation_id = ?");
      parameters.push(clean(observationId));
    }
    const normalizedStatuses = cleanStringList(statuses);
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 200)));
    return this.database.prepare(`
      SELECT * FROM memory_reward_credit_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...parameters, maximum).map(normalizeRewardCreditProposal);
  }

  recordRewardPathCreditProposal({
    id = "",
    observationId,
    memoryCreditProposalId,
    agentId,
    memoryId,
    edgeId,
    contextKey,
    pathPosition,
    distanceFromTarget,
    eligibilityWeight,
    rewardDirection,
    rewardValue = 0,
    proposedUtilityDelta = 0,
    status,
    policyVersion,
    evidence = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedObservationId = clean(observationId);
    const normalizedMemoryProposalId = clean(memoryCreditProposalId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedEdgeId = clean(edgeId);
    const normalizedContextKey = clean(contextKey);
    const normalizedDirection = clean(rewardDirection);
    const normalizedStatus = clean(status);
    const normalizedPolicyVersion = clean(policyVersion);
    const position = Math.trunc(Number(pathPosition));
    const distance = Math.trunc(Number(distanceFromTarget));
    const weight = Number(eligibilityWeight);
    if (!normalizedAgentId || !normalizedObservationId || !normalizedMemoryProposalId
      || !normalizedMemoryId || !normalizedEdgeId || !normalizedContextKey
      || !["increase", "decrease", "hold"].includes(normalizedDirection)
      || !["eligible", "pending", "blocked"].includes(normalizedStatus)
      || !normalizedPolicyVersion || !Number.isInteger(position) || position < 0
      || !Number.isInteger(distance) || distance < 0
      || !Number.isFinite(weight) || weight <= 0 || weight > 1) {
      throw new Error("Reward path credit proposal is incomplete.");
    }
    const nodeProposal = this.getRewardCreditProposal(
      normalizedAgentId,
      normalizedMemoryProposalId,
    );
    const edge = this.database.prepare(`
      SELECT * FROM memory_edges WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedEdgeId);
    if (!nodeProposal || nodeProposal.observation_id !== normalizedObservationId
      || nodeProposal.memory_id !== normalizedMemoryId || !edge) {
      throw new Error("Reward path credit proposal exceeded its audited trace boundary.");
    }
    const existing = normalizeRewardPathCreditProposal(this.database.prepare(`
      SELECT * FROM memory_reward_path_credit_proposals
      WHERE memory_credit_proposal_id = ? AND edge_id = ?
    `).get(normalizedMemoryProposalId, normalizedEdgeId));
    if (existing) return { ...existing, wasInserted: false };
    const proposalId = clean(id) || stableId(
      "reward-path-credit",
      normalizedMemoryProposalId,
      normalizedEdgeId,
    );
    this.database.prepare(`
      INSERT INTO memory_reward_path_credit_proposals (
        id, observation_id, memory_credit_proposal_id, agent_id, memory_id,
        edge_id, context_key, path_position, distance_from_target,
        eligibility_weight, reward_direction, reward_value,
        proposed_utility_delta, status, policy_version, evidence_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      proposalId,
      normalizedObservationId,
      normalizedMemoryProposalId,
      normalizedAgentId,
      normalizedMemoryId,
      normalizedEdgeId,
      normalizedContextKey,
      position,
      distance,
      weight,
      normalizedDirection,
      bounded(rewardValue, 0, -1, 1),
      bounded(proposedUtilityDelta, 0, -1, 1),
      normalizedStatus,
      normalizedPolicyVersion,
      canonicalJson(evidence, {}),
      clean(createdAt) || nowIso(),
    );
    return { ...this.getRewardPathCreditProposal(normalizedAgentId, proposalId), wasInserted: true };
  }

  getRewardPathCreditProposal(agentId, proposalId) {
    return normalizeRewardPathCreditProposal(this.database.prepare(`
      SELECT * FROM memory_reward_path_credit_proposals
      WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(proposalId)));
  }

  listRewardPathCreditProposals(agentId, {
    observationId = "",
    memoryCreditProposalId = "",
    statuses = [],
    limit = 1000,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRewardPathCreditProposals requires agentId.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (clean(observationId)) {
      clauses.push("observation_id = ?");
      parameters.push(clean(observationId));
    }
    if (clean(memoryCreditProposalId)) {
      clauses.push("memory_credit_proposal_id = ?");
      parameters.push(clean(memoryCreditProposalId));
    }
    const normalizedStatuses = cleanStringList(statuses);
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    const maximum = Math.min(5000, Math.max(1, Math.trunc(Number(limit) || 1000)));
    return this.database.prepare(`
      SELECT * FROM memory_reward_path_credit_proposals
      WHERE ${clauses.join(" AND ")}
      ORDER BY memory_credit_proposal_id ASC, path_position ASC, id ASC
      LIMIT ?
    `).all(...parameters, maximum).map(normalizeRewardPathCreditProposal);
  }

  resolveRewardObservation({
    agentId,
    observationId,
    status,
    result = {},
    errorMessage = "",
    resolvedAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedObservationId = clean(observationId);
    const normalizedStatus = clean(status);
    if (!normalizedAgentId || !normalizedObservationId
      || !["analyzed", "blocked", "cancelled"].includes(normalizedStatus)) {
      throw new Error("Resolving reward observation requires a terminal status.");
    }
    const timestamp = clean(resolvedAt) || nowIso();
    const update = this.database.prepare(`
      UPDATE memory_reward_observations
      SET status = ?, result_json = ?, error_message = ?, resolved_at = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = 'pending'
    `).run(
      normalizedStatus,
      canonicalJson(result, {}),
      clean(errorMessage),
      timestamp,
      timestamp,
      normalizedAgentId,
      normalizedObservationId,
    );
    if (Number(update.changes || 0) !== 1) {
      throw new Error("Reward observation is missing or no longer pending.");
    }
    return this.getRewardObservation(normalizedAgentId, normalizedObservationId);
  }

  listMemoryRetrievalStats(agentId, {
    memoryIds = [],
    limit = 200,
    requireComplete = false,
    windowStart = "",
    windowEnd = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listMemoryRetrievalStats requires agentId.");
    const requestedIds = cleanStringList(memoryIds);
    const window = normalizeTimeWindow(windowStart, windowEnd);
    const traceClauses = ["trace.agent_id = ?", "trace.result_status = 'ready'"];
    const traceParameters = [normalizedAgentId];
    if (window.start) {
      traceClauses.push("trace.created_at >= ?");
      traceParameters.push(window.start);
    }
    if (window.end) {
      traceClauses.push("trace.created_at < ?");
      traceParameters.push(window.end);
    }
    if (requestedIds.length) {
      traceClauses.push(`node.id IN (${requestedIds.map(() => "?").join(", ")})`);
      traceParameters.push(...requestedIds);
    }
    const feedbackClauses = ["feedback.agent_id = ?"];
    const feedbackParameters = [normalizedAgentId];
    if (window.start) {
      feedbackClauses.push("feedback.created_at >= ?");
      feedbackParameters.push(window.start);
    }
    if (window.end) {
      feedbackClauses.push("feedback.created_at < ?");
      feedbackParameters.push(window.end);
    }
    if (requestedIds.length) {
      feedbackClauses.push(`node.id IN (${requestedIds.map(() => "?").join(", ")})`);
      feedbackParameters.push(...requestedIds);
    }
    const selectedRows = this.database.prepare(`
      SELECT item.value AS memory_id, COUNT(DISTINCT trace.id) AS selected_count,
             MAX(trace.created_at) AS last_selected_at
      FROM memory_retrieval_traces AS trace
      JOIN json_each(trace.selected_ids_json) AS item
      JOIN memory_nodes AS node ON node.id = item.value AND node.agent_id = trace.agent_id
      WHERE ${traceClauses.join(" AND ")}
      GROUP BY item.value
    `).all(...traceParameters);
    const seedRows = this.database.prepare(`
      SELECT item.value AS memory_id, COUNT(DISTINCT trace.id) AS seed_count,
             MAX(trace.created_at) AS last_seeded_at
      FROM memory_retrieval_traces AS trace
      JOIN json_each(trace.seed_ids_json) AS item
      JOIN memory_nodes AS node ON node.id = item.value AND node.agent_id = trace.agent_id
      WHERE ${traceClauses.join(" AND ")}
      GROUP BY item.value
    `).all(...traceParameters);
    const feedbackRows = this.database.prepare(`
      SELECT item.value AS memory_id, feedback.signal,
             COUNT(DISTINCT feedback.id) AS signal_count,
             MAX(feedback.created_at) AS last_feedback_at
      FROM memory_retrieval_feedback AS feedback
      JOIN json_each(feedback.target_memory_ids_json) AS item
      JOIN memory_nodes AS node ON node.id = item.value AND node.agent_id = feedback.agent_id
      WHERE ${feedbackClauses.join(" AND ")}
      GROUP BY item.value, feedback.signal
    `).all(...feedbackParameters);
    const stats = new Map();
    const ensure = (memoryId) => {
      if (!stats.has(memoryId)) {
        stats.set(memoryId, {
          memoryId,
          selectedCount: 0,
          seedCount: 0,
          lastSelectedAt: null,
          lastSeededAt: null,
          lastFeedbackAt: null,
          feedback: Object.fromEntries(RETRIEVAL_FEEDBACK_SIGNALS.map((signal) => [signal, 0])),
        });
      }
      return stats.get(memoryId);
    };
    if (requestedIds.length) {
      const existing = this.database.prepare(`
        SELECT id FROM memory_nodes
        WHERE agent_id = ? AND id IN (${requestedIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...requestedIds);
      for (const row of existing) ensure(row.id);
    }
    for (const row of selectedRows) {
      const item = ensure(row.memory_id);
      item.selectedCount = Number(row.selected_count || 0);
      item.lastSelectedAt = row.last_selected_at || null;
    }
    for (const row of seedRows) {
      const item = ensure(row.memory_id);
      item.seedCount = Number(row.seed_count || 0);
      item.lastSeededAt = row.last_seeded_at || null;
    }
    for (const row of feedbackRows) {
      const item = ensure(row.memory_id);
      item.feedback[row.signal] = Number(row.signal_count || 0);
      if (!item.lastFeedbackAt || row.last_feedback_at > item.lastFeedbackAt) {
        item.lastFeedbackAt = row.last_feedback_at || null;
      }
    }
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 200)));
    const values = [...stats.values()]
      .sort((left, right) => (
        String(right.lastSelectedAt || "").localeCompare(String(left.lastSelectedAt || ""))
        || right.selectedCount - left.selectedCount
        || left.memoryId.localeCompare(right.memoryId)
      ));
    if (requireComplete && values.length > maximum) {
      throw new Error(`Memory retrieval stats exceed the complete-result limit of ${maximum}.`);
    }
    return values.slice(0, maximum);
  }

  listEdgeRetrievalStats(agentId, {
    edgeIds = [],
    limit = 200,
    windowStart = "",
    windowEnd = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listEdgeRetrievalStats requires agentId.");
    const requestedIds = cleanStringList(edgeIds);
    const window = normalizeTimeWindow(windowStart, windowEnd);
    const traceClauses = ["trace.agent_id = ?", "trace.result_status = 'ready'"];
    const traceParameters = [normalizedAgentId];
    if (window.start) {
      traceClauses.push("trace.created_at >= ?");
      traceParameters.push(window.start);
    }
    if (window.end) {
      traceClauses.push("trace.created_at < ?");
      traceParameters.push(window.end);
    }
    if (requestedIds.length) {
      traceClauses.push(`stored_edge.id IN (${requestedIds.map(() => "?").join(", ")})`);
      traceParameters.push(...requestedIds);
    }
    const feedbackClauses = ["feedback.agent_id = ?"];
    const feedbackParameters = [normalizedAgentId];
    if (window.start) {
      feedbackClauses.push("feedback.created_at >= ?");
      feedbackParameters.push(window.start);
    }
    if (window.end) {
      feedbackClauses.push("feedback.created_at < ?");
      feedbackParameters.push(window.end);
    }
    if (requestedIds.length) {
      feedbackClauses.push(`stored_edge.id IN (${requestedIds.map(() => "?").join(", ")})`);
      feedbackParameters.push(...requestedIds);
    }
    const traversalRows = this.database.prepare(`
      SELECT stored_edge.id AS edge_id,
             stored_edge.from_memory_id, stored_edge.to_memory_id, stored_edge.relation,
             COUNT(DISTINCT trace.id) AS traversed_count,
             MAX(trace.created_at) AS last_traversed_at
      FROM memory_retrieval_traces AS trace
      JOIN json_each(trace.paths_json) AS selected_path ON 1 = 1
      JOIN json_each(selected_path.value, '$.edges') AS path_edge ON 1 = 1
      JOIN memory_edges AS stored_edge
        ON stored_edge.id = json_extract(path_edge.value, '$.edgeId')
       AND stored_edge.agent_id = trace.agent_id
      WHERE ${traceClauses.join(" AND ")}
      GROUP BY stored_edge.id
    `).all(...traceParameters);
    const feedbackRows = this.database.prepare(`
      SELECT stored_edge.id AS edge_id, feedback.signal,
             COUNT(DISTINCT feedback.id) AS signal_count,
             MAX(feedback.created_at) AS last_feedback_at
      FROM memory_retrieval_feedback AS feedback
      JOIN memory_retrieval_traces AS trace
        ON trace.id = feedback.trace_id AND trace.agent_id = feedback.agent_id
      JOIN json_each(feedback.target_memory_ids_json) AS target_memory ON 1 = 1
      JOIN json_each(trace.paths_json) AS selected_path
        ON json_extract(selected_path.value, '$.memoryId') = target_memory.value
      JOIN json_each(selected_path.value, '$.edges') AS path_edge ON 1 = 1
      JOIN memory_edges AS stored_edge
        ON stored_edge.id = json_extract(path_edge.value, '$.edgeId')
       AND stored_edge.agent_id = feedback.agent_id
      WHERE ${feedbackClauses.join(" AND ")}
      GROUP BY stored_edge.id, feedback.signal
    `).all(...feedbackParameters);
    const stats = new Map();
    const ensure = ({
      edge_id: edgeId,
      from_memory_id: fromMemoryId = "",
      to_memory_id: toMemoryId = "",
      relation = "",
    }) => {
      if (!stats.has(edgeId)) {
        stats.set(edgeId, {
          edgeId,
          fromMemoryId,
          toMemoryId,
          relation,
          traversedCount: 0,
          lastTraversedAt: null,
          lastFeedbackAt: null,
          feedback: Object.fromEntries(RETRIEVAL_FEEDBACK_SIGNALS.map((signal) => [signal, 0])),
        });
      }
      return stats.get(edgeId);
    };
    if (requestedIds.length) {
      const existing = this.database.prepare(`
        SELECT id AS edge_id, from_memory_id, to_memory_id, relation
        FROM memory_edges
        WHERE agent_id = ? AND id IN (${requestedIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...requestedIds);
      for (const row of existing) ensure(row);
    }
    for (const row of traversalRows) {
      const item = ensure(row);
      item.traversedCount = Number(row.traversed_count || 0);
      item.lastTraversedAt = row.last_traversed_at || null;
    }
    for (const row of feedbackRows) {
      const item = ensure(row);
      item.feedback[row.signal] = Number(row.signal_count || 0);
      if (!item.lastFeedbackAt || row.last_feedback_at > item.lastFeedbackAt) {
        item.lastFeedbackAt = row.last_feedback_at || null;
      }
    }
    return [...stats.values()]
      .sort((left, right) => (
        String(right.lastTraversedAt || "").localeCompare(String(left.lastTraversedAt || ""))
        || right.traversedCount - left.traversedCount
        || left.edgeId.localeCompare(right.edgeId)
      ))
      .slice(0, Math.min(500, Math.max(1, Math.trunc(Number(limit) || 200))));
  }

  listEdgeRetrievalStatsByView(agentId, {
    edgeIds = [],
    intentViews = [],
    limit = 500,
    requireComplete = false,
    windowStart = "",
    windowEnd = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listEdgeRetrievalStatsByView requires agentId.");
    const requestedIds = cleanStringList(edgeIds);
    const requestedViews = cleanStringList(intentViews);
    const window = normalizeTimeWindow(windowStart, windowEnd);
    const viewExpression = "COALESCE(NULLIF(json_extract(path_edge.value, '$.relationView'), ''), 'unknown')";
    const buildConditions = (timeAlias) => {
      const clauses = [`${timeAlias}.agent_id = ?`];
      const parameters = [normalizedAgentId];
      if (timeAlias === "trace") clauses.push("trace.result_status = 'ready'");
      if (window.start) {
        clauses.push(`${timeAlias}.created_at >= ?`);
        parameters.push(window.start);
      }
      if (window.end) {
        clauses.push(`${timeAlias}.created_at < ?`);
        parameters.push(window.end);
      }
      if (requestedIds.length) {
        clauses.push(`stored_edge.id IN (${requestedIds.map(() => "?").join(", ")})`);
        parameters.push(...requestedIds);
      }
      if (requestedViews.length) {
        clauses.push(`${viewExpression} IN (${requestedViews.map(() => "?").join(", ")})`);
        parameters.push(...requestedViews);
      }
      return { clauses, parameters };
    };
    const traversalFilter = buildConditions("trace");
    const feedbackFilter = buildConditions("feedback");
    const traversalRows = this.database.prepare(`
      SELECT stored_edge.id AS edge_id,
             stored_edge.from_memory_id, stored_edge.to_memory_id, stored_edge.relation,
             ${viewExpression} AS intent_view,
             COUNT(DISTINCT trace.id) AS traversed_count,
             MAX(trace.created_at) AS last_traversed_at
      FROM memory_retrieval_traces AS trace
      JOIN json_each(trace.paths_json) AS selected_path ON 1 = 1
      JOIN json_each(selected_path.value, '$.edges') AS path_edge ON 1 = 1
      JOIN memory_edges AS stored_edge
        ON stored_edge.id = json_extract(path_edge.value, '$.edgeId')
       AND stored_edge.agent_id = trace.agent_id
      WHERE ${traversalFilter.clauses.join(" AND ")}
      GROUP BY stored_edge.id, intent_view
    `).all(...traversalFilter.parameters);
    const feedbackRows = this.database.prepare(`
      SELECT stored_edge.id AS edge_id,
             stored_edge.from_memory_id, stored_edge.to_memory_id, stored_edge.relation,
             ${viewExpression} AS intent_view, feedback.signal,
             COUNT(DISTINCT feedback.id) AS signal_count,
             MAX(feedback.created_at) AS last_feedback_at
      FROM memory_retrieval_feedback AS feedback
      JOIN memory_retrieval_traces AS trace
        ON trace.id = feedback.trace_id AND trace.agent_id = feedback.agent_id
      JOIN json_each(feedback.target_memory_ids_json) AS target_memory ON 1 = 1
      JOIN json_each(trace.paths_json) AS selected_path
        ON json_extract(selected_path.value, '$.memoryId') = target_memory.value
      JOIN json_each(selected_path.value, '$.edges') AS path_edge ON 1 = 1
      JOIN memory_edges AS stored_edge
        ON stored_edge.id = json_extract(path_edge.value, '$.edgeId')
       AND stored_edge.agent_id = feedback.agent_id
      WHERE ${feedbackFilter.clauses.join(" AND ")}
      GROUP BY stored_edge.id, intent_view, feedback.signal
    `).all(...feedbackFilter.parameters);
    const stats = new Map();
    const ensure = (row) => {
      const key = `${row.edge_id}\u001f${row.intent_view}`;
      if (!stats.has(key)) {
        stats.set(key, {
          edgeId: row.edge_id,
          fromMemoryId: row.from_memory_id || "",
          toMemoryId: row.to_memory_id || "",
          relation: row.relation || "",
          intentView: row.intent_view,
          traversedCount: 0,
          lastTraversedAt: null,
          lastFeedbackAt: null,
          feedback: Object.fromEntries(RETRIEVAL_FEEDBACK_SIGNALS.map((signal) => [signal, 0])),
        });
      }
      return stats.get(key);
    };
    if (requestedIds.length && requestedViews.length) {
      const existing = this.database.prepare(`
        SELECT id AS edge_id, from_memory_id, to_memory_id, relation
        FROM memory_edges
        WHERE agent_id = ? AND id IN (${requestedIds.map(() => "?").join(", ")})
      `).all(normalizedAgentId, ...requestedIds);
      for (const row of existing) {
        for (const intentView of requestedViews) ensure({ ...row, intent_view: intentView });
      }
    }
    for (const row of traversalRows) {
      const item = ensure(row);
      item.traversedCount = Number(row.traversed_count || 0);
      item.lastTraversedAt = row.last_traversed_at || null;
    }
    for (const row of feedbackRows) {
      const item = ensure(row);
      item.feedback[row.signal] = Number(row.signal_count || 0);
      if (!item.lastFeedbackAt || row.last_feedback_at > item.lastFeedbackAt) {
        item.lastFeedbackAt = row.last_feedback_at || null;
      }
    }
    const maximum = Math.min(2000, Math.max(1, Math.trunc(Number(limit) || 500)));
    const values = [...stats.values()]
      .sort((left, right) => (
        String(right.lastTraversedAt || "").localeCompare(String(left.lastTraversedAt || ""))
        || right.traversedCount - left.traversedCount
        || left.edgeId.localeCompare(right.edgeId)
        || left.intentView.localeCompare(right.intentView)
      ));
    if (requireComplete && values.length > maximum) {
      throw new Error(`Edge retrieval stats exceed the complete-result limit of ${maximum}.`);
    }
    return values.slice(0, maximum);
  }

  getMemoryAccessibilityState(agentId, memoryId) {
    return normalizeAccessibilityState(this.database.prepare(`
      SELECT * FROM memory_accessibility_state
      WHERE agent_id = ? AND memory_id = ?
    `).get(clean(agentId), clean(memoryId)));
  }

  getMemoryRecallReactivationState(agentId, memoryId) {
    return normalizeRecallReactivationState(this.database.prepare(`
      SELECT * FROM memory_recall_reactivation_state
      WHERE agent_id = ? AND memory_id = ?
    `).get(clean(agentId), clean(memoryId)));
  }

  listMemoryRecallReactivationStates(agentId, { policyVersions = [] } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) {
      throw new Error("listMemoryRecallReactivationStates requires agentId.");
    }
    const versions = cleanStringList(policyVersions);
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (versions.length) {
      clauses.push(`policy_version IN (${versions.map(() => "?").join(", ")})`);
      parameters.push(...versions);
    }
    return this.database.prepare(`
      SELECT * FROM memory_recall_reactivation_state
      WHERE ${clauses.join(" AND ")}
      ORDER BY memory_id ASC
    `).all(...parameters).map(normalizeRecallReactivationState);
  }

  getMemoryConsolidationState(agentId, memoryId) {
    return normalizeConsolidationState(this.database.prepare(`
      SELECT * FROM memory_consolidation_state
      WHERE agent_id = ? AND memory_id = ?
    `).get(clean(agentId), clean(memoryId)));
  }

  listMemoryConsolidationStates(agentId, { policyVersions = [] } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listMemoryConsolidationStates requires agentId.");
    const versions = cleanStringList(policyVersions);
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (versions.length) {
      clauses.push(`policy_version IN (${versions.map(() => "?").join(", ")})`);
      parameters.push(...versions);
    }
    return this.database.prepare(`
      SELECT * FROM memory_consolidation_state
      WHERE ${clauses.join(" AND ")}
      ORDER BY memory_id ASC
    `).all(...parameters).map(normalizeConsolidationState);
  }

  getMemoryContextUtilityState(agentId, memoryId, contextKey) {
    return normalizeContextUtilityState(this.database.prepare(`
      SELECT * FROM memory_context_utility_state
      WHERE agent_id = ? AND memory_id = ? AND context_key = ?
    `).get(clean(agentId), clean(memoryId), clean(contextKey)));
  }

  listMemoryContextUtilityStates(agentId, { contextKeys = [], policyVersions = [] } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listMemoryContextUtilityStates requires agentId.");
    const keys = cleanStringList(contextKeys);
    const versions = cleanStringList(policyVersions);
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (keys.length) {
      clauses.push(`context_key IN (${keys.map(() => "?").join(", ")})`);
      parameters.push(...keys);
    }
    if (versions.length) {
      clauses.push(`policy_version IN (${versions.map(() => "?").join(", ")})`);
      parameters.push(...versions);
    }
    return this.database.prepare(`
      SELECT * FROM memory_context_utility_state
      WHERE ${clauses.join(" AND ")}
      ORDER BY memory_id ASC, context_key ASC
    `).all(...parameters).map(normalizeContextUtilityState);
  }

  listMemoryAccessibilityStates(agentId, { policyVersions = [] } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listMemoryAccessibilityStates requires agentId.");
    const versions = cleanStringList(policyVersions);
    if (!versions.length) return [];
    return this.database.prepare(`
      SELECT * FROM memory_accessibility_state
      WHERE agent_id = ? AND policy_version IN (${versions.map(() => "?").join(", ")})
      ORDER BY memory_id ASC
    `).all(normalizedAgentId, ...versions).map(normalizeAccessibilityState);
  }

  getEdgeRelationUtilityState(agentId, edgeId, intentView) {
    return normalizeEdgeRelationUtilityState(this.database.prepare(`
      SELECT * FROM memory_edge_relation_utility_state
      WHERE agent_id = ? AND edge_id = ? AND intent_view = ?
    `).get(clean(agentId), clean(edgeId), clean(intentView)));
  }

  previewRewardCreditApplication({ agentId, observationId, policy } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedObservationId = clean(observationId);
    if (!normalizedAgentId || !normalizedObservationId) {
      throw new Error("Reward application preview requires agentId and observationId.");
    }
    const normalizedPolicy = normalizeRewardApplicationPolicy(policy);
    const observation = this.getRewardObservation(normalizedAgentId, normalizedObservationId);
    if (!observation || observation.status !== "analyzed") {
      throw new Error("Reward application preview requires an analyzed observation.");
    }
    const memoryProposals = this.listRewardCreditProposals(normalizedAgentId, {
      observationId: normalizedObservationId,
      statuses: ["eligible"],
      limit: 500,
    });
    const pathProposals = this.listRewardPathCreditProposals(normalizedAgentId, {
      observationId: normalizedObservationId,
      statuses: ["eligible"],
      limit: 5000,
    });
    if (!memoryProposals.length) {
      throw new Error("Reward application preview has no eligible memory credit proposals.");
    }
    if (memoryProposals.some((proposal) => (
      !normalizedPolicy.allowedCreditPolicyVersions.includes(proposal.policy_version)
    ))) {
      throw new Error("Reward application encountered a memory credit policy version that was not approved.");
    }
    if (pathProposals.some((proposal) => (
      !normalizedPolicy.allowedPathPolicyVersions.includes(proposal.policy_version)
    ))) {
      throw new Error("Reward application encountered a path policy version that was not approved.");
    }
    const targets = new Map();
    const addTarget = ({ targetType, targetId, contextKey = "", delta, sourceProposalType, sourceProposalId }) => {
      const key = `${targetType}\u001f${targetId}\u001f${contextKey}`;
      if (!targets.has(key)) {
        targets.set(key, {
          targetType,
          targetId,
          contextKey,
          delta: 0,
          sourceProposalType,
          sourceProposalIds: [],
        });
      }
      const target = targets.get(key);
      if (target.sourceProposalType !== sourceProposalType) {
        throw new Error("Reward application target mixed incompatible proposal types.");
      }
      target.delta += Number(delta) || 0;
      target.sourceProposalIds.push(sourceProposalId);
    };
    for (const proposal of memoryProposals) {
      const memory = this.getMemory(proposal.memory_id);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.status !== "active") {
        throw new Error(`Reward target memory ${proposal.memory_id} is no longer active.`);
      }
      if (proposal.proposed_consolidation_delta > 0) {
        addTarget({
          targetType: "consolidation",
          targetId: proposal.memory_id,
          delta: proposal.proposed_consolidation_delta,
          sourceProposalType: "memory",
          sourceProposalId: proposal.id,
        });
      }
      if (proposal.proposed_utility_delta !== 0) {
        if (!clean(proposal.context_key)) {
          throw new Error("Reward context utility requires an explicit context key.");
        }
        addTarget({
          targetType: "context-utility",
          targetId: proposal.memory_id,
          contextKey: proposal.context_key,
          delta: proposal.proposed_utility_delta,
          sourceProposalType: "memory",
          sourceProposalId: proposal.id,
        });
      }
    }
    for (const proposal of pathProposals) {
      const edge = this.database.prepare(`
        SELECT 1 AS exists_flag FROM memory_edges WHERE agent_id = ? AND id = ?
      `).get(normalizedAgentId, proposal.edge_id);
      if (!edge) throw new Error(`Reward path edge ${proposal.edge_id} is no longer available.`);
      if (proposal.proposed_utility_delta === 0) continue;
      addTarget({
        targetType: "relation-utility",
        targetId: proposal.edge_id,
        contextKey: proposal.context_key,
        delta: proposal.proposed_utility_delta,
        sourceProposalType: "path",
        sourceProposalId: proposal.id,
      });
    }
    const changes = [...targets.values()].map((target) => {
      const section = target.targetType === "consolidation"
        ? normalizedPolicy.consolidation
        : target.targetType === "context-utility"
          ? normalizedPolicy.contextUtility
          : normalizedPolicy.relationUtility;
      const state = target.targetType === "consolidation"
        ? this.getMemoryConsolidationState(normalizedAgentId, target.targetId)
        : target.targetType === "context-utility"
          ? this.getMemoryContextUtilityState(
            normalizedAgentId,
            target.targetId,
            target.contextKey,
          )
          : this.getEdgeRelationUtilityState(
            normalizedAgentId,
            target.targetId,
            target.contextKey,
          );
      const currentValue = state?.value ?? section.initialValue;
      const appliedValue = boundedRewardStateChange(currentValue, target.delta, section);
      return {
        ...target,
        sourceProposalIds: [...new Set(target.sourceProposalIds)].sort(),
        currentValue,
        appliedValue,
        previousState: {
          exists: Boolean(state),
          value: state?.value ?? null,
          policyVersion: state?.policy_version || "",
          applicationId: state?.last_application_id || "",
          observationWindowId: state?.last_observation_window_id || "",
          appliedAt: state?.last_applied_at || null,
        },
      };
    }).filter((change) => !sameNumericValue(change.currentValue, change.appliedValue));
    if (!changes.length) {
      throw new Error("Reward application preview has no bounded state changes to apply.");
    }
    const input = {
      agentId: normalizedAgentId,
      observationId: normalizedObservationId,
      policy: normalizedPolicy,
      memoryProposals: memoryProposals.map((proposal) => ({
        id: proposal.id,
        memoryId: proposal.memory_id,
        contextKey: proposal.context_key,
        policyVersion: proposal.policy_version,
        rewardValue: proposal.reward_value,
        proposedConsolidationDelta: proposal.proposed_consolidation_delta,
        proposedUtilityDelta: proposal.proposed_utility_delta,
      })),
      pathProposals: pathProposals.map((proposal) => ({
        id: proposal.id,
        memoryCreditProposalId: proposal.memory_credit_proposal_id,
        memoryId: proposal.memory_id,
        edgeId: proposal.edge_id,
        contextKey: proposal.context_key,
        policyVersion: proposal.policy_version,
        eligibilityWeight: proposal.eligibility_weight,
        distanceFromTarget: proposal.distance_from_target,
        proposedUtilityDelta: proposal.proposed_utility_delta,
      })),
      changes,
    };
    return {
      agentId: normalizedAgentId,
      observationId: normalizedObservationId,
      policyVersion: normalizedPolicy.version,
      inputHash: canonicalHash(input),
      changes,
      eligibleMemoryProposalIds: memoryProposals.map((proposal) => proposal.id),
      eligiblePathProposalIds: pathProposals.map((proposal) => proposal.id),
      skippedCount: memoryProposals.length + pathProposals.length
        - new Set(changes.flatMap((change) => change.sourceProposalIds)).size,
      automaticStateMutationAllowed: false,
    };
  }

  getRewardApplication(agentId, applicationId) {
    const normalizedAgentId = clean(agentId);
    const normalizedApplicationId = clean(applicationId);
    if (!normalizedAgentId || !normalizedApplicationId) return null;
    const row = this.database.prepare(`
      SELECT * FROM memory_reward_applications WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedApplicationId);
    if (!row) return null;
    const changes = this.database.prepare(`
      SELECT * FROM memory_reward_application_changes
      WHERE agent_id = ? AND application_id = ?
      ORDER BY target_type ASC, target_id ASC, context_key ASC
    `).all(normalizedAgentId, normalizedApplicationId).map(normalizeRewardApplicationChange);
    return normalizeRewardApplication(row, changes);
  }

  listRewardApplications(agentId, { limit = 50, offset = 0 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listRewardApplications requires agentId.");
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 50)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.database.prepare(`
      SELECT * FROM memory_reward_applications
      WHERE agent_id = ?
      ORDER BY applied_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(normalizedAgentId, maximum, skip).map((row) => normalizeRewardApplication(row));
  }

  applyRewardCreditApplication({
    agentId,
    observationId,
    policy,
    expectedInputHash,
    actor,
    reason = "",
    appliedAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedObservationId = clean(observationId);
    const normalizedActor = clean(actor);
    const normalizedInputHash = clean(expectedInputHash).toLowerCase();
    if (!normalizedAgentId || !normalizedObservationId || !normalizedActor) {
      throw new Error("Applying reward credit requires agentId, observationId, and actor.");
    }
    if (!/^[a-f0-9]{64}$/u.test(normalizedInputHash)) {
      throw new Error("Applying reward credit requires the explicitly approved SHA-256 input hash.");
    }
    const existing = this.database.prepare(`
      SELECT * FROM memory_reward_applications
      WHERE agent_id = ? AND observation_id = ?
    `).get(normalizedAgentId, normalizedObservationId);
    if (existing) {
      if (existing.input_hash !== normalizedInputHash) {
        throw new Error("Reward observation was already applied with a different input hash.");
      }
      if (existing.status === "rolled_back") {
        throw new Error("A rolled-back reward observation cannot be silently reapplied.");
      }
      return { ...this.getRewardApplication(normalizedAgentId, existing.id), wasApplied: false };
    }
    const preview = this.previewRewardCreditApplication({
      agentId: normalizedAgentId,
      observationId: normalizedObservationId,
      policy,
    });
    if (preview.inputHash !== normalizedInputHash) {
      throw new Error("Reward application input hash does not match the explicit approval.");
    }
    const timestamp = clean(appliedAt) || nowIso();
    if (!validTimestamp(timestamp)) throw new Error("Reward appliedAt is invalid.");
    const normalizedAppliedAt = new Date(timestamp).toISOString();
    const applicationId = stableId(
      "reward-application",
      normalizedAgentId,
      normalizedObservationId,
      normalizedInputHash,
    );
    return this.transaction(() => {
      const fresh = this.previewRewardCreditApplication({
        agentId: normalizedAgentId,
        observationId: normalizedObservationId,
        policy,
      });
      if (fresh.inputHash !== normalizedInputHash) {
        throw new Error("Reward state changed after preview and before application.");
      }
      this.database.prepare(`
        INSERT INTO memory_reward_applications (
          id, observation_id, agent_id, input_hash, policy_version, status,
          applied_count, skipped_count, applied_by, application_reason, applied_at
        ) VALUES (?, ?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?)
      `).run(
        applicationId,
        normalizedObservationId,
        normalizedAgentId,
        normalizedInputHash,
        fresh.policyVersion,
        fresh.changes.length,
        fresh.skippedCount,
        normalizedActor,
        clean(reason),
        normalizedAppliedAt,
      );
      const insertAudit = this.database.prepare(`
        INSERT INTO memory_reward_application_changes (
          id, application_id, agent_id, source_proposal_type, source_proposal_ids_json,
          target_type, target_id, context_key, target_policy_version,
          previous_exists, previous_value, previous_policy_version,
          previous_application_id, previous_observation_window_id, previous_applied_at,
          applied_value, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const change of fresh.changes) {
        insertAudit.run(
          stableId(
            "reward-applied-change",
            applicationId,
            change.targetType,
            change.targetId,
            change.contextKey,
          ),
          applicationId,
          normalizedAgentId,
          change.sourceProposalType,
          canonicalJson(change.sourceProposalIds, []),
          change.targetType,
          change.targetId,
          change.contextKey,
          fresh.policyVersion,
          change.previousState.exists ? 1 : 0,
          change.previousState.value,
          change.previousState.policyVersion,
          change.previousState.applicationId,
          change.previousState.observationWindowId,
          change.previousState.appliedAt,
          change.appliedValue,
          normalizedAppliedAt,
        );
        if (change.targetType === "consolidation") {
          this.database.prepare(`
            INSERT INTO memory_consolidation_state (
              memory_id, agent_id, value, policy_version, last_application_id,
              last_applied_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(memory_id) DO UPDATE SET
              value = excluded.value,
              policy_version = excluded.policy_version,
              last_application_id = excluded.last_application_id,
              last_applied_at = excluded.last_applied_at,
              updated_at = excluded.updated_at
          `).run(
            change.targetId,
            normalizedAgentId,
            change.appliedValue,
            fresh.policyVersion,
            applicationId,
            normalizedAppliedAt,
            normalizedAppliedAt,
            normalizedAppliedAt,
          );
        } else if (change.targetType === "context-utility") {
          this.database.prepare(`
            INSERT INTO memory_context_utility_state (
              memory_id, agent_id, context_key, value, policy_version,
              last_application_id, last_applied_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(memory_id, context_key) DO UPDATE SET
              value = excluded.value,
              policy_version = excluded.policy_version,
              last_application_id = excluded.last_application_id,
              last_applied_at = excluded.last_applied_at,
              updated_at = excluded.updated_at
          `).run(
            change.targetId,
            normalizedAgentId,
            change.contextKey,
            change.appliedValue,
            fresh.policyVersion,
            applicationId,
            normalizedAppliedAt,
            normalizedAppliedAt,
            normalizedAppliedAt,
          );
        } else {
          this.database.prepare(`
            INSERT INTO memory_edge_relation_utility_state (
              edge_id, agent_id, intent_view, value, policy_version,
              last_observation_window_id, last_applied_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(edge_id, intent_view) DO UPDATE SET
              value = excluded.value,
              policy_version = excluded.policy_version,
              last_observation_window_id = excluded.last_observation_window_id,
              last_applied_at = excluded.last_applied_at,
              updated_at = excluded.updated_at
          `).run(
            change.targetId,
            normalizedAgentId,
            change.contextKey,
            change.appliedValue,
            fresh.policyVersion,
            `reward:${normalizedObservationId}`,
            normalizedAppliedAt,
            normalizedAppliedAt,
            normalizedAppliedAt,
          );
        }
      }
      return { ...this.getRewardApplication(normalizedAgentId, applicationId), wasApplied: true };
    });
  }

  rollbackRewardCreditApplication({
    agentId,
    applicationId,
    actor,
    reason,
    rolledBackAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedApplicationId = clean(applicationId);
    const normalizedActor = clean(actor);
    const normalizedReason = clean(reason);
    if (!normalizedAgentId || !normalizedApplicationId || !normalizedActor || !normalizedReason) {
      throw new Error("Rolling back reward credit requires agentId, applicationId, actor, and reason.");
    }
    const application = this.getRewardApplication(normalizedAgentId, normalizedApplicationId);
    if (!application) throw new Error("Reward application does not exist for this Agent.");
    if (application.status === "rolled_back") return { ...application, wasRolledBack: false };
    const timestamp = clean(rolledBackAt) || nowIso();
    if (!validTimestamp(timestamp)) throw new Error("Reward rolledBackAt is invalid.");
    const normalizedRolledBackAt = new Date(timestamp).toISOString();
    if (normalizedRolledBackAt < application.applied_at) {
      throw new Error("Reward rollback cannot predate its application.");
    }
    return this.transaction(() => {
      for (const change of application.changes) {
        const state = change.target_type === "consolidation"
          ? this.getMemoryConsolidationState(normalizedAgentId, change.target_id)
          : change.target_type === "context-utility"
            ? this.getMemoryContextUtilityState(
              normalizedAgentId,
              change.target_id,
              change.context_key,
            )
            : this.getEdgeRelationUtilityState(
              normalizedAgentId,
              change.target_id,
              change.context_key,
            );
        const applicationMatches = change.target_type === "relation-utility"
          ? state?.last_observation_window_id === `reward:${application.observation_id}`
          : state?.last_application_id === application.id;
        if (!state || !applicationMatches
          || !sameNumericValue(state.value, change.appliedValue)
          || state.policy_version !== change.target_policy_version
          || state.last_applied_at !== application.applied_at) {
          throw new Error(`Reward target ${change.target_id} has a later state and cannot be rolled back.`);
        }
      }
      for (const change of application.changes) {
        if (!change.previousExists) {
          if (change.target_type === "consolidation") {
            this.database.prepare(`
              DELETE FROM memory_consolidation_state WHERE agent_id = ? AND memory_id = ?
            `).run(normalizedAgentId, change.target_id);
          } else if (change.target_type === "context-utility") {
            this.database.prepare(`
              DELETE FROM memory_context_utility_state
              WHERE agent_id = ? AND memory_id = ? AND context_key = ?
            `).run(normalizedAgentId, change.target_id, change.context_key);
          } else {
            this.database.prepare(`
              DELETE FROM memory_edge_relation_utility_state
              WHERE agent_id = ? AND edge_id = ? AND intent_view = ?
            `).run(normalizedAgentId, change.target_id, change.context_key);
          }
          continue;
        }
        if (change.target_type === "consolidation") {
          this.database.prepare(`
            UPDATE memory_consolidation_state
            SET value = ?, policy_version = ?, last_application_id = ?,
                last_applied_at = ?, updated_at = ?
            WHERE agent_id = ? AND memory_id = ?
          `).run(
            change.previousValue,
            change.previous_policy_version,
            change.previous_application_id,
            change.previous_applied_at,
            normalizedRolledBackAt,
            normalizedAgentId,
            change.target_id,
          );
        } else if (change.target_type === "context-utility") {
          this.database.prepare(`
            UPDATE memory_context_utility_state
            SET value = ?, policy_version = ?, last_application_id = ?,
                last_applied_at = ?, updated_at = ?
            WHERE agent_id = ? AND memory_id = ? AND context_key = ?
          `).run(
            change.previousValue,
            change.previous_policy_version,
            change.previous_application_id,
            change.previous_applied_at,
            normalizedRolledBackAt,
            normalizedAgentId,
            change.target_id,
            change.context_key,
          );
        } else {
          this.database.prepare(`
            UPDATE memory_edge_relation_utility_state
            SET value = ?, policy_version = ?, last_observation_window_id = ?,
                last_applied_at = ?, updated_at = ?
            WHERE agent_id = ? AND edge_id = ? AND intent_view = ?
          `).run(
            change.previousValue,
            change.previous_policy_version,
            change.previous_observation_window_id,
            change.previous_applied_at,
            normalizedRolledBackAt,
            normalizedAgentId,
            change.target_id,
            change.context_key,
          );
        }
      }
      this.database.prepare(`
        UPDATE memory_reward_applications
        SET status = 'rolled_back', rolled_back_by = ?, rollback_reason = ?, rolled_back_at = ?
        WHERE agent_id = ? AND id = ? AND status = 'applied'
      `).run(
        normalizedActor,
        normalizedReason,
        normalizedRolledBackAt,
        normalizedAgentId,
        normalizedApplicationId,
      );
      return { ...this.getRewardApplication(normalizedAgentId, normalizedApplicationId), wasRolledBack: true };
    });
  }

  getPlasticityShadowRun(agentId, runId) {
    const normalizedAgentId = clean(agentId);
    const normalizedRunId = clean(runId);
    if (!normalizedAgentId || !normalizedRunId) return null;
    const row = this.database.prepare(`
      SELECT * FROM memory_plasticity_shadow_runs
      WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedRunId);
    if (!row) return null;
    const changes = this.database.prepare(`
      SELECT * FROM memory_plasticity_shadow_changes
      WHERE agent_id = ? AND run_id = ?
      ORDER BY target_type ASC, target_id ASC, intent_view ASC
    `).all(normalizedAgentId, normalizedRunId).map(normalizePlasticityShadowChange);
    return normalizePlasticityShadowRun(row, changes);
  }

  listPlasticityShadowRuns(agentId, { limit = 50, offset = 0 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listPlasticityShadowRuns requires agentId.");
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 50)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.database.prepare(`
      SELECT * FROM memory_plasticity_shadow_runs
      WHERE agent_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(normalizedAgentId, maximum, skip)
      .map((row) => normalizePlasticityShadowRun(row));
  }

  recordPlasticityShadowRun({
    id = "",
    agentId,
    policyVersion,
    observationWindowId,
    windowStart,
    windowEnd,
    inputHash,
    changes = [],
    metadata = {},
    createdAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedWindowId = clean(observationWindowId);
    const normalizedInputHash = clean(inputHash).toLowerCase();
    const window = normalizeTimeWindow(windowStart, windowEnd);
    if (!normalizedAgentId || !normalizedPolicyVersion || !normalizedWindowId) {
      throw new Error("Plasticity shadow run requires agentId, policyVersion, and observationWindowId.");
    }
    if (!window.start || !window.end) {
      throw new Error("Plasticity shadow run requires a complete observation window.");
    }
    if (!/^[a-f0-9]{64}$/u.test(normalizedInputHash)) {
      throw new Error("Plasticity shadow run requires a SHA-256 inputHash.");
    }
    if (!Array.isArray(changes)) throw new Error("Plasticity shadow changes must be an array.");
    const existing = this.database.prepare(`
      SELECT * FROM memory_plasticity_shadow_runs
      WHERE agent_id = ? AND policy_version = ? AND observation_window_id = ?
    `).get(normalizedAgentId, normalizedPolicyVersion, normalizedWindowId);
    if (existing) {
      if (existing.input_hash !== normalizedInputHash
        || existing.window_start !== window.start
        || existing.window_end !== window.end) {
        throw new Error("Plasticity observation window was already recorded with different input.");
      }
      return {
        ...this.getPlasticityShadowRun(normalizedAgentId, existing.id),
        wasInserted: false,
      };
    }
    const allowedDirections = new Set(["increase", "decrease", "hold"]);
    const preparedChanges = changes.map((change, index) => {
      const targetType = clean(change?.targetType);
      const targetId = clean(change?.targetId);
      const learningTarget = clean(change?.learningTarget);
      const intentView = clean(change?.intentView);
      const evidenceClass = clean(change?.evidenceClass);
      const evidenceTier = clean(change?.evidenceTier);
      const candidateDirection = clean(change?.candidateDirection);
      const targetPolicyVersion = clean(change?.targetPolicyVersion);
      const baseState = change?.baseState && typeof change.baseState === "object"
        && !Array.isArray(change.baseState) ? change.baseState : {};
      const baseStateExists = Boolean(baseState.exists);
      const baseStateAppliedAt = clean(baseState.appliedAt);
      if (!["memory", "edge"].includes(targetType) || !targetId) {
        throw new Error(`Plasticity shadow change ${index} has an invalid target.`);
      }
      if (!["accessibility", "relation-utility", "manual-review"].includes(learningTarget)) {
        throw new Error(`Plasticity shadow change ${index} has an invalid learning target.`);
      }
      if ((targetType === "memory" && intentView)
        || (targetType === "edge" && !intentView)) {
        throw new Error(`Plasticity shadow change ${index} has an invalid intent view.`);
      }
      if (!evidenceClass || !evidenceTier || !allowedDirections.has(candidateDirection)) {
        throw new Error(`Plasticity shadow change ${index} has incomplete evidence classification.`);
      }
      if (!targetPolicyVersion) {
        throw new Error(`Plasticity shadow change ${index} requires targetPolicyVersion.`);
      }
      if (baseStateAppliedAt && !validTimestamp(baseStateAppliedAt)) {
        throw new Error(`Plasticity shadow change ${index} has an invalid base state timestamp.`);
      }
      const targetExists = targetType === "memory"
        ? this.database.prepare(`
          SELECT 1 FROM memory_nodes WHERE agent_id = ? AND id = ?
        `).get(normalizedAgentId, targetId)
        : this.database.prepare(`
          SELECT 1 FROM memory_edges WHERE agent_id = ? AND id = ?
        `).get(normalizedAgentId, targetId);
      if (!targetExists) {
        throw new Error(`Plasticity shadow change ${index} target is not owned by this Agent.`);
      }
      return {
        id: stableId(
          "plasticity-change",
          normalizedAgentId,
          normalizedPolicyVersion,
          normalizedWindowId,
          targetType,
          targetId,
          learningTarget,
          intentView,
        ),
        targetType,
        targetId,
        learningTarget,
        intentView,
        evidenceClass,
        evidenceTier,
        candidateDirection,
        targetPolicyVersion,
        baseState: {
          exists: baseStateExists,
          value: baseStateExists
            ? unitInterval(baseState.value, `changes[${index}].baseState.value`)
            : null,
          policyVersion: baseStateExists ? clean(baseState.policyVersion) : "",
          observationWindowId: baseStateExists ? clean(baseState.observationWindowId) : "",
          appliedAt: baseStateExists && baseStateAppliedAt
            ? new Date(baseStateAppliedAt).toISOString()
            : null,
        },
        currentValue: unitInterval(change.currentValue, `changes[${index}].currentValue`),
        decayedValue: unitInterval(change.decayedValue, `changes[${index}].decayedValue`),
        positiveStep: unitInterval(change.positiveStep, `changes[${index}].positiveStep`),
        negativeStep: unitInterval(change.negativeStep, `changes[${index}].negativeStep`),
        proposedValue: unitInterval(change.proposedValue, `changes[${index}].proposedValue`),
        blocked: Boolean(change.blocked),
        blockReason: clean(change.blockReason),
        evidence: change.evidence && typeof change.evidence === "object"
          && !Array.isArray(change.evidence) ? change.evidence : {},
      };
    });
    const runId = clean(id) || `plasticity-shadow-${randomUUID()}`;
    const timestamp = clean(createdAt) || nowIso();
    if (!validTimestamp(timestamp)) throw new Error("Plasticity shadow createdAt is invalid.");
    const normalizedCreatedAt = new Date(timestamp).toISOString();
    if (normalizedCreatedAt < window.end) {
      throw new Error("Plasticity shadow observation window has not closed yet.");
    }
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO memory_plasticity_shadow_runs (
          id, agent_id, policy_version, observation_window_id,
          window_start, window_end, input_hash, candidate_count,
          metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runId,
        normalizedAgentId,
        normalizedPolicyVersion,
        normalizedWindowId,
        window.start,
        window.end,
        normalizedInputHash,
        preparedChanges.length,
        json(metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {}, {}),
        normalizedCreatedAt,
      );
      const insertChange = this.database.prepare(`
        INSERT INTO memory_plasticity_shadow_changes (
          id, run_id, agent_id, target_type, target_id, learning_target,
          intent_view, evidence_class, evidence_tier, candidate_direction,
          current_value, decayed_value, positive_step, negative_step,
          proposed_value, blocked, block_reason, evidence_json, created_at,
          target_policy_version, base_state_exists, base_state_policy_version,
          base_state_observation_window_id, base_state_applied_at, base_state_value
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const change of preparedChanges) {
        insertChange.run(
          change.id,
          runId,
          normalizedAgentId,
          change.targetType,
          change.targetId,
          change.learningTarget,
          change.intentView,
          change.evidenceClass,
          change.evidenceTier,
          change.candidateDirection,
          change.currentValue,
          change.decayedValue,
          change.positiveStep,
          change.negativeStep,
          change.proposedValue,
          change.blocked ? 1 : 0,
          change.blockReason,
          json(change.evidence, {}),
          normalizedCreatedAt,
          change.targetPolicyVersion,
          change.baseState.exists ? 1 : 0,
          change.baseState.policyVersion,
          change.baseState.observationWindowId,
          change.baseState.appliedAt,
          change.baseState.value,
        );
      }
      return {
        ...this.getPlasticityShadowRun(normalizedAgentId, runId),
        wasInserted: true,
      };
    });
  }

  getPlasticityApplication(agentId, applicationId) {
    const normalizedAgentId = clean(agentId);
    const normalizedApplicationId = clean(applicationId);
    if (!normalizedAgentId || !normalizedApplicationId) return null;
    const row = this.database.prepare(`
      SELECT * FROM memory_plasticity_applications
      WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, normalizedApplicationId);
    if (!row) return null;
    const changes = this.database.prepare(`
      SELECT * FROM memory_plasticity_application_changes
      WHERE agent_id = ? AND application_id = ?
      ORDER BY target_type ASC, target_id ASC, intent_view ASC
    `).all(normalizedAgentId, normalizedApplicationId)
      .map(normalizePlasticityApplicationChange);
    return normalizePlasticityApplication(row, changes);
  }

  listPlasticityApplications(agentId, { limit = 50, offset = 0 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listPlasticityApplications requires agentId.");
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 50)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    return this.database.prepare(`
      SELECT * FROM memory_plasticity_applications
      WHERE agent_id = ?
      ORDER BY applied_at DESC, id DESC
      LIMIT ? OFFSET ?
    `).all(normalizedAgentId, maximum, skip)
      .map((row) => normalizePlasticityApplication(row));
  }

  applyPlasticityShadowRun({
    agentId,
    runId,
    expectedInputHash,
    actor,
    reason = "",
    appliedAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRunId = clean(runId);
    const normalizedInputHash = clean(expectedInputHash).toLowerCase();
    const normalizedActor = clean(actor);
    if (!normalizedAgentId || !normalizedRunId || !normalizedActor) {
      throw new Error("Applying plasticity requires agentId, runId, and an explicit actor.");
    }
    if (!/^[a-f0-9]{64}$/u.test(normalizedInputHash)) {
      throw new Error("Applying plasticity requires the expected SHA-256 input hash.");
    }
    const run = this.getPlasticityShadowRun(normalizedAgentId, normalizedRunId);
    if (!run) throw new Error("Plasticity shadow run does not exist for this Agent.");
    if (run.input_hash !== normalizedInputHash) {
      throw new Error("Plasticity shadow input hash does not match the explicit approval.");
    }
    const existing = this.database.prepare(`
      SELECT * FROM memory_plasticity_applications
      WHERE agent_id = ? AND run_id = ?
    `).get(normalizedAgentId, normalizedRunId);
    if (existing) {
      if (existing.input_hash !== normalizedInputHash) {
        throw new Error("Plasticity application exists with a different input hash.");
      }
      if (existing.status === "rolled_back") {
        throw new Error("A rolled-back plasticity run cannot be silently reapplied.");
      }
      return {
        ...this.getPlasticityApplication(normalizedAgentId, existing.id),
        wasApplied: false,
      };
    }
    const timestamp = clean(appliedAt) || nowIso();
    if (!validTimestamp(timestamp)) throw new Error("Plasticity appliedAt is invalid.");
    const normalizedAppliedAt = new Date(timestamp).toISOString();
    if (normalizedAppliedAt < run.window_end) {
      throw new Error("Plasticity cannot be applied before its observation window closes.");
    }
    const applicable = run.changes.filter((change) => (
      !change.blocked
      && ((change.target_type === "memory" && change.learning_target === "accessibility")
        || (change.target_type === "edge" && change.learning_target === "relation-utility"))
    ));
    if (!applicable.length) {
      throw new Error("Plasticity shadow run has no unblocked state changes to apply.");
    }
    const applicationId = stableId(
      "plasticity-application",
      normalizedAgentId,
      normalizedRunId,
      normalizedInputHash,
    );
    return this.transaction(() => {
      const snapshots = applicable.map((change, index) => {
        if (!change.targetPolicyVersion) {
          throw new Error(`Plasticity change ${index} has no target policy version.`);
        }
        const state = change.target_type === "memory"
          ? this.getMemoryAccessibilityState(normalizedAgentId, change.target_id)
          : this.getEdgeRelationUtilityState(
            normalizedAgentId,
            change.target_id,
            change.intent_view,
          );
        const expected = change.baseState || { exists: false, value: null };
        if (Boolean(state) !== Boolean(expected.exists)) {
          throw new Error(`Plasticity target ${change.target_id} changed after shadow evaluation.`);
        }
        if (state) {
          const actualAppliedAt = state.last_applied_at || null;
          if (!sameNumericValue(state.value, expected.value)
            || state.policy_version !== expected.policyVersion
            || state.last_observation_window_id !== expected.observationWindowId
            || actualAppliedAt !== expected.appliedAt) {
            throw new Error(`Plasticity target ${change.target_id} changed after shadow evaluation.`);
          }
        }
        const target = change.target_type === "memory"
          ? this.database.prepare(`
            SELECT status FROM memory_nodes WHERE agent_id = ? AND id = ?
          `).get(normalizedAgentId, change.target_id)
          : this.database.prepare(`
            SELECT 1 AS exists_flag FROM memory_edges WHERE agent_id = ? AND id = ?
          `).get(normalizedAgentId, change.target_id);
        if (!target || (change.target_type === "memory" && target.status !== "active")) {
          throw new Error(`Plasticity target ${change.target_id} is no longer active.`);
        }
        return { change, state };
      });
      this.database.prepare(`
        INSERT INTO memory_plasticity_applications (
          id, run_id, agent_id, input_hash, status, applied_count, skipped_count,
          applied_by, application_reason, applied_at
        ) VALUES (?, ?, ?, ?, 'applied', ?, ?, ?, ?, ?)
      `).run(
        applicationId,
        normalizedRunId,
        normalizedAgentId,
        normalizedInputHash,
        snapshots.length,
        run.changes.length - snapshots.length,
        normalizedActor,
        clean(reason),
        normalizedAppliedAt,
      );
      const insertAudit = this.database.prepare(`
        INSERT INTO memory_plasticity_application_changes (
          id, application_id, shadow_change_id, agent_id, target_type, target_id,
          intent_view, target_policy_version, previous_exists, previous_value,
          previous_policy_version, previous_observation_window_id, previous_applied_at,
          applied_value, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const { change, state } of snapshots) {
        insertAudit.run(
          stableId("plasticity-applied-change", applicationId, change.id),
          applicationId,
          change.id,
          normalizedAgentId,
          change.target_type,
          change.target_id,
          change.intent_view,
          change.targetPolicyVersion,
          state ? 1 : 0,
          state?.value ?? null,
          state?.policy_version || "",
          state?.last_observation_window_id || "",
          state?.last_applied_at || null,
          change.proposedValue,
          normalizedAppliedAt,
        );
        if (change.target_type === "memory") {
          this.database.prepare(`
            INSERT INTO memory_accessibility_state (
              memory_id, agent_id, value, policy_version,
              last_observation_window_id, last_applied_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(memory_id) DO UPDATE SET
              value = excluded.value,
              policy_version = excluded.policy_version,
              last_observation_window_id = excluded.last_observation_window_id,
              last_applied_at = excluded.last_applied_at,
              updated_at = excluded.updated_at
          `).run(
            change.target_id,
            normalizedAgentId,
            change.proposedValue,
            change.targetPolicyVersion,
            run.observation_window_id,
            normalizedAppliedAt,
            normalizedAppliedAt,
            normalizedAppliedAt,
          );
        } else {
          this.database.prepare(`
            INSERT INTO memory_edge_relation_utility_state (
              edge_id, agent_id, intent_view, value, policy_version,
              last_observation_window_id, last_applied_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(edge_id, intent_view) DO UPDATE SET
              value = excluded.value,
              policy_version = excluded.policy_version,
              last_observation_window_id = excluded.last_observation_window_id,
              last_applied_at = excluded.last_applied_at,
              updated_at = excluded.updated_at
          `).run(
            change.target_id,
            normalizedAgentId,
            change.intent_view,
            change.proposedValue,
            change.targetPolicyVersion,
            run.observation_window_id,
            normalizedAppliedAt,
            normalizedAppliedAt,
            normalizedAppliedAt,
          );
        }
      }
      return {
        ...this.getPlasticityApplication(normalizedAgentId, applicationId),
        wasApplied: true,
      };
    });
  }

  rollbackPlasticityApplication({
    agentId,
    applicationId,
    actor,
    reason,
    rolledBackAt = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedApplicationId = clean(applicationId);
    const normalizedActor = clean(actor);
    const normalizedReason = clean(reason);
    if (!normalizedAgentId || !normalizedApplicationId || !normalizedActor || !normalizedReason) {
      throw new Error("Rolling back plasticity requires agentId, applicationId, actor, and reason.");
    }
    const application = this.getPlasticityApplication(
      normalizedAgentId,
      normalizedApplicationId,
    );
    if (!application) throw new Error("Plasticity application does not exist for this Agent.");
    if (application.status === "rolled_back") {
      return { ...application, wasRolledBack: false };
    }
    const timestamp = clean(rolledBackAt) || nowIso();
    if (!validTimestamp(timestamp)) throw new Error("Plasticity rolledBackAt is invalid.");
    const normalizedRolledBackAt = new Date(timestamp).toISOString();
    if (normalizedRolledBackAt < application.applied_at) {
      throw new Error("Plasticity rollback cannot predate its application.");
    }
    const run = this.getPlasticityShadowRun(normalizedAgentId, application.run_id);
    if (!run) throw new Error("Plasticity shadow run is missing for this application.");
    return this.transaction(() => {
      for (const change of application.changes) {
        const state = change.target_type === "memory"
          ? this.getMemoryAccessibilityState(normalizedAgentId, change.target_id)
          : this.getEdgeRelationUtilityState(
            normalizedAgentId,
            change.target_id,
            change.intent_view,
          );
        if (!state
          || !sameNumericValue(state.value, change.appliedValue)
          || state.policy_version !== change.target_policy_version
          || state.last_observation_window_id !== run.observation_window_id
          || state.last_applied_at !== application.applied_at) {
          throw new Error(`Plasticity target ${change.target_id} has a later state and cannot be rolled back.`);
        }
      }
      for (const change of application.changes) {
        if (!change.previousExists) {
          if (change.target_type === "memory") {
            this.database.prepare(`
              DELETE FROM memory_accessibility_state
              WHERE agent_id = ? AND memory_id = ?
            `).run(normalizedAgentId, change.target_id);
          } else {
            this.database.prepare(`
              DELETE FROM memory_edge_relation_utility_state
              WHERE agent_id = ? AND edge_id = ? AND intent_view = ?
            `).run(normalizedAgentId, change.target_id, change.intent_view);
          }
          continue;
        }
        if (change.target_type === "memory") {
          this.database.prepare(`
            UPDATE memory_accessibility_state
            SET value = ?, policy_version = ?, last_observation_window_id = ?,
                last_applied_at = ?, updated_at = ?
            WHERE agent_id = ? AND memory_id = ?
          `).run(
            change.previousValue,
            change.previous_policy_version,
            change.previous_observation_window_id,
            change.previous_applied_at,
            normalizedRolledBackAt,
            normalizedAgentId,
            change.target_id,
          );
        } else {
          this.database.prepare(`
            UPDATE memory_edge_relation_utility_state
            SET value = ?, policy_version = ?, last_observation_window_id = ?,
                last_applied_at = ?, updated_at = ?
            WHERE agent_id = ? AND edge_id = ? AND intent_view = ?
          `).run(
            change.previousValue,
            change.previous_policy_version,
            change.previous_observation_window_id,
            change.previous_applied_at,
            normalizedRolledBackAt,
            normalizedAgentId,
            change.target_id,
            change.intent_view,
          );
        }
      }
      this.database.prepare(`
        UPDATE memory_plasticity_applications
        SET status = 'rolled_back', rolled_back_by = ?, rollback_reason = ?, rolled_back_at = ?
        WHERE agent_id = ? AND id = ? AND status = 'applied'
      `).run(
        normalizedActor,
        normalizedReason,
        normalizedRolledBackAt,
        normalizedAgentId,
        normalizedApplicationId,
      );
      return {
        ...this.getPlasticityApplication(normalizedAgentId, normalizedApplicationId),
        wasRolledBack: true,
      };
    });
  }

  recordAffectiveActivationDecision({
    id = "",
    agentId,
    memoryId,
    enabled,
    policyVersion,
    actor,
    reason,
    createdAt = nowIso(),
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedActor = clean(actor);
    const normalizedReason = clean(reason);
    if (!normalizedAgentId || !normalizedMemoryId || !normalizedPolicyVersion
      || !normalizedActor || !normalizedReason || typeof enabled !== "boolean") {
      throw new Error("Affective activation decision requires memory, enabled, policy, actor, and reason.");
    }
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId
      || memory.state_family !== "affective_association"
      || !["reported", "established"].includes(memory.representation_layer)) {
      throw new Error("Affective activation decision requires an affective state for the same Agent.");
    }
    if (enabled) {
      const claim = memory.metadata?.reportedStateDraft?.affectiveClaim
        || memory.metadata?.affectiveClaim
        || null;
      if (memory.status !== "active" || memory.temporal_state !== "current"
        || !clean(claim?.trigger?.key) || !clean(claim?.trigger?.label)
        || !clean(claim?.emotion?.label)
        || !["positive", "negative", "mixed", "neutral"].includes(clean(claim?.emotion?.valence))
        || !["low", "medium", "high"].includes(clean(claim?.emotion?.intensity))) {
        throw new Error("Only a current structured affective state can be enabled for activation.");
      }
      const current = this.getCurrentCanonicalMemory({
        agentId: normalizedAgentId,
        subjectRole: memory.subject_role,
        subjectKey: memory.subject_key,
        canonicalKey: memory.canonical_key,
        representationLayer: memory.representation_layer,
        stateFamily: "affective_association",
        stateScopeKey: memory.state_scope_key,
      });
      if (current?.id !== memory.id) {
        throw new Error("Only the current affective state can be enabled for activation.");
      }
    }
    const timestamp = new Date(clean(createdAt));
    if (!Number.isFinite(timestamp.getTime())) {
      throw new Error("Affective activation decision createdAt is invalid.");
    }
    const decisionId = clean(id) || `affective-activation-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO memory_affective_activation_decisions (
        id, memory_id, agent_id, enabled, policy_version, actor, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decisionId,
      normalizedMemoryId,
      normalizedAgentId,
      enabled ? 1 : 0,
      normalizedPolicyVersion,
      normalizedActor,
      normalizedReason,
      timestamp.toISOString(),
    );
    return normalizeAffectiveActivationDecision(this.database.prepare(`
      SELECT * FROM memory_affective_activation_decisions
      WHERE agent_id = ? AND id = ?
    `).get(normalizedAgentId, decisionId));
  }

  listAffectiveActivationDecisions(agentId, { memoryId = "", limit = 100 } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listAffectiveActivationDecisions requires agentId.");
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (clean(memoryId)) {
      clauses.push("memory_id = ?");
      parameters.push(clean(memoryId));
    }
    return this.database.prepare(`
      SELECT * FROM memory_affective_activation_decisions
      WHERE ${clauses.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(
      ...parameters,
      Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100))),
    ).map(normalizeAffectiveActivationDecision);
  }

  listEnabledAffectiveActivations(agentId, {
    policyVersions = [],
    representationLayers = [],
    subjectRole = "",
    subjectKey = "",
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listEnabledAffectiveActivations requires agentId.");
    const policies = cleanStringList(policyVersions);
    const layers = cleanStringList(representationLayers);
    if (!policies.length || !layers.length) return [];
    if (layers.some((layer) => !["reported", "established"].includes(layer))) {
      throw new Error("Affective activation representation layer must be reported or established.");
    }
    const clauses = [
      "decision.agent_id = ?",
      "decision.enabled = 1",
      `decision.policy_version IN (${policies.map(() => "?").join(", ")})`,
      `memory.representation_layer IN (${layers.map(() => "?").join(", ")})`,
      "memory.state_family = 'affective_association'",
      "memory.status = 'active'",
      "memory.temporal_state = 'current'",
    ];
    const parameters = [normalizedAgentId, ...policies, ...layers];
    if (clean(subjectRole)) {
      clauses.push("memory.subject_role = ?");
      parameters.push(clean(subjectRole));
    }
    if (clean(subjectKey)) {
      clauses.push("memory.subject_key = ?");
      parameters.push(clean(subjectKey));
    }
    return this.database.prepare(`
      SELECT decision.id AS decision_id
      FROM memory_affective_activation_decisions AS decision
      JOIN memory_nodes AS memory
        ON memory.id = decision.memory_id AND memory.agent_id = decision.agent_id
      WHERE ${clauses.join(" AND ")}
        AND NOT EXISTS (
          SELECT 1 FROM memory_affective_activation_decisions AS newer
          WHERE newer.agent_id = decision.agent_id
            AND newer.memory_id = decision.memory_id
            AND (
              newer.created_at > decision.created_at
              OR (newer.created_at = decision.created_at AND newer.id > decision.id)
            )
        )
      ORDER BY decision.created_at DESC, decision.id DESC
    `).all(...parameters).map(({ decision_id: decisionId }) => {
      const decision = normalizeAffectiveActivationDecision(this.database.prepare(`
        SELECT * FROM memory_affective_activation_decisions
        WHERE agent_id = ? AND id = ?
      `).get(normalizedAgentId, decisionId));
      return { decision, memory: this.getMemory(decision.memoryId) };
    });
  }

  listMemories(agentId, {
    query = "",
    statuses = ["active"],
    kinds = [],
    limit = 50,
    offset = 0,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    if (!normalizedAgentId) throw new Error("listMemories 需要 agentId。");
    const normalizedStatuses = [...new Set(
      (Array.isArray(statuses) ? statuses : [statuses]).map(clean).filter(Boolean),
    )];
    const normalizedKinds = [...new Set(
      (Array.isArray(kinds) ? kinds : [kinds]).map(clean).filter(Boolean),
    )];
    const maximum = Math.min(200, Math.max(1, Math.trunc(Number(limit) || 50)));
    const skip = Math.max(0, Math.trunc(Number(offset) || 0));
    const clauses = ["agent_id = ?"];
    const parameters = [normalizedAgentId];
    if (normalizedStatuses.length) {
      clauses.push(`status IN (${normalizedStatuses.map(() => "?").join(", ")})`);
      parameters.push(...normalizedStatuses);
    }
    if (normalizedKinds.length) {
      clauses.push(`kind IN (${normalizedKinds.map(() => "?").join(", ")})`);
      parameters.push(...normalizedKinds);
    }
    const text = clean(query);
    if (text) {
      clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')");
      const pattern = `%${text.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
      parameters.push(pattern, pattern);
    }
    const rows = this.database.prepare(`
      SELECT * FROM memory_nodes
      WHERE ${clauses.join(" AND ")}
      ORDER BY
        CASE status WHEN 'active' THEN 0 WHEN 'deleted' THEN 2 ELSE 1 END,
        COALESCE(event_date, event_start, recorded_at) DESC,
        updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...parameters, maximum, skip).map(normalizeNode);
    const total = Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM memory_nodes
      WHERE ${clauses.join(" AND ")}
    `).get(...parameters).count || 0);
    return {
      items: rows,
      total,
      limit: maximum,
      offset: skip,
    };
  }

  listMemorySources(memoryId) {
    return this.database.prepare(`
        SELECT source.*, link.relation, link.authority,
               link.source_trust, link.evidence_strength,
               link.provenance AS evidence_provenance,
               link.metadata_json AS link_metadata_json,
               link.updated_at AS evidence_updated_at
        FROM memory_sources AS link
        JOIN source_records AS source ON source.id = link.source_id
        WHERE link.memory_id = ?
        ORDER BY source.occurred_at ASC, source.recorded_at ASC
      `).all(memoryId).map(normalizeEvidenceSource);
  }

  getMemoryDetail(agentId, memoryId) {
    const memory = this.getMemory(memoryId);
    if (!memory || memory.agent_id !== clean(agentId)) return null;
    return {
      memory,
      sources: this.listMemorySources(memoryId),
      roles: this.listMemoryRoles(memoryId),
      actorEntities: this.listMemoryActorEntities(memoryId),
      entities: this.listMemoryEntities(memoryId),
      relationships: this.listMemoryRelationships(memoryId),
      edges: this.database.prepare(`
        SELECT * FROM memory_edges
        WHERE agent_id = ? AND (from_memory_id = ? OR to_memory_id = ?)
        ORDER BY updated_at DESC
      `).all(agentId, memoryId, memoryId).map(normalizeEdge),
      mutations: this.database.prepare(`
        SELECT * FROM memory_mutations
        WHERE agent_id = ? AND memory_id = ?
        ORDER BY created_at DESC, rowid DESC
      `).all(agentId, memoryId).map((row) => ({
        ...row,
        before: parseJson(row.before_json, {}),
        after: parseJson(row.after_json, {}),
      })),
    };
  }

  recordMutation({
    agentId,
    memoryId,
    action,
    actor = "human",
    reason = "",
    before,
    after,
  }) {
    const mutationId = `mutation-${randomUUID()}`;
    this.database.prepare(`
      INSERT INTO memory_mutations (
        id, agent_id, memory_id, action, actor, reason,
        before_json, after_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      mutationId,
      clean(agentId),
      clean(memoryId),
      clean(action),
      clean(actor) || "human",
      clean(reason),
      json(nodeSnapshot(before), {}),
      json(nodeSnapshot(after), {}),
      nowIso(),
    );
    return mutationId;
  }

  editMemoryManually({
    agentId,
    memoryId,
    patch = {},
    actor = "human",
    reason = "",
  }) {
    const before = this.getMemory(memoryId);
    if (!before || before.agent_id !== clean(agentId)) throw new Error("没有找到要编辑的记忆。");
    const content = Object.hasOwn(patch, "content") ? String(patch.content ?? "") : before.content;
    if (!content.trim()) throw new Error("记忆正文不能为空。");
    const eventDate = Object.hasOwn(patch, "eventDate")
      ? clean(patch.eventDate) || null
      : before.event_date;
    if (eventDate && !/^\d{4}-\d{2}-\d{2}$/u.test(eventDate)) {
      throw new Error("事件日期必须为空或 YYYY-MM-DD。");
    }
    const continuityFingerprint = eventContinuityFingerprint(this, agentId, memoryId);
    let invalidatedMemoryIds = [];
    let after;
    this.transaction(() => {
      after = this.upsertMemory({
        id: before.id,
        agentId: before.agent_id,
        kind: clean(patch.kind) || before.kind,
        layer: clean(patch.layer) || before.layer,
        title: Object.hasOwn(patch, "title") ? patch.title : before.title,
        content,
        subjectRole: clean(patch.subjectRole) || before.subject_role,
        subjectKey: Object.hasOwn(patch, "subjectKey") ? patch.subjectKey : before.subject_key,
        canonicalKey: Object.hasOwn(patch, "canonicalKey") ? patch.canonicalKey : before.canonical_key,
        reality: clean(patch.reality) || before.reality,
        worldId: Object.hasOwn(patch, "worldId") ? patch.worldId : before.world_id,
        worldFrame: Object.hasOwn(patch, "worldFrame") ? patch.worldFrame : before.world_frame,
        evidenceMode: "manual",
        representationLayer: Object.hasOwn(patch, "representationLayer")
          ? patch.representationLayer
          : before.representation_layer,
        stateFamily: Object.hasOwn(patch, "stateFamily")
          ? patch.stateFamily
          : before.state_family,
        statePhase: Object.hasOwn(patch, "statePhase")
          ? patch.statePhase
          : before.state_phase,
        stateScopeKey: before.state_scope_key,
        temporalState: clean(patch.temporalState) || before.temporal_state,
        revisionAction: before.revision_action,
        eventDate,
        eventStart: Object.hasOwn(patch, "eventStart") ? patch.eventStart || null : before.event_start,
        eventEnd: Object.hasOwn(patch, "eventEnd") ? patch.eventEnd || null : before.event_end,
        knownAt: Object.hasOwn(patch, "knownAt") ? patch.knownAt || null : before.known_at,
        validFrom: before.valid_from,
        validTo: before.valid_to,
        recordedAt: before.recorded_at,
        status: before.status,
        confidence: Object.hasOwn(patch, "confidence") ? patch.confidence : before.confidence,
        importance: Object.hasOwn(patch, "importance") ? patch.importance : before.importance,
        perspective: Object.hasOwn(patch, "perspective") ? patch.perspective : before.perspective,
        metadata: {
          ...before.metadata,
          manuallyEdited: true,
        },
      });
      this.database.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(memoryId);
      if ((before.kind === 'event' || after.kind === 'event') && continuityFingerprint !== eventContinuityFingerprint(this, agentId, memoryId)) {
        invalidatedMemoryIds = invalidateEventContinuity(this, { agentId, memoryId });
        after = this.getMemory(memoryId);
      }
      this.database.prepare(`
        DELETE FROM memory_edges
        WHERE agent_id = ? AND provenance = 'association-builder-v1'
          AND (from_memory_id = ? OR to_memory_id = ?)
      `).run(agentId, memoryId, memoryId);
      this.recordMutation({
        agentId,
        memoryId,
        action: "edit",
        actor,
        reason,
        before,
        after,
      });
    });
    return { ...after, eventContinuityInvalidatedMemoryIds: invalidatedMemoryIds };
  }

  updateMemoryMetadata({
    agentId,
    memoryId,
    metadata,
    actor = "system",
    reason = "",
  }) {
    const before = this.getMemory(memoryId);
    const normalizedMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? metadata
      : null;
    if (!before || before.agent_id !== clean(agentId)) throw new Error("没有找到要更新元数据的记忆。");
    if (!normalizedMetadata) throw new Error("记忆元数据必须是对象。");
    let after;
    this.transaction(() => {
      this.database.prepare(`
        UPDATE memory_nodes
        SET metadata_json = ?, updated_at = ?
        WHERE agent_id = ? AND id = ?
      `).run(
        json(normalizedMetadata, {}),
        nowIso(),
        clean(agentId),
        before.id,
      );
      after = this.getMemory(before.id);
      this.recordMutation({
        agentId: clean(agentId),
        memoryId: before.id,
        action: "edit",
        actor: clean(actor) || "system",
        reason: clean(reason),
        before,
        after,
      });
    });
    return after;
  }

  setMemoryDeleted({
    agentId,
    memoryId,
    deleted = true,
    actor = "human",
    reason = "",
  }) {
    const before = this.getMemory(memoryId);
    if (!before || before.agent_id !== clean(agentId)) throw new Error("没有找到要修改的记忆。");
    const targetStatus = deleted ? "deleted" : "active";
    if (before.status === targetStatus) return before;
    let invalidatedMemoryIds = [];
    let after;
    this.transaction(() => {
      after = this.updateMemoryStatus(memoryId, targetStatus);
      if (before.kind === 'event') {
        invalidatedMemoryIds = invalidateEventContinuity(this, { agentId, memoryId,
          reason: deleted ? '事件已删除，原关联判断失效。' : '事件已恢复，需要重新判断关联。' });
        after = this.getMemory(memoryId);
      }
      if (deleted) {
        this.database.prepare(`
          DELETE FROM memory_edges
          WHERE agent_id = ? AND provenance = 'association-builder-v1'
            AND (from_memory_id = ? OR to_memory_id = ?)
        `).run(agentId, memoryId, memoryId);
      }
      this.recordMutation({
        agentId,
        memoryId,
        action: deleted ? "delete" : "restore",
        actor,
        reason,
        before,
        after,
      });
    });
    return { ...after, eventContinuityInvalidatedMemoryIds: invalidatedMemoryIds };
  }

  findCanonicalMemories({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer = "",
    stateFamily = "",
    stateScopeKey = "",
    statuses = ["active"],
  }) {
    const normalizedStatuses = [...new Set(statuses.map(clean).filter(Boolean))];
    const normalizedRepresentationLayer = clean(representationLayer);
    const normalizedStateFamily = clean(stateFamily);
    const normalizedStateScopeKey = clean(stateScopeKey)
      || (normalizedStateFamily && normalizedStateFamily !== NON_STATE_SCOPE_KEY
        ? ROOT_STATE_SCOPE_KEY
        : normalizedStateFamily === NON_STATE_SCOPE_KEY ? NON_STATE_SCOPE_KEY : "");
    if (normalizedRepresentationLayer && !REPRESENTATION_LAYERS.includes(normalizedRepresentationLayer)) {
      throw new Error("Canonical memory representationLayer is invalid.");
    }
    if (normalizedStateFamily && !MEMORY_STATE_FAMILY_STORAGE_VALUES.includes(normalizedStateFamily)) {
      throw new Error("Canonical memory stateFamily is invalid.");
    }
    if (normalizedStateScopeKey && !isValidStateScopeKey(normalizedStateScopeKey)) {
      throw new Error("Canonical memory stateScopeKey is invalid.");
    }
    if (!normalizedStatuses.length) return [];
    const representationFilter = normalizedRepresentationLayer ? "AND representation_layer = ?" : "";
    const stateFamilyFilter = normalizedStateFamily ? "AND state_family = ?" : "";
    const stateScopeFilter = normalizedStateScopeKey ? "AND state_scope_key = ?" : "";
    return this.database.prepare(`
      SELECT * FROM memory_nodes
      WHERE agent_id = ?
        AND subject_role = ?
        AND subject_key = ?
        AND canonical_key = ?
        ${representationFilter}
        ${stateFamilyFilter}
        ${stateScopeFilter}
        AND status IN (${normalizedStatuses.map(() => "?").join(", ")})
      ORDER BY updated_at DESC
    `).all(
      agentId,
      subjectRole,
      subjectKey,
      canonicalKey,
      ...(normalizedRepresentationLayer ? [normalizedRepresentationLayer] : []),
      ...(normalizedStateFamily ? [normalizedStateFamily] : []),
      ...(normalizedStateScopeKey ? [normalizedStateScopeKey] : []),
      ...normalizedStatuses,
    ).map(normalizeNode);
  }

  listEntities(agentId, { kind = "" } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedKind = clean(kind).toLocaleLowerCase("en-US");
    const rows = normalizedKind
      ? this.database.prepare(`
        SELECT * FROM entities
        WHERE agent_id = ? AND kind = ?
        ORDER BY canonical_name ASC, id ASC
      `).all(normalizedAgentId, normalizedKind)
      : this.database.prepare(`
        SELECT * FROM entities
        WHERE agent_id = ?
        ORDER BY kind ASC, canonical_name ASC, id ASC
      `).all(normalizedAgentId);
    return rows.map(normalizeEntity);
  }

  getEntity(agentId, entityId) {
    return normalizeEntity(this.database.prepare(`
      SELECT * FROM entities WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(entityId)));
  }

  findEntityByName({ agentId, kind, name }) {
    const key = entityNameKey(name);
    if (!key) return null;
    const matches = this.listEntities(agentId, { kind }).filter((entity) => (
      [entity.canonical_name, ...entity.aliases].some((label) => entityNameKey(label) === key)
    ));
    if (matches.length > 1) {
      throw new Error(`Entity name is ambiguous for this Agent: ${normalizedEntityName(name)}`);
    }
    return matches[0] || null;
  }

  upsertEntity({
    id = "",
    agentId,
    kind,
    canonicalName,
    aliases = [],
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedKind = clean(kind).toLocaleLowerCase("en-US");
    const normalizedCanonicalName = normalizedEntityName(canonicalName);
    if (!normalizedAgentId || !normalizedKind || !normalizedCanonicalName) {
      throw new Error("Entity requires agentId, kind, and canonicalName.");
    }
    const requestedId = clean(id);
    const byId = requestedId ? this.getEntity(normalizedAgentId, requestedId) : null;
    const byName = this.findEntityByName({
      agentId: normalizedAgentId,
      kind: normalizedKind,
      name: normalizedCanonicalName,
    });
    if (byId && byName && byId.id !== byName.id) {
      throw new Error("Entity id and canonical name resolve to different existing entities.");
    }
    const existing = byId || byName;
    const normalizedAliases = (Array.isArray(aliases) ? aliases : [])
      .map(normalizedEntityName)
      .filter(Boolean);
    for (const alias of normalizedAliases) {
      const conflict = this.findEntityByName({
        agentId: normalizedAgentId,
        kind: normalizedKind,
        name: alias,
      });
      if (conflict && conflict.id !== existing?.id) {
        throw new Error(`Entity alias already belongs to another entity: ${alias}`);
      }
    }
    const entityId = existing?.id || requestedId || stableId(
      "entity",
      normalizedAgentId,
      normalizedKind,
      entityNameKey(normalizedCanonicalName),
    );
    const storedCanonicalName = existing?.canonical_name || normalizedCanonicalName;
    const canonicalKey = entityNameKey(storedCanonicalName);
    const mergedAliases = [
      ...(existing?.aliases || []),
      ...(existing && entityNameKey(normalizedCanonicalName) !== canonicalKey
        ? [normalizedCanonicalName]
        : []),
      ...normalizedAliases,
    ].filter((alias, index, values) => (
      entityNameKey(alias) !== canonicalKey
      && values.findIndex((candidate) => entityNameKey(candidate) === entityNameKey(alias)) === index
    ));
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO entities (
        id, agent_id, kind, canonical_name, aliases_json,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        canonical_name = excluded.canonical_name,
        aliases_json = excluded.aliases_json,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      entityId,
      normalizedAgentId,
      normalizedKind,
      storedCanonicalName,
      json(mergedAliases, []),
      json({ ...(existing?.metadata || {}), ...metadata }, {}),
      existing?.created_at || timestamp,
      timestamp,
    );
    return this.getEntity(normalizedAgentId, entityId);
  }

  linkMemoryEntity({ memoryId, entityId, role = "about" }) {
    const memory = this.getMemory(memoryId);
    if (!memory) throw new Error("Memory entity link requires an existing memory.");
    const entity = this.getEntity(memory.agent_id, entityId);
    if (!entity) throw new Error("Memory entity link requires an entity from the same Agent.");
    const normalizedRole = clean(role) || "about";
    this.database.prepare(`
      INSERT INTO memory_entities (memory_id, entity_id, role, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id, entity_id, role) DO NOTHING
    `).run(memory.id, entity.id, normalizedRole, nowIso());
    return this.listMemoryEntities(memory.id).find((item) => (
      item.id === entity.id && item.link_role === normalizedRole
    ));
  }

  unlinkMemoryEntity({ memoryId, entityId, role = "about" }) {
    return Number(this.database.prepare(`
      DELETE FROM memory_entities
      WHERE memory_id = ? AND entity_id = ? AND role = ?
    `).run(clean(memoryId), clean(entityId), clean(role) || "about").changes || 0);
  }

  listMemoryEntities(memoryId) {
    return this.database.prepare(`
      SELECT entity.*, link.role AS link_role, link.created_at AS linked_at
      FROM memory_entities AS link
      JOIN entities AS entity ON entity.id = link.entity_id
      WHERE link.memory_id = ?
      ORDER BY link.role ASC, entity.canonical_name ASC, entity.id ASC
    `).all(clean(memoryId)).map(normalizeEntity);
  }

  listEntityMemories({ agentId, entityId, statuses = ["active"] }) {
    const normalizedStatuses = [...new Set(statuses.map(clean).filter(Boolean))];
    if (!normalizedStatuses.length) return [];
    return this.database.prepare(`
      SELECT memory.*, link.role AS entity_role
      FROM memory_entities AS link
      JOIN memory_nodes AS memory ON memory.id = link.memory_id
      WHERE memory.agent_id = ? AND link.entity_id = ?
        AND memory.status IN (${normalizedStatuses.map(() => "?").join(", ")})
      ORDER BY COALESCE(memory.event_start, memory.known_at, memory.recorded_at) DESC,
        memory.updated_at DESC
    `).all(
      clean(agentId),
      clean(entityId),
      ...normalizedStatuses,
    ).map(normalizeNode);
  }

  getActorEntityBinding({ agentId, actorRole, actorKey }) {
    return normalizeActorEntityBinding(this.database.prepare(`
      SELECT * FROM actor_entity_bindings
      WHERE agent_id = ? AND actor_role = ? AND actor_key = ?
    `).get(clean(agentId), clean(actorRole), clean(actorKey)));
  }

  listActorEntityBindings(agentId, { actorRole = "", entityId = "" } = {}) {
    const clauses = ["binding.agent_id = ?"];
    const parameters = [clean(agentId)];
    if (clean(actorRole)) {
      clauses.push("binding.actor_role = ?");
      parameters.push(clean(actorRole));
    }
    if (clean(entityId)) {
      clauses.push("binding.entity_id = ?");
      parameters.push(clean(entityId));
    }
    return this.database.prepare(`
      SELECT binding.*
      FROM actor_entity_bindings AS binding
      WHERE ${clauses.join(" AND ")}
      ORDER BY binding.actor_role ASC, binding.actor_key ASC
    `).all(...parameters).map(normalizeActorEntityBinding);
  }

  bindActorEntity({
    agentId,
    actorRole,
    actorKey,
    entityId,
    displayName = "",
    provenance = "",
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedActorRole = clean(actorRole);
    const normalizedActorKey = clean(actorKey);
    const normalizedEntityId = clean(entityId);
    if (!normalizedAgentId || !["user", "agent", "other"].includes(normalizedActorRole)
      || !normalizedActorKey || !normalizedEntityId) {
      throw new Error("Actor entity binding requires a personal actor and entity.");
    }
    const entity = this.getEntity(normalizedAgentId, normalizedEntityId);
    if (!entity) throw new Error("Actor entity binding requires an entity from the same Agent.");
    const normalizedDisplayName = normalizedEntityName(displayName) || entity.canonical_name;
    const existing = this.getActorEntityBinding({
      agentId: normalizedAgentId,
      actorRole: normalizedActorRole,
      actorKey: normalizedActorKey,
    });
    if (existing && existing.entity_id !== normalizedEntityId) {
      throw new Error("Actor identity is already bound to another entity.");
    }
    const normalizedProvenance = clean(provenance);
    const normalizedMetadata = metadata ?? {};
    if (existing
      && existing.display_name === normalizedDisplayName
      && existing.provenance === normalizedProvenance
      && canonicalJson(existing.metadata, {}) === canonicalJson(normalizedMetadata, {})) {
      return existing;
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO actor_entity_bindings (
        agent_id, actor_role, actor_key, entity_id, display_name,
        provenance, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, actor_role, actor_key) DO UPDATE SET
        display_name = excluded.display_name,
        provenance = excluded.provenance,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      normalizedAgentId,
      normalizedActorRole,
      normalizedActorKey,
      normalizedEntityId,
      normalizedDisplayName,
      normalizedProvenance,
      json(normalizedMetadata, {}),
      existing?.created_at || timestamp,
      timestamp,
    );
    return this.getActorEntityBinding({
      agentId: normalizedAgentId,
      actorRole: normalizedActorRole,
      actorKey: normalizedActorKey,
    });
  }

  ensureActorEntity({
    agentId,
    actorRole,
    actorKey,
    displayName,
    aliases = [],
    provenance = "",
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedActorRole = clean(actorRole);
    const normalizedActorKey = clean(actorKey);
    const normalizedDisplayName = normalizedEntityName(displayName);
    if (!normalizedAgentId || !["user", "agent", "other"].includes(normalizedActorRole)
      || !normalizedActorKey || !normalizedDisplayName) {
      throw new Error("Actor entity requires agentId, personal actor identity, and displayName.");
    }
    const bound = this.getActorEntityBinding({
      agentId: normalizedAgentId,
      actorRole: normalizedActorRole,
      actorKey: normalizedActorKey,
    });
    if (bound) {
      const entity = this.getEntity(normalizedAgentId, bound.entity_id);
      if (!entity) throw new Error("Actor entity binding points to a missing entity.");
      const canonicalKey = entityNameKey(entity.canonical_name);
      const desiredAliases = [
        ...entity.aliases,
        ...(entityNameKey(normalizedDisplayName) === canonicalKey ? [] : [normalizedDisplayName]),
        ...(Array.isArray(aliases) ? aliases : []),
      ].map(normalizedEntityName).filter((alias, index, values) => (
        alias && entityNameKey(alias) !== canonicalKey
        && (!this.findEntityByName({ agentId: normalizedAgentId, kind: entity.kind, name: alias })
          || this.findEntityByName({ agentId: normalizedAgentId, kind: entity.kind, name: alias }).id === entity.id)
        && values.findIndex((candidate) => (
          entityNameKey(candidate) === entityNameKey(alias)
        )) === index
      ));
      const desiredEntityMetadata = { ...entity.metadata, ...metadata };
      const updated = canonicalJson(entity.aliases, []) === canonicalJson(desiredAliases, [])
        && canonicalJson(entity.metadata, {}) === canonicalJson(desiredEntityMetadata, {})
        ? entity
        : this.upsertEntity({
          id: entity.id,
          agentId: normalizedAgentId,
          kind: entity.kind,
          canonicalName: entity.canonical_name,
          aliases: desiredAliases,
          metadata: desiredEntityMetadata,
        });
      const binding = this.bindActorEntity({
        agentId: normalizedAgentId,
        actorRole: normalizedActorRole,
        actorKey: normalizedActorKey,
        entityId: updated.id,
        displayName: normalizedDisplayName,
        provenance: clean(provenance) || bound.provenance,
        metadata: { ...bound.metadata, ...metadata },
      });
      return { entity: updated, binding, wasCreated: false };
    }
    const entityKind = normalizedActorRole === 'agent' ? 'agent' : 'person';
    const sameName = this.findEntityByName({ agentId: normalizedAgentId, kind: entityKind, name: normalizedDisplayName });
    const identityName = sameName ? `${normalizedDisplayName} [${normalizedActorRole}:${normalizedActorKey}]` : normalizedDisplayName;
    const entity = this.upsertEntity({
      id: stableId("actor-entity", normalizedAgentId, normalizedActorRole, normalizedActorKey),
      agentId: normalizedAgentId,
      kind: normalizedActorRole === "agent" ? "agent" : "person",
      canonicalName: identityName,
      aliases: (Array.isArray(aliases) ? aliases : []).filter(alias => !this.findEntityByName({ agentId: normalizedAgentId, kind: entityKind, name: alias })),
      metadata: {
        actorRole: normalizedActorRole,
        actorKey: normalizedActorKey,
        ...metadata,
      },
    });
    const binding = this.bindActorEntity({
      agentId: normalizedAgentId,
      actorRole: normalizedActorRole,
      actorKey: normalizedActorKey,
      entityId: entity.id,
      displayName: normalizedDisplayName,
      provenance,
      metadata,
    });
    return { entity, binding, wasCreated: true };
  }

  listMemoryActorEntities(memoryId) {
    return this.database.prepare(`
      SELECT role.role AS memory_role, role.actor_role, role.actor_key,
             role.is_primary, role.confidence,
             binding.display_name AS actor_display_name,
             entity.id AS entity_id, entity.agent_id AS entity_agent_id,
             entity.kind AS entity_kind, entity.canonical_name,
             entity.aliases_json, entity.metadata_json AS entity_metadata_json,
             entity.created_at AS entity_created_at,
             entity.updated_at AS entity_updated_at
      FROM memory_actor_roles AS role
      JOIN actor_entity_bindings AS binding
        ON binding.agent_id = role.agent_id
       AND binding.actor_role = role.actor_role
       AND binding.actor_key = role.actor_key
      JOIN entities AS entity
        ON entity.id = binding.entity_id AND entity.agent_id = binding.agent_id
      WHERE role.memory_id = ?
      ORDER BY role.is_primary DESC, role.role ASC,
               entity.canonical_name ASC, entity.id ASC
    `).all(clean(memoryId)).map(normalizeMemoryActorEntity);
  }

  listActorEntityMemories({ agentId, entityId, statuses = ["active"] }) {
    const normalizedStatuses = [...new Set(statuses.map(clean).filter(Boolean))];
    if (!normalizedStatuses.length) return [];
    return this.database.prepare(`
      SELECT memory.*, role.role AS actor_memory_role,
             role.actor_role AS actor_identity_role,
             role.actor_key AS actor_identity_key,
             role.is_primary AS actor_is_primary,
             role.confidence AS actor_confidence
      FROM actor_entity_bindings AS binding
      JOIN memory_actor_roles AS role
        ON role.agent_id = binding.agent_id
       AND role.actor_role = binding.actor_role
       AND role.actor_key = binding.actor_key
      JOIN memory_nodes AS memory
        ON memory.id = role.memory_id AND memory.agent_id = role.agent_id
      WHERE binding.agent_id = ? AND binding.entity_id = ?
        AND memory.status IN (${normalizedStatuses.map(() => "?").join(", ")})
      ORDER BY COALESCE(memory.event_start, memory.known_at, memory.recorded_at) DESC,
               memory.updated_at DESC, role.role ASC
    `).all(
      clean(agentId),
      clean(entityId),
      ...normalizedStatuses,
    ).map((row) => ({
      ...normalizeNode(row),
      actorMemoryRole: row.actor_memory_role,
      actorIdentityRole: row.actor_identity_role,
      actorIdentityKey: row.actor_identity_key,
      actorIsPrimary: Boolean(row.actor_is_primary),
      actorConfidence: Number(row.actor_confidence),
    }));
  }

  getRelationship(agentId, relationshipId) {
    const relationship = normalizeRelationship(this.database.prepare(`
      SELECT * FROM relationships WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(relationshipId)));
    if (!relationship) return null;
    return {
      ...relationship,
      members: this.listRelationshipMembers(relationship.id),
    };
  }

  findRelationshipByKey(agentId, relationshipKey) {
    const row = this.database.prepare(`
      SELECT id FROM relationships WHERE agent_id = ? AND relationship_key = ?
    `).get(clean(agentId), clean(relationshipKey));
    return row ? this.getRelationship(agentId, row.id) : null;
  }

  listRelationships(agentId, { statuses = ["active"] } = {}) {
    const normalizedStatuses = [...new Set(statuses.map(clean).filter(Boolean))];
    if (!normalizedStatuses.length) return [];
    return this.database.prepare(`
      SELECT * FROM relationships
      WHERE agent_id = ? AND status IN (${normalizedStatuses.map(() => "?").join(", ")})
      ORDER BY updated_at DESC, relationship_key ASC
    `).all(clean(agentId), ...normalizedStatuses).map((row) => ({
      ...normalizeRelationship(row),
      members: this.listRelationshipMembers(row.id),
    }));
  }

  upsertRelationship({
    id = "",
    agentId,
    relationshipKey,
    kind = "dyad",
    label = "关系",
    worldId = "relationship",
    worldFrame = "relational",
    status = "active",
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedKey = clean(relationshipKey).toLocaleLowerCase("en-US");
    const normalizedKind = clean(kind) || "dyad";
    const normalizedLabel = clean(label) || "关系";
    const normalizedWorldId = clean(worldId) || "relationship";
    const normalizedWorldFrame = clean(worldFrame) || "relational";
    const normalizedStatus = clean(status) || "active";
    if (!normalizedAgentId || !normalizedKey
      || !["dyad", "group"].includes(normalizedKind)
      || !WORLD_FRAMES.includes(normalizedWorldFrame)
      || !["active", "archived", "deleted"].includes(normalizedStatus)) {
      throw new Error("Relationship requires a valid Agent, key, kind, world, and status.");
    }
    const existing = this.findRelationshipByKey(normalizedAgentId, normalizedKey);
    const requestedId = clean(id);
    if (existing && requestedId && existing.id !== requestedId) {
      throw new Error("Relationship key already belongs to another relationship id.");
    }
    const relationshipId = existing?.id || requestedId || stableId(
      "relationship",
      normalizedAgentId,
      normalizedKey,
    );
    const owner = this.database.prepare(`SELECT agent_id FROM relationships WHERE id = ?`)
      .get(relationshipId);
    if (owner && owner.agent_id !== normalizedAgentId) {
      throw new Error("Relationship id already belongs to another Agent.");
    }
    const mergedMetadata = { ...(existing?.metadata || {}), ...metadata };
    if (existing
      && existing.kind === normalizedKind
      && existing.label === normalizedLabel
      && existing.world_id === normalizedWorldId
      && existing.world_frame === normalizedWorldFrame
      && existing.status === normalizedStatus
      && canonicalJson(existing.metadata, {}) === canonicalJson(mergedMetadata, {})) {
      return existing;
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO relationships (
        id, agent_id, relationship_key, kind, label,
        world_id, world_frame, status, metadata_json,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        relationship_key = excluded.relationship_key,
        kind = excluded.kind,
        label = excluded.label,
        world_id = excluded.world_id,
        world_frame = excluded.world_frame,
        status = excluded.status,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      relationshipId,
      normalizedAgentId,
      normalizedKey,
      normalizedKind,
      normalizedLabel,
      normalizedWorldId,
      normalizedWorldFrame,
      normalizedStatus,
      json(mergedMetadata, {}),
      existing?.created_at || timestamp,
      timestamp,
    );
    return this.getRelationship(normalizedAgentId, relationshipId);
  }

  addRelationshipMember({
    agentId,
    relationshipId,
    entityId,
    memberRole = "member",
    provenance = "",
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedRelationshipId = clean(relationshipId);
    const normalizedEntityId = clean(entityId);
    const normalizedMemberRole = clean(memberRole) || "member";
    const relationship = this.getRelationship(normalizedAgentId, normalizedRelationshipId);
    const entity = this.getEntity(normalizedAgentId, normalizedEntityId);
    if (!relationship || !entity || !normalizedMemberRole) {
      throw new Error("Relationship member requires a relationship and entity from the same Agent.");
    }
    const existing = relationship.members.find((member) => member.entity_id === normalizedEntityId);
    const normalizedProvenance = clean(provenance);
    const normalizedMetadata = metadata ?? {};
    if (existing
      && existing.member_role === normalizedMemberRole
      && existing.provenance === normalizedProvenance
      && canonicalJson(existing.metadata, {}) === canonicalJson(normalizedMetadata, {})) {
      return existing;
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO relationship_members (
        relationship_id, agent_id, entity_id, member_role,
        provenance, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(relationship_id, entity_id) DO UPDATE SET
        member_role = excluded.member_role,
        provenance = excluded.provenance,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      normalizedRelationshipId,
      normalizedAgentId,
      normalizedEntityId,
      normalizedMemberRole,
      normalizedProvenance,
      json(normalizedMetadata, {}),
      existing?.created_at || timestamp,
      timestamp,
    );
    return this.listRelationshipMembers(normalizedRelationshipId)
      .find((member) => member.entity_id === normalizedEntityId);
  }

  listRelationshipMembers(relationshipId) {
    return this.database.prepare(`
      SELECT member.relationship_id, member.agent_id, member.entity_id,
             member.member_role, member.provenance,
             member.metadata_json AS membership_metadata_json,
             member.created_at, member.updated_at,
             entity.agent_id AS entity_agent_id, entity.kind AS entity_kind,
             entity.canonical_name, entity.aliases_json,
             entity.metadata_json AS entity_metadata_json,
             entity.created_at AS entity_created_at,
             entity.updated_at AS entity_updated_at
      FROM relationship_members AS member
      JOIN entities AS entity
        ON entity.id = member.entity_id AND entity.agent_id = member.agent_id
      WHERE member.relationship_id = ?
      ORDER BY member.member_role ASC, entity.canonical_name ASC, entity.id ASC
    `).all(clean(relationshipId)).map(normalizeRelationshipMember);
  }

  linkMemoryToRelationship({
    agentId,
    memoryId,
    relationshipId,
    membershipType = "about",
    confidence = 1,
    provenance = "",
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedRelationshipId = clean(relationshipId);
    const normalizedType = clean(membershipType) || "about";
    const allowedTypes = [
      "about", "shared_experience", "relationship_state",
      "affective_association", "commitment", "milestone",
    ];
    const memory = this.getMemory(normalizedMemoryId);
    const relationship = this.getRelationship(normalizedAgentId, normalizedRelationshipId);
    if (!memory || memory.agent_id !== normalizedAgentId || !relationship
      || !allowedTypes.includes(normalizedType)) {
      throw new Error("Memory relationship membership is invalid or crosses Agent boundaries.");
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_relationship_memberships (
        memory_id, relationship_id, agent_id, membership_type,
        confidence, provenance, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, relationship_id, membership_type) DO NOTHING
    `).run(
      normalizedMemoryId,
      normalizedRelationshipId,
      normalizedAgentId,
      normalizedType,
      unitInterval(confidence, "Relationship membership confidence"),
      clean(provenance),
      json(metadata, {}),
      timestamp,
      timestamp,
    );
    return this.listMemoryRelationships(normalizedMemoryId).find((item) => (
      item.relationship_id === normalizedRelationshipId
      && item.membership_type === normalizedType
    ));
  }

  unlinkMemoryFromRelationship({
    agentId,
    memoryId,
    relationshipId,
    membershipType = "",
    provenance = "",
  }) {
    const clauses = ["agent_id = ?", "memory_id = ?", "relationship_id = ?"];
    const parameters = [clean(agentId), clean(memoryId), clean(relationshipId)];
    if (clean(membershipType)) {
      clauses.push("membership_type = ?");
      parameters.push(clean(membershipType));
    }
    if (clean(provenance)) {
      clauses.push("provenance = ?");
      parameters.push(clean(provenance));
    }
    return Number(this.database.prepare(`
      DELETE FROM memory_relationship_memberships WHERE ${clauses.join(" AND ")}
    `).run(...parameters).changes || 0);
  }

  listMemoryRelationships(memoryId) {
    return this.database.prepare(`
      SELECT membership.memory_id, membership.relationship_id,
             membership.agent_id, membership.membership_type,
             membership.confidence, membership.provenance,
             membership.metadata_json AS membership_metadata_json,
             membership.created_at, membership.updated_at,
             relationship.relationship_key, relationship.kind AS relationship_kind,
             relationship.label AS relationship_label,
             relationship.world_id, relationship.world_frame,
             relationship.status AS relationship_status
      FROM memory_relationship_memberships AS membership
      JOIN relationships AS relationship
        ON relationship.id = membership.relationship_id
       AND relationship.agent_id = membership.agent_id
      WHERE membership.memory_id = ?
      ORDER BY membership.membership_type ASC,
               relationship.relationship_key ASC
    `).all(clean(memoryId)).map(normalizeMemoryRelationshipMembership);
  }

  listRelationshipMemories({
    agentId,
    relationshipId,
    statuses = ["active"],
    membershipTypes = [],
  }) {
    const normalizedStatuses = [...new Set(statuses.map(clean).filter(Boolean))];
    const normalizedTypes = [...new Set(membershipTypes.map(clean).filter(Boolean))];
    if (!normalizedStatuses.length) return [];
    const typeClause = normalizedTypes.length
      ? `AND membership.membership_type IN (${normalizedTypes.map(() => "?").join(", ")})`
      : "";
    const rows = this.database.prepare(`
      SELECT memory.*, membership.membership_type,
             membership.confidence AS relationship_confidence,
             membership.provenance AS relationship_provenance,
             membership.metadata_json AS relationship_metadata_json
      FROM memory_relationship_memberships AS membership
      JOIN memory_nodes AS memory
        ON memory.id = membership.memory_id AND memory.agent_id = membership.agent_id
      WHERE membership.agent_id = ? AND membership.relationship_id = ?
        AND memory.status IN (${normalizedStatuses.map(() => "?").join(", ")})
        ${typeClause}
      ORDER BY COALESCE(memory.event_start, memory.known_at, memory.recorded_at) DESC,
               memory.updated_at DESC
    `).all(
      clean(agentId),
      clean(relationshipId),
      ...normalizedStatuses,
      ...normalizedTypes,
    );
    const memories = new Map();
    for (const row of rows) {
      const membership = {
        type: row.membership_type,
        confidence: Number(row.relationship_confidence),
        provenance: row.relationship_provenance,
        metadata: parseJson(row.relationship_metadata_json, {}),
      };
      const existing = memories.get(row.id);
      if (existing) {
        existing.relationshipMemberships.push(membership);
        continue;
      }
      memories.set(row.id, {
        ...normalizeNode(row),
        relationshipMemberships: [membership],
      });
    }
    return [...memories.values()];
  }

  getCurrentCanonicalMemory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer = "",
    stateFamily = "",
    stateScopeKey = ROOT_STATE_SCOPE_KEY,
    worldId = "",
    worldFrame = "",
    includePending = false,
    includeHistorical = false,
    excludeMemoryId = "",
  }) {
    const normalizedRepresentationLayer = clean(representationLayer);
    const normalizedStateFamily = clean(stateFamily);
    const normalizedStateScopeKey = clean(stateScopeKey) || ROOT_STATE_SCOPE_KEY;
    const normalizedWorldId = clean(worldId);
    const normalizedWorldFrame = clean(worldFrame);
    if (normalizedRepresentationLayer && !REPRESENTATION_LAYERS.includes(normalizedRepresentationLayer)) {
      throw new Error("Current canonical memory representationLayer is invalid.");
    }
    if (normalizedStateFamily && !MEMORY_STATE_FAMILY_STORAGE_VALUES.includes(normalizedStateFamily)) {
      throw new Error("Current canonical memory stateFamily is invalid.");
    }
    if (!isValidStateScopeKey(normalizedStateScopeKey)
      || normalizedStateScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Current canonical memory stateScopeKey is invalid.");
    }
    const representationFilter = normalizedRepresentationLayer ? "AND representation_layer = ?" : "";
    const stateFamilyFilter = normalizedStateFamily ? "AND state_family = ?" : "";
    const worldIdFilter = normalizedWorldId ? "AND world_id = ?" : "";
    const worldFrameFilter = normalizedWorldFrame ? "AND world_frame = ?" : "";
    const current = normalizeNode(this.database.prepare(`
      SELECT * FROM memory_nodes
      WHERE agent_id = ?
        AND subject_role = ?
        AND subject_key = ?
        AND canonical_key = ?
        ${representationFilter}
        ${stateFamilyFilter}
        ${worldIdFilter}
        ${worldFrameFilter}
        AND state_scope_key = ?
        AND id <> ?
        AND (status = 'active' ${includePending ? `OR (
          status <> 'deleted' AND representation_layer = 'reported' AND (
            (layer = 'provisional' AND json_extract(metadata_json, '$.reviewState') = 'pending'
              AND COALESCE(json_extract(metadata_json, '$.reportedStateAction'), 'create')
                IN ('create', 'supersede', 'pause', 'resume', 'narrow_scope'))
            OR EXISTS (SELECT 1 FROM memory_reported_state_proposals proposal
              WHERE proposal.agent_id = memory_nodes.agent_id AND proposal.review_state = 'pending'
                AND proposal.id = json_extract(memory_nodes.metadata_json, '$.reportedStateTransitionId'))
          ))` : ""} ${includeHistorical ? "OR (status = 'superseded' AND layer <> 'provisional')" : ""})
      ORDER BY CASE WHEN status = 'active' OR layer = 'provisional' THEN 0 ELSE 1 END,
        COALESCE(valid_from, known_at, event_start, recorded_at) DESC,
        updated_at DESC
      LIMIT 1
    `).get(
      agentId,
      subjectRole,
      subjectKey,
      canonicalKey,
      ...(normalizedRepresentationLayer ? [normalizedRepresentationLayer] : []),
      ...(normalizedStateFamily ? [normalizedStateFamily] : []),
      ...(normalizedWorldId ? [normalizedWorldId] : []),
      ...(normalizedWorldFrame ? [normalizedWorldFrame] : []),
      normalizedStateScopeKey,
      clean(excludeMemoryId),
    ));
    const sourceView = executionEventSourceView(this, clean(agentId));
    if (sourceView && current && !sourceView.allows(current)) {
      throw Object.assign(new Error('Current canonical state awaits an eligible source scope.'), { code: 'EVENT_SOURCE_TASK_DEFERRED' });
    }
    return current;
  }

  listCanonicalStateHistory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer = "",
    stateFamily = "",
    stateScopeKey = ROOT_STATE_SCOPE_KEY,
    includeDeleted = false,
  }) {
    const normalizedRepresentationLayer = clean(representationLayer);
    const normalizedStateFamily = clean(stateFamily);
    const normalizedStateScopeKey = clean(stateScopeKey) || ROOT_STATE_SCOPE_KEY;
    if (normalizedRepresentationLayer && !REPRESENTATION_LAYERS.includes(normalizedRepresentationLayer)) {
      throw new Error("Canonical history representationLayer is invalid.");
    }
    if (normalizedStateFamily && !MEMORY_STATE_FAMILY_STORAGE_VALUES.includes(normalizedStateFamily)) {
      throw new Error("Canonical history stateFamily is invalid.");
    }
    if (!isValidStateScopeKey(normalizedStateScopeKey)
      || normalizedStateScopeKey === NON_STATE_SCOPE_KEY) {
      throw new Error("Canonical history stateScopeKey is invalid.");
    }
    const statusFilter = includeDeleted ? "" : "AND status <> 'deleted'";
    const representationFilter = normalizedRepresentationLayer ? "AND representation_layer = ?" : "";
    const stateFamilyFilter = normalizedStateFamily ? "AND state_family = ?" : "";
    return this.database.prepare(`
      SELECT * FROM memory_nodes
      WHERE agent_id = ?
        AND subject_role = ?
        AND subject_key = ?
        AND canonical_key = ?
        ${representationFilter}
        ${stateFamilyFilter}
        AND state_scope_key = ?
        ${statusFilter}
      ORDER BY COALESCE(valid_from, known_at, event_start, recorded_at) DESC,
        updated_at DESC
    `).all(
      agentId,
      subjectRole,
      subjectKey,
      canonicalKey,
      ...(normalizedRepresentationLayer ? [normalizedRepresentationLayer] : []),
      ...(normalizedStateFamily ? [normalizedStateFamily] : []),
      normalizedStateScopeKey,
    ).map(normalizeNode);
  }

  listCurrentScopedExceptions({ agentId, rootMemoryId } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedRootMemoryId = clean(rootMemoryId);
    const root = this.getMemory(normalizedRootMemoryId);
    if (!root || root.agent_id !== normalizedAgentId
      || root.status !== "active"
      || root.state_scope_key !== ROOT_STATE_SCOPE_KEY) {
      return [];
    }
    return this.database.prepare(`
      SELECT exception.*
      FROM memory_edges AS edge
      JOIN memory_nodes AS exception
        ON exception.agent_id = edge.agent_id AND exception.id = edge.from_memory_id
      WHERE edge.agent_id = ?
        AND edge.to_memory_id = ?
        AND edge.relation = 'scoped_exception_to'
        AND exception.status = 'active'
        AND exception.state_scope_key LIKE 'scope:%'
        AND exception.subject_role = ?
        AND exception.subject_key = ?
        AND exception.canonical_key = ?
        AND exception.representation_layer = ?
        AND exception.state_family = ?
      ORDER BY COALESCE(exception.valid_from, exception.known_at, exception.recorded_at) DESC,
        exception.updated_at DESC, exception.id ASC
    `).all(
      normalizedAgentId,
      root.id,
      root.subject_role,
      root.subject_key,
      root.canonical_key,
      root.representation_layer,
      root.state_family,
    ).map(normalizeNode);
  }

  bindEventContinuity({ agentId, memoryId, resolution, candidateId = '', relation = '', contentHash, rationale, candidateIds = [], evidenceSourceIds = [], provenance = 'event-continuity-v1' }) {
    const memory = this.getMemory(memoryId);
    const target = resolution === 'matched' ? this.getMemory(candidateId) : null;
    for (const item of [memory, ...(target ? [target] : [])]) {
      if (!item || item.agent_id !== agentId || item.kind !== 'event' || !['active', 'superseded'].includes(item.status)
        || item.layer === 'provisional') throw new Error('Event continuity requires stored events from the same Agent.');
    }
    if (!['new', 'ambiguous', 'matched'].includes(resolution) || (resolution === 'matched' && (!target || target.id === memory.id
      || !memoryWorldsCompatible(memory, target, { allowRealSpaces: true })))) throw new Error('Invalid event continuity target.');
    if ((target && !['same_thread', 'completes', 'cancels', 'corrects'].includes(relation))
      || (!target && (candidateId || relation))) throw new Error('Invalid event continuity relation.');
    const identityOwner = target || memory;
    const canonicalKey = identityOwner.metadata?.eventIdentityKey || stableId('event', agentId, identityOwner.id);
    return this.transaction(() => {
      const write = (node, metadata) => {
        this.database.prepare('UPDATE memory_nodes SET canonical_key = ?, metadata_json = ?, updated_at = ? WHERE agent_id = ? AND id = ?')
          .run(canonicalKey, json({ ...node.metadata, ...metadata, eventIdentityKey: canonicalKey }, {}), nowIso(), agentId, node.id);
        this.syncSearch(node.id);
      };
      // A retried older record may already have newer descendants. Move its
      // entire identity group when its own earlier continuation is resolved.
      const previousIdentity = memory.metadata?.eventIdentityKey;
      if (target && previousIdentity && previousIdentity !== canonicalKey) {
        const descendants = this.database.prepare(`SELECT id FROM memory_nodes WHERE agent_id = ? AND kind = 'event'
          AND status <> 'deleted' AND json_extract(metadata_json, '$.eventIdentityKey') = ?`).all(agentId, previousIdentity);
        const sourceView = executionEventSourceView(this, agentId);
        for (const { id } of descendants) {
          const node = this.getMemory(id);
          if (sourceView && !sourceView.allows(node)) throw Object.assign(new Error('Event identity group awaits an eligible source scope.'), { code: 'EVENT_SOURCE_TASK_DEFERRED' });
          if (!memoryWorldsCompatible(memory, node, { allowRealSpaces: true })) throw new Error('Event identity group crosses incompatible worlds.');
          write(node, {});
        }
      }
      if (target && target.metadata?.eventIdentityKey !== canonicalKey) write(target, {});
      write(memory, { eventContinuity: { resolution, targetMemoryId: target?.id || '', relation,
        contentHash, rationale, candidateIds, evidenceSourceIds } });
      if (target) for (const edgeRelation of new Set(['same_thread', relation])) this.upsertEdge({
        agentId, fromMemoryId: memory.id, toMemoryId: target.id, relation: edgeRelation,
        direction: 'directed', weight: 1, confidence: 1, provenance,
        metadata: { evidenceSourceIds, rationale },
      });
      return this.getMemory(memory.id);
    });
  }

  updateMemoryStatus(id, status) {
    const changed = this.database.prepare(`
      UPDATE memory_nodes SET status = ?, updated_at = ? WHERE id = ?
    `).run(status, nowIso(), id);
    if (Number(changed.changes || 0) > 0) this.syncSearch(id);
    return this.getMemory(id);
  }

  closeCurrentMemoryState({ agentId, memoryId, validTo, allowPending = false }) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedValidTo = clean(validTo);
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Closing a memory state requires a memory from the same Agent.");
    }
    const pending = allowPending && memory.layer === "provisional"
      && memory.status === "archived" && memory.metadata?.reviewState === "pending";
    if (memory.status !== "active" && !pending) {
      throw new Error("Only an active current memory state can be closed.");
    }
    if (!validTimestamp(normalizedValidTo)) {
      throw new Error("Closing a memory state requires a valid validTo timestamp.");
    }
    const timestamp = new Date(normalizedValidTo).toISOString();
    if (memory.valid_from && timestamp < memory.valid_from) {
      throw new Error("A memory state cannot close before its validity begins.");
    }
    const result = this.database.prepare(`
      UPDATE memory_nodes
      SET status = 'superseded', temporal_state = 'historical', valid_to = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = ?
    `).run(timestamp, nowIso(), normalizedAgentId, normalizedMemoryId, memory.status);
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Current memory state changed while it was being closed.");
    }
    this.syncSearch(normalizedMemoryId);
    return this.getMemory(normalizedMemoryId);
  }

  closeReportedMemoryState({
    agentId,
    memoryId,
    stateFamily,
    statePhase,
    temporalState,
    status = "superseded",
    validTo,
    allowPending = false,
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedFamily = clean(stateFamily);
    const normalizedPhase = clean(statePhase);
    const normalizedTemporalState = clean(temporalState);
    const normalizedStatus = clean(status);
    const normalizedValidTo = clean(validTo);
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId
      || memory.representation_layer !== "reported"
      || memory.state_family !== normalizedFamily) {
      throw new Error("Closing a reported state requires the exact reviewed memory target.");
    }
    const pending = allowPending && memory.layer === "provisional"
      && memory.status === "archived" && memory.metadata?.reviewState === "pending";
    if (memory.status !== "active" && !pending) {
      throw new Error("Only an active reported state can be closed.");
    }
    if (!MEMORY_STATE_PHASES.includes(normalizedPhase)
      || ["not_applicable", "unspecified", "active", "paused"].includes(normalizedPhase)) {
      throw new Error("Closing a reported state requires a terminal state phase.");
    }
    if (!TEMPORAL_STATES.includes(normalizedTemporalState)
      || ["current", "planned", "in_progress", "timeless", "unknown"].includes(normalizedTemporalState)) {
      throw new Error("Closing a reported state requires a terminal temporal state.");
    }
    if (!["superseded", "disputed"].includes(normalizedStatus)) {
      throw new Error("Closing a reported state requires a historical or disputed status.");
    }
    if (!validTimestamp(normalizedValidTo)) {
      throw new Error("Closing a reported state requires a valid validity end.");
    }
    const timestamp = new Date(normalizedValidTo).toISOString();
    if (memory.valid_from && timestamp < memory.valid_from) {
      throw new Error("A reported state cannot close before its validity begins.");
    }
    const result = this.database.prepare(`
      UPDATE memory_nodes
      SET status = ?, temporal_state = ?, state_phase = ?, valid_to = ?, updated_at = ?
      WHERE agent_id = ? AND id = ? AND status = ?
        AND representation_layer = 'reported' AND state_family = ?
    `).run(
      normalizedStatus,
      normalizedTemporalState,
      normalizedPhase,
      timestamp,
      nowIso(),
      normalizedAgentId,
      normalizedMemoryId,
      memory.status,
      normalizedFamily,
    );
    if (Number(result.changes || 0) !== 1) {
      throw new Error("Reported state changed while it was being closed.");
    }
    this.syncSearch(normalizedMemoryId);
    return this.getMemory(normalizedMemoryId);
  }

  restoreReportedStateTransition({ agentId, proposalId, memoryId, before, applied, actor = "human", reason = "" }) {
    const memory = this.getMemory(memoryId);
    if (!memory || memory.agent_id !== clean(agentId) || memory.status === "deleted") return null;
    // A later transition or manual edit owns the state now; never overwrite it.
    if (memory.metadata?.reportedStateTransitionId !== proposalId
      || ["status", "state_phase", "temporal_state", "valid_to"].some(key => memory[key] !== applied[key])) return null;
    const current = this.getCurrentCanonicalMemory({ agentId, subjectRole: memory.subject_role,
      subjectKey: memory.subject_key, canonicalKey: memory.canonical_key,
      representationLayer: "reported", stateFamily: memory.state_family, stateScopeKey: memory.state_scope_key,
      includePending: true, excludeMemoryId: memory.id });
    if (current) return null;
    const metadata = { ...memory.metadata };
    delete metadata.reportedStateTransitionId;
    if (before.transitionId) metadata.reportedStateTransitionId = before.transitionId;
    const status = before.layer === "provisional" && memory.layer !== "provisional" ? "active" : before.status;
    this.database.prepare(`UPDATE memory_nodes
      SET status = ?, state_phase = ?, temporal_state = ?, valid_to = ?, metadata_json = ?, updated_at = ?
      WHERE agent_id = ? AND id = ?`).run(status, before.state_phase, before.temporal_state, before.valid_to,
        json(metadata, {}), nowIso(), clean(agentId), memory.id);
    this.syncSearch(memory.id);
    const restored = this.getMemory(memory.id);
    this.recordMutation({ agentId, memoryId: memory.id, action: "edit", actor, reason, before: memory, after: restored });
    return restored;
  }

  getCurrentMemoryRetrievalContext(memoryId, { policyVersion = "" } = {}) {
    const memory = this.getMemory(clean(memoryId));
    if (!memory) return null;
    const sourceHash = memoryRetrievalContextSourceHash(memory);
    const normalizedPolicyVersion = clean(policyVersion);
    const row = normalizedPolicyVersion
      ? this.database.prepare(`
        SELECT * FROM memory_retrieval_contexts
        WHERE agent_id = ? AND memory_id = ? AND policy_version = ? AND source_hash = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(memory.agent_id, memory.id, normalizedPolicyVersion, sourceHash)
      : this.database.prepare(`
        SELECT * FROM memory_retrieval_contexts
        WHERE agent_id = ? AND memory_id = ? AND source_hash = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `).get(memory.agent_id, memory.id, sourceHash);
    return normalizeRetrievalContext(row);
  }

  listMemoryRetrievalContexts({ agentId, memoryId = "", limit = 100 } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    if (!normalizedAgentId) throw new Error("Listing retrieval contexts requires agentId.");
    const maximum = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
    const rows = normalizedMemoryId
      ? this.database.prepare(`
        SELECT * FROM memory_retrieval_contexts
        WHERE agent_id = ? AND memory_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(normalizedAgentId, normalizedMemoryId, maximum)
      : this.database.prepare(`
        SELECT * FROM memory_retrieval_contexts
        WHERE agent_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).all(normalizedAgentId, maximum);
    return rows.map(normalizeRetrievalContext);
  }

  upsertMemoryRetrievalContext({
    agentId,
    memoryId,
    policyVersion,
    sourceHash,
    contextText,
    queryTerms = [],
    provider = "",
    model = "",
    promptVersion,
    proposalRequestId = "",
    criticRequestId = "",
    usage = {},
    metadata = {},
  } = {}) {
    const normalizedAgentId = clean(agentId);
    const normalizedMemoryId = clean(memoryId);
    const normalizedPolicyVersion = clean(policyVersion);
    const normalizedSourceHash = clean(sourceHash);
    const normalizedContextText = String(contextText ?? "").trim().replace(/\s+/gu, " ");
    const normalizedQueryTerms = cleanStringList(queryTerms).slice(0, 12);
    const normalizedPromptVersion = clean(promptVersion);
    const memory = this.getMemory(normalizedMemoryId);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error("Retrieval context requires a memory from the same Agent.");
    }
    if (!normalizedPolicyVersion) throw new Error("Retrieval context requires policyVersion.");
    if (!/^[a-f0-9]{64}$/u.test(normalizedSourceHash)) {
      throw new Error("Retrieval context requires a SHA-256 sourceHash.");
    }
    if (normalizedSourceHash !== memoryRetrievalContextSourceHash(memory)) {
      throw new Error("Retrieval context source changed before it could be stored.");
    }
    if (normalizedContextText.length < 8 || normalizedContextText.length > 600) {
      throw new Error("Retrieval context must contain between 8 and 600 characters.");
    }
    if (normalizedQueryTerms.some((term) => term.length > 40)) {
      throw new Error("Retrieval context query terms must not exceed 40 characters each.");
    }
    if (!normalizedPromptVersion) throw new Error("Retrieval context requires promptVersion.");
    const contextHash = createHash("sha256")
      .update(canonicalJson({
        contextText: normalizedContextText,
        queryTerms: normalizedQueryTerms,
      }, {}))
      .digest("hex");
    const id = stableId(
      "retrieval-context",
      normalizedAgentId,
      normalizedMemoryId,
      normalizedPolicyVersion,
      normalizedSourceHash,
    );
    const existing = normalizeRetrievalContext(this.database.prepare(`
      SELECT * FROM memory_retrieval_contexts
      WHERE agent_id = ? AND memory_id = ? AND policy_version = ? AND source_hash = ?
    `).get(
      normalizedAgentId,
      normalizedMemoryId,
      normalizedPolicyVersion,
      normalizedSourceHash,
    ));
    if (existing) {
      if (existing.context_hash !== contextHash) {
        throw new Error("Retrieval context output changed without a policy version change.");
      }
      return { ...existing, wasInserted: false, sourceCurrent: true };
    }
    this.database.prepare(`
      INSERT INTO memory_retrieval_contexts (
        id, memory_id, agent_id, policy_version, source_hash, context_hash,
        context_text, query_terms_json, provider, model, prompt_version,
        proposal_request_id, critic_request_id, usage_json, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      normalizedMemoryId,
      normalizedAgentId,
      normalizedPolicyVersion,
      normalizedSourceHash,
      contextHash,
      normalizedContextText,
      json(normalizedQueryTerms, []),
      clean(provider),
      clean(model),
      normalizedPromptVersion,
      clean(proposalRequestId),
      clean(criticRequestId),
      json(usage, {}),
      json(metadata, {}),
      nowIso(),
    );
    this.syncSearch(normalizedMemoryId);
    return {
      ...this.getCurrentMemoryRetrievalContext(normalizedMemoryId, {
        policyVersion: normalizedPolicyVersion,
      }),
      wasInserted: true,
      sourceCurrent: true,
    };
  }

  upsertEmbedding({
    memoryId,
    model,
    vector,
    contentHash = "",
    sourceMemoryIds = [],
  }) {
    const normalizedMemoryId = clean(memoryId);
    const normalizedModel = clean(model);
    const values = vector instanceof Float32Array
      ? vector
      : Float32Array.from(Array.isArray(vector) ? vector : []);
    if (!normalizedMemoryId || !this.getMemory(normalizedMemoryId)) {
      throw new Error("Embedding requires an existing memoryId.");
    }
    if (!normalizedModel) throw new Error("Embedding requires model.");
    if (!values.length) throw new Error("Embedding vector cannot be empty.");
    const blob = Buffer.from(
      values.buffer.slice(values.byteOffset, values.byteOffset + values.byteLength),
    );
    this.database.prepare(`
      INSERT INTO memory_embeddings (
        memory_id, model, dimensions, content_hash, vector, created_at, source_memory_ids_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, model) DO UPDATE SET
        dimensions = excluded.dimensions,
        content_hash = excluded.content_hash,
        vector = excluded.vector,
        source_memory_ids_json = excluded.source_memory_ids_json,
        created_at = excluded.created_at
    `).run(
      normalizedMemoryId,
      normalizedModel,
      values.length,
      clean(contentHash),
      blob,
      nowIso(),
      JSON.stringify(cleanStringList(sourceMemoryIds)),
    );
    return {
      memoryId: normalizedMemoryId,
      model: normalizedModel,
      dimensions: values.length,
      contentHash: clean(contentHash),
    };
  }

  listEmbeddings(agentId, model, {
    includeArchived = false,
    cache = false,
    cacheMaxBytes,
  } = {}) {
    const read = () => this.readEmbeddingRows(agentId, model, { includeArchived });
    return cache ? cachedEmbeddingRows(this.database, JSON.stringify([agentId, model, includeArchived]), read,
      { maximumBytes: cacheMaxBytes }) : read();
  }

  readEmbeddingRows(agentId, model, { includeArchived }) {
    const statusClause = includeArchived
      ? "node.status <> 'deleted'"
      : "node.status = 'active'";
    return this.database.prepare(`
      SELECT embedding.memory_id, embedding.model, embedding.dimensions,
             embedding.content_hash, embedding.vector, embedding.source_memory_ids_json, node.kind,
             node.layer, node.importance, node.recorded_at
      FROM memory_embeddings AS embedding
      JOIN memory_nodes AS node ON node.id = embedding.memory_id
      WHERE node.agent_id = ? AND embedding.model = ? AND ${statusClause}
    `).all(agentId, model).map((row) => ({
      ...row,
      vector: new Float32Array(
        row.vector.buffer.slice(
          row.vector.byteOffset,
          row.vector.byteOffset + row.vector.byteLength,
        ),
      ),
      importance: Number(row.importance),
    }));
  }

  linkSource(memoryId, sourceId, relation = "evidence", {
    authority = "unknown",
    sourceTrust = 0.5,
    evidenceStrength = 1,
    provenance = "",
    metadata = {},
  } = {}) {
    const normalizedAuthority = clean(authority) || "unknown";
    if (!SOURCE_AUTHORITIES.includes(normalizedAuthority)) {
      throw new Error(`Unknown source authority: ${normalizedAuthority}.`);
    }
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_sources (
        memory_id, source_id, relation, authority,
        source_trust, evidence_strength, provenance,
        metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id, source_id, relation) DO UPDATE SET
        authority = excluded.authority,
        source_trust = excluded.source_trust,
        evidence_strength = excluded.evidence_strength,
        provenance = excluded.provenance,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      memoryId,
      sourceId,
      clean(relation) || "evidence",
      normalizedAuthority,
      bounded(sourceTrust, 0.5),
      bounded(evidenceStrength, 1),
      clean(provenance),
      json(metadata, {}),
      timestamp,
      timestamp,
    );
  }

  getEdge(agentId, edgeId) {
    return normalizeEdge(this.database.prepare(`
      SELECT * FROM memory_edges WHERE agent_id = ? AND id = ?
    `).get(clean(agentId), clean(edgeId)));
  }

  findEdge({ agentId, fromMemoryId, toMemoryId, relation }) {
    return normalizeEdge(this.database.prepare(`
      SELECT * FROM memory_edges
      WHERE agent_id = ? AND from_memory_id = ? AND to_memory_id = ? AND relation = ?
    `).get(
      clean(agentId),
      clean(fromMemoryId),
      clean(toMemoryId),
      clean(relation),
    ));
  }

  upsertEdge({
    id = "",
    agentId,
    fromMemoryId,
    toMemoryId,
    relation,
    direction = "directed",
    weight = 0.5,
    confidence = 1,
    provenance = "",
    metadata = {},
  }) {
    const normalizedAgentId = clean(agentId);
    const normalizedFromMemoryId = clean(fromMemoryId);
    const normalizedToMemoryId = clean(toMemoryId);
    const normalizedRelation = clean(relation);
    if (!normalizedAgentId || !normalizedFromMemoryId || !normalizedToMemoryId || !normalizedRelation) {
      throw new Error("Edge requires agentId, fromMemoryId, toMemoryId, and relation.");
    }
    if (normalizedFromMemoryId === normalizedToMemoryId) {
      throw new Error("Memory edge cannot point to itself.");
    }
    const endpointCount = Number(this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM memory_nodes
      WHERE agent_id = ? AND id IN (?, ?)
    `).get(
      normalizedAgentId,
      normalizedFromMemoryId,
      normalizedToMemoryId,
    ).count || 0);
    if (endpointCount !== 2) {
      throw new Error("Memory edge endpoints must exist for the same Agent.");
    }

    const edgeId = clean(id) || stableId(
      "edge",
      normalizedAgentId,
      normalizedFromMemoryId,
      normalizedToMemoryId,
      normalizedRelation,
    );
    const timestamp = nowIso();
    this.database.prepare(`
      INSERT INTO memory_edges (
        id, agent_id, from_memory_id, to_memory_id, relation, direction,
        weight, confidence, provenance, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, from_memory_id, to_memory_id, relation) DO UPDATE SET
        direction = excluded.direction,
        weight = excluded.weight,
        confidence = excluded.confidence,
        provenance = excluded.provenance,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      edgeId,
      normalizedAgentId,
      normalizedFromMemoryId,
      normalizedToMemoryId,
      normalizedRelation,
      direction,
      bounded(weight, 0.5),
      bounded(confidence, 1),
      clean(provenance),
      json(metadata, {}),
      timestamp,
      timestamp,
    );
    return normalizeEdge(this.database.prepare(`
      SELECT * FROM memory_edges
      WHERE agent_id = ? AND from_memory_id = ? AND to_memory_id = ? AND relation = ?
    `).get(
      normalizedAgentId,
      normalizedFromMemoryId,
      normalizedToMemoryId,
      normalizedRelation,
    ));
  }

  syncSearch(memoryId) {
    // SAVEPOINT also nests inside a transaction opened directly by a host.
    this.database.exec('SAVEPOINT memory_search_sync');
    try {
      const result = this.syncSearchEntry(memoryId);
      this.database.exec('RELEASE memory_search_sync');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK TO memory_search_sync');
      this.database.exec('RELEASE memory_search_sync');
      throw error;
    }
  }

  syncSearchEntry(memoryId) {
    const memory = this.getMemory(memoryId);
    if (!memory) return;
    removeSearchRows(this.database, memoryId);
    if (memory.status === "deleted") return;
    const retrievalContext = this.getCurrentMemoryRetrievalContext(memoryId);
    const indexedContent = [
      memory.content,
      retrievalContext?.context_text,
      ...(retrievalContext?.queryTerms || []),
    ].map(clean).filter(Boolean).join("\n");
    const inserted = this.database.prepare(`
      INSERT INTO memory_fts (memory_id, agent_id, title, content)
      VALUES (?, ?, ?, ?)
    `).run(memory.id, memory.agent_id, memory.title, indexedContent);
    if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_fts_rows'").get()) {
      this.database.prepare(`INSERT INTO memory_fts_rows(fts_rowid,memory_id,agent_id,lexical_text) VALUES(?,?,?,?)`)
        .run(inserted.lastInsertRowid, memory.id, memory.agent_id, normalizedSearchDocument(`${memory.title}\n${memory.content}`));
    }
  }

  search(agentId, query, {
    limit = 10,
    includeArchived = false,
    kinds = [],
    layers = [],
    worldId = "",
    worldFrame = "",
  } = {}) {
    const text = clean(query);
    if (!text) return [];
    const maximum = Math.min(100, Math.max(1, Math.trunc(limit)));
    const statusClause = includeArchived
      ? "node.status <> 'deleted'"
      : "node.status = 'active'";
    const normalizedKinds = [...new Set(kinds.map(clean).filter(Boolean))];
    const normalizedLayers = [...new Set(layers.map(clean).filter(Boolean))];
    const normalizedWorldId = clean(worldId);
    const normalizedWorldFrame = clean(worldFrame);
    const kindClause = normalizedKinds.length
      ? `AND node.kind IN (${normalizedKinds.map(() => "?").join(", ")})`
      : "";
    const layerClause = normalizedLayers.length
      ? `AND node.layer IN (${normalizedLayers.map(() => "?").join(", ")})`
      : "";
    const worldIdClause = normalizedWorldId ? "AND node.world_id = ?" : "";
    const worldFrameClause = normalizedWorldFrame ? "AND node.world_frame = ?" : "";
    const filters = [
      ...(normalizedWorldId ? [normalizedWorldId] : []),
      ...(normalizedWorldFrame ? [normalizedWorldFrame] : []),
      ...normalizedKinds,
      ...normalizedLayers,
    ];
    try {
      const matches = this.database.prepare(`
        SELECT node.*, bm25(memory_fts) AS search_rank
        FROM memory_fts
        JOIN memory_nodes AS node ON node.id = memory_fts.memory_id
        WHERE memory_fts MATCH ?
          AND memory_fts.agent_id = ?
          AND ${statusClause}
          ${worldIdClause}
          ${worldFrameClause}
          ${kindClause}
          ${layerClause}
        ORDER BY search_rank ASC, node.importance DESC
        LIMIT ?
      `).all(`"${text.replaceAll('"', '""')}"`, agentId, ...filters, maximum)
        .map((row) => ({
          ...normalizeNode(row),
          search_rank: Number(row.search_rank),
        }));
      if (matches.length) return matches;
    } catch {
      // Short queries and builds without the preferred tokenizer use LIKE below.
    }
    const pattern = `%${text.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    return this.database.prepare(`
      SELECT node.*, 0 AS search_rank
      FROM memory_nodes AS node
      JOIN memory_fts AS fts_row ON fts_row.memory_id = node.id
        WHERE node.agent_id = ?
          AND ${statusClause}
          ${worldIdClause}
          ${worldFrameClause}
          ${kindClause}
        ${layerClause}
        AND (fts_row.title LIKE ? ESCAPE '\\' OR fts_row.content LIKE ? ESCAPE '\\')
      ORDER BY node.importance DESC, node.recorded_at DESC
      LIMIT ?
    `).all(agentId, ...filters, pattern, pattern, maximum).map(normalizeNode);
  }

  expand(agentId, seedIds, {
    maxDepth = 2,
    maxNodes = 30,
    minimumWeight = 0,
    relations = [],
    traversal = "both",
    includeDeleted = false,
    worldId = "",
    worldFrame = "",
    allowedMemoryIds = null,
  } = {}) {
    const requestedSeeds = [...new Set(seedIds.map(clean).filter(Boolean))];
    const normalizedWorldId = clean(worldId);
    const normalizedWorldFrame = clean(worldFrame);
    const nodeStatus = this.database.prepare(`
      SELECT status, world_id, world_frame FROM memory_nodes WHERE agent_id = ? AND id = ?
    `);
    const nodeAllowed = (id) => {
      if (allowedMemoryIds && !allowedMemoryIds.has(id)) return false;
      const row = nodeStatus.get(agentId, id);
      return Boolean(
        row
        && (includeDeleted || row.status !== "deleted")
        && (!normalizedWorldId || row.world_id === normalizedWorldId)
        && (!normalizedWorldFrame || row.world_frame === normalizedWorldFrame),
      );
    };
    const seeds = requestedSeeds.filter(nodeAllowed);
    const depthLimit = Math.min(8, Math.max(0, Math.trunc(maxDepth)));
    const nodeLimit = Math.min(500, Math.max(seeds.length, Math.trunc(maxNodes)));
    const relationSet = new Set(relations.map(clean).filter(Boolean));
    const visited = new Map(seeds.map((id) => [id, 0]));
    const queue = [...seeds];
    const traversedEdges = [];

    const outgoing = this.database.prepare(`
      SELECT * FROM memory_edges
      WHERE agent_id = ? AND from_memory_id = ? AND weight >= ?
      ORDER BY weight DESC, updated_at DESC
    `);
    const incoming = this.database.prepare(`
      SELECT * FROM memory_edges
      WHERE agent_id = ? AND to_memory_id = ? AND weight >= ?
      ORDER BY weight DESC, updated_at DESC
    `);

    while (queue.length && visited.size < nodeLimit) {
      const current = queue.shift();
      const depth = visited.get(current);
      if (depth >= depthLimit) continue;

      const candidates = [];
      if (traversal !== "incoming") {
        candidates.push(...outgoing.all(agentId, current, bounded(minimumWeight, 0)));
      }
      if (traversal !== "outgoing") {
        candidates.push(...incoming.all(agentId, current, bounded(minimumWeight, 0)));
      }
      for (const row of candidates) {
        const edge = normalizeEdge(row);
        if (relationSet.size && !relationSet.has(edge.relation)) continue;
        const neighbor = edge.from_memory_id === current
          ? edge.to_memory_id
          : edge.from_memory_id;
        if (!nodeAllowed(neighbor)) continue;
        traversedEdges.push(edge);
        if (visited.has(neighbor)) continue;
        visited.set(neighbor, depth + 1);
        queue.push(neighbor);
        if (visited.size >= nodeLimit) break;
      }
    }

    const nodes = [...visited.entries()]
      .map(([id, depth]) => ({ ...this.getMemory(id), depth }))
      .filter((node) => node.id);
    return {
      nodes,
      edges: [...new Map(traversedEdges.map((edge) => [edge.id, edge])).values()],
    };
  }
}
