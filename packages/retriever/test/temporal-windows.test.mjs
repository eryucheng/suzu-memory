import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { closeRetrievalWorkers, resolveTemporalQuery, retrieveMemories } from '../src/index.mjs';
import { memoryCalendarDate, temporalAffinity } from '../src/temporal-ranking.mjs';

const now = new Date('2026-10-23T07:30:00+08:00');
const win = (startDate, endDate = startDate) => ({ startDate, endDate });
for (const [query, precision, core, tolerance = core] of [
  ['昨天', 'exact', win('2026-10-22')], ['12月25号', 'exact', win('2025-12-25')],
  ['上周', 'exact', win('2026-10-12', '2026-10-18')],
  ['这周', 'exact', win('2026-10-19', '2026-10-25')], ['本周', 'exact', win('2026-10-19', '2026-10-25')],
  ['上上周', 'exact', win('2026-10-05', '2026-10-11')],
  ['上个月', 'exact', win('2026-09-01', '2026-09-30')], ['这个月', 'exact', win('2026-10-01', '2026-10-31')],
  ['上上个月', 'exact', win('2026-08-01', '2026-08-31')],
  ['去年', 'exact', win('2025-01-01', '2025-12-31')], ['今年', 'exact', win('2026-01-01', '2026-12-31')],
  ['前年', 'exact', win('2024-01-01', '2024-12-31')], ['去年十二月', 'exact', win('2025-12-01', '2025-12-31')],
  ['去年3月', 'exact', win('2025-03-01', '2025-03-31')],
  ['今年春天', 'exact', win('2026-03-01', '2026-05-31')], ['今年夏天', 'exact', win('2026-06-01', '2026-08-31')],
  ['今年秋天', 'exact', win('2026-09-01', '2026-11-30')], ['今年冬天', 'exact', win('2026-12-01', '2027-02-28')],
  ['前年冬季', 'exact', win('2024-12-01', '2025-02-28')],
  ['夏季', 'exact', win('2026-06-01', '2026-08-31')], ['冬天', 'exact', win('2025-12-01', '2026-02-28')],
  ['三天前', 'approximate', win('2026-10-19', '2026-10-21'), win('2026-10-17', '2026-10-23')],
  ['2周前', 'approximate', win('2026-10-06', '2026-10-12'), win('2026-10-02', '2026-10-16')],
  ['两周前', 'approximate', win('2026-10-06', '2026-10-12'), win('2026-10-02', '2026-10-16')],
  ['2 weeks ago', 'approximate', win('2026-10-06', '2026-10-12'), win('2026-10-02', '2026-10-16')],
  ['三个月前', 'approximate', win('2026-07-08', '2026-08-07'), win('2026-06-22', '2026-08-23')],
  ['两年前', 'approximate', win('2024-09-08', '2024-12-07'), win('2024-07-25', '2025-01-21')],
  ['这几天', 'vague', win('2026-10-20', '2026-10-23'), win('2026-10-18', '2026-10-23')],
  ['这两天', 'vague', win('2026-10-20', '2026-10-23'), win('2026-10-18', '2026-10-23')],
  ['前几天', 'vague', win('2026-10-17', '2026-10-21'), win('2026-10-13', '2026-10-22')],
  ['最近', 'vague', win('2026-10-09', '2026-10-23'), win('2026-09-23', '2026-10-23')],
  ['近来', 'vague', win('2026-10-09', '2026-10-23'), win('2026-09-23', '2026-10-23')],
  ['几周前', 'vague', win('2026-09-11', '2026-10-09'), win('2026-08-24', '2026-10-16')],
  ['前几周', 'vague', win('2026-09-11', '2026-10-09'), win('2026-08-24', '2026-10-16')],
  ['几个月前', 'vague', win('2026-04-23', '2026-08-23'), win('2026-01-23', '2026-09-23')],
  ['几年前', 'vague', win('2020-10-23', '2024-10-23'), win('2017-10-23', '2025-10-23')],
  ['十几天前', 'vague', win('2026-10-04', '2026-10-12'), win('2026-10-01', '2026-10-13')],
  ['十几个月前', 'vague', win('2025-03-23', '2025-11-23'), win('2024-12-23', '2025-12-23')],
  ['二十几天前', 'vague', win('2026-09-24', '2026-10-02'), win('2026-09-21', '2026-10-03')],
  ['三十几天前', 'vague', win('2026-09-14', '2026-09-22'), win('2026-09-11', '2026-09-23')],
  ['两个星期前', 'approximate', win('2026-10-06', '2026-10-12'), win('2026-10-02', '2026-10-16')],
  ['两星期前', 'approximate', win('2026-10-06', '2026-10-12'), win('2026-10-02', '2026-10-16')],
  ['两个礼拜前', 'approximate', win('2026-10-06', '2026-10-12'), win('2026-10-02', '2026-10-16')],
  ['半个月前', 'approximate', win('2026-10-07', '2026-10-09'), win('2026-10-05', '2026-10-11')],
  ['半年前', 'approximate', win('2026-04-08', '2026-05-08'), win('2026-03-23', '2026-05-24')],
  ['前些天', 'vague', win('2026-10-17', '2026-10-21'), win('2026-10-13', '2026-10-22')],
  ['前段时间', 'vague', win('2026-09-11', '2026-10-16'), win('2026-07-25', '2026-10-22')],
  ['前阵子', 'vague', win('2026-09-11', '2026-10-16'), win('2026-07-25', '2026-10-22')],
  ['上半年', 'exact', win('2026-01-01', '2026-06-30')],
  ['下半年', 'exact', win('2026-07-01', '2026-12-31')],
  ['去年上半年', 'exact', win('2025-01-01', '2025-06-30')],
  ['年底', 'vague', win('2025-11-01', '2025-12-31'), win('2025-10-01', '2025-12-31')],
  ['今年年底', 'vague', win('2026-11-01', '2026-12-31'), win('2026-10-01', '2026-12-31')],
  ['去年年末', 'vague', win('2025-11-01', '2025-12-31'), win('2025-10-01', '2025-12-31')],
  ['以前', 'vague', null], ['之前', 'vague', null], ['很久以前', 'vague', null], ['上次', 'vague', null],
]) test(`calendar windows: ${query}`, () => {
  const parsed = resolveTemporalQuery(`${query}聊过猫吗`, now);
  assert.equal(parsed.precision, precision);
  assert.deepEqual(parsed.coreWindow, core);
  assert.deepEqual(parsed.toleranceWindow, tolerance);
  assert.equal(parsed.remainingQuery, '聊过猫吗');
});

test('windows use the local day across DST, New Year, and clamped month ends', () => {
  const sunday = resolveTemporalQuery('本周', new Date('2027-01-03T23:30:00-08:00'), 'America/Los_Angeles');
  assert.deepEqual(sunday.coreWindow, win('2026-12-28', '2027-01-03'));
  const nextDay = resolveTemporalQuery('本周', new Date('2027-01-04T07:30:00Z'), 'Asia/Shanghai');
  assert.deepEqual(nextDay.coreWindow, win('2027-01-04', '2027-01-10'));
  const monthEnd = resolveTemporalQuery('一个月前', new Date('2024-03-31T12:00:00+08:00'));
  assert.deepEqual(monthEnd.coreWindow, win('2024-02-14', '2024-03-15'));
  const spring = resolveTemporalQuery('两周前', new Date('2026-03-15T00:30:00-07:00'), 'America/Los_Angeles');
  assert.deepEqual(spring.coreWindow, win('2026-02-26', '2026-03-04'));
  assert.deepEqual(resolveTemporalQuery('下半年', new Date('2027-01-05T12:00:00+08:00')).coreWindow,
    win('2026-07-01', '2026-12-31'));
  assert.deepEqual(resolveTemporalQuery('今年下半年', new Date('2027-01-05T12:00:00+08:00')).coreWindow,
    win('2027-07-01', '2027-12-31'));
  assert.deepEqual(resolveTemporalQuery('半年前', new Date('2024-08-31T12:00:00+08:00')).coreWindow,
    win('2024-02-14', '2024-03-15'));
});

test('time affinity is bounded, tapers to zero, and never penalizes outside dates', () => {
  const parsed = resolveTemporalQuery('前几天', now);
  for (const [date, score] of [['2026-10-17', 1], ['2026-10-21', 1], ['2026-10-15', 0.5],
    ['2026-10-13', 0], ['2026-10-22', 0], ['2026-09-01', 0]]) {
    assert.equal(temporalAffinity(date, parsed), score, date);
  }
  const recent = resolveTemporalQuery('最近', now);
  assert.ok(temporalAffinity('2026-10-23', recent) > temporalAffinity('2026-10-14', recent));
  assert.equal(memoryCalendarDate({ kind: 'event', event_date: '2026-10-22', event_start: '2026-10-20T00:00:00Z' }, 'Asia/Shanghai'), '2026-10-22');
  assert.equal(memoryCalendarDate({ kind: 'fact', state_family: 'preference', known_at: '2026-10-21T23:30:00Z', valid_from: '2026-01-01' }, 'Asia/Shanghai'), '2026-10-22');
});

function fixture(t, memories) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-temporal-window-'));
  t.after(async () => { await closeRetrievalWorkers(); fs.rmSync(root, { recursive: true, force: true }); });
  const databasePath = path.join(root, 'memory.db');
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  try {
    for (const { embedding, ...memory } of memories) {
      repository.upsertMemory({ agentId: 'window-agent', kind: 'event', layer: 'episodic',
        subjectRole: 'user', subjectKey: 'user', content: '讨论过灯塔博物馆的展览。',
        importance: 0.5, ...memory });
      if (embedding) repository.upsertEmbedding({ memoryId: memory.id, model: 'calendar-test',
        vector: embedding, sourceMemoryIds: [memory.id] });
    }
  } finally { database.close(); }
  return Object.assign((query, options = {}, extra = {}) => retrieveMemories({ databasePath, agentId: 'window-agent', query, now,
    options: { maximumReturnedCandidates: 10, includeCandidateContext: true, ...options }, ...extra }), { root });
}

test('vague time boosts topic matches without admitting unrelated or discarding old memories', async t => {
  const recall = fixture(t, [
    { id: 'three-days', eventDate: '2026-10-20' }, { id: 'forty-days', eventDate: '2026-09-13' },
    { id: 'unrelated', eventDate: '2026-10-20', content: '正在修理厨房里的洗碗机。', importance: 1 },
  ]);
  const result = await recall('前几天聊过灯塔博物馆吗');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.candidates.map(c => c.memoryId), ['three-days', 'forty-days']);
  assert.equal(result.candidates[1].temporalRanking.timeScore, 0);
  for (const candidate of result.candidates) assert.equal(candidate.score,
    candidate.temporalRanking.topicScore * (1 + candidate.temporalRanking.weight * candidate.temporalRanking.timeScore));
  assert.match(result.context, /2026-10-20/);
  const oldOnly = fixture(t, [{ id: 'only-old', eventDate: '2026-09-13' }]);
  const fallback = await oldOnly('前几天聊过灯塔博物馆吗');
  assert.equal(fallback.candidates[0].memoryId, 'only-old');
  assert.match(fallback.context, /2026-09-13/);
});

test('vague topic recall preserves the caller’s full query for semantic search', async t => {
  const recall = fixture(t, [{ id: 'old', eventDate: '2026-09-13' }]);
  const inputs = [];
  const result = await recall('两周前聊过灯塔博物馆吗', {}, { embeddingProvider: async text => {
    inputs.push(text); return { model: 'window-test', vector: [1, 0] };
  } });
  assert.equal(result.status, 'ready');
  assert.ok(result.seedRouting.plannedRoutes.includes('bm25'));
  assert.ok(result.seedRouting.plannedRoutes.includes('vector'));
  assert.ok(inputs.length > 0);
  assert.ok(inputs.every(text => text.includes('两周前')));
});

test('topicless recent recall returns local dated memories in reverse date order', async t => {
  const recall = fixture(t, [
    { id: 'old', eventDate: '2026-09-13' }, { id: 'recent', eventDate: '2026-10-20' },
    { id: 'newest', eventDate: '2026-10-22', content: '讨论过猫咪。' },
    { id: 'future', eventDate: '2026-12-01' },
  ]);
  const recent = await recall('最近我们聊了什么');
  assert.deepEqual(recent.candidates.map(c => c.memoryId), ['newest', 'recent']);
  assert.match(recent.context, /2026-10-22/);
  assert.match(recent.context, /2026-10-20/);
  const latest = await recall('上次聊过灯塔博物馆吗');
  assert.ok(latest.candidates.some(c => c.memoryId === 'recent'));
});

test('raw evidence retains ordinary matches when an exact date is only a bonus', async t => {
  const recall = fixture(t, [
    { id: 'raw-new', kind: 'utterance', layer: 'raw', eventStart: '2026-10-19T23:30:00Z', recordedAt: '2026-10-19T23:30:00Z' },
    { id: 'raw-old', kind: 'utterance', layer: 'raw', eventStart: '2026-09-12T23:30:00Z', recordedAt: '2026-09-12T23:30:00Z' },
  ]);
  const vague = await recall('前几天聊过灯塔博物馆吗');
  assert.deepEqual(vague.candidates.map(c => c.memoryId), ['raw-new', 'raw-old']);
  const exact = await recall('10月20号聊过灯塔博物馆吗');
  assert.deepEqual(exact.candidates.map(c => c.memoryId), ['raw-new', 'raw-old']);
});

test('state recall ranks its known date and discloses that date independently of validity', async t => {
  const recall = fixture(t, [
    { id: 'new-state', kind: 'preference', layer: 'semantic', stateFamily: 'preference',
      canonicalKey: 'user:preference:cats', knownAt: '2026-10-19T23:30:00Z', validFrom: '2026-01-01T00:00:00Z',
      content: '用户喜欢猫咪。', temporalState: 'current' },
    { id: 'old-state', kind: 'preference', layer: 'semantic', stateFamily: 'preference',
      canonicalKey: 'user:preference:cats-old', knownAt: '2026-09-12T23:30:00Z', validFrom: '2026-01-01T00:00:00Z',
      content: '用户喜欢猫咪。', temporalState: 'current' },
  ]);
  const result = await recall('前几天喜欢猫咪吗');
  assert.deepEqual(result.candidates.map(c => c.memoryId), ['new-state', 'old-state']);
  assert.match(result.context, /状态记录日期：2026-10-20/);
  const exact = await recall('10月20号喜欢猫咪吗');
  assert.deepEqual(exact.candidates.map(c => c.memoryId), ['new-state', 'old-state']);
});

test('a topicless empty window returns no matches and a topic still falls back outside it', async t => {
  const recall = fixture(t, [{ id: 'old', eventDate: '2026-09-13' }]);
  assert.equal((await recall('最近我们聊了什么')).status, 'no-match');
  assert.equal((await recall('最近聊过灯塔博物馆吗')).candidates[0].memoryId, 'old');
});

const testVector = (original, topic) => [original, topic, Math.sqrt(1 - original ** 2 - topic ** 2)];
const mealQuery = '2026年10月20日中午我吃了什么？';
const mealMemories = () => [
  { id: 'meal', content: '煮了碗面，坐在阳台享用。', embedding: testVector(0.45, 0.55) },
  { id: 'weak', content: '今天整理了书柜。', embedding: testVector(0.2, 0.49) },
  { id: 'duplicate', content: '午间做了一份炒饭。', embedding: testVector(0.6, 0.6) },
  { id: 'outside', content: '昨天煮了一碗粥。', eventStart: '2026-10-19T04:00:00Z', embedding: testVector(0.2, 0.85) },
  { id: 'ordinary-outside', content: '上周煮过一碗面。', eventStart: '2026-10-13T04:00:00Z', embedding: testVector(0.6, 0.2) },
  { id: 'unknown-date', content: '曾经做过一道炖菜。', metadata: { sourceTimeKnown: false }, embedding: testVector(0.2, 0.85) },
].map(memory => ({ kind: 'utterance', layer: 'evidence', eventStart: '2026-10-20T04:00:00Z', ...memory }));

test('exact-date topic retrieval preserves admission, dates, deduplication and batched billing in both execution modes', async t => {
  const recall = fixture(t, mealMemories());
  let first;
  for (const execution of ['inline', 'worker']) {
    const calls = [];
    const embeddingProvider = Object.assign(async () => { throw new Error('Queries should share the batch request.'); }, {
      async embedMany(texts) {
        calls.push(texts);
        return { model: 'calendar-test', vectors: [[1, 0, 0], [0, 1, 0]],
          requestId: 'one-batch', usage: { prompt_tokens: 17, total_tokens: 17 } };
      },
    });
    const usageLedgerPath = path.join(recall.root, `${execution}.jsonl`);
    const result = await recall(mealQuery, { execution, sqlPrefilterThreshold: 1 }, { embeddingProvider, usageLedgerPath });
    assert.deepEqual(result.candidates.map(candidate => candidate.memoryId).sort(), ['duplicate', 'meal', 'ordinary-outside']);
    assert.match(result.context, /煮了碗面/u);
    assert.doesNotMatch(result.context, /书柜|一碗粥|炖菜/u);
    assert.equal(result.candidates.find(candidate => candidate.memoryId === 'meal').lexicalScore, 0);
    assert.equal(result.candidates.find(candidate => candidate.memoryId === 'meal').queryRoute, 'calendar-topic');
    assert.equal(result.candidates.find(candidate => candidate.memoryId === 'ordinary-outside').queryRoute, 'original');
    assert.equal(result.records.filter(record => record.memoryId === 'duplicate').length, 1);
    assert.deepEqual(calls, [['2026年10月20日中午我吃了什么?', '中午我吃了什么?']]);
    const ledger = fs.readFileSync(usageLedgerPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].usage.prompt_tokens, 17);
    assert.equal(ledger[0].metadata.batchSize, 2);
    if (first) assert.deepEqual(result.candidates, first.candidates);
    else first = result;
  }
  const sameVector = Object.assign(async () => ({ model: 'calendar-test', vector: [1, 0, 0] }), {
    async embedMany() { return { model: 'calendar-test', vectors: [[1, 0, 0], [1, 0, 0]] }; },
  });
  const shared = await recall(mealQuery, { execution: 'inline' }, { embeddingProvider: sameVector });
  assert.equal(shared.candidates.find(candidate => candidate.memoryId === 'duplicate').score,
    first.candidates.find(candidate => candidate.memoryId === 'duplicate').score, 'Two routes must not add relevance or the date bonus twice.');
});

test('embedding failures retain successful routes and record each actual receipt', async t => {
  const recall = fixture(t, mealMemories());
  for (const failed of ['original', 'calendar-topic']) {
    const calls = [];
    const usageLedgerPath = path.join(recall.root, `${failed}.jsonl`);
    const embeddingProvider = async text => {
      calls.push(text);
      const original = text.includes('2026');
      const receipt = { model: 'calendar-test', requestId: text, usage: { prompt_tokens: 3, total_tokens: 3 } };
      if (original === (failed === 'original')) throw Object.assign(new Error('temporary provider failure'), receipt);
      return { ...receipt, vector: original ? [1, 0, 0] : [0, 1, 0] };
    };
    const result = await recall(mealQuery, { execution: 'inline' }, { embeddingProvider, usageLedgerPath });
    assert.equal(result.status, 'ready');
    assert.equal(result.vector.status, 'ready');
    assert.match(result.vector.warning, /temporary provider failure/u);
    assert.equal(result.candidates.some(candidate => candidate.memoryId === 'meal'), failed === 'original');
    assert.equal(result.candidates.some(candidate => candidate.memoryId === 'ordinary-outside'), failed === 'calendar-topic');
    assert.ok(!result.candidates.some(candidate => ['weak', 'outside', 'unknown-date'].includes(candidate.memoryId)));
    assert.equal(calls.length, 2);
    assert.equal(fs.readFileSync(usageLedgerPath, 'utf8').trim().split('\n').length, 2);
  }
  let batches = 0;
  const usageLedgerPath = path.join(recall.root, 'failed-batch.jsonl');
  const failedBatch = Object.assign(async () => { throw new Error('Unexpected scalar retry.'); }, {
    async embedMany() {
      batches++;
      throw Object.assign(new Error('batch unavailable'), { model: 'calendar-test', usage: { prompt_tokens: 6 } });
    },
  });
  const failed = await recall(mealQuery, { execution: 'worker' }, { embeddingProvider: failedBatch, usageLedgerPath });
  assert.equal(failed.status, 'no-match');
  assert.equal(failed.vector.status, 'error');
  assert.equal(batches, 1);
  assert.equal(fs.readFileSync(usageLedgerPath, 'utf8').trim().split('\n').length, 1);
});

test('date routing avoids extra requests without a scoped topic and cancels an active worker batch', async t => {
  const recall = fixture(t, mealMemories());
  const inputs = [];
  const embeddingProvider = async text => { inputs.push(text); return { model: 'calendar-test', vector: [1, 0, 0] }; };
  for (const query of ['中午我吃了什么？', '2026年10月20日', '2026年10月1日中午我吃了什么？', '“2026年10月20日”这句话']) {
    const previous = inputs.length;
    await recall(query, { execution: 'inline' }, { embeddingProvider });
    assert.equal(inputs.length - previous, 1, query);
  }
  const controller = new AbortController();
  let announce;
  const entered = new Promise(resolve => { announce = resolve; });
  let cancelled = false;
  const blocking = Object.assign(async () => { throw new Error('Expected batch.'); }, {
    embedMany(_texts, { signal }) {
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true });
        announce();
      });
    },
  });
  const pending = recall(mealQuery, { execution: 'worker' }, { embeddingProvider: blocking, signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered;
  controller.abort();
  await rejected;
  await closeRetrievalWorkers();
  assert.equal(cancelled, true);
});
