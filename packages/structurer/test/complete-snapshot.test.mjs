import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";
import {
  buildStructureSnapshot, buildRelationSnapshot, proposeStructuresForBatch,
  proposeRelationsForBatch, planMemoryConsolidation, runMemoryConsolidation,
} from "../src/index.mjs";

function fixture(t, { count = 2, content = "一次看展经历。", sourceContent = "原始来源。", sources = 1 } = {}) {
  const database = openMemoryDatabase(":memory:");
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const memoryIds = [];
  for (let i = 0; i < count; i += 1) {
    const memory = repository.upsertMemory({
      id: `event-${i}`, agentId: "agent-test", kind: "event", layer: "episodic",
      title: "完整经历的标题。".repeat(25), content, subjectRole: "agent", subjectKey: "agent-test",
      eventStart: "2026-09-20T08:00:00.000Z",
    });
    memoryIds.push(memory.id);
    for (let j = 0; j < sources; j += 1) {
      const source = repository.upsertSource({
        agentId: "agent-test", sourceKind: "conversation", externalId: `${i}-${j}`, content: sourceContent,
      });
      repository.linkSource(memory.id, source.id, "evidence");
    }
  }
  return { repository, agentId: "agent-test", memoryIds };
}

test("structure generation receives full memories, titles and existing container content", async (t) => {
  const content = "事情的完整经过。".repeat(500) + "最后确认：那次展览已经取消。";
  const args = fixture(t, { content });
  const previous = "过去的相关经历。".repeat(500) + "限定：只涉及九月份的活动。";
  const topic = args.repository.upsertTopic({ agentId: args.agentId, title: "展览", content: previous });
  let received;
  await proposeStructuresForBatch({ ...args, nearbyContainerIds: [topic.id], generator: async ({ input }) => {
    received = JSON.parse(input.slice(input.indexOf("{")));
    return { output: { proposals: [] } };
  } });
  assert.equal(received.currentMemories[0].content, content);
  assert.equal(received.currentMemories[0].title, "完整经历的标题。".repeat(25));
  assert.equal(received.candidateContainers[0].content, previous);
  assert.throws(() => buildStructureSnapshot({ ...args, maxContentChars: 700 }), /complete 700-character budget/);
  assert.throws(() => buildStructureSnapshot({ ...args, maxSnapshotChars: 4000 }), /4000-character privacy budget/);
});

test("relation generation receives complete evidence including its final causal correction", async (t) => {
  const content = "经过和背景。".repeat(500) + "我们最后取消了活动。";
  const sourceContent = "当时讨论了很多。".repeat(1300) + "不是因为下雨，是因为场馆临时闭馆才取消。";
  const args = fixture(t, { content, sourceContent });
  let received;
  await proposeRelationsForBatch({ ...args, generator: async ({ input }) => {
    received = JSON.parse(input.slice(input.indexOf("{")));
    return { output: { proposals: [] } };
  } });
  assert.equal(received.memories[0].content, content);
  assert.equal(received.sourceRecords[0].content, sourceContent);
  assert.throws(() => buildRelationSnapshot({ ...args, maxMemoryContentChars: 600 }), /complete 600-character budget/);
  assert.throws(() => buildRelationSnapshot({ ...args, maxSourceContentChars: 900 }), /complete 900-character budget/);
  assert.throws(() => buildRelationSnapshot({ ...args, maxSnapshotChars: 4000 }), /4000-character privacy budget/);
});

test('organization snapshots suppress synthetic source dates while retaining explicit event dates', t => {
  const args = fixture(t);
  const sourceReads = [], listSources = args.repository.listMemorySources.bind(args.repository);
  args.repository.listMemorySources = id => { sourceReads.push(id); return listSources(id); };
  for (const id of args.memoryIds) {
    args.repository.database.prepare('UPDATE memory_nodes SET event_start=?, known_at=?, metadata_json=? WHERE id=?')
      .run('2000-01-02T12:00:00Z', '2000-01-02T12:00:00Z', JSON.stringify({ sourceTimeKnown: false }), id);
    for (const source of args.repository.listMemorySources(id)) args.repository.database.prepare(
      'UPDATE source_records SET occurred_at=?, known_at=?, metadata_json=? WHERE id=?')
      .run('2000-01-02T12:00:00Z', '2000-01-02T12:00:00Z', JSON.stringify({ sourceTimeKnown: false }), source.id);
  }
  sourceReads.length = 0;
  const structure = buildStructureSnapshot(args);
  assert.deepEqual(sourceReads, args.memoryIds);
  sourceReads.length = 0;
  const relation = buildRelationSnapshot(args);
  assert.deepEqual(sourceReads, args.memoryIds);
  assert.doesNotMatch(JSON.stringify(structure), /2000-01-02/);
  assert.doesNotMatch(JSON.stringify(relation), /2000-01-02/);
  assert.equal(structure.currentMemories[0].sourceTimeKnown, false);
  args.repository.database.prepare('UPDATE memory_nodes SET event_date=?, event_start=NULL, metadata_json=? WHERE id=?')
    .run('2025-12-25', '{}', args.memoryIds[0]);
  const dated = buildStructureSnapshot(args).currentMemories.find(memory => memory.id === args.memoryIds[0]);
  assert.equal(dated.eventDate, '2025-12-25');
  assert.equal(dated.knownAt, null);
});

test("selected memory and container member lists are complete or explicitly rejected", (t) => {
  const args = fixture(t, { count: 41, sources: 0 });
  const topic = args.repository.upsertTopic({ agentId: args.agentId, title: "看展", content: "多次看展的经历。" });
  for (const memoryId of args.memoryIds) args.repository.linkMemoryToTopic({ agentId: args.agentId, memoryId, topicId: topic.id });
  const structure = buildStructureSnapshot({ ...args, nearbyContainerIds: [topic.id], maxSnapshotChars: 100_000 });
  assert.equal(structure.currentMemories.length, 41);
  assert.equal(structure.candidateContainers[0].memberIds.length, 41);
  assert.equal(structure.candidateContainers[0].memberIdsTruncated, false);
  assert.throws(() => buildStructureSnapshot({ ...args, maxMemories: 40 }), /complete 40-memory budget/);
  assert.throws(() => buildStructureSnapshot({ ...args, maxMemberIdsPerContainer: 30 }), /complete 30-member budget/);
  assert.equal(buildRelationSnapshot({ ...args, maxSnapshotChars: 100_000 }).memories.length, 41);
  assert.throws(() => buildRelationSnapshot({ ...args, maxMemories: 32 }), /complete 32-memory budget/);
});

test("all selected sources are retained and aggregate excess stops before generation", async (t) => {
  const args = fixture(t, { sources: 7 });
  const snapshot = buildRelationSnapshot(args);
  assert.equal(snapshot.sourceRecords.length, 14);
  assert.equal(snapshot.memories[0].sourceIds.length, 7);
  assert.equal(snapshot.memories[0].sourcesTruncated, false);
  assert.throws(() => buildRelationSnapshot({ ...args, maxSourcesPerMemory: 6 }), /complete 6-source budget/);
  let calls = 0;
  const large = fixture(t, { content: "长材料".repeat(20_000) });
  const generator = async () => { calls += 1; return { output: { proposals: [] } }; };
  await assert.rejects(proposeStructuresForBatch({ ...large, generator }), /32000-character privacy budget/);
  await assert.rejects(proposeRelationsForBatch({ ...large, generator }), /48000-character privacy budget/);
  assert.equal(calls, 0);
});

test("generation gates distinguish single-memory structure, source-backed relations and retrospective candidates", async (t) => {
  const args = fixture(t);
  const calls = [];
  const generator = async request => {
    calls.push(request.schemaName);
    return { output: request.schemaName === "memory-consolidation-combined-v1"
      ? { structure: { proposals: [] }, relations: { proposals: [] } } : { proposals: [] } };
  };
  generator.supportsCombinedConsolidation = true;
  await proposeStructuresForBatch({ ...args, memoryIds: [], generator });
  assert.equal(calls.length, 0);
  await proposeStructuresForBatch({ ...args, memoryIds: args.memoryIds.slice(0, 1), generator });
  assert.equal(calls.length, 0);
  await proposeRelationsForBatch({ ...args, memoryIds: args.memoryIds.slice(0, 1), generator });
  assert.equal(calls.length, 0);
  const withoutSources = fixture(t, { sources: 0 });
  await proposeRelationsForBatch({ ...withoutSources, generator });
  assert.equal(calls.length, 0);
  await proposeRelationsForBatch({ ...args, generator });
  assert.equal(calls.length, 1);
  const empty = planMemoryConsolidation({ ...args, triggerMemoryIds: [args.memoryIds[0]] });
  await runMemoryConsolidation({ ...args, runId: empty.id, structureGenerator: generator, relationGenerator: generator });
  assert.equal(calls.length, 1);
  args.repository.upsertEdge({ agentId: args.agentId, fromMemoryId: args.memoryIds[0], toMemoryId: args.memoryIds[1],
    relation: "associated_with", weight: 0.9, confidence: 0.9 });
  const related = planMemoryConsolidation({ ...args, triggerMemoryIds: [args.memoryIds[0]] });
  assert.deepEqual(related.candidateIds, [args.memoryIds[1]]);
  await runMemoryConsolidation({ ...args, runId: related.id, structureGenerator: generator, relationGenerator: generator });
  assert.deepEqual(calls, ["memory-relation-proposals-v1", "memory-consolidation-combined-v1"]);
});
