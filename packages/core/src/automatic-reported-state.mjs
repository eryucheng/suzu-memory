import { assertEventSourceExecutionCurrent } from './event-source-execution.mjs';
import { runImmediateMemoryMaintenance } from './immediate-maintenance.mjs';
import { MAINTENANCE_TASK_TYPES } from './maintenance-tasks.mjs';
import { applyReportedStateProposal, isRepeatedReportedStateTransition } from './reported-state-policy.mjs';

const clean = value => String(value ?? '').trim();

const SAFE_AUTOMATIC_REPORTED_STATE_ACTIONS = new Set(["create", "reinforce"]);

function isDirectSelfReport(observation) {
  const payload = observation?.payload || {};
  switch (clean(observation?.state_family)) {
    case "preference":
      return payload.explicitExpression?.directness === "explicit_self_statement";
    case "identity":
      return payload.subject?.attribution === "explicit_self_report";
    case "belief":
      return payload.holder?.attribution === "explicit_self_statement";
    case "value":
      return payload.holder?.attribution === "explicit_self_statement"
        && ["explicit_principle", "reasoned_priority"].includes(payload.basis?.evidenceType);
    case "goal":
      return payload.holder?.attribution === "explicit_self_statement";
    case "capability":
      return payload.holder?.attribution === "explicit_self_statement"
        && payload.performance?.evidenceType === "self_report";
    case "self_concept":
      return ["explicit_self_definition", "explicit_self_reflection"]
        .includes(payload.holder?.attribution);
    case "condition":
    case "habit":
      return payload.evidenceBasis === "explicit_self_report";
    case "disposition":
      return payload.evidenceType === "explicit_self_description";
    case "relationship":
      return payload.perspective?.attribution === "explicit_self_statement";
    case "affective_association":
      return payload.experiencer?.attribution === "explicit_self_report";
    default:
      return false;
  }
}

/**
 * A direct self-report can be applied to the formal state without waiting for
 * review. Uncertain transitions retain the existing evidence-only path.
 */
export function assessReportedStateAutoAcceptance({
  repository,
  agentId,
  proposalId,
} = {}) {
  if (!repository) throw new Error("Reported-state auto-accept assessment requires a repository.");
  const normalizedAgentId = clean(agentId);
  const proposal = repository.getReportedStateProposal(normalizedAgentId, proposalId);
  if (!proposal) return { eligible: false, reason: "proposal-not-found", proposal: null };
  if (proposal.review_state !== "pending") {
    return { eligible: false, reason: `proposal-${proposal.review_state}`, proposal };
  }
  if (proposal.metadata?.reportedStateApplication) {
    return { eligible: false, reason: 'reported-state-already-applied', proposal };
  }
  if (proposal.state_family === 'preference') {
    return { eligible: false, reason: 'reported-preference-uses-direct-application', proposal };
  }
  const goalProgress = proposal.state_family === "goal" && proposal.action === "progress_update";
  if (!SAFE_AUTOMATIC_REPORTED_STATE_ACTIONS.has(proposal.action) && !goalProgress
    && !isRepeatedReportedStateTransition(repository, proposal)) {
    return { eligible: false, reason: "state-transition-requires-review", proposal };
  }
  if (!["user", "agent", "other"].includes(proposal.subject_role)) {
    return { eligible: false, reason: "subject-is-not-an-individual", proposal };
  }
  const requestId = clean(proposal.metadata?.stateAnalysisRequestId);
  const request = requestId
    ? repository.getStateAnalysisRequest(normalizedAgentId, requestId)
    : null;
  if (!request
    || request.evidence_mode !== "explicit"
    || request.representation_layer !== "reported"
    || request.subject_role !== proposal.subject_role
    || request.subject_key !== proposal.subject_key
    || request.canonical_key !== proposal.canonical_key) {
    return { eligible: false, reason: "request-boundary-mismatch", proposal };
  }
  const observation = repository.getStateEvidenceObservation(
    normalizedAgentId,
    proposal.selectedObservationId,
  );
  if (!observation
    || observation.lifecycle !== "current"
    || observation.qualification !== "qualified"
    || observation.subject_role !== proposal.subject_role
    || observation.subject_key !== proposal.subject_key
    || observation.canonical_key !== proposal.canonical_key
    || clean(observation.scope?.currentRepresentationLayer) !== "reported"
    || !isDirectSelfReport(observation)) {
    return { eligible: false, reason: "selected-evidence-is-not-direct-self-report", proposal };
  }
  const memoryId = clean(observation.memory_id || observation.memoryId);
  const detail = repository.getMemoryDetail(normalizedAgentId, memoryId);
  const isOwnUtterance = detail?.roles.some((role) => (
    role.role === "speaker"
    && role.actor_role === proposal.subject_role
    && role.actor_key === proposal.subject_key
    && Boolean(role.is_primary)
  ));
  if (!isOwnUtterance
    || !request.memoryIds.includes(memoryId)
    || observation.sourceIds.some((sourceId) => !request.sourceIds.includes(sourceId))) {
    return { eligible: false, reason: "speaker-or-source-boundary-mismatch", proposal };
  }
  if (goalProgress) {
    // Attaching the same direct source to its accepted goal preserves the existing state.
    const current = repository.getMemoryDetail(normalizedAgentId, proposal.previousMemoryId);
    if (!current || current.memory.status !== "active" || current.memory.layer === "provisional"
      || !observation.sourceIds.every(id => current.sources.some(source => source.id === id && source.lifecycle === "active"))) {
      return { eligible: false, reason: "state-transition-requires-review", proposal };
    }
  }
  return {
    eligible: true,
    reason: "explicit-self-report",
    proposal,
    request,
    observation,
  };
}

export function applyAutomaticReportedState({ repository, agentId, proposalId }) {
  const assessment = assessReportedStateAutoAcceptance({ repository, agentId, proposalId });
  if (!assessment.eligible) return { proposalId, reason: assessment.reason };
  return repository.transaction(() => {
    const resolution = applyReportedStateProposal(repository, { agentId, proposalId });
    const maintenance = runImmediateMemoryMaintenance({
      repository, agentId, batchId: `auto-reported-state:${proposalId}`,
      memoryIds: [resolution.memory?.id, resolution.previous?.id].filter(Boolean),
      followUpTaskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding], requiredFollowUpEnqueue: true,
    });
    return { proposalId, resolution, maintenance };
  });
}

// Keep the maintenance report shape for existing callers.
export function autoAcceptReportedStateProposals({ repository, agentId, proposalIds = [] } = {}) {
  if (!repository) throw new Error('Reported-state automatic application requires a repository.');
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error('Reported-state automatic application requires agentId.');
  const accepted = [], deferred = [];
  const selected = Array.isArray(proposalIds) ? [...new Set(proposalIds.map(clean).filter(Boolean))] : [];
  for (const proposalId of selected) {
    try {
      const result = applyAutomaticReportedState({ repository, agentId: normalizedAgentId, proposalId });
      (result.resolution ? accepted : deferred).push(result);
    } catch (error) {
      assertEventSourceExecutionCurrent();
      deferred.push({ proposalId, reason: 'application-revalidation-failed', error: error.message });
    }
  }
  return { status: accepted.length ? 'completed' : 'no-eligible-proposals', accepted, deferred };
}

export function recoverPendingAutomaticReportedStates(repository, agentId) {
  const proposals = repository.database.prepare(`
    SELECT proposal.id FROM memory_reported_state_proposals proposal
    JOIN memory_state_analysis_requests request ON request.agent_id = proposal.agent_id
      AND request.id = json_extract(proposal.metadata_json, '$.stateAnalysisRequestId')
    WHERE proposal.agent_id = ? AND proposal.state_family <> 'preference' AND proposal.review_state = 'pending'
      AND proposal.result_memory_id IS NULL AND json_type(proposal.metadata_json, '$.reportedStateApplication') IS NULL
      AND request.status = 'completed' AND json_extract(request.metadata_json, '$.proposalId') = proposal.id
    ORDER BY proposal.created_at, proposal.id`).all(agentId);
  return autoAcceptReportedStateProposals({ repository, agentId, proposalIds: proposals.map(proposal => proposal.id) });
}
