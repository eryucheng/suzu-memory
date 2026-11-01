import { enqueueMemoryMaintenanceTasks, MAINTENANCE_TASK_TYPES } from './maintenance-tasks.mjs';
import { createHash } from "node:crypto";
import { assertEventSourceExecutionCurrent } from "./event-source-execution.mjs";
import { modelCalendarFields } from './calendar-time.mjs';

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

const SAME_STATE_ACTIONS = new Set(["reinforce", "progress_update"]);

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

function currentState(repository, proposal) {
  const current = repository.getCurrentCanonicalMemory({
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
  if ((current?.id || "") !== proposal.previousMemoryId) {
    throw new Error("Reported state changed after the proposal was reviewed.");
  }
  return current;
}

function reviewedEvidence(repository, proposal) {
  const evidenceSnapshot = proposal.metadata?.reportedStateEvidenceSnapshot;
  if (evidenceSnapshot?.version !== "reported-state-evidence-snapshot-v1"
    || !clean(evidenceSnapshot.selectedContent)
    || !Array.isArray(evidenceSnapshot.observations)) {
    throw new Error("Reported state proposal does not contain an immutable evidence snapshot.");
  }
  const snapshotByObservationId = new Map(
    evidenceSnapshot.observations.map((item) => [clean(item.observationId), item]),
  );
  let selected = null;
  const contributions = [];
  for (const observationId of proposal.consideredObservationIds) {
    const observation = repository.getStateEvidenceObservation(proposal.agent_id, observationId);
    if (!observation || observation.lifecycle !== "current"
      || observation.state_family !== proposal.state_family
      || observation.subject_role !== proposal.subject_role
      || observation.subject_key !== proposal.subject_key
      || observation.canonical_key !== proposal.canonical_key
      || clean(observation.scope?.currentRepresentationLayer) !== "reported") {
      throw new Error("Reported state proposal evidence changed or crossed its reviewed target.");
    }
    const memoryId = clean(observation.memory_id || observation.memoryId);
    const detail = repository.getMemoryDetail(proposal.agent_id, memoryId);
    if (!detail || detail.memory.status === "deleted") {
      throw new Error("Reported state proposal evidence memory is no longer available.");
    }
    const linkedSourceIds = new Set(detail.sources.map((source) => source.id));
    if (!observation.sourceIds.length
      || observation.sourceIds.some((sourceId) => !linkedSourceIds.has(sourceId))) {
      throw new Error("Reported state proposal evidence sources changed after review.");
    }
    const recordedSnapshot = snapshotByObservationId.get(observation.id);
    if (!recordedSnapshot
      || clean(recordedSnapshot.observationHash) !== clean(observation.observation_hash)
      || clean(recordedSnapshot.memoryId) !== memoryId
      || clean(recordedSnapshot.memoryFingerprint) !== canonicalHash({
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
      })) {
      throw new Error("Reported state proposal evidence memory changed after review.");
    }
    const recordedSourceFingerprints = new Map(
      (recordedSnapshot.sourceFingerprints || []).map((item) => [clean(item.id), clean(item.fingerprint)]),
    );
    for (const sourceId of [...observation.sourceIds].sort()) {
      const source = detail.sources.find((item) => item.id === sourceId);
      if (source.lifecycle !== "active") {
        throw new Error("Reported state proposal evidence source is no longer active.");
      }
      const fingerprint = canonicalHash({
        id: source.id,
        agentId: source.agent_id,
        sourceKind: source.source_kind,
        externalId: source.external_id,
        occurredAt: source.occurred_at,
        knownAt: source.known_at,
        speaker: source.speaker,
        content: source.content,
      });
      if (recordedSourceFingerprints.get(sourceId) !== fingerprint) {
        throw new Error("Reported state proposal evidence source changed after review.");
      }
    }
    if (proposal.draft?.evidenceObservationIds?.includes(observation.id)) {
      if (observation.qualification !== "qualified") throw new Error("Aggregated state evidence is no longer qualified.");
      contributions.push({ observation, detail });
    }
    if (observation.id === proposal.selectedObservationId) {
      if (observation.qualification !== "qualified") {
        throw new Error("Reported state proposal selected evidence is no longer qualified.");
      }
      selected = { observation, detail, contentSnapshot: evidenceSnapshot.selectedContent };
    }
  }
  if (!selected) throw new Error("Reported state proposal lost its selected evidence.");
  const draft = proposal.draft || {};
  if (NEW_STATE_ACTIONS.has(proposal.action) || proposal.action === "reinforce") {
    const selectedMemoryId = clean(selected.observation.memory_id || selected.observation.memoryId);
    if (!Array.isArray(draft.evidenceObservationIds)
      || !draft.evidenceObservationIds.includes(selected.observation.id)
      || !Array.isArray(draft.evidenceMemoryIds)
      || !draft.evidenceMemoryIds.includes(selectedMemoryId)
      || !Array.isArray(draft.evidenceSourceIds)
      || selected.observation.sourceIds.some((sourceId) => !draft.evidenceSourceIds.includes(sourceId))) {
      throw new Error("Reported state draft does not preserve its selected evidence chain.");
    }
  }
  if (contributions.length) {
    const ids = new Set(contributions.map(item => item.observation.id));
    const memories = new Set(contributions.map(item => item.detail.memory.id));
    const sources = new Set(contributions.flatMap(item => item.observation.sourceIds));
    if (draft.evidenceObservationIds.some(id => !ids.has(id))
      || draft.evidenceMemoryIds.some(id => !memories.has(id)) || draft.evidenceSourceIds.some(id => !sources.has(id))) {
      throw new Error("Aggregated state evidence escapes the reviewed snapshot.");
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

function materializeState(repository, proposal, evidence) {
  const validityStart = iso(proposal.draft.validFrom, "validity start");
  const pending = repository.getMemory(provisionalStateId(proposal));
  // Keep the referenced state identity when a subsequent transition already used it.
  const referenced = pending && (pending.metadata?.reportedStateTransition || repository.database.prepare(`SELECT 1 FROM memory_reported_state_proposals
    WHERE agent_id = ? AND previous_memory_id = ? LIMIT 1`).get(proposal.agent_id, pending.id));
  const memoryId = referenced ? pending.id : `reported-state-${createHash("sha256")
    .update(`${proposal.agent_id}\u001f${proposal.id}`)
    .digest("hex")
    .slice(0, 24)}`;
  const stateLabel = clean(proposal.metadata?.target?.stateLabel);
  const semantic = semanticDraft(repository, proposal);
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
    reality: semantic?.reality || pending?.reality || evidence.detail.memory.reality,
    worldId: semantic?.world_id || pending?.world_id || evidence.detail.memory.world_id,
    worldFrame: semantic?.world_frame || pending?.world_frame || evidence.detail.memory.world_frame,
    evidenceMode: "explicit",
    representationLayer: "reported",
    stateFamily: proposal.state_family,
    stateScopeKey: proposal.proposed_scope_key,
    statePhase: referenced ? pending.state_phase : proposal.state_phase,
    temporalState: referenced ? pending.temporal_state : proposal.temporal_state,
    revisionAction: ["create", "add_scoped_exception"].includes(proposal.action)
      ? "add"
      : "update",
    knownAt: evidence.detail.memory.known_at || evidence.observation.observed_at,
    validFrom: validityStart,
    validTo: referenced ? pending.valid_to : null,
    status: referenced && pending.status === "superseded" ? pending.status : "active",
    confidence: bounded(evidence.observation.confidence, 0.75),
    importance: 0.6,
    actorRoles: actorRoles(proposal),
    metadata: {
      reportedStateProposalId: proposal.id,
      ...modelCalendarFields(evidence.detail.memory, [], evidence.detail.sources),
      reportedStateAction: proposal.action,
      reportedStateReviewVersion: proposal.review_version,
      reportedStateInputHash: proposal.input_hash,
      reportedStateDraft: proposal.draft,
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
} = {}) {
  const existingDraft = reuseExisting ? readReportedStateDraft(targetMemory) : {};
  const existingObservations = new Set(existingDraft.evidenceObservationIds || []);
  const existingSources = new Set(existingDraft.evidenceSourceIds || []);
  for (const contribution of evidence.contributions || [evidence]) {
    if (existingObservations.has(contribution.observation.id)) continue;
    const sourceById = new Map(contribution.detail.sources.map((source) => [source.id, source]));
    for (const sourceId of contribution.observation.sourceIds) {
      if (existingSources.has(sourceId)) continue;
      const source = sourceById.get(sourceId);
      repository.linkSource(targetMemory.id, sourceId, `reported_state_${proposal.action}`, {
        authority: clean(source?.authority) || "subject_firsthand",
        sourceTrust: bounded(source?.source_trust, 0.8),
        evidenceStrength: bounded(contribution.observation.confidence, 0.75),
        provenance: provisional ? "pending-reported-state-proposal-v1" : "accepted-reported-state-proposal-v1",
        metadata: {
          reportedStateProposalId: proposal.id,
          stateFamily: proposal.state_family,
          action: proposal.action,
          observationId: contribution.observation.id,
        },
      });
    }
    if (targetMemory.id !== contribution.detail.memory.id) {
      repository.upsertEdge({
        agentId: proposal.agent_id,
        fromMemoryId: targetMemory.id,
        toMemoryId: contribution.detail.memory.id,
        relation: challenged ? "challenged_by" : "supported_by",
        direction: "directed",
        weight: challenged ? 0.8 : 0.9,
        confidence: bounded(contribution.observation.confidence, 0.75),
        provenance: provisional ? "pending-reported-state-proposal-v1" : "accepted-reported-state-proposal-v1",
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

function provisionalStateId(proposal) {
  return `pending-reported-state-${canonicalHash([proposal.agent_id, proposal.id]).slice(0, 24)}`;
}

function semanticDraft(repository, proposal) {
  const id = proposal.metadata?.semanticMemoryId;
  if (!id) return null;
  const memory = repository.getMemory(id);
  if (!memory || memory.agent_id !== proposal.agent_id || memory.status === 'deleted'
    || memory.metadata?.stateAnalysisDraft !== true
    || memory.metadata.stateAnalysisRequestId !== proposal.metadata.stateAnalysisRequestId
    || memory.title !== proposal.metadata.semanticMemorySnapshot?.title
    || memory.content !== proposal.metadata.semanticMemorySnapshot?.content) {
    throw new Error('Reported state semantic memory is no longer available.');
  }
  return memory;
}

export function materializeReportedStateProposal(repository, { agentId, proposalId } = {}) {
  const proposal = repository.getReportedStateProposal(clean(agentId), proposalId);
  if (!proposal) throw new Error("Reported state proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") return { status: "skipped", proposal, memory: null };
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
        const closed = terminal ? repository.closeReportedMemoryState({ agentId: proposal.agent_id,
          memoryId: current.id, stateFamily: proposal.state_family,
          statePhase: terminal.statePhase, temporalState: terminal.temporalState,
          validTo: evidence.observation.observed_at, allowPending: true })
          : current.status === 'superseded' ? current : repository.closeCurrentMemoryState({ agentId: proposal.agent_id,
            memoryId: current.id, validTo: proposal.draft.validFrom, allowPending: true });
        repository.updateMemoryMetadata({ agentId: proposal.agent_id, memoryId: current.id,
          metadata: { ...current.metadata, reportedStateTransitionId: proposal.id },
          reason: "Apply reported state transition pending human review." });
        const fields = memory => ({ ...Object.fromEntries(["layer", "status", "state_phase", "temporal_state", "valid_to"]
          .map(key => [key, memory[key]])), transitionId: memory.metadata?.reportedStateTransitionId || '' });
        transition = { memoryId: current.id, before: fields(current), applied: fields(closed) };
      }
    }
    const semantic = semanticDraft(repository, proposal);
    const memory = repository.upsertMemory({
      id: provisionalStateId(proposal), agentId: proposal.agent_id,
      kind: proposal.proposed_kind || previous?.kind,
      layer: "provisional", status: "archived",
      title: semantic?.title ?? (clean(proposal.metadata?.target?.stateLabel) || previous?.title || ""),
      content: reportedStateContent(proposal, evidence, semantic),
      subjectRole: proposal.subject_role, subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key, evidenceMode: "explicit",
      reality: semantic?.reality || evidence.detail.memory.reality,
      worldId: semantic?.world_id || evidence.detail.memory.world_id,
      worldFrame: semantic?.world_frame || evidence.detail.memory.world_frame,
      representationLayer: "reported", stateFamily: proposal.state_family,
      stateScopeKey: proposal.proposed_scope_key,
      statePhase: terminal?.statePhase || proposal.state_phase || previous?.state_phase,
      temporalState: terminal?.temporalState || proposal.temporal_state || previous?.temporal_state,
      knownAt: evidence.detail.memory.known_at || evidence.observation.observed_at,
      validFrom: proposal.draft?.validFrom || evidence.observation.observed_at,
      confidence: bounded(evidence.observation.confidence, 0.75), importance: 0.6,
      actorRoles: actorRoles({ ...proposal, proposed_kind: proposal.proposed_kind || previous?.kind }, { provisional: true }),
      metadata: {
        provisional: true, reviewState: "pending", epistemicStatus: "reported_state",
        ...modelCalendarFields(evidence.detail.memory, [], evidence.detail.sources),
        reportedStateProposalId: proposal.id, reportedStateAction: proposal.action,
        reportedStatePreviousMemoryId: proposal.previousMemoryId,
        reportedStateDraft: proposal.draft,
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

export function materializePendingReportedStateProposals(repository, { agentId } = {}) {
  const ids = repository.database.prepare(`
    SELECT proposal.id FROM memory_reported_state_proposals proposal
    WHERE proposal.agent_id = ? AND proposal.review_state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM memory_nodes memory WHERE memory.agent_id = proposal.agent_id
        AND memory.layer = 'provisional'
        AND json_extract(memory.metadata_json, '$.reportedStateProposalId') = proposal.id
        AND (proposal.action NOT IN (${[...PENDING_TRANSITION_ACTIONS].map(() => '?').join(',')})
          OR memory.status = 'deleted'
            OR json_extract(memory.metadata_json, '$.reportedStateTransition') IS NOT NULL
            OR json_extract(memory.metadata_json, '$.reportedStateConfirmation') IS NOT NULL))
    ORDER BY proposal.created_at, proposal.id
  `).all(clean(agentId), ...PENDING_TRANSITION_ACTIONS);
  const materialized = [];
  const failed = [];
  for (const { id } of ids) {
    try { materialized.push(materializeReportedStateProposal(repository, { agentId, proposalId: id })); }
    catch (error) { assertEventSourceExecutionCurrent(); failed.push({ proposalId: id, error: error.message }); }
  }
  return { materialized, failed };
}

function removeProvisionalState(repository, proposal, actor, reason, retainedMemoryId = "") {
  const memory = repository.getMemory(provisionalStateId(proposal));
  if (memory && memory.id !== retainedMemoryId && memory.status !== "deleted") repository.setMemoryDeleted({
    agentId: proposal.agent_id, memoryId: memory.id, actor, reason,
  });
}

function finish(repository, proposal, memory, resolvedBy, note, status, previous = null) {
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
  if (!current || current.state_scope_key !== "root") return;
  const changesRootLifecycle = NEW_STATE_ACTIONS.has(proposal.action)
    || Boolean(TERMINAL_ACTIONS[proposal.action])
    || proposal.action === "correct_attribution";
  if (!changesRootLifecycle) return;
  const exceptions = repository.listCurrentScopedExceptions({
    agentId: proposal.agent_id,
    rootMemoryId: current.id,
  });
  if (exceptions.length) {
    throw new Error(
      "Reported root state has active scoped exceptions and requires explicit scope reconciliation before transition.",
    );
  }
}

export function resolveReportedStateProposal(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Resolving a reported state proposal requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedAction = clean(action);
  const proposal = repository.getReportedStateProposal(normalizedAgentId, proposalId);
  if (!proposal) throw new Error("Reported state proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") {
    throw new Error(`Reported state proposal is already ${proposal.review_state}.`);
  }
  if (!["accept", "dismiss"].includes(normalizedAction)) {
    throw new Error(`Unknown reported state proposal action: ${normalizedAction || "(empty)"}.`);
  }
  if (normalizedAction === "dismiss") {
    return repository.transaction(() => {
      const transition = repository.getMemory(provisionalStateId(proposal))?.metadata?.reportedStateTransition;
      removeProvisionalState(repository, proposal, resolvedBy, "Reported state proposal dismissed.");
      const restored = transition ? repository.restoreReportedStateTransition({
        agentId: normalizedAgentId, proposalId: proposal.id, ...transition,
        actor: resolvedBy, reason: note || "Reported state transition dismissed.",
      }) : null;
      return {
        status: "dismissed",
        proposal: repository.dismissReportedStateProposal({
          agentId: normalizedAgentId,
          proposalId: proposal.id,
          resolvedBy,
          note,
        }),
        memory: null,
        restored,
        previous: proposal.previousMemoryId
          ? repository.getMemory(proposal.previousMemoryId)
          : null,
      };
    });
  }
  return repository.transaction(() => {
    const evidence = reviewedEvidence(repository, proposal);
    const confirmation = repository.getMemory(provisionalStateId(proposal))?.metadata?.reportedStateConfirmation;
    if (confirmation) {
      const memory = repository.getMemory(confirmation.memoryId);
      if (!isRepeatedReportedStateTransition(repository, proposal) || memory.valid_to !== confirmation.validTo) {
        throw new Error('Reported state confirmation changed after review.');
      }
      attachSelectedEvidence(repository, proposal, memory, evidence);
      return finish(repository, proposal, memory, resolvedBy, note, 'reinforced', memory);
    }
    const transition = repository.getMemory(provisionalStateId(proposal))?.metadata?.reportedStateTransition;
    if (transition && TERMINAL_ACTIONS[proposal.action]) {
      const memory = repository.getMemory(transition.memoryId);
      if (!memory || memory.agent_id !== normalizedAgentId || memory.status === "deleted") {
        throw new Error("Reported state transition target is no longer available.");
      }
      attachSelectedEvidence(repository, proposal, memory, evidence);
      return finish(repository, proposal, memory, resolvedBy, note, proposal.action, memory);
    }
    const pending = repository.getMemory(provisionalStateId(proposal));
    // A pending original may already have been replaced by a later proposal.
    // Accepting its evidence must preserve that newer state and its identity.
    const replacedPending = pending?.status === 'superseded' && pending.metadata?.reportedStateTransitionId;
    const current = replacedPending && (proposal.action === 'create' || transition)
      ? (transition ? repository.getMemory(transition.memoryId) : null) : currentState(repository, proposal);

    if (proposal.action === "create") {
      const memory = materializeState(repository, proposal, evidence);
      attachSelectedEvidence(repository, proposal, memory, evidence);
      return finish(repository, proposal, memory, resolvedBy, note, "created");
    }

    if (!current) throw new Error("Reported state transition lost its reviewed current state.");

    if (proposal.action === "add_scoped_exception") {
      const existingException = repository.getCurrentCanonicalMemory({
        agentId: normalizedAgentId,
        subjectRole: proposal.subject_role,
        subjectKey: proposal.subject_key,
        canonicalKey: proposal.canonical_key,
        representationLayer: "reported",
        stateFamily: proposal.state_family,
        stateScopeKey: proposal.proposed_scope_key,
      });
      if (existingException) {
        throw new Error("This reported-state scope already has a current exception; rebuild against that scope.");
      }
      const memory = materializeState(repository, proposal, evidence);
      attachSelectedEvidence(repository, proposal, memory, evidence);
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: memory.id,
        toMemoryId: current.id,
        relation: "scoped_exception_to",
        direction: "directed",
        weight: 1,
        confidence: bounded(evidence.observation.confidence, 0.75),
        provenance: "accepted-reported-state-proposal-v1",
        metadata: {
          reportedStateProposalId: proposal.id,
          stateFamily: proposal.state_family,
          targetScopeKey: proposal.target_scope_key,
          proposedScopeKey: proposal.proposed_scope_key,
        },
      });
      return finish(
        repository,
        proposal,
        memory,
        resolvedBy,
        note,
        "scoped-exception-added",
        current,
      );
    }

    rejectUnsafeRootTransition(repository, proposal, current);

    if (SAME_STATE_ACTIONS.has(proposal.action)) {
      attachSelectedEvidence(repository, proposal, current, evidence, { reuseExisting: true });
      {
        const draft = readReportedStateDraft(current);
        const evidenceFields = ["evidenceObservationIds", "evidenceMemoryIds", "evidenceSourceIds"];
        if (evidenceFields.some(field => (proposal.draft[field] || []).some(id => !draft[field]?.includes(id)))) {
          repository.updateMemoryMetadata({ agentId: proposal.agent_id, memoryId: current.id,
            metadata: { ...current.metadata, reportedStateDraft: { ...draft,
              ...Object.fromEntries(evidenceFields.map(field => [field,
                [...new Set([...(draft[field] || []), ...(proposal.draft[field] || [])])]])),
            } }, reason: "Retain accepted state confirmation evidence." });
        }
      }
      return finish(
        repository,
        proposal,
        current,
        resolvedBy,
        note,
        proposal.action === "reinforce" ? "reinforced" : "progress-recorded",
        current,
      );
    }

    if (NEW_STATE_ACTIONS.has(proposal.action)) {
      const memory = materializeState(repository, proposal, evidence);
      attachSelectedEvidence(repository, proposal, memory, evidence);
      if (current.status !== "superseded") {
        repository.closeCurrentMemoryState({
          agentId: normalizedAgentId,
          memoryId: current.id,
          validTo: proposal.draft.validFrom,
          allowPending: true,
        });
      }
      repository.upsertEdge({
        agentId: normalizedAgentId,
        fromMemoryId: memory.id,
        toMemoryId: current.id,
        relation: "supersedes",
        direction: "directed",
        weight: 1,
        confidence: bounded(evidence.observation.confidence, 0.75),
        provenance: "accepted-reported-state-proposal-v1",
        metadata: {
          reportedStateProposalId: proposal.id,
          transition: proposal.action,
        },
      });
      return finish(repository, proposal, memory, resolvedBy, note, proposal.action, current);
    }

    const terminal = TERMINAL_ACTIONS[proposal.action];
    if (terminal) {
      attachSelectedEvidence(repository, proposal, current, evidence);
      if (isRepeatedReportedStateTransition(repository, proposal)) return finish(repository, proposal, current, resolvedBy, note, 'reinforced', current);
      const closed = repository.closeReportedMemoryState({
        agentId: normalizedAgentId,
        memoryId: current.id,
        stateFamily: proposal.state_family,
        statePhase: terminal.statePhase,
        temporalState: terminal.temporalState,
        status: "superseded",
        validTo: evidence.observation.observed_at,
      });
      return finish(repository, proposal, closed, resolvedBy, note, proposal.action, current);
    }

    if (proposal.action === "correct_attribution") {
      attachSelectedEvidence(repository, proposal, current, evidence, { challenged: true });
      const corrected = repository.closeReportedMemoryState({
        agentId: normalizedAgentId,
        memoryId: current.id,
        stateFamily: proposal.state_family,
        statePhase: "retired",
        temporalState: "historical",
        status: "disputed",
        validTo: evidence.observation.observed_at,
      });
      return finish(repository, proposal, corrected, resolvedBy, note, "attribution-corrected", current);
    }

    throw new Error(`Reported state proposal action is not accepted yet: ${proposal.action}.`);
  });
}
