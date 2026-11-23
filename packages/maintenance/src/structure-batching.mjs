import { createHash } from "node:crypto";
import { DIRECT_INGESTION_MEMORY_KINDS, assertEventSourceExecutionCurrent, executionEventSourceView, readOrganizationInput } from "@suzu-memory/core";

export const DEFAULT_MINIMUM_STRUCTURE_MEMORIES = 20;

const unique = values => [...new Set(values.filter(Boolean))];
const versionKey = memory => JSON.stringify([memory.id, memory.fingerprint || memory.updatedAt || memory.updated_at]);

function selectAccumulatedStructureTasks({ repository, agentId, minimumMemories, now }) {
  assertEventSourceExecutionCurrent(agentId);
  if (!repository.database.prepare(`SELECT 1 FROM memory_maintenance_tasks
    WHERE agent_id = ? AND task_type = 'structure-proposal' AND attempt_count < max_attempts
      AND available_at <= ? AND (status = 'pending'
        OR (status = 'running' AND lease_expires_at <= ?)) LIMIT 1`).get(agentId, now, now)) {
    return { taskIds: [], eligible: new Map(), pendingMemoryCount: 0, accumulatingTaskCount: 0 };
  }
  const sourceView = executionEventSourceView(repository, agentId);
  const queued = [];
  for (let offset = 0; ; offset += 500) {
    const page = repository.listMaintenanceTasks(agentId, {
      taskTypes: ["structure-proposal"], statuses: ["pending", "running"], limit: 500, offset,
    });
    queued.push(...page);
    if (page.length < 500) break;
  }
  const tasks = queued.filter(task => task.attempt_count < task.max_attempts && task.available_at <= now
    && (task.status === "pending" || task.lease_expires_at <= now)
    && (!sourceView || (task.payload.memoryIds?.length
      && task.payload.memoryIds.every(id => sourceView.memoryIds.has(id)))));
  const requestedIds = unique(tasks.flatMap(task => task.payload.memoryIds || []));
  const completed = repository.database.prepare(`
    SELECT payload_json, result_json FROM memory_maintenance_tasks
    WHERE agent_id = ? AND task_type = 'structure-proposal' AND status = 'completed'
      AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.memoryIds') member
        WHERE member.value IN (SELECT value FROM json_each(?)))
  `).all(agentId, JSON.stringify(requestedIds));
  const processed = new Set(completed.flatMap(row => {
    const result = JSON.parse(row.result_json);
    const payload = JSON.parse(row.payload_json);
    return (result.processedMemoryVersions || payload.memoryVersions || []).map(versionKey);
  }));
  const input = readOrganizationInput(repository, agentId, requestedIds);
  const fingerprints = new Map(input.memories.map(memory => [memory.id, memory.fingerprint]));
  const eligible = new Map(requestedIds.map(id => repository.getMemory(id))
    .filter(memory => memory?.agent_id === agentId && memory.status === "active"
      && memory.layer !== "provisional" && DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind)
      && !processed.has(versionKey({ id: memory.id, fingerprint: fingerprints.get(memory.id) }))
      && !processed.has(versionKey(memory)))
    .map(memory => [memory.id, { ...memory, fingerprint: fingerprints.get(memory.id) }]));
  const availableTaskIds = new Set(tasks.map(task => task.id));
  const frozen = tasks.find(task => task.result?.structureBatch
    && task.result.structureBatch.taskIds.every(id => {
      if (availableTaskIds.has(id)) return true;
      const settled = repository.getMaintenanceTask(agentId, id);
      return settled?.status === 'completed' && (settled.result?.reason === 'memory-deleted'
        || settled.result?.structureBatch?.id === task.result.structureBatch.id);
    }));
  if (frozen) {
    // Earlier releases could retire a deleted member's task independently. The
    // surviving owners must still be able to settle their shared checkpoint.
    const batch = { ...frozen.result.structureBatch,
      taskIds: frozen.result.structureBatch.taskIds.filter(id => availableTaskIds.has(id)) };
    return { taskIds: batch.taskIds, batch, pendingMemoryCount: 0, accumulatingTaskCount: 0 };
  }
  // A waiting/in-flight batch owns these memory versions until it is settled.
  const reserved = new Set(queued.flatMap(task => task.result?.structureBatch?.memoryVersions || []).map(versionKey));
  const groups = new Map();
  const empty = [];
  for (const task of tasks) {
    if (task.result?.structureBatch) continue;
    if ((task.payload.memoryIds || []).some(id => eligible.has(id) && reserved.has(versionKey(eligible.get(id))))) continue;
    const ids = (task.payload.memoryIds || []).filter(id => eligible.has(id));
    if (!ids.length) { empty.push(task); continue; }
    const priorMembers = task.failureHistory?.findLast(item => item.details?.memoryIds)?.details.memoryIds;
    const key = task.attempt_count > 0
      ? `retry:${JSON.stringify(priorMembers?.slice().sort() || [task.id])}` : "new-memories";
    const group = groups.get(key) || [];
    group.push(task);
    groups.set(key, group);
  }
  let selected = empty.slice(0, 100);
  let pendingMemoryCount = 0;
  let accumulatingTaskCount = 0;
  if (!selected.length) {
    for (const group of groups.values()) {
      const count = unique(group.flatMap(task => task.payload.memoryIds || []).filter(id => eligible.has(id))).length;
      pendingMemoryCount += count;
      if (count < minimumMemories && group.every(task => task.attempt_count === 0)) accumulatingTaskCount += group.length;
      // Retries retain the original work even if some evidence was removed meanwhile.
      if (!selected.length && (count >= minimumMemories || group.some(task => task.attempt_count > 0))) {
        if (group.some(task => task.attempt_count > 0)) { selected = group.slice(0, 100); continue; }
        const collected = new Set();
        for (const task of group) {
          if (!(task.payload.memoryIds || []).some(id => eligible.has(id) && !collected.has(id))) continue;
          selected.push(task);
          for (const id of task.payload.memoryIds || []) if (eligible.has(id)) collected.add(id);
          if (collected.size >= minimumMemories) break;
        }
      }
    }
  }
  return { taskIds: selected.map(task => task.id), eligible, pendingMemoryCount, accumulatingTaskCount };
}

export function inspectAccumulatedStructureTasks(options) {
  const { accumulatingTaskCount, pendingMemoryCount } = selectAccumulatedStructureTasks({
    ...options, now: new Date().toISOString(),
  });
  return { accumulatingTaskCount, pendingMemoryCount };
}

function currentStructureBatch(repository, agentId, batch) {
  const view = executionEventSourceView(repository, agentId);
  const memories = batch.memoryIds.map(id => repository.getMemory(id)).filter(memory => memory?.agent_id === agentId
    && memory.status === 'active' && memory.layer !== 'provisional' && DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind)
    && (!view || view.memoryIds.has(memory.id)));
  const memoryIds = memories.map(memory => memory.id);
  const organizationInput = readOrganizationInput(repository, agentId, memoryIds);
  if (batch.organizationInput?.hash === organizationInput.hash) return batch;
  // A checkpoint only proves coverage for its recorded input. Rebuild this
  // affected batch after a semantic change, keeping other batches untouched.
  const fingerprints = new Map(organizationInput.memories.map(memory => [memory.id, memory.fingerprint]));
  const memoryVersions = memories.map(memory => ({ id: memory.id, updatedAt: memory.updated_at, fingerprint: fingerprints.get(memory.id) }));
  const worlds = new Map();
  for (const memory of memories) {
    const key = JSON.stringify([memory.reality, memory.world_id, memory.world_frame]);
    if (!worlds.has(key)) worlds.set(key, []);
    worlds.get(key).push(memory.id);
  }
  return { id: batch.id, taskIds: batch.taskIds, memoryIds, memoryVersions, organizationInput,
    parts: [...worlds.values()].map((ids, index) => ({ id: `${batch.id}:world-${index}`, memoryIds: ids, status: 'pending' })) };
}

export function claimAccumulatedStructureTasks({ repository, agentId, workerId, minimumMemories }) {
  return repository.transaction(() => {
    const now = new Date().toISOString();
    const { taskIds, batch: frozenBatch, eligible, pendingMemoryCount } = selectAccumulatedStructureTasks({
      repository, agentId, minimumMemories, now,
    });
    if (!taskIds.length) return { workerId, tasks: [], memoryIds: [], pendingMemoryCount };
    const claimed = repository.claimMaintenanceTasks({
      agentId, lane: "semantic", taskTypes: ["structure-proposal"],
      taskIds, maximumTasks: 100, workerId, claimedAt: now,
    });
    if (frozenBatch) {
      if (claimed.tasks.length !== frozenBatch.taskIds.length) throw new Error("Structure batch could not be claimed atomically.");
      const batch = currentStructureBatch(repository, agentId, frozenBatch);
      for (const task of claimed.tasks) repository.checkpointMaintenanceTask({ agentId, taskId: task.id, workerId,
        result: { structureBatch: batch } });
      return { ...claimed, batch, memoryIds: batch.memoryIds, memoryVersions: batch.memoryVersions, pendingMemoryCount };
    }
    const memoryIds = unique(claimed.tasks.flatMap(task => task.payload.memoryIds || []).filter(id => eligible.has(id)));
    const id = `accumulated-structure:${createHash("sha256").update(claimed.tasks.map(task => task.id).sort().join(":" )).digest("hex").slice(0, 24)}`;
    const batch = currentStructureBatch(repository, agentId, { id, taskIds: claimed.tasks.map(task => task.id), memoryIds });
    for (const task of claimed.tasks) repository.checkpointMaintenanceTask({ agentId, taskId: task.id, workerId,
      result: { structureBatch: batch } });
    return { ...claimed, batch, memoryIds, pendingMemoryCount, memoryVersions: batch.memoryVersions };
  });
}

// Existing small plans rejoin the same durable accumulation queue. Plans with
// partial results retain their original retry path.
export function deferSmallConsolidationRuns({ repository, agentId, minimumMemories }) {
  const runs = repository.listClaimableConsolidationRuns(agentId, { now: new Date().toISOString(), limit: 100 });
  for (const run of runs) {
    if (run.triggerIds.length >= minimumMemories || run.structureProposalIds.length || run.relationProposalIds.length
      || run.metadata?.accumulatedStructureBatchId || run.metadata?.organizationProgress || run.metadata?.replannedFrom) continue;
    repository.transaction(() => {
      const workerId = `accumulate:${run.id}`;
      repository.claimConsolidationRun({ agentId, runId: run.id, workerId });
      repository.enqueueMaintenanceTask({ agentId, lane: "semantic", taskType: "structure-proposal",
        payload: { batchId: `accumulate:${run.id}`, memoryIds: run.triggerIds } });
      repository.finishConsolidationRun({ agentId, runId: run.id, status: "cancelled", workerId });
    });
  }
}
