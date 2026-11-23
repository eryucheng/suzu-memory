import { createHash } from 'node:crypto';

const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
const ids = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value))].sort();
const summaryHash = (title, content) => createHash('sha256').update(JSON.stringify([title, content])).digest('hex');

export function structureSummaryMaterial(title, content, memoryIds, inputVersion) {
  return { version: 1, memoryIds: ids(memoryIds), contentHash: summaryHash(title, content),
    ...(inputVersion ? { inputVersion } : {}) };
}

export function readStructureSummaryMaterial(repository, memory) {
  const metadata = memory.metadata || parse(memory.metadata_json);
  const material = metadata.structureSummaryMaterial;
  const recorded = material?.version === 1 && material.contentHash === summaryHash(memory.title, memory.content) ? material : null;
  if (recorded?.inputVersion) return recorded;
  // Old unchanged generated summaries already have a persisted proposal owner.
  // Do not guess provenance for human rewrites or unrecorded summary versions.
  const ownerId = metadata.structureSummaryProposalId || metadata.structureProposalId;
  const owner = ownerId ? repository.getStructureProposal(memory.agent_id, ownerId) : null;
  if (!owner || owner.title !== memory.title || owner.content !== memory.content) return recorded;
  const inputVersion = owner.metadata?.organizationInput;
  // An older refresh could retain its attachment owner. Only a summary with
  // the same published text and member set can use that proposal's snapshot.
  const sourceIds = ids([...owner.memberIds, ...(inputVersion?.memories || []).map(item => item.id)]);
  if (recorded && JSON.stringify(ids(recorded.memoryIds)) !== JSON.stringify(sourceIds)) return recorded;
  return structureSummaryMaterial(memory.title, memory.content, sourceIds, inputVersion);
}

export function expectedStructureSummary(memory) {
  return { title: memory.title, content: memory.content, revision: memory.metadata?.structureSummaryRevision ?? 0 };
}

export function structureSummaryMatches(memory, expected) {
  return Boolean(memory && memory.title === expected.title && memory.content === expected.content
    && (memory.metadata?.structureSummaryRevision ?? 0) === (expected.revision ?? 0));
}

function summaryRefreshTargets(repository, agentId, memoryId = null) {
  return repository.database.prepare(`SELECT DISTINCT node.id FROM memory_maintenance_tasks task
    JOIN memory_nodes node ON node.agent_id = task.agent_id AND node.id = json_extract(task.payload_json, '$.memoryIds[0]')
    WHERE task.agent_id = ? AND task.lane = 'semantic' AND task.task_type = 'structure-summary'
      AND json_extract(task.payload_json, '$.invalidatesSummary') IS NOT 0
      AND (task.status <> 'completed' OR json_extract(task.result_json, '$.status') IS NOT 'completed')
      AND (? IS NULL OR node.id = ?)
      AND json_extract(task.payload_json, '$.expectedSummary.title') = node.title
      AND json_extract(task.payload_json, '$.expectedSummary.content') = node.content
      AND COALESCE(json_extract(task.payload_json, '$.expectedSummary.revision'), 0)
        = COALESCE(json_extract(node.metadata_json, '$.structureSummaryRevision'), 0)`).all(agentId, memoryId, memoryId);
}

export function structureSummaryNeedsRefresh(repository, agentId, memoryId) {
  return summaryRefreshTargets(repository, agentId, memoryId).length > 0;
}

export function unavailableStructureSummaryIds(repository, agentId) {
  const unavailable = new Set(summaryRefreshTargets(repository, agentId).map(({ id }) => id));
  if (!unavailable.size) return unavailable;
  const parents = new Map();
  for (const { memory, material } of readStructureDependencies(repository, agentId).values()) {
    for (const memberId of material?.memoryIds || []) {
      if (!parents.has(memberId)) parents.set(memberId, []);
      parents.get(memberId).push(memory.id);
    }
  }
  // A parent still contains the old child summary even before its own refresh is enqueued.
  for (const id of unavailable) for (const parent of parents.get(id) || []) unavailable.add(parent);
  return unavailable;
}

/** Typed membership and the inputs of the actual stored summary have different
 * lifetimes: detaching an edge does not erase the information in an old summary. */
export function readStructureDependencies(repository, agentId) {
  const rows = repository.database.prepare(`SELECT * FROM memory_nodes
    WHERE agent_id = ? AND kind IN ('topic', 'episode')`).all(agentId);
  const containers = new Map(rows.map(memory => [memory.id, { memory, memberIds: [], retiredMemberIds: [],
    material: readStructureSummaryMaterial(repository, memory) }]));
  for (const edge of repository.database.prepare(`SELECT edge.from_memory_id, edge.to_memory_id, edge.relation, member.status
    FROM memory_edges edge JOIN memory_nodes member ON member.id = edge.from_memory_id AND member.agent_id = edge.agent_id
    WHERE edge.agent_id = ? AND edge.relation IN ('supports_topic', 'part_of_episode')`).all(agentId)) {
    const container = containers.get(edge.to_memory_id);
    if (container && edge.relation === (container.memory.kind === 'topic' ? 'supports_topic' : 'part_of_episode')) {
      (edge.status === 'deleted' ? container.retiredMemberIds : container.memberIds).push(edge.from_memory_id);
    }
  }
  for (const container of containers.values()) {
    container.memberIds = ids(container.memberIds);
    container.dependencyIds = ids([...container.memberIds, ...(container.material?.memoryIds || [])]);
    const metadata = parse(container.memory.metadata_json);
    container.erasureDependencyIds = ids([...container.dependencyIds,
      ...(!container.material ? container.retiredMemberIds : []),
      ...(metadata.structureSummaryMaterial?.memoryIds || []),
      ...(metadata.organizationInput?.memories || []).map(item => item.id)]);
  }
  return containers;
}
