import { createTestDirectory, closeAfterTests } from '../../../test/support/suite-resources.mjs';
import { extractionModelFixture } from '../../../test/support/extraction-fixtures.mjs';
import assert from "node:assert/strict";
import { processStateAnalysisRequest } from "@suzu-memory/analysis";
import { retrieveMemories } from "@suzu-memory/retriever";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateMemoryTaskOutput } from '@suzu-memory/service';

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-memory/core";
import {
  LONG_TERM_EXTRACTION_SCHEMA,
  archiveLongTermEvidence,
  fallbackStateAnalysisToProvisionalReview,
  buildLongTermExtractionInput,
  buildExtractionParticipants,
  detectExtractionLanguage,
  normalizeGeneratedLongTermExtraction,
  resolveExtractionParticipant,
  resolveExtractionActor,
  resolveExtractedCandidateIdentity,
} from "../src/index.mjs";

function temporaryDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-extraction-"));
  const databasePath = path.join(root, "memory.db");
  const database = openMemoryDatabase(databasePath);
  return { root, database, repository: new MemoryRepository(database) };
}

for (const language of ['en', 'zh']) test(`archives all directly named participants beyond eight: ${language}`, t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const names = Array.from({ length: 10 }, (_, index) => language === 'en' ? `Guest ${index + 1}` : `来宾${index + 1}`);
  const text = language === 'en' ? `Suzu visited the museum with ${names.join(', ')}.` : `Suzu 和${names.join('、')}一起参观了博物馆。`;
  const identity = { companionId: 'agent-test', companionName: 'Suzu', primaryUserId: 'human-test', primaryUserName: 'User' };
  const built = buildLongTermExtractionInput({ identity, memoryOwner: 'Suzu', userName: 'User',
    messages: [{ id: 'museum-visit', role: 'assistant', speaker: 'Suzu', text, timestamp: '2026-08-04T08:00:00Z' }] });
  const candidate = { kind: 'event', title: 'Museum visit', content: text, subjectRole: 'agent', subjectName: 'Suzu',
    actorRoles: names.map(actorName => ({ role: 'participant', actorRole: 'other', actorName, confidence: 1 })),
    canonicalKey: '', stateFamily: 'not_applicable', stateLabel: '', reality: 'real', evidenceMode: 'observed', temporalState: 'historical',
    eventDate: '', eventStart: '', eventEnd: '', revisionAction: 'add', confidence: 1, importance: 0.5, sourceRefs: [built.messages[0].memoryRef] };
  const validated = validateMemoryTaskOutput({ schemaName: 'long-term-memory-extraction-v4', schema: LONG_TERM_EXTRACTION_SCHEMA }, extractionModelFixture({ memories: [candidate] }));
  const generated = normalizeGeneratedLongTermExtraction(validated, built);
  assert.equal(generated.memories[0].actorRoles.length, 10);
  const archived = archiveLongTermEvidence({ repository, agentId: 'agent-test', identity, messages: built.messages,
    generatedMemories: generated.memories, batchId: 'museum-visitors', recordedAt: '2026-08-04T08:01:00Z' });
  assert.equal(archived.memoriesStored, 1, JSON.stringify(archived));
  const saved = repository.getMemoryDetail('agent-test', archived.candidateResults[0].memoryId);
  const participants = saved.roles.filter(role => role.role === 'participant');
  assert.equal(participants.length, 10);
  assert.equal(new Set(participants.map(role => role.actor_key)).size, 10);
  assert.deepEqual(participants.map(role => role.metadata.actorName).sort(), [...names].sort());
  assert.equal(saved.sources.length, 1);
});

test('archived facts, state drafts and review fallback retain first knowledge time and the full interval', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const identity = { companionId: 'owner', companionName: 'Suzu', primaryUserId: 'human', primaryUserName: 'Lin' };
  const built = buildLongTermExtractionInput({ identity, messages: [
    { id: 'first', role: 'user', speaker: 'Lin', timestamp: '2026-11-01T09:00:00Z', knownAt: '2026-11-03T09:00:00Z',
      text: 'I plan a visit from 2026-11-10 through 2026-11-12.' },
    { id: 'second', role: 'user', speaker: 'Lin', timestamp: '2026-11-02T09:00:00Z', knownAt: '2026-11-02T12:00:00Z',
      text: 'The visit is confirmed.' },
  ] });
  const base = { title: 'Planned visit', content: 'Lin plans a visit from 2026-11-10 through 2026-11-12.',
    classification: { category: 'event' }, subject: { ref: 'P2' }, actors: [], reality: 'real', evidenceMode: 'explicit',
    temporalState: 'historical', revisionAction: 'add', time: { start: '2026-11-10T09:00:00Z', end: '2026-11-12T09:00:00Z' },
    confidence: 1, importance: 0.6, sourceRefs: ['M0001', 'M0002'] };
  const generated = normalizeGeneratedLongTermExtraction({ memories: [base,
    { ...base, classification: { category: 'plan', key: 'visit', label: 'Visit' }, temporalState: 'current' }] }, built);
  const archived = archiveLongTermEvidence({ repository, agentId: 'owner', identity, messages: built.messages,
    generatedMemories: generated.memories, batchId: 'visit', recordedAt: '2026-11-04T00:00:00Z' });
  const expectedKnownAt = '2026-11-02T12:00:00.000Z';
  const fact = repository.getMemory(archived.candidateResults[0].memoryId);
  assert.equal(fact.known_at, expectedKnownAt);
  const request = repository.getStateAnalysisRequest('owner', archived.candidateResults[1].stateAnalysisRequestId);
  assert.equal(repository.getIngestionDecisionByBatchCandidate('owner', 'visit', 1).known_at, expectedKnownAt);
  const draft = repository.materializeStateAnalysisMemory('owner', request.id);
  assert.equal(draft.known_at, expectedKnownAt);
  assert.equal(draft.event_start, generated.memories[1].eventStart);
  assert.equal(draft.event_end, generated.memories[1].eventEnd);
  const fallback = fallbackStateAnalysisToProvisionalReview({ repository, request }).provisional;
  assert.equal(fallback.known_at, expectedKnownAt);
  assert.equal(fallback.event_end, generated.memories[1].eventEnd);
  const sources = repository.listMemorySources(fact.id);
  assert.deepEqual(sources.map(source => [source.occurred_at, source.known_at]).sort(), [
    ['2026-11-01T09:00:00.000Z', '2026-11-03T09:00:00.000Z'],
    ['2026-11-02T09:00:00.000Z', '2026-11-02T12:00:00.000Z'],
  ]);
  const undated = buildLongTermExtractionInput({ identity,
    messages: [{ id: 'undated', role: 'user', speaker: 'Lin', timestamp: null, text: 'I visited the museum.' }] });
  const undatedCandidates = normalizeGeneratedLongTermExtraction({ memories: [
    { ...base, content: 'Lin visited the museum.', time: null, sourceRefs: ['M0001'] },
  ] }, undated).memories;
  const undatedArchive = archiveLongTermEvidence({ repository, agentId: 'owner', identity, messages: undated.messages,
    generatedMemories: undatedCandidates, batchId: 'undated', recordedAt: '2026-11-04T00:00:00.000Z' });
  const undatedMemory = repository.getMemory(undatedArchive.candidateResults[0].memoryId);
  assert.equal(undatedMemory.known_at, '2026-11-04T00:00:00.000Z');
  assert.equal(repository.getIngestionDecisionByBatchCandidate('owner', 'undated', 0).known_at, undatedMemory.known_at);
  const undatedSource = repository.listMemorySources(undatedMemory.id)[0];
  assert.equal(undatedSource.known_at, undatedMemory.known_at);
  assert.equal(undatedSource.occurred_at, null);
  assert.equal(repository.getMemory(undatedArchive.utteranceMemoryIds[0]).event_start, null);
});

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
    const resolved = resolveExtractionActor({ ref: person.ref }, { participants });
    assert.equal(resolved.key, person.actorKey);
    assert.equal(resolved.name, person.name);
  }
  const unresolved = resolveExtractedCandidateIdentity({ subjectRole: 'other', subjectName: 'O’Neill', kind: 'event',
    actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: "Ｏ'Ｎｅｉｌｌ", confidence: 1 }] },
  'owner', { participants: [], unresolvedActorScope: 'one-window' });
  assert.equal(unresolved.actorRoles[0].actorKey, unresolved.subjectKey);
});

test("long-term extraction schema has no host continuity summary", () => {
  assert.deepEqual(LONG_TERM_EXTRACTION_SCHEMA.required, ["memories"]);
  assert.equal(Object.hasOwn(LONG_TERM_EXTRACTION_SCHEMA.properties, "summary"), false);
  assert.deepEqual(normalizeGeneratedLongTermExtraction({ memories: [] }), { memories: [] });
  assert.throws(
    () => normalizeGeneratedLongTermExtraction({ summary: "host-owned", memories: [] }),
    /不适用：summary/u,
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

test("annotates each archive window and message with its source language in the extraction request", () => {
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
  assert.match(built.input, /P1 记忆拥有者：I painted a sunrise last year/u);
  assert.match(built.input, /\[source-language=zh\] P2 对方：我今天去了科技馆/u);
  assert.match(built.input, /\[source-language=en\] P1 记忆拥有者：I loved the science exhibit/u);
});

test('a short English message retains its language in a mostly Chinese batch', () => {
  const built = buildLongTermExtractionInput({ messages: [
    { id: 'long-chinese', role: 'assistant', text: '今天一起整理了读书群的书单。'.repeat(30) },
    { id: 'short-english', role: 'user', text: 'I prefer mysteries.' },
  ] });
  assert.equal(built.archiveWindows[0].sourceLanguage, 'mixed');
  assert.deepEqual(built.messages.map(message => message.sourceLanguage), ['zh', 'en']);
  assert.match(built.input, /\[source-language=en\] P2 对方：I prefer mysteries\./u);
});

test('the extraction parser preserves supplied multilingual names, time ranges and state labels without mutating its input', () => {
  const narratives = [
    { title: 'Reading—at home', content: 'Caroline prefers reading at 18:00–19:00—after dinner.', stateLabel: 'Reading at 18:00–19:00' },
    { title: '阅读《海边—灯塔》', content: '小夏说：“我喜欢《海边—灯塔》，每天18:00–19:00读。”', stateLabel: '喜欢《海边—灯塔》' },
    { title: '小夏每晚阅读《Sea–Light》', content: '小夏说：“我喜欢每天晚上安静地阅读Sea–Light。”', stateLabel: '喜欢安静阅读《Sea–Light》' },
  ];
  const input = { memories: narratives.map(narrative => ({
    kind: 'preference', ...narrative, subjectRole: 'user', subjectName: '小夏', actorRoles: [],
    canonicalKey: 'reading', stateFamily: 'preference', reality: 'real', evidenceMode: 'explicit',
    temporalState: 'current', revisionAction: 'add', eventDate: '', eventStart: '', eventEnd: '', confidence: 1, importance: 0.5, sourceRefs: ['M0001'],
  })) };
  const original = structuredClone(input);
  const parsed = normalizeGeneratedLongTermExtraction(extractionModelFixture(input));
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
  assert.match(built.input, /^记忆拥有者：P1 Echo\n/u);
  const lines = built.input.split('\n');
  for (const [body, name, spaceId] of [
    ['前文内容', 'P1 Echo', 'group-a'],
    ['正文内容', 'P2 Echo', 'group-b'],
    ['后文内容', 'P1 Echo', 'group-b'],
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

test('captured speakers supply an unconfigured owner name to the extraction model', () => {
  for (const name of ['Suzu', '铃']) {
    const built = buildLongTermExtractionInput({ memoryOwner: '', identity: { companionId: 'owner' },
      messages: [{ id: 'owner-message', role: 'assistant', speaker: name, text: 'A museum visit.',
        eventSource: { recipientAgentId: 'owner', sender: { kind: 'agent', id: 'owner', name },
          topology: { kind: 'space', spaceKind: 'group' } } }] });
    const owner = built.participants.find(person => person.actorRole === 'agent');
    assert.equal(owner.name, name);
    assert.equal(owner.actorKey, 'owner');
    assert.ok(built.input.startsWith(`记忆拥有者：${owner.ref} ${name}\n`));
    assert.equal(resolveExtractionActor({ ref: owner.ref }, built).name, name);
  }
  assert.equal(buildExtractionParticipants([], { agentId: 'unnamed-owner' })[0].name, '未命名人物');
});

test('named human and Agents omit person IDs from model input while retaining source attribution', () => {
  const source = { recipientAgentId: 'private-owner-id', spaceId: 'reading-group',
    sender: { kind: 'local-user', id: 'private-human-id', name: '小夏' },
    topology: { kind: 'space', spaceKind: 'group' } };
  const built = buildLongTermExtractionInput({ memoryOwner: 'Suzu', userName: '私聊角色',
    identity: { companionId: 'private-owner-id', primaryUserId: 'private-human-id' },
    messages: [{ id: 'source-message', role: 'user', text: '我负责整理书单。', eventSource: source }] });
  assert.match(built.input, /^记忆拥有者：P1 Suzu\n/u);
  assert.match(built.input, /"ref":"P2","name":"小夏"/u);
  assert.match(built.input, /P2 小夏：我负责整理书单。/u);
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

for (const [language, text] of [["en", "Xia's hands were shaking."], ["zh", "小夏的双手在发抖。"]]) {
  for (const evidenceMode of ["observed", "inferred"]) test(`routes ${language} ${evidenceMode} state evidence to its specialist`, async t => {
    const { root, database, repository } = temporaryDatabase();
    t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const name = language === "en" ? "Xia" : "小夏";
    const identity = { primaryUserId: "human-xia", primaryUserName: name, companionId: "agent-test", companionName: "Suzu" };
    const built = buildLongTermExtractionInput({ memoryOwner: "Suzu", userName: name, identity,
      messages: [{ id: "observation", role: "assistant", speaker: "Suzu", timestamp: "2026-08-04T08:00:00Z", text }] });
    const generated = normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [{ kind: "fact", title: text, content: text, subjectRole: "user", subjectName: name,
      actorRoles: [{ role: "experiencer", actorRole: "user", actorName: name, confidence: 0.9 }],
      canonicalKey: "user:condition:shaking", stateFamily: "condition", stateLabel: "shaking hands", reality: "real", evidenceMode,
      temporalState: "current", eventDate: "", eventStart: "", eventEnd: "", revisionAction: "add", confidence: 0.8, importance: 0.5, sourceRefs: [built.messages[0].memoryRef] }] })).memories;
    const result = archiveLongTermEvidence({ repository, agentId: "agent-test", messages: built.messages, generatedMemories: generated,
      batchId: "observation-batch", recordedAt: "2026-08-04T08:01:00Z", identity });
    assert.equal(result.stateAnalysisRequestsQueued, 1, JSON.stringify(result));
    assert.equal(result.memoriesForReview, 0);
    const [request] = repository.listStateAnalysisRequests("agent-test", { statuses: ["pending"] });
    assert.equal(request.canonical_key, 'user:condition:shaking');
    assert.equal(request.evidence_mode, evidenceMode);
    assert.equal(request.representation_layer, "inferred");
    assert.deepEqual(request.memoryIds, result.utteranceMemoryIds);
    const processed = await processStateAnalysisRequest({ repository, agentId: "agent-test", requestId: request.id, embeddingProvider: async () => { throw new Error("Evidence-only analysis must not pre-embed a temporary semantic draft."); }, generator: async () => ({ output: { analyses: [{
      memoryId: request.memoryIds[0], sourceIds: request.sourceIds, confidence: 0.8, rationale: "The source describes the fixed person.",
      targetMatch: "exact", matchedLabel: "shaking hands", conditionPresence: "present", conditionKind: "health", effect: "none", temporality: "current",
      evidenceBasis: evidenceMode === "observed" ? "direct_observation" : "inferred", scopeLabel: "this moment", revisionCue: "none",
    }] } }) });
    assert.equal(processed.status, "provisional-review", JSON.stringify(processed));
    assert.equal(processed.merged.observations.length, 1);
    assert.equal(processed.merged.observations[0].qualification, evidenceMode === "observed" ? "qualified" : "unresolved");
    const recalled = await retrieveMemories({ databasePath: path.join(root, "memory.db"), agentId: "agent-test", query: language === "en" ? "shaking hands" : "双手在发抖",
      now: new Date("2026-08-04T08:05:00Z"), options: { topK: 5, maximumContextChars: 4000 } });
    assert.ok(recalled.candidates.some(item => item.memoryId === processed.provisional.id), JSON.stringify(recalled.candidates));
  });
}

for (const language of ['zh', 'en']) test(`compact references preserve directed state targets, changes and evidence: ${language}`, () => {
  const owner = language === 'zh' ? '小铃' : 'Suzu';
  const user = language === 'zh' ? '小夏' : 'Xia';
  const content = language === 'zh' ? '小夏不再信任小铃。' : 'Xia no longer trusts Suzu.';
  const built = buildLongTermExtractionInput({ memoryOwner: owner, userName: user,
    identity: { companionId: 'owner-private', primaryUserId: 'human-private' },
    messages: [{ id: 'correction', role: 'user', speaker: user, timestamp: '2026-08-04T08:00:00Z', text: content }] });
  const candidate = { title: content, content, classification: { category: 'relationship', key: 'trust', label: content,
    target: { counterpart: { ref: 'P1' }, dimension: 'trust' } },
    subject: { ref: 'P2' }, actors: [{ role: 'experiencer', person: { ref: 'P2' }, confidence: 0.8 }],
    reality: 'real', evidenceMode: 'explicit', temporalState: 'current', revisionAction: 'correct',
    time: null, confidence: 0.9, importance: 0.7, sourceRefs: ['M0001'] };
  const original = structuredClone(candidate);
  const memory = normalizeGeneratedLongTermExtraction({ memories: [candidate] }, built).memories[0];
  assert.equal(memory.kind, 'relationship');
  assert.equal(memory.subjectRole, 'user');
  assert.equal(memory.subjectName, user);
  assert.deepEqual(memory.stateTarget, { counterpartRole: 'agent', counterpartName: owner, counterpartKey: 'owner-private', counterpartIdentityStatus: 'bound', relationshipDimension: 'trust' });
  assert.equal(memory.revisionAction, 'correct');
  assert.equal(memory.canonicalKey, 'trust');
  assert.equal(memory.content, content);
  assert.deepEqual(memory.actorRoles, [{ role: 'experiencer', actorRole: 'user', actorKey: 'human-private', actorName: user, identityStatus: 'bound', confidence: 0.8 }]);
  assert.deepEqual(memory.sourceRefs, ['M0001']);
  assert.equal(memory.eventDate, '');
  assert.equal(memory.confidence, 0.9);
  assert.equal(memory.importance, 0.7);
  assert.deepEqual(candidate, original);
  assert.doesNotMatch(built.input, /owner-private|human-private/);
});

test('each semantic category retains its domain kind without a second classification decision', () => {
  const expected = { event: ['event', 'not_applicable'], reflection: ['reflection', 'not_applicable'],
    identity: ['fact', 'identity'], belief: ['belief_state', 'belief'], preference: ['preference', 'preference'],
    habit: ['belief_state', 'habit'], disposition: ['belief_state', 'disposition'], value: ['belief_state', 'value'],
    plan: ['plan', 'goal'], commitment: ['commitment', 'goal'], open_loop: ['open_loop', 'goal'],
    capability: ['fact', 'capability'], relationship: ['relationship', 'relationship'],
    affective_association: ['belief_state', 'affective_association'], self_concept: ['belief_state', 'self_concept'], condition: ['fact', 'condition'] };
  const targets = { identity: { identityField: 'relationship_status', fieldCardinality: 'single' },
    belief: { object: { world: 'weather' } }, relationship: { counterpart: { name: 'Suzu' }, dimension: 'trust' },
    affective_association: { trigger: { world: 'rain' } } };
  for (const [category, kinds] of Object.entries(expected)) {
    const classification = { category, ...(category === 'event' ? {} : { key: 'same-fact' }),
      ...(['event', 'reflection'].includes(category) ? {} : { label: 'A supported fact' }),
      ...(targets[category] ? { target: targets[category] } : {}) };
    const memory = normalizeGeneratedLongTermExtraction({ memories: [{ title: 'A supported fact', content: 'Xia stated a fact.',
      classification, subject: { name: 'Xia' }, actors: [], reality: 'real', evidenceMode: 'inferred',
      temporalState: 'unknown', revisionAction: 'update', time: null, confidence: 0.8, importance: 0.5, sourceRefs: ['M0001'] }] }).memories[0];
    assert.deepEqual([memory.kind, memory.stateFamily], kinds, category);
    assert.equal(memory.evidenceMode, 'inferred');
    assert.equal(memory.revisionAction, 'update');
    assert.equal(memory.canonicalKey, category === 'event' ? '' : 'same-fact');
  }
});


test('interleaved archive connections keep distinct same-name references bound to separate entities', t => {
  const directory = createTestDirectory(path.join(os.tmpdir(), 'entity-archive-lock-'));
  const databasePath = path.join(directory, 'memory.db');
  const databaseA = closeAfterTests(openMemoryDatabase(databasePath, { timeout: 20 }));
  const databaseB = closeAfterTests(openMemoryDatabase(databasePath, { timeout: 20 }));
  const repositoryA = new MemoryRepository(databaseA), repositoryB = new MemoryRepository(databaseB);
  const identity = { companionId: 'a', companionName: 'Suzu', primaryUserId: 'u', primaryUserName: 'Lin' };
  const built = buildLongTermExtractionInput({ identity, messages: [
    { id: 'france', role: 'user', speaker: 'Lin', text: 'I visited Paris in France.' },
    { id: 'texas', role: 'user', speaker: 'Lin', text: 'I visited Paris in Texas.' },
  ] });
  const base = { title: 'Paris', content: 'Lin visited Paris in France.', classification: { category: 'event' }, subject: { ref: 'P2' },
    actors: [], reality: 'real', evidenceMode: 'explicit', temporalState: 'historical', revisionAction: 'add', time: null,
    confidence: 1, importance: 0.5, sourceRefs: ['M0001'], entityRefs: ['E1'] };
  const rows = normalizeGeneratedLongTermExtraction({ entities: [
    { ref: 'E1', kind: 'place', name: 'Paris', aliases: ['Paris France'] },
    { ref: 'E2', kind: 'place', name: 'Paris', aliases: ['Paris Texas'] },
  ], memories: [base, { ...base, content: 'Lin visited Paris in Texas.', sourceRefs: ['M0002'], entityRefs: ['E2'] }] }, built).memories;
  repositoryA.upsertEntity({ id: 'existing-paris', agentId: 'a', kind: 'place', canonicalName: 'Paris' });
  const archive = (repository, row, index) => archiveLongTermEvidence({ repository, agentId: 'a', identity, messages: built.messages,
    generatedMemories: [row], batchId: 'shared-batch', candidateIndexOffset: index });
  const read = repositoryA.listIngestionEntityBindings.bind(repositoryA);
  let secondResult, retrySecond = false, attempted = false;
  t.mock.method(repositoryA, 'listIngestionEntityBindings', args => {
    const captured = read(args);
    if (!attempted) {
      attempted = true;
      try { secondResult = archive(repositoryB, rows[0], 0); }
      catch (error) { if (!/database is locked/u.test(error.message)) throw error; retrySecond = true; }
    }
    return captured;
  });
  const firstResult = archive(repositoryA, rows[1], 1);
  if (retrySecond) secondResult = archive(repositoryB, rows[0], 0);
  assert.equal(firstResult.memoriesStored, 1); assert.equal(secondResult.memoriesStored, 1);
  const entity = (repository, result) => repository.listMemoryEntities(result.candidateResults[0].memoryId).find(item => item.kind === 'place');
  const texas = entity(repositoryA, firstResult), france = entity(repositoryB, secondResult);
  assert.notEqual(texas.id, france.id, 'Two different references cannot acquire the same entity from stale reads.');
  assert.equal(repositoryA.getIngestionDecisionByBatchCandidate('a', 'shared-batch', 0).candidate.entityBindings.E1, france.id);
  assert.equal(repositoryA.getIngestionDecisionByBatchCandidate('a', 'shared-batch', 1).candidate.entityBindings.E2, texas.id);
});
