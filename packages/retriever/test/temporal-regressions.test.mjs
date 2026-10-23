import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { planVectorQuery, recallCorePhrases, resolveTemporalQuery, retrieveMemories } from '../src/index.mjs';

test('plural pronouns are removed as whole words for lexical and vector queries', () => {
  for (const pronoun of ['我们', '你们', '他们', '她们', '它们', '咱们']) {
    assert.deepEqual(recallCorePhrases(`${pronoun}聊过猫吗`), ['聊过猫']);
    assert.equal(planVectorQuery(`${pronoun}聊过猫吗`).text, '聊过猫');
  }
});

test('yearless Chinese and English recall dates use the most recent occurrence', () => {
  const now = new Date('2027-01-08T12:00:00+08:00');
  for (const query of ['12月25号聊了什么', 'What happened on December 25?', 'What happened on the 25th of December?']) {
    const temporal = resolveTemporalQuery(query, now);
    assert.equal(temporal.startDate, '2026-12-25', query);
    assert.equal(temporal.endDate, '2026-12-25', query);
  }
  for (const query of ['What happened in December?', 'What happened during December?']) {
    const temporal = resolveTemporalQuery(query, now);
    assert.equal(temporal.startDate, '2026-12-01', query);
    assert.equal(temporal.endDate, '2026-12-31', query);
  }
  const combined = resolveTemporalQuery('What happened in December and January?', now);
  assert.equal(combined.startDate, '2026-12-01');
  assert.equal(combined.endDate, '2027-01-31');
});

test('explicit years and current calendar periods retain their meaning', () => {
  const now = new Date('2027-01-08T12:00:00+08:00');
  for (const query of ['2027年12月25号', '2027-12-25', 'December 25, 2027', '今年12月25号']) {
    assert.equal(resolveTemporalQuery(query, now).startDate, '2027-12-25', query);
  }
  assert.equal(resolveTemporalQuery('明年12月25号', now).startDate, '2028-12-25');
  assert.equal(resolveTemporalQuery('去年12月25号', now).startDate, '2026-12-25');
  assert.equal(resolveTemporalQuery('in December 2027', now).startDate, '2027-12-01');
  assert.equal(resolveTemporalQuery('in January', now).startDate, '2027-01-01');
  assert.equal(resolveTemporalQuery('1月8号', now).startDate, '2027-01-08');
  assert.equal(resolveTemporalQuery('明天', now).startDate, '2027-01-09');
});

test('yearless leap dates find a valid past occurrence', () => {
  const now = new Date('2026-01-08T12:00:00+08:00');
  assert.equal(resolveTemporalQuery('2月29号聊了什么', now).startDate, '2024-02-29');
  assert.equal(resolveTemporalQuery('What happened on February 29?', now).startDate, '2024-02-29');
});

test('an invalid date with an explicit year never falls back to another year', () => {
  const now = new Date('2027-01-08T12:00:00+08:00');
  for (const query of ['2027年2月29号', '2027-02-29', 'February 29, 2027', '今年2月29号', '2月30号']) {
    assert.equal(resolveTemporalQuery(query, now).matched, false, query);
  }
  assert.equal(resolveTemporalQuery('2028年2月29号', now).startDate, '2028-02-29');
});

test('calendar year selection uses the query timezone at New Year', () => {
  const now = new Date('2026-12-31T16:30:00Z');
  assert.equal(resolveTemporalQuery('12月31号', now, 'Asia/Shanghai').startDate, '2026-12-31');
  assert.equal(resolveTemporalQuery('in December', now, 'Asia/Shanghai').startDate, '2026-12-01');
});

test('temporal evidence recall uses the same local date as the query', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-calendar-recall-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const databasePath = path.join(root, 'memory.db');
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  for (const [id, timestamp] of [
    ['morning-0730', '2026-10-22T07:30:00+08:00'],
    ['morning-1030', '2026-10-22T10:30:00+08:00'],
    ['previous-local-day', '2026-10-21T23:59:59+08:00'],
    ['next-local-day', '2026-10-23T00:00:00+08:00'],
    ['christmas', '2026-12-25T07:30:00+08:00'],
    ['los-angeles-evening', '2026-08-04T03:30:00Z'],
  ]) repository.upsertMemory({ id, agentId: 'calendar-agent', kind: 'utterance', layer: 'evidence',
    content: '今天聊了灯塔博物馆的展览。', subjectRole: 'user', subjectKey: 'user',
    eventStart: new Date(timestamp).toISOString(), recordedAt: new Date(timestamp).toISOString(),
    metadata: { speaker: 'User' } });
  database.close();
  const recall = (query, now, timeZone = 'Asia/Shanghai') => retrieveMemories({ databasePath,
    agentId: 'calendar-agent', query, now: new Date(now), options: { timeZone, maximumReturnedCandidates: 10 } });
  const yesterday = await recall('昨天聊了灯塔博物馆', '2026-10-23T12:00:00+08:00');
  assert.equal(yesterday.status, 'ready');
  assert.deepEqual(yesterday.candidates.filter(candidate => candidate.temporalRanking?.timeScore > 0).map(candidate => candidate.memoryId).sort(), ['morning-0730', 'morning-1030']);
  const christmas = await recall('12月25号聊了灯塔博物馆', '2027-01-08T12:00:00+08:00');
  assert.equal(christmas.status, 'ready');
  assert.deepEqual(christmas.candidates.filter(candidate => candidate.temporalRanking?.timeScore > 0).map(candidate => candidate.memoryId), ['christmas']);
  const sharedChristmas = await recall('12月25号我们去干什么了', '2027-01-05T12:00:00+08:00');
  assert.equal(sharedChristmas.status, 'ready');
  assert.deepEqual(sharedChristmas.candidates.map(candidate => candidate.memoryId), ['christmas']);
  const pacific = await recall('昨天聊了灯塔博物馆', '2026-08-04T19:00:00Z', 'America/Los_Angeles');
  assert.equal(pacific.status, 'ready');
  assert.deepEqual(pacific.candidates.filter(candidate => candidate.temporalRanking?.timeScore > 0).map(candidate => candidate.memoryId), ['los-angeles-evening']);
});
