import { randomUUID } from "node:crypto";

import { processPendingStateAnalysisRequests } from "@suzu-memory/analysis";
import {
  resolveReportedStateProposal,
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
} from "@suzu-memory/structurer";

export const MAINTENANCE_LANES = Object.freeze({
  embedding: "embedding",
  semantic: "semantic",
});

export const MAINTENANCE_TASK_TYPES = Object.freeze({
  memoryEmbedding: "memory-embedding",
  retrievalContext: "retrieval-context",
  structureProposal: "structure-proposal",
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
  followUpTaskTypes = Object.values(MAINTENANCE_TASK_TYPES),
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
    warnings.push(`Relationship membership sync failed: ${error.message}`);
  }
  try {
    associations = formalMemoryIds.length ? updateAssociationGraph({
      repository,
      agentId: normalizedAgentId,
      memoryIds: formalMemoryIds,
    }) : associations;
  } catch (error) {
    warnings.push(`Association update failed: ${error.message}`);
  }
  if (planConsolidation && formalMemoryIds.length) {
    try {
      consolidationPlan = planMemoryConsolidation({
        repository,
        agentId: normalizedAgentId,
        triggerMemoryIds: formalMemoryIds,
        metadata: { inputBatchId: clean(batchId) },
      });
    } catch (error) {
      warnings.push(`Consolidation planning failed: ${error.message}`);
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
    const semanticTaskTypes = normalizedFollowUpTaskTypes.filter((taskType) => (
      taskType !== MAINTENANCE_TASK_TYPES.memoryEmbedding
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
  if (!SAFE_AUTOMATIC_REPORTED_STATE_ACTIONS.has(proposal.action)) {
    return { eligible: false, reason: "state-transition-requires-review", proposal };
  }
  if (!["user", "agent"].includes(proposal.subject_role)) {
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
            MAINTENANCE_TASK_TYPES.retrievalContext,
          ],
          planConsolidation: true,
        }),
      });
    } catch (error) {
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

async function processStructureTasks({
  repository,
  agentId,
  tasks,
  workerId,
  generator,
  usageLedgerPath,
}) {
  const completed = [];
  const failed = [];
  const reports = [];
  for (const task of tasks) {
    try {
      const report = await proposeStructuresForBatch({
        repository,
        agentId,
        batchId: clean(task.payload?.batchId),
        memoryIds: uniqueStrings(task.payload?.memoryIds),
        generator,
        usageLedgerPath,
      });
      const provisionalMemoryIds = uniqueStrings((report.proposed || [])
        .map((proposal) => proposal.result_memory_id));
      const queued = provisionalMemoryIds.length
        ? runImmediateMemoryMaintenance({
          repository,
          agentId,
          batchId: `pending-structure:${clean(task.id)}`,
          memoryIds: provisionalMemoryIds,
          followUpTaskTypes: [
            MAINTENANCE_TASK_TYPES.memoryEmbedding,
            MAINTENANCE_TASK_TYPES.retrievalContext,
          ],
          planConsolidation: false,
        })
        : { status: "skipped", reason: "no-new-pending-structures", queued: [] };
      reports.push(report);
      completed.push(repository.finishMaintenanceTask({
        agentId,
        taskId: task.id,
        workerId,
        result: {
          ...structureTaskResult(report),
          queued: queued.queued,
          maintenanceWarnings: queued.warnings,
        },
      }));
    } catch (error) {
      reports.push({ status: "failed", taskId: task.id, error: error.message });
      failed.push(repository.failMaintenanceTask({
        agentId,
        taskId: task.id,
        workerId,
        errorMessage: error.message,
        errorDetails: {
          lane: MAINTENANCE_LANES.semantic,
          taskType: clean(task.task_type),
          memoryIds: uniqueStrings(task.payload?.memoryIds),
          stage: "structure-proposal",
          errorCode: clean(error.code),
          errorName: clean(error.name),
        },
        result: { status: "failed", error: error.message },
      }));
    }
  }
  return { reports, completed, failed };
}

export async function runSemanticTaskMaintenance({
  repository,
  agentId,
  retrievalContextGenerator,
  structureGenerator,
  usageLedgerPath = "",
  maximumTasks = 10,
  workerId = `semantic-${randomUUID()}`,
} = {}) {
  if (!repository) throw new Error("Semantic task maintenance requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Semantic task maintenance requires agentId.");
  const supported = [];
  if (typeof retrievalContextGenerator === "function") {
    supported.push(MAINTENANCE_TASK_TYPES.retrievalContext);
  }
  if (typeof structureGenerator === "function") {
    supported.push(MAINTENANCE_TASK_TYPES.structureProposal);
  }
  if (!supported.length) {
    return { status: "disabled", reason: "semantic-providers-not-configured", selected: 0 };
  }
  const claimed = repository.claimMaintenanceTasks({
    agentId: normalizedAgentId,
    lane: MAINTENANCE_LANES.semantic,
    taskTypes: supported,
    maximumTasks: boundedInteger(maximumTasks, 10, 1, 100, "maximumTasks"),
    workerId,
  });
  if (!claimed.tasks.length) {
    return { status: "empty", selected: 0, workerId: claimed.workerId };
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
      results.retrievalContexts = await processRetrievalContextTasks({
        repository,
        agentId: normalizedAgentId,
        tasks: contexts,
        workerId: claimed.workerId,
        generator: retrievalContextGenerator,
        usageLedgerPath,
      });
    } catch (error) {
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

export async function runSemanticMemoryMaintenance({
  repository,
  agentId,
  generator,
  structureGenerator = generator,
  retrievalContextGenerator = generator,
  usageLedgerPath = "",
  maximumTasks = 10,
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
  const semanticTasks = await runSemanticTaskMaintenance({
    repository,
    agentId: normalizedAgentId,
    retrievalContextGenerator,
    structureGenerator,
    usageLedgerPath,
    maximumTasks,
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
    })
    : { status: "disabled", reason: "structure-provider-not-configured", selected: 0 };
  const hasFailures = [
    semanticTasks.status,
    stateAnalysis.status,
    automaticStateAcceptance.status,
    consolidation.status,
  ].some((status) => ["failed", "partial-failure", "completed-with-failures"].includes(status));
  return {
    status: hasFailures ? "completed-with-failures" : "completed",
    semanticTasks,
    stateAnalysis,
    automaticStateAcceptance,
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
