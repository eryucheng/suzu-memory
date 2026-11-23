import { extractionModelFixture } from '../../../test/support/extraction-fixtures.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase, resolveCalendarExpression } from '@suzu-memory/core';
import { archiveLongTermEvidence, buildLongTermExtractionInput, normalizeGeneratedLongTermExtraction,
  parseGeneratedExtractionRepair } from '../src/index.mjs';

const timestamp = '2023-08-23T07:31:00.000Z';
const message = (text, overrides = {}) => ({ id: 'source', role: 'user', speaker: 'User', timestamp, text, ...overrides });
const candidate = (content, overrides = {}) => ({ kind: 'event', title: 'Application', content,
  subjectRole: 'user', subjectName: 'User', actorRoles: [{ role: 'experiencer', actorRole: 'user', actorName: 'User', confidence: 1 }],
  canonicalKey: '', stateFamily: 'not_applicable', stateLabel: '', reality: 'real', evidenceMode: 'explicit',
  temporalState: 'historical', revisionAction: 'add', eventDate: '', eventStart: '', eventEnd: '', confidence: 1, importance: 0.6, sourceRefs: ['M0001'], ...overrides });

function extractWithTime(built, time, evidence = ['M0001']) {
  const [{ sourceRefs, ...draft }] = extractionModelFixture([candidate('User completed the application.')]);
  return normalizeGeneratedLongTermExtraction({ memories: [{ ...draft, evidence, time }] }, built).memories[0];
}

test('a date mentioned in original evidence never fills an unknown event date', () => {
  const built = buildLongTermExtractionInput({ messages: [message('我上周提交了申请，明天查申请进度。')] });
  assert.equal(extractWithTime(built, null).eventDate, '');
  assert.throws(() => extractWithTime(built, null, ['M9999']), /\.evidence/u);
});

test('a date resolved by the model from broader context remains a usable old-style date', () => {
  const built = buildLongTermExtractionInput({ messages: [message('7 月 1 日寄出。')] });
  assert.equal(extractWithTime(built, '2023-07-01').eventDate, '2023-07-01');
  assert.equal(extractWithTime(built, { date: '2023-07-01' }).eventDate, '2023-07-01');
});

test('a previous repair quote mentioning the date of an object cannot change the date of the action', () => {
  const quote = '昨天那炉面我早上切开看了';
  const built = buildLongTermExtractionInput({ messages: [message(quote + '，里面还是有点实。', {
    timestamp: '2026-04-12T04:38:00Z',
  })] });
  const [draft] = extractionModelFixture([candidate('罗杏子于 4 月 12 日切开昨天做的面。', { eventDate: '2026-04-12' })]);
  const result = parseGeneratedExtractionRepair({
    results: [{ candidateIndex: 0, status: 'repaired', memories: [{ ...draft, timeEvidence: { sourceRef: 'M0001', quote } }] }],
  }, built);
  assert.deepEqual(result.results[0].memories[0].time, { date: '2026-04-12' });
});

test('direct archive preserves the event and original evidence when its date and instant disagree', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const text = 'Yesterday I attended the review. Tomorrow I send the report.';
  const built = buildLongTermExtractionInput({ messages: [message(text)] });
  const visit = candidate('User attended the review.', { eventDate: '2023-08-22', eventStart: timestamp });
  const plan = candidate('User plans to send the report.', { eventDate: '2023-08-24', temporalState: 'planned' });
  const result = archiveLongTermEvidence({ repository, agentId: 'time-test', messages: built.messages,
    generatedMemories: [visit, plan], batchId: 'time-batch', recordedAt: timestamp, timeZone: built.timeZone });
  assert.equal(result.messagesArchived, 1);
  assert.equal(result.memoriesStored, 2);
  const [savedVisit, savedPlan] = result.candidateResults.map(item => repository.getMemory(item.memoryId));
  assert.equal(savedVisit.content, visit.content);
  assert.ok(!savedVisit.event_date && !savedVisit.event_start);
  assert.equal(savedPlan.event_date, '2023-08-24');
  assert.equal(repository.getMemory(result.utteranceMemoryIds[0]).content, text);
});

test('calendar periods anchored to an explicit date share the retrieval calendar convention', () => {
  for (const [text, start, end] of [
    ['the week before 2023-08-23', '2023-08-14', '2023-08-20'],
    ['the week of 2023-08-23', '2023-08-21', '2023-08-27'],
    ['2023年8月23日的前一周', '2023-08-14', '2023-08-20'],
    ['2023 年 8 月 23 日的前一周', '2023-08-14', '2023-08-20'],
    ['从 2023　年 8 月 22 日到 8 月 23 日', '2023-08-22', '2023-08-23'],
    ['the month after 2023-12-23', '2024-01-01', '2024-01-31'],
    ['the day after 2024-02-28', '2024-02-29', '2024-02-29'],
  ]) {
    const parsed = resolveCalendarExpression(text, timestamp);
    assert.deepEqual([parsed.startDate, parsed.endDate], [start, end], text);
    assert.equal(text.slice(parsed.span.start, parsed.span.end), text);
  }
});

test('invalid calendar dates and unzoned timestamps limit only the affected time', () => {
  for (const field of ['eventStart', 'eventEnd']) {
    for (const invalid of ['2026-02-30T08:00:00Z', '2026-08-04T08:00:00', 'August 4, 2026']) {
      const output = normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate('User visited the museum.', {
        [field]: invalid, eventDate: '2026-08-04',
      })] }));
      assert.equal(output.memories[0][field], '');
      assert.equal(output.memories[0].eventDate, '2026-08-04');
    }
  }
  const [draft] = extractionModelFixture([candidate('User visited the museum.', { eventDate: '2026-02-30' })]);
  assert.equal(normalizeGeneratedLongTermExtraction({ memories: [draft] }).memories[0].eventDate, '');
  const { time, ...withoutTime } = draft;
  assert.equal(normalizeGeneratedLongTermExtraction({ memories: [withoutTime] }).memories[0].eventDate, '');
});

test('checks agreement among structured fields in the configured time zone', () => {
  const fields = { eventDate: '2026-08-04', eventStart: '2026-08-05T03:00:00Z', eventEnd: '2026-08-06T04:00:00Z' };
  const value = fields => extractionModelFixture([candidate('User visited the museum.', fields)]);
  const valid = normalizeGeneratedLongTermExtraction({ memories: value(fields) }, { timeZone: 'America/Los_Angeles' }).memories[0];
  assert.equal(valid.eventDate, '2026-08-04');
  assert.equal(valid.eventEnd, '2026-08-06T04:00:00.000Z');
  for (const [input, timeZone] of [[fields, 'Asia/Shanghai'], [{ ...fields, eventEnd: '2026-08-04T03:00:00Z' }, 'America/Los_Angeles']]) {
    const output = normalizeGeneratedLongTermExtraction({ memories: value(input) }, { timeZone }).memories[0];
    assert.equal(output.content, valid.content);
    assert.ok(!output.eventDate && !output.eventStart && !output.eventEnd);
  }
});
