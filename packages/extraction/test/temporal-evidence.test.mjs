import { extractionModelFixture } from '../../../test/support/extraction-fixtures.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase, resolveCalendarExpression } from '@suzu-memory/core';
import { archiveLongTermEvidence, buildLongTermExtractionInput, normalizeGeneratedLongTermExtraction } from '../src/index.mjs';

const timestamp = '2023-08-23T07:31:00.000Z';
const message = (text, overrides = {}) => ({ id: 'source', role: 'user', speaker: 'User', timestamp, text, ...overrides });
const candidate = (content, overrides = {}) => ({ kind: 'event', title: 'Application', content,
  subjectRole: 'user', subjectName: 'User', actorRoles: [{ role: 'experiencer', actorRole: 'user', actorName: 'User', confidence: 1 }],
  canonicalKey: '', stateFamily: 'not_applicable', stateLabel: '', reality: 'real', evidenceMode: 'explicit',
  temporalState: 'historical', revisionAction: 'add', eventDate: '', eventStart: '', eventEnd: '', confidence: 1, importance: 0.6, sourceRefs: ['M0001'], ...overrides });
const conflict = { code: 'MEMORY_EXTRACTION_TIME_CONFLICT' };

for (const [language, source, wrong, correct] of [
  ['en', 'This week I applied to adoption agencies.', 'In the week before 2023-08-23, User applied to adoption agencies.',
    'In the week of 2023-08-23, User applied to adoption agencies.'],
  ['zh', '这周我向收养机构提交了申请。', 'User 在上周向收养机构提交了申请。', 'User 在本周向收养机构提交了申请。'],
]) {
  test('rejects a shifted event week using only its own sources: ' + language, () => {
    const built = buildLongTermExtractionInput({ messages: [message(source),
      message(language === 'en' ? 'I painted a self-portrait last week.' : '我上周画了一幅自画像。', { id: 'painting' })] });
    assert.throws(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate(wrong)] }), built), conflict);
    assert.equal(normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate(correct)] }), built).memories.length, 1);
    assert.equal(built.messages.length, 2);
  });
}

for (const field of ['eventDate', 'eventStart', 'eventEnd']) test('rejects an event field contradicting its stated interval: ' + field, () => {
  const built = buildLongTermExtractionInput({ messages: [message('I painted a self-portrait last week.')] });
  const content = 'In the week before 2023-08-23, User painted a self-portrait.';
  const wrong = candidate(content, { [field]: field === 'eventDate' ? '2023-08-23' : timestamp });
  assert.throws(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [wrong] }), built), conflict);
  assert.equal(normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate(content)] }), built).memories[0][field], '');
});

test('compares content against the referenced source, including absolute dates and ranges', () => {
  for (const [source, wrong, right] of [
    ['I applied yesterday.', 'On 2023-08-20, User applied.', 'On 2023-08-22, User applied.'],
    ['我昨天提交了申请。', 'User 在2023年8月20日提交申请。', 'User 在2023年8月22日提交申请。'],
    ['I applied this week.', 'User applied from 2023-08-14 to 2023-08-20.', 'User applied from 2023-08-21 to 2023-08-27.'],
  ]) {
    const built = buildLongTermExtractionInput({ messages: [message(source)] });
    assert.throws(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate(wrong)] }), built), conflict);
    assert.doesNotThrow(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate(right)] }), built));
  }
});

test('checks dates in titles as well as content and ignores rejected source dates', () => {
  const built = buildLongTermExtractionInput({ messages: [message('I applied this week, not last week.')] });
  const correct = candidate('In the week of 2023-08-23, User applied.');
  assert.throws(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [{ ...correct, title: 'Applied last week' }] }), built), conflict);
  assert.throws(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate('User applied last week.')] }), built), conflict);
  assert.doesNotThrow(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [correct] }), built));
});

test('a date field must agree with the summary even when the source has no calendar expression', () => {
  const built = buildLongTermExtractionInput({ messages: [message('I applied.')] });
  assert.throws(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate('User applied on 2023-08-22.', { eventDate: '2023-08-21' })] }), built), conflict);
});

test('keeps reporting dates separate from event dates and leaves unrelated states alone', () => {
  for (const [source, content, kind, eventDate] of [
    ['I went to a support group yesterday.', 'On 2023-08-22 (yesterday relative to the 2023-08-23 conversation), User attended a support group.', 'event', '2023-08-22'],
    ['I painted it last year.', 'During the 2023-08-23 chat, User shared a photo of a painting made last year.', 'event', '2023-08-23'],
    ['I love my work. We might go camping next month.', 'User reflected on loving their work.', 'reflection', '2023-08-23'],
  ]) {
    const built = buildLongTermExtractionInput({ messages: [message(source)] });
    assert.doesNotThrow(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate(content, { kind, eventDate })] }), built));
  }
});

test('uses the configured timezone at a week boundary', () => {
  const built = buildLongTermExtractionInput({ timeZone: 'America/Los_Angeles',
    messages: [message('This week I applied.', { timestamp: '2023-08-21T02:00:00Z' })] });
  assert.equal(built.timeZone, 'America/Los_Angeles');
  assert.doesNotThrow(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate('User applied in the week of 2023-08-20.')] }), built));
  assert.throws(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate('User applied in the week of 2023-08-21.')] }), built), conflict);
});

test('multiple source dates do not force relative phrases onto the earliest message', () => {
  const built = buildLongTermExtractionInput({ messages: [message('This week I painted.', { timestamp: '2023-08-16T07:00:00Z' }),
    message('This week I applied.', { id: 'later' })] });
  assert.doesNotThrow(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate('This week User applied.', { sourceRefs: ['M0001', 'M0002'] })] }), built));
});

test('unknown source time and unrecognized expressions do not become invented calendar constraints', () => {
  for (const source of [message('I applied this week.', { timestamp: 'unknown' }),
    message('I applied this week.', { sourceMetadata: { sourceTimeKnown: false } }),
    message('I applied some time ago.')]) {
    const built = buildLongTermExtractionInput({ messages: [source] });
    assert.doesNotThrow(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate('User applied in the week before 2023-08-23.')] }), built));
  }
});

test('the archive boundary retains raw evidence and valid neighbors when a direct caller supplies a time conflict', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const built = buildLongTermExtractionInput({ messages: [message('This week I applied.')] });
  const wrong = candidate('In the week before 2023-08-23, User applied.');
  const valid = candidate('In the week of 2023-08-23, User applied.');
  const result = archiveLongTermEvidence({ repository, agentId: 'time-test', messages: built.messages,
    generatedMemories: [wrong, valid], batchId: 'time-batch', recordedAt: timestamp, timeZone: built.timeZone });
  assert.equal(result.messagesArchived, 1);
  assert.equal(result.memoriesStored, 1);
  assert.equal(result.memoriesForReview, 1);
  assert.deepEqual(result.candidateResults[0].reasons, ['source-time-conflict']);
  assert.equal(result.candidateResults[0].provisionalMemoryId, '');
  assert.equal(repository.getMemory(result.utteranceMemoryIds[0]).content, 'This week I applied.');
  assert.equal(repository.getMemory(result.candidateResults[1].memoryId).content, valid.content);
});

test('calendar periods anchored to an explicit date share the retrieval calendar convention', () => {
  for (const [text, start, end] of [
    ['the week before 2023-08-23', '2023-08-14', '2023-08-20'],
    ['the week of 2023-08-23', '2023-08-21', '2023-08-27'],
    ['2023年8月23日的前一周', '2023-08-14', '2023-08-20'],
    ['the month after 2023-12-23', '2024-01-01', '2024-01-31'],
    ['the day after 2024-02-28', '2024-02-29', '2024-02-29'],
  ]) {
    const parsed = resolveCalendarExpression(text, timestamp);
    assert.deepEqual([parsed.startDate, parsed.endDate], [start, end], text);
  }
});

test('invalid calendar dates and unzoned timestamps cannot be normalized into a different event time', () => {
  for (const field of ['eventStart', 'eventEnd']) for (const invalid of ['2026-02-30T08:00:00Z', '2026-08-04T08:00:00', 'August 4, 2026']) {
    assert.throws(() => normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate('User visited the museum.', { [field]: invalid })] })), /ISO 8601/);
  }
  const output = normalizeGeneratedLongTermExtraction(extractionModelFixture({ memories: [candidate('User visited the museum.', { eventStart: '2026-08-04T08:00:00+08:00' })] }));
  assert.equal(output.memories[0].eventStart, '2026-08-04T00:00:00.000Z');
});

for (const language of ['en', 'zh']) test(`event date and start agree in the configured timezone even without dated prose: ${language}`, () => {
  const text = language === 'en' ? 'User visited the museum.' : 'User 参观了博物馆。';
  const value = fields => extractionModelFixture({ memories: [candidate(text, fields)] });
  assert.throws(() => normalizeGeneratedLongTermExtraction(value({ eventDate: '2026-08-04', eventStart: '2026-08-06T08:00:00Z' })), conflict);
  const dateFields = { eventDate: '2026-08-04', eventStart: '2026-08-05T03:00:00Z', eventEnd: '2026-08-06T04:00:00Z' };
  const valid = normalizeGeneratedLongTermExtraction(value(dateFields), { timeZone: 'America/Los_Angeles' }).memories[0];
  assert.equal(valid.eventDate, '2026-08-04');
  assert.equal(valid.eventEnd, '2026-08-06T04:00:00.000Z');
  assert.throws(() => normalizeGeneratedLongTermExtraction(value(dateFields), { timeZone: 'Asia/Shanghai' }), conflict);
});
