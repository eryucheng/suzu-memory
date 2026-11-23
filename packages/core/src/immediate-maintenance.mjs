import { updateAssociationGraph } from './association-graph.mjs';
import { assertEventSourceExecutionCurrent } from './event-source-execution.mjs';
import { MAINTENANCE_TASK_TYPES, enqueueMemoryMaintenanceTasks, memoryMaintenanceTaskPayload as taskPayload } from './maintenance-tasks.mjs';
import { DIRECT_INGESTION_MEMORY_KINDS } from './ontology.mjs';
import { syncMemoryRelationshipMemberships } from './relationship-structure.mjs';

const clean = value => String(value ?? '').trim();
const uniqueStrings = values => [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];

/**
 * Runs only deterministic work for newly stored memories. It never scans old
 * data and never invokes an external model. Expensive follow-up work is merely
 * recorded in the persistent maintenance queue.
 */
export function runImmediateMemoryMaintenance({
  repository,
  agentId,
  batchId = "",
  memoryIds = [],
  embeddingMemoryIds = memoryIds,
  followUpTaskTypes = [MAINTENANCE_TASK_TYPES.memoryEmbedding, MAINTENANCE_TASK_TYPES.structureProposal, MAINTENANCE_TASK_TYPES.eventContinuity],
  planConsolidation = true,
  requiredFollowUpEnqueue = false,
} = {}) {
  if (!repository) throw new Error("Immediate memory maintenance requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedMemoryIds = uniqueStrings(memoryIds).sort();
  const normalizedEmbeddingMemoryIds = uniqueStrings(embeddingMemoryIds).sort();
  const normalizedFollowUpTaskTypes = uniqueStrings(followUpTaskTypes);
  if (!normalizedAgentId) throw new Error("Immediate memory maintenance requires agentId.");
  if (normalizedFollowUpTaskTypes.some((taskType) => (
    !Object.values(MAINTENANCE_TASK_TYPES).includes(taskType)
  ))) {
    throw new Error("Immediate memory maintenance received an unknown follow-up task type.");
  }
  if (!normalizedMemoryIds.length && !normalizedEmbeddingMemoryIds.length) {
    return {
      status: "skipped",
      reason: "no-new-memories",
      relationshipMemberships: { status: "skipped", linked: 0 },
      associations: { status: "skipped", memories: 0 },
      consolidationPlan: null,
      queued: [],
      warnings: [],
    };
  }

  const warnings = [];
  const provisionalMemoryIdSet = new Set(normalizedMemoryIds.filter((memoryId) => (
    repository.getMemory(memoryId)?.layer === "provisional"
  )));
  const formalMemoryIds = normalizedMemoryIds.filter((memoryId) => (
    !provisionalMemoryIdSet.has(memoryId)
  ));
  let relationshipMemberships = { status: "skipped", linked: 0 };
  let associations = { status: "skipped", memories: 0 };
  let consolidationPlan = null;
  const queued = [];
  try {
    relationshipMemberships = formalMemoryIds.length
      ? syncMemoryRelationshipMemberships({
        repository,
        agentId: normalizedAgentId,
        memoryIds: formalMemoryIds,
      })
      : relationshipMemberships;
  } catch (error) {
    assertEventSourceExecutionCurrent();
    warnings.push(`Relationship membership sync failed: ${error.message}`);
  }
  try {
    associations = formalMemoryIds.length ? updateAssociationGraph({
      repository,
      agentId: normalizedAgentId,
      memoryIds: formalMemoryIds,
    }) : associations;
  } catch (error) {
    assertEventSourceExecutionCurrent();
    warnings.push(`Association update failed: ${error.message}`);
  }
  if (planConsolidation && formalMemoryIds.length) {
    const eligibleIds = formalMemoryIds.filter(id => DIRECT_INGESTION_MEMORY_KINDS.includes(repository.getMemory(id)?.kind));
    consolidationPlan = { status: "accumulating", memoryIds: eligibleIds };
    if (eligibleIds.length && !normalizedFollowUpTaskTypes.includes(MAINTENANCE_TASK_TYPES.structureProposal)) {
      normalizedFollowUpTaskTypes.push(MAINTENANCE_TASK_TYPES.structureProposal);
    }
  }
  try {
    if (normalizedFollowUpTaskTypes.includes(MAINTENANCE_TASK_TYPES.memoryEmbedding)) {
      if (normalizedEmbeddingMemoryIds.length) {
        queued.push(...enqueueMemoryMaintenanceTasks({
          repository,
          agentId: normalizedAgentId,
          payload: taskPayload({
            repository,
            agentId: normalizedAgentId,
            batchId,
            memoryIds: normalizedEmbeddingMemoryIds,
          }),
          taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding],
        }));
      }
    }
    const eventIds = formalMemoryIds.filter(id => {
      const memory = repository.getMemory(id);
      return memory?.kind === 'event' && memory.status === 'active' && !memory.metadata?.eventContinuity;
    });
    if (eventIds.length && normalizedFollowUpTaskTypes.includes(MAINTENANCE_TASK_TYPES.eventContinuity)) queued.push(...enqueueMemoryMaintenanceTasks({ repository, agentId: normalizedAgentId,
      payload: taskPayload({ repository, agentId: normalizedAgentId, batchId, memoryIds: eventIds }),
      taskTypes: [MAINTENANCE_TASK_TYPES.eventContinuity] }));
    const semanticTaskTypes = normalizedFollowUpTaskTypes.filter((taskType) => (
      taskType !== MAINTENANCE_TASK_TYPES.memoryEmbedding && taskType !== MAINTENANCE_TASK_TYPES.eventContinuity
    ));
    if (formalMemoryIds.length && semanticTaskTypes.length) {
      queued.push(...enqueueMemoryMaintenanceTasks({
        repository,
        agentId: normalizedAgentId,
        payload: taskPayload({
          repository,
          agentId: normalizedAgentId,
          batchId,
          memoryIds: formalMemoryIds,
        }),
        taskTypes: semanticTaskTypes,
      }));
    }
  } catch (error) {
    assertEventSourceExecutionCurrent();
    if (requiredFollowUpEnqueue) throw error;
    warnings.push(`Follow-up maintenance enqueue failed: ${error.message}`);
  }
  return {
    status: warnings.length ? "completed-with-warnings" : "completed",
    relationshipMemberships,
    associations,
    consolidationPlan,
    queued: queued.map((task) => ({
      id: task.id,
      lane: task.lane,
      taskType: task.task_type,
      status: task.status,
      wasInserted: task.wasInserted,
    })),
    warnings,
  };
}
