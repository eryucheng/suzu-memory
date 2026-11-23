import { readOrganizationInput } from './organization-input.mjs';
import { finishOrganizationInputMutation } from './organization-invalidation.mjs';
import { memoryWorldScope } from './ontology.mjs';
import { runImmediateMemoryMaintenance } from './immediate-maintenance.mjs';
import { MAINTENANCE_TASK_TYPES } from './maintenance-tasks.mjs';
import { readReportedStateTransition, reportedStateMaterializedMemory,
  restorePreviousReportedState, reapplyReportedStateTransition,
  reportedStateEvidenceMemoryFingerprint, reportedStateSourceFingerprint } from './reported-state-policy.mjs';

const liveReview = proposal => ['pending', 'accepted'].includes(proposal?.review_state);

function currentEvidence(repository, agentId, snapshot, erasedSources = null) {
  const detail = repository.getMemoryDetail(agentId, snapshot.memoryId);
  if (!detail || detail.memory.status === 'deleted'
    || reportedStateEvidenceMemoryFingerprint(detail) !== snapshot.memoryFingerprint) return false;
  const sources = new Map(detail.sources.map(source => [source.id, source]));
  return snapshot.sourceFingerprints.every(item => {
    const source = sources.get(item.id);
    return !erasedSources?.has(item.id) && source?.lifecycle === 'active'
      && reportedStateSourceFingerprint(source) === item.fingerprint;
  });
}

function changeTransition(repository, effect, reapply, erasing) {
  const { transition } = effect;
  const proposal = repository.getReportedStateProposal(effect.proposal.agent_id, effect.proposal.id);
  const actor = 'system:reported-state-evidence';
  const reason = reapply ? 'Restore the supported reported state transition.' : 'Reported state transition evidence is unavailable.';
  try {
    return reapply ? reapplyReportedStateTransition(repository, proposal, transition, { actor, reason })
      : restorePreviousReportedState(repository, proposal, transition, { actor, reason, erasing, suspend: true });
  } catch (error) {
    if (error.code !== 'EVENT_SOURCE_TASK_DEFERRED') throw error;
    return false;
  }
}

function reconcilePublishedState(repository, agentId, memoryId, effect) {
  const memory = repository.getMemory(memoryId);
  if (!memory) return;
  const suspended = memory.metadata.reportedStateSuspendedStatus;
  if (memory.status === 'deleted' && !suspended) return;

  const links = repository.database.prepare(`
    SELECT link.source_id AS sourceId, link.relation, link.metadata_json AS metadata, source.lifecycle
    FROM memory_sources link JOIN source_records source ON source.id=link.source_id WHERE link.memory_id=?`).all(memoryId);
  const proposals = new Map();
  const ownership = id => {
    if (!proposals.has(id)) proposals.set(id, repository.getReportedStateProposal(agentId, id));
    return proposals.get(id);
  };
  const observations = new Map();
  const changes = [];
  let supported = false;
  for (const link of links) {
    const metadata = JSON.parse(link.metadata);
    const { reportedStateProposalId, observationId, reportedStateEvidenceUnavailable } = metadata;
    let current = link.lifecycle === 'active';
    if (reportedStateProposalId && observationId) {
      const proposal = ownership(reportedStateProposalId);
      const key = JSON.stringify([reportedStateProposalId, observationId]);
      if (!observations.has(key)) {
        const snapshot = proposal?.metadata.reportedStateEvidenceSnapshot?.observations?.find(item => item.observationId === observationId);
        observations.set(key, liveReview(proposal) && (!snapshot || currentEvidence(repository, agentId, snapshot)));
      }
      current &&= observations.get(key);
      if (Boolean(reportedStateEvidenceUnavailable) === current) {
        changes.push({ ...link, current, reportedStateProposalId, observationId });
      }
    }
    supported ||= current;
  }
  const owner = ownership(memory.metadata.reportedStateProposalId || '');
  const owned = liveReview(owner) && !memory.metadata.manuallyEdited
    && (owner.resultMemoryId === memoryId || (memory.layer === 'provisional'
      && reportedStateMaterializedMemory(repository, owner)?.id === memoryId));
  const available = supported && effect?.supported !== false;
  const suspend = owned && !available && memory.status !== 'deleted';
  const restore = owned && available && suspended && memory.status === 'deleted';
  if (!changes.length && !suspend && !restore) return;
  const before = readOrganizationInput(repository, agentId, [memoryId]);

  for (const link of changes) {
    repository.database.prepare(`
      UPDATE memory_sources SET metadata_json=json_set(metadata_json, '$.reportedStateEvidenceUnavailable', ?)
      WHERE memory_id=? AND source_id=? AND relation=?`).run(Number(!link.current), memoryId, link.sourceId, link.relation);
    repository.database.prepare(`
      UPDATE memory_edges SET metadata_json=json_set(metadata_json, '$.reportedStateEvidenceUnavailable', ?)
      WHERE agent_id=? AND from_memory_id=? AND json_extract(metadata_json, '$.reportedStateProposalId')=?
        AND json_extract(metadata_json, '$.observationId')=?`)
      .run(Number(!link.current), agentId, memoryId, link.reportedStateProposalId, link.observationId);
  }
  if (suspend) {
    const reason = 'No current evidence remains for the reported state.';
    repository.updateMemoryMetadata({ agentId, memoryId, reason,
      metadata: { ...memory.metadata, reportedStateSuspendedStatus: memory.status } });
    repository.setMemoryDeleted({ agentId, memoryId, actor: 'system:reported-state-evidence', reason });
  } else if (restore) {
    let canRestore = true;
    try {
      if (effect && owner.metadata.reportedStateTransitionSuspended) canRestore = changeTransition(repository, effect, true);
      else if (suspended === 'active' || memory.layer === 'provisional') canRestore = !repository.getCurrentCanonicalMemory({
        ...memoryWorldScope(memory), agentId, subjectRole: memory.subject_role, subjectKey: memory.subject_key,
        canonicalKey: memory.canonical_key, stateFamily: memory.state_family, stateScopeKey: memory.state_scope_key,
        representationLayer: memory.representation_layer, includePending: true, excludeMemoryId: memoryId,
      });
    } catch (error) {
      if (error.code !== 'EVENT_SOURCE_TASK_DEFERRED') throw error;
      canRestore = false;
    }
    if (canRestore) {
      const { reportedStateSuspendedStatus, ...metadata } = repository.getMemory(memoryId).metadata;
      repository.updateMemoryStatus(memoryId, reportedStateSuspendedStatus);
      const restored = repository.updateMemoryMetadata({ agentId, memoryId, metadata,
        reason: 'Original reported-state evidence is current again.' });
      runImmediateMemoryMaintenance({ repository, agentId, memoryIds: [memoryId],
        batchId: `reported-state-restored:${restored.updated_at}`,
        followUpTaskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding], planConsolidation: false, requiredFollowUpEnqueue: true });
    }
  }
  finishOrganizationInputMutation(repository, { agentId, before });
}

/** Follow the recorded observation and source ownership instead of changing
 * the review status. Soft-deleted source links remain available for rollback. */
export function reconcileReportedStateEvidence(repository, {
  agentId, memoryIds = [], sourceIds = [], resultMemoryIds = [], recover = false, erasing = null,
}) {
  if (!recover && !memoryIds.length && !sourceIds.length && !resultMemoryIds.length) return;
  const selection = recover
    ? `(evidence.status='deleted' OR json_extract(evidence.metadata_json, '$.manuallyEdited')=1
        OR source.lifecycle<>'active' OR json_type(state.metadata_json, '$.reportedStateSuspendedStatus')='text'
        OR json_type(proposal.metadata_json, '$.reportedStateTransitionSuspended')='object')`
    : `(evidence.id IN (SELECT value FROM json_each(?)) OR source.id IN (SELECT value FROM json_each(?)))`;
  const targets = memoryIds.length || sourceIds.length || recover ? repository.database.prepare(`
    SELECT DISTINCT proposal.id FROM memory_reported_state_proposals proposal
    LEFT JOIN memory_nodes state ON state.id=proposal.result_memory_id
    JOIN memory_reported_state_proposal_observations ref ON ref.agent_id=proposal.agent_id AND ref.proposal_id=proposal.id
    JOIN memory_state_evidence_observations observation ON observation.id=ref.observation_id
    JOIN memory_nodes evidence ON evidence.id=observation.memory_id
    JOIN memory_state_observation_sources material ON material.observation_id=observation.id
    JOIN source_records source ON source.id=material.source_id
    WHERE proposal.agent_id=? AND proposal.state_family<>'preference'
      AND proposal.review_state IN ('pending', 'accepted') AND ${selection}
  `).all(agentId, ...(recover ? [] : [JSON.stringify(memoryIds), JSON.stringify(sourceIds)])) : [];
  const memories = new Set(resultMemoryIds);
  const effects = [];
  const separated = new Map();
  const erasedSources = erasing ? new Set(sourceIds) : null;
  const proposals = new Set(targets.map(row => row.id));
  for (const memoryId of resultMemoryIds) {
    const { reportedStateTransitionId: transitionId, reportedStateProposalId: ownerId } = repository.getMemory(memoryId)?.metadata || {};
    if (transitionId) proposals.add(transitionId);
    if (ownerId) proposals.add(ownerId);
  }
  // A restored predecessor can still carry a cutoff imposed by a replacement
  // whose own source was already removed. Revisit the owner of that cutoff.
  for (const id of proposals) {
    const proposal = repository.getReportedStateProposal(agentId, id);
    if (!proposal || proposal.state_family === 'preference') continue;
    const result = reportedStateMaterializedMemory(repository, proposal);
    const successor = result?.metadata.reportedStateTransitionId;
    if (successor) proposals.add(successor);
    if (!liveReview(proposal) || !result) continue;
    memories.add(result.id);
    const transition = readReportedStateTransition(repository, proposal);
    const snapshots = proposal.metadata?.reportedStateEvidenceSnapshot?.observations;
    if (!transition || !snapshots?.length) continue;
    for (const memoryId of new Set([proposal.previousMemoryId, transition.memoryId])) {
      const previous = repository.getMemory(memoryId);
      if (previous?.metadata.reportedStateSuspendedStatus && previous.metadata.reportedStateProposalId) {
        proposals.add(previous.metadata.reportedStateProposalId);
      }
    }
    const separate = result.id !== transition.memoryId;
    if (separate && (result.metadata.reportedStateProposalId !== proposal.id || result.metadata.manuallyEdited)) continue;
    const effect = { proposal, transition, separate,
      supported: snapshots.every(snapshot => currentEvidence(repository, agentId, snapshot, erasedSources)) };
    effects.push(effect);
    if (separate) separated.set(result.id, effect);
  }
  for (const id of memories) {
    if (erasing?.has(id)) repository.updateMemoryStatus(id, 'deleted');
    else if (!erasing) reconcilePublishedState(repository, agentId, id, separated.get(id));
  }
  const reconsider = new Set();
  for (const effect of effects) {
    const suspended = effect.proposal.metadata.reportedStateTransitionSuspended;
    if (!effect.supported && !suspended) {
      const restored = changeTransition(repository, effect, false, erasing);
      for (const id of restored?.suspendedMemoryIds || []) reconsider.add(id);
      const predecessor = repository.getMemory(effect.proposal.previousMemoryId);
      if (restored && predecessor?.metadata.reportedStateSuspendedStatus) reconsider.add(predecessor.id);
    }
    else if (effect.supported && suspended && !effect.separate) changeTransition(repository, effect, true);
  }
  if (!erasing) for (const id of reconsider) reconcilePublishedState(repository, agentId, id, separated.get(id));
  if (recover) {
    const cutoffs = repository.database.prepare(`SELECT DISTINCT proposal.id FROM memory_nodes memory
      JOIN memory_reported_state_proposals proposal ON proposal.agent_id=memory.agent_id
        AND proposal.id=json_extract(memory.metadata_json, '$.reportedStateTransitionId')
      WHERE memory.agent_id=? AND memory.status IN ('superseded', 'disputed')
        AND proposal.state_family<>'preference' AND proposal.review_state='dismissed'`).all(agentId);
    for (const { id } of cutoffs) {
      const proposal = repository.getReportedStateProposal(agentId, id);
      restorePreviousReportedState(repository, proposal, readReportedStateTransition(repository, proposal), {
        actor: 'system:reported-state-evidence', reason: 'Recover the state left closed by a withdrawn transition.',
      });
    }
  }
}
