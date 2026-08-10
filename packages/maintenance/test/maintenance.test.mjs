import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";

import {
  autoAcceptReportedStateProposals,
  inspectMaintenance,
  runEmbeddingMaintenance,
  runImmediateMemoryMaintenance,
  runSemanticMemoryMaintenance,
  runSemanticTaskMaintenance,
} from "../src/index.mjs";

const AGENT_ID = "maintenance-test";

function fixture() {
  const database = openMemoryDatabase(":memory:");
  return { database, repository: new MemoryRepository(database) };
}

function seedMemory(repository, id, content = "这件事") {
  return repository.upsertMemory({
    id,
    agentId: AGENT_ID,
    kind: "event",
    layer: "direct",
    title: "测试事件",
    content,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    worldId: "relationship",
    worldFrame: "relational",
    evidenceMode: "explicit",
    representationLayer: "unspecified",
    stateFamily: "not_applicable",
    statePhase: "not_applicable",
    temporalState: "historical",
    revisionAction: "add",
    eventDate: "2026-08-04",
    eventStart: "2026-08-04T02:00:00.000Z",
  });
}

test("immediate lane performs deterministic work and only queues expensive follow-ups", () => {
  const { database, repository } = fixture();
  seedMemory(repository, "event-1");
  const first = runImmediateMemoryMaintenance({
    repository,
    agentId: AGENT_ID,
    batchId: "batch-1",
    memoryIds: ["event-1"],
  });
  const replay = runImmediateMemoryMaintenance({
    repository,
    agentId: AGENT_ID,
    batchId: "batch-1",
    memoryIds: ["event-1"],
  });
  assert.equal(first.status, "completed");
  assert.equal(first.queued.length, 3);
  assert.equal(first.queued.every((task) => task.wasInserted), true);
  assert.equal(replay.queued.every((task) => !task.wasInserted), true);
  const status = inspectMaintenance({ repository, agentId: AGENT_ID });
  assert.equal(status.tasks.length, 3);
  assert.equal(status.taskCounts["embedding:memory-embedding:pending"], 1);
  assert.equal(status.taskCounts["semantic:retrieval-context:pending"], 1);
  assert.equal(status.taskCounts["semantic:structure-proposal:pending"], 1);
  database.close();
});

test("immediate lane can index evidence without sending it through semantic maintenance", () => {
  const { database, repository } = fixture();
  seedMemory(repository, "event-1");
  repository.upsertMemory({
    id: "utterance-1",
    agentId: AGENT_ID,
    kind: "utterance",
    layer: "evidence",
    content: "我们今天去了科技馆。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    worldId: "relationship",
    worldFrame: "relational",
    evidenceMode: "imported",
    temporalState: "historical",
    eventStart: "2026-08-04T02:00:00.000Z",
  });

  runImmediateMemoryMaintenance({
    repository,
    agentId: AGENT_ID,
    batchId: "batch-evidence",
    memoryIds: ["event-1"],
    embeddingMemoryIds: ["event-1", "utterance-1"],
  });

  const tasks = repository.listMaintenanceTasks(AGENT_ID, { statuses: ["pending"] });
  const embedding = tasks.find((task) => task.task_type === "memory-embedding");
  const semantic = tasks.filter((task) => task.lane === "semantic");
  assert.deepEqual(embedding.payload.memoryIds, ["event-1", "utterance-1"]);
  assert.equal(semantic.length, 2);
  assert.equal(semantic.every((task) => (
    JSON.stringify(task.payload.memoryIds) === JSON.stringify(["event-1"])
  )), true);
  database.close();
});

test("embedding lane combines queued memory ids and reuses completed vectors", async () => {
  const { database, repository } = fixture();
  seedMemory(repository, "event-1", "第一件测试事件");
  seedMemory(repository, "event-2", "第二件测试事件");
  runImmediateMemoryMaintenance({
    repository,
    agentId: AGENT_ID,
    batchId: "batch-1",
    memoryIds: ["event-1"],
  });
  runImmediateMemoryMaintenance({
    repository,
    agentId: AGENT_ID,
    batchId: "batch-2",
    memoryIds: ["event-2"],
  });
  const associationCount = () => Number(database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_edges
    WHERE provenance = 'association-builder-v1' AND relation = 'associated_with'
  `).get().count);
  assert.equal(associationCount(), 0);
  const calls = [];
  const provider = async () => {
    throw new Error("single embedding path should not be used");
  };
  provider.model = "test-embedding";
  provider.dimensions = 3;
  provider.embedMany = async (texts) => {
    calls.push(texts);
    return {
      vectors: texts.map((_, index) => Float32Array.from([1, index + 1, 1])),
      model: "test-embedding",
      usage: {},
    };
  };
  const result = await runEmbeddingMaintenance({
    repository,
    agentId: AGENT_ID,
    embeddingProvider: provider,
    maximumTasks: 10,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.selected, 2);
  assert.equal(result.report.added, 2);
  assert.equal(result.associations.status, "completed");
  assert.equal(result.associations.associationEdges, 1);
  assert.equal(associationCount(), 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 2);
  assert.equal(repository.listMaintenanceTasks(AGENT_ID, {
    lanes: ["embedding"],
    statuses: ["completed"],
  }).length, 2);
  assert.equal((await runEmbeddingMaintenance({
    repository,
    agentId: AGENT_ID,
    embeddingProvider: provider,
  })).status, "empty");
  database.close();
});

test("semantic lane keeps retrieval context and structure prompts separate", async () => {
  const { database, repository } = fixture();
  seedMemory(repository, "event-1", "后来呢");
  runImmediateMemoryMaintenance({
    repository,
    agentId: AGENT_ID,
    batchId: "batch-1",
    memoryIds: ["event-1"],
  });
  const schemaNames = [];
  const generator = async ({ schemaName }) => {
    schemaNames.push(schemaName);
    if (schemaName === "memory_retrieval_context_proposal_v1") {
      return {
        output: {
          context: "用户在关系世界中追问前一件测试事件后来发生了什么。",
          queryTerms: ["后来发生了什么", "测试事件后续"],
        },
        usage: {},
      };
    }
    if (schemaName === "memory_retrieval_context_critic_v1") {
      return { output: { approved: true, issues: [] }, usage: {} };
    }
    if (schemaName === "memory-structure-proposals-v1") {
      return { output: { proposals: [] }, usage: {} };
    }
    throw new Error(`unexpected schema ${schemaName}`);
  };
  const result = await runSemanticTaskMaintenance({
    repository,
    agentId: AGENT_ID,
    retrievalContextGenerator: generator,
    structureGenerator: generator,
    maximumTasks: 10,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.selected, 2);
  assert.deepEqual(schemaNames, [
    "memory_retrieval_context_proposal_v1",
    "memory_retrieval_context_critic_v1",
    "memory-structure-proposals-v1",
  ]);
  assert.ok(repository.getCurrentMemoryRetrievalContext("event-1"));
  assert.equal(repository.listMaintenanceTasks(AGENT_ID, {
    lanes: ["semantic"],
    statuses: ["completed"],
  }).length, 2);
  const embeddingTasks = repository.listMaintenanceTasks(AGENT_ID, {
    lanes: ["embedding"],
    statuses: ["pending"],
  });
  assert.equal(embeddingTasks.length, 2);
  assert.equal(
    embeddingTasks.some((task) => task.payload.retrievalContextVersions
      .some((version) => Boolean(version.contextId))),
    true,
  );
  database.close();
});

test("semantic failures retry three times, preserve partial success, and enter human review", async () => {
  const { database, repository } = fixture();
  seedMemory(repository, "event-good", "第一件需要检索上下文的短事件");
  seedMemory(repository, "event-failing", "第二件会在审查阶段失败的短事件");
  runImmediateMemoryMaintenance({
    repository,
    agentId: AGENT_ID,
    batchId: "batch-partial-failure",
    memoryIds: ["event-good", "event-failing"],
  });
  const generator = async ({ input, schemaName }) => {
    const parsed = JSON.parse(input);
    if (schemaName === "memory_retrieval_context_proposal_v1") {
      return {
        output: {
          context: `检索说明：${parsed.source.content}`,
          queryTerms: [parsed.source.content],
        },
        usage: {},
      };
    }
    if (schemaName === "memory_retrieval_context_critic_v1") {
      if (String(parsed.source.content).includes("第二件")) {
        const error = new Error("critic provider timed out");
        error.code = "UPSTREAM_TIMEOUT";
        throw error;
      }
      return { output: { approved: true, issues: [] }, usage: {} };
    }
    throw new Error(`unexpected schema ${schemaName}`);
  };

  const reports = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    reports.push(await runSemanticTaskMaintenance({
      repository,
      agentId: AGENT_ID,
      retrievalContextGenerator: generator,
      structureGenerator: null,
      maximumTasks: 10,
    }));
  }
  assert.ok(repository.getCurrentMemoryRetrievalContext("event-good"));
  assert.equal(repository.getCurrentMemoryRetrievalContext("event-failing"), null);
  assert.equal(repository.getMemory("event-good").status, "active");
  assert.equal(repository.getMemory("event-failing").status, "active");
  const failedTask = repository.listMaintenanceTasks(AGENT_ID, {
    taskTypes: ["retrieval-context"],
    statuses: ["failed"],
  })[0];
  assert.equal(failedTask.review_state, "pending");
  assert.equal(failedTask.attempt_count, 3);
  assert.equal(failedTask.failureHistory.length, 3);
  assert.equal(failedTask.failureHistory.every((item) => (
    item.error === "critic provider timed out"
    && item.details.failedItems[0].stage === "critic"
    && item.details.failedItems[0].errorCode === "UPSTREAM_TIMEOUT"
  )), true);
  assert.deepEqual(failedTask.result.failures[0].memoryIds, ["event-failing"]);
  assert.equal(reports[0].tasksRetried, 1);
  assert.equal(reports[1].tasksRetried, 1);
  assert.equal(reports[2].tasksSentToReview, 1);
  database.close();
});

test("expired leases can be reclaimed and failures stay bounded", () => {
  const { database, repository } = fixture();
  const task = repository.enqueueMaintenanceTask({
    agentId: AGENT_ID,
    lane: "embedding",
    taskType: "memory-embedding",
    payload: { memoryIds: ["event-1"] },
    maxAttempts: 2,
    availableAt: "2026-08-04T00:00:00.000Z",
  });
  const first = repository.claimMaintenanceTasks({
    agentId: AGENT_ID,
    lane: "embedding",
    workerId: "worker-1",
    leaseSeconds: 30,
    claimedAt: "2026-08-04T01:00:00.000Z",
  });
  assert.equal(first.tasks[0].id, task.id);
  const reclaimed = repository.claimMaintenanceTasks({
    agentId: AGENT_ID,
    lane: "embedding",
    workerId: "worker-2",
    claimedAt: "2026-08-04T01:01:00.000Z",
  });
  assert.equal(reclaimed.tasks[0].attempt_count, 2);
  const failed = repository.failMaintenanceTask({
    agentId: AGENT_ID,
    taskId: task.id,
    workerId: "worker-2",
    errorMessage: "provider failed",
    failedAt: "2026-08-04T01:01:01.000Z",
  });
  assert.equal(failed.status, "failed");
  assert.equal(failed.review_state, "pending");
  assert.equal(failed.failureHistory.length, 1);
  assert.equal(failed.failureHistory[0].attempt, 2);
  assert.equal(failed.failureHistory[0].error, "provider failed");
  assert.equal(repository.claimMaintenanceTasks({
    agentId: AGENT_ID,
    lane: "embedding",
    workerId: "worker-3",
    claimedAt: "2026-08-04T02:00:00.000Z",
  }).tasks.length, 0);
  const accepted = repository.reviewMaintenanceTaskFailure({
    agentId: AGENT_ID,
    taskId: task.id,
    action: "accept",
    reviewedBy: "human:test",
    note: "修好 Provider 后重试。",
    reviewedAt: "2026-08-04T02:01:00.000Z",
  });
  assert.equal(accepted.status, "completed");
  assert.equal(accepted.review_state, "accepted");
  assert.equal(accepted.attempt_count, 2);
  assert.equal(repository.claimMaintenanceTasks({
    agentId: AGENT_ID,
    lane: "embedding",
    workerId: "worker-4",
    claimedAt: "2026-08-04T02:02:00.000Z",
  }).tasks.length, 0);
  database.close();
});

test("semantic maintenance auto-accepts only a request-bound explicit self report", async () => {
  const { database, repository } = fixture();
  const source = repository.upsertSource({
    agentId: AGENT_ID,
    sourceKind: "transcript-message",
    externalId: "explicit-preference-source",
    occurredAt: "2026-08-04T08:00:00.000Z",
    speaker: "User",
    content: "我一直很喜欢解谜游戏。",
  });
  const utterance = repository.upsertMemory({
    id: "explicit-preference-utterance",
    agentId: AGENT_ID,
    kind: "utterance",
    layer: "evidence",
    content: "我一直很喜欢解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    evidenceMode: "explicit",
    temporalState: "historical",
    knownAt: "2026-08-04T08:00:00.000Z",
    actorRoles: [{
      role: "speaker",
      actorRole: "user",
      actorKey: "user",
      isPrimary: true,
      confidence: 1,
    }],
  });
  repository.linkSource(utterance.id, source.id, "verbatim", {
    authority: "subject_firsthand",
    sourceTrust: 1,
    evidenceStrength: 1,
  });
  repository.recordStateAnalysisRequest({
    agentId: AGENT_ID,
    batchId: "explicit-state-batch",
    candidateIndex: 0,
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    targetLabel: "解谜游戏",
    representationLayer: "reported",
    evidenceMode: "explicit",
    memoryIds: [utterance.id],
    sourceIds: [source.id],
  });
  const generator = async ({ analyzerRole }) => {
    const common = {
      memoryId: utterance.id,
      sourceIds: [source.id],
      confidence: 0.98,
      rationale: "原话直接支持。",
    };
    const outputs = {
      "object-grounding": {
        analyses: [{ ...common, targetMatch: "exact", matchedLabel: "解谜游戏" }],
      },
      "explicit-expression": {
        analyses: [{ ...common, expressionType: "likes", directness: "explicit_self_statement" }],
      },
      "behavior-conditions": { analyses: [] },
      "sharing-affect": { analyses: [] },
      "time-scope": {
        analyses: [{
          ...common,
          stateTime: "current",
          occurrencePattern: "repeated",
          scopeKind: "category",
          scopeLabel: "解谜游戏",
          contextLabel: "",
          revisionCue: "none",
        }],
      },
    };
    return { output: outputs[analyzerRole], model: `test-${analyzerRole}`, usage: {} };
  };

  const result = await runSemanticMemoryMaintenance({
    repository,
    agentId: AGENT_ID,
    generator,
    structureGenerator: null,
    retrievalContextGenerator: null,
  });
  assert.equal(result.stateAnalysis.results[0].status, "proposal-pending");
  assert.equal(result.automaticStateAcceptance.accepted.length, 1);
  assert.equal(result.automaticStateAcceptance.deferred.length, 0);
  const state = repository.listMemories(AGENT_ID, { kinds: ["preference"] });
  assert.equal(state.total, 1);
  assert.equal(state.items[0].representation_layer, "reported");
  assert.equal(repository.listReportedStateProposals(AGENT_ID, {
    reviewStates: ["pending"],
  }).length, 0);
  assert.deepEqual(
    repository.listMaintenanceTasks(AGENT_ID, { statuses: ["pending"] })
      .map((task) => task.task_type).sort(),
    ["memory-embedding", "retrieval-context"],
  );

  const reviewed = result.stateAnalysis.results[0].proposal;
  const transition = repository.recordReportedStateProposal({
    agentId: AGENT_ID,
    batchId: "explicit-transition-batch",
    stateFamily: reviewed.state_family,
    subjectRole: reviewed.subject_role,
    subjectKey: reviewed.subject_key,
    canonicalKey: reviewed.canonical_key,
    action: "supersede",
    previousMemoryId: state.items[0].id,
    proposedState: reviewed.draft,
    reviewVersion: reviewed.review_version,
    inputHash: "explicit-transition-review-input",
    selectedObservationId: reviewed.selectedObservationId,
    consideredObservationIds: reviewed.consideredObservationIds,
    metadata: { stateAnalysisRequestId: reviewed.metadata.stateAnalysisRequestId },
  });
  const deferred = autoAcceptReportedStateProposals({
    repository,
    agentId: AGENT_ID,
    proposalIds: [transition.id],
  });
  assert.equal(deferred.accepted.length, 0);
  assert.equal(deferred.deferred[0].reason, "state-transition-requires-review");
  assert.equal(repository.getReportedStateProposal(AGENT_ID, transition.id).review_state, "pending");
  database.close();
});
