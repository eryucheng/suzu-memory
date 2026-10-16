import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";
import { planMemoryConsolidation, runMemoryConsolidation, memoryBudgetError } from "../src/index.mjs";

test("retrospective budget splits preserve every new/old pair and resume completed parts", async t => {
  const database = openMemoryDatabase(":memory:");
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({ agentId: "owner", sourceKind: "conversation", externalId: "source",
    content: "因为上次遇到这些情况，这次大家一起调整了安排。" });
  for (const prefix of ["new", "old"]) for (let i = 0; i < 4; i += 1) {
    const id = `${prefix}-${i}`;
    repository.upsertMemory({ id, agentId: "owner", kind: "event", layer: "episodic",
      content: `${id}:` + "完整事件".repeat(60) + "尾部", eventStart: "2026-09-20T08:00:00Z" });
    repository.linkSource(id, source.id);
  }
  for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) repository.upsertEdge({ agentId: "owner",
    fromMemoryId: `new-${i}`, toMemoryId: `old-${j}`, relation: "associated_with", weight: 0.9, confidence: 0.9 });
  const plan = planMemoryConsolidation({ repository, agentId: "owner", triggerMemoryIds: [0, 1, 2, 3].map(i => `new-${i}`) });
  const calls = [];
  const succeeded = [];
  const generator = async request => {
    assert.ok(request.input.length <= 8000);
    calls.push(request);
    if (calls.length === 2) throw new Error("transient provider failure");
    succeeded.push(request);
    return { output: { structure: { proposals: [] }, relations: { proposals: [] } } };
  };
  generator.supportsCombinedConsolidation = true;
  generator.assertRequestBudget = request => {
    if (request.input.length > 8000) throw memoryBudgetError("Test complete-request budget exceeded.");
  };
  const run = () => runMemoryConsolidation({ repository, agentId: "owner", runId: plan.id,
    structureGenerator: generator, relationGenerator: generator });
  assert.equal((await run()).status, "retry-pending");
  assert.equal((await run()).status, "no-proposals");
  assert.equal(calls[1].input, calls[2].input);
  assert.equal(new Set(succeeded.map(request => request.input)).size, succeeded.length);
  const pairs = new Set();
  for (const request of succeeded) {
    const structureInput = request.input.split("## structure\n")[1].split("\n\n## relations\n")[0];
    const snapshot = JSON.parse(structureInput.slice(structureInput.indexOf("{")));
    for (const current of snapshot.retrospectiveContext.triggerMemoryIds) {
      for (const old of snapshot.retrospectiveContext.historicalMemoryIds) pairs.add(`${current}:${old}`);
    }
    assert.ok(snapshot.currentMemories.every(memory => memory.content.endsWith("尾部")));
  }
  assert.equal(pairs.size, 16);
});

test("consolidation output exhaustion retains diagnostics and stops automatic retry", async t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({ agentId: 'owner', sourceKind: 'conversation', externalId: 'source', content: '两次相关经历。' });
  for (const id of ['new', 'old']) {
    repository.upsertMemory({ id, agentId: 'owner', kind: 'event', layer: 'episodic', content: id, eventStart: '2026-09-20T08:00:00Z' });
    repository.linkSource(id, source.id);
  }
  repository.upsertEdge({ agentId: 'owner', fromMemoryId: 'new', toMemoryId: 'old', relation: 'associated_with', weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ repository, agentId: 'owner', triggerMemoryIds: ['new'] });
  const diagnostics = { maxOutputTokens: 65536, usage: { outputTokens: 65536 } };
  let calls = 0;
  const generator = async () => { calls++; throw Object.assign(new Error('Output protection reached'), { code: 'MAX_TOKENS', diagnostics }); };
  generator.supportsCombinedConsolidation = true;
  const result = await runMemoryConsolidation({ repository, agentId: 'owner', runId: plan.id, structureGenerator: generator, relationGenerator: generator });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.run.review_state, 'pending');
  assert.equal(result.run.attempt_count, 1);
  assert.equal(result.run.failureHistory[0].details.errorCode, 'MAX_TOKENS');
  assert.deepEqual(result.run.failureHistory[0].details.providerDiagnostics, diagnostics);
});

test("oversized evidence for one new/old pair is preserved and does not retry the model", async t => {
  const database = openMemoryDatabase(":memory:");
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({ agentId: "owner", sourceKind: "conversation", externalId: "large-source",
    content: "完整证据".repeat(13000) + "结尾证据" });
  for (const id of ["new", "old"]) {
    repository.upsertMemory({ id, agentId: "owner", kind: "event", layer: "episodic", content: id,
      eventStart: "2026-09-20T08:00:00Z" });
    repository.linkSource(id, source.id);
  }
  repository.upsertEdge({ agentId: "owner", fromMemoryId: "new", toMemoryId: "old", relation: "associated_with", weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ repository, agentId: "owner", triggerMemoryIds: ["new"] });
  let calls = 0;
  const generator = async () => { calls += 1; return { output: { proposals: [] } }; };
  const result = await runMemoryConsolidation({ repository, agentId: "owner", runId: plan.id,
    structureGenerator: generator, relationGenerator: generator });
  assert.equal(result.status, "failed");
  assert.equal(result.run.review_state, "pending");
  assert.equal(result.run.attempt_count, 1);
  assert.equal(calls, 0);
  assert.ok(repository.getMemoryDetail("owner", "new").sources[0].content.endsWith("结尾证据"));
});
