import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";
import { buildPreferenceEvidenceSnapshot } from "../src/preference-snapshot.mjs";

function fixture(t, { count = 1, sourceCount = 1, content = "一次完整的讨论。", kind = "event" } = {}) {
  const database = openMemoryDatabase(":memory:");
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const memoryIds = [];
  for (let i = 0; i < count; i += 1) {
    const memory = repository.upsertMemory({
      id: `memory-${i}`, agentId: "agent-test", kind, layer: kind === "utterance" ? "raw" : "episodic",
      title: "事件背景。".repeat(40), content, subjectRole: "agent", subjectKey: "agent-test",
      reality: "real", evidenceMode: "explicit", temporalState: "historical",
    });
    memoryIds.push(memory.id);
    for (let j = 0; j < sourceCount; j += 1) {
      const source = repository.upsertSource({
        agentId: "agent-test", sourceKind: "conversation", externalId: `source-${i}-${j}`, content,
      });
      repository.linkSource(memory.id, source.id, kind === "utterance" ? "verbatim" : "evidence");
    }
  }
  return (options = {}) => buildPreferenceEvidenceSnapshot({
    repository, agentId: "agent-test", subjectRole: "agent", subjectKey: "agent-test",
    canonicalKey: "agent:preference:discussion", memoryIds, ...options,
  });
}

test("utterance archival time does not become the expressed state's temporal status", (t) => {
  for (const content of ["我喜欢公平线索的推理小说。", "我以前喜欢长篇，现在更喜欢短篇。"] ) {
    const snapshot = fixture(t, { kind: "utterance", content })({ allowUtteranceEvidence: true });
    assert.equal(snapshot.memories.length, 1);
    assert.equal(Object.hasOwn(snapshot.memories[0], "temporalState"), false);
    assert.equal(snapshot.memories[0].content, content);
    assert.equal(snapshot.sourceRecords[0].content, content);
  }
  const eventSnapshot = fixture(t)();
  assert.equal(eventSnapshot.memories[0].temporalState, "historical");
});

test("preserves long evidence including the final correction and full title", (t) => {
  const content = "背景材料。".repeat(1800) + "最后更正：我不喜欢这件事。";
  const build = fixture(t, { content });
  const snapshot = build();
  assert.equal(snapshot.memories[0].content, content);
  assert.equal(snapshot.sourceRecords[0].content, content);
  assert.equal(snapshot.memories[0].title, "事件背景。".repeat(40));
  assert.throws(() => build({ maxMemoryContentChars: 700 }), /complete 700-character budget/);
  assert.throws(() => build({ maxSourceContentChars: 1000 }), /complete 1000-character budget/);
  assert.throws(() => build({ maxSnapshotChars: 4000 }), /4000-character privacy budget/);
});

test("includes every selected memory instead of dropping messages after forty", (t) => {
  const build = fixture(t, { count: 41 });
  assert.equal(build().memories.length, 41);
  assert.equal(build().omitted.memoriesTruncated, 0);
  assert.throws(() => build({ maxMemories: 40 }), /complete 40-memory budget/);
});

test("includes every in-scope source instead of dropping sources after eight", (t) => {
  const build = fixture(t, { sourceCount: 9 });
  const snapshot = build();
  assert.equal(snapshot.sourceRecords.length, 9);
  assert.equal(snapshot.memories[0].sourcesTruncated, false);
  assert.throws(() => build({ maxSourcesPerMemory: 8 }), /complete 8-source budget/);
  const allowedSourceIds = snapshot.sourceRecords.slice(0, 2).map(source => source.id);
  assert.equal(build({ allowedSourceIds, maxSourcesPerMemory: 2 }).sourceRecords.length, 2);
});
