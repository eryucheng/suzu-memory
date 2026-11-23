import { organizationInputIsCurrent, readOrganizationInput } from './organization-input.mjs';
import { resolveMemoryStructureProposal } from './structure-policy.mjs';
import { DIRECT_INGESTION_MEMORY_KINDS } from './ontology.mjs';
import { enqueueMemoryMaintenanceTasks, MAINTENANCE_TASK_TYPES } from './maintenance-tasks.mjs';
import { createHash } from 'node:crypto';
import { expectedStructureSummary, readStructureSummaryMaterial } from './structure-provenance.mjs';
import { relationProposalOwnsEdge } from './relation-policy.mjs';

export function enqueueStructureSummaryRefresh(repository, agentId, memory) {
  const members = repository.listContainerMembers({ agentId, containerId: memory.id, containerKind: memory.kind,
    relation: memory.kind === 'topic' ? 'supports_topic' : 'part_of_episode',
    statuses: ['active', 'superseded', 'disputed', 'archived'] });
  const input = readOrganizationInput(repository, agentId, members.map(member => member.id));
  repository.enqueueMaintenanceTask({ agentId, lane: 'semantic', taskType: MAINTENANCE_TASK_TYPES.structureSummary,
    payload: { batchId: `organization-members:${input.hash}`, memoryIds: [memory.id],
      expectedSummary: expectedStructureSummary(memory) } });
}

function refreshDependentSummaries(repository, agentId, memoryIds) {
  const parents = repository.database.prepare(`SELECT DISTINCT to_memory_id AS id FROM memory_edges
    WHERE agent_id = ? AND relation IN ('supports_topic', 'part_of_episode')
      AND from_memory_id IN (SELECT value FROM json_each(?))`).all(agentId, JSON.stringify(memoryIds));
  for (const { id } of parents) {
    const memory = repository.getMemory(id);
    if (memory?.status !== 'active') continue;
    const owner = repository.getStructureProposal(agentId,
      memory.metadata?.structureSummaryProposalId || memory.metadata?.structureProposalId || '');
    const hash = createHash('sha256').update(JSON.stringify([memory.title, memory.content])).digest('hex');
    // Only regenerate a summary still owned by the automatic organization flow.
    // A human rewrite is an independent assertion and must remain untouched.
    if (!readStructureSummaryMaterial(repository, memory)
      && (!owner || ((owner.title !== memory.title || owner.content !== memory.content)
        && memory.metadata.structureSummaryHash !== hash))) continue;
    enqueueStructureSummaryRefresh(repository, agentId, memory);
  }
}

// Called inside the mutation owner's transaction. Advancing only on a semantic
// change distinguishes an edit/restore from already retired work, including ABA
// edits, without letting access statistics or maintenance timestamps trigger LLMs.
export function finishOrganizationInputMutation(repository, { agentId, before, enqueue = false }) {
  const current = readOrganizationInput(repository, agentId, before.memories.map(memory => memory.id));
  const previous = new Map(before.memories.map(memory => [memory.id, memory.fingerprint]));
  const memoryIds = current.memories.filter(memory => memory.fingerprint !== previous.get(memory.id)).map(memory => memory.id);
  if (!memoryIds.length) return;
  for (const id of memoryIds) repository.database.prepare(`UPDATE memory_nodes SET metadata_json = json_set(metadata_json,
    '$.organizationRevision', COALESCE(json_extract(metadata_json, '$.organizationRevision'), 0) + 1)
    WHERE agent_id = ? AND id = ?`).run(agentId, id);
  invalidateOrganizationProposals(repository, { agentId, memoryIds });
  refreshDependentSummaries(repository, agentId, memoryIds);
  if (enqueue) {
    const active = memoryIds.filter(id => {
      const memory = repository.getMemory(id);
      return memory?.status === 'active' && DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind);
    });
    if (active.length) enqueueMemoryMaintenanceTasks({ repository, agentId, memoryIds: active,
      batchId: `organization-input:${readOrganizationInput(repository, agentId, active).hash}`,
      taskTypes: [MAINTENANCE_TASK_TYPES.structureProposal] });
  }
}

// Mutation owners retire only derivatives that depended on the changed records.
// Existing dismissal/revocation routines retain their ownership and rollback rules.
export function invalidateOrganizationProposals(repository, { agentId, memoryIds }) {
  const selected = JSON.stringify([...new Set(memoryIds)]);
  const actor = 'system:organization-invalidation';
  const note = 'Organization evidence changed; the previous proposal is no longer current.';
  return repository.transaction(() => {
    const structures = repository.database.prepare(`SELECT id FROM memory_structure_proposals proposal
      WHERE agent_id = ? AND review_state = 'pending' AND (
        EXISTS (SELECT 1 FROM json_each(member_ids_json) WHERE value IN (SELECT value FROM json_each(?)))
        OR EXISTS (SELECT 1 FROM json_each(metadata_json, '$.organizationInput.memories')
          WHERE json_extract(value, '$.id') IN (SELECT value FROM json_each(?))))`).all(agentId, selected, selected);
    for (const { id } of structures) {
      const proposal = repository.getStructureProposal(agentId, id);
      if (proposal.review_state !== 'pending' || organizationInputIsCurrent(repository, agentId, proposal.metadata.organizationInput)) continue;
      resolveMemoryStructureProposal(repository, { agentId, proposalId: id, action: 'dismiss', resolvedBy: actor, note });
    }
    const relations = repository.database.prepare(`SELECT id FROM memory_relation_proposals
      WHERE agent_id = ? AND review_state IN ('pending', 'accepted')
        AND (from_memory_id IN (SELECT value FROM json_each(?)) OR to_memory_id IN (SELECT value FROM json_each(?)))`)
      .all(agentId, selected, selected);
    for (const { id } of relations) {
      const proposal = repository.getRelationProposal(agentId, id);
      if (organizationInputIsCurrent(repository, agentId, proposal.metadata.organizationInput)) continue;
      if (proposal.review_state === 'pending') repository.resolveRelationProposal({ agentId, proposalId: id,
        resolution: 'dismissed', resolvedBy: actor, note });
      else {
        const edge = repository.getEdge(agentId, proposal.result_edge_id);
        // A subsequent human edit owns its edge. Never delete it as if it were
        // still the unchanged derivative originally created by this proposal.
        if (relationProposalOwnsEdge(proposal, edge)) {
          repository.revokeRelationProposal({ agentId, proposalId: id, revokedBy: actor, note });
        }
      }
    }
  });
}
