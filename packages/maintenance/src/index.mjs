import { assertEventSourceExecutionCurrent } from '@suzu-memory/core';
import { randomUUID } from "node:crypto";
import { claimAccumulatedStructureTasks, deferSmallConsolidationRuns,
  DEFAULT_MINIMUM_STRUCTURE_MEMORIES } from "./structure-batching.mjs";
export { DEFAULT_MINIMUM_STRUCTURE_MEMORIES } from "./structure-batching.mjs";

import { processPendingStateAnalysisRequests, prepareEventContinuity, applyEventContinuity } from "@suzu-memory/analysis";
import {
  DIRECT_INGESTION_MEMORY_KINDS,
  resolveReportedStateProposal,
  isRepeatedReportedStateTransition,
  materializePendingReportedStateProposals,
  syncMemoryRelationshipMemberships,
  updateAssociationGraph,
} from "@suzu-memory/core";
import {
  generateMemoryRetrievalContexts,
  syncMemoryEmbeddings,
} from "@suzu-memory/embedding-indexer";
import {
  planMemoryConsolidation,
  processPlannedConsolidationRuns,
  proposeStructuresForBatch,
  prepareStructureGeneration,
  runBudgetedMemoryParts,
  memoryBudgetError,
} from "@suzu-memory/structurer";

export const MAINTENANCE_LANES = Object.freeze({
  embedding: "embedding",
  semantic: "semantic",
});

export const MAINTENANCE_TASK_TYPES = Object.freeze({
  memoryEmbedding: "memory-embedding",
  retrievalContext: "retrieval-context",
  structureProposal: "structure-proposal",
  eventContinuity: "event-continuity",
});

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const parsed = value === undefined || value === null || value === ""
    ? fallback
    : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function taskPayload({ repository, agentId, batchId, memoryIds }) {
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

function enqueueFollowUpTasks({ repository, agentId, payload, taskTypes }) {
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
        queued.push(...enqueueFollowUpTasks({
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
    if (eventIds.length && normalizedFollowUpTaskTypes.includes(MAINTENANCE_TASK_TYPES.eventContinuity)) queued.push(...enqueueFollowUpTasks({ repository, agentId: normalizedAgentId,
      payload: taskPayload({ repository, agentId: normalizedAgentId, batchId, memoryIds: eventIds }),
      taskTypes: [MAINTENANCE_TASK_TYPES.eventContinuity] }));
    const semanticTaskTypes = normalizedFollowUpTaskTypes.filter((taskType) => (
      taskType !== MAINTENANCE_TASK_TYPES.memoryEmbedding && taskType !== MAINTENANCE_TASK_TYPES.eventContinuity
    ));
    if (formalMemoryIds.length && semanticTaskTypes.length) {
      queued.push(...enqueueFollowUpTasks({
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
 * Deterministic gate for the only high-level proposal class that may be
 * accepted without a human: a new or reinforcing state explicitly stated by
 * the same person. It does not use content keywords or model confidence alone.
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
  if (!SAFE_AUTOMATIC_REPORTED_STATE_ACTIONS.has(proposal.action) && !isRepeatedReportedStateTransition(repository, proposal)) {
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
  return {
    eligible: true,
    reason: "explicit-self-report",
    proposal,
    request,
    observation,
  };
}

export function autoAcceptReportedStateProposals({
  repository,
  agentId,
  proposalIds = [],
} = {}) {
  if (!repository) throw new Error("Reported-state auto-acceptance requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Reported-state auto-acceptance requires agentId.");
  const accepted = [];
  const deferred = [];
  for (const proposalId of uniqueStrings(proposalIds)) {
    const assessment = assessReportedStateAutoAcceptance({
      repository,
      agentId: normalizedAgentId,
      proposalId,
    });
    if (!assessment.eligible) {
      deferred.push({ proposalId, reason: assessment.reason });
      continue;
    }
    try {
      const resolution = resolveReportedStateProposal(repository, {
        agentId: normalizedAgentId,
        proposalId,
        action: "accept",
        resolvedBy: "system:auto-explicit-self-report-v1",
        note: "Accepted by deterministic explicit self-report policy v1.",
      });
      const memoryIds = uniqueStrings([
        resolution.memory?.id,
        resolution.previous?.id,
      ]);
      accepted.push({
        proposalId,
        resolution,
        maintenance: runImmediateMemoryMaintenance({
          repository,
          agentId: normalizedAgentId,
          batchId: `auto-reported-state:${proposalId}`,
          memoryIds,
          followUpTaskTypes: [
            MAINTENANCE_TASK_TYPES.memoryEmbedding,
          ],
          planConsolidation: true,
        }),
      });
    } catch (error) {
    assertEventSourceExecutionCurrent();
      deferred.push({
        proposalId,
        reason: "acceptance-revalidation-failed",
        error: error.message,
      });
    }
  }
  return {
    status: accepted.length ? "completed" : "no-eligible-proposals",
    accepted,
    deferred,
  };
}

function taskMemoryIds(tasks) {
  return uniqueStrings(tasks.flatMap((task) => task.payload?.memoryIds || [])).sort();
}

function failedMemoryIds(report) {
  return new Set((report?.failures || []).flatMap((failure) => failure.memoryIds || []).map(clean));
}

function embeddingTaskResult(report) {
  return {
    status: clean(report?.status),
    model: clean(report?.model),
    dimensions: Number(report?.dimensions || 0),
    added: Number(report?.added || 0),
    reused: Number(report?.reused || 0),
    failed: Number(report?.failed || 0),
  };
}

function retrievalContextTaskResult(report) {
  return {
    status: clean(report?.status),
    policyVersion: clean(report?.policyVersion),
    added: Number(report?.added || 0),
    reused: Number(report?.reused || 0),
    skipped: Number(report?.skipped || 0),
    rejected: Number(report?.rejected || 0),
    failed: Number(report?.failed || 0),
  };
}

function structureTaskResult(report) {
  return {
    status: clean(report?.status),
    batchId: clean(report?.batchId),
    proposedIds: (report?.proposed || []).map((item) => clean(item.id)).filter(Boolean),
    provisionalMemoryIds: (report?.proposed || [])
      .map((item) => clean(item.result_memory_id))
      .filter(Boolean),
    duplicateIds: (report?.duplicates || []).map((item) => clean(item.id)).filter(Boolean),
    rejected: Array.isArray(report?.rejected) ? report.rejected.length : 0,
    warnings: Array.isArray(report?.warnings) ? report.warnings.map(clean).filter(Boolean) : [],
  };
}

function normalizedTaskFailures(failures = []) {
  return (Array.isArray(failures) ? failures : []).map((failure) => ({
    memoryIds: uniqueStrings([
      ...(Array.isArray(failure?.memoryIds) ? failure.memoryIds : []),
      failure?.memoryId,
    ]),
    stage: clean(failure?.stage),
    error: clean(failure?.error) || "Unknown maintenance item failure.",
    errorCode: clean(failure?.errorCode),
    errorName: clean(failure?.errorName),
    sourceHash: clean(failure?.sourceHash),
    candidate: failure?.candidate && typeof failure.candidate === "object"
      && !Array.isArray(failure.candidate)
      ? failure.candidate
      : null,
  }));
}

function finishTaskGroup({ repository, agentId, workerId, tasks, result, failures = [] }) {
  const completed = [];
  const failed = [];
  const normalizedFailures = normalizedTaskFailures(failures);
  for (const task of tasks) {
    const taskMemoryIdSet = new Set(uniqueStrings(task.payload?.memoryIds));
    const taskFailures = normalizedFailures.filter((failure) => (
      !failure.memoryIds.length || failure.memoryIds.some((memoryId) => taskMemoryIdSet.has(memoryId))
    ));
    if (taskFailures.length) {
      const exactErrors = uniqueStrings(taskFailures.map((failure) => failure.error));
      failed.push(repository.failMaintenanceTask({
        agentId,
        taskId: task.id,
        workerId,
        errorMessage: exactErrors.join(" | "),
        errorDetails: {
          lane: clean(task.lane),
          taskType: clean(task.task_type),
          failedItems: taskFailures,
        },
        result: {
          ...(result && typeof result === "object" ? result : {}),
          failures: taskFailures,
        },
      }));
    } else {
      completed.push(repository.finishMaintenanceTask({
        agentId,
        taskId: task.id,
        workerId,
        result,
      }));
    }
  }
  return {
    completed,
    failed,
    reviewQueued: failed.filter((task) => (
      task.status === "failed" && task.review_state === "pending"
    )),
  };
}

export async function runEmbeddingMaintenance({
  repository,
  agentId,
  embeddingProvider,
  usageLedgerPath = "",
  maximumTasks = 10,
  batchSize = 10,
  workerId = `embedding-${randomUUID()}`,
} = {}) {
  if (!repository) throw new Error("Embedding maintenance requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Embedding maintenance requires agentId.");
  if (typeof embeddingProvider !== "function") {
    return { status: "disabled", reason: "embedding-provider-not-configured", selected: 0 };
  }
  const claimed = repository.claimMaintenanceTasks({
    agentId: normalizedAgentId,
    lane: MAINTENANCE_LANES.embedding,
    taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding],
    maximumTasks: boundedInteger(maximumTasks, 10, 1, 100, "maximumTasks"),
    workerId,
  });
  if (!claimed.tasks.length) {
    return { status: "empty", selected: 0, workerId: claimed.workerId };
  }
  const memoryIds = taskMemoryIds(claimed.tasks);
  try {
    const report = await syncMemoryEmbeddings({
      repository,
      agentId: normalizedAgentId,
      embeddingProvider,
      ledgerPath: usageLedgerPath,
      memoryIds,
      batchSize: boundedInteger(batchSize, 10, 1, 10, "batchSize"),
    });
    // Keep semantic edges on the same durable task as their vectors. If this
    // step fails, the embedding task is retried; a later retry also refreshes
    // edges for vectors that were already written before the interruption.
    const associations = updateAssociationGraph({
      repository,
      agentId: normalizedAgentId,
      memoryIds,
    });
    const taskResults = finishTaskGroup({
      repository,
      agentId: normalizedAgentId,
      workerId: claimed.workerId,
      tasks: claimed.tasks,
      result: {
        ...embeddingTaskResult(report),
        associations,
      },
      failures: report.failures,
    });
    return {
      status: taskResults.failed.length ? "partial-failure" : "completed",
      selected: claimed.tasks.length,
      memoryIds,
      report,
      associations,
      tasksCompleted: taskResults.completed.length,
      tasksRetried: taskResults.failed.filter((task) => task.status === "pending").length,
      tasksFailed: taskResults.failed.filter((task) => task.status === "failed").length,
      tasksSentToReview: taskResults.reviewQueued.length,
      workerId: claimed.workerId,
    };
  } catch (error) {
    assertEventSourceExecutionCurrent();
    const failed = claimed.tasks.map((task) => repository.failMaintenanceTask({
      agentId: normalizedAgentId,
      taskId: task.id,
      workerId: claimed.workerId,
      errorMessage: error.message,
      errorDetails: {
        lane: MAINTENANCE_LANES.embedding,
        taskType: clean(task.task_type),
        memoryIds: uniqueStrings(task.payload?.memoryIds),
        errorCode: clean(error.code),
        errorName: clean(error.name),
      },
    }));
    return {
      status: "failed",
      selected: claimed.tasks.length,
      error: error.message,
      tasksRetried: failed.filter((task) => task.status === "pending").length,
      tasksFailed: failed.filter((task) => task.status === "failed").length,
      tasksSentToReview: failed.filter((task) => (
        task.status === "failed" && task.review_state === "pending"
      )).length,
      workerId: claimed.workerId,
    };
  }
}

async function processRetrievalContextTasks({
  repository,
  agentId,
  tasks,
  workerId,
  generator,
  usageLedgerPath,
}) {
  const memoryIds = taskMemoryIds(tasks);
  const report = await generateMemoryRetrievalContexts({
    repository,
    agentId,
    proposer: generator,
    critic: generator,
    memoryIds,
    ledgerPath: usageLedgerPath,
  });
  const failures = report.results.filter((item) => item.status === "failed");
  const taskResults = finishTaskGroup({
    repository,
    agentId,
    workerId,
    tasks,
    result: retrievalContextTaskResult(report),
    failures,
  });
  const changedMemoryIds = uniqueStrings(report.results
    .filter((item) => item.status === "added")
    .map((item) => item.memoryId));
  const queuedEmbedding = changedMemoryIds.length
    ? enqueueFollowUpTasks({
      repository,
      agentId,
      payload: taskPayload({
        repository,
        agentId,
        batchId: `retrieval-context:${clean(report.policyVersion)}`,
        memoryIds: changedMemoryIds,
      }),
      taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding],
    })
    : [];
  return { report, queuedEmbedding, ...taskResults };
}

async function processStructureTasks({ repository, agentId, tasks, batch,
  workerId, generator, usageLedgerPath }) {
  const checkpoint = () => repository.transaction(() => {
    for (const task of tasks) repository.checkpointMaintenanceTask({ agentId, taskId: task.id, workerId,
      result: { structureBatch: batch } });
  });
  try {
    await runBudgetedMemoryParts({ parts: batch.parts, checkpoint,
      prepare: part => prepareStructureGeneration({ repository, agentId, batchId: part.id,
        memoryIds: part.memoryIds, generator }),
      execute: async (part, preparedGeneration) => {
        const report = await proposeStructuresForBatch({ repository, agentId, batchId: part.id,
          memoryIds: part.memoryIds, generator, usageLedgerPath, preparedGeneration });
        const provisionalMemoryIds = uniqueStrings([...report.proposed, ...report.duplicates]
          .map(proposal => proposal.result_memory_id));
        const queued = provisionalMemoryIds.length ? runImmediateMemoryMaintenance({
          repository, agentId, batchId: `pending-structure:${part.id}`, memoryIds: provisionalMemoryIds,
          followUpTaskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding], planConsolidation: false,
        }) : { queued: [], warnings: [] };
        return { ...structureTaskResult(report), queued: queued.queued, maintenanceWarnings: queued.warnings };
      },
    });
    const finishedIds = uniqueStrings(batch.parts.filter(part => part.status === "completed").flatMap(part => part.memoryIds));
    if (!batch.consolidationPlanned) {
      const consolidationPlan = finishedIds.length ? planMemoryConsolidation({
        repository, agentId, triggerMemoryIds: finishedIds,
        metadata: { accumulatedStructureBatchId: batch.id },
      }) : null;
      batch.consolidationPlanned = true;
      batch.consolidationRunId = consolidationPlan?.id || "";
      checkpoint();
    }
    if (batch.parts.some(part => part.status === "blocked")) {
      throw memoryBudgetError("One or more complete memory items exceed the organization budget; original material is retained for review.");
    }
    const completed = repository.transaction(() => tasks.map(task => repository.finishMaintenanceTask({
      agentId, taskId: task.id, workerId, result: { status: "completed", structureBatch: batch,
        processedMemoryVersions: batch.memoryVersions, consolidationRunId: batch.consolidationRunId },
    })));
    return { reports: batch.parts.map(part => part.result), completed, failed: [] };
  } catch (error) {
    assertEventSourceExecutionCurrent();
    const blockedIds = error.code === "MEMORY_STRUCTURE_INPUT_TOO_LARGE"
      ? new Set(batch.parts.filter(part => part.status === "blocked").flatMap(part => part.memoryIds)) : null;
    const completed = [];
    const failed = repository.transaction(() => tasks.flatMap(task => {
      if (blockedIds && !(task.payload.memoryIds || []).some(id => blockedIds.has(id))) {
        completed.push(repository.finishMaintenanceTask({ agentId, taskId: task.id, workerId,
          result: { status: "completed", structureBatch: batch,
            processedMemoryVersions: batch.memoryVersions.filter(memory => !blockedIds.has(memory.id)),
            consolidationRunId: batch.consolidationRunId } }));
        return [];
      }
      return [repository.failMaintenanceTask({
      agentId, taskId: task.id, workerId, errorMessage: error.message,
      retry: !["MEMORY_STRUCTURE_INPUT_TOO_LARGE", "MAX_TOKENS"].includes(error.code),
      errorDetails: { lane: "semantic", taskType: "structure-proposal", memoryIds: batch.memoryIds,
        stage: "structure-proposal", errorCode: clean(error.code), errorName: clean(error.name),
        providerDiagnostics: error.diagnostics || {} },
      result: { status: "failed", error: error.message, structureBatch: batch },
      })];
    }));
    return { reports: [{ status: "failed", error: error.message }], completed, failed };
  }
}

export async function runSemanticTaskMaintenance({
  repository,
  agentId,
  retrievalContextGenerator,
  structureGenerator,
  usageLedgerPath = "",
  maximumTasks = 10,
  minimumStructureMemories = DEFAULT_MINIMUM_STRUCTURE_MEMORIES,
  workerId = `semantic-${randomUUID()}`,
} = {}) {
  if (!repository) throw new Error("Semantic task maintenance requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Semantic task maintenance requires agentId.");
  const supported = [];
  if (typeof retrievalContextGenerator === "function" || retrievalContextGenerator === null) {
    supported.push(MAINTENANCE_TASK_TYPES.retrievalContext);
  }
  if (!supported.length && typeof structureGenerator !== "function") {
    return { status: "disabled", reason: "semantic-providers-not-configured", selected: 0 };
  }
  const claimed = supported.length ? repository.claimMaintenanceTasks({
    agentId: normalizedAgentId,
    lane: MAINTENANCE_LANES.semantic,
    taskTypes: supported,
    maximumTasks: boundedInteger(maximumTasks, 10, 1, 100, "maximumTasks"),
    workerId,
  }) : { workerId, tasks: [] };
  const structureBatch = typeof structureGenerator === "function"
    ? claimAccumulatedStructureTasks({ repository, agentId: normalizedAgentId, workerId,
      minimumMemories: boundedInteger(minimumStructureMemories, DEFAULT_MINIMUM_STRUCTURE_MEMORIES, 2, 100, "minimumStructureMemories") })
    : { tasks: [], memoryIds: [], pendingMemoryCount: 0 };
  claimed.tasks.push(...structureBatch.tasks);
  if (!claimed.tasks.length) {
    return { status: structureBatch.pendingMemoryCount ? "accumulating" : "empty", selected: 0,
      pendingMemoryCount: structureBatch.pendingMemoryCount, workerId: claimed.workerId };
  }
  const contexts = claimed.tasks.filter((task) => (
    task.task_type === MAINTENANCE_TASK_TYPES.retrievalContext
  ));
  const structures = claimed.tasks.filter((task) => (
    task.task_type === MAINTENANCE_TASK_TYPES.structureProposal
  ));
  const results = {};
  if (contexts.length) {
    try {
      results.retrievalContexts = retrievalContextGenerator === null ? {
        completed: contexts.map(task => repository.finishMaintenanceTask({
          agentId: normalizedAgentId, taskId: task.id, workerId: claimed.workerId,
          result: { status: 'skipped', reason: 'retrieval-context-generation-disabled' },
        })),
        failed: [],
      } : await processRetrievalContextTasks({
        repository,
        agentId: normalizedAgentId,
        tasks: contexts,
        workerId: claimed.workerId,
        generator: retrievalContextGenerator,
        usageLedgerPath,
      });
    } catch (error) {
    assertEventSourceExecutionCurrent();
      results.retrievalContexts = {
        error: error.message,
        completed: [],
        failed: contexts.map((task) => repository.failMaintenanceTask({
          agentId: normalizedAgentId,
          taskId: task.id,
          workerId: claimed.workerId,
          errorMessage: error.message,
          errorDetails: {
            lane: MAINTENANCE_LANES.semantic,
            taskType: clean(task.task_type),
            memoryIds: uniqueStrings(task.payload?.memoryIds),
            stage: "retrieval-context-batch",
            errorCode: clean(error.code),
            errorName: clean(error.name),
          },
          result: { status: "failed", error: error.message },
        })),
      };
    }
  }
  if (structures.length) {
    results.structures = await processStructureTasks({
      repository,
      agentId: normalizedAgentId,
      tasks: structures,
      batch: structureBatch.batch,
      workerId: claimed.workerId,
      generator: structureGenerator,
      usageLedgerPath,
    });
  }
  const finishedTasks = Object.values(results).flatMap((result) => result.completed || []);
  const failedTasks = Object.values(results).flatMap((result) => result.failed || []);
  return {
    status: failedTasks.length ? "partial-failure" : "completed",
    selected: claimed.tasks.length,
    tasksCompleted: finishedTasks.length,
    tasksRetried: failedTasks.filter((task) => task.status === "pending").length,
    tasksFailed: failedTasks.filter((task) => task.status === "failed").length,
    tasksSentToReview: failedTasks.filter((task) => (
      task.status === "failed" && task.review_state === "pending"
    )).length,
    results,
    workerId: claimed.workerId,
  };
}

export async function runEventContinuityMaintenance({ repository, agentId, generator, embeddingProvider,
  maximumTasks = 10, usageLedgerPath = '' }) {
  if (typeof generator !== 'function' || typeof embeddingProvider !== 'function') {
    return { status: 'disabled', reason: 'event-continuity-provider-not-configured', completed: [], failed: [] };
  }
  const claimed = repository.claimMaintenanceTasks({ agentId, lane: 'semantic',
    taskTypes: [MAINTENANCE_TASK_TYPES.eventContinuity], maximumTasks, workerId: `event-continuity-${randomUUID()}` });
  const completed = [], failed = [];
  for (const task of claimed.tasks) {
    const progress = task.result?.eventContinuityProgress || { parts: [{ id: task.id, memoryIds: task.payload.memoryIds, status: 'pending' }] };
    const checkpoint = () => repository.checkpointMaintenanceTask({ agentId, taskId: task.id, workerId: claimed.workerId,
      result: { eventContinuityProgress: progress } });
    try {
      await runBudgetedMemoryParts({ parts: progress.parts, checkpoint,
        prepare: async part => {
          try { return await prepareEventContinuity({ repository, agentId, memoryIds: part.memoryIds, generator, embeddingProvider, usageLedgerPath }); }
          catch (error) {
            if (error.code === 'MEMORY_STATE_ANALYSIS_INPUT_TOO_LARGE') throw memoryBudgetError(error.message);
            throw error;
          }
        },
        execute: (part, prepared) => applyEventContinuity({ repository, agentId, prepared, generator, usageLedgerPath }),
      });
      if (progress.parts.some(part => part.status === 'blocked')) throw memoryBudgetError('Complete event continuity evidence exceeds the request budget.');
      completed.push(repository.finishMaintenanceTask({ agentId, taskId: task.id, workerId: claimed.workerId,
        result: { eventContinuityProgress: progress } }));
    } catch (error) {
      assertEventSourceExecutionCurrent();
      failed.push(repository.failMaintenanceTask({ agentId, taskId: task.id, workerId: claimed.workerId,
        errorMessage: error.message, retry: !['MAX_TOKENS', 'MEMORY_STRUCTURE_INPUT_TOO_LARGE'].includes(error.code),
          errorDetails: { stage: 'event-continuity', memoryIds: task.payload.memoryIds, errorCode: error.code || '',
            providerDiagnostics: error.diagnostics || {} },
        result: { eventContinuityProgress: progress } }));
    }
  }
  return { status: failed.length ? 'partial-failure' : 'completed', completed, failed };
}

export async function runSemanticMemoryMaintenance({
  repository,
  embeddingProvider,
  agentId,
  generator,
  structureGenerator = generator,
  retrievalContextGenerator = null,
  usageLedgerPath = "",
  maximumTasks = 10,
  minimumStructureMemories = DEFAULT_MINIMUM_STRUCTURE_MEMORIES,
  maximumStateRequests = 10,
  maximumConsolidationRuns = 3,
} = {}) {
  const normalizedAgentId = clean(agentId);
  if (!repository || !normalizedAgentId) {
    throw new Error("Semantic memory maintenance requires repository and agentId.");
  }
  const stateAnalysis = typeof generator === "function"
    ? await processPendingStateAnalysisRequests({
      repository,
      embeddingProvider,
      agentId: normalizedAgentId,
      generator,
      maxRequests: boundedInteger(
        maximumStateRequests,
        10,
        1,
        500,
        "maximumStateRequests",
      ),
      usageLedgerPath,
    })
    : { status: "disabled", reason: "generation-provider-not-configured", selected: 0 };
  const automaticStateAcceptance = stateAnalysis.status === "disabled"
    ? { status: "disabled", reason: stateAnalysis.reason, accepted: [], deferred: [] }
    : autoAcceptReportedStateProposals({
      repository,
      agentId: normalizedAgentId,
      proposalIds: (stateAnalysis.results || [])
        .map((result) => clean(result.proposal?.id))
        .filter(Boolean),
    });
  const pendingStateMaterialization = materializePendingReportedStateProposals(repository, {
    agentId: normalizedAgentId,
  });
  const eventContinuity = await runEventContinuityMaintenance({ repository, agentId: normalizedAgentId,
    generator, embeddingProvider, maximumTasks, usageLedgerPath });
  const pendingStateMemories = repository.listPendingProvisionalMemories(normalizedAgentId, { limit: 5_000 })
    .filter(memory => memory.metadata?.reportedStateProposalId || memory.metadata?.preferenceProposalId);
  for (const memory of pendingStateMemories) {
    runImmediateMemoryMaintenance({
      repository, agentId: normalizedAgentId, batchId: `pending-reported-state:${memory.id}`,
      memoryIds: [memory.id], followUpTaskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding],
      planConsolidation: false,
    });
  }
  if (typeof structureGenerator === "function") deferSmallConsolidationRuns({
    repository, agentId: normalizedAgentId, minimumMemories: minimumStructureMemories,
  });
  const semanticTasks = await runSemanticTaskMaintenance({
    repository,
    agentId: normalizedAgentId,
    retrievalContextGenerator,
    structureGenerator,
    usageLedgerPath,
    maximumTasks,
    minimumStructureMemories,
  });
  const consolidation = typeof structureGenerator === "function"
    ? await processPlannedConsolidationRuns({
      repository,
      agentId: normalizedAgentId,
      generator: structureGenerator,
      maximumRuns: boundedInteger(
        maximumConsolidationRuns,
        3,
        1,
        100,
        "maximumConsolidationRuns",
      ),
      usageLedgerPath,
      minimumTriggerMemories: minimumStructureMemories,
    })
    : { status: "disabled", reason: "structure-provider-not-configured", selected: 0 };
  const hasFailures = [
    semanticTasks.status,
    stateAnalysis.status,
    automaticStateAcceptance.status,
    consolidation.status,
    eventContinuity.status,
  ].some((status) => ["failed", "partial-failure", "completed-with-failures"].includes(status));
  return {
    status: hasFailures || pendingStateMaterialization.failed.length ? "completed-with-failures" : "completed",
    semanticTasks,
    stateAnalysis,
    automaticStateAcceptance,
    pendingStateMaterialization,
    eventContinuity,
    consolidation,
  };
}

export function inspectMaintenance({ repository, agentId, limit = 100 } = {}) {
  if (!repository || !clean(agentId)) {
    throw new Error("Inspecting maintenance requires repository and agentId.");
  }
  const normalizedAgentId = clean(agentId);
  const maximum = boundedInteger(limit, 100, 1, 500, "limit");
  const tasks = repository.listMaintenanceTasks(normalizedAgentId, {
    statuses: ["pending", "running", "failed"],
    limit: maximum,
    order: "asc",
  });
  const runnableTaskCount = Number(repository.database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_maintenance_tasks
    WHERE agent_id = ? AND status IN ('pending', 'running')
  `).get(normalizedAgentId)?.count || 0);
  const summarize = (items) => items.reduce((counts, item) => {
    const key = `${item.lane}:${item.task_type}:${item.status}`;
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
  const stateRequests = repository.listStateAnalysisRequests(normalizedAgentId, {
    statuses: ["pending", "blocked", "failed"],
    limit: maximum,
  });
  const stateRequestCounts = Object.fromEntries(
    ["pending", "blocked", "failed"].map((status) => [
      status,
      stateRequests.filter((request) => request.status === status).length,
    ]),
  );
  const consolidationRuns = repository.listConsolidationRuns(normalizedAgentId, {
    statuses: ["planned", "running", "failed"],
    limit: maximum,
    order: "asc",
  });
  return {
    status: "ready",
    taskCounts: summarize(tasks),
    runnableTaskCount,
    tasks,
    pendingStateAnalysisRequests: stateRequestCounts.pending,
    stateAnalysisRequests: {
      ...stateRequestCounts,
      total: stateRequests.length,
      items: stateRequests,
    },
    consolidationRuns: {
      planned: consolidationRuns.filter((run) => run.status === "planned").length,
      running: consolidationRuns.filter((run) => run.status === "running").length,
      failed: consolidationRuns.filter((run) => run.status === "failed").length,
    },
  };
}
