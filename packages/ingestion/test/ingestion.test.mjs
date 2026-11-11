import { extractionModelFixture } from '../../../test/support/extraction-fixtures.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureCompanionRelationshipStructure,
  MemoryRepository,
  openMemoryDatabase,
  withEventSourceExecution,
  readCausalExcerpt,
} from "@suzu-memory/core";

import {
  appendCompanionEvents,
  normalizeCompanionEvent,
  processPendingCompanionEvents,
  reviseCompanionEvent,
} from "../src/index.mjs";
import { generateCompanionEventBatch, retryCompanionExtractionRepair } from "../src/processing-stages.mjs";
import * as processingStages from '../src/processing-stages.mjs';
import { archiveLongTermEvidence, fallbackStateAnalysisToProvisionalReview, loadLongTermExtractionSystemPrompt } from "@suzu-memory/extraction";
import { calculateCost, withUsageRecorder } from '@suzu-memory/usage-ledger';

const AGENT_ID = "companion-test";
const IDENTITY = Object.freeze({
  spaceId: AGENT_ID,
  companionId: AGENT_ID,
  companionName: "Companion",
  primaryUserId: "user",
  primaryUserName: "User",
});

function event(overrides = {}) {
  return {
    protocolVersion: 1,
    eventId: "event-1",
    spaceId: AGENT_ID,
    eventType: "conversation.turn",
    occurredAt: "2026-08-04T02:00:00.000Z",
    knownAt: "2026-08-04T02:00:00.000Z",
    actor: { role: "user", id: "user", name: "User" },
    participants: [
      { role: "user", id: "user", name: "User" },
      { role: "companion", id: AGENT_ID, name: "Companion" },
    ],
    world: { id: "relationship", frame: "relational" },
    content: { text: "我们今天一起把记忆系统的事件入口定下来了。" },
    source: { kind: "test", locator: "test://conversation/1" },
    metadata: { channel: "direct-message" },
    ...overrides,
  };
}

function generatedEventCandidate(overrides = {}) {
  return {
    kind: "event",
    title: "共同完成事件入口设计",
    content: "User 和 Companion 共同确定了长期记忆事件入口的边界。",
    subjectRole: "shared",
    subjectName: "User 与 Companion",
    actorRoles: [
      { role: "experiencer", actorRole: "user", actorName: "User", confidence: 1 },
      { role: "experiencer", actorRole: "agent", actorName: "Companion", confidence: 1 },
    ],
    canonicalKey: "",
    stateFamily: "not_applicable",
    stateLabel: "",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "historical",
    revisionAction: "add",
    eventDate: "2026-08-04",
    eventStart: "2026-08-04T02:00:00.000Z",
    eventEnd: "",
    confidence: 0.95,
    importance: 0.75,
    sourceRefs: ["M0001", "M0002"],
    ...overrides,
  };
}

function repositoryFixture() {
  const database = openMemoryDatabase(":memory:");
  return { database, repository: new MemoryRepository(database) };
}

test('ingestion preserves original sources and only archives uniquely located causal excerpts', async t => {
  for (const language of ['en', 'zh']) {
    const { database, repository } = repositoryFixture(); t.after(() => database.close());
    const start = language === 'en' ? 'Because the museum was closed,' : '因为博物馆闭馆，';
    const end = language === 'en' ? 'User cancelled the visit.' : 'User 取消了参观。';
    const causal = `${start} ${end}`;
    const content = `  ${'Background information. '.repeat(40)}${causal}${' Other matters.'.repeat(40)}  `;
    const repeated = `${content}\n${causal}`;
    appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: [
      event({ content: { text: content } }),
      event({ eventId: 'second', content: { text: repeated } }),
    ] });
    let calls = 0;
    const result = await processPendingCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY,
      generator: async () => {
        calls++;
        return { output: extractionModelFixture({
          causalExcerpts: ['M0001', 'M0002', 'M9999'].map(sourceRef => ({ sourceRef, start, end })),
          memories: [generatedEventCandidate({ content: causal, sourceRefs: ['M0001', 'M0002'] })],
        }) };
      } });
    assert.equal(calls, 1);
    assert.equal(result.messagesArchived, 2);
    const sources = repository.listMemorySources(result.candidateResults[0].memoryId);
    const first = sources.find(source => source.metadata.memoryRef === 'M0001');
    const second = sources.find(source => source.metadata.memoryRef === 'M0002');
    assert.equal(first.content, content.trim());
    assert.equal(second.content, repeated.trim());
    const range = readCausalExcerpt(first);
    assert.ok(range, 'A uniquely anchored passage must survive extraction, archiving and database reads.');
    assert.equal(first.content.slice(range.start, range.end), causal);
    assert.equal(readCausalExcerpt(second), null, 'Ambiguous anchors require the complete original.');
    const edited = repository.upsertSource({ agentId: AGENT_ID, sourceKind: first.source_kind,
      externalId: first.external_id, content: `${first.content}\nThe visit went ahead after all.`, metadata: first.metadata });
    assert.equal(readCausalExcerpt(edited), null, 'Editing the original invalidates its previous passage.');
  }
});

for (const language of ['en', 'zh']) test('repairs only the time-conflicting candidate and revalidates the correction: ' + language, async () => {
  const source = language === 'en' ? 'This week I applied to adoption agencies.' : '这周我向收养机构提交了申请。';
  const valid = generatedEventCandidate({ sourceRefs: ['M0002'], content: 'User visited a museum.', eventDate: '', eventStart: '' });
  const wrong = generatedEventCandidate({ sourceRefs: ['M0001'],
    content: language === 'en' ? 'In the week before 2023-08-23, User applied to adoption agencies.' : 'User 上周向收养机构提交了申请。',
    eventDate: '2023-08-23', eventStart: '' });
  const corrected = { ...wrong, content: language === 'en' ? 'In the week of 2023-08-23, User applied to adoption agencies.' : 'User 本周向收养机构提交了申请。',
    eventDate: '' };
  const requests = [];
  const result = await generateCompanionEventBatch({ identity: IDENTITY, timeZone: 'Asia/Shanghai', events: [
    event({ occurredAt: '2023-08-23T07:31:00Z', content: { text: source } }),
    event({ eventId: 'second', occurredAt: '2023-08-23T07:32:00Z', content: { text: 'I visited a museum.' } }),
  ], generator: async request => {
    requests.push(request);
    if (requests.length === 1) return { output: extractionModelFixture({ memories: [wrong, valid] }) };
    const input = JSON.parse(request.input);
    assert.equal(input.timeZone, 'Asia/Shanghai');
    assert.deepEqual(input.candidates.map(item => item.candidateIndex), [0]);
    assert.deepEqual(input.sourceMessages.map(item => item.ref), ['M0001', 'M0002']);
    assert.match(input.candidates[0].validationError, /Temporal conflict/u);
    return { output: extractionModelFixture({ results: [{ candidateIndex: 0, status: 'repaired', memories: [requests.length === 2 ? wrong : corrected] }] }) };
  } });
  assert.equal(requests.length, 3);
  assert.equal(result.generation.metadata.repairAttempts, 2);
  assert.equal(result.generation.metadata.unresolvedCandidateCount, 0);
  assert.deepEqual(result.generation.output.memories.map(item => item.content), [valid.content, corrected.content]);
});

test('healthy temporal extraction makes no repair API request', async () => {
  let calls = 0;
  const memory = generatedEventCandidate({ sourceRefs: ['M0001'], content: 'User completed the design on 2026-08-04.' });
  const result = await generateCompanionEventBatch({ events: [event()], identity: IDENTITY,
    generator: async () => { calls++; return { output: extractionModelFixture({ memories: [memory] }) }; } });
  assert.equal(calls, 1);
  assert.equal(result.generation.metadata.initialInvalidCandidateCount, 0);
});

test('unresolved time conflicts keep raw evidence and the configured timezone through an archived review retry', async t => {
  const f = repositoryFixture();
  t.after(() => f.database.close());
  let calls = 0;
  const wrong = generatedEventCandidate({ sourceRefs: ['M0001'], eventDate: '', eventStart: '',
    content: 'In the week of 2023-08-21, User applied.' });
  appendCompanionEvents({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
    events: event({ occurredAt: '2023-08-21T02:00:00Z', content: { text: 'This week I applied.' } }) });
  const result = await processPendingCompanionEvents({ repository: f.repository, agentId: AGENT_ID,
    identity: IDENTITY, timeZone: 'America/Los_Angeles',
    generator: async () => ({ output: extractionModelFixture(++calls === 1 ? { memories: [wrong] }
      : { results: [{ candidateIndex: 0, status: 'repaired', memories: [wrong] }] }) }) });
  assert.equal(calls, 4);
  assert.equal(result.memoriesStored, 0);
  assert.equal(result.messagesArchived, 1);
  const task = f.repository.getMaintenanceTask(AGENT_ID, result.generationDiagnostics.failureReviewTaskId);
  const pending = task.payload.extractionRepair;
  assert.equal(pending.timeZone, 'America/Los_Angeles');
  assert.equal(pending.messages[0].text, 'This week I applied.');
  assert.equal(pending.candidates[0].candidate.content, wrong.content);
  const corrected = { ...wrong, content: 'In the week of 2023-08-20, User applied.' };
  const retried = await retryCompanionExtractionRepair({ repository: f.repository, agentId: AGENT_ID, task,
    identity: IDENTITY, completedAt: '2026-10-30T02:00:00Z', generator: async request => {
      assert.equal(JSON.parse(request.input).timeZone, 'America/Los_Angeles');
      return { output: extractionModelFixture({ results: [{ candidateIndex: 0, status: 'repaired', memories: [corrected] }] }) };
    } });
  assert.equal(retried.memoriesStored, 1);
  assert.equal(retried.failureReviewTask, null);
  assert.equal(f.repository.getMemory(retried.candidateResults[0].memoryId).content, corrected.content);
  assert.equal(f.repository.listMemories(AGENT_ID, { kinds: ['utterance'] }).items.length, 1);
});

test('normal archive processing uses the extraction timezone at a week boundary', async t => {
  const f = repositoryFixture();
  t.after(() => f.database.close());
  appendCompanionEvents({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
    events: event({ occurredAt: '2023-08-21T02:00:00Z', content: { text: 'This week I applied.' } }) });
  const memory = generatedEventCandidate({ sourceRefs: ['M0001'], eventDate: '', eventStart: '', content: 'In the week of 2023-08-20, User applied.' });
  let calls = 0;
  const result = await processPendingCompanionEvents({ repository: f.repository, agentId: AGENT_ID,
    identity: IDENTITY, timeZone: 'America/Los_Angeles', generator: async () => { calls++; return { output: extractionModelFixture({ memories: [memory] }) }; } });
  assert.equal(calls, 1);
  assert.equal(result.memoriesStored, 1);
  assert.equal(result.memoriesForReview, 0);
});

for (const mode of ['success', 'archive-failure', 'output-limit', 'transport-failure']) test(`review repair retains its generation usage exactly once: ${mode}`, async t => {
  const f = repositoryFixture();
  t.after(() => f.database.close());
  appendCompanionEvents({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const initial = await processPendingCompanionEvents({ repository: f.repository, agentId: AGENT_ID,
    identity: IDENTITY, generator: async ({ schemaName }) => ({ output: extractionModelFixture(
      schemaName === 'long-term-memory-extraction-v4'
        ? { memories: [generatedEventCandidate({ sourceRefs: ['M0001'], eventDate: 'invalid' })] }
        : { results: [{ candidateIndex: 0, status: 'pending', reason: 'Needs source review.' }] }) }) });
  const task = f.repository.getMaintenanceTask(AGENT_ID, initial.generationDiagnostics.failureReviewTaskId);
  const charges = [];
  let calls = 0;
  const generator = async () => {
    const receipt = { model: 'repair-fixture', requestId: `repair-${++calls}`,
      usage: { prompt_tokens: calls === 1 ? 11 : 13 }, metadata: { provider: 'fixture' } };
    if (['output-limit', 'transport-failure'].includes(mode)) {
      if (calls === 1) return { ...receipt,
        output: { results: [{ candidateIndex: 0, status: 'pending', reason: 'Unresolved date.' }] } };
      throw Object.assign(new Error('Completed repair response failed.'), receipt,
        { code: mode === 'output-limit' ? 'MAX_TOKENS' : 'MEMORY_PROVIDER_TRANSPORT_EXHAUSTED' });
    }
    return { ...receipt, output: extractionModelFixture({ results: [{ candidateIndex: 0, status: 'repaired',
      memories: [generatedEventCandidate({ sourceRefs: ['M0001'] })] }] }) };
  };
  const run = () => withUsageRecorder(charge => charges.push(charge), () => retryCompanionExtractionRepair({
    repository: f.repository, agentId: AGENT_ID, task, identity: IDENTITY, generator,
    usageLedgerPath: path.join(os.tmpdir(), 'repair-owner-unused.jsonl'), executionTime: new Date('2026-11-10T00:00:00Z'),
    completedAt: '2026-11-10T00:00:00Z' }));
  if (mode === 'archive-failure') {
    const review = f.repository.reviewMaintenanceTaskFailure.bind(f.repository);
    f.repository.reviewMaintenanceTaskFailure = () => { throw new Error('temporary repair archive failure'); };
    await assert.rejects(run, /temporary repair archive failure/);
    assert.equal(charges.length, 1);
    assert.equal(f.repository.getMaintenanceTask(AGENT_ID, task.id).review_state, 'pending');
    f.repository.reviewMaintenanceTaskFailure = review;
    await run();
    assert.deepEqual(charges.map(charge => charge.requestId), ['repair-1', 'repair-2']);
    assert.equal(charges.reduce((sum, charge) => sum + charge.usage.prompt_tokens, 0), 24);
  } else if (mode === 'output-limit') {
    await assert.rejects(run, { code: 'MAX_TOKENS' });
    assert.deepEqual(charges.map(charge => [charge.requestId, charge.usage.prompt_tokens]),
      [['repair-1', 11], ['repair-2', 13]]);
    assert.equal(charges[1].metadata.failed, true);
  } else {
    const result = await run();
    assert.deepEqual(charges.map(charge => [charge.requestId, charge.usage.prompt_tokens]),
      mode === 'success' ? [['repair-1', 11]] : [['repair-1', 11], ['repair-2', 13]]);
    assert.equal(result.generationDiagnostics.degraded, mode !== 'success');
  }
});

test('extraction billing preserves each physical receipt and its cache token units', async t => {
  const f = repositoryFixture();
  t.after(() => f.database.close());
  appendCompanionEvents({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const usages = [
    { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens: 1 },
    { prompt_tokens: 200, prompt_tokens_details: { cached_tokens: 50 }, completion_tokens: 2 },
    { prompt_cache_miss_tokens: 30, prompt_cache_hit_tokens: 70, completion_tokens: 3 },
  ];
  const charges = [];
  let calls = 0;
  const result = await withUsageRecorder(charge => charges.push(charge), () => processPendingCompanionEvents({
    repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
    usageLedgerPath: path.join(os.tmpdir(), 'physical-receipt-unused.jsonl'), generator: async () => {
      const call = calls++;
      return { model: 'deepseek-v4-pro', requestId: `cache-${call + 1}`, usage: usages[call],
        output: extractionModelFixture(call === 0
          ? { memories: [generatedEventCandidate({ sourceRefs: ['M0001'], eventDate: 'invalid' })] }
          : { results: [{ candidateIndex: 0, ...(call === 1
            ? { status: 'pending', reason: 'Still checking source date.' }
            : { status: 'repaired', memories: [generatedEventCandidate({ sourceRefs: ['M0001'] })] }) }] }) };
    } }));
  assert.equal(result.generationDiagnostics.repaired, true);
  assert.equal(calls, 3);
  assert.deepEqual(charges.map(charge => charge.requestId), ['cache-1', 'cache-2', 'cache-3']);
  assert.deepEqual(charges.map(charge => charge.usage), usages);
  assert.deepEqual(charges.map(charge => charge.units), [
    { inputUncachedTokens: 20, inputCachedTokens: 80, outputTextTokens: 1 },
    { inputUncachedTokens: 150, inputCachedTokens: 50, outputTextTokens: 2 },
    { inputUncachedTokens: 30, inputCachedTokens: 70, outputTextTokens: 3 },
  ]);
  const total = charges.reduce((sum, charge) => sum + calculateCost(charge).amountCny, 0);
  const expected = calculateCost({ model: 'deepseek-v4-pro', timestamp: charges[0].timestamp,
    units: { inputUncachedTokens: 200, inputCachedTokens: 200, outputTextTokens: 6 } }).amountCny;
  assert.ok(Math.abs(total - expected) < 1e-12);
});

for (const stage of ['initial', 'repair']) test(`extraction bills a completed physical receipt before an abort guard: ${stage}`, async t => {
  const f = repositoryFixture();
  t.after(() => f.database.close());
  appendCompanionEvents({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const controller = new AbortController();
  const charges = [];
  let calls = 0;
  await assert.rejects(withUsageRecorder(charge => charges.push(charge), () => withEventSourceExecution(f.repository,
    () => processPendingCompanionEvents({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
      usageLedgerPath: path.join(os.tmpdir(), 'abort-receipt-unused.jsonl'), generator: async () => {
        const receipt = { model: 'fixture', requestId: `physical-${++calls}`, usage: { prompt_tokens: 7 } };
        if (stage === 'repair' && calls === 1) return { ...receipt,
          output: extractionModelFixture({ memories: [generatedEventCandidate({ sourceRefs: ['M0001'], eventDate: 'invalid' })] }) };
        controller.abort();
        return { ...receipt, output: stage === 'initial' ? { memories: [] }
          : { results: [{ candidateIndex: 0, status: 'pending', reason: 'Late response.' }] } };
      } }), { signal: controller.signal })), { name: 'AbortError' });
  assert.equal(calls, stage === 'initial' ? 1 : 2);
  assert.deepEqual(charges.map(charge => charge.requestId), Array.from({ length: calls }, (_, i) => `physical-${i + 1}`));
  assert.equal(charges.reduce((sum, charge) => sum + charge.usage.prompt_tokens, 0), calls * 7);
  assert.equal(f.repository.listMemories(AGENT_ID).total, 0);
});

test('the ingestion billing boundary preserves generator capabilities and call arguments', async () => {
  const receiver = { owner: 'provider' };
  const request = { input: 'Complete model material.' };
  const budgetError = Object.assign(new Error('Provider budget rejects the complete request.'), { code: 'FIXTURE_BUDGET' });
  const generator = async function (received, extra) {
    assert.equal(this, receiver);
    assert.equal(received, request);
    assert.equal(extra, 'same extra argument');
    return { output: {}, usage: {} };
  };
  const capability = Symbol('provider-capability');
  Object.defineProperty(generator, 'assertRequestBudget', { value: () => { throw budgetError; } });
  generator[capability] = { complete: true };
  const wrapped = processingStages.recordingCompanionEventGenerator({ generator, warnings: [] });
  assert.equal(wrapped.assertRequestBudget, generator.assertRequestBudget);
  assert.equal(wrapped[capability], generator[capability]);
  assert.throws(() => wrapped.assertRequestBudget(request), error => error === budgetError);
  assert.deepEqual(await wrapped.call(receiver, request, 'same extra argument'), { output: {}, usage: {} });
});

test('ordinary extraction charges both responses once when archive storage fails before retry', async t => {
  const f = repositoryFixture();
  t.after(() => f.database.close());
  appendCompanionEvents({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const complete = f.repository.completeInputBatch.bind(f.repository);
  let rejectArchive = true;
  f.repository.completeInputBatch = (agentId, batchId, options) => {
    if (options.success && rejectArchive) { rejectArchive = false; throw new Error('temporary archive failure'); }
    return complete(agentId, batchId, options);
  };
  const charges = [];
  let calls = 0;
  const run = () => withUsageRecorder(charge => charges.push(charge), () => processPendingCompanionEvents({
    repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
    usageLedgerPath: path.join(os.tmpdir(), 'ingestion-owner-unused.jsonl'), generator: async () => ({
      model: 'fixture', requestId: `ordinary-${++calls}`, usage: { prompt_tokens: 7 }, output: { memories: [] } }) }));
  await assert.rejects(run, /temporary archive failure/);
  assert.equal(charges.length, 1);
  assert.equal((await run()).status, 'processed');
  assert.deepEqual(charges.map(charge => charge.requestId), ['ordinary-1', 'ordinary-2']);
  assert.equal(charges.reduce((sum, charge) => sum + charge.usage.prompt_tokens, 0), 14);
});

test('memory overrides use the same source-time validation', async () => {
  const wrong = generatedEventCandidate({ sourceRefs: ['M0001'], eventDate: '', eventStart: '', content: 'User finished the design yesterday.' });
  await assert.rejects(generateCompanionEventBatch({ identity: IDENTITY, events: [event()], memoriesOverride: extractionModelFixture([wrong]) }),
    { code: 'MEMORY_EXTRACTION_TIME_CONFLICT' });
});

test("normalizes one primary user and one companion while allowing third-party event persons", () => {
  const normalized = normalizeCompanionEvent(event({
    participants: [{ role: "other", id: "museum-guide", name: "讲解员" }],
  }), IDENTITY);
  assert.equal(normalized.world.frame, "relational");
  assert.deepEqual(
    normalized.participants.map(({ role, id }) => ({ role, id })),
    [
      { role: "other", id: "museum-guide" },
      { role: "user", id: "user" },
      { role: "companion", id: AGENT_ID },
    ],
  );
  assert.throws(
    () => normalizeCompanionEvent(event({
      participants: [{ role: "user", id: "another-user", name: "其他用户" }],
    }), IDENTITY),
    /second primary user/u,
  );
  assert.throws(
    () => normalizeCompanionEvent(event({
      participants: [{ role: "companion", id: "another-companion", name: "其他陪伴者" }],
    }), IDENTITY),
    /second companion/u,
  );
});

test('omitted targets and empty optional time fields need no paid repair call', async () => {
  const output = extractionModelFixture({ memories: [
    generatedEventCandidate({ sourceRefs: ['M0001'], eventDate: '', eventStart: '' }),
    generatedEventCandidate({ kind: 'preference', title: '喜欢薰衣草香味', content: 'User 明确说喜欢薰衣草香味。',
      subjectRole: 'user', subjectName: 'User', canonicalKey: 'lavender', stateFamily: 'preference',
      stateLabel: '薰衣草香味', sourceRefs: ['M0001'], eventDate: '', eventStart: '' }),
  ] });
  output.memories[0].time = { date: null, start: null, end: null };
  output.memories[1].time = {};
  const original = structuredClone(output);
  let calls = 0;
  const generated = await generateCompanionEventBatch({ events: [event()], identity: IDENTITY,
    generator: async ({ schemaName }) => {
      calls++;
      assert.equal(schemaName, 'long-term-memory-extraction-v4');
      return { output, usage: {} };
    } });
  assert.equal(calls, 1);
  assert.deepEqual(generated.generation.output.memories.map(m => m.title), ['共同完成事件入口设计', '喜欢薰衣草香味']);
  for (const memory of generated.generation.output.memories) {
    assert.equal(Object.hasOwn(memory, 'stateTarget'), false);
    assert.equal(memory.eventDate, '');
    assert.equal(memory.eventStart, '');
    assert.equal(memory.eventEnd, '');
  }
  assert.deepEqual(output, original);
});

test("repairs one schema-valid JSON object that fails strict extraction validation", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).items;
  const schemas = [];
  const generator = async ({ input, schemaName }) => {
    schemas.push(schemaName);
    if (schemaName === "long-term-memory-extraction-v4") {
      return {
        output: extractionModelFixture({ memories: [generatedEventCandidate({ sourceRefs: ["M0001"], eventDate: "August 4, 2026" })] }),
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        durationMs: 10,
        requestId: "initial-request",
        metadata: { schemaName },
      };
    }
    assert.match(input, /time.date.*YYYY-MM-DD/u);
    return {
      output: extractionModelFixture({ results: [{ candidateIndex: 0, status: "repaired", memories: [generatedEventCandidate({ sourceRefs: ["M0001"] })] }] }),
      usage: { prompt_tokens: 4, completion_tokens: 2 },
      durationMs: 5,
      requestId: "repair-request",
      metadata: { schemaName },
    };
  };
  const generated = await generateCompanionEventBatch({
    events: pending,
    identity: IDENTITY,
    generator,
  });
  assert.deepEqual(schemas, [
    "long-term-memory-extraction-v4",
    "long-term-memory-extraction-repair-v5",
  ]);
  assert.equal(generated.generation.output.memories[0].eventDate, "2026-08-04");
  assert.deepEqual(generated.generation.usage, { prompt_tokens: 14, completion_tokens: 7 });
  assert.equal(generated.generation.durationMs, 15);
  assert.equal(generated.generation.metadata.repaired, true);
  assert.equal(generated.generation.metadata.initialRequestId, "initial-request");
  database.close();
});

test("keeps the repair pass in the source language of the invalid candidate", async () => {
  const { database, repository } = repositoryFixture();
  const englishEvent = event({
    content: { text: "I painted a sunrise last year." },
  });
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: englishEvent });
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).items;
  let repairPrompt = "";
  const generated = await generateCompanionEventBatch({
    events: pending,
    identity: IDENTITY,
    generator: async ({ schemaName, systemPrompt }) => {
      if (schemaName === "long-term-memory-extraction-v4") {
        return {
          output: extractionModelFixture({ memories: [generatedEventCandidate({ sourceRefs: ["M0001"], eventDate: "August 4, 2026" })] }),
          usage: {},
        };
      }
      repairPrompt = systemPrompt;
      return {
        output: extractionModelFixture({ results: [{ candidateIndex: 0, status: "repaired", memories: [generatedEventCandidate({ sourceRefs: ["M0001"] })] }] }),
        usage: {},
      };
    },
  });
  assert.equal(generated.generation.metadata.repaired, true);
  assert.match(repairPrompt, /M0001=en/u);
  assert.match(repairPrompt, /write them in English/u);
  database.close();
});

test("retains individually valid candidates when one repair cannot satisfy domain rules", async () => {
  const invalid = generatedEventCandidate({ eventDate: "August 4, 2026" });
  const valid = generatedEventCandidate({ title: "有效候选", sourceRefs: ["M0001"] });
  let calls = 0;
  const generator = async () => {
    calls += 1;
    return {
      output: extractionModelFixture(calls === 1 ? { memories: [valid, invalid] } : { results: [{ candidateIndex: 1, status: "repaired", memories: [invalid] }] }),
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      durationMs: 4,
      requestId: `request-${calls}`,
      metadata: { schemaName: calls === 1 ? "initial" : "repair" },
    };
  };
  const generated = await generateCompanionEventBatch({
    events: [event()],
    identity: IDENTITY,
    generator,
  });
  assert.equal(calls, 4);
  assert.equal(generated.generation.output.memories.length, 1);
  assert.equal(generated.generation.output.memories[0].title, "有效候选");
  assert.deepEqual(generated.generation.usage, { prompt_tokens: 12, completion_tokens: 8 });
  assert.equal(generated.generation.metadata.repaired, false);
  assert.equal(generated.generation.metadata.salvaged, true);
  assert.equal(generated.generation.metadata.salvageSource, "initial");
  assert.equal(generated.generation.metadata.rejectedCandidates.length, 4);
  assert.deepEqual(
    generated.generation.metadata.rejectedCandidates.map((item) => item.stage),
    ["initial", "repair", "repair", "repair"],
  );
  assert.match(generated.generation.metadata.repairValidationError, /time.date/u);
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 1);
  assert.equal(generated.generation.metadata.candidateValidationIncomplete, true);
});

test("never lets a repair response delete candidates that were already valid", async () => {
  const invalid = generatedEventCandidate({ eventDate: "August 4, 2026" });
  const valid = generatedEventCandidate({ title: "必须保留的有效候选", sourceRefs: ["M0001"] });
  let calls = 0;
  const generated = await generateCompanionEventBatch({
    events: [event()],
    identity: IDENTITY,
    generator: async () => {
      calls += 1;
      return {
        output: extractionModelFixture(calls === 1 ? { memories: [valid, invalid] } : { results: [] }),
        usage: {},
      };
    },
  });
  assert.equal(calls, 4);
  assert.deepEqual(
    generated.generation.output.memories.map((candidate) => candidate.title),
    ["必须保留的有效候选"],
  );
  assert.equal(generated.generation.metadata.repaired, false);
  assert.equal(generated.generation.metadata.initialValidCandidateCount, 1);
  assert.equal(generated.generation.metadata.initialInvalidCandidateCount, 1);
  assert.equal(generated.generation.metadata.finalCandidateCount, 1);
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 1);
  assert.equal(generated.generation.metadata.candidateValidationIncomplete, true);
});

for (const language of ['zh', 'en']) test('retries only omitted candidate indices: ' + language, async t => {
  const valid = generatedEventCandidate({ title: 'Already valid', sourceRefs: ['M0001'] });
  const first = generatedEventCandidate({ title: 'First', sourceRefs: ['M0001'] });
  const second = generatedEventCandidate({ title: 'Second', sourceRefs: ['M0001'] });
  const invalid = memory => { const { revisionAction, ...rest } = memory; return rest; };
  const requests = [];
  const generated = await generateCompanionEventBatch({ events: [event({ content: {
    text: language === 'en' ? 'I went to a parade and it inspired me to help others.' : '我参加了游行，这激励我去帮助别人。',
  } })], identity: IDENTITY, generator: async request => {
    requests.push(request);
    if (requests.length === 1) return { output: extractionModelFixture({ memories: [valid, invalid(first), invalid(second)] }), usage: { prompt_tokens: 3 } };
    const input = JSON.parse(request.input);
    assert.equal(input.sourceMessages.length, 1);
    assert.match(request.systemPrompt, new RegExp('M0001=' + language));
    if (requests.length === 2) {
      assert.deepEqual(input.candidates.map(item => item.candidateIndex), [1, 2]);
      return { output: extractionModelFixture({ results: [{ candidateIndex: 2, status: 'repaired', memories: [second] }] }), usage: { prompt_tokens: 2 } };
    }
    assert.deepEqual(input.candidates.map(item => item.candidateIndex), [1]);
    return { output: extractionModelFixture({ results: [{ candidateIndex: 1, status: 'repaired', memories: [first] }] }), usage: { prompt_tokens: 1 } };
  } });
  assert.equal(requests.length, 3);
  assert.deepEqual(generated.generation.output.memories.map(item => item.title), ['Already valid', 'Second', 'First']);
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
  assert.equal(generated.generation.metadata.repairValidCandidateCount, 2);
  assert.equal(generated.generation.usage.prompt_tokens, 6);
  const f = repositoryFixture();
  t.after(() => f.database.close());
  const archived = archiveLongTermEvidence({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
    messages: generated.messages, generatedMemories: generated.generation.output.memories,
    batchId: 'out-of-order-repair', recordedAt: '2026-08-04T03:00:00.000Z' });
  assert.deepEqual(archived.candidateResults.map(item => item.candidateIndex), [0, 1, 2]);
  assert.deepEqual(archived.candidateResults.map(item => item.candidate.title), ['Already valid', 'Second', 'First']);
});

for (const language of ['zh', 'en']) test('repairs one candidate into independent event and preference memories: ' + language, async t => {
  const visit = generatedEventCandidate({ title: 'Museum visit', sourceRefs: ['M0001'],
    subjectRole: 'user', subjectName: 'User',
    actorRoles: [{ role: 'experiencer', actorRole: 'user', actorName: 'User', confidence: 1 }],
    content: language === 'en' ? 'User visited the museum.' : 'User 参观了博物馆。' });
  const preference = { ...visit, kind: 'preference', title: 'Reading preference', stateFamily: 'preference',
    stateLabel: 'Reading', canonicalKey: 'reading', temporalState: 'current',
    content: language === 'en' ? 'User likes reading.' : 'User 喜欢阅读。' };
  let calls = 0;
  const generated = await generateCompanionEventBatch({ identity: IDENTITY, events: [event({ content: {
    text: language === 'en' ? 'I visited the museum. I also like reading.' : '我参观了博物馆。我也喜欢阅读。',
  } })], generator: async request => {
    if (++calls === 1) return { output: extractionModelFixture({ memories: [{ ...visit, kind: 'invalid-kind' }] }) };
    assert.deepEqual(JSON.parse(request.input).candidates.map(item => item.candidateIndex), [0]);
    return { output: extractionModelFixture({ results: [{ candidateIndex: 0, status: 'repaired', memories: [visit, preference] }] }) };
  } });
  assert.equal(calls, 2);
  assert.deepEqual(generated.generation.output.memories.map(({ kind, content, sourceRefs }) => ({ kind, content, sourceRefs })), [visit, preference].map(({ kind, content, sourceRefs }) => ({ kind, content, sourceRefs })));
  assert.equal(generated.generation.metadata.repairValidCandidateCount, 1);
  assert.equal(generated.generation.metadata.finalCandidateCount, 2);
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
  const f = repositoryFixture();
  t.after(() => f.database.close());
  const archived = archiveLongTermEvidence({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
    messages: generated.messages, generatedMemories: generated.generation.output.memories,
    batchId: 'split-repair', recordedAt: '2026-08-04T03:00:00.000Z' });
  assert.deepEqual(archived.candidateResults.map(item => item.status), ['created', 'analysis_pending']);
  assert.equal(new Set(archived.candidateResults.map(item => item.ingestionDecisionId)).size, 2);
});

test('duplicate or unrequested indices cannot change pending candidates or their entity declarations', async () => {
  const entities = [{ ref: 'E1', kind: 'place', name: 'Paris', aliases: [] }];
  const memory = { ...extractionModelFixture({ memories: [generatedEventCandidate({ sourceRefs: ['M0001'], content: 'User visited Paris.' })] }).memories[0], entityRefs: ['E1'] };
  const invalid = { ...memory, time: { date: 'last week' } };
  let calls = 0;
  const laterInputs = [];
  const generated = await generateCompanionEventBatch({ events: [event({ content: { text: memory.content } })], identity: IDENTITY,
    generator: async request => {
      if (++calls === 1) return { output: { entities, memories: [invalid, invalid] } };
      const result = index => ({ candidateIndex: index, status: 'repaired', memories: [memory] });
      if (calls === 2) return { output: { entities: [{ ref: 'E1', kind: 'person', name: 'Mallory', aliases: [] }], results: [result(0), result(0), result(99)] } };
      const input = JSON.parse(request.input);
      laterInputs.push(input);
      if (calls === 3) return { output: { entities, results: [result(0), { candidateIndex: 1, status: 'pending', reason: 'Still unresolved.' }] } };
      return { output: { entities, results: [result(1)] } };
    } });
  assert.equal(calls, 4);
  assert.deepEqual(laterInputs.map(input => input.candidates.map(item => item.candidateIndex)), [[0, 1], [1]]);
  assert.ok(laterInputs.every(input => input.entities[0].name === 'Paris' && input.entities[0].kind === 'place'));
  assert.equal(generated.generation.metadata.repairValidCandidateCount, 2);
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
});

test('explicit rejections are recorded and do not require another repair attempt', async () => {
  let calls = 0;
  const generated = await generateCompanionEventBatch({ events: [event()], identity: IDENTITY,
    generator: async () => ++calls === 1
      ? { output: extractionModelFixture({ memories: [generatedEventCandidate({ eventDate: 'not a date' })] }) }
      : { output: extractionModelFixture({ results: [{ candidateIndex: 0, status: 'rejected', reason: 'The source does not support this experience.' }] }) } });
  assert.equal(calls, 2);
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
  assert.deepEqual(generated.generation.metadata.repairRejectedCandidates,
    [{ index: 0, reason: 'The source does not support this experience.' }]);
});

test('repair transport failure preserves valid candidates without retrying the exhausted provider', async () => {
  const valid = generatedEventCandidate({ title: 'Keep this event' });
  let calls = 0;
  const generated = await generateCompanionEventBatch({ events: [event()], identity: IDENTITY,
    generator: async () => {
      if (++calls === 1) return { output: extractionModelFixture({ memories: [valid, { ...valid, eventDate: 'invalid' }] }), usage: { prompt_tokens: 5 } };
      throw Object.assign(new Error('Provider transport exhausted.'), { code: 'MEMORY_PROVIDER_TRANSPORT_EXHAUSTED', usage: { prompt_tokens: 2 } });
    } });
  assert.equal(calls, 2);
  assert.deepEqual(generated.generation.output.memories.map(({ kind, content, sourceRefs }) => ({ kind, content, sourceRefs })), [valid].map(({ kind, content, sourceRefs }) => ({ kind, content, sourceRefs })));
  assert.deepEqual(generated.generation.metadata.extractionRepair.candidates.map(item => item.index), [1]);
  assert.equal(generated.generation.usage.prompt_tokens, 7);
});

test('repairs missing source references using the supplied batch sources', async () => {
  const corrected = generatedEventCandidate({ sourceRefs: ['M0001'] });
  let calls = 0;
  const generated = await generateCompanionEventBatch({ events: [event()], identity: IDENTITY,
    generator: async request => {
      if (++calls === 1) return { output: extractionModelFixture({ memories: [{ ...corrected, sourceRefs: [] }] }) };
      assert.equal(JSON.parse(request.input).sourceMessages[0].ref, 'M0001');
      return { output: extractionModelFixture({ results: [{ candidateIndex: 0, status: 'repaired', memories: [corrected] }] }) };
    } });
  assert.equal(calls, 2);
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
});

for (const language of ['zh', 'en']) test('repairs incorrect citations from the supplied source messages: ' + language, async () => {
  const corrected = generatedEventCandidate({ sourceRefs: ['M0002'], subjectRole: 'user', subjectName: 'User',
    actorRoles: [{ role: 'experiencer', actorRole: 'user', actorName: 'User', confidence: 1 }],
    content: language === 'en' ? 'User visited the museum.' : 'User 参观了博物馆。' });
  let calls = 0;
  const generated = await generateCompanionEventBatch({ identity: IDENTITY, events: [
    event({ eventId: 'citation-context', content: { text: language === 'en' ? 'Good morning.' : '早上好。' } }),
    event({ eventId: 'citation-evidence', content: { text: language === 'en' ? 'I visited the museum.' : '我参观了博物馆。' } }),
  ], generator: async request => {
    if (++calls === 1) return { output: extractionModelFixture({ memories: [{ ...corrected, sourceRefs: ['M0999'], kind: 'invalid-kind' }] }) };
    assert.deepEqual(JSON.parse(request.input).sourceMessages.map(message => message.ref), ['M0001', 'M0002']);
    return { output: extractionModelFixture({ results: [{ candidateIndex: 0, status: 'repaired', memories: [corrected] }] }) };
  } });
  assert.equal(calls, 2);
  assert.deepEqual(generated.generation.output.memories.map(({ kind, content, sourceRefs }) => ({ kind, content, sourceRefs })), [corrected].map(({ kind, content, sourceRefs }) => ({ kind, content, sourceRefs })));
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
});

test('corrects a citation to supplied evidence while rejecting an unseen source', async () => {
  const first = generatedEventCandidate({ title: 'Museum visit', sourceRefs: ['M0002'] });
  const second = generatedEventCandidate({ title: 'Concert visit', sourceRefs: ['M0002'] });
  let calls = 0;
  const generated = await generateCompanionEventBatch({ identity: IDENTITY, events: [
    event({ eventId: 'unrelated-citation', content: { text: 'Good morning.' } }),
    event({ eventId: 'supplied-citation', content: { text: 'We visited the museum and attended a concert.' } }),
  ], generator: async request => {
    if (++calls === 1) return { output: extractionModelFixture({ memories: [
      { ...first, sourceRefs: ['M0001'], kind: 'invalid-kind' }, { ...second, kind: 'invalid-kind' },
    ] }) };
    const input = JSON.parse(request.input);
    if (calls === 2) {
      assert.deepEqual(input.sourceMessages.map(message => message.ref), ['M0001', 'M0002']);
      return { output: extractionModelFixture({ results: [
        { candidateIndex: 0, status: 'repaired', memories: [first] },
        { candidateIndex: 1, status: 'repaired', memories: [{ ...second, sourceRefs: ['M0003'] }] },
      ] }) };
    }
    assert.deepEqual(input.candidates.map(item => item.candidateIndex), [1]);
    assert.deepEqual(input.sourceMessages.map(message => message.ref), ['M0001', 'M0002']);
    return { output: extractionModelFixture({ results: [{ candidateIndex: 1, status: 'repaired', memories: [second] }] }) };
  } });
  assert.equal(calls, 3);
  assert.deepEqual(generated.generation.output.memories.map(({ kind, content, sourceRefs }) => ({ kind, content, sourceRefs })), [first, second].map(({ kind, content, sourceRefs }) => ({ kind, content, sourceRefs })));
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
});

test('recovers an unparseable initial response through the same indexed repair contract', async () => {
  let calls = 0;
  const generated = await generateCompanionEventBatch({ events: [event()], identity: IDENTITY,
    generator: async request => {
      if (++calls === 1) return { output: extractionModelFixture('truncated JSON') };
      const input = JSON.parse(request.input);
      assert.equal(input.candidates[0].candidate, null);
      assert.equal(input.candidates[0].rawOutput, 'truncated JSON');
      return { output: extractionModelFixture({ results: [{ candidateIndex: 0, status: 'repaired', memories: [generatedEventCandidate({ sourceRefs: ['M0001'] })] }] }) };
    } });
  assert.equal(calls, 2);
  assert.equal(generated.generation.output.memories.length, 1);
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
});

test('repairs each invalid candidate against its own family contract and reports complete recovery', async () => {
  const valid = generatedEventCandidate({ sourceRefs: ['M0001'] });
  const preference = generatedEventCandidate({ kind: 'preference', stateFamily: 'preference', stateLabel: '阅读偏好',
    canonicalKey: 'reading', sourceRefs: ['M0001'] });
  const goal = generatedEventCandidate({ kind: 'plan', stateFamily: 'goal', stateLabel: '阅读计划',
    canonicalKey: 'reading-plan', sourceRefs: ['M0001'] });
  let calls = 0;
  const generated = await generateCompanionEventBatch({ events: [event()], identity: IDENTITY,
    generator: async request => {
      if (++calls === 1) return { output: extractionModelFixture({ memories: [valid,
        { ...preference, stateTarget: { objectRole: 'world', objectName: '阅读' } },
        { ...goal, kind: 'belief_state' }] }), usage: {} };
      const input = JSON.parse(request.input);
      assert.equal(input.candidates.length, 2);
      assert.deepEqual(input.candidates.map(item => item.candidateIndex), [1, 2]);
      assert.match(input.candidates[0].validationError, /不适用：target/u);
      assert.match(input.candidates[1].validationError, /classification.category 无效/u);
      return { output: extractionModelFixture({ results: [preference, goal].map((memory, index) => ({ candidateIndex: index + 1, status: "repaired", memories: [memory] })) }), usage: {} };
    } });
  assert.equal(calls, 2);
  assert.equal(generated.generation.output.memories.length, 3);
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
  assert.equal(generated.generation.metadata.candidateValidationIncomplete, false);
});

for (const language of ['en', 'zh']) for (const role of ['user', 'companion']) {
  test('stores a source-supported joint event with one speaker: ' + language + '/' + role, async t => {
    const f = repositoryFixture();
    t.after(() => f.database.close());
    const ownName = role === 'user' ? 'User' : 'Companion';
    const subjectRole = role === 'user' ? 'user' : 'agent';
    const otherName = role === 'user' ? 'Companion' : 'User';
    const otherRole = role === 'user' ? 'agent' : 'user';
    const text = language === 'en' ? 'I went to the museum with you yesterday.' : '我昨天和你一起去了博物馆。';
    const appended = appendCompanionEvents({ ...f, agentId: AGENT_ID, identity: IDENTITY,
      events: event({ actor: { role, id: role === 'user' ? 'user' : AGENT_ID, name: ownName }, content: { text } }) });
    const candidate = generatedEventCandidate({ subjectRole, subjectName: ownName,
      content: ownName + ' and ' + otherName + ' went to the museum together.',
      actorRoles: [{ role: 'experiencer', actorRole: subjectRole, actorName: ownName, confidence: 1 },
        { role: 'participant', actorRole: otherRole, actorName: otherName, confidence: 1 }], sourceRefs: ['M0001'] });
    let calls = 0;
    const generated = await generateCompanionEventBatch({ events: appended.events, identity: IDENTITY,
      generator: async () => { calls++; return { output: extractionModelFixture({ memories: [candidate] }) }; } });
    assert.equal(calls, 1);
    const archived = archiveLongTermEvidence({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
      messages: generated.messages, generatedMemories: generated.generation.output.memories,
      batchId: 'joint-event', recordedAt: '2026-08-04T03:00:00.000Z' });
    assert.equal(archived.candidateResults[0].status, 'created');
    const detail = f.repository.getMemoryDetail(AGENT_ID, archived.candidateResults[0].memoryId);
    assert.equal(detail.sources[0].authority, 'subject_firsthand');
    assert.ok(detail.roles.some(actor => actor.role === 'participant' && actor.actor_role === otherRole));
  });
}

test('a non-state fact classification error is repaired before asking for a state key', async () => {
  const corrected = generatedEventCandidate({ title: 'Friend adopted a child',
    content: 'User said a friend adopted a child last year.', subjectRole: 'user', subjectName: 'User',
    actorRoles: [{ role: 'experiencer', actorRole: 'user', actorName: 'User', confidence: 0.9 }],
    sourceRefs: ['M0001'], eventDate: '', eventStart: '' });
  const invalid = { ...corrected, kind: 'fact' };
  let calls = 0;
  const generated = await generateCompanionEventBatch({ events: [event({
    content: { text: 'A friend adopted a child last year.' },
  })], identity: IDENTITY, generator: async request => {
    if (++calls === 1) return { output: extractionModelFixture({ memories: [invalid] }) };
    const input = JSON.parse(request.input);
    assert.match(input.candidates[0].validationError, /classification.category 无效/u);
    assert.doesNotMatch(input.candidates[0].validationError, /canonicalKey/u);
    return { output: extractionModelFixture({ results: [{ candidateIndex: 0, status: "repaired", memories: [corrected] }] }) };
  } });
  assert.equal(calls, 2);
  assert.equal(generated.generation.output.memories[0].kind, 'event');
  assert.equal(generated.generation.metadata.unresolvedCandidateCount, 0);
});

test("corrects known participant roles from host identity before evidence gates", async () => {
  const generated = await generateCompanionEventBatch({
    events: [event({
      actor: { role: "companion", id: AGENT_ID, name: "Companion" },
      content: { text: "我刚才整理完了事件入口。" },
    })],
    identity: IDENTITY,
    generator: async () => ({
      output: extractionModelFixture({
        memories: [generatedEventCandidate({
          subjectRole: "user",
          subjectName: "Companion",
          actorRoles: [
            { role: "experiencer", actorRole: "user", actorName: "Companion", confidence: 1 },
          ],
          sourceRefs: ["M0001"],
        })],
      }),
      usage: {},
    }),
  });
  assert.equal(generated.generation.output.memories[0].subjectRole, "agent");
  assert.equal(generated.generation.output.memories[0].actorRoles[0].actorRole, "agent");
  assert.equal(generated.generation.output.memories.length, 1);
  assert.deepEqual(generated.generation.output.memories[0].actorRoles.map(actor => actor.actorName), ['Companion']);
});

test("appends events idempotently and rejects conflicting replays without producing memory", () => {
  const { database, repository } = repositoryFixture();
  const first = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event(),
  });
  const replay = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ recordedAt: "2026-08-04T03:00:00.000Z" }),
  });
  assert.equal(first.inserted, 1);
  assert.equal(replay.reused, 1);
  assert.equal(repository.listInputEvents(AGENT_ID).total, 1);
  assert.equal(repository.listMemories(AGENT_ID, { statuses: [] }).total, 0);
  assert.throws(
    () => appendCompanionEvents({
      repository,
      agentId: AGENT_ID,
      identity: IDENTITY,
      events: event({ content: { text: "同一个 id 却换了内容。" } }),
    }),
    (error) => error.code === "INPUT_EVENT_CONFLICT",
  );
  database.close();
});

test("supersedes a pending event append-only and claims only its replacement", () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const revised = reviseCompanionEvent({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    targetEventId: "event-1",
    action: "amend",
    reason: "The original message was edited by its author.",
    replacementEvent: event({
      eventId: "event-1-revision-2",
      content: { text: "我们今天重新确认了记忆系统的事件入口。" },
    }),
  });
  assert.equal(revised.wasInserted, true);
  assert.equal(repository.getInputEventByExternalId(AGENT_ID, "event-1").lifecycle, "superseded");
  const replay = reviseCompanionEvent({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    targetEventId: "event-1",
    action: "amend",
    reason: "The original message was edited by its author.",
    replacementEvent: event({
      eventId: "event-1-revision-2",
      content: { text: "我们今天重新确认了记忆系统的事件入口。" },
    }),
  });
  assert.equal(replay.wasInserted, false);
  const pipeline = repository.inspectInputPipeline(AGENT_ID);
  assert.deepEqual(pipeline.eventCounts, { pending: 1, processing: 0, archived: 0 });
  assert.deepEqual(pipeline.lifecycleCounts, { active: 1, superseded: 1, retracted: 0 });
  const claimed = repository.claimPendingInputEvents(AGENT_ID, { workerId: "revision-worker" });
  assert.deepEqual(claimed.events.map((item) => item.external_id), ["event-1-revision-2"]);
  database.close();
});

test("retracts archived evidence and removes memories that have no active source", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const processed = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: extractionModelFixture([]),
  });
  assert.equal(processed.status, "processed");
  const activeBefore = repository.listMemories(AGENT_ID, {
    statuses: ["active"],
    kinds: ["utterance"],
  }).items;
  assert.equal(activeBefore.length, 1);
  const revised = reviseCompanionEvent({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    targetEventId: "event-1",
    action: "retract",
    reason: "The source message was removed.",
  });
  assert.equal(revised.invalidatedSources, 1);
  assert.equal(revised.affectedMemories, 1);
  assert.equal(repository.getInputEventByExternalId(AGENT_ID, "event-1").lifecycle, "retracted");
  assert.equal(repository.getMemory(activeBefore[0].id).status, "deleted");
  assert.equal(repository.getMemoryDetail(AGENT_ID, activeBefore[0].id).sources[0].lifecycle, "retracted");
  assert.equal(repository.listMemories(AGENT_ID, { statuses: ["active"] }).total, 0);
  database.close();
});

test("rejects a revision while the target event is owned by a processing batch", () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  repository.claimPendingInputEvents(AGENT_ID, { workerId: "active-worker" });
  assert.throws(() => reviseCompanionEvent({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    targetEventId: "event-1",
    action: "retract",
  }), (error) => error.code === "INPUT_EVENT_REVISION_RACE");
  database.close();
});

test("fragments oversized events without losing text and keeps replay idempotency", () => {
  const { database, repository } = repositoryFixture();
  const text = '甲'.repeat(11) + '🌊' + '乙'.repeat(133);
  const first = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ eventId: "large-event", content: { text } }),
    maximumEventCharacters: 12,
  });
  const replay = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ eventId: "large-event", content: { text } }),
    maximumEventCharacters: 12,
  });
  assert.equal(first.accepted, 1);
  assert.ok(first.eventRecords > 1);
  assert.equal(replay.reused, first.eventRecords);
  assert.equal(first.events.map((item) => item.content.text).join(""), text);
  assert.equal(
    repository.listInputEvents(AGENT_ID, { statuses: ["pending"], limit: 100 }).items
      .map((item) => item.content.text).join(""),
    text,
  );
  assert.equal(first.events[0].external_id, "large-event");
  assert.deepEqual(
    first.events.map((item) => item.metadata.suzuMemoryFragment.index),
    first.events.map((_, index) => index + 1),
  );
  assert.throws(
    () => appendCompanionEvents({
      repository,
      agentId: AGENT_ID,
      identity: IDENTITY,
      events: event({ eventId: "large-event", content: { text: `${text}已改变` } }),
      maximumEventCharacters: 12,
    }),
    (error) => error.code === "INPUT_EVENT_CONFLICT",
  );
  database.close();
});

test("claims a fragmented logical event atomically instead of using the remaining batch tail", () => {
  const { database, repository } = repositoryFixture();
  const longText = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉";
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    maximumEventCharacters: 10,
    events: [
      event({
        eventId: "short-before-long",
        occurredAt: "2026-08-04T01:59:00.000Z",
        knownAt: "2026-08-04T01:59:00.000Z",
        content: { text: "12345678" },
      }),
      event({ eventId: "atomic-long-event", content: { text: longText } }),
    ],
  });
  const first = repository.claimPendingInputEvents(AGENT_ID, {
    maximumEvents: 100,
    maximumContentCharacters: 22,
    workerId: "first-worker",
  });
  assert.deepEqual(first.events.map((item) => item.external_id), ["short-before-long"]);
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 2);
  assert.deepEqual(
    pending.items.map((item) => item.metadata.suzuMemoryFragment.index),
    [1, 2],
  );
  const second = repository.claimPendingInputEvents(AGENT_ID, {
    maximumEvents: 100,
    maximumContentCharacters: 22,
    workerId: "second-worker",
  });
  assert.equal(second.events.length, 2);
  assert.equal(second.events.map((item) => item.content.text).join(""), longText);
  database.close();
});

test("quarantines an unprocessable logical event and continues to the next event", () => {
  const { database, repository } = repositoryFixture();
  const longText = "甲".repeat(26);
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    maximumEventCharacters: 10,
    events: [
      event({ eventId: "over-budget-logical-event", content: { text: longText } }),
      event({ eventId: "healthy-event-after-quarantine", content: { text: "后面的正常事件仍应被领取。" } }),
    ],
  });
  const claimed = repository.claimPendingInputEvents(AGENT_ID, {
    maximumEvents: 100,
    maximumContentCharacters: 20,
    workerId: "blocked-worker",
  });
  assert.equal(claimed.quarantined.length, 1);
  assert.equal(claimed.quarantined[0].code, "INPUT_EVENT_FRAGMENT_GROUP_TOO_LARGE");
  assert.equal(claimed.quarantined[0].details.fragmentCount, 3);
  assert.equal(claimed.quarantined[0].details.characterCount, longText.length);
  assert.equal(claimed.events.length, 2);
  assert.ok(claimed.events.every((item) => (
    item.external_id.startsWith("healthy-event-after-quarantine")
  )));
  assert.equal(
    claimed.events.map((item) => item.content.text).join(""),
    "后面的正常事件仍应被领取。",
  );
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 0);
  const quarantined = repository.listInputEvents(AGENT_ID, {
    statuses: ["archived"],
    limit: 100,
  }).items.filter((item) => item.processing_disposition === "quarantined");
  assert.equal(quarantined.length, 3);
  assert.ok(quarantined.every((item) => /Logical input event/u.test(item.last_error)));
  const review = repository.listMaintenanceTasks(AGENT_ID, {
    taskTypes: ["input-event-quarantine"],
    statuses: ["failed"],
  });
  assert.equal(review.length, 1);
  assert.equal(review[0].review_state, "pending");
  database.close();
});

test("claims only the oldest prefix within the auditable content budget", () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [
      event({ eventId: "budget-1", content: { text: "12345678" } }),
      event({ eventId: "budget-2", content: { text: "abcdefgh" } }),
    ],
  });
  const claimed = repository.claimPendingInputEvents(AGENT_ID, {
    maximumEvents: 2,
    maximumContentCharacters: 10,
    workerId: "budget-worker",
  });
  assert.equal(claimed.events.length, 1);
  assert.equal(claimed.events[0].external_id, "budget-1");
  assert.equal(claimed.batch.input_character_count, 8);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).total, 1);
  database.close();
});

test("quarantines a legacy oversized event instead of sending it to a model", () => {
  const { database, repository } = repositoryFixture();
  repository.appendInputEvent({
    agentId: AGENT_ID,
    externalId: "legacy-oversized",
    eventType: "conversation.turn",
    actorRole: "user",
    actorKey: "user",
    occurredAt: "2026-08-04T02:00:00.000Z",
    content: { text: "x".repeat(20) },
  });
  const claimed = repository.claimPendingInputEvents(AGENT_ID, {
    maximumContentCharacters: 10,
    workerId: "budget-worker",
  });
  assert.equal(claimed.batch, null);
  assert.equal(claimed.quarantined.length, 1);
  assert.equal(claimed.quarantined[0].code, "INPUT_EVENT_TOO_LARGE");
  assert.equal(claimed.quarantined[0].details.characterCount, 20);
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 0);
  const archived = repository.listInputEvents(AGENT_ID, { statuses: ["archived"] });
  assert.equal(archived.total, 1);
  assert.equal(archived.items[0].processing_disposition, "quarantined");
  assert.match(archived.items[0].last_error, /exceeding the 10-character/u);
  database.close();
});

test("keeps extraction as a separately testable stage without host context", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).items;
  const generated = await generateCompanionEventBatch({
    events: pending,
    identity: IDENTITY,
    memoriesOverride: extractionModelFixture([generatedEventCandidate({ sourceRefs: ["M0001"] })]),
  });
  assert.equal(generated.messages.length, 1);
  assert.equal(generated.generation.output.memories.length, 1);
  assert.equal(Object.hasOwn(generated.generation.output, "summary"), false);
  database.close();
});

test("uses boundary messages for interpretation without archiving or citing them again", async () => {
  const { database, repository } = repositoryFixture();
  const core = event({
    eventId: "archive-core",
    occurredAt: "2026-08-04T02:01:00.000Z",
    knownAt: "2026-08-04T02:01:00.000Z",
    content: { text: "我今天去了科技馆。" },
  });
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: core });
  let receivedInput = "";
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    previousContextEvents: [event({
      eventId: "read-only-previous",
      occurredAt: "2026-08-04T02:00:00.000Z",
      knownAt: "2026-08-04T02:00:00.000Z",
      actor: { role: "companion", id: AGENT_ID, name: "Companion" },
      content: { text: "你今天准备去哪里？" },
    })],
    continuationGuidanceEvents: [event({
      eventId: "read-only-guidance",
      occurredAt: "2026-08-04T02:02:00.000Z",
      knownAt: "2026-08-04T02:02:00.000Z",
      content: { text: "参观还没有结束。" },
    })],
    generator: async ({ input }) => {
      receivedInput = input;
      return { output: extractionModelFixture({ memories: [generatedEventCandidate({ sourceRefs: ["M0001"] })] }), usage: {} };
    },
  });
  assert.equal(result.messagesArchived, 1);
  assert.equal(result.previousContextMessages, 1);
  assert.equal(result.continuationGuidanceMessages, 1);
  assert.match(receivedInput, /只读的前文衔接/u);
  assert.match(receivedInput, /只读的后文衔接/u);
  const utterances = repository.listMemories(AGENT_ID, {
    statuses: [],
    kinds: ["utterance"],
  }).items;
  assert.deepEqual(utterances.map((item) => item.content), [core.content.text]);
  assert.doesNotMatch(JSON.stringify(repository.listMemories(AGENT_ID, { statuses: [] }).items), /准备去哪里|参观还没有结束/u);
  database.close();
});

test("shares one provider request across archive windows but rejects cross-window evidence", async () => {
  const { database, repository } = repositoryFixture();
  const first = event({ eventId: "window-event-1", content: { text: "第一件独立事情。" } });
  const second = event({
    eventId: "window-event-2",
    occurredAt: "2026-08-04T03:00:00.000Z",
    knownAt: "2026-08-04T03:00:00.000Z",
    content: { text: "第二件独立事情。" },
  });
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [first, second],
  });
  let requests = 0;
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    archiveWindows: [
      { id: "window-a", coreEventIds: [first.eventId] },
      { id: "window-b", coreEventIds: [second.eventId] },
    ],
    generator: async () => {
      requests += 1;
      return {
        output: extractionModelFixture({
          memories: [generatedEventCandidate({ sourceRefs: ["M0001", "M0002"] })],
        }),
        usage: {},
      };
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.archiveWindows, 2);
  assert.equal(result.messagesArchived, 2);
  assert.equal(result.candidateResults[0].status, "reject");
  assert.deepEqual(result.candidateResults[0].reasons, ["cross-window-evidence"]);
  const followedBy = database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_edges
    WHERE agent_id = ? AND relation = 'followed_by'
  `).get(AGENT_ID);
  assert.equal(Number(followedBy.count), 0);
  database.close();
});

test("preserves utterance order across budget splits only with explicit continuity", async () => {
  const { database, repository } = repositoryFixture();
  const first = event({ eventId: "continued-event-1", content: { text: "同一长会话的前半段。" } });
  const second = event({
    eventId: "continued-event-2",
    occurredAt: "2026-08-04T03:01:00.000Z",
    knownAt: "2026-08-04T03:01:00.000Z",
    actor: { role: "companion", id: AGENT_ID, name: "Companion" },
    content: { text: "同一长会话的后半段。" },
  });
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [first, second],
  });
  await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    archiveWindows: [
      { id: "split-a", continuityId: "conversation-1", coreEventIds: [first.eventId] },
      { id: "split-b", continuityId: "conversation-1", coreEventIds: [second.eventId] },
    ],
    memoriesOverride: extractionModelFixture([]),
  });
  const followedBy = database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_edges
    WHERE agent_id = ? AND relation = 'followed_by'
  `).get(AGENT_ID);
  assert.equal(Number(followedBy.count), 1);
  database.close();
});

test("reassembles every fragment before extraction and archives one complete utterance", async () => {
  const { database, repository } = repositoryFixture();
  const longText = "第一部分尚未说完。\n\n第二部分继续说明，第三部分才给出完整结论。";
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    maximumEventCharacters: 12,
    events: event({ eventId: "reassembled-event", content: { text: longText } }),
  });
  const pending = repository.listInputEvents(AGENT_ID, {
    statuses: ["pending"],
    limit: 100,
  }).items;
  const generated = await generateCompanionEventBatch({
    events: pending,
    identity: IDENTITY,
    memoriesOverride: extractionModelFixture([]),
  });
  assert.equal(generated.messages.length, 1);
  assert.equal(generated.messages[0].text, longText);
  assert.equal(generated.messages[0].inputEventIds.length, pending.length);
  assert.equal(generated.messages[0].logicalEvent.fragmentCount, pending.length);
  assert.equal(generated.input.split(longText).length - 1, 1);

  const processed = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    maximumContentCharacters: 100,
    memoriesOverride: extractionModelFixture([]),
  });
  assert.equal(processed.eventsProcessed, pending.length);
  assert.equal(processed.messagesArchived, 1);
  const utterances = repository.listMemories(AGENT_ID, {
    statuses: [],
    kinds: ["utterance"],
  }).items;
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].content, longText);
  const detail = repository.getMemoryDetail(AGENT_ID, utterances[0].id);
  assert.equal(detail.sources[0].metadata.logicalEvent.fragmentCount, pending.length);
  assert.deepEqual(detail.sources[0].metadata.inputEventIds, pending.map((item) => item.id));
  database.close();
});

test("processes a bilateral relationship-world batch without a host transcript", async () => {
  const { database, repository } = repositoryFixture();
  const identityStructure = ensureCompanionRelationshipStructure({
    repository,
    agentId: AGENT_ID,
    primaryUserId: IDENTITY.primaryUserId,
    primaryUserName: IDENTITY.primaryUserName,
    companionId: IDENTITY.companionId,
    companionName: IDENTITY.companionName,
  });
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [
      event(),
      event({
        eventId: "event-2",
        occurredAt: "2026-08-04T02:01:00.000Z",
        knownAt: "2026-08-04T02:01:00.000Z",
        actor: { role: "companion", id: AGENT_ID, name: "Companion" },
        content: { text: "我会把关系世界和物理事实分开记录。" },
      }),
    ],
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    now: new Date("2026-08-04T02:05:00.000Z"),
    memoriesOverride: extractionModelFixture([generatedEventCandidate()]),
  });
  assert.equal(result.status, "processed");
  assert.equal(result.eventsProcessed, 2);
  assert.equal(result.memoriesStored, 1);
  assert.equal(result.candidateResults[0].candidateIndex, 0);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 2);
  const memories = repository.listMemories(AGENT_ID, { statuses: [], limit: 20 }).items;
  assert.equal(memories.filter((memory) => memory.kind === "utterance").length, 2);
  const storedEvent = memories.find((memory) => memory.kind === "event");
  assert.ok(storedEvent);
  assert.equal(storedEvent.reality, "real");
  assert.equal(storedEvent.world_id, "relationship");
  assert.equal(storedEvent.world_frame, "relational");
  assert.equal(result.relationshipMemberships.status, "ready");
  assert.equal(result.relationshipMemberships.linked, 1);
  assert.equal(
    repository.listRelationshipMemories({
      agentId: AGENT_ID,
      relationshipId: identityStructure.relationship.id,
    })[0].id,
    storedEvent.id,
  );
  assert.equal(
    (await processPendingCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY })).status,
    "skipped",
  );
  database.close();
});

test("archives supplied primary identities with the same actor keys used by entity bindings", async () => {
  const { database, repository } = repositoryFixture();
  const identity = Object.freeze({
    ...IDENTITY,
    primaryUserId: "caroline",
    primaryUserName: "Caroline",
    companionId: "melanie",
    companionName: "Melanie",
  });
  const participants = [
    { role: "user", id: identity.primaryUserId, name: identity.primaryUserName },
    { role: "companion", id: identity.companionId, name: identity.companionName },
  ];
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity,
    events: [
      event({
        eventId: "identity-user-event",
        actor: { role: "user", id: identity.primaryUserId, name: identity.primaryUserName },
        participants,
        content: { text: "I had breakfast before the meeting." },
      }),
      event({
        eventId: "identity-companion-event",
        occurredAt: "2026-08-04T02:01:00.000Z",
        knownAt: "2026-08-04T02:01:00.000Z",
        actor: { role: "companion", id: identity.companionId, name: identity.companionName },
        participants,
        content: { text: "I will remember that detail." },
      }),
    ],
  });

  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity,
    memoriesOverride: extractionModelFixture([]),
  });

  assert.equal(result.status, "processed");
  const userBinding = repository.getActorEntityBinding({
    agentId: AGENT_ID,
    actorRole: "user",
    actorKey: identity.primaryUserId,
  });
  const companionBinding = repository.getActorEntityBinding({
    agentId: AGENT_ID,
    actorRole: "agent",
    actorKey: identity.companionId,
  });
  assert.ok(userBinding);
  assert.ok(companionBinding);
  const userMemories = repository.listActorEntityMemories({
    agentId: AGENT_ID,
    entityId: userBinding.entity_id,
  });
  const companionMemories = repository.listActorEntityMemories({
    agentId: AGENT_ID,
    entityId: companionBinding.entity_id,
  });
  assert.equal(userMemories.some((memory) => memory.content.includes("breakfast")), true);
  assert.equal(companionMemories.some((memory) => memory.content.includes("remember that detail")), true);
  database.close();
});

test("stores one-off daily evidence as an episodic event without promoting a stable state", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({
      content: { text: "我中午吃了牛肉面。" },
      world: { id: "primary", frame: "physical" },
    }),
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    now: new Date("2026-08-04T02:05:00.000Z"),
    memoriesOverride: extractionModelFixture([generatedEventCandidate({
      title: "中午吃了牛肉面",
      content: "User 中午吃了牛肉面。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [
        { role: "experiencer", actorRole: "user", actorName: "User", confidence: 1 },
      ],
      importance: 0.25,
      sourceRefs: ["M0001"],
    })]),
  });
  assert.equal(result.status, "processed");
  assert.equal(result.memoriesStored, 1);
  const memories = repository.listMemories(AGENT_ID, { statuses: [], limit: 20 }).items;
  const storedEvent = memories.find((memory) => memory.kind === "event");
  assert.ok(storedEvent);
  assert.equal(storedEvent.content, "User 中午吃了牛肉面。");
  assert.equal(storedEvent.state_family, "not_applicable");
  assert.equal(memories.some((memory) => memory.kind === "preference"), false);
  database.close();
});

test("returns failed batches to pending so generation can be retried safely", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  await assert.rejects(
    processPendingCompanionEvents({
      repository,
      agentId: AGENT_ID,
      identity: IDENTITY,
      generator: async () => { throw new Error("provider unavailable"); },
    }),
    /provider unavailable/u,
  );
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 1);
  assert.match(pending.items[0].last_error, /provider unavailable/u);
  assert.equal(repository.listInputBatches(AGENT_ID)[0].status, "failed");
  database.close();
});

test("output exhaustion preserves raw evidence and enters review after one extraction attempt", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  let calls = 0;
  const diagnostics = { maxOutputTokens: 65536, usage: { outputTokens: 65536 } };
  const run = () => processPendingCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY,
    generator: async () => { calls++; throw Object.assign(new Error('Output protection reached'), { code: 'MAX_TOKENS', diagnostics }); },
    now: new Date('2026-08-04T02:05:00.000Z') });
  const result = await run();
  assert.equal(result.status, 'processed');
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ['archived'] }).total, 1);
  const review = repository.listMaintenanceTasks(AGENT_ID, { taskTypes: ['long-term-extraction'] })[0];
  assert.equal(review.review_state, 'pending');
  assert.equal(review.attempt_count, 1);
  assert.equal(review.result.failures[0].errorCode, 'MAX_TOKENS');
  assert.deepEqual(review.result.failures[0].details.providerDiagnostics, diagnostics);
  await run();
  assert.equal(calls, 1);
  database.close();
});

test('output truncation splits once, persists the smaller limit, and archives every source exactly once', async () => {
  const { database, repository } = repositoryFixture();
  try {
    appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY,
      events: Array.from({ length: 5 }, (_, i) => event({ eventId: `split-${i}`, content: { text: `独立原话${i}` } })) });
    const sizes = [];
    const generator = async ({ input }) => {
      const refs = [...input.matchAll(/^\[(M\d{4})\]/gmu)].map(match => match[1]);
      sizes.push(refs.length);
      if (refs.length > 2) throw Object.assign(new Error('output truncated'), { code: 'MAX_TOKENS' });
      const sources = [...input.matchAll(/^\[(M\d{4})\].*?(独立原话\d)/gmu)];
      return { output: extractionModelFixture({ memories: sources.map(([, ref, text]) => generatedEventCandidate({ title: text,
        content: text, subjectRole: 'user', subjectName: 'User',
        actorRoles: [{ role: 'experiencer', actorRole: 'user', actorName: 'User', confidence: 1 }],
        sourceRefs: [ref] })) }), usage: {} };
    };
    for (let i = 0; i < 3; i++) {
      const result = await processPendingCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, generator });
      assert.equal(result.status, 'processed');
      assert.equal(result.generationDiagnostics.degraded, false);
      assert.ok(result.memoriesStored > 0, JSON.stringify(result.candidateResults));
    }
    assert.deepEqual(sizes, [5, 2, 2, 1]);
    assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ['pending'] }).total, 0);
    assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ['archived'] }).total, 5);
    assert.equal(repository.listMaintenanceTasks(AGENT_ID, { taskTypes: ['long-term-extraction'] }).length, 0);
    assert.equal(repository.listMemories(AGENT_ID, { kinds: ['utterance'], limit: 20 }).total, 5);
    const evidence = repository.listMemories(AGENT_ID, { kinds: ['event'], limit: 20 }).items
      .flatMap(memory => repository.getMemoryDetail(AGENT_ID, memory.id).sources.map(source => source.content));
    assert.deepEqual([...new Set(evidence)].sort(), Array.from({ length: 5 }, (_, i) => `独立原话${i}`));
  } finally { database.close(); }
});

test('a split limit survives database reopening and a later network failure never repeats the original large request', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-extraction-split-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'memory.db');
  let database = openMemoryDatabase(file);
  let repository = new MemoryRepository(database);
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY,
    events: Array.from({ length: 5 }, (_, i) => event({ eventId: `resume-${i}`, content: { text: `resume-source-${i}` } })) });
  const sizes = [];
  let failNetwork = true;
  const generator = async ({ input }) => {
    const refs = [...input.matchAll(/^\[(M\d{4})\]/gmu)].map(match => match[1]);
    sizes.push(refs.length);
    if (refs.length > 2) throw Object.assign(new Error('output truncated'), { code: 'MAX_TOKENS' });
    if (failNetwork) { failNetwork = false; throw new Error('network unavailable'); }
    return { output: { memories: [] }, usage: {} };
  };
  try {
    await assert.rejects(processPendingCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, generator }), /network unavailable/u);
    assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ['archived'] }).total, 0);
    database.close();
    database = openMemoryDatabase(file);
    repository = new MemoryRepository(database);
    for (let i = 0; i < 3; i++) await processPendingCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, generator });
    assert.deepEqual(sizes, [5, 2, 2, 2, 1]);
    assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ['archived'] }).total, 5);
    assert.equal(repository.listMaintenanceTasks(AGENT_ID, { taskTypes: ['long-term-extraction'] }).length, 0);
  } finally { database.close(); }
});

test('repeated subdivision stops at one whole source and only that source enters review', async () => {
  const { database, repository } = repositoryFixture();
  try {
    appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY,
      events: Array.from({ length: 4 }, (_, i) => event({ eventId: `single-${i}`, content: { text: `single-source-${i}` } })) });
    const sizes = [];
    const generator = async ({ input }) => {
      const refs = [...input.matchAll(/^\[(M\d{4})\]/gmu)].map(match => match[1]);
      sizes.push(refs.length);
      if (input.includes('single-source-0')) throw Object.assign(new Error('output truncated'), { code: 'MAX_TOKENS' });
      return { output: { memories: [] }, usage: {} };
    };
    for (let i = 0; i < 3; i++) await processPendingCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, generator });
    assert.deepEqual(sizes, [4, 2, 1, 1, 2]);
    assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ['archived'] }).total, 4);
    const tasks = repository.listMaintenanceTasks(AGENT_ID, { taskTypes: ['long-term-extraction'] });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].payload.eventIds.length, 1);
    assert.equal(tasks[0].attempt_count, 1);
  } finally { database.close(); }
});

test('a truncated repair also splits instead of silently retaining only the initially valid candidates', async () => {
  const { database, repository } = repositoryFixture();
  try {
    appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY,
      events: [event({ eventId: 'repair-first' }), event({ eventId: 'repair-second' })] });
    const calls = [];
    const charges = [];
    const generator = async ({ input, schemaName }) => {
      calls.push(schemaName);
      const receipt = { model: 'fixture', requestId: `split-${calls.length}` };
      if (schemaName === 'long-term-memory-extraction-repair-v5') {
        throw Object.assign(new Error('repair output truncated'), receipt, { code: 'MAX_TOKENS', usage: { completion_tokens: 10 } });
      }
      const refs = [...input.matchAll(/^\[(M\d{4})\]/gmu)].map(match => match[1]);
      return { ...receipt, output: extractionModelFixture({ memories: refs.length === 2
        ? [generatedEventCandidate({ sourceRefs: ['M0001'] }), generatedEventCandidate({ sourceRefs: ['M0002'], eventDate: 'bad-date' })]
        : [] }), usage: { completion_tokens: 5 } };
    };
    const run = () => withUsageRecorder(charge => charges.push(charge), () => processPendingCompanionEvents({
      repository, agentId: AGENT_ID, identity: IDENTITY, generator,
      usageLedgerPath: path.join(os.tmpdir(), 'split-receipt-unused.jsonl') }));
    const first = await run();
    assert.equal(first.eventsProcessed, 1);
    assert.equal(first.generationDiagnostics.degraded, false);
    await run();
    assert.deepEqual(calls, ['long-term-memory-extraction-v4', 'long-term-memory-extraction-repair-v5',
      'long-term-memory-extraction-v4', 'long-term-memory-extraction-v4']);
    assert.deepEqual(charges.map(charge => [charge.requestId, charge.usage.completion_tokens]),
      [['split-1', 5], ['split-2', 10], ['split-3', 5], ['split-4', 5]]);
    assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ['archived'] }).total, 2);
    assert.equal(repository.listMaintenanceTasks(AGENT_ID, { taskTypes: ['long-term-extraction'] }).length, 0);
  } finally { database.close(); }
});

test("archives raw evidence and queues human review after three ordinary extraction failures", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  let attempts = 0;
  const generator = async () => {
    attempts += 1;
    const error = new Error("提取模型输出不符合结构化结果。");
    error.code = "MEMORY_GENERATION_INVALID_OUTPUT";
    throw error;
  };

  for (const minute of [5, 6]) {
    await assert.rejects(
      processPendingCompanionEvents({
        repository,
        agentId: AGENT_ID,
        identity: IDENTITY,
        generator,
        now: new Date(`2026-08-04T02:${String(minute).padStart(2, "0")}:00.000Z`),
      }),
      /提取模型输出不符合结构化结果/u,
    );
  }
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].metadata.suzuMemoryProcessing.attemptCount, 2);
  assert.equal(pending.items[0].metadata.suzuMemoryProcessing.failureHistory.length, 2);

  const terminal = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    generator,
    now: new Date("2026-08-04T02:07:00.000Z"),
  });
  assert.equal(terminal.status, "processed");
  assert.equal(attempts, 3);
  assert.equal(terminal.generatedCandidates, 0);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 1);
  const review = repository.listMaintenanceTasks(AGENT_ID, {
    taskTypes: ["long-term-extraction"],
  })[0];
  assert.equal(review.status, "failed");
  assert.equal(review.review_state, "pending");
  assert.equal(review.attempt_count, 3);
  assert.equal(review.result.failures[0].errorCode, "MEMORY_GENERATION_INVALID_OUTPUT");
  assert.equal(repository.listMemories(AGENT_ID, { kinds: ["utterance"] }).total, 1);
  database.close();
});

test("claims only the caller-scoped pending events for an archive window", async () => {
  const { database, repository } = repositoryFixture();
  const first = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ eventId: "event-first", occurredAt: "2026-08-04T02:00:00.000Z" }),
  });
  const second = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ eventId: "event-second", occurredAt: "2026-08-04T03:00:00.000Z" }),
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    candidateEventIds: second.events.map((item) => item.id),
    memoriesOverride: extractionModelFixture([]),
  });
  assert.equal(result.status, "processed");
  assert.equal(repository.getInputEvent(AGENT_ID, first.events[0].id).status, "pending");
  assert.equal(repository.getInputEvent(AGENT_ID, second.events[0].id).status, "archived");
  database.close();
});

test("archives raw evidence and queues human review after transport retries are exhausted", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const generator = async () => {
    const error = new Error(
      "记忆处理 API 返回的不是有效响应 JSON（status=200，attempt=3/3）。",
    );
    error.code = "MEMORY_PROVIDER_TRANSPORT_EXHAUSTED";
    error.transportAttempts = 3;
    error.maximumTransportAttempts = 3;
    error.diagnostics = {
      kind: "invalid-response-envelope",
      status: 200,
      contentType: "text/html",
      responseCharacters: 12,
      requestId: "fixture-request",
    };
    throw error;
  };

  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    generator,
    now: new Date("2026-08-04T02:05:00.000Z"),
  });

  assert.equal(result.status, "processed");
  assert.equal(result.eventsProcessed, 1);
  assert.equal(result.messagesArchived, 1);
  assert.equal(result.generatedCandidates, 0);
  assert.equal(result.generationDiagnostics.degraded, true);
  assert.equal(result.generationDiagnostics.transportAttempts, 3);
  assert.match(result.generationDiagnostics.failureReviewTaskId, /^maintenance-task-/u);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).total, 0);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 1);

  const batch = repository.listInputBatches(AGENT_ID)[0];
  assert.equal(batch.status, "completed");
  assert.equal(batch.output.degraded, true);
  assert.equal(batch.output.failureReviewTaskId, result.generationDiagnostics.failureReviewTaskId);
  const review = repository.getMaintenanceTask(
    AGENT_ID,
    result.generationDiagnostics.failureReviewTaskId,
  );
  assert.equal(review.task_type, "long-term-extraction");
  assert.equal(review.status, "failed");
  assert.equal(review.review_state, "pending");
  assert.equal(review.attempt_count, 3);
  assert.equal(review.max_attempts, 3);
  assert.equal(review.failureHistory.length, 1);
  assert.equal(review.failureHistory[0].attempt, 3);
  assert.equal(review.result.failures[0].errorCode, "MEMORY_PROVIDER_TRANSPORT_EXHAUSTED");
  assert.equal(review.payload.memoryIds.length, 1);
  assert.equal(repository.getMemory(review.payload.memoryIds[0]).kind, "utterance");

  const next = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    generator,
  });
  assert.equal(next.status, "skipped");
  assert.equal(next.reason, "no-pending-events");
  database.close();
});

test("reclaims an expired interrupted input batch without allowing its old worker to finish", () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const interrupted = repository.claimPendingInputEvents(AGENT_ID, {
    workerId: "worker-interrupted",
    leaseSeconds: 60,
    createdAt: "2026-08-04T02:00:00.000Z",
  });
  assert.equal(interrupted.events.length, 1);

  const beforeExpiry = repository.claimPendingInputEvents(AGENT_ID, {
    workerId: "worker-too-early",
    leaseSeconds: 60,
    createdAt: "2026-08-04T02:00:30.000Z",
  });
  assert.equal(beforeExpiry.batch, null);

  const reclaimed = repository.claimPendingInputEvents(AGENT_ID, {
    workerId: "worker-retry",
    leaseSeconds: 60,
    createdAt: "2026-08-04T02:01:01.000Z",
  });
  assert.equal(reclaimed.events.length, 1);
  assert.notEqual(reclaimed.batch.id, interrupted.batch.id);
  assert.equal(repository.getInputBatch(AGENT_ID, interrupted.batch.id).status, "failed");
  assert.match(
    repository.getInputBatch(AGENT_ID, interrupted.batch.id).error_message,
    /lease expired/u,
  );
  assert.throws(
    () => repository.completeInputBatch(AGENT_ID, interrupted.batch.id, {
      success: true,
      leaseOwner: "worker-interrupted",
      completedAt: "2026-08-04T02:01:02.000Z",
    }),
    (error) => error.code === "INPUT_BATCH_LEASE_LOST",
  );
  repository.completeInputBatch(AGENT_ID, reclaimed.batch.id, {
    success: false,
    leaseOwner: "worker-retry",
    errorMessage: "retry later",
    completedAt: "2026-08-04T02:01:03.000Z",
  });
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).total, 1);
  database.close();
});

test("queues expensive post-processing without calling providers in the archive turn", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  let embeddingCalls = 0;
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: extractionModelFixture([generatedEventCandidate({
      sourceRefs: ["M0001"],
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [
        { role: "experiencer", actorRole: "user", actorName: "User", confidence: 1 },
      ],
    })]),
    embeddingProvider: async () => {
      embeddingCalls += 1;
      throw new Error("embedding unavailable");
    },
  });
  assert.equal(result.status, "processed");
  assert.equal(embeddingCalls, 0);
  assert.equal(result.embeddingIndex.status, "queued");
  assert.deepEqual(
    result.maintenanceTasks.map((task) => `${task.lane}:${task.taskType}`).sort(),
    [
      "embedding:memory-embedding",
      "semantic:event-continuity",
      "semantic:structure-proposal",
    ],
  );
  const queuedTasks = repository.listMaintenanceTasks(AGENT_ID, { statuses: ["pending"] });
  const embeddingTask = queuedTasks.find((task) => task.task_type === "memory-embedding");
  const semanticTasks = queuedTasks.filter((task) => task.lane === "semantic");
  const utterance = repository.listMemories(AGENT_ID, { statuses: ["active"] }).items
    .find((memory) => memory.kind === "utterance");
  assert.deepEqual(
    new Set(embeddingTask.payload.memoryIds),
    new Set([result.candidateResults[0].memoryId, utterance.id]),
  );
  assert.equal(semanticTasks.every((task) => (
    JSON.stringify(task.payload.memoryIds) === JSON.stringify([result.candidateResults[0].memoryId])
  )), true);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 1);
  database.close();
});

test("rolls back archival when required follow-up tasks cannot be persisted", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const originalEnqueue = repository.enqueueMaintenanceTask.bind(repository);
  repository.enqueueMaintenanceTask = (options) => {
    if (options.taskType === "memory-embedding") {
      throw Object.assign(new Error("queue storage unavailable"), { code: "QUEUE_STORAGE_UNAVAILABLE" });
    }
    return originalEnqueue(options);
  };
  await assert.rejects(processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: extractionModelFixture([generatedEventCandidate({ sourceRefs: ["M0001"] })]),
  }), /queue storage unavailable/u);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).total, 1);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 0);
  assert.equal(repository.listMaintenanceTasks(AGENT_ID, { statuses: ["pending"] }).length, 0);
  repository.enqueueMaintenanceTask = originalEnqueue;
  const retried = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: extractionModelFixture([generatedEventCandidate({ sourceRefs: ["M0001"] })]),
  });
  assert.equal(retried.status, "processed");
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 1);
  assert.ok(repository.listMaintenanceTasks(AGENT_ID, { statuses: ["pending"] }).length > 0);
  database.close();
});

test("preserves inferred beliefs as isolated provisional evidence after analysis fallback", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({
      actor: { role: "companion", id: AGENT_ID, name: "Companion" },
      content: { text: "我感觉 User 最近可能很喜欢逛科技馆。" },
    }),
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: extractionModelFixture([generatedEventCandidate({
      kind: "belief_state",
      title: "对科技馆的兴趣",
      content: "User 似乎喜欢逛科技馆。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [],
      canonicalKey: "preference:museum-visits",
      stateFamily: "belief",
      stateTarget: { objectRole: "world", objectName: "科技馆" },
      stateLabel: "喜欢逛科技馆",
      evidenceMode: "inferred",
      temporalState: "current",
      eventDate: "",
      eventStart: "",
      sourceRefs: ["M0001"],
    })]),
  });
  assert.equal(result.memoriesForReview, 0);
  assert.equal(result.candidateResults[0].status, "analysis_pending");
  assert.equal(repository.listPendingProvisionalMemories(AGENT_ID).length, 0);
  const request = repository.getStateAnalysisRequest(AGENT_ID, result.candidateResults[0].stateAnalysisRequestId);
  assert.equal(request.representation_layer, "inferred");
  const fallback = fallbackStateAnalysisToProvisionalReview({ repository, request, reason: "fixture-analysis-failure" });
  const provisional = repository.listPendingProvisionalMemories(AGENT_ID);
  assert.equal(provisional.length, 1);
  assert.equal(provisional[0].id, fallback.provisional.id);
  assert.equal(provisional[0].layer, "provisional");
  assert.equal(provisional[0].status, "archived");
  assert.equal(provisional[0].metadata.epistemicStatus, "agent_impression");
  assert.equal(repository.listMemories(AGENT_ID, { statuses: ["active"] }).total, 1);
  assert.deepEqual(
    result.maintenanceTasks.map((task) => `${task.lane}:${task.taskType}`),
    ["embedding:memory-embedding"],
  );
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM memory_edges
    WHERE agent_id = ? AND (from_memory_id = ? OR to_memory_id = ?)
  `).get(AGENT_ID, provisional[0].id, provisional[0].id).count), 0);
  database.close();
});

test("queues inferred preference candidates for the behavioral specialist", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ content: { text: "我最近可能越来越喜欢逛科技馆了。" } }),
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: extractionModelFixture([generatedEventCandidate({
      kind: "preference",
      title: "对科技馆的兴趣",
      content: "User 可能越来越喜欢逛科技馆。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [
        { role: "preference_holder", actorRole: "user", actorName: "User", confidence: 0.7 },
      ],
      canonicalKey: "preference:museum-visits",
      stateFamily: "preference",
      stateLabel: "喜欢逛科技馆",
      evidenceMode: "inferred",
      temporalState: "current",
      eventDate: "",
      eventStart: "",
      sourceRefs: ["M0001"],
    })]),
  });
  assert.equal(result.stateAnalysisRequestsQueued, 1);
  assert.equal(result.candidateResults[0].status, "analysis_pending");
  const requests = repository.listStateAnalysisRequests(AGENT_ID, { statuses: ["pending"] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].representation_layer, "inferred");
  assert.equal(repository.listPendingProvisionalMemories(AGENT_ID).length, 0);
  database.close();
});

test("uses the long-term extraction prompt and refuses to guess across mixed world evidence", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [
      event({ content: { text: "我们在关系世界里一起整理记忆。" } }),
      event({
        eventId: "event-physical",
        occurredAt: "2026-08-04T02:02:00.000Z",
        knownAt: "2026-08-04T02:02:00.000Z",
        world: { id: "physical-home", frame: "physical" },
        content: { text: "User 此时坐在物理世界的电脑前。" },
      }),
    ],
  });
  let receivedSystemPrompt = "";
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    generator: async ({ systemPrompt }) => {
      receivedSystemPrompt = systemPrompt;
      return {
        output: extractionModelFixture({
          memories: [generatedEventCandidate()],
        }),
        usage: {},
      };
    },
  });
  assert.equal(receivedSystemPrompt, loadLongTermExtractionSystemPrompt());
  assert.equal(result.memoriesForReview, 1);
  assert.deepEqual(result.candidateResults[0].reasons, ["mixed-world-evidence-needs-resolution"]);
  assert.equal(repository.listMemories(AGENT_ID, { statuses: [], kinds: ["event"] }).total, 0);
  database.close();
});

for (const language of ['en', 'zh']) test(`repair receives its archive window, owner and read-only context: ${language}`, async () => {
  const firstText = language === 'en' ? 'The dog is named Mochi.' : '那只狗叫麻糬。';
  const secondText = language === 'en' ? 'We swam together.' : '我们一起游泳了。';
  const beforeText = language === 'en' ? 'We are telling a story about a dog.' : '我们正在讲一只狗的故事。';
  const afterText = language === 'en' ? 'Then we fed the dog.' : '随后我们喂了那只狗。';
  const content = language === 'en' ? 'User swam with the dog Mochi.' : 'User 和那只叫麻糬的狗一起游泳了。';
  const source = (id, text) => event({ eventId: id, world: { frame: 'fictional', id: 'story' }, content: { text } });
  const corrected = generatedEventCandidate({ title: content, content, subjectRole: 'user', subjectName: 'User',
    actorRoles: [{ role: 'experiencer', actorRole: 'user', actorName: 'User', confidence: 1 }],
    reality: 'fictional', eventDate: '', eventStart: '', sourceRefs: ['M0001', 'M0002'] });
  let calls = 0;
  let repairInput;
  let repairText;
  const result = await generateCompanionEventBatch({ identity: IDENTITY,
    events: [{ ...source('name', firstText), knownAt: '2026-08-05T02:00:00Z' }, source('swim', secondText), source('other', 'UNRELATED_WINDOW')],
    archiveWindows: [
      { id: 'story-window', coreEventIds: ['name', 'swim'], previousContextEvents: [{ ...source('before', beforeText), knownAt: '2000-01-01T00:00:00Z', metadata: { sourceTimeKnown: false } }],
        continuationGuidanceEvents: [source('after', afterText)] },
      { id: 'unrelated-window', coreEventIds: ['other'] },
    ], generator: async request => {
      if (++calls === 1) {
        const { revisionAction, ...invalid } = corrected;
        return { output: extractionModelFixture({ memories: [{ ...invalid, sourceRefs: ['M0002'] }] }) };
      }
      repairInput = JSON.parse(request.input);
      repairText = request.input;
      return { output: extractionModelFixture({ results: [{ candidateIndex: 0, status: 'repaired', memories: [corrected] }] }) };
    } });
  const input = repairInput;
  assert.equal(input.memoryOwner, 'P1');
  assert.deepEqual(input.sourceMessages.map(message => message.ref), ['M0001', 'M0002']);
  assert.deepEqual(input.sourceMessages[0].world, { frame: 'fictional', id: 'story' });
  assert.equal(input.sourceMessages[0].knownAt, '2026-08-05T02:00:00Z');
  assert.equal(input.contextWindows[0].previousContextMessages[0].timestamp, 'unknown');
  assert.doesNotMatch(repairText, /2000-01-01/);
  assert.equal(input.contextWindows[0].previousContextMessages[0].text, beforeText);
  assert.equal(input.contextWindows[0].continuationGuidanceMessages[0].text, afterText);
  assert.ok(input.contextWindows.every(window => window.window === 'W0001'));
  assert.ok(input.contextWindows.flatMap(window => [...window.previousContextMessages, ...window.continuationGuidanceMessages]).every(message => !Object.hasOwn(message, 'ref')));
  assert.doesNotMatch(repairText, /UNRELATED_WINDOW/);
  assert.equal(calls, 2);
  assert.deepEqual(result.generation.output.memories[0].sourceRefs, ['M0001', 'M0002']);
  assert.equal(result.generation.output.memories[0].reality, 'fictional');
  assert.equal(result.generation.metadata.unresolvedCandidateCount, 0);
});


for (const mode of ['complete-table', 'used-entities-only', 'later-retry']) test('candidate repair preserves same-name entity identities: ' + mode, async t => {
  const entities = [{ ref: 'E1', kind: 'place', name: 'Paris', aliases: ['Paris France'] },
    { ref: 'E2', kind: 'place', name: 'Paris', aliases: ['Paris Texas'] }];
  const base = extractionModelFixture({ memories: [generatedEventCandidate({ subjectRole: 'user', subjectName: 'User',
    actorRoles: [], sourceRefs: ['M0001'], eventDate: '', eventStart: '', content: 'User visited Paris in France.' })] }).memories[0];
  const second = { ...base, content: 'User visited Paris in Texas.', sourceRefs: ['M0002'], entityRefs: ['E2'] };
  let calls = 0;
  const generated = await generateCompanionEventBatch({ identity: IDENTITY,
    events: [event({ content: { text: base.content } }), event({ eventId: 'event-2', content: { text: second.content } })],
    archiveWindows: [{ id: 'france', coreEventIds: ['event-1'] }, { id: 'texas', coreEventIds: ['event-2'] }],
    generator: async request => {
      if (++calls === 1) return { output: { entities, memories: [{ ...base, entityRefs: ['E1'] },
        { ...second, classification: { category: 'invalid' } }] } };
      const input = JSON.parse(request.input);
      assert.deepEqual(input.entities, entities);
      assert.equal(input.sourceMessages.length, 1, 'Repair reads the affected window.');
      return { output: { entities: mode === 'complete-table' ? entities : [entities[1]], results: [{ candidateIndex: 1, status: 'repaired', memories: [second] }] } };
    } });
  assert.equal(calls, 2);
  assert.equal(generated.generation.output.memories.length, 2);
  assert.equal(generated.generation.output.memories[0].entityScope, generated.generation.output.memories[1].entityScope);
  const f = repositoryFixture(); t.after(() => f.database.close());
  f.repository.upsertEntity({ id: 'existing-france', agentId: AGENT_ID, kind: 'place', canonicalName: 'Paris', aliases: ['Paris France'] });
  const archive = (memories, offset = 0) => archiveLongTermEvidence({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
    messages: generated.messages, batchId: 'entity-repair', candidateIndexOffset: offset, generatedMemories: memories });
  const rows = generated.generation.output.memories;
  const results = mode === 'later-retry' ? [...archive([rows[0]]).candidateResults, ...archive([rows[1]], 1).candidateResults]
    : archive(rows).candidateResults;
  assert.ok(results.every(item => item.status === 'created'));
  const linked = results.map(item => f.repository.listMemoryEntities(item.memoryId).find(entity => entity.kind === 'place'));
  assert.equal(linked[0].id, 'existing-france', 'A unique existing object may be reused.');
  assert.notEqual(linked[0].id, linked[1].id, 'Another E reference cannot take the entity already bound in this batch.');
  assert.ok(linked[0].aliases.includes('Paris France'));
  assert.ok(linked[1].aliases.includes('Paris Texas'));
  const repeated = archive([rows[1]], 2).candidateResults[0];
  assert.equal(f.repository.listMemoryEntities(repeated.memoryId).find(entity => entity.kind === 'place').id, linked[1].id);
  const stored = f.repository.listIngestionEntityBindings({ agentId: AGENT_ID, batchId: 'entity-repair', entityScopes: [rows[0].entityScope] });
  assert.deepEqual(new Set(stored.map(item => `${item.ref}:${item.entity.id}`)), new Set([`E1:${linked[0].id}`, `E2:${linked[1].id}`]));
});


test('partial repair retains newly declared entity references for remaining candidates', async t => {
  const first = extractionModelFixture({ memories: [generatedEventCandidate({ subjectRole: 'user', subjectName: 'User', actorRoles: [],
    sourceRefs: ['M0001'], content: 'User visited Paris in France.', eventDate: '', eventStart: '' })] }).memories[0];
  const second = { ...first, content: 'User visited Paris in Texas.' };
  let calls = 0, continuationRefs;
  const generated = await generateCompanionEventBatch({ identity: IDENTITY, events: [event({ content: { text: first.content + ' ' + second.content } })],
    generator: async request => {
      if (++calls === 1) return { output: { memories: [first, second].map(row => ({ ...row, classification: { category: 'invalid' } })) } };
      if (calls === 2) return { output: { entities: [{ ref: 'E1', kind: 'place', name: 'Paris', aliases: ['Paris France'] }],
        results: [{ candidateIndex: 0, status: 'repaired', memories: [{ ...first, entityRefs: ['E1'] }] },
          { candidateIndex: 1, status: 'pending', reason: 'The second location remains to be checked.' }] } };
      continuationRefs = (JSON.parse(request.input).entities || []).map(entity => entity.ref);
      return { output: { entities: [{ ref: 'E2', kind: 'place', name: 'Paris', aliases: ['Paris Texas'] }],
        results: [{ candidateIndex: 1, status: 'repaired', memories: [{ ...second, entityRefs: ['E2'] }] }] } };
    } });
  assert.equal(calls, 3);
  assert.deepEqual(continuationRefs, ['E1'], 'The next repair sees the reference already assigned.');
  const rows = generated.generation.output.memories;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].entityScope, rows[1].entityScope);
  const f = repositoryFixture(); t.after(() => f.database.close());
  const archived = archiveLongTermEvidence({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY,
    messages: generated.messages, batchId: 'partial-new-entities', generatedMemories: rows });
  const ids = archived.candidateResults.map(item => f.repository.listMemoryEntities(item.memoryId).find(entity => entity.kind === 'place').id);
  assert.equal(ids.length, 2); assert.notEqual(ids[0], ids[1]);
});


test('repair preserves accepted entity types and keeps earlier successful memories when a later reference conflicts', async t => {
  const first = extractionModelFixture({ memories: [generatedEventCandidate({ subjectRole: 'user', subjectName: 'User', actorRoles: [],
    sourceRefs: ['M0001'], eventDate: '', eventStart: '', content: 'User visited Paris.' })] }).memories[0];
  const second = { ...first, content: 'User met Mira.' };
  const paris = { ref: 'E1', kind: 'place', name: 'Paris', aliases: [] };
  let calls = 0, finalInput;
  const generated = await generateCompanionEventBatch({ identity: IDENTITY, events: [event({ content: { text: first.content + ' ' + second.content } })],
    generator: async request => {
      if (++calls === 1) return { output: { memories: [first, second].map(memory => ({ ...memory, classification: { category: 'invalid' } })) } };
      if (calls === 2) return { output: { entities: [paris], results: [
        { candidateIndex: 0, status: 'repaired', memories: [{ ...first, entityRefs: ['E1'] }] },
        { candidateIndex: 1, status: 'pending', reason: 'Check the person.' }] } };
      if (calls === 3) return { output: { entities: [{ ref: 'E1', kind: 'person', name: 'Mira', aliases: [] }],
        results: [{ candidateIndex: 1, status: 'repaired', memories: [{ ...second, entityRefs: ['E1'] }] }] } };
      finalInput = JSON.parse(request.input);
      return { output: { entities: [{ ref: 'E2', kind: 'person', name: 'Mira', aliases: [] }],
        results: [{ candidateIndex: 1, status: 'repaired', memories: [{ ...second, entityRefs: ['E2'] }] }] } };
    } });
  assert.equal(calls, 4);
  assert.equal(finalInput.entities[0].kind, 'place');
  assert.match(finalInput.candidates[0].validationError, /E1.*place/);
  assert.deepEqual(generated.generation.output.memories.map(memory => memory.content), [first.content, second.content]);
  const f = repositoryFixture(); t.after(() => f.database.close());
  const archived = archiveLongTermEvidence({ repository: f.repository, agentId: AGENT_ID, identity: IDENTITY, messages: generated.messages,
    batchId: 'repair-conflicting-types', generatedMemories: generated.generation.output.memories });
  assert.equal(archived.memoriesStored, 2);
  const named = archived.candidateResults.map(item => f.repository.listMemoryEntities(item.memoryId).find(entity => ['Paris', 'Mira'].includes(entity.canonical_name)));
  assert.deepEqual(named.map(entity => entity.kind), ['place', 'person']);
  assert.notEqual(named[0].id, named[1].id);
});
