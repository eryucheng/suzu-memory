import { memoryWorldScope, memoryWorldsCompatible } from './ontology.mjs';
import { enqueueMemoryMaintenanceTasks, MAINTENANCE_TASK_TYPES } from './maintenance-tasks.mjs';
import { createHash } from "node:crypto";
import { assertEventSourceExecutionCurrent } from "./event-source-execution.mjs";
import { modelCalendarFields } from './calendar-time.mjs';
import { updateAssociationGraph } from './association-graph.mjs';
import { syncMemoryRelationshipMemberships } from './relationship-structure.mjs';
import { ROOT_STATE_SCOPE_KEY } from './state-scope.mjs';
import { reconcileReportedStateEvidence } from './reported-state-evidence.mjs';

// Read the format written by this module; accept the existing legacy claim fields
// at this boundary so consumers do not each implement their own storage contract.
export function readReportedStateDraft(memory) {
  const metadata = memory?.metadata || {};
  if (Object.hasOwn(metadata, "reportedStateDraft")) return { ...(metadata.reportedStateDraft || {}) };
  const draft = {};
  for (const [field, legacy] of [
    ["preferenceClaim", "reportedPreference"],
    ["identityClaim", "reportedIdentity"],
    ["affectiveClaim", "reportedAffectiveAssociation"],
    ["conditionClaim", "reportedCondition"],
    ["habitClaim", "reportedHabit"],
    ["dispositionClaim", "reportedDisposition"],
  ]) {
    if (!draft[field] && (metadata[field] || metadata[legacy])) {
      draft[field] = metadata[field] || metadata[legacy];
    }
  }
  return draft;
}

function clean(value) {
  return String(value ?? "").trim();
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
  );
}

function canonicalHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

export function reportedStateSourceFingerprint(source) {
  return canonicalHash({
    id: source.id, agentId: source.agent_id, sourceKind: source.source_kind, externalId: source.external_id,
    occurredAt: source.occurred_at, knownAt: source.known_at, speaker: source.speaker, content: source.content,
  });
}

export function reportedStateEvidenceMemoryFingerprint({ memory, roles }) {
  return canonicalHash({
    id: memory.id, title: memory.title, content: memory.content,
    subjectRole: memory.subject_role, subjectKey: memory.subject_key, knownAt: memory.known_at,
    eventStart: memory.event_start,
    roles: roles.map(role => ({ role: role.role, actorRole: role.actor_role,
      actorKey: role.actor_key, isPrimary: role.is_primary })),
  });
}

function bounded(value, fallback = 0.5) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(1, Math.max(0, number));
}

function iso(value, label) {
  const parsed = new Date(clean(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Reported state ${label} is not a valid timestamp.`);
  }
  return parsed.toISOString();
}

const NEW_STATE_ACTIONS = new Set([
  "create", "narrow_scope", "supersede", "pause", "resume",
]);

export const REPORTED_STATE_REINFORCEMENT_PROVENANCE = "reported-state-reinforcement-v1";
const SAME_STATE_ACTIONS = new Set(["reinforce", "progress_update"]);
const EVIDENCE_FIELDS = ['evidenceObservationIds', 'evidenceMemoryIds', 'evidenceSourceIds'];

export function isReportedPreferenceReinforcement(proposal) {
  return proposal?.action === 'reinforce' && proposal.state_family === 'preference';
}

const TERMINAL_ACTIONS = Object.freeze({
  complete: Object.freeze({ statePhase: "completed", temporalState: "completed" }),
  cancel: Object.freeze({ statePhase: "cancelled", temporalState: "cancelled" }),
  end: Object.freeze({ statePhase: "ended", temporalState: "historical" }),
  retire: Object.freeze({ statePhase: "retired", temporalState: "historical" }),
  interrupt: Object.freeze({ statePhase: "interrupted", temporalState: "historical" }),
  stop: Object.freeze({ statePhase: "ended", temporalState: "historical" }),
  revoke: Object.freeze({ statePhase: "ended", temporalState: "historical" }),
});

export const REPORTED_STATE_TERMINAL_PHASES = Object.freeze([
  ...new Set(Object.values(TERMINAL_ACTIONS).map(value => value.statePhase)),
]);

const PENDING_TRANSITION_ACTIONS = new Set([
  ...Object.keys(TERMINAL_ACTIONS), ...[...NEW_STATE_ACTIONS].filter(action => action !== 'create'),
]);

class ReportedStateInputChangedError extends Error {}

export function isRepeatedReportedStateTransition(repository, proposal) {
  const terminal = TERMINAL_ACTIONS[proposal.action];
  const previous = proposal.previousMemoryId && repository.getMemory(proposal.previousMemoryId);
  return Boolean(terminal && previous?.agent_id === proposal.agent_id && previous.status === 'superseded'
    && previous.state_phase === terminal.statePhase && previous.temporal_state === terminal.temporalState);
}

function memoryLayer(stateFamily) {
  if (stateFamily === "goal") return "prospective";
  if (stateFamily === "relationship") return "relational";
  return "semantic";
}

function reportedProposalWorld(repository, proposal) {
  const semantic = readStateAnalysisSemanticMemory(repository, proposal);
  const selected = repository.getStateEvidenceObservation(proposal.agent_id, proposal.selectedObservationId);
  if (semantic) return memoryWorldScope(semantic);
  if (!selected) throw new ReportedStateInputChangedError('Reported state lost its selected world evidence.');
  return selected.world;
}

function currentState(repository, proposal, previousMemoryId = proposal.previousMemoryId) {
  const current = repository.getCurrentCanonicalMemory({
    ...reportedProposalWorld(repository, proposal),
    agentId: proposal.agent_id,
    subjectRole: proposal.subject_role,
    subjectKey: proposal.subject_key,
    canonicalKey: proposal.canonical_key,
    representationLayer: "reported",
    stateFamily: proposal.state_family,
    stateScopeKey: proposal.target_scope_key,
    includePending: true,
    includeHistorical: proposal.action !== "create",
    excludeMemoryId: provisionalStateId(proposal),
  });
  if ((current?.id || "") !== previousMemoryId) {
    throw new ReportedStateInputChangedError("Reported state changed after the proposal was reviewed.");
  }
  return current;
}

function carriedPreferenceObservation(repository, proposal, preview, observation) {
  if (proposal.state_family !== 'preference' || preview?.layer !== 'provisional'
    || observation?.lifecycle !== 'superseded' || observation.qualification !== 'qualified') return false;
  // A previously materialized preview can keep its reviewed claim when the
  // same utterance was analyzed again and explicitly matched back to it.
  const rows = repository.database.prepare(`SELECT id FROM memory_state_evidence_observations
    WHERE agent_id=? AND memory_id=? AND state_family='preference' AND canonical_key=?
      AND lifecycle='current' AND qualification='qualified' AND signal=? AND observed_at=?`)
    .all(proposal.agent_id, observation.memory_id, proposal.canonical_key, observation.signal, observation.observed_at);
  return rows.some(({ id }) => {
    const newer = repository.getStateEvidenceObservation(proposal.agent_id, id);
    const earlierScope = observation.payload?.timeScope;
    const laterScope = newer.payload?.timeScope;
    if (!earlierScope || !laterScope || newer.scope?.currentRepresentationLayer !== 'reported'
      || newer.subject_key !== observation.subject_key || newer.subject_role !== observation.subject_role
      || canonicalHash([...newer.sourceIds].sort()) !== canonicalHash([...observation.sourceIds].sort())
      || newer.payload?.explicitExpression?.directness !== 'explicit_self_statement'
      || newer.payload?.objectGrounding?.targetMatch !== observation.payload?.objectGrounding?.targetMatch
      || ['stateTime', 'scopeKind', 'contextLabel', 'revisionCue'].some(key => laterScope[key] !== earlierScope[key])) return false;
    const request = clean(newer.payload?.analysisRequest?.id);
    const match = request && repository.getStateAnalysisRequest(proposal.agent_id, request)?.metadata?.stateIdentityResolution;
    return match?.resolution === 'matched' && match.candidateId === preview.id;
  });
}

function reviewedEvidence(repository, proposal, legacyPreview = null) {
  const evidenceSnapshot = proposal.metadata?.reportedStateEvidenceSnapshot;
  if (evidenceSnapshot?.version !== "reported-state-evidence-snapshot-v1"
    || !clean(evidenceSnapshot.selectedContent)
    || !Array.isArray(evidenceSnapshot.observations)) {
    throw new ReportedStateInputChangedError("Reported state proposal does not contain an immutable evidence snapshot.");
  }
  const snapshotByObservationId = new Map(
    evidenceSnapshot.observations.map((item) => [clean(item.observationId), item]),
  );
  let selected = null;
  const contributions = [];
  for (const observationId of proposal.consideredObservationIds) {
    const observation = repository.getStateEvidenceObservation(proposal.agent_id, observationId);
    if (!observation || (observation.lifecycle !== "current" && !carriedPreferenceObservation(repository, proposal, legacyPreview, observation))
      || observation.state_family !== proposal.state_family
      || observation.subject_role !== proposal.subject_role
      || observation.subject_key !== proposal.subject_key
      || observation.canonical_key !== proposal.canonical_key
      || clean(observation.scope?.currentRepresentationLayer) !== "reported") {
      throw new ReportedStateInputChangedError("Reported state proposal evidence changed or crossed its reviewed target.");
    }
    const memoryId = clean(observation.memory_id || observation.memoryId);
    const detail = repository.getMemoryDetail(proposal.agent_id, memoryId);
    if (!detail || detail.memory.status === "deleted") {
      throw new ReportedStateInputChangedError("Reported state proposal evidence memory is no longer available.");
    }
    const linkedSourceIds = new Set(detail.sources.map((source) => source.id));
    if (!observation.sourceIds.length
      || observation.sourceIds.some((sourceId) => !linkedSourceIds.has(sourceId))) {
      throw new ReportedStateInputChangedError("Reported state proposal evidence sources changed after review.");
    }
    const recordedSnapshot = snapshotByObservationId.get(observation.id);
    if (!recordedSnapshot
      || clean(recordedSnapshot.observationHash) !== clean(observation.observation_hash)
      || clean(recordedSnapshot.memoryId) !== memoryId
      || clean(recordedSnapshot.memoryFingerprint) !== reportedStateEvidenceMemoryFingerprint(detail)) {
      throw new ReportedStateInputChangedError("Reported state proposal evidence memory changed after review.");
    }
    const recordedSourceFingerprints = new Map(
      (recordedSnapshot.sourceFingerprints || []).map((item) => [clean(item.id), clean(item.fingerprint)]),
    );
    for (const sourceId of [...observation.sourceIds].sort()) {
      const source = detail.sources.find((item) => item.id === sourceId);
      if (source.lifecycle !== "active") {
        throw new ReportedStateInputChangedError("Reported state proposal evidence source is no longer active.");
      }
      const fingerprint = reportedStateSourceFingerprint(source);
      if (recordedSourceFingerprints.get(sourceId) !== fingerprint) {
        throw new ReportedStateInputChangedError("Reported state proposal evidence source changed after review.");
      }
    }
    if (proposal.draft?.evidenceObservationIds?.includes(observation.id)) {
      if (observation.qualification !== "qualified") throw new ReportedStateInputChangedError("Aggregated state evidence is no longer qualified.");
      contributions.push({ observation, detail });
    }
    if (observation.id === proposal.selectedObservationId) {
      if (observation.qualification !== "qualified") {
        throw new ReportedStateInputChangedError("Reported state proposal selected evidence is no longer qualified.");
      }
      selected = { observation, detail, contentSnapshot: evidenceSnapshot.selectedContent };
    }
  }
  if (!selected) throw new ReportedStateInputChangedError("Reported state proposal lost its selected evidence.");
  if (proposal.state_family === 'preference' && selected.observation.payload?.analysisRequest
    && !selected.detail.roles.some(role => role.role === 'speaker' && role.is_primary
      && role.actor_role === proposal.subject_role && role.actor_key === proposal.subject_key)) {
    throw new ReportedStateInputChangedError('A reported preference requires the subject’s own statement.');
  }
  const world = reportedProposalWorld(repository, proposal);
  if (!readStateAnalysisSemanticMemory(repository, proposal) && ![selected, ...contributions].every(item => memoryWorldsCompatible(world, item.observation.world, { allowRealSpaces: true }))) {
    throw new ReportedStateInputChangedError('Reported state contributing evidence crosses incompatible worlds.');
  }
  const draft = proposal.draft || {};
  if (NEW_STATE_ACTIONS.has(proposal.action) || ["reinforce", "add_scoped_exception"].includes(proposal.action)) {
    const selectedMemoryId = clean(selected.observation.memory_id || selected.observation.memoryId);
    if (!Array.isArray(draft.evidenceObservationIds)
      || !draft.evidenceObservationIds.includes(selected.observation.id)
      || !Array.isArray(draft.evidenceMemoryIds)
      || !draft.evidenceMemoryIds.includes(selectedMemoryId)
      || !Array.isArray(draft.evidenceSourceIds)
      || selected.observation.sourceIds.some((sourceId) => !draft.evidenceSourceIds.includes(sourceId))) {
      throw new ReportedStateInputChangedError("Reported state draft does not preserve its selected evidence chain.");
    }
  }
  if (contributions.length) {
    const ids = new Set(contributions.map(item => item.observation.id));
    const memories = new Set(contributions.map(item => item.detail.memory.id));
    const sources = new Set(contributions.flatMap(item => item.observation.sourceIds));
    if (draft.evidenceObservationIds.some(id => !ids.has(id))
      || draft.evidenceMemoryIds.some(id => !memories.has(id)) || draft.evidenceSourceIds.some(id => !sources.has(id))) {
      throw new ReportedStateInputChangedError("Aggregated state evidence escapes the reviewed snapshot.");
    }
    selected.contributions = contributions;
  }
  return selected;
}

function actorRoles(proposal, { provisional = false } = {}) {
  const roles = [{
    role: "subject",
    actorRole: proposal.subject_role,
    actorKey: proposal.subject_key,
    isPrimary: true,
    confidence: 1,
    provenance: provisional ? "pending-reported-state-proposal-v1" : "accepted-reported-state-proposal-v1",
    metadata: { reportedStateProposalId: proposal.id },
  }];
  if (proposal.proposed_kind === "belief_state") {
    roles.push({
      ...roles[0],
      role: "belief_holder",
    });
  } else if (proposal.proposed_kind === "preference") {
    roles.push({
      ...roles[0],
      role: "preference_holder",
    });
  }
  const counterpart = proposal.draft?.counterpart;
  if (proposal.state_family === "relationship"
    && clean(counterpart?.role) && clean(counterpart?.key)) {
    roles.push({
      role: "participant",
      actorRole: clean(counterpart.role),
      actorKey: clean(counterpart.key),
      isPrimary: false,
      confidence: 1,
      provenance: provisional ? "pending-reported-state-proposal-v1" : "accepted-reported-state-proposal-v1",
      metadata: {
        reportedStateProposalId: proposal.id,
        label: clean(counterpart.label),
      },
    });
  }
  return roles;
}

function reportedStateContent(proposal, evidence, semantic) {
  const values = proposal.state_family === "identity" ? proposal.draft?.identityClaim?.values : null;
  if (values?.length > 1) {
    return [clean(proposal.metadata?.target?.subjectLabel), clean(proposal.metadata?.target?.stateLabel)]
      .filter(Boolean).join(" · ") + "：\n" + values.map(item => clean(item.valueScope)
        ? clean(item.valueText) + " (" + clean(item.valueScope) + ")" : clean(item.valueText)).filter(Boolean).join("; ");
  }
  if (semantic) return semantic.content;
  const statements = [...new Set((evidence.contributions || []).map(item => clean(item.detail.memory.content)).filter(Boolean))];
  return statements.length > 1 ? statements.join("\n") : evidence.contentSnapshot;
}

function stateCalendarMetadata(semantic, evidence) {
  const hasEventTime = semantic && (semantic.event_date || semantic.event_start || semantic.event_end);
  return hasEventTime ? modelCalendarFields(semantic, [])
    : modelCalendarFields(evidence.detail.memory, [], evidence.detail.sources);
}

function materializeState(repository, proposal, evidence) {
  const validityStart = iso(proposal.draft.validFrom, "validity start");
  const pending = repository.getMemory(provisionalStateId(proposal));
  // Promote stored preference previews in place, including versions already
  // referenced by a later transition. Other families keep their legacy path.
  const referenced = pending && pending.status !== 'deleted' && (proposal.state_family === 'preference'
    || pending.metadata?.reportedStateTransition || repository.database.prepare(`SELECT 1 FROM memory_reported_state_proposals
      WHERE agent_id = ? AND previous_memory_id = ? LIMIT 1`).get(proposal.agent_id, pending.id));
  const memoryId = referenced ? pending.id : `reported-state-${createHash("sha256")
    .update(`${proposal.agent_id}\u001f${proposal.id}`)
    .digest("hex")
    .slice(0, 24)}`;
  const stateLabel = clean(proposal.metadata?.target?.stateLabel);
  const semantic = readStateAnalysisSemanticMemory(repository, proposal);
  return repository.upsertMemory({
    id: memoryId,
    agentId: proposal.agent_id,
    kind: proposal.proposed_kind,
    layer: memoryLayer(proposal.state_family),
    title: semantic?.title ?? stateLabel,
    content: reportedStateContent(proposal, evidence, semantic),
    subjectRole: proposal.subject_role,
    subjectKey: proposal.subject_key,
    canonicalKey: proposal.canonical_key,
    ...reportedProposalWorld(repository, proposal),
    evidenceMode: "explicit",
    representationLayer: "reported",
    stateFamily: proposal.state_family,
    stateScopeKey: proposal.proposed_scope_key,
    statePhase: referenced ? pending.state_phase : proposal.state_phase,
    temporalState: referenced ? pending.temporal_state : proposal.temporal_state,
    revisionAction: ["create", "add_scoped_exception"].includes(proposal.action)
      ? "add"
      : "update",
    eventDate: semantic?.event_date || null,
    eventStart: semantic?.event_start || null,
    eventEnd: semantic?.event_end || null,
    knownAt: semantic?.known_at || evidence.detail.memory.known_at || evidence.observation.observed_at,
    validFrom: validityStart,
    validTo: referenced ? pending.valid_to : null,
    status: referenced && pending.status === "superseded" ? pending.status : "active",
    confidence: bounded(evidence.observation.confidence, 0.75),
    importance: 0.6,
    actorRoles: actorRoles(proposal),
    metadata: {
      reportedStateProposalId: proposal.id,
      ...stateCalendarMetadata(semantic, evidence),
      reportedStateAction: proposal.action,
      reportedStateReviewVersion: proposal.review_version,
      reportedStateInputHash: proposal.input_hash,
      reportedStateDraft: proposal.draft,
      ...(semantic?.metadata?.stateTarget ? { stateTarget: semantic.metadata.stateTarget } : {}),
      truthBoundary: proposal.metadata?.truthBoundary || {},
      ...(referenced && pending.metadata?.reportedStateTransitionId
        ? { reportedStateTransitionId: pending.metadata.reportedStateTransitionId } : {}),
    },
  });
}

function attachSelectedEvidence(repository, proposal, targetMemory, evidence, {
  challenged = false,
  provisional = false,
  reuseExisting = false,
  edgeOnly = false,
} = {}) {
  if (!edgeOnly) {
    const related = [readStateAnalysisSemanticMemory(repository, proposal)?.id,
      ...(evidence.contributions || [evidence]).map(item => item.detail.memory.id)].filter(Boolean);
    const entityIds = [...new Set(related.flatMap(id => repository.listMemoryEntities(id).map(entity => entity.id)))];
    repository.linkMemoryEntities({ memoryId: targetMemory.id, entityIds });
  }
  const existingDraft = reuseExisting ? readReportedStateDraft(targetMemory) : {};
  const existingObservations = new Set(existingDraft.evidenceObservationIds || []);
  const existingSources = new Set(existingDraft.evidenceSourceIds || []);
  for (const contribution of evidence.contributions || [evidence]) {
    if (existingObservations.has(contribution.observation.id)) continue;
    const sourceById = new Map(contribution.detail.sources.map((source) => [source.id, source]));
    for (const sourceId of edgeOnly ? [] : contribution.observation.sourceIds) {
      if (existingSources.has(sourceId)) continue;
      const source = sourceById.get(sourceId);
      repository.linkSource(targetMemory.id, sourceId, `reported_state_${proposal.action}`, {
        authority: clean(source?.authority) || "subject_firsthand",
        sourceTrust: bounded(source?.source_trust, 0.8),
        evidenceStrength: bounded(contribution.observation.confidence, 0.75),
        provenance: stateEvidenceProvenance(proposal, provisional),
        metadata: {
          reportedStateProposalId: proposal.id,
          stateFamily: proposal.state_family,
          action: proposal.action,
          observationId: contribution.observation.id,
        },
      });
    }
    if (targetMemory.id !== contribution.detail.memory.id) {
      const key = {
        agentId: proposal.agent_id,
        fromMemoryId: targetMemory.id,
        toMemoryId: contribution.detail.memory.id,
        relation: challenged ? "challenged_by" : "supported_by",
      };
      if ((edgeOnly || reuseExisting) && repository.findEdge(key)) continue;
      repository.upsertEdge({
        ...key,
        direction: "directed",
        weight: challenged ? 0.8 : 0.9,
        confidence: bounded(contribution.observation.confidence, 0.75),
        provenance: stateEvidenceProvenance(proposal, provisional),
        metadata: {
          reportedStateProposalId: proposal.id,
          stateFamily: proposal.state_family,
          action: proposal.action,
          observationId: contribution.observation.id,
        },
      });
    }
  }
}

function stateEvidenceProvenance(proposal, provisional = false) {
  if (provisional) return 'pending-reported-state-proposal-v1';
  return proposal.state_family === 'preference' ? 'reported-preference-proposal-v1' : 'accepted-reported-state-proposal-v1';
}

function provisionalStateId(proposal) {
  return `pending-reported-state-${canonicalHash([proposal.agent_id, proposal.id]).slice(0, 24)}`;
}

export function readReportedStateTransition(repository, proposal) {
  return preferenceApplication(proposal)?.transition || proposal.metadata?.reportedStateApplication?.transition
    || repository.getMemory(provisionalStateId(proposal))?.metadata?.reportedStateTransition || null;
}

export function reportedStateMaterializedMemory(repository, proposal) {
  return repository.getMemory(proposal.resultMemoryId || provisionalStateId(proposal));
}

export function withdrawnReportedPreferenceSources(repository, {
  agentId, subjectRole, subjectKey, canonicalKey, stateLabel,
}) {
  const rows = repository.database.prepare(`
    WITH withdrawn AS (
      SELECT id, metadata_json FROM memory_reported_state_proposals
      WHERE agent_id=? AND state_family='preference' AND review_state='dismissed'
        AND subject_role=? AND subject_key=?
        AND (canonical_key=? OR lower(trim(json_extract(metadata_json, '$.target.stateLabel')))=?)
    )
    SELECT source.value AS id FROM withdrawn
    JOIN json_each(COALESCE(json_extract(metadata_json, '$.reportedPreferenceApplication.sourceIds'),
      json_extract(metadata_json, '$.reportedStateReinforcement.sourceIds'))) source
    UNION
    SELECT source.source_id AS id FROM withdrawn
    JOIN memory_reported_state_proposal_observations link ON link.proposal_id=withdrawn.id AND link.evidence_role='selected'
    JOIN memory_state_observation_sources source ON source.agent_id=link.agent_id AND source.observation_id=link.observation_id
  `).all(agentId, subjectRole, subjectKey, canonicalKey, clean(stateLabel).toLowerCase());
  return new Set(rows.map(row => row.id));
}

function attachPreferenceSupport(repository, proposal, memory, evidence) {
  const usedSources = new Set(repository.listMemorySources(memory.id).map(source => source.id));
  const withdrawnSources = withdrawnReportedPreferenceSources(repository, {
    agentId: proposal.agent_id,
    subjectRole: proposal.subject_role,
    subjectKey: proposal.subject_key,
    canonicalKey: proposal.canonical_key,
    stateLabel: proposal.metadata?.target?.stateLabel,
  });
  const addedSources = [];
  for (const contribution of evidence.contributions || [evidence]) {
    const toMemoryId = contribution.detail.memory.id;
    const sourceIds = contribution.observation.sourceIds;
    if (sourceIds.some(id => withdrawnSources.has(id)) || toMemoryId === memory.id) continue;
    const edgeKey = { agentId: proposal.agent_id, fromMemoryId: memory.id, toMemoryId, relation: 'supported_by' };
    const evidenceSourceIds = sourceIds.filter(id => !usedSources.has(id));
    if (!evidenceSourceIds.length || repository.findEdge(edgeKey)) continue;
    repository.upsertEdge({
      ...edgeKey, direction: 'directed', weight: 0.9,
      confidence: bounded(contribution.observation.confidence, 0.75),
      provenance: REPORTED_STATE_REINFORCEMENT_PROVENANCE,
      metadata: { reportedStateProposalId: proposal.id, evidenceSourceIds },
    });
    for (const id of evidenceSourceIds) {
      usedSources.add(id);
      addedSources.push(id);
    }
  }
  return { status: 'reinforced', memory, previous: memory, sourceIds: addedSources };
}

function preferenceApplication(proposal) {
  if (proposal.state_family !== 'preference') return null;
  const legacy = proposal.metadata?.reportedStateReinforcement;
  return proposal.metadata?.reportedPreferenceApplication || (legacy && { ...legacy, status: 'reinforced' });
}

export function reportedStateVersion(memory) {
  return canonicalHash([memory.subject_role, memory.subject_key, memory.canonical_key, memory.state_scope_key,
    memory.representation_layer, memory.state_family, memory.kind, memory.layer, memoryWorldScope(memory),
    memory.title, memory.content, memory.event_date, memory.event_start, memory.event_end, memory.valid_from,
    readReportedStateDraft(memory).preferenceClaim]);
}

export function appliedReportedPreferenceMemory(repository, proposal, { includeDeleted = false } = {}) {
  if (proposal.state_family !== 'preference' || !proposal.resultMemoryId || proposal.review_state === 'dismissed') return null;
  const memory = repository.getMemory(proposal.resultMemoryId);
  if (!memory || (!includeDeleted && memory.status === 'deleted') || memory.agent_id !== proposal.agent_id) return null;
  const application = preferenceApplication(proposal);
  if (proposal.action === 'reinforce') {
    return application?.sourceIds?.length && (includeDeleted || repository.listMemorySources(memory.id).some(source =>
      source.evidence_provenance === REPORTED_STATE_REINFORCEMENT_PROVENANCE
      && source.evidenceMetadata.reportedStateProposalId === proposal.id)) ? memory : null;
  }
  if (proposal.action === 'correct_attribution') {
    return application?.transition && memory.metadata?.reportedStateTransitionId === proposal.id
      && memory.status === 'disputed' ? memory : null;
  }
  // Older creations and scoped exceptions already identify the node they own.
  // Version replacements need their recorded previous-state transition as well.
  const legacyOwnedNode = ['create', 'add_scoped_exception'].includes(proposal.action);
  return memory.metadata?.reportedStateProposalId === proposal.id && !memory.metadata?.manuallyEdited
    && (application ? application.version === reportedStateVersion(memory) : legacyOwnedNode) ? memory : null;
}

export function suspendedReportedPreferenceMemory(repository, proposal) {
  if (proposal?.action === 'reinforce') {
    const memory = appliedReportedPreferenceMemory(repository, proposal, { includeDeleted: true });
    if (!memory) return null;
    const support = repository.database.prepare(`SELECT 1 FROM memory_edges
      WHERE agent_id=? AND from_memory_id=? AND relation='supported_by' AND provenance=?
        AND json_extract(metadata_json, '$.reportedStateProposalId')=? LIMIT 1`)
      .get(proposal.agent_id, memory.id, REPORTED_STATE_REINFORCEMENT_PROVENANCE, proposal.id);
    return support ? memory : null;
  }
  const resultMemoryId = preferenceApplication(proposal || {})?.suspendedMemoryId;
  if (!resultMemoryId || proposal.resultMemoryId) return null;
  const memory = appliedReportedPreferenceMemory(repository, { ...proposal, resultMemoryId }, { includeDeleted: true });
  return memory?.status === 'deleted' ? memory : null;
}

function invalidatePreferenceSupport(repository, { agentId, memoryIds, sourceId }) {
  const edges = repository.database.prepare(`
    DELETE FROM memory_edges WHERE agent_id=? AND provenance=? AND relation='supported_by'
      AND to_memory_id IN (SELECT value FROM json_each(?))
      AND (? IS NULL OR ? IN (SELECT value FROM json_each(metadata_json, '$.evidenceSourceIds')))
    RETURNING from_memory_id AS memoryId, json_extract(metadata_json, '$.reportedStateProposalId') AS proposalId`
  ).all(agentId, REPORTED_STATE_REINFORCEMENT_PROVENANCE, JSON.stringify(memoryIds), sourceId, sourceId);
  if (!edges.length) return;
  const clear = repository.database.prepare(`UPDATE memory_reported_state_proposals
    SET result_memory_id=NULL, updated_at=? WHERE agent_id=? AND id=? AND result_memory_id=?
      AND NOT EXISTS (SELECT 1 FROM memory_edges WHERE agent_id=? AND from_memory_id=?
        AND relation='supported_by' AND provenance=? AND json_extract(metadata_json, '$.reportedStateProposalId')=?)`);
  const now = new Date().toISOString();
  for (const { memoryId, proposalId } of edges) {
    clear.run(now, agentId, proposalId, memoryId, agentId, memoryId, REPORTED_STATE_REINFORCEMENT_PROVENANCE, proposalId);
  }
}

export function invalidateReportedPreferenceEvidence(repository, {
  agentId, memoryIds, sourceId = null, erasing = null, evidenceOnly = false, reversible = false,
}) {
  if (!memoryIds.length) return;
  // Supplementary links remain owned by the proposal while a speech record is
  // soft-deleted. The source reader excludes it until that record is restored.
  if (!reversible) invalidatePreferenceSupport(repository, { agentId, memoryIds, sourceId });
  const ids = JSON.stringify(memoryIds);
  if (!erasing && !reversible) {
    const observations = repository.database.prepare(`
      SELECT observation.id FROM memory_state_evidence_observations observation
      WHERE observation.agent_id=? AND observation.memory_id IN (SELECT value FROM json_each(?))
        AND observation.state_family='preference' AND observation.lifecycle='current'
        AND json_extract(observation.scope_json, '$.currentRepresentationLayer')='reported'
        AND (? IS NULL OR EXISTS (SELECT 1 FROM memory_state_observation_sources source
          WHERE source.agent_id=observation.agent_id AND source.observation_id=observation.id AND source.source_id=?))
    `).all(agentId, ids, sourceId, sourceId);
    for (const { id } of observations) repository.withdrawStateEvidenceObservation({ agentId, observationId: id });
  }
  const affected = repository.database.prepare(`
    WITH changed AS (SELECT value AS id FROM json_each(?)), proposals AS (
      SELECT link.proposal_id AS id
      FROM memory_state_evidence_observations observation
      JOIN memory_reported_state_proposal_observations link
        ON link.agent_id=observation.agent_id AND link.observation_id=observation.id
      WHERE observation.agent_id=? AND observation.memory_id IN changed
      UNION SELECT json_extract(memory.metadata_json, '$.reportedStateProposalId')
      FROM memory_nodes memory WHERE memory.id IN changed AND memory.agent_id=? AND ?=0
    )
    SELECT proposal.id FROM memory_reported_state_proposals proposal
    WHERE proposal.agent_id=? AND proposal.id IN proposals AND proposal.state_family='preference'
      AND proposal.action<>'reinforce'
      AND (proposal.result_memory_id IS NOT NULL
        OR json_type(proposal.metadata_json, '$.reportedPreferenceApplication.suspendedMemoryId')='text')
      AND proposal.review_state IN ('pending','accepted')
    ORDER BY proposal.created_at DESC, proposal.id DESC
  `).all(ids, agentId, agentId, Number(evidenceOnly), agentId);
  const changed = new Set(memoryIds);
  for (const { id } of affected) {
    const proposal = repository.getReportedStateProposal(agentId, id);
    const application = preferenceApplication(proposal);
    const lostResult = !sourceId && !evidenceOnly && changed.has(proposal.resultMemoryId);
    const lostEvidence = application?.evidenceMemoryIds?.some(memoryId => changed.has(memoryId))
      && (!sourceId || application.sourceIds.includes(sourceId));
    if (!lostResult && !lostEvidence) continue;
    const memory = appliedReportedPreferenceMemory(repository, proposal, { includeDeleted: true });
    let metadata = proposal.metadata;
    if (application) {
      const { suspendedMemoryId, ...record } = application;
      if (reversible && lostEvidence && !lostResult) {
        const eligible = memory?.status === 'active' && Boolean(application.version);
        if (eligible || suspendedMemoryId) record.suspendedMemoryId = eligible ? memory.id : suspendedMemoryId;
      }
      metadata = { ...metadata, reportedPreferenceApplication: record };
    }
    repository.database.prepare(`UPDATE memory_reported_state_proposals
      SET result_memory_id=NULL, metadata_json=?, updated_at=? WHERE agent_id=? AND id=?`)
      .run(JSON.stringify(metadata), new Date().toISOString(), agentId, id);
    undoReportedPreference(repository, proposal, memory, 'system', 'Reported preference evidence changed.', erasing);
  }
}

export function stateAnalysisSemanticMemoryMatches(memory, { agentId, requestId, snapshot = null }) {
  return Boolean(memory && memory.agent_id === agentId && memory.status !== 'deleted'
    && memory.metadata?.stateAnalysisDraft === true && memory.metadata.stateAnalysisRequestId === requestId
    && (!snapshot || (memory.title === snapshot.title && memory.content === snapshot.content)));
}

export function readStateAnalysisSemanticMemory(repository, proposal) {
  const id = proposal.metadata?.semanticMemoryId;
  if (!id) return null;
  const memory = repository.getMemory(id);
  if (!stateAnalysisSemanticMemoryMatches(memory, { agentId: proposal.agent_id,
    requestId: proposal.metadata.stateAnalysisRequestId, snapshot: proposal.metadata.semanticMemorySnapshot || {} })) {
    throw new ReportedStateInputChangedError('State analysis semantic memory is no longer available.');
  }
  return memory;
}

export function materializeReportedStateProposal(repository, { agentId, proposalId } = {}) {
  const proposal = repository.getReportedStateProposal(clean(agentId), proposalId);
  if (!proposal) throw new Error("Reported state proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") return { status: "skipped", proposal, memory: null };
  if (proposal.state_family === 'preference') return repository.transaction(() =>
    applyReportedPreference(repository, repository.getReportedStateProposal(proposal.agent_id, proposal.id)));
  if (proposal.metadata?.reportedStateApplication) return { status: 'existing', proposal,
    memory: appliedReportedStateMemory(repository, proposal) };
  const existing = repository.getMemory(provisionalStateId(proposal));
  if (existing && (existing.status === 'deleted' || !PENDING_TRANSITION_ACTIONS.has(proposal.action) || existing.metadata?.reportedStateTransition || existing.metadata?.reportedStateConfirmation)) {
    return { status: "existing", proposal, memory: existing };
  }
  return repository.transaction(() => {
    const previous = proposal.previousMemoryId ? repository.getMemory(proposal.previousMemoryId) : null;
    const evidence = reviewedEvidence(repository, proposal);
    const terminal = TERMINAL_ACTIONS[proposal.action];
    let transition = null;
    let confirmation = null;
    if (PENDING_TRANSITION_ACTIONS.has(proposal.action)) {
      const current = currentState(repository, proposal);
      if (!current) throw new Error("Reported state transition lost its reviewed current state.");
      if (isRepeatedReportedStateTransition(repository, proposal)) {
        confirmation = { memoryId: current.id, statePhase: current.state_phase, validTo: current.valid_to };
      } else {
        rejectUnsafeRootTransition(repository, proposal, current);
        transition = recordStateClosure(repository, proposal, current, () => terminal
          ? repository.closeReportedMemoryState({ agentId: proposal.agent_id,
          memoryId: current.id, stateFamily: proposal.state_family,
          statePhase: terminal.statePhase, temporalState: terminal.temporalState,
          validTo: evidence.observation.observed_at, allowPending: true })
          : current.status === 'superseded' ? current : repository.closeCurrentMemoryState({ agentId: proposal.agent_id,
            memoryId: current.id, validTo: proposal.draft.validFrom, allowPending: true }));
      }
    }
    const semantic = readStateAnalysisSemanticMemory(repository, proposal);
    const memory = repository.upsertMemory({
      id: provisionalStateId(proposal), agentId: proposal.agent_id,
      kind: proposal.proposed_kind || previous?.kind,
      layer: "provisional", status: "archived",
      title: semantic?.title ?? (clean(proposal.metadata?.target?.stateLabel) || previous?.title || ""),
      content: reportedStateContent(proposal, evidence, semantic),
      subjectRole: proposal.subject_role, subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key, evidenceMode: "explicit",
      ...reportedProposalWorld(repository, proposal),
      representationLayer: "reported", stateFamily: proposal.state_family,
      stateScopeKey: proposal.proposed_scope_key,
      statePhase: terminal?.statePhase || proposal.state_phase || previous?.state_phase,
      temporalState: terminal?.temporalState || proposal.temporal_state || previous?.temporal_state,
      eventDate: semantic?.event_date || null,
      eventStart: semantic?.event_start || null,
      eventEnd: semantic?.event_end || null,
      knownAt: semantic?.known_at || evidence.detail.memory.known_at || evidence.observation.observed_at,
      validFrom: proposal.draft?.validFrom || evidence.observation.observed_at,
      confidence: bounded(evidence.observation.confidence, 0.75), importance: 0.6,
      actorRoles: actorRoles({ ...proposal, proposed_kind: proposal.proposed_kind || previous?.kind }, { provisional: true }),
      metadata: {
        provisional: true, reviewState: "pending", epistemicStatus: "reported_state",
        ...stateCalendarMetadata(semantic, evidence),
        reportedStateProposalId: proposal.id, reportedStateAction: proposal.action,
        reportedStatePreviousMemoryId: proposal.previousMemoryId,
        reportedStateDraft: proposal.draft,
        ...(semantic?.metadata?.stateTarget ? { stateTarget: semantic.metadata.stateTarget } : {}),
          ...(transition ? { reportedStateTransition: transition } : {}),
          ...(confirmation ? { reportedStateConfirmation: confirmation } : {}),
      },
    });
    attachSelectedEvidence(repository, proposal, memory, evidence, { provisional: true });
    if (transition && !terminal) repository.upsertEdge({
      agentId: proposal.agent_id, fromMemoryId: memory.id, toMemoryId: previous.id,
      relation: 'supersedes', direction: 'directed', weight: 1,
      confidence: bounded(evidence.observation.confidence, 0.75),
      provenance: 'pending-reported-state-proposal-v1',
      metadata: { reportedStateProposalId: proposal.id, transition: proposal.action },
    });
    enqueueMemoryMaintenanceTasks({ repository, agentId: proposal.agent_id,
      batchId: 'pending-reported-state:' + memory.id, memoryIds: [memory.id],
      taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding] });
    return { status: "created", proposal, memory };
  });
}

export function materializePendingReportedStateProposals(repository, { agentId, action = "", stateFamily = "" } = {}) {
  const ids = repository.database.prepare(`
    SELECT proposal.id FROM memory_reported_state_proposals proposal
    WHERE proposal.agent_id = ? AND proposal.review_state = 'pending' AND (? = '' OR proposal.action = ?)
      AND (? = '' OR proposal.state_family = ?)
      AND ((proposal.state_family = 'preference'
          AND proposal.result_memory_id IS NULL
          AND json_type(proposal.metadata_json, '$.reportedPreferenceApplication') IS NULL
          AND json_type(proposal.metadata_json, '$.reportedStateReinforcement') IS NULL)
        OR (proposal.state_family <> 'preference' AND proposal.result_memory_id IS NULL
          AND json_type(proposal.metadata_json, '$.reportedStateApplication') IS NULL
          AND NOT EXISTS (SELECT 1 FROM memory_nodes memory WHERE memory.agent_id = proposal.agent_id
        AND memory.layer = 'provisional'
        AND json_extract(memory.metadata_json, '$.reportedStateProposalId') = proposal.id
        AND (proposal.action NOT IN (${[...PENDING_TRANSITION_ACTIONS].map(() => '?').join(',')})
          OR memory.status = 'deleted'
            OR json_extract(memory.metadata_json, '$.reportedStateTransition') IS NOT NULL
          OR json_extract(memory.metadata_json, '$.reportedStateConfirmation') IS NOT NULL))))
    ORDER BY proposal.created_at, proposal.id
  `).all(clean(agentId), action, action, stateFamily, stateFamily, ...PENDING_TRANSITION_ACTIONS);
  const materialized = [];
  const failed = [];
  for (const { id } of ids) {
    try {
      const result = materializeReportedStateProposal(repository, { agentId, proposalId: id });
      if (result.status !== 'skipped') materialized.push(result);
    }
    catch (error) { assertEventSourceExecutionCurrent(); failed.push({ proposalId: id, error: error.message }); }
  }
  return { materialized, failed };
}

export function recordStateClosure(repository, proposal, current, close) {
  const closed = close();
  repository.updateMemoryMetadata({ agentId: proposal.agent_id, memoryId: current.id,
    metadata: { ...current.metadata, reportedStateTransitionId: proposal.id },
    reason: "Record reported state transition ownership." });
  const fields = memory => ({
    layer: memory.layer, status: memory.status, state_phase: memory.state_phase,
    temporal_state: memory.temporal_state, valid_to: memory.valid_to,
    transitionId: memory.metadata?.reportedStateTransitionId || '',
  });
  return { memoryId: current.id, before: fields(current), applied: fields(closed) };
}

function removeProvisionalState(repository, proposal, actor, reason, retainedMemoryId = "") {
  const memory = repository.getMemory(provisionalStateId(proposal));
  if (memory && memory.id !== retainedMemoryId && memory.status !== "deleted") repository.setMemoryDeleted({
    agentId: proposal.agent_id, memoryId: memory.id, actor, reason,
  });
}

function finish(repository, proposal, { memory, status, previous }, resolvedBy, note) {
  removeProvisionalState(repository, proposal, resolvedBy, "Reported state proposal accepted.", memory.id);
  return {
    status,
    proposal: repository.resolveReportedStateProposalRecord({
      agentId: proposal.agent_id,
      proposalId: proposal.id,
      resolution: "accepted",
      resultMemoryId: memory.id,
      resolvedBy,
      note,
    }),
    memory: repository.getMemory(memory.id),
    previous: previous ? repository.getMemory(previous.id) : null,
  };
}

function rejectUnsafeRootTransition(repository, proposal, current) {
  if (!current || current.state_scope_key !== ROOT_STATE_SCOPE_KEY) return;
  const changesRootLifecycle = NEW_STATE_ACTIONS.has(proposal.action)
    || Boolean(TERMINAL_ACTIONS[proposal.action])
    || proposal.action === "correct_attribution";
  if (!changesRootLifecycle) return;
  const exceptions = repository.listCurrentScopedExceptions({
    agentId: proposal.agent_id,
    rootMemoryId: current.id,
  });
  const polarity = proposal.draft?.preferenceClaim?.polarity;
  const compatiblePreferenceReplacement = proposal.state_family === 'preference'
    && proposal.action === 'supersede' && ['positive', 'negative'].includes(polarity)
    && exceptions.every(memory => readReportedStateDraft(memory).preferenceClaim?.polarity === polarity);
  if (exceptions.length && !compatiblePreferenceReplacement) {
  throw new ReportedStateInputChangedError(
      "Reported root state has active scoped exceptions and requires explicit scope reconciliation before transition.",
    );
  }
}

function linkScopedState(repository, scoped, root, { proposalId, confidence, provenance }) {
  const key = { agentId: root.agent_id, fromMemoryId: scoped.id, toMemoryId: root.id, relation: 'scoped_exception_to' };
  if (repository.findEdge(key)) return;
  repository.upsertEdge({
    ...key, direction: 'directed', weight: 1,
    confidence: bounded(confidence, 0.75),
    provenance,
    metadata: {
      reportedStateProposalId: proposalId, stateFamily: root.state_family,
      targetScopeKey: root.state_scope_key, proposedScopeKey: scoped.state_scope_key,
    },
  });
}

// A scoped assertion belongs to its canonical preference. Whenever a current
// version is applied or restored, connect the live scopes to the live root.
function linkReportedPreferenceScopes(repository, memory, { proposalId, erasing } = {}) {
  const target = {
    ...memoryWorldScope(memory), agentId: memory.agent_id,
    subjectRole: memory.subject_role, subjectKey: memory.subject_key,
    canonicalKey: memory.canonical_key, representationLayer: 'reported',
  };
  const isRoot = memory.state_scope_key === ROOT_STATE_SCOPE_KEY;
  const root = isRoot ? memory : repository.getCurrentCanonicalMemory({ ...target, stateFamily: 'preference' });
  if (root?.status !== 'active' || erasing?.has(root.id)) return;
  const scopes = isRoot ? repository.findCanonicalMemories(target)
    .filter(state => state.state_family === 'preference' && state.state_scope_key.startsWith('scope:')) : [memory];
  for (const scoped of scopes) {
    if (erasing?.has(scoped.id)) continue;
    linkScopedState(repository, scoped, root, {
      proposalId: proposalId || scoped.metadata?.reportedStateProposalId,
      confidence: scoped.confidence, provenance: 'reported-preference-proposal-v1',
    });
  }
}

function applyReportedState(repository, proposal, evidence, pending = repository.getMemory(provisionalStateId(proposal)), suspended = null) {
  const confirmation = pending?.metadata?.reportedStateConfirmation;
  if (confirmation) {
    const memory = repository.getMemory(confirmation.memoryId);
    if (!isRepeatedReportedStateTransition(repository, proposal) || memory.valid_to !== confirmation.validTo) {
      throw new Error('Reported state confirmation changed after review.');
    }
    attachSelectedEvidence(repository, proposal, memory, evidence);
    return { status: 'reinforced', memory, previous: memory };
  }
  let transition = pending?.metadata?.reportedStateTransition;
  if (transition && TERMINAL_ACTIONS[proposal.action]) {
    const memory = repository.getMemory(transition.memoryId);
    if (!memory || memory.agent_id !== proposal.agent_id || memory.status === 'deleted') {
      throw new Error('Reported state transition target is no longer available.');
    }
    attachSelectedEvidence(repository, proposal, memory, evidence);
    return { status: proposal.action, memory, previous: memory, transition };
  }

  // A legacy preview can already have a successor. Keep its historical interval
  // and identity when applying it from the stored proposal.
  const replacedPending = pending?.status === 'superseded' && pending.metadata?.reportedStateTransitionId;
  const current = replacedPending && (proposal.action === 'create' || transition)
    ? (transition ? repository.getMemory(transition.memoryId) : null) : currentState(repository, proposal, transition?.memoryId);
  const materialize = () => suspended ? repository.updateMemoryStatus(suspended.id, 'active')
    : materializeState(repository, proposal, evidence);

  if (proposal.action === 'create') {
    const memory = materialize();
    attachSelectedEvidence(repository, proposal, memory, evidence);
    return { status: 'created', memory };
  }
  if (!current) throw new Error('Reported state transition lost its reviewed current state.');

  if (proposal.action === 'add_scoped_exception') {
    const existingException = repository.getCurrentCanonicalMemory({
      ...reportedProposalWorld(repository, proposal),
      agentId: proposal.agent_id,
      subjectRole: proposal.subject_role,
      subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key,
      representationLayer: 'reported',
      stateFamily: proposal.state_family,
      stateScopeKey: proposal.proposed_scope_key,
    });
    if (existingException) {
      throw new ReportedStateInputChangedError('This reported-state scope already has a current exception; rebuild against that scope.');
    }
    const memory = materialize();
    attachSelectedEvidence(repository, proposal, memory, evidence);
    if (proposal.state_family !== 'preference') linkScopedState(repository, memory, current, {
      proposalId: proposal.id, confidence: evidence.observation.confidence, provenance: stateEvidenceProvenance(proposal),
    });
    return { status: 'scoped-exception-added', memory, previous: current };
  }

  rejectUnsafeRootTransition(repository, proposal, current);
  if (isReportedPreferenceReinforcement(proposal)) return attachPreferenceSupport(repository, proposal, current, evidence);

  if (SAME_STATE_ACTIONS.has(proposal.action)) {
    attachSelectedEvidence(repository, proposal, current, evidence, { reuseExisting: true });
    const draft = readReportedStateDraft(current);
    if (EVIDENCE_FIELDS.some(field => (proposal.draft[field] || []).some(id => !draft[field]?.includes(id)))) {
      repository.updateMemoryMetadata({ agentId: proposal.agent_id, memoryId: current.id,
        metadata: { ...current.metadata, reportedStateDraft: { ...draft,
          ...Object.fromEntries(EVIDENCE_FIELDS.map(field => [field,
            [...new Set([...(draft[field] || []), ...(proposal.draft[field] || [])])]])),
        } }, reason: 'Retain accepted state confirmation evidence.' });
    }
    return { status: proposal.action === 'reinforce' ? 'reinforced' : 'progress-recorded', memory: current, previous: current };
  }

  if (NEW_STATE_ACTIONS.has(proposal.action)) {
    const memory = materialize();
    attachSelectedEvidence(repository, proposal, memory, evidence);
    if (current.status !== 'superseded') {
      const close = () => repository.closeCurrentMemoryState({
        agentId: proposal.agent_id, memoryId: current.id, validTo: proposal.draft.validFrom, allowPending: true,
      });
      transition = recordStateClosure(repository, proposal, current, close);
    }
    repository.upsertEdge({
      agentId: proposal.agent_id,
      fromMemoryId: memory.id,
      toMemoryId: current.id,
      relation: 'supersedes',
      direction: 'directed',
      weight: 1,
      confidence: bounded(evidence.observation.confidence, 0.75),
      provenance: stateEvidenceProvenance(proposal),
      metadata: { reportedStateProposalId: proposal.id, transition: proposal.action },
    });
    return { status: proposal.action, memory, previous: current, transition };
  }

  const terminal = TERMINAL_ACTIONS[proposal.action];
  if (terminal) {
    attachSelectedEvidence(repository, proposal, current, evidence);
    if (isRepeatedReportedStateTransition(repository, proposal)) return { status: 'reinforced', memory: current, previous: current };
    transition = recordStateClosure(repository, proposal, current, () => repository.closeReportedMemoryState({
      agentId: proposal.agent_id, memoryId: current.id, stateFamily: proposal.state_family,
      statePhase: terminal.statePhase, temporalState: terminal.temporalState,
      status: 'superseded', validTo: evidence.observation.observed_at,
    }));
    return { status: proposal.action, memory: repository.getMemory(current.id), previous: current, transition };
  }

  if (proposal.action === 'correct_attribution') {
    const preference = proposal.state_family === 'preference';
    attachSelectedEvidence(repository, proposal, current, evidence, { challenged: true, edgeOnly: preference });
    const close = () => repository.closeReportedMemoryState({
      agentId: proposal.agent_id, memoryId: current.id, stateFamily: proposal.state_family,
      statePhase: 'retired', temporalState: 'historical', status: 'disputed',
      validTo: evidence.observation.observed_at,
    });
    transition = recordStateClosure(repository, proposal, current, close);
    return { status: 'attribution-corrected', memory: repository.getMemory(current.id), previous: current, transition };
  }
  throw new Error(`Reported state proposal cannot apply action: ${proposal.action}.`);
}

function applyReportedPreference(repository, proposal, suspended = null) {
  if (!suspended && proposal.review_state !== 'pending') return { status: 'skipped', proposal, memory: null };
  if (!suspended && preferenceApplication(proposal)) {
    return { status: 'existing', proposal, memory: appliedReportedPreferenceMemory(repository, proposal) };
  }
  const pending = suspended ? null : repository.getMemory(provisionalStateId(proposal));
  if (pending?.status === 'deleted') return { status: 'skipped', proposal, memory: null };
  const evidence = reviewedEvidence(repository, proposal, pending);
  const effect = applyReportedState(repository, proposal, evidence, pending, suspended);
  const { memory, previous, transition, status } = effect;
  const createsVersion = memory.id !== previous?.id;
  const contributions = evidence.contributions || [evidence];
  const application = {
    status,
    sourceIds: effect.sourceIds ?? [...new Set(contributions.flatMap(item => item.observation.sourceIds))],
    evidenceMemoryIds: [...new Set(contributions.map(item => item.detail.memory.id))],
    ...(createsVersion ? { version: reportedStateVersion(memory) } : {}),
    ...(transition ? { transition } : {}),
  };
  const resultMemoryId = application.sourceIds.length ? memory.id : null;
  const updated = repository.database.prepare(`UPDATE memory_reported_state_proposals
    SET result_memory_id=?, metadata_json=json_set(metadata_json, '$.reportedPreferenceApplication', json(?)), updated_at=?
    WHERE agent_id=? AND id=? AND review_state=? AND result_memory_id IS NULL`)
    .run(resultMemoryId, JSON.stringify(application), new Date().toISOString(), proposal.agent_id, proposal.id, proposal.review_state);
  if (updated.changes !== 1) throw new Error('Reported preference changed while it was being applied.');
  removeProvisionalState(repository, proposal, 'system', 'Reported preference applied.', memory.id);
  if (createsVersion && memory.status === 'active') {
    linkReportedPreferenceScopes(repository, memory, { proposalId: proposal.id });
    const maintenance = { repository, agentId: proposal.agent_id, memoryIds: [memory.id] };
    syncMemoryRelationshipMemberships(maintenance);
    updateAssociationGraph(maintenance);
    enqueueMemoryMaintenanceTasks({ ...maintenance, batchId: `reported-preference:${proposal.id}`,
      taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding, MAINTENANCE_TASK_TYPES.structureProposal] });
  }
  return { status: 'created', proposal: repository.getReportedStateProposal(proposal.agent_id, proposal.id), memory: resultMemoryId ? memory : null };
}

export function restoreReportedPreferenceEvidence(repository, { agentId, memoryId }) {
  const rows = repository.database.prepare(`SELECT id FROM memory_reported_state_proposals
    WHERE agent_id=? AND state_family='preference' AND review_state IN ('pending','accepted')
      AND result_memory_id IS NULL AND json_type(metadata_json, '$.reportedPreferenceApplication.suspendedMemoryId')='text'
      AND ? IN (SELECT value FROM json_each(metadata_json, '$.reportedPreferenceApplication.evidenceMemoryIds'))
    ORDER BY created_at,id`).all(agentId, memoryId);
  for (const { id } of rows) {
    try {
      repository.transaction(() => {
        const proposal = repository.getReportedStateProposal(agentId, id);
        const suspended = suspendedReportedPreferenceMemory(repository, proposal);
        if (!suspended) return;
        // Reapplication may close the original predecessor again. An edited
        // predecessor or a different current state retains its own ownership.
        if (proposal.previousMemoryId && repository.getMemory(proposal.previousMemoryId)?.metadata?.manuallyEdited) return;
        applyReportedPreference(repository, proposal, suspended);
      });
    } catch (error) {
      assertEventSourceExecutionCurrent();
      if (!(error instanceof ReportedStateInputChangedError)) throw error;
      // The saved proposal retains its evidence and can be retried when its
      // other temporarily missing sources return. The raw restore can finish.
    }
  }
}

function recordReportedStateSuspension(repository, proposal, transition, versions) {
  const { alternatives = [], ...original } = transition;
  const available = versions.flatMap(({ memory, before }) => {
    const previousVersion = reportedStateVersion(memory);
    if (memory.id === transition.memoryId) return [{ transition: original, previousVersion }];
    if (!NEW_STATE_ACTIONS.has(proposal.action)) return [];
    const applied = { ...transition.applied, layer: before.layer, state_phase: before.state_phase };
    return [{ transition: { memoryId: memory.id, before, applied }, previousVersion }];
  });
  const options = [...new Map([...alternatives, ...available].map(option => [option.transition.memoryId, option])).values()];
  repository.database.prepare(`UPDATE memory_reported_state_proposals
    SET metadata_json=json_set(metadata_json, '$.reportedStateTransitionSuspended', json(?)), updated_at=?
    WHERE agent_id=? AND id=?`).run(JSON.stringify({ options }), new Date().toISOString(), proposal.agent_id, proposal.id);
}

export function restorePreviousReportedState(repository, proposal, transition, { actor, reason, erasing, suspend = false } = {}) {
  let owner = proposal;
  let change = transition;
  const visited = new Set();
  const skipped = [];
  while (change && !visited.has(owner.id)) {
    visited.add(owner.id);
    const previous = repository.getMemory(change.memoryId);
    if (!previous || previous.agent_id !== proposal.agent_id || previous.metadata?.reportedStateTransitionId !== owner.id) return null;
    if (previous.status !== 'deleted' && !erasing?.has(previous.id)) {
      const memory = repository.restoreReportedStateTransition({
        agentId: proposal.agent_id, proposalId: owner.id, ...change, actor, reason,
      });
      if (!memory) return null;
      const versions = [{ memory, before: change.before }];
      const suspendedMemoryIds = [];
      // Roll back the cutoff on temporarily unavailable versions as well. They
      // stay deleted until their own evidence returns and their slot is free.
      for (const item of skipped.reverse()) {
        const earlier = repository.getReportedStateProposal(proposal.agent_id, item.memory.metadata.reportedStateProposalId);
        if (!earlier || earlier.review_state === 'dismissed') continue;
        const earlierChange = readReportedStateTransition(repository, earlier);
        if (!earlierChange) continue;
        const version = repository.restoreReportedStateTransition({ agentId: proposal.agent_id, proposalId: item.ownerId,
          ...item.change, actor, reason, preserveSuspension: true });
        if (!version) continue;
        recordReportedStateSuspension(repository, earlier, earlierChange, versions);
        versions.unshift({ memory: version, before: item.change.before });
        suspendedMemoryIds.push(version.id);
      }
      if (suspend) recordReportedStateSuspension(repository, proposal, transition, versions);
      return { memory, suspendedMemoryIds };
    }
    if (!erasing?.has(previous.id) && previous.metadata.reportedStateSuspendedStatus) {
      skipped.push({ memory: previous, ownerId: owner.id, change });
    }
    owner = repository.getReportedStateProposal(proposal.agent_id, previous.metadata?.reportedStateProposalId);
    change = owner && readReportedStateTransition(repository, owner);
  }
  return null;
}

export function reapplyReportedStateTransition(repository, proposal, transition, { actor, reason }) {
  const { reportedStateTransitionSuspended: suspension, ...metadata } = proposal.metadata;
  if (!suspension) return false;
  const options = suspension.options || [{ transition, previousVersion: suspension.previousVersion }];
  for (const option of options) {
    const predecessor = repository.getMemory(option.transition.memoryId);
    if (!predecessor || reportedStateVersion(predecessor) !== option.previousVersion
      || !repository.restoreReportedStateTransition({ agentId: proposal.agent_id, proposalId: proposal.id,
        ...option.transition, reapply: true, actor, reason })) continue;
    if (options.length > 1 || option.transition.memoryId !== transition.memoryId) {
      const alternatives = options.filter(candidate => candidate !== option);
      const change = { ...option.transition, ...(alternatives.length ? { alternatives } : {}) };
      if (metadata.reportedStateApplication) {
        metadata.reportedStateApplication = { ...metadata.reportedStateApplication, transition: change };
      } else {
        const result = reportedStateMaterializedMemory(repository, proposal);
        repository.updateMemoryMetadata({ agentId: proposal.agent_id, memoryId: result.id,
          metadata: { ...result.metadata, reportedStateTransition: change }, actor, reason });
      }
    }
    repository.database.prepare(`UPDATE memory_reported_state_proposals SET metadata_json=?, updated_at=?
      WHERE agent_id=? AND id=?`).run(JSON.stringify(metadata), new Date().toISOString(), proposal.agent_id, proposal.id);
    return true;
  }
  return false;
}

function restoreWithdrawnReportedState(repository, proposal, transition, actor, reason) {
  const restored = restorePreviousReportedState(repository, proposal, transition, { actor, reason });
  if (!restored) return null;
  const { memory, suspendedMemoryIds } = restored;
  const prior = repository.getMemory(proposal.previousMemoryId);
  if (prior?.metadata.reportedStateSuspendedStatus && !suspendedMemoryIds.includes(prior.id)) suspendedMemoryIds.push(prior.id);
  if (!suspendedMemoryIds.length) return memory;
  reconcileReportedStateEvidence(repository, { agentId: proposal.agent_id, resultMemoryIds: suspendedMemoryIds });
  return repository.getCurrentCanonicalMemory({ ...memoryWorldScope(memory), agentId: proposal.agent_id,
    subjectRole: memory.subject_role, subjectKey: memory.subject_key, canonicalKey: memory.canonical_key,
    representationLayer: memory.representation_layer, stateFamily: memory.state_family, stateScopeKey: memory.state_scope_key,
    includePending: true });
}

function undoReportedPreference(repository, proposal, memory, actor, reason, erasing) {
  const application = preferenceApplication(proposal);
  if (!memory) return null;
  repository.database.prepare(`DELETE FROM memory_edges WHERE agent_id=? AND (from_memory_id=? OR to_memory_id=?)
    AND provenance IN (?, 'reported-preference-proposal-v1', 'accepted-reported-state-proposal-v1')
    AND json_extract(metadata_json, '$.reportedStateProposalId')=?`)
    .run(proposal.agent_id, memory.id, memory.id, REPORTED_STATE_REINFORCEMENT_PROVENANCE, proposal.id);
  const createsVersion = !['reinforce', 'correct_attribution'].includes(proposal.action);
  if (createsVersion && erasing?.has(memory.id)) {
    repository.updateMemoryStatus(memory.id, 'deleted');
  } else if (createsVersion) {
    repository.setMemoryDeleted({ agentId: proposal.agent_id, memoryId: memory.id, actor, reason });
  }
  const restored = restorePreviousReportedState(repository, proposal, application?.transition, { actor, reason, erasing })?.memory || null;
  if (restored?.status === 'active') linkReportedPreferenceScopes(repository, restored, { erasing });
  return restored;
}

export function appliedReportedStateMemory(repository, proposal, { includeSuspended = false } = {}) {
  if (proposal.state_family === 'preference') return appliedReportedPreferenceMemory(repository, proposal);
  const application = proposal.metadata?.reportedStateApplication;
  if (!application || !proposal.resultMemoryId || proposal.review_state === 'dismissed'
    || (!includeSuspended && proposal.metadata.reportedStateTransitionSuspended)) return null;
  const memory = repository.getMemory(proposal.resultMemoryId);
  if (!memory || memory.agent_id !== proposal.agent_id
    || (memory.status === 'deleted' && !(includeSuspended && memory.metadata.reportedStateSuspendedStatus))) return null;
  if (application.version && (memory.metadata?.reportedStateProposalId !== proposal.id
    || memory.metadata?.manuallyEdited || reportedStateVersion(memory) !== application.version)) return null;
  return memory;
}

export function withdrawableReportedStateMemory(repository, proposal) {
  return appliedReportedStateMemory(repository, proposal, { includeSuspended: true })
    || (proposal.state_family === 'preference' ? suspendedReportedPreferenceMemory(repository, proposal) : null);
}

export function applyReportedStateProposal(repository, { agentId, proposalId } = {}) {
  return repository.transaction(() => {
    const proposal = repository.getReportedStateProposal(agentId, proposalId);
    if (!proposal || proposal.review_state !== 'pending') throw new Error('Reported state is not awaiting application.');
    if (proposal.state_family === 'preference') return applyReportedPreference(repository, proposal);
    if (proposal.metadata?.reportedStateApplication) return { status: 'existing', proposal,
      memory: appliedReportedStateMemory(repository, proposal) };
    const evidence = reviewedEvidence(repository, proposal);
    const effect = applyReportedState(repository, proposal, evidence);
    const memory = repository.getMemory(effect.memory.id);
    const additive = memory.id === effect.previous?.id;
    const before = readReportedStateDraft(effect.previous);
    const after = readReportedStateDraft(memory);
    const added = additive ? Object.fromEntries(EVIDENCE_FIELDS
      .map(field => [field, (after[field] || []).filter(id => !before[field]?.includes(id))])) : undefined;
    const application = { status: effect.status,
      ...(!additive ? { version: reportedStateVersion(memory) } : { added }),
      ...(effect.transition ? { transition: effect.transition } : {}) };
    const result = repository.database.prepare(`UPDATE memory_reported_state_proposals
      SET result_memory_id = ?, metadata_json = json_set(metadata_json, '$.reportedStateApplication', json(?)), updated_at = ?
      WHERE agent_id = ? AND id = ? AND review_state = 'pending' AND result_memory_id IS NULL`)
      .run(memory.id, JSON.stringify(application), new Date().toISOString(), proposal.agent_id, proposal.id);
    if (result.changes !== 1) throw new Error('Reported state changed while it was being applied.');
    removeProvisionalState(repository, proposal, 'system', 'Reported state applied.', memory.id);
    return { ...effect, memory, proposal: repository.getReportedStateProposal(proposal.agent_id, proposal.id) };
  });
}

export function recoverAutomaticallyReviewedStates(repository, agentId) {
  return repository.transaction(() => {
    const rows = repository.database.prepare(`SELECT id FROM memory_reported_state_proposals
      WHERE agent_id = ? AND review_state = 'accepted' AND state_family <> 'preference'
        AND resolved_by = 'system:auto-explicit-self-report-v1'`).all(agentId);
    const update = repository.database.prepare(`UPDATE memory_reported_state_proposals
      SET review_state = 'pending', resolved_by = '', resolution_note = '', resolved_at = NULL,
        metadata_json = json_set(metadata_json, '$.reportedStateApplication', json(?), '$.priorAutomaticReview', json(?)),
        updated_at = ? WHERE agent_id = ? AND id = ?`);
    for (const { id } of rows) {
      const proposal = repository.getReportedStateProposal(agentId, id);
      const memory = repository.getMemory(proposal.resultMemoryId);
      const version = memory && memory.id !== proposal.previousMemoryId && memory.metadata?.reportedStateProposalId === proposal.id
        ? reportedStateVersion(memory) : undefined;
      update.run(JSON.stringify({ status: 'existing', ...(version ? { version } : {}) }),
        JSON.stringify({ actor: proposal.resolved_by, note: proposal.resolution_note, at: proposal.resolved_at }),
        new Date().toISOString(), agentId, id);
    }
    return rows.length;
  });
}

function undoReportedState(repository, proposal, memory, actor, reason) {
  const application = proposal.metadata?.reportedStateApplication;
  if (!memory || !application) return null;
  if (application.version) {
    repository.setMemoryDeleted({ agentId: proposal.agent_id, memoryId: memory.id, actor, reason });
    if (memory.status !== 'active' && memory.metadata.reportedStateSuspendedStatus !== 'active') return null;
  } else {
    const owner = `json_extract(metadata_json, '$.reportedStateProposalId') = ?`;
    const observation = `json_extract(metadata_json, '$.observationId') AS observationId`;
    const sources = repository.database.prepare(`DELETE FROM memory_sources WHERE memory_id = ? AND ${owner}
      RETURNING source_id AS sourceId, ${observation}`).all(memory.id, proposal.id);
    const edges = repository.database.prepare(`DELETE FROM memory_edges WHERE agent_id = ? AND from_memory_id = ? AND ${owner}
      RETURNING relation, to_memory_id AS memoryId, ${observation}`).all(proposal.agent_id, memory.id, proposal.id);
    // Legacy applications recorded the owner on their links but not the draft
    // delta. Recover only contributions we can attribute to those links.
    const additions = application.added || {
      evidenceObservationIds: [...sources, ...edges].map(row => row.observationId).filter(Boolean),
      evidenceMemoryIds: edges.filter(row => row.relation === 'supported_by').map(row => row.memoryId),
      evidenceSourceIds: sources.map(row => row.sourceId),
    };
    if (Object.values(additions).some(ids => ids.length)) {
      const surviving = repository.database.prepare(`SELECT source_id AS sourceId, NULL AS memoryId, ${observation}
        FROM memory_sources WHERE memory_id = ?
        UNION ALL SELECT NULL, to_memory_id, ${observation} FROM memory_edges
        WHERE agent_id = ? AND from_memory_id = ? AND relation = 'supported_by'`).all(memory.id, proposal.agent_id, memory.id);
      const liveIds = {
        evidenceObservationIds: new Set(surviving.map(row => row.observationId).filter(Boolean)),
        evidenceMemoryIds: new Set(surviving.map(row => row.memoryId).filter(Boolean)),
        evidenceSourceIds: new Set(surviving.map(row => row.sourceId).filter(Boolean)),
      };
      const draft = readReportedStateDraft(memory);
      for (const field of EVIDENCE_FIELDS) {
        draft[field] = (draft[field] || []).filter(id => !additions[field]?.includes(id) || liveIds[field].has(id));
      }
      repository.updateMemoryMetadata({ agentId: proposal.agent_id, memoryId: memory.id,
        metadata: { ...memory.metadata, reportedStateDraft: draft }, actor, reason });
    }
    reconcileReportedStateEvidence(repository, { agentId: proposal.agent_id, resultMemoryIds: [memory.id] });
  }
  return restoreWithdrawnReportedState(repository, proposal, application.transition, actor, reason);
}

export function resolveReportedStateProposal(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = 'human',
  note = '',
} = {}) {
  if (!repository) throw new Error('Resolving a reported state proposal requires a repository.');
  const normalizedAgentId = clean(agentId);
  const normalizedAction = clean(action);
  if (!['accept', 'dismiss'].includes(normalizedAction)) {
    throw new Error(`Unknown reported state proposal action: ${normalizedAction || '(empty)'}.`);
  }

  return repository.transaction(() => {
    const proposal = repository.getReportedStateProposal(normalizedAgentId, proposalId);
    if (!proposal) throw new Error('Reported state proposal does not exist for this Agent.');
    const applied = appliedReportedStateMemory(repository, proposal);
    const owned = normalizedAction === 'dismiss' ? withdrawableReportedStateMemory(repository, proposal) : null;
    if (proposal.review_state !== 'pending'
      && !(proposal.review_state === 'accepted' && owned)) {
      throw new Error(`Reported state proposal is already ${proposal.review_state}.`);
    }
    if (normalizedAction === 'dismiss') {
      const reason = note || 'Reported state proposal dismissed.';
      const transition = readReportedStateTransition(repository, proposal);
      const resolved = repository.resolveReportedStateProposalRecord({
        agentId: normalizedAgentId, proposalId: proposal.id, resolution: 'dismissed', resolvedBy, note,
      });
      removeProvisionalState(repository, proposal, resolvedBy, reason);
      const reversible = owned && (applied || proposal.state_family !== 'preference' || proposal.action === 'reinforce');
      const restored = reversible ? (proposal.state_family === 'preference'
        ? undoReportedPreference(repository, proposal, owned, resolvedBy, reason)
        : undoReportedState(repository, proposal, owned, resolvedBy, reason))
        : restoreWithdrawnReportedState(repository, proposal, transition, resolvedBy, reason);
      return { status: 'dismissed', proposal: resolved, memory: null, restored,
        previous: proposal.previousMemoryId ? repository.getMemory(proposal.previousMemoryId) : null };
    }

    if (proposal.state_family === 'preference') {
      const result = applied ? { proposal, memory: applied } : applyReportedPreference(repository, proposal);
      if (!result.memory) throw new Error('Reported preference has no active result to confirm.');
      return finish(repository, result.proposal, {
        status: preferenceApplication(result.proposal).status,
        memory: result.memory,
        previous: proposal.previousMemoryId ? repository.getMemory(proposal.previousMemoryId) : null,
      }, resolvedBy, note);
    }
    const result = applied ? { memory: applied, proposal, status: proposal.metadata.reportedStateApplication.status,
      previous: proposal.previousMemoryId ? repository.getMemory(proposal.previousMemoryId) : null }
      : applyReportedStateProposal(repository, { agentId: normalizedAgentId, proposalId: proposal.id });
    if (!result.memory) throw new Error('Reported state has no active result to confirm.');
    return finish(repository, result.proposal, result, resolvedBy, note);
  });
}
