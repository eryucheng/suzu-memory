import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";
import { runImmediateMemoryMaintenance, runSemanticMemoryMaintenance, inspectMaintenance } from "../src/index.mjs";
import { planMemoryConsolidation } from "@suzu-memory/structurer";
import { claimAccumulatedStructureTasks } from "../src/structure-batching.mjs";

function fixture(t, databasePath = ":memory:") {
  const database = openMemoryDatabase(databasePath);
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const calls = [];
  const generator = async request => {
    calls.push(request);
    return { output: request.schemaName === "memory-consolidation-combined-v1"
      ? { structure: { proposals: [] }, relations: { proposals: [] } } : { proposals: [] } };
  };
  generator.supportsCombinedConsolidation = true;
  const run = () => runSemanticMemoryMaintenance({ repository, agentId: "owner", structureGenerator: generator });
  function seed(index, { owner = "owner", world = "primary", content = `第 ${index} 次的完整经历。` } = {}) {
    const memory = repository.upsertMemory({ id: `${owner}-${world}-${index}`, agentId: owner, kind: "event",
      layer: "episodic", content, subjectRole: "agent", subjectKey: owner,
      worldId: world, worldFrame: "physical", eventStart: "2026-09-20T08:00:00.000Z" });
    runImmediateMemoryMaintenance({ repository, agentId: owner, batchId: `batch-${index}-${world}`, memoryIds: [memory.id] });
    return memory;
  }
  return { database, repository, calls, generator, seed, run };
}

test("nineteen memories wait without generation or attempts, the twentieth is grouped once", async t => {
  const f = fixture(t);
  for (let i = 0; i < 19; i += 1) f.seed(i);
  for (let i = 0; i < 3; i += 1) {
    const report = await f.run();
    assert.equal(report.semanticTasks.status, "accumulating");
    assert.equal(report.semanticTasks.pendingMemoryCount, 19);
    assert.equal(f.calls.length, 0);
  }
  assert.ok(f.repository.listMaintenanceTasks("owner", { taskTypes: ["structure-proposal"] }).every(task => task.attempt_count === 0));
  f.seed(19);
  await f.run();
  assert.equal(f.calls.length, 1);
  const snapshot = JSON.parse(f.calls[0].input.split("\n\n").slice(1).join("\n\n"));
  assert.equal(snapshot.currentMemories.length, 20);
  await f.run();
  assert.equal(f.calls.length, 1);
  for (let i = 20; i < 39; i += 1) f.seed(i);
  await f.run();
  assert.equal(f.calls.length, 1);
  f.seed(39);
  await f.run();
  assert.equal(f.calls.length, 2);
});

test('maintenance inspection shares the structure threshold without claiming or modifying tasks', async t => {
  const f = fixture(t);
  for (let index = 0; index < 19; index++) f.seed(index);
  const snapshot = () => JSON.stringify(f.database.prepare('SELECT * FROM memory_maintenance_tasks ORDER BY id').all());
  const before = snapshot();
  const waiting = inspectMaintenance({ repository: f.repository, agentId: 'owner', limit: 1 });
  assert.equal(waiting.tasks.length, 1);
  assert.equal(waiting.structureQueue.accumulatingTaskCount, 19);
  assert.equal(waiting.structureQueue.pendingMemoryCount, 19);
  assert.equal(snapshot(), before);
  const lowerThreshold = inspectMaintenance({ repository: f.repository, agentId: 'owner', limit: 1, minimumStructureMemories: 19 });
  assert.equal(lowerThreshold.structureQueue.accumulatingTaskCount, 0);
  assert.equal(snapshot(), before);
  f.seed(19);
  assert.equal(inspectMaintenance({ repository: f.repository, agentId: 'owner', limit: 1 }).structureQueue.accumulatingTaskCount, 0);
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(inspectMaintenance({ repository: f.repository, agentId: 'owner', limit: 1 }).structureQueue.pendingMemoryCount, 0);
});

test("duplicates, deleted memories and other Agents do not inflate a batch", async t => {
  const f = fixture(t);
  const first = f.seed(0);
  for (let i = 0; i < 125; i += 1) {
    runImmediateMemoryMaintenance({ repository: f.repository, agentId: "owner", batchId: `duplicate-${i}`, memoryIds: [first.id] });
    f.seed(i, { owner: "another-agent" });
  }
  for (let i = 1; i < 19; i += 1) f.seed(i);
  const deleted = f.seed(20);
  f.repository.setMemoryDeleted({ agentId: "owner", memoryId: deleted.id, actor: "test", reason: "removed" });
  await f.run(); // Remove ineligible queue entries without generation.
  await f.run();
  assert.equal(f.calls.length, 0);
  f.seed(21);
  await f.run();
  assert.equal(f.calls.length, 1);
  // A duplicate arriving after successful processing is also discarded by code.
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: "owner", batchId: "late-duplicate", memoryIds: [first.id] });
  await f.run();
  await f.run();
  assert.equal(f.calls.length, 1);
});

test("partial batches survive closing and reopening the database", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "structure-accumulation-"));
  const databasePath = path.join(root, "memory.db");
  const first = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(first);
  for (let i = 0; i < 19; i += 1) {
    const memory = repository.upsertMemory({ id: `owner-primary-${i}`, agentId: "owner", kind: "event",
      layer: "episodic", worldId: "primary", worldFrame: "physical", content: `经历 ${i}`, eventStart: "2026-09-20T08:00:00Z" });
    runImmediateMemoryMaintenance({ repository, agentId: "owner", memoryIds: [memory.id] });
  }
  first.close();
  const f = fixture(t, databasePath);
  await f.run();
  assert.equal(f.calls.length, 0);
  f.seed(19);
  await f.run();
  assert.equal(f.calls.length, 1);
});

test("old single-trigger consolidation plans return to accumulation without bypassing the threshold", async t => {
  const f = fixture(t);
  const first = f.seed(0);
  const second = f.seed(1);
  f.repository.upsertEdge({ agentId: "owner", fromMemoryId: first.id, toMemoryId: second.id,
    relation: "associated_with", weight: 0.9, confidence: 0.9 });
  const plan = planMemoryConsolidation({ repository: f.repository, agentId: "owner", triggerMemoryIds: [first.id] });
  await f.run();
  assert.equal(f.calls.length, 0);
  assert.equal(f.repository.getConsolidationRun("owner", plan.id).status, "cancelled");
  for (let i = 2; i < 20; i += 1) f.seed(i);
  await f.run();
  assert.equal(f.calls.length, 1);
});

test("an accumulated batch uses at most one local call plus one combined old-network call", async t => {
  const f = fixture(t);
  const old = f.repository.upsertMemory({ agentId: "owner", id: "old", kind: "event", layer: "episodic",
    content: "过去一起完成的经历。", worldId: "primary", worldFrame: "physical", eventStart: "2026-09-01T08:00:00Z" });
  const source = f.repository.upsertSource({ agentId: "owner", sourceKind: "conversation", externalId: "causal-source", content: "因为过去那件事，现在我们又一起完成了一次。" });
  f.repository.linkSource(old.id, source.id);
  for (let i = 0; i < 20; i += 1) {
    const memory = f.seed(i);
    f.repository.linkSource(memory.id, source.id);
    if (i === 0) f.repository.upsertEdge({ agentId: "owner", fromMemoryId: memory.id, toMemoryId: old.id,
      relation: "associated_with", weight: 0.9, confidence: 0.9 });
  }
  await f.run();
  assert.deepEqual(f.calls.map(call => call.schemaName), ["memory-structure-proposals-v1", "memory-consolidation-combined-v1"]);
  await f.run();
  assert.equal(f.calls.length, 2);
});

test("twenty memories across two spaces trigger together and organize in separate parts", async t => {
  const f = fixture(t);
  for (let i = 0; i < 10; i += 1) f.seed(i, { world: 'room-a' });
  for (let i = 0; i < 9; i += 1) f.seed(i, { world: 'room-b' });
  await f.run();
  assert.equal(f.calls.length, 0);
  f.seed(9, { world: 'room-b' });
  await f.run();
  assert.equal(f.calls.length, 2);
  const snapshots = f.calls.map(call => JSON.parse(call.input.split('\n\n').slice(1).join('\n\n')));
  assert.deepEqual(snapshots.map(snapshot => snapshot.currentMemories.length), [10, 10]);
  assert.deepEqual(snapshots.map(snapshot => [...new Set(snapshot.currentMemories.map(memory => memory.worldId))]), [['room-a'], ['room-b']]);
  await f.run();
  assert.equal(f.calls.length, 2);
});

test("a failed accumulated batch retries its whole material and does not consume single tasks as empty work", async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i += 1) f.seed(i);
  let attempts = 0;
  const generator = async ({ input }) => {
    const snapshot = JSON.parse(input.split("\n\n").slice(1).join("\n\n"));
    assert.equal(snapshot.currentMemories.length, 20);
    if (++attempts === 1) throw new Error("temporary provider failure");
    return { output: { proposals: [] } };
  };
  const run = () => runSemanticMemoryMaintenance({ repository: f.repository, agentId: "owner", structureGenerator: generator });
  assert.equal((await run()).semanticTasks.tasksRetried, 20);
  f.seed(20);
  assert.equal((await run()).semanticTasks.tasksCompleted, 20);
  assert.equal(attempts, 2);
  const pending = f.repository.listMaintenanceTasks("owner", { taskTypes: ["structure-proposal"], statuses: ["pending"] });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempt_count, 0);
});

test("interrupted batches retain membership before the first provider call", async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i += 1) f.seed(i);
  const claimed = claimAccumulatedStructureTasks({ repository: f.repository, agentId: "owner",
    workerId: "interrupted-worker", minimumMemories: 20 });
  assert.equal(claimed.tasks.length, 20);
  f.repository.recoverRunningMaintenanceTasks("owner", { force: true });
  f.seed(20);
  await f.run();
  const snapshot = JSON.parse(f.calls[0].input.split("\n\n").slice(1).join("\n\n"));
  assert.equal(snapshot.currentMemories.length, 20);
  assert.equal(snapshot.currentMemories.some(memory => memory.id === "owner-primary-20"), false);
});

test("oversized batches split complete memories and retry only unfinished parts", async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i += 1) f.seed(i, { content: `${i}:` + "完整经历".repeat(400) + `尾部-${i}` });
  const calls = [];
  const generator = async request => {
    calls.push(request);
    if (calls.length === 2) throw new Error("temporary second-part failure");
    return { output: { proposals: [] } };
  };
  const run = () => runSemanticMemoryMaintenance({ repository: f.repository, agentId: "owner", structureGenerator: generator });
  assert.equal((await run()).semanticTasks.tasksRetried, 20);
  f.seed(20);
  assert.equal((await run()).semanticTasks.tasksCompleted, 20);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].input, calls[2].input);
  const successful = [calls[0], calls[2]].flatMap(request => JSON.parse(request.input.split("\n\n").slice(1).join("\n\n")).currentMemories);
  assert.equal(new Set(successful.map(memory => memory.id)).size, 20);
  assert.ok(successful.every(memory => memory.content.endsWith(`尾部-${memory.id.split("-").at(-1)}`)));
});

test("an indivisible oversized memory enters review once while other parts complete", async t => {
  const f = fixture(t);
  f.seed(0, { content: "超长原文".repeat(9000) + "保留尾部" });
  for (let i = 1; i < 20; i += 1) f.seed(i);
  const result = await f.run();
  assert.equal(result.semanticTasks.tasksSentToReview, 1);
  assert.equal(result.semanticTasks.tasksCompleted, 19);
  const tasks = f.repository.listMaintenanceTasks("owner", { taskTypes: ["structure-proposal"], statuses: ["failed"] });
  const parts = tasks[0].result.structureBatch.parts;
  assert.equal(parts.filter(part => part.status === "blocked").length, 1);
  assert.equal(parts.filter(part => part.status === "completed").flatMap(part => part.memoryIds).length, 19);
  assert.ok(f.repository.getMemory("owner-primary-0").content.endsWith("保留尾部"));
  const calls = f.calls.length;
  await f.run();
  assert.equal(f.calls.length, calls);
});
