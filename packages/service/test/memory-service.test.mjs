import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MemoryRepository,
  SCHEMA_VERSION,
  memoryRetrievalContextSourceHash,
  openMemoryDatabase,
  proposeMemoryStructure,
} from "@suzu-memory/core";

import {
  createMemoryService,
  resolveMemoryServicePaths,
} from "../src/index.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-service-"));
}

function seedMemory(service) {
  const database = openMemoryDatabase(service.paths.databasePath);
  try {
    const repository = new MemoryRepository(database);
    repository.upsertMemory({
      id: "event-museum",
      agentId: service.agentId,
      kind: "event",
      layer: "long_term",
      title: "科技馆之行",
      content: "用户上周六去了科技馆，并参观了机器人展。",
      subjectRole: "user",
      subjectKey: "user:test",
      reality: "real",
      evidenceMode: "explicit",
      eventDate: "2026-07-25",
      recordedAt: "2026-07-25T12:00:00.000Z",
      status: "active",
    });
  } finally {
    database.close();
  }
}

function inputEvent(eventId = "service-event-1") {
  return {
    protocolVersion: 1,
    eventId,
    eventType: "conversation.turn",
    occurredAt: "2026-08-04T03:00:00.000Z",
    actor: { role: "user", id: "user", name: "User" },
    content: { text: "这条消息先进入事件日志，再异步整理成记忆。" },
  };
}

function generatedEventCandidate() {
  return {
    kind: "event",
    title: "建立维护流水线",
    content: "用户明确记录了三类长期记忆维护任务。",
    subjectRole: "user",
    subjectName: "User",
    actorRoles: [
      { role: "experiencer", actorRole: "user", actorName: "User", confidence: 1 },
    ],
    canonicalKey: "",
    stateFamily: "not_applicable",
    stateLabel: "",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "historical",
    revisionAction: "add",
    retentionReason: "significant_event",
    eventDate: "2026-08-04",
    eventStart: "2026-08-04T03:00:00.000Z",
    eventEnd: "",
    confidence: 0.95,
    importance: 0.75,
    sourceRefs: ["M0001"],
  };
}

test("service resolves one portable Agent scope and initializes the existing schema", () => {
  const dataRoot = temporaryDirectory();
  const paths = resolveMemoryServicePaths({ dataRoot, agentId: "agent-test" });
  assert.equal(paths.databasePath, path.join(dataRoot, "agents", "agent-test", "memory", "memory.db"));

  const service = createMemoryService({ dataRoot, agentId: "agent-test" });
  const status = service.initialize();
  assert.equal(status.status, "ready");
  assert.equal(status.agentId, "agent-test");
  assert.equal(status.memoryCount, 0);
  assert.equal(status.identityStructure.relationshipLabel, "关系");
  assert.ok(status.identityStructure.userEntityId);
  assert.ok(status.identityStructure.companionEntityId);
  assert.ok(status.identityStructure.relationshipId);
  assert.equal(status.database.schemaVersion, status.database.expectedSchemaVersion);
  const identity = service.withRepository((repository) => ({
    actors: repository.listActorEntityBindings(service.agentId),
    relationships: repository.listRelationships(service.agentId),
  }), { readOnly: true });
  assert.equal(identity.actors.length, 2);
  assert.equal(identity.relationships.length, 1);
  assert.equal(identity.relationships[0].members.length, 2);
});

test("service initializes schema and identity roots only once before ordinary repository reads", () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  const initialize = service.initialize.bind(service);
  let initializeCalls = 0;
  service.initialize = (...args) => {
    initializeCalls += 1;
    return initialize(...args);
  };
  service.listMemories();
  service.listMemories();
  service.listInputEvents();
  assert.equal(initializeCalls, 1);
  service.info();
  assert.equal(initializeCalls, 2);
});

test("service reuses repository editing, deletion, restoration and provenance detail", () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  seedMemory(service);

  assert.equal(service.listMemories().total, 1);
  assert.equal(service.getMemory("event-museum").memory.title, "科技馆之行");
  const edited = service.editMemory("event-museum", { title: "上周六的科技馆" }, {
    reason: "测试人工纠正",
  });
  assert.equal(edited.title, "上周六的科技馆");
  assert.equal(service.getMemory("event-museum").mutations[0].action, "edit");

  assert.equal(service.deleteMemory("event-museum").status, "deleted");
  assert.equal(service.listMemories().total, 0);
  assert.equal(service.restoreMemory("event-museum").status, "active");
  assert.equal(service.listMemories().total, 1);
});

test("service persists the real retriever trace without changing retrieval behavior", async () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  seedMemory(service);

  const result = await service.search("记得我上周六去科技馆吗", {
    now: "2026-07-30T12:00:00.000Z",
    reactivate: true,
  });
  assert.equal(result.status, "ready");
  assert.equal(result.fragments[0].memoryId, "event-museum");
  assert.equal(result.trace.persisted, true);
  assert.ok(result.trace.id);
  assert.equal(result.trace.metadata.naturalDecay.enabled, true);
  assert.equal(
    result.trace.metadata.naturalDecay.configurationVersion,
    "companion-natural-decay-v2",
  );
  assert.equal(result.trace.metadata.naturalDecay.model, "shifted-power-law");
  assert.equal(result.trace.metadata.naturalDecay.equivalentHalfLifeDays, 90);
  assert.equal(result.trace.metadata.plasticity.enabled, false);
  assert.equal(result.trace.metadata.recallReactivation.enabled, true);
  assert.equal(
    result.trace.metadata.recallReactivation.configurationVersion,
    "companion-recall-reactivation-v2",
  );
  assert.equal(result.trace.metadata.recallReactivation.model, "shifted-power-law");
  assert.equal(result.trace.metadata.recallReactivation.equivalentHalfLifeDays, 30);
  assert.equal(result.trace.reactivation.status, "applied");
  assert.equal(result.trace.reactivation.applied, 1);
  const stateAfterFirstRecall = service.withRepository(
    (repository) => repository.getMemoryRecallReactivationState(
      service.agentId,
      "event-museum",
    ),
    { readOnly: true },
  );
  assert.equal(stateAfterFirstRecall.activation_count, 1);

  const recalledAgain = await service.search("记得我上周六去科技馆吗", {
    now: "2026-07-30T13:00:00.000Z",
    reactivate: true,
  });
  assert.ok(recalledAgain.candidates[0].recallReactivation.scoreAdjustment > 0);
  const stateAfterSecondRecall = service.withRepository(
    (repository) => repository.getMemoryRecallReactivationState(
      service.agentId,
      "event-museum",
    ),
    { readOnly: true },
  );
  assert.equal(stateAfterSecondRecall.activation_count, 2);
  assert.equal(service.listRetrievalTraces().length, 2);
});

test("trace persistence and activation can be selected independently", async () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  seedMemory(service);
  const options = { now: "2026-07-30T12:00:00.000Z" };
  await service.search("科技馆", { ...options, persistTrace: false, reactivate: false });
  assert.equal(service.listRetrievalTraces().length, 0);
  const logged = await service.search("科技馆", { ...options, persistTrace: true });
  assert.equal(logged.trace.reactivation.status, "disabled");
  assert.equal(service.listRetrievalTraces().length, 1);
  assert.equal(service.withRepository(repository => repository.getMemoryRecallReactivationState(service.agentId, "event-museum")), null);
  const activated = await service.search("科技馆", { ...options, persistTrace: false, reactivate: true, activationId: "message-a" });
  assert.equal(activated.trace.persisted, false);
  assert.equal(activated.trace.reactivation.applied, 1);
  assert.equal(service.listRetrievalTraces().length, 1);
  const replay = await service.search("科技馆", { ...options, persistTrace: false, reactivate: true, activationId: "message-a" });
  assert.equal(replay.trace.reactivation.applied, 0);
  assert.equal(service.withRepository(repository => repository.getMemoryRecallReactivationState(service.agentId, "event-museum")).activation_count, 1);
  service.reactivateRecall({ activationId: "message-b", memoryIds: ["event-museum"], now: options.now });
  const reopened = createMemoryService({ dataRoot: service.paths.dataRoot, agentId: service.agentId });
  assert.equal(reopened.reactivateRecall({ activationId: "message-a", memoryIds: ["event-museum"], now: options.now }).applied, 0);
  assert.equal(reopened.withRepository(repository => repository.getMemoryRecallReactivationState(service.agentId, "event-museum")).activation_count, 2);
  assert.equal(reopened.reactivateRecall({ activationId: "policy-off", memoryIds: ["event-museum"],
    options: { recallReactivation: { enabled: false } } }).status, "disabled");
  assert.equal(reopened.withRepository(repository => repository.getMemoryRecallReactivationState(service.agentId, "event-museum")).activation_count, 2);
  await assert.rejects(service.search("科技馆", { ...options, persistTrace: false, reactivate: true }), /stable activationId/);
});

test("receipt migration preserves existing activation state", async () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  seedMemory(service);
  const recalled = await service.search("科技馆", { reactivate: true });
  const previous = service.withRepository(repository => repository.getMemoryRecallReactivationState(service.agentId, "event-museum"));
  service.withRepository((_repository, database) => database.exec("DROP TABLE memory_recall_reactivation_receipts; DELETE FROM schema_migrations WHERE version=44"));
  const migrated = createMemoryService({ dataRoot: service.paths.dataRoot, agentId: service.agentId });
  assert.equal(migrated.info().database.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(migrated.withRepository(repository => repository.getMemoryRecallReactivationState(service.agentId, "event-museum")), previous);
  const reapplication = migrated.withRepository(repository => repository.applyRecallReactivation({ agentId: service.agentId,
    traceId: recalled.trace.id, policy: service.defaults.retrieval.recallReactivation }));
  assert.equal(reapplication.applied, 0);
});

test("service scopes explicit worlds end-to-end without breaking unscoped callers", async () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  const database = openMemoryDatabase(service.paths.databasePath);
  try {
    const repository = new MemoryRepository(database);
    for (const value of [
      {
        id: "physical-museum",
        worldId: "daily-life",
        worldFrame: "physical",
        content: "用户在现实中去了科技馆看机器人展。",
      },
      {
        id: "fictional-museum",
        worldId: "novel-city",
        worldFrame: "fictional",
        content: "小说里的角色去了科技馆看机器人展。",
      },
    ]) {
      repository.upsertMemory({
        id: value.id,
        agentId: service.agentId,
        kind: "event",
        layer: "long_term",
        title: "科技馆",
        content: value.content,
        subjectRole: "user",
        subjectKey: "user:test",
        reality: value.worldFrame === "physical" ? "real" : "fictional",
        worldId: value.worldId,
        worldFrame: value.worldFrame,
        evidenceMode: "explicit",
        eventDate: "2026-07-25",
        recordedAt: "2026-07-25T12:00:00.000Z",
        status: "active",
      });
    }
  } finally {
    database.close();
  }

  const ids = (result) => new Set(result.candidates.map((candidate) => candidate.memoryId));
  const scoped = await service.search("科技馆里的机器人展", {
    world: { id: "daily-life", frame: "physical" },
    persistTrace: false,
    options: { maximumCandidates: 10, maximumReturnedCandidates: 10 },
  });
  assert.equal(scoped.status, "ready");
  assert.deepEqual([...ids(scoped)], ["physical-museum"]);

  const crossWorld = await service.search("科技馆里的机器人展", {
    world: { id: "daily-life", frame: "physical" },
    allowCrossWorld: true,
    persistTrace: false,
    options: { maximumCandidates: 10, maximumReturnedCandidates: 10 },
  });
  assert.deepEqual(ids(crossWorld), new Set(["physical-museum", "fictional-museum"]));

  const unscoped = await service.search("科技馆里的机器人展", {
    persistTrace: false,
    options: { maximumCandidates: 10, maximumReturnedCandidates: 10 },
  });
  assert.deepEqual(ids(unscoped), new Set(["physical-museum", "fictional-museum"]));
});

test("service allows an explicit retrieval configuration to disable product natural decay", async () => {
  const service = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "agent-test",
    defaults: { retrieval: { naturalDecay: { enabled: false } } },
  });
  service.initialize();
  seedMemory(service);

  const result = await service.search("记得我上周六去科技馆吗", {
    now: "2026-07-30T12:00:00.000Z",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.trace.metadata.naturalDecay.enabled, false);
});

test("service exposes the existing structured brain snapshot", () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  seedMemory(service);
  const snapshot = service.brainSnapshot({ cachePath: "" });
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.nodes.some((node) => node.id === "event-museum"), true);
  assert.deepEqual(
    snapshot.nodes
      .filter((node) => node.graphNodeType)
      .map((node) => node.id)
      .sort(),
    ["topology:actor:user:user%3Atest", "topology:agent"],
  );
});

test("service exposes a durable full association-graph rebuild", () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  service.withRepository((repository) => {
    for (const [id, eventDate] of [
      ["rebuild-first", "2026-08-01"],
      ["rebuild-second", "2026-08-02"],
    ]) {
      repository.upsertMemory({
        id,
        agentId: service.agentId,
        kind: "event",
        layer: "episodic",
        content: "两条记忆都和科技馆有关。",
        eventDate,
      });
      repository.upsertEmbedding({
        memoryId: id,
        model: "test-embedding",
        vector: [1, 0],
      });
    }
  });
  const rebuilt = service.rebuildAssociationGraph();
  assert.equal(rebuilt.status, "completed");
  assert.equal(rebuilt.associationEdges, 1);
  assert.equal(service.brainSnapshot({ cachePath: "" }).edges.some((edge) => (
    edge.relation === "associated_with"
  )), true);
});

test("service uses pending structural nodes immediately and confirms them after review", async () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  const proposal = service.withRepository((repository) => {
    for (const [id, content] of [
      ["event-museum", "用户去了科技馆。"],
      ["event-dinner", "用户参观后吃了晚饭。"],
    ]) {
      repository.upsertMemory({
        id,
        agentId: service.agentId,
        kind: "event",
        layer: "episodic",
        content,
        subjectRole: "user",
        subjectKey: "user",
      });
    }
    const source = repository.upsertSource({
      agentId: service.agentId,
      sourceKind: "conversation",
      externalId: "source-museum",
      occurredAt: "2026-07-25T09:00:00.000Z",
      speaker: "User",
      content: "我今天去了科技馆，回来以后还去吃了晚饭。",
    });
    repository.linkSource("event-museum", source.id, "verbatim", {
      authority: "subject_firsthand",
      sourceTrust: 0.95,
      evidenceStrength: 1,
      provenance: "service-review-console-test",
    });
    return proposeMemoryStructure(repository, {
      agentId: service.agentId,
      batchId: "service-structure-review",
      kind: "episode",
      title: "科技馆之行",
      content: "科技馆参观和之后的晚饭属于同一次出行。",
      subjectRole: "user",
      subjectKey: "user",
      eventDate: "2026-07-25",
      memberIds: ["event-museum", "event-dinner"],
      confidence: 0.9,
    });
  });

  const pending = service.listHighLevelProposals();
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].type, "structure");
  assert.equal(service.getHighLevelProposal("structure", proposal.id).id, proposal.id);
  const consoleOverview = service.reviewConsoleOverview({ now: "2026-08-05T10:00:00.000Z" });
  assert.equal(consoleOverview.status, "ready");
  assert.equal(consoleOverview.counts.reviews, 1);
  assert.equal(consoleOverview.storage.activeDatabase.status, "valid");
  assert.equal(consoleOverview.storage.backups.status, "missing");
  const consoleDetail = service.getReviewConsoleProposal("structure", proposal.id);
  assert.equal(consoleDetail.writePreview.title, "科技馆之行");
  assert.deepEqual(
    consoleDetail.members.map((item) => item.memory.id),
    ["event-museum", "event-dinner"],
  );
  assert.equal(consoleDetail.evidence[0].content, "我今天去了科技馆，回来以后还去吃了晚饭。");
  assert.equal(consoleDetail.evidence[0].speaker, "User");
  assert.equal(consoleDetail.permissions.canAccept, true);
  assert.equal(consoleDetail.proposal.result_memory_id, proposal.result_memory_id);
  assert.equal(service.getMemory(proposal.result_memory_id).memory.metadata.structureReviewState, "pending");
  assert.ok((await service.search("还记得科技馆和之后的晚饭吗", {
    persistTrace: false,
  })).graph.selectedMemoryIds.includes(proposal.result_memory_id));
  const accepted = service.resolveHighLevelProposal("structure", proposal.id, {
    action: "accept",
    actor: "human:test",
    reason: "同一次出行。",
  });
  assert.equal(accepted.resolution.status, "accepted");
  assert.equal(accepted.resolution.memory.kind, "episode");
  assert.deepEqual(
    accepted.maintenance.queued.map((task) => task.taskType).sort(),
    ["memory-embedding"],
  );
  const recalled = await service.search("还记得科技馆和之后的晚饭吗", {
    persistTrace: false,
  });
  assert.ok(recalled.graph.selectedMemoryIds.includes(accepted.resolution.memory.id));
  assert.equal(service.listHighLevelProposals().total, 0);
  assert.equal(service.listHighLevelProposals({ reviewStates: ["accepted"] }).total, 1);
});

test("service exposes terminal maintenance failures in the human review queue", () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  const task = service.withRepository((repository) => {
    repository.upsertMemory({
      id: "event-maintenance-review",
      agentId: service.agentId,
      kind: "event",
      layer: "direct",
      content: "需要保留的原始事件。",
      subjectRole: "user",
      subjectKey: "user",
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "historical",
    });
    const queued = repository.enqueueMaintenanceTask({
      agentId: service.agentId,
      lane: "semantic",
      taskType: "retrieval-context",
      payload: { memoryIds: ["event-maintenance-review"] },
      maxAttempts: 3,
    });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claimed = repository.claimMaintenanceTasks({
        agentId: service.agentId,
        lane: "semantic",
        workerId: `worker-${attempt}`,
      }).tasks[0];
      repository.failMaintenanceTask({
        agentId: service.agentId,
        taskId: claimed.id,
        workerId: `worker-${attempt}`,
        errorMessage: `critic failure ${attempt}`,
        errorDetails: { stage: "critic", memoryIds: ["event-maintenance-review"] },
        result: {
          policyVersion: "retrieval-context-v1",
          failures: [{
            memoryIds: ["event-maintenance-review"],
            stage: "critic",
            error: `critic failure ${attempt}`,
            sourceHash: memoryRetrievalContextSourceHash(
              repository.getMemory("event-maintenance-review"),
            ),
            candidate: {
              context: "这条记忆用于回答用户要求保留的原始事件。",
              queryTerms: ["保留的原始事件"],
              provider: "fake",
              model: "fake-context-model",
              requestId: `proposal-${attempt}`,
            },
          }],
        },
      });
    }
    return repository.getMaintenanceTask(service.agentId, queued.id);
  });
  assert.equal(task.review_state, "pending");
  const pending = service.listHighLevelProposals({ types: ["maintenance-failure"] });
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].proposal.failureHistory.length, 3);
  const detail = service.getReviewConsoleProposal("maintenance-failure", task.id);
  assert.equal(detail.writePreview.content, "这条记忆用于回答用户要求保留的原始事件。");
  assert.equal(detail.maintenanceFailure.lastError, "critic failure 3");
  assert.equal(detail.maintenanceFailure.history.length, 3);
  assert.deepEqual(detail.members.map((item) => item.memory.id), ["event-maintenance-review"]);
  assert.equal(detail.permissions.canAccept, true);
  const resolution = service.resolveHighLevelProposal("maintenance-failure", task.id, {
    action: "accept",
    actor: "human:test",
    reason: "Provider 已恢复。",
  });
  assert.equal(resolution.maintenance.status, "completed-by-human");
  assert.equal(resolution.resolution.task.status, "completed");
  assert.equal(resolution.resolution.task.attempt_count, 3);
  assert.equal(resolution.resolution.applied.length, 1);
  assert.equal(service.withRepository((repository) => (
    repository.getCurrentMemoryRetrievalContext("event-maintenance-review").context_text
  ), { readOnly: true }), "这条记忆用于回答用户要求保留的原始事件。");
});

test("service exposes quarantined input with its original text for human review", async () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.appendEvent({
    protocolVersion: 1,
    eventId: "quarantined-input-event",
    eventType: "conversation.turn",
    occurredAt: "2026-08-06T02:00:00.000Z",
    actor: { role: "user", id: "user" },
    content: { text: "x".repeat(200) },
  });
  const result = await service.processPendingEvents({ maximumContentCharacters: 10 });
  assert.equal(result.status, "quarantined");
  const pending = service.listHighLevelProposals({ types: ["maintenance-failure"] });
  assert.equal(pending.total, 1);
  const task = pending.items[0].proposal;
  assert.equal(task.task_type, "input-event-quarantine");
  const detail = service.getReviewConsoleProposal("maintenance-failure", task.id);
  assert.equal(detail.writePreview.kind, "input-event-quarantine");
  assert.equal(detail.evidence.length, 1);
  assert.equal(detail.evidence[0].content, "x".repeat(200));
  assert.equal(detail.permissions.canAccept, true);
  const resolution = service.resolveHighLevelProposal("maintenance-failure", task.id, {
    action: "accept",
    actor: "human:test",
    reason: "确认此原始输入需要人工处理。",
  });
  assert.equal(resolution.resolution.task.review_state, "accepted");
  const archived = service.listInputEvents({ statuses: ["archived"] });
  assert.equal(archived.items[0].processing_disposition, "quarantined");
});

test("service exposes exhausted retrospective consolidation without discarding base memories", () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  const run = service.withRepository((repository) => {
    for (const id of ["consolidation-trigger", "consolidation-history"]) {
      repository.upsertMemory({
        id,
        agentId: service.agentId,
        kind: "event",
        layer: "episodic",
        content: `${id} 的原始事件仍应保留。`,
      });
    }
    const created = repository.recordConsolidationRun({
      id: "consolidation-review-run",
      agentId: service.agentId,
      policyVersion: "test-v1",
      triggerIds: ["consolidation-trigger"],
      candidateIds: ["consolidation-history"],
      inputHash: "consolidation-review-input",
      maxAttempts: 1,
    });
    const claimed = repository.claimConsolidationRun({
      agentId: service.agentId,
      runId: created.id,
      workerId: "failed-consolidation-worker",
    });
    return repository.failConsolidationRun({
      agentId: service.agentId,
      runId: claimed.id,
      workerId: "failed-consolidation-worker",
      errorMessage: "retrospective provider failed",
      errorDetails: { stage: "retrospective-consolidation" },
    });
  });
  assert.equal(run.status, "failed");
  assert.equal(run.review_state, "pending");
  const pending = service.listHighLevelProposals({ types: ["maintenance-failure"] });
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].id, run.id);
  const detail = service.getReviewConsoleProposal("maintenance-failure", run.id);
  assert.equal(detail.maintenanceFailure.lastError, "retrospective provider failed");
  assert.equal(detail.maintenanceFailure.history.length, 1);
  assert.deepEqual(
    detail.members.map((item) => item.memory.id).sort(),
    ["consolidation-history", "consolidation-trigger"],
  );
  assert.equal(detail.permissions.canAccept, false);
  assert.equal(detail.permissions.canDismiss, true);
  const resolution = service.resolveHighLevelProposal("maintenance-failure", run.id, {
    action: "dismiss",
    actor: "human:test",
    reason: "基础记忆已保留，本次不继续生成高层关系。",
  });
  assert.equal(resolution.resolution.run.status, "cancelled");
  assert.equal(resolution.resolution.run.review_state, "dismissed");
  assert.ok(service.withRepository((repository) => (
    repository.getMemory("consolidation-trigger")
  ), { readOnly: true }));
});

test("service keeps base evidence, retries enrichment three times, and lets a human decide the existing candidate", async () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  const seeded = service.withRepository((repository) => {
    const source = repository.upsertSource({
      agentId: service.agentId,
      sourceKind: "transcript-message",
      externalId: "state-review-source",
      occurredAt: "2026-08-05T08:00:00.000Z",
      knownAt: "2026-08-05T08:00:00.000Z",
      recordedAt: "2026-08-05T08:01:00.000Z",
      speaker: "User",
      content: "我一直很喜欢解谜游戏，这个可以记住。",
    });
    const evidence = repository.upsertMemory({
      id: "state-review-evidence",
      agentId: service.agentId,
      kind: "utterance",
      layer: "evidence",
      content: source.content,
      subjectRole: "user",
      subjectKey: "user",
      reality: "real",
      evidenceMode: "imported",
      temporalState: "historical",
      knownAt: source.known_at,
      recordedAt: source.recorded_at,
      actorRoles: [{
        role: "speaker",
        actorRole: "user",
        actorKey: "user",
        isPrimary: true,
        confidence: 1,
      }],
    });
    repository.linkSource(evidence.id, source.id, "verbatim", {
      authority: "verbatim_record",
      sourceTrust: 1,
      evidenceStrength: 1,
    });
    const request = repository.recordStateAnalysisRequest({
      agentId: service.agentId,
      batchId: "state-review-batch",
      candidateIndex: 0,
      stateFamily: "preference",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: "user:preference:puzzle-games",
      targetLabel: "解谜游戏",
      representationLayer: "reported",
      evidenceMode: "explicit",
      memoryIds: [evidence.id],
      sourceIds: [source.id],
      metadata: { subjectName: "User" },
    });
    const candidate = {
      kind: "preference",
      title: "对解谜游戏的喜好",
      content: "User 明确表示一直很喜欢解谜游戏。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [{
        role: "preference_holder",
        actorRole: "user",
        actorName: "User",
        confidence: 1,
      }],
      canonicalKey: request.canonical_key,
      stateFamily: "preference",
      stateLabel: "喜欢解谜游戏",
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "current",
      retentionReason: "explicit_preference",
      confidence: 0.95,
      importance: 0.7,
      sourceRefs: [source.external_id],
    };
    repository.recordIngestionDecision({
      agentId: service.agentId,
      batchId: request.batch_id,
      candidateIndex: request.candidate_index,
      decision: "store",
      resultStatus: "analysis_pending",
      candidate,
      sourceRefs: [source.external_id],
      sourceIds: [source.id],
      knownAt: source.known_at,
    });
    repository.bindStateAnalysisTarget({ agentId: service.agentId, requestId: request.id,
      canonicalKey: "state-resolved-puzzle-games" });
    return { evidenceId: evidence.id, requestId: request.id };
  });

  let modelCalls = 0;
  const processing = await service.analyzePendingState({
    maxRequests: 10,
    generator: async () => {
      modelCalls += 1;
      throw new Error("provider unavailable");
    },
  });
  assert.equal(processing.status, "completed");
  assert.equal(processing.automaticRetries, 2);
  assert.equal(processing.sentToReview, 1);
  assert.ok(modelCalls >= 3);
  assert.ok(service.getMemory(seeded.evidenceId));

  const pending = service.listHighLevelProposals({ types: ["ingestion"] });
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].reviewState, "pending");
  const detail = service.getReviewConsoleProposal("ingestion", pending.items[0].id);
  assert.equal(detail.writePreview.content, "User 明确表示一直很喜欢解谜游戏。");
  assert.equal(detail.members[0].memory.layer, "provisional");
  assert.equal(detail.maintenanceFailure.history.length, 3);
  assert.equal(detail.stateAnalysisRequest.id, seeded.requestId);
  assert.equal(detail.writePreview.canonicalKey, "state-resolved-puzzle-games");
  assert.equal(detail.proposal.candidate.canonicalKey, "user:preference:puzzle-games",
    "the original extraction remains available for auditing");

  const callsBeforeHumanDecision = modelCalls;
  const accepted = service.resolveHighLevelProposal("ingestion", pending.items[0].id, {
    action: "accept",
    actor: "human:test",
    reason: "原话足以确认。",
  });
  assert.equal(accepted.resolution.status, "accepted");
  assert.equal(accepted.resolution.memory.layer, "semantic");
  assert.equal(accepted.resolution.memory.canonical_key, detail.writePreview.canonicalKey);
  assert.equal(accepted.resolution.decision.resolvedCandidate.canonicalKey, detail.writePreview.canonicalKey);
  assert.equal(modelCalls, callsBeforeHumanDecision);
  assert.equal(service.listHighLevelProposals({ types: ["ingestion"] }).total, 0);
  assert.equal(service.listHighLevelProposals({
    types: ["ingestion"],
    reviewStates: ["accepted"],
  }).total, 1);
});

test("dismissing an enrichment candidate keeps its original evidence", () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  service.initialize();
  const decision = service.withRepository((repository) => {
    const source = repository.upsertSource({
      agentId: service.agentId,
      sourceKind: "transcript-message",
      externalId: "dismiss-review-source",
      occurredAt: "2026-08-05T09:00:00.000Z",
      speaker: "User",
      content: "这是需要保留的原始证据。",
    });
    const evidence = repository.upsertMemory({
      id: "dismiss-review-evidence",
      agentId: service.agentId,
      kind: "utterance",
      layer: "evidence",
      content: source.content,
      subjectRole: "user",
      subjectKey: "user",
      reality: "real",
      evidenceMode: "imported",
      temporalState: "historical",
    });
    repository.linkSource(evidence.id, source.id, "verbatim", {
      authority: "verbatim_record",
      sourceTrust: 1,
      evidenceStrength: 1,
    });
    const provisional = repository.upsertMemory({
      id: "dismiss-review-provisional",
      agentId: service.agentId,
      kind: "fact",
      layer: "provisional",
      content: "待人工判断的进一步结论。",
      subjectRole: "user",
      subjectKey: "user",
      reality: "real",
      evidenceMode: "inferred",
      representationLayer: "inferred",
      status: "archived",
      metadata: { provisional: true },
    });
    return repository.recordIngestionDecision({
      agentId: service.agentId,
      batchId: "dismiss-review-batch",
      candidateIndex: 0,
      decision: "review",
      resultStatus: "review",
      reasonCodes: ["state-analysis-specialist-fallback"],
      candidate: {
        kind: "fact",
        content: provisional.content,
        subjectRole: "user",
      },
      sourceIds: [source.id],
      provisionalMemoryId: provisional.id,
    });
  });

  const result = service.resolveHighLevelProposal("ingestion", decision.id, {
    action: "dismiss",
    actor: "human:test",
  });
  assert.equal(result.resolution.status, "dismissed");
  assert.ok(service.getMemory("dismiss-review-evidence"));
  assert.equal(service.getMemory("dismiss-review-provisional").memory.status, "archived");
  assert.equal(service.listHighLevelProposals({ types: ["ingestion"] }).total, 0);
});

test("service keeps the repository open until asynchronous existing services finish", async () => {
  const embeddingProvider = async () => ({
    vector: Float32Array.from([1, 0, 0]),
    model: "test-embedding",
    usage: {},
  });
  embeddingProvider.model = "test-embedding";
  embeddingProvider.dimensions = 3;
  const service = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "agent-test",
    providers: { embedding: embeddingProvider },
  });
  service.initialize();
  seedMemory(service);

  const report = await service.syncEmbeddings();
  assert.equal(report.status, "ready");
  assert.equal(report.added, 1);
  assert.equal(service.getMemory("event-museum").memory.id, "event-museum");
});

test("service appends companion events without analysis and processes them later", async () => {
  const service = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "companion-test",
    defaults: { memoryOwner: "Companion", userName: "User" },
  });
  const appended = service.appendEvent(inputEvent());
  assert.equal(appended.inserted, 1);
  assert.equal(service.listInputEvents().total, 1);
  assert.equal(service.listMemories({ statuses: [] }).total, 0);
  const processed = await service.processPendingEvents({
    now: "2026-08-04T03:05:00.000Z",
    memoriesOverride: [],
  });
  assert.equal(processed.status, "processed");
  assert.equal(service.listInputEvents({ statuses: ["archived"] }).total, 1);
  assert.equal(service.listInputBatches()[0].status, "completed");
  assert.equal(service.listMemories({ statuses: [], kinds: ["utterance"] }).total, 1);
});

test("service retries a degraded long-term extraction from retained raw events after human review", async () => {
  const service = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "retry-long-term-extraction",
    defaults: { memoryOwner: "Companion", userName: "User" },
  });
  service.appendEvent(inputEvent("retry-long-term-event"));
  let failedAttempts = 0;
  const failingGenerator = async () => {
    failedAttempts += 1;
    const error = new Error("temporary extraction provider failure");
    error.code = "MEMORY_GENERATION_INVALID_OUTPUT";
    throw error;
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await service.processPendingEvents({
        generator: failingGenerator,
        now: `2026-08-04T03:0${attempt}:00.000Z`,
      });
    } catch (error) {
      assert.match(error.message, /temporary extraction provider failure/u);
    }
  }
  assert.equal(failedAttempts, 3);
  const review = service.listHighLevelProposals({ types: ["maintenance-failure"] }).items[0];
  assert.equal(review.proposal.task_type, "long-term-extraction");
  const detail = service.getReviewConsoleProposal("maintenance-failure", review.id);
  assert.equal(detail.permissions.canRetryLongTermExtraction, true);
  const retried = await service.retryLongTermExtractionFailure(review.id, {
    actor: "human:test",
    reason: "provider recovered",
    now: "2026-08-04T03:10:00.000Z",
    generator: async () => ({ output: { memories: [generatedEventCandidate()] }, usage: {} }),
  });
  assert.equal(retried.status, "retried");
  assert.equal(retried.reviewTask.review_state, "accepted");
  assert.equal(service.listInputEvents({ statuses: ["archived"] }).total, 1);
  assert.equal(service.listMemories({ statuses: [], kinds: ["utterance"] }).total, 1);
  assert.equal(service.listMemories({ statuses: [], kinds: ["event"] }).total, 1);
});

test("service carries configured identities from input through archive into entity-seeded recall", async () => {
  const service = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "identity-e2e",
    defaults: {
      memoryOwner: "Melanie",
      userName: "Caroline",
      primaryUserId: "caroline",
      companionId: "melanie",
    },
  });
  service.appendEvent({
    protocolVersion: 1,
    eventId: "identity-e2e-event",
    eventType: "conversation.turn",
    occurredAt: "2026-08-04T03:00:00.000Z",
    actor: { role: "user", id: "caroline", name: "Caroline" },
    participants: [
      { role: "user", id: "caroline", name: "Caroline" },
      { role: "companion", id: "melanie", name: "Melanie" },
    ],
    world: { id: "relationship", frame: "relational" },
    content: { text: "I attended an important committee meeting after breakfast." },
  });
  await service.processPendingEvents({
    now: "2026-08-04T03:05:00.000Z",
    memoriesOverride: [{
      ...generatedEventCandidate(),
      title: "早餐后的委员会会议",
      content: "She attended an important committee meeting after breakfast.",
      subjectName: "Caroline",
      actorRoles: [
        { role: "experiencer", actorRole: "user", actorName: "Caroline", confidence: 1 },
      ],
    }],
  });

  const identities = service.withRepository((repository) => {
    const user = repository.listActorEntityBindings(service.agentId)
      .find((binding) => binding.actor_role === "user" && binding.actor_key === "caroline");
    assert.ok(user);
    const actorMemoryIds = repository.listActorEntityMemories({
      agentId: service.agentId,
      entityId: user.entity_id,
    }).map((memory) => memory.id);
    return { user, actorMemoryIds };
  }, { readOnly: true });

  const result = await service.search("What did Caroline do after breakfast?", {
    now: "2026-08-05T03:00:00.000Z",
    persistTrace: false,
  });
  assert.equal(result.status, "ready");
  assert.deepEqual(
    {
      matched: result.seedRouting.subjectRouting.query.matched,
      role: result.seedRouting.subjectRouting.query.role,
      key: result.seedRouting.subjectRouting.query.key,
    },
    { matched: true, role: "user", key: "caroline" },
  );
  assert.ok(result.fragments.some((fragment) => identities.actorMemoryIds.includes(fragment.memoryId)));
  const entity = result.matchedEntities.find((item) => item.entityId === identities.user.entity_id);
  assert.ok(entity);
  assert.ok(entity.actorMemoryIds.some((memoryId) => identities.actorMemoryIds.includes(memoryId)));
  assert.ok(result.candidates.some((candidate) => (
    identities.actorMemoryIds.includes(candidate.memoryId) && candidate.entityScore > 0
  )));
});

test("service embeds new memories while structure maintenance accumulates", async () => {
  const schemas = [];
  const generator = async ({ schemaName }) => {
    schemas.push(schemaName);
    if (schemaName === "long-term-memory-extraction-v2") {
      return { output: { memories: [generatedEventCandidate()] }, usage: {} };
    }
    if (schemaName === "memory_retrieval_context_proposal_v1") {
      return {
        output: {
          context: "用户明确记录了长期记忆的三类维护任务。",
          queryTerms: ["三类记忆维护任务"],
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
    throw new Error(`Unexpected schema: ${schemaName}`);
  };
  const embedding = async () => ({
    vector: Float32Array.from([1, 0, 0]),
    model: "test-embedding",
    usage: {},
  });
  embedding.model = "test-embedding";
  embedding.dimensions = 3;
  const service = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "companion-test",
    defaults: { memoryOwner: "Companion", userName: "User" },
    providers: { generator, embedding },
  });
  service.appendEvent(inputEvent("maintenance-event-1"));
  const result = await service.runMaintenance({ lane: "all" });
  assert.equal(result.semantic.inputBatches[0].status, "processed");
  assert.equal(result.semantic.semanticTasks.selected, 0);
  assert.equal(result.semantic.semanticTasks.status, "accumulating");
  assert.equal(result.semantic.semanticTasks.pendingMemoryCount, 1);
  assert.equal(result.embedding.selected, 1);
  assert.equal(result.embedding.report.added, 1);
  assert.equal(result.embedding.report.reused, 1);
  assert.deepEqual(
    new Set(result.embedding.memoryIds.map((memoryId) => service.getMemory(memoryId).memory.kind)),
    new Set(["event", "utterance"]),
  );
  assert.deepEqual(schemas, [
    "long-term-memory-extraction-v2",
  ]);
  const status = service.maintenanceStatus();
  assert.equal(status.pendingInputEvents, 0);
  const pending = status.tasks.filter((task) => task.status === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].task_type, "structure-proposal");
  assert.equal(pending[0].attempt_count, 0);
});

test("a recoverable semantic failure does not prevent the embedding lane from running", async () => {
  const embedding = async () => ({
    vector: Float32Array.from([1, 0, 0]),
    model: "test-embedding",
    usage: {},
  });
  embedding.model = "test-embedding";
  embedding.dimensions = 3;
  const service = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "companion-test",
    providers: {
      generator: async () => {
        throw Object.assign(new Error("temporary generator outage"), { code: "GENERATOR_UNAVAILABLE" });
      },
      embedding,
    },
  });
  service.initialize();
  service.withRepository((repository) => {
    repository.upsertMemory({
      id: "embedding-survives-semantic-failure",
      agentId: service.agentId,
      kind: "event",
      layer: "episodic",
      content: "这个记忆应该仍然进入向量索引。",
    });
    repository.enqueueMaintenanceTask({
      agentId: service.agentId,
      lane: "embedding",
      taskType: "memory-embedding",
      payload: { memoryIds: ["embedding-survives-semantic-failure"] },
    });
  });
  service.appendEvent(inputEvent("semantic-failure-event"));
  const result = await service.runMaintenance({ lane: "all" });
  assert.equal(result.status, "completed-with-failures");
  assert.equal(result.semantic.status, "completed-with-failures");
  assert.equal(result.semantic.inputBatches[0].stage, "input-events");
  assert.equal(result.embedding.selected, 1);
  assert.equal(result.embedding.report.added, 1);
});

test("service creates verified backups and restores them with an automatic safety snapshot", () => {
  const service = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "agent-test",
  });
  service.initialize();
  seedMemory(service);
  const backup = service.backupDatabase({ now: "2026-08-05T04:00:00.000Z" });
  assert.equal(backup.status, "valid");
  assert.equal(backup.agentId, "agent-test");
  assert.ok(fs.existsSync(backup.databasePath));
  assert.ok(fs.existsSync(backup.manifestPath));

  service.editMemory("event-museum", { content: "这是一条恢复前的临时修改。" });
  assert.match(service.getMemory("event-museum").memory.content, /临时修改/u);
  assert.throws(
    () => service.restoreDatabaseBackup(backup.databasePath),
    (error) => error.code === "RESTORE_CONFIRMATION_REQUIRED",
  );
  const restored = service.restoreDatabaseBackup(backup.databasePath, {
    confirmAgentId: "agent-test",
    now: "2026-08-05T04:05:00.000Z",
  });
  assert.equal(restored.status, "restored");
  assert.ok(fs.existsSync(restored.safetyBackup.databasePath));
  assert.equal(
    service.getMemory("event-museum").memory.content,
    "用户上周六去了科技馆，并参观了机器人展。",
  );
});

test("service imports another Agent database by rebinding its scoped records to the target Agent", () => {
  const source = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "agent-source",
    defaults: { companionId: "agent-source", memoryOwner: "旧联系人" },
  });
  source.initialize();
  source.withRepository((repository) => {
    repository.upsertMemory({
      id: "imported-agent-memory",
      agentId: "agent-source",
      kind: "event",
      layer: "long_term",
      title: "复用的旧记忆",
      content: "这是应该导入到新联系人的长期记忆。",
      subjectRole: "agent",
      subjectKey: "agent-source",
      reality: "real",
      evidenceMode: "explicit",
      recordedAt: "2026-08-10T10:00:00.000Z",
      status: "active",
    });
  });

  const target = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "agent-target",
    defaults: { companionId: "agent-target", memoryOwner: "新联系人" },
  });
  target.initialize();
  target.withRepository((repository) => {
    repository.upsertMemory({
      id: "target-memory-to-back-up",
      agentId: "agent-target",
      kind: "event",
      layer: "long_term",
      title: "导入前的记忆",
      content: "这条记忆会被导入前安全备份保留。",
      subjectRole: "user",
      subjectKey: "user",
      reality: "real",
      evidenceMode: "explicit",
      recordedAt: "2026-08-10T11:00:00.000Z",
      status: "active",
    });
  });

  assert.throws(
    () => target.importDatabaseAsAgent(source.paths.databasePath),
    (error) => error.code === "IMPORT_CONFIRMATION_REQUIRED",
  );
  const imported = target.importDatabaseAsAgent(source.paths.databasePath, {
    confirmAgentId: "agent-target",
    now: "2026-08-11T00:00:00.000Z",
  });
  assert.equal(imported.status, "imported");
  assert.deepEqual(imported.source.agentIds, ["agent-source"]);
  assert.deepEqual(imported.imported.agentIds, ["agent-target"]);
  assert.ok(fs.existsSync(imported.safetyBackup.databasePath));

  const rebound = target.withRepository((repository, database) => ({
    memory: repository.getMemory("imported-agent-memory"),
    roles: repository.listMemoryRoles("imported-agent-memory"),
    bindings: repository.listActorEntityBindings("agent-target"),
    relationships: repository.listRelationships("agent-target"),
    indexed: database.prepare("SELECT agent_id FROM memory_fts WHERE memory_id = ?")
      .get("imported-agent-memory"),
    retainedTargetMemory: repository.getMemory("target-memory-to-back-up"),
  }), { readOnly: true });
  assert.equal(rebound.memory.agent_id, "agent-target");
  assert.equal(rebound.memory.subject_key, "agent-target");
  assert.ok(rebound.roles.some((role) => role.actor_key === "agent-target"));
  assert.equal(rebound.roles.some((role) => role.actor_key === "agent-source"), false);
  assert.ok(rebound.bindings.some((binding) => binding.actor_role === "agent" && binding.actor_key === "agent-target"));
  assert.equal(rebound.bindings.some((binding) => binding.actor_key === "agent-source"), false);
  assert.ok(rebound.relationships.some((relationship) => relationship.relationship_key.includes("agent:agent-target")));
  assert.equal(rebound.relationships.some((relationship) => relationship.relationship_key.includes("agent:agent-source")), false);
  assert.equal(rebound.indexed.agent_id, "agent-target");
  assert.equal(rebound.retainedTargetMemory, null);

  assert.deepEqual(source.inspectDatabaseImport(source.paths.databasePath).agentIds, ["agent-source"]);
});

test("service rejects an unscoped database instead of reporting a no-op import", () => {
  const sourceDirectory = temporaryDirectory();
  const sourcePath = path.join(sourceDirectory, "unscoped-memory.db");
  const sourceDatabase = openMemoryDatabase(sourcePath);
  sourceDatabase.close();

  const target = createMemoryService({
    dataRoot: temporaryDirectory(),
    agentId: "agent-target",
  });
  target.initialize();

  assert.throws(
    () => target.importDatabaseAsAgent(sourcePath, { confirmAgentId: "agent-target" }),
    (error) => error.code === "IMPORT_AGENT_SCOPE_MISSING",
  );
});

test("service rejects a backup whose manifest hash no longer matches", () => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "agent-test" });
  const backup = service.backupDatabase({ now: "2026-08-05T04:10:00.000Z" });
  fs.appendFileSync(backup.databasePath, "tampered", "utf8");
  assert.throws(
    () => service.inspectDatabaseBackup(backup.databasePath),
    (error) => error.code === "BACKUP_HASH_MISMATCH",
  );
});
