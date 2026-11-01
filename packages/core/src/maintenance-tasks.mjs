const clean = value => String(value ?? '').trim();
const uniqueStrings = values => [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
export const MAINTENANCE_LANES = Object.freeze({ embedding: 'embedding', semantic: 'semantic' });
export const MAINTENANCE_TASK_TYPES = Object.freeze({ memoryEmbedding: 'memory-embedding',
  retrievalContext: 'retrieval-context', structureProposal: 'structure-proposal', eventContinuity: 'event-continuity' });

export function memoryMaintenanceTaskPayload({ repository, agentId, batchId, memoryIds }) {
  const memories = memoryIds.map((memoryId) => repository.getMemory(memoryId))
    .filter((memory) => memory?.agent_id === agentId);
  return {
    batchId: clean(batchId),
    memoryIds,
    memoryVersions: memories.map((memory) => ({
      id: memory.id,
      updatedAt: memory.updated_at,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    retrievalContextVersions: memories.map((memory) => {
      const context = repository.getCurrentMemoryRetrievalContext(memory.id);
      return {
        memoryId: memory.id,
        contextId: clean(context?.id),
        sourceHash: clean(context?.source_hash),
        updatedAt: clean(context?.updated_at),
      };
    }).sort((left, right) => left.memoryId.localeCompare(right.memoryId)),
    worldIds: uniqueStrings(memories.map((memory) => memory.world_id)).sort(),
    subjects: [...new Map(memories.map((memory) => {
      const role = clean(memory.subject_role);
      const key = clean(memory.subject_key);
      return [`${role}\u001f${key}`, { role, key }];
    }).filter(([, subject]) => subject.role || subject.key)).values()],
  };
}

export function enqueueMemoryMaintenanceTasks({ repository, agentId, payload = null, batchId = "", memoryIds = [], taskTypes }) {
  payload ||= memoryMaintenanceTaskPayload({ repository, agentId, batchId, memoryIds });
  const definitions = [
    [MAINTENANCE_LANES.embedding, MAINTENANCE_TASK_TYPES.memoryEmbedding],
    [MAINTENANCE_LANES.semantic, MAINTENANCE_TASK_TYPES.retrievalContext],
    [MAINTENANCE_LANES.semantic, MAINTENANCE_TASK_TYPES.structureProposal],
    [MAINTENANCE_LANES.semantic, MAINTENANCE_TASK_TYPES.eventContinuity],
  ].filter(([, taskType]) => taskTypes.includes(taskType));
  return definitions.map(([lane, taskType]) => repository.enqueueMaintenanceTask({
    agentId,
    lane,
    taskType,
    payload,
  }));
}

export function retirePendingMemoryMaintenanceTasks(repository, { agentId, memoryId }) {
  return repository.database.prepare(`
    UPDATE memory_maintenance_tasks SET status = 'completed', completed_at = ?, updated_at = ?,
      result_json = ?, error_message = ''
    WHERE agent_id = ? AND status = 'pending'
      AND task_type IN ('memory-embedding', 'retrieval-context', 'structure-proposal', 'event-continuity')
      AND json_array_length(payload_json, '$.memoryIds') = 1
      AND json_extract(payload_json, '$.memoryIds[0]') = ?
  `).run(new Date().toISOString(), new Date().toISOString(),
    JSON.stringify({ status: 'skipped', reason: 'memory-deleted', memoryId }), agentId, memoryId).changes;
}
