import assert from "node:assert/strict";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "../src/index.mjs";

const POLICY = Object.freeze({
  enabled: true,
  configurationVersion: "test-recall-reactivation-v2",
  activationGain: 0.025,
  maximumActivation: 0.35,
  scaleDays: 10,
  decayExponent: 0.5,
  maximumScoreAdjustment: 0.03,
});

function readyTrace(repository, id, selectedIds, createdAt) {
  return repository.recordRetrievalTrace({
    id,
    agentId: "agent-test",
    queryText: "还记得科技馆吗",
    resultStatus: "ready",
    selectedIds,
    createdAt,
  });
}

test("reactivates only selected memories with bounded decay and trace idempotence", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "selected-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户去了科技馆。",
  });
  repository.upsertMemory({
    id: "candidate-only-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "这条只进入过候选，没有被注入。",
  });

  const firstTrace = readyTrace(
    repository,
    "trace-reactivation-1",
    ["selected-memory"],
    "2026-08-01T00:00:00.000Z",
  );
  const first = repository.applyRecallReactivation({
    agentId: "agent-test",
    traceId: firstTrace.id,
    activatedAt: "2026-08-01T00:00:00.000Z",
    policy: POLICY,
  });
  assert.equal(first.status, "applied");
  assert.equal(first.applied, 1);
  assert.equal(first.states[0].value, 0.025);
  assert.equal(first.states[0].activation_count, 1);
  assert.equal(
    repository.getMemoryRecallReactivationState("agent-test", "candidate-only-memory"),
    null,
  );

  const replay = repository.applyRecallReactivation({
    agentId: "agent-test",
    traceId: firstTrace.id,
    activatedAt: "2026-08-01T00:00:00.000Z",
    policy: POLICY,
  });
  assert.equal(replay.status, "unchanged");
  assert.equal(replay.applied, 0);
  assert.equal(
    repository.getMemoryRecallReactivationState("agent-test", "selected-memory")
      .activation_count,
    1,
  );

  const secondTrace = readyTrace(
    repository,
    "trace-reactivation-2",
    ["selected-memory"],
    "2026-08-31T00:00:00.000Z",
  );
  repository.applyRecallReactivation({
    agentId: "agent-test",
    traceId: secondTrace.id,
    activatedAt: "2026-08-31T00:00:00.000Z",
    policy: POLICY,
  });
  const state = repository.getMemoryRecallReactivationState(
    "agent-test",
    "selected-memory",
  );
  assert.equal(state.activation_count, 2);
  assert.ok(Math.abs(state.value - 0.03660714285714286) < 1e-12);
  assert.equal(state.last_trace_id, secondTrace.id);
  assert.equal(repository.listMemoryRecallReactivationStates("agent-test").length, 1);
  database.close();
});

test("repeated recall approaches the configured activation ceiling without exceeding it", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "frequently-recalled",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "一段被频繁想起的经历。",
  });

  let previousValue = 0;
  let latestGain = 0;
  for (let index = 0; index < 100; index += 1) {
    const trace = readyTrace(
      repository,
      `trace-ceiling-${index}`,
      ["frequently-recalled"],
      "2026-08-01T00:00:00.000Z",
    );
    const applied = repository.applyRecallReactivation({
      agentId: "agent-test",
      traceId: trace.id,
      activatedAt: "2026-08-01T00:00:00.000Z",
      policy: POLICY,
    });
    const nextValue = applied.states[0].value;
    latestGain = nextValue - previousValue;
    previousValue = nextValue;
  }

  assert.ok(previousValue <= POLICY.maximumActivation);
  assert.ok(previousValue > 0.34);
  assert.ok(latestGain < POLICY.activationGain / 100);
  database.close();
});

test("trace-free activation receipts deduplicate interleaved inputs", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({ id: "selected-memory", agentId: "agent-test", kind: "event", layer: "episodic", content: "一次参观。" });
  const activate = activationId => repository.applyRecallReactivation({ agentId: "agent-test", activationId,
    memoryIds: ["selected-memory"], activatedAt: "2026-08-01T00:00:00.000Z", policy: POLICY });
  assert.equal(activate("input-a").applied, 1);
  assert.equal(activate("input-b").applied, 1);
  assert.equal(activate("input-a").applied, 0);
  assert.equal(repository.getMemoryRecallReactivationState("agent-test", "selected-memory").activation_count, 2);
  assert.equal(repository.getMemoryRecallReactivationState("agent-test", "selected-memory").last_trace_id, null);
  assert.equal(repository.listRetrievalTraces("agent-test").length, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memory_recall_reactivation_receipts").get().n, 2);
  database.close();
});

test("activation and its durable receipt roll back together", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({ id: "selected-memory", agentId: "agent-test", kind: "event", layer: "episodic", content: "一次参观。" });
  database.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON memory_recall_reactivation_receipts BEGIN SELECT RAISE(ABORT, 'controlled receipt failure'); END");
  assert.throws(() => repository.applyRecallReactivation({ agentId: "agent-test", activationId: "input-a",
    memoryIds: ["selected-memory"], policy: POLICY }), /controlled receipt failure/);
  assert.equal(repository.getMemoryRecallReactivationState("agent-test", "selected-memory"), null);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM memory_recall_reactivation_receipts").get().n, 0);
  database.close();
});
