import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-memory/core";
import {
  LONG_TERM_EXTRACTION_SCHEMA,
  RETENTION_REASONS,
  archiveLongTermEvidence,
  buildLongTermExtractionInput,
  buildExtractionParticipants,
  detectExtractionLanguage,
  isRetentionReasonCompatible,
  parseGeneratedLongTermExtraction,
  resolveExtractionParticipant,
  resolveExtractedCandidateIdentity,
} from "../src/index.mjs";

function temporaryDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-extraction-"));
  const databasePath = path.join(root, "memory.db");
  const database = openMemoryDatabase(databasePath);
  return { root, database, repository: new MemoryRepository(database) };
}

test('apostrophe folding resolves known names without collapsing distinct host identities', () => {
  const participants = buildExtractionParticipants([
    { role: 'assistant', speaker: "O'Neill", text: 'I visited the museum.' },
    { role: 'user', speaker: 'O’Neill', text: 'I visited the library.' },
  ], { companionId: 'agent-oneill', companionName: "O'Neill", primaryUserId: 'human-oneill', primaryUserName: 'O’Neill' });
  for (const name of ["O'Neill", 'O’Neill']) {
    assert.equal(resolveExtractionParticipant(name, participants).status, 'ambiguous');
  }
  assert.equal(new Set(participants.map(person => person.actorKey)).size, 2);
  for (const person of participants) {
    const resolved = resolveExtractionParticipant(person.name, participants);
    assert.equal(resolved.status, 'known');
    assert.equal(resolved.participant.actorKey, person.actorKey);
  }
  const unresolved = resolveExtractedCandidateIdentity({ subjectRole: 'other', subjectName: 'O’Neill', kind: 'event',
    actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: "Ｏ'Ｎｅｉｌｌ", confidence: 1 }] },
  'owner', { participants: [], unresolvedActorScope: 'one-window' });
  assert.equal(unresolved.actorRoles[0].actorKey, unresolved.subjectKey);
});

test("long-term extraction schema has no host continuity summary", () => {
  assert.deepEqual(LONG_TERM_EXTRACTION_SCHEMA.required, ["memories"]);
  assert.equal(Object.hasOwn(LONG_TERM_EXTRACTION_SCHEMA.properties, "summary"), false);
  assert.deepEqual(parseGeneratedLongTermExtraction({ memories: [] }), { memories: [] });
  assert.throws(
    () => parseGeneratedLongTermExtraction({ summary: "host-owned", memories: [] }),
    /只能包含 memories/u,
  );
});

test("long-term extraction input only contains submitted standard events", () => {
  const built = buildLongTermExtractionInput({
    memoryOwner: "Companion",
    userName: "User",
    messages: [{
      id: "event-1",
      timestamp: "2026-08-04T00:00:00.000Z",
      role: "user",
      text: "今天去了科技馆。",
      worldFrame: "physical",
      worldId: "primary",
    }],
  });
  assert.equal(built.messages.length, 1);
  assert.equal(built.messages[0].memoryRef, "M0001");
  assert.match(built.input, /【待提取的标准事件】/u);
  assert.doesNotMatch(built.input, /既有记忆摘要|切点|短期上下文/u);
});

test("labels boundary context as read-only and assigns evidence refs only to archive messages", () => {
  const message = (id, role, text) => ({
    id,
    timestamp: "2026-08-04T00:00:00.000Z",
    role,
    text,
    worldFrame: "relational",
    worldId: "relationship",
  });
  const built = buildLongTermExtractionInput({
    memoryOwner: "Companion",
    userName: "User",
    previousContextMessages: [message("previous", "assistant", "之前的问题是什么？")],
    messages: [message("archive", "user", "我今天去了科技馆。")],
    continuationGuidanceMessages: [message("guidance", "user", "这件事还没有讲完。")],
  });
  assert.deepEqual(built.messages.map((item) => item.memoryRef), ["M0001"]);
  assert.equal(built.previousContextMessages[0].memoryRef, undefined);
  assert.equal(built.continuationGuidanceMessages[0].memoryRef, undefined);
  assert.match(built.input, /【只读的前文衔接】[\s\S]*之前的问题是什么/u);
  assert.match(built.input, /【待提取的标准事件】[\s\S]*\[M0001\][\s\S]*我今天去了科技馆/u);
  assert.match(built.input, /【只读的后文衔接】[\s\S]*这件事还没有讲完/u);
  assert.equal((built.input.match(/\[M\d{4}\]/gu) || []).length, 1);
});

test("packs semantic archive windows into one prompt without sharing evidence namespaces", () => {
  const message = (id, text) => ({
    id,
    timestamp: "2026-08-04T00:00:00.000Z",
    role: "user",
    text,
  });
  const built = buildLongTermExtractionInput({
    archiveWindows: [
      { id: "window-a", messages: [message("a", "第一段独立经历。")] },
      { id: "window-b", messages: [message("b", "第二段独立经历。")] },
    ],
  });
  assert.deepEqual(built.messages.map((item) => item.memoryRef), ["M0001", "M0002"]);
  assert.deepEqual(built.messages.map((item) => item.archiveWindowId), ["window-a", "window-b"]);
  assert.match(built.input, /【语义归档窗口 W0001】[\s\S]*\[M0001\][\s\S]*【语义归档窗口 W0002】[\s\S]*\[M0002\]/u);
});

test("keeps Chinese, English, and mixed archive windows in their own output languages", () => {
  const message = (id, role, text) => ({
    id,
    timestamp: "2026-08-04T00:00:00.000Z",
    role,
    text,
  });
  assert.equal(detectExtractionLanguage("今天去科技馆看AI展。"), "zh");
  assert.equal(detectExtractionLanguage("I went to the science museum today."), "en");
  assert.equal(detectExtractionLanguage("今天我和你一起看 a science museum video。"), "mixed");

  const built = buildLongTermExtractionInput({
    archiveWindows: [
      { id: "zh", messages: [message("zh-1", "user", "我今天去了科技馆。")] },
      { id: "en", messages: [message("en-1", "assistant", "I painted a sunrise last year.")] },
      {
        id: "mixed",
        messages: [
          message("mixed-1", "user", "我今天去了科技馆。"),
          message("mixed-2", "assistant", "I loved the science exhibit."),
        ],
      },
    ],
  });
  assert.deepEqual(built.archiveWindows.map((window) => window.sourceLanguage), ["zh", "en", "mixed"]);
  assert.match(built.input, /本窗口输出语言：中文/u);
  assert.match(built.input, /本窗口输出语言：English/u);
  assert.match(built.input, /本窗口输出语言：逐候选跟随直接证据/u);
  assert.match(built.input, /Agent：I painted a sunrise last year/u);
  assert.match(built.input, /\[source-language=zh\] user：我今天去了科技馆/u);
  assert.match(built.input, /\[source-language=en\] agent：I loved the science exhibit/u);
});

test('a short English message retains its language in a mostly Chinese batch', () => {
  const built = buildLongTermExtractionInput({ messages: [
    { id: 'long-chinese', role: 'assistant', text: '今天一起整理了读书群的书单。'.repeat(30) },
    { id: 'short-english', role: 'user', text: 'I prefer mysteries.' },
  ] });
  assert.equal(built.archiveWindows[0].sourceLanguage, 'mixed');
  assert.deepEqual(built.messages.map(message => message.sourceLanguage), ['zh', 'en']);
  assert.match(built.input, /\[source-language=en\] user：I prefer mysteries\./u);
});

test('extraction preserves quoted names, time ranges and state labels in Chinese, English and mixed narratives', () => {
  const narratives = [
    { title: 'Reading—at home', content: 'Caroline prefers reading at 18:00–19:00—after dinner.', stateLabel: 'Reading at 18:00–19:00' },
    { title: '阅读《海边—灯塔》', content: '小夏说：“我喜欢《海边—灯塔》，每天18:00–19:00读。”', stateLabel: '喜欢《海边—灯塔》' },
    { title: '小夏每晚阅读《Sea–Light》', content: '小夏说：“我喜欢每天晚上安静地阅读Sea–Light。”', stateLabel: '喜欢安静阅读《Sea–Light》' },
  ];
  const input = { memories: narratives.map(narrative => ({
    kind: 'preference', ...narrative, subjectRole: 'user', subjectName: '小夏', actorRoles: [],
    canonicalKey: 'reading', stateFamily: 'preference', reality: 'real', evidenceMode: 'explicit',
    temporalState: 'current', revisionAction: 'add', retentionReason: 'explicit_preference',
    eventDate: '', eventStart: '', eventEnd: '', confidence: 1, importance: 0.5, sourceRefs: ['M0001'],
  })) };
  const original = structuredClone(input);
  const parsed = parseGeneratedLongTermExtraction(input);
  assert.deepEqual(parsed.memories.map(({ title, content, stateLabel }) => ({ title, content, stateLabel })), narratives);
  assert.deepEqual(input, original);
});

test('owner and same-name speakers use supplied identities throughout core and boundary context', () => {
  const message = (id, senderId, text, spaceId) => ({ id, text, role: 'user', speaker: 'Echo',
    timestamp: '2026-09-22T08:00:00Z',
    eventSource: { recipientAgentId: 'owner', spaceId, sender: { kind: 'agent', id: senderId, name: 'Echo' },
      topology: { kind: 'space', spaceKind: 'group' } },
  });
  const source = {
    memoryOwner: 'Echo', identity: { companionId: 'owner', companionName: 'Echo' },
    previousContextMessages: [message('before', 'owner', '前文内容', 'group-a')],
    messages: [message('core', 'peer', '正文内容', 'group-b')],
    continuationGuidanceMessages: [message('after', 'owner', '后文内容', 'group-b')],
  };
  const original = structuredClone(source);
  const built = buildLongTermExtractionInput(source);
  assert.match(built.input, /^记忆拥有者：Echo \[agent:owner\]\n/u);
  const lines = built.input.split('\n');
  for (const [body, name, spaceId] of [
    ['前文内容', 'Echo [agent:owner]', 'group-a'],
    ['正文内容', 'Echo [other:peer]', 'group-b'],
    ['后文内容', 'Echo [agent:owner]', 'group-b'],
  ]) {
    const line = lines.find(value => value.endsWith(`：${body}`));
    assert.ok(line.endsWith(`${name}：${body}`));
    const provenance = JSON.parse(line.match(/\[来源 (.+?)\] /u)[1]);
    assert.deepEqual(provenance, { spaceId, spaceKind: 'group' });
    assert.doesNotMatch(line, /\(user\)|\(assistant\)/u);
  }
  assert.equal((built.input.match(/\[M\d{4}\]/gu) || []).length, 1);
  assert.deepEqual(source, original, 'Presentation must not rewrite captured messages or source material.');
});

test('named human and Agents omit person IDs from model input while retaining source attribution', () => {
  const source = { recipientAgentId: 'private-owner-id', spaceId: 'reading-group',
    sender: { kind: 'local-user', id: 'private-human-id', name: '小夏' },
    topology: { kind: 'space', spaceKind: 'group' } };
  const built = buildLongTermExtractionInput({ memoryOwner: 'Suzu', userName: '私聊角色',
    identity: { companionId: 'private-owner-id', primaryUserId: 'private-human-id' },
    messages: [{ id: 'source-message', role: 'user', text: '我负责整理书单。', eventSource: source }] });
  assert.match(built.input, /^记忆拥有者：Suzu\n/u);
  assert.match(built.input, /"role":"user","name":"小夏"/u);
  assert.match(built.input, /小夏：我负责整理书单。/u);
  assert.doesNotMatch(built.input, /private-owner-id|private-human-id|私聊角色|"id":/u);
  assert.equal(built.participants.find(person => person.name === '小夏').actorKey, 'private-human-id');
  assert.deepEqual(built.messages[0].eventSource, source);
});

test("persists each raw message's detected source language for later audit", () => {
  const { root, database, repository } = temporaryDatabase();
  try {
    const built = buildLongTermExtractionInput({
      archiveWindows: [{
        id: "english-window",
        messages: [{
          id: "english-message",
          timestamp: "2026-08-04T00:00:00.000Z",
          role: "assistant",
          text: "I painted a sunrise last year.",
        }],
      }],
    });
    const archive = archiveLongTermEvidence({
      repository,
      agentId: "agent-test",
      messages: built.messages,
      generatedMemories: [],
      batchId: "batch-language-test",
      recordedAt: "2026-08-04T00:01:00.000Z",
    });
    const utterance = repository.getMemory(archive.utteranceMemoryIds[0]);
    assert.equal(utterance.metadata.sourceLanguage, "en");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps episodic events separate from unsupported stable-state inference", () => {
  assert.equal(RETENTION_REASONS.includes("episodic_event"), true);
  assert.equal(isRetentionReasonCompatible("event", "episodic_event"), true);
  assert.equal(isRetentionReasonCompatible("preference", "episodic_event"), false);
  assert.equal(isRetentionReasonCompatible("belief_state", "episodic_event"), false);

});
