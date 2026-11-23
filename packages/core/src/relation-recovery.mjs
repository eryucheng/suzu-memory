import { materializeMemoryRelationProposal, relationProposalOwnsEdge } from './relation-policy.mjs';
import { readOrganizationInput, organizationInputIsCurrent } from './organization-input.mjs';
import { enqueueMemoryMaintenanceTasks, MAINTENANCE_TASK_TYPES } from './maintenance-tasks.mjs';

// Older consolidation checkpoints kept the actual evidence with their results.
// Recover from those records only when both endpoints and all cited sources are
// unchanged. Missing snapshots are never replaced by an assumption of validity.
function legacyEvidence(repository, agentId) {
  const saved = new Map();
  for (const row of repository.database.prepare(`SELECT id, metadata_json FROM memory_consolidation_runs
    WHERE agent_id = ? AND json_array_length(relation_proposal_ids_json) > 0`).all(agentId)) {
    const progress = JSON.parse(row.metadata_json).organizationProgress;
    for (const part of progress?.parts || []) for (const proposal of [
      ...(part.relations?.proposed || []), ...(part.relations?.duplicates || []),
    ]) saved.set(proposal.id, { proposal, runId: row.id });
  }
  return saved;
}

function restoreLegacyInput(repository, proposal, saved) {
  if (!saved || saved.proposal.agent_id !== proposal.agent_id
    || ['from_memory_id', 'to_memory_id', 'relation', 'rationale', 'proposal_hash', 'created_at']
      .some(key => saved.proposal[key] !== proposal[key])) return false;
  const createdAt = Date.parse(proposal.created_at);
  const endpoints = [proposal.from_memory_id, proposal.to_memory_id].map(id => repository.getMemory(id));
  if (!Number.isFinite(createdAt) || endpoints.some(memory => !memory || memory.status === 'deleted'
    || !(Date.parse(memory.updated_at) <= createdAt))) return false;
  const sources = new Map((saved.proposal.evidence || []).map(source => [source.id, source]));
  const fields = ['id', 'agent_id', 'source_kind', 'external_id', 'content', 'content_hash', 'speaker',
    'occurred_at', 'known_at', 'recorded_at', 'world_id', 'world_frame', 'lifecycle', 'revision_id'];
  if (!proposal.evidence.length || sources.size !== proposal.evidence.length || proposal.evidence.some(source => {
    const original = sources.get(source.id);
    return !original || fields.some(key => (original[key] ?? '') !== (source[key] ?? ''))
      || original.metadata?.sourceTimeKnown !== source.metadata?.sourceTimeKnown;
  })) return false;
  const input = readOrganizationInput(repository, proposal.agent_id, endpoints.map(memory => memory.id));
  repository.database.prepare(`UPDATE memory_relation_proposals SET metadata_json = json_set(metadata_json,
    '$.organizationInput', json(?), '$.relationRecovery', json(?)) WHERE agent_id = ? AND id = ?`)
    .run(JSON.stringify(input), JSON.stringify({ evidenceRunId: saved.runId, recoveredAt: new Date().toISOString() }),
      proposal.agent_id, proposal.id);
  return true;
}

export function materializePendingMemoryRelationProposals(repository, { agentId, batchSize = 100 } = {}) {
  if (!repository || !String(agentId || '').trim()) throw new Error('Relation recovery requires repository and agentId.');
  const size = Math.min(500, Math.max(1, Math.trunc(Number(batchSize) || 100)));
  const result = { materialized: [], covered: [], requeued: [], retired: [], failed: [] };
  let cursor = '', saved;
  for (;;) {
    // Page by ID rather than repeatedly reading the first pending page. A bad
    // record cannot prevent later records from becoming available after restart.
    const rows = repository.database.prepare(`SELECT id FROM memory_relation_proposals
      WHERE agent_id = ? AND review_state = 'pending' AND result_edge_id IS NULL AND id > ?
      ORDER BY id LIMIT ?`).all(agentId, cursor, size);
    if (!rows.length) break;
    for (const { id } of rows) {
      cursor = id;
      try {
        const status = repository.transaction(() => {
          let proposal = repository.getRelationProposal(agentId, id);
          if (!proposal.metadata.organizationInput) {
            saved ||= legacyEvidence(repository, agentId);
            restoreLegacyInput(repository, proposal, saved.get(id));
            proposal = repository.getRelationProposal(agentId, id);
          }
          const edge = repository.findEdge({ agentId, fromMemoryId: proposal.from_memory_id,
            toMemoryId: proposal.to_memory_id, relation: proposal.relation });
          const owner = edge && repository.getRelationProposal(agentId, edge.metadata?.relationProposalId);
          if (relationProposalOwnsEdge(owner, edge) && ['pending', 'accepted'].includes(owner.review_state)
            && organizationInputIsCurrent(repository, agentId, owner.metadata.organizationInput)) {
            repository.resolveRelationProposal({ agentId, proposalId: id, resolution: 'dismissed',
              resolvedBy: 'system:relation-recovery', note: `Relation is already applied by ${owner.id}.` });
            return 'covered';
          }
          const applied = materializeMemoryRelationProposal(repository, { agentId, proposalId: id });
          return applied.status === 'retired' ? 'retired' : 'materialized';
        });
        result[status].push(id);
      } catch (error) {
        if (!['MEMORY_ORGANIZATION_INPUT_CHANGED', 'MEMORY_ORGANIZATION_INVALID_CANDIDATE'].includes(error.code)) {
          result.failed.push({ proposalId: id, error: error.message });
          continue;
        }
        try {
          const queued = repository.transaction(() => {
            const proposal = repository.getRelationProposal(agentId, id);
            repository.resolveRelationProposal({ agentId, proposalId: id, resolution: 'dismissed',
              resolvedBy: 'system:relation-recovery', note: error.message });
            const memoryIds = [proposal.from_memory_id, proposal.to_memory_id]
              .filter(memoryId => repository.getMemory(memoryId)?.status === 'active');
            if (memoryIds.length < 2) return false;
            enqueueMemoryMaintenanceTasks({ repository, agentId, memoryIds,
              batchId: `relation-recovery:${id}`, taskTypes: [MAINTENANCE_TASK_TYPES.structureProposal] });
            return true;
          });
          (queued ? result.requeued : result.retired).push(id);
        } catch (failure) { result.failed.push({ proposalId: id, error: failure.message }); }
      }
    }
  }
  return result;
}
