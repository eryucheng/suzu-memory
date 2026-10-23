import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { resolveTemporalQuery, retrieveMemories } from '../src/index.mjs';
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

test('unbounded topicless recall covers historical periods despite dense recent dialogue', async t => {
  const memories = [
    { id: 'oldest', eventDate: '2024-01-01' },
    { id: 'middle', eventDate: '2025-05-01' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: `recent-${i}`, eventDate: '2026-10-22' })),
  ];
  for (const kind of ['event', 'utterance']) {
    const recall = fixture(t, memories.map(memory => ({ ...memory, kind, layer: kind === 'utterance' ? 'raw' : 'episodic',
      eventStart: `${memory.eventDate}T07:30:00+08:00`, recordedAt: `${memory.eventDate}T07:30:00+08:00` })));
    const historical = await recall('以前我们聊了什么', { maximumReturnedCandidates: 3, maximumChainMemories: 3 });
    assert.equal(historical.status, 'ready');
    assert.ok(historical.candidates.some(c => c.memoryId === 'oldest'));
    assert.ok(historical.candidates.some(c => c.memoryId === 'middle'));
    assert.match(historical.context, /2024-01-01/);
    assert.match(historical.context, /2025-05-01/);
    const recent = await recall('最近我们聊了什么', { maximumReturnedCandidates: 3 });
    assert.ok(recent.candidates.every(c => c.memoryId.startsWith('recent-')));
    const topic = await recall('以前聊过灯塔博物馆吗');
    assert.ok(topic.candidates.every(c => c.temporalRanking.topicScore > 0));
  }
});

test('topicless historical utterance recall keeps the requested speaker while covering history', async t => {
  const recall = fixture(t, [
    { id: 'agent-old', eventDate: '2024-01-01' },
    { id: 'agent-middle', eventDate: '2025-05-01' },
    ...Array.from({ length: 25 }, (_, i) => ({ id: `agent-new-${i}`, eventDate: '2026-10-22' })),
  ].map(memory => ({ ...memory, kind: 'utterance', layer: 'raw', subjectRole: 'agent', subjectKey: 'window-agent',
    eventStart: `${memory.eventDate}T07:30:00+08:00` })).concat([{
    id: 'other-speaker', kind: 'utterance', layer: 'raw', subjectRole: 'user', subjectKey: 'user',
    eventStart: '2020-01-01T07:30:00+08:00', importance: 1, content: '另一位说话人的原话。',
  }]));
  const result = await recall('你以前说过什么', { maximumReturnedCandidates: 3 });
  assert.ok(result.candidates.some(c => c.memoryId === 'agent-old'));
  assert.ok(result.candidates.some(c => c.memoryId === 'agent-middle'));
  assert.ok(result.candidates.every(c => c.memoryId !== 'other-speaker'));
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
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'memory.db');
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  try {
    for (const memory of memories) repository.upsertMemory({ agentId: 'window-agent', kind: 'event', layer: 'episodic',
      subjectRole: 'user', subjectKey: 'user', content: '讨论过灯塔博物馆的展览。',
      importance: 0.5, ...memory });
  } finally { database.close(); }
  return (query, options = {}, extra = {}) => retrieveMemories({ databasePath, agentId: 'window-agent', query, now,
    options: { maximumReturnedCandidates: 10, includeCandidateContext: true, ...options }, ...extra });
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

test('vague topic recall still invokes BM25 and vector routes with the time phrase removed', async t => {
  const recall = fixture(t, [{ id: 'old', eventDate: '2026-09-13' }]);
  const inputs = [];
  const result = await recall('两周前聊过灯塔博物馆吗', {}, { embeddingProvider: async text => {
    inputs.push(text); return { model: 'window-test', vector: [1, 0] };
  } });
  assert.equal(result.status, 'ready');
  assert.ok(result.seedRouting.plannedRoutes.includes('bm25'));
  assert.ok(result.seedRouting.plannedRoutes.includes('vector'));
  assert.ok(inputs.length > 0);
  assert.ok(inputs.every(text => !text.includes('两周前')));
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
  assert.deepEqual(latest.candidates.map(c => c.memoryId), ['recent']);
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
