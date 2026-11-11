import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase, memoryRetrievalContextSourceHash, proposeMemoryStructure } from '@suzu-memory/core';
import { lexicalScore, lexicalTerms, closeRetrievalWorker, recallCorePhrases, resolveTemporalQuery, retrieveMemories } from '../src/index.mjs';

const now = new Date('2026-10-23T07:30:00+08:00');
const perspective = { speakerRole: 'user', speakerKey: 'caroline', speakerNames: ['Caroline'],
  addresseeRole: 'agent', addresseeKey: 'melanie', addresseeNames: ['Melanie'] };

test('quoted time words remain topics while dates outside quotes keep their original spans', async t => {
  for (const query of ['What did I say about "Yesterday"?', '我对电影《昨天》的原话是什么',
    'What is "last summer" about?', '我说过「去年」这两个字吗', "What did I say about '2025-05-25'?",
    "我对'昨天'的原话是什么", "我对'2025-05-25'的原话是什么"]) {
    const temporal = resolveTemporalQuery(query, now);
    assert.equal(temporal.matched, false, query);
    assert.equal(temporal.remainingQuery, query, query);
  }
  for (const [query, expression, remaining] of [
    ['What did I say about "Yesterday" yesterday?', 'yesterday', 'What did I say about "Yesterday" ?'],
    ['昨天我对《明天》的原话是什么', '昨天', '我对《明天》的原话是什么'],
    ['ﬃ "yesterday" yesterday', 'yesterday', 'ﬃ "yesterday"'],
    ['😀 ＂yesterday＂ yesterday', 'yesterday', '😀 ＂yesterday＂'],
    ["What did O’Neill say yesterday?", 'yesterday', 'What did O’Neill say ?'],
  ]) {
    const temporal = resolveTemporalQuery(query, now);
    assert.equal(temporal.expression, expression, query);
    assert.equal(temporal.startDate, '2026-10-22', query);
    assert.equal(temporal.remainingQuery, remaining, query);
    assert.deepEqual(Object.getOwnPropertySymbols(temporal), [], 'Internal parse spans are not public fields.');
  }
  const recall = fixture(t, [
    { id: 'movie', kind: 'utterance', layer: 'evidence',
      content: 'I like the movie "Yesterday". 我对电影《昨天》的评价是很好看。', metadata: { speaker: 'Caroline' },
      eventStart: '2026-10-01T08:30:00+08:00', eventDate: '2026-10-01' },
    { id: 'museum', kind: 'utterance', layer: 'evidence',
      content: 'I visited a museum yesterday. 我昨天参观了博物馆。', metadata: { speaker: 'Caroline' },
      eventStart: '2026-10-22T08:30:00+08:00', eventDate: '2026-10-22' },
  ]);
  for (const query of ['What did I say about the movie "Yesterday"?', '我对电影《昨天》的原话是什么']) {
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.seedRouting.primaryMemoryId, 'movie', query);
    assert.ok(result.candidates.every(item => item.memoryId !== 'museum'), query);
  }
});

test('English date qualifiers belong to the whole date and are removed from the topic', () => {
  for (const [query, startDate, endDate] of [
    ['May 25 of last year', '2025-05-25', '2025-05-25'],
    ['25th of May of last year', '2025-05-25', '2025-05-25'],
    ['May 25 of 2025', '2025-05-25', '2025-05-25'],
    ['May 25 in 2025', '2025-05-25', '2025-05-25'],
    ['in May of last year', '2025-05-01', '2025-05-31'],
    ['in May of next year', '2027-05-01', '2027-05-31'],
    ['from May 25 of 2025 to June 25 of 2025', '2025-05-25', '2025-06-25'],
  ]) {
    const temporal = resolveTemporalQuery(query, now);
    assert.deepEqual(temporal.coreWindow, { startDate, endDate }, query);
    assert.equal(temporal.remainingQuery, '', query);
  }
});

test('incomplete temporal ranges and alternatives never collapse into their first day', () => {
  for (const query of ['May 25 or June 25', 'before May 25', 'after May 25', '5月25日之前', '5月25日以后']) {
    assert.equal(resolveTemporalQuery(query, now).matched, false, query);
  }
  assert.equal(resolveTemporalQuery('May 25 to visit the museum', now).startDate, '2026-05-25');
  assert.equal(resolveTemporalQuery('day before yesterday', now).startDate, '2026-10-21');
});

for (const [query, startDate, endDate] of [
  ['from May 25 to June 25', '2026-05-25', '2026-06-25'],
  ['between May 25 and June 25', '2026-05-25', '2026-06-25'],
  ['5月25日到6月25日', '2026-05-25', '2026-06-25'],
  ['from December 25 to January 5, 2025', '2024-12-25', '2025-01-05'],
  ['去年12月25号到1月5号', '2025-12-25', '2026-01-05'],
  ['2025-12-25 至 2026-01-05', '2025-12-25', '2026-01-05'],
]) test(`bounded calendar ranges reuse endpoint parsing: ${query}`, () => {
  const parsed = resolveTemporalQuery(query, now);
  assert.deepEqual(parsed.coreWindow, { startDate, endDate });
  assert.equal(parsed.remainingQuery, '');
});

test('English topicless questions retrieve the full bounded interval through the existing date route', async t => {
  const recall = fixture(t, [{ id: 'first', eventDate: '2026-05-26', content: 'Caroline visited the science museum.' },
    { id: 'second', eventDate: '2026-06-10', content: 'Caroline attended a violin concert.' },
    { id: 'outside', eventDate: '2026-07-01', content: 'Caroline went swimming.' }]);
  const result = await recall('What happened from May 25 to June 25?');
  assert.equal(result.status, 'ready');
  assert.deepEqual(new Set(result.candidates.map(item => item.memoryId)), new Set(['first', 'second']));
  assert.match(result.context, /Caroline visited the science museum\./u);
  assert.match(result.context, /Caroline attended a violin concert\./u);
  assert.doesNotMatch(result.context, /Caroline went swimming\./u);
});

test('calendar parser returns bounded valid windows or ordinary retrieval fallback for boundary years', () => {
  for (const query of ['spring 0000', 'winter 9999', 'December 9999', 'first half of 0000',
    '0000年夏天', '9999年冬天', '0025年3月4日', 'in January 0025']) {
    const parsed = resolveTemporalQuery(query, now);
    if (!parsed.matched) continue;
    for (const period of [parsed.coreWindow, parsed.toleranceWindow]) {
      assert.match(period.startDate, /^\d{4}-\d{2}-\d{2}$/u, query);
      assert.match(period.endDate, /^\d{4}-\d{2}-\d{2}$/u, query);
      assert.ok(period.startDate <= period.endDate, query);
    }
  }
  assert.equal(resolveTemporalQuery('spring 0000', now).matched, false);
  assert.equal(resolveTemporalQuery('winter 9999', now).matched, false);
});

test('calendar validity is preserved across year boundaries, leap days and English/Chinese formats', () => {
  for (const year of ['0000', '0001', '0099', '0100', '1900', '2000', '2026', '9999']) {
    for (const query of [`${year}-02-29`, `February 29, ${year}`, `${year}年2月29日`,
      `spring ${year}`, `winter ${year}`, `first half of ${year}`, `in December ${year}`]) {
      const parsed = resolveTemporalQuery(query, now);
      if (!parsed.matched) continue;
      for (const period of [parsed.coreWindow, parsed.toleranceWindow]) {
        assert.match(period.startDate, /^\d{4}-\d{2}-\d{2}$/u, query);
        assert.match(period.endDate, /^\d{4}-\d{2}-\d{2}$/u, query);
        assert.ok(period.startDate <= period.endDate, query);
        assert.ok(Number.isFinite(Date.parse(period.startDate)), query);
        assert.ok(Number.isFinite(Date.parse(period.endDate)), query);
      }
    }
  }
  assert.equal(resolveTemporalQuery('1900-02-29', now).matched, false);
  assert.equal(resolveTemporalQuery('2000-02-29', now).startDate, '2000-02-29');
});

test('English accented words remain complete words across lexical matching', () => {
  assert.deepEqual(lexicalTerms('résumé café fiancé'), ['résumé', 'café', 'fiancé']);
  assert.equal(lexicalScore('résumé', 'The sum is ten.').overlap, 0);
  assert.equal(lexicalScore('résumé', 'Caroline edited her résumé.').overlap, 1);
});

// Equivalent meanings must produce the same downstream contract, rather than
// maintain different English ranking or state-selection behavior.
for (const [english, chinese] of [
  ['two weeks ago', '两周前'], ['twenty-nine days ago', '二十九天前'],
  ['a couple of weeks ago', '两周前'], ['a few days ago', '前几天'],
  ['several weeks ago', '几周前'], ['half a year ago', '半年前'],
  ['a fortnight ago', '两周前'], ['these days', '这几天'],
  ['recently', '最近'], ['lately', '近来'], ['a while ago', '前段时间'],
  ['in the past', '以前'], ['last time', '上次'],
  ['this summer', '今年夏天'], ['last winter', '去年冬天'],
  ['in spring', '春天'], ['summer of 2025', '2025年夏天'],
  ['the first half of this year', '今年上半年'], ['the end of last year', '去年年底'],
  ['one hundred and five days ago', '105天前'], ['a couple weeks ago', '两周前'],
  ['one and a half years ago', '18个月前'], ['0.5 years ago', '半年前'],
  ['a year and a half ago', '18个月前'],
]) test(`shared calendar contract: ${english}`, () => {
  const pick = parsed => ({ matched: parsed.matched, precision: parsed.precision, kind: parsed.kind,
    coreWindow: parsed.coreWindow, toleranceWindow: parsed.toleranceWindow, ordering: parsed.ordering });
  assert.deepEqual(pick(resolveTemporalQuery(english, now)), pick(resolveTemporalQuery(chinese, now)));
  assert.equal(resolveTemporalQuery(english, now).remainingQuery, '');
});

test('English quantity parsing consumes the complete amount and never reuses an unsupported tail', () => {
  const decimal = resolveTemporalQuery('1.5 days ago', now);
  assert.equal(decimal.expression, '1.5 days ago');
  assert.deepEqual(decimal.coreWindow, { startDate: '2026-10-20', endDate: '2026-10-22' });
  assert.equal(resolveTemporalQuery('one thousand and five days ago', now).matched, false);
  assert.equal(resolveTemporalQuery('one million and five days ago', now).matched, false);
  assert.equal(resolveTemporalQuery('-5 days ago', now).matched, false);
  assert.deepEqual(resolveTemporalQuery('1,000 days ago', now).coreWindow,
    resolveTemporalQuery('1000 days ago', now).coreWindow);
  assert.equal(resolveTemporalQuery('1,105 days ago', now).matched, false);
  const rolling = resolveTemporalQuery('over the past one and a half months', now);
  assert.equal(rolling.expression, 'over the past one and a half months');
  assert.deepEqual(rolling.coreWindow, { startDate: '2026-09-07', endDate: '2026-10-23' });
});

for (const [query, start, end] of [
  ['What happened in 2024?', '2024-01-01', '2024-12-31'],
  ['What happened last year in December?', '2025-12-01', '2025-12-31'],
  ['What happened in December last year?', '2025-12-01', '2025-12-31'],
  ['What happened on December 25 last year?', '2025-12-25', '2025-12-25'],
  ['What happened over the past two weeks?', '2026-10-09', '2026-10-23'],
  ['What happened last Monday?', '2026-10-19', '2026-10-19'],
  ['What happened last Friday?', '2026-10-16', '2026-10-16'],
  ['What happens next Sunday?', '2026-10-25', '2026-10-25'],
  ['What happened last summer?', '2026-06-01', '2026-08-31'],
  ['What happens next winter?', '2026-12-01', '2027-02-28'],
  ['What happened in summer last year?', '2025-06-01', '2025-08-31'],
  ['What happened last year in spring?', '2025-03-01', '2025-05-31'],
  ['What happened on 25 December 2025?', '2025-12-25', '2025-12-25'],
  ['What happened in May 2025?', '2025-05-01', '2025-05-31'],
  ['What happened on Dec. 25, 2025?', '2025-12-25', '2025-12-25'],
]) test(`English calendar syntax: ${query}`, () => {
  const parsed = resolveTemporalQuery(query, now);
  assert.deepEqual(parsed.coreWindow, { startDate: start, endDate: end });
  assert.doesNotMatch(parsed.remainingQuery, /last year|December|two weeks|2024/iu);
});

test('English words respect boundaries while regular inflections retain lexical evidence', () => {
  assert.deepEqual(lexicalScore('cat', 'Caroline discussed education.').matchedTerms, []);
  assert.deepEqual(lexicalScore('art', 'Melanie visited a department store.').matchedTerms, []);
  for (const [query, content] of [['paint', 'She painted a sunrise.'], ['cats', 'A cat lives here.'],
    ['running', 'He runs every morning.'], ['coffee', 'She drinks coffee.'],
    ['well-being', 'She talked about her well-being.']]) {
    assert.ok(lexicalScore(query, content).overlap > 0, `${query}: ${content}`);
  }
  assert.deepEqual(recallCorePhrases('What did we discuss?'), []);
});

test('English silent-e and doubled-consonant inflections do not merge distinct words', () => {
  assert.equal(lexicalScore('hoping', 'Caroline was hopping.').overlap, 0);
  assert.equal(lexicalScore('hopped', 'Caroline hoped to visit.').overlap, 0);
  for (const [query, content] of [['hoping', 'She hoped to visit.'], ['hopping', 'She hopped away.'],
    ['using', 'She uses a paintbrush.'], ['painted', 'She paints landscapes.']]) {
    assert.ok(lexicalScore(query, content).overlap > 0, `${query}: ${content}`);
  }
});

for (const [root, inflected] of [['call', 'calling'], ['fall', 'falling'], ['pass', 'passed'],
  ['fill', 'filled'], ['stuff', 'stuffed'], ['add', 'added'], ['cancel', 'cancelled'], ['lie', 'lying'],
  ['class', 'classes'], ['bus', 'buses'], ['glass', 'glasses'], ['quiz', 'quizzes'], ['gas', 'gases']]) {
  test(`English inflections preserve existing root letters: ${root}/${inflected}`, () => {
    assert.equal(lexicalScore(root, inflected).overlap, 1);
    assert.equal(lexicalScore(inflected, root).overlap, 1);
  });
}

test('English inflection matching does not invent shortened person names', () => {
  assert.equal(lexicalScore('Cal', 'She was calling.').overlap, 0);
  assert.equal(lexicalScore('ad', 'She added a note.').overlap, 0);
});

for (const [query, start, end] of [
  ['in May of 2025', '2025-05-01', '2025-05-31'],
  ['May of 2025', '2025-05-01', '2025-05-31'],
  ['in September and October 2025', '2025-09-01', '2025-10-31'],
  ['from December 2024 to January 2025', '2024-12-01', '2025-01-31'],
  ['between December and January 2025', '2024-12-01', '2025-01-31'],
  ['in December and January', '2025-12-01', '2026-01-31'],
  ['last May', '2026-05-01', '2026-05-31'],
  ['next May', '2027-05-01', '2027-05-31'],
  ['this November', '2026-11-01', '2026-11-30'],
]) test(`English month qualifiers and ranges stay intact: ${query}`, () => {
  const parsed = resolveTemporalQuery(query, now);
  assert.deepEqual(parsed.coreWindow, { startDate: start, endDate: end });
  assert.equal(parsed.remainingQuery, '');
});

test('negated English dates and invalid month ranges cannot create a positive time constraint', () => {
  for (const query of ['not yesterday', 'not on December 25', 'not last year', 'not in May 2025',
    'anything except today', 'not 2025-10-26', 'from December 2025 to January 2024']) {
    assert.equal(resolveTemporalQuery(query, now).matched, false, query);
  }
});

function fixture(t, memories, prepare = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-english-'));
  const databasePath = path.join(root, 'memory.db');
  t.after(async () => { await closeRetrievalWorker(databasePath); fs.rmSync(root, { recursive: true, force: true }); });
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  for (const memory of memories) repository.upsertMemory({ agentId: 'melanie', kind: 'event', layer: 'episodic',
    subjectRole: 'user', subjectKey: 'caroline', content: 'Caroline visited the lighthouse museum.',
    eventDate: '2026-10-20', importance: 0.5, ...memory });
  prepare(repository);
  database.close();
  return (query, options = {}, extra = {}) => retrieveMemories({ databasePath, agentId: 'melanie', query, now,
    queryPerspective: perspective, options: { includeCandidateContext: true, execution: 'inline', ...options }, ...extra });
}

test('ordinary evidence slots retain independent matches instead of adding adjacent small talk', async t => {
  const recall = fixture(t, [
    { id: 'violin', kind: 'utterance', layer: 'evidence', content: 'I play violin. 我会拉小提琴。', eventStart: '2026-10-20T01:00:00Z' },
    { id: 'clarinet', kind: 'utterance', layer: 'evidence', content: 'I play clarinet. 我会吹单簧管。', eventStart: '2026-10-21T01:00:00Z' },
    { id: 'small-talk', kind: 'utterance', layer: 'evidence', subjectRole: 'agent', subjectKey: 'melanie',
      content: 'Wonderful! 太棒了！', eventStart: '2026-10-21T01:00:01Z' },
  ], repository => {
    repository.upsertEdge({ agentId: 'melanie', fromMemoryId: 'clarinet', toMemoryId: 'small-talk',
      relation: 'followed_by', direction: 'directed', weight: 1 });
    for (const id of ['violin', 'clarinet']) repository.upsertEmbedding({ memoryId: id, model: 'slot-fixture', vector: [1, 0] });
  });
  for (const query of ['What can Caroline play?', '我会演奏什么？']) {
    const result = await recall(query, { maximumContextMemories: 2 }, { embeddingProvider: async () => ({ model: 'slot-fixture', vector: [1, 0] }) });
    assert.deepEqual(new Set(result.graph.selectedMemoryIds), new Set(['violin', 'clarinet']), query);
    assert.match(result.context, /I play violin\. 我会拉小提琴。/u);
    assert.match(result.context, /I play clarinet\. 我会吹单簧管。/u);
    assert.doesNotMatch(result.context, /Wonderful|太棒了/u);
  }
});

test('resolved event dates retain their separate knowledge clock in either query language', async t => {
  const recall = fixture(t, [{ id: 'museum', eventDate: '2026-10-20', knownAt: '2026-10-21T01:00:00Z',
    content: 'Caroline said she visited the museum yesterday. 我昨天参观了博物馆。' }]);
  for (const query of ['When did Caroline visit the museum?', '我什么时候参观了博物馆？']) {
    const result = await recall(query);
    assert.match(result.context, /事件日期：2026-10-20；获知时间：2026-10-21/u);
    assert.ok(result.context.includes('Caroline said she visited the museum yesterday. 我昨天参观了博物馆。'));
  }
});

test('reason questions retain direct wording when no reviewed causal edge exists', async t => {
  const recall = fixture(t, [
    { id: 'lab', content: 'Caroline chose a coastal lab for conservation research. 我选择了海岸研究所做保护研究。' },
    { id: 'reason', kind: 'utterance', layer: 'evidence',
      content: 'I chose the lab because it protects endangered turtles. 我选择研究所是因为它保护濒危海龟。' },
  ]);
  for (const query of ['Why did Caroline choose the lab?', '我为什么选择研究所？']) {
    const result = await recall(query);
    assert.ok(result.graph.selectedMemoryIds.includes('reason'), query);
    assert.match(result.context, /endangered turtles|濒危海龟/u);
    assert.doesNotMatch(result.context, /有明确关系的原因/u, 'Ordinary matches must not be labelled as reviewed causal edges.');
  }
});

test('English irregular verb forms match their inflections and respect word boundaries', () => {
  for (const [query, document] of [['choose', 'chose'], ['go', 'went'], ['write', 'written'], ['teach', 'taught']]) {
    assert.equal(lexicalScore(query, document).overlap, 1);
    assert.equal(lexicalScore(document, query).overlap, 1);
  }
  assert.equal(lexicalScore('choose', 'choosesomething').overlap, 0);
});

test('English FTS hits obey the same word boundaries and retain approved query expansions', async t => {
  const recall = fixture(t, [
    { id: 'education', content: 'Caroline discussed education.' },
    { id: 'cat', content: 'Caroline adopted a cat.' },
    { id: 'expansion', content: 'Caroline said she studied at CMU.' },
  ], repository => repository.upsertMemoryRetrievalContext({ agentId: 'melanie', memoryId: 'expansion',
    policyVersion: 'retrieval-context-v1', contextText: 'Caroline attended a university.',
    queryTerms: ['college', 'university'], provider: 'test', model: 'test', promptVersion: 'test',
    sourceHash: memoryRetrievalContextSourceHash(repository.getMemory('expansion')),
  }));
  const cat = await recall('cat');
  assert.equal(cat.status, 'ready');
  assert.ok(cat.candidates.some(item => item.memoryId === 'cat'));
  assert.ok(cat.candidates.every(item => item.memoryId !== 'education'));
  const university = await recall('university');
  assert.equal(university.status, 'ready');
  assert.ok(university.candidates.some(item => item.memoryId === 'expansion'));
});

test('English original-wording recall retains attributed statements from both participants', async t => {
  const recall = fixture(t, [
    { id: 'caroline-said', kind: 'utterance', layer: 'evidence',
      content: 'I said Melanie has a new job at the library.', metadata: { speaker: 'Caroline' } },
    { id: 'melanie-said', kind: 'utterance', layer: 'evidence', subjectRole: 'agent', subjectKey: 'melanie',
      content: 'I said Caroline has a new job at the library.', metadata: { speaker: 'Melanie' } },
  ]);
  const result = await recall("What did Caroline say about Melanie's job?");
  assert.equal(result.status, 'ready');
  assert.equal(result.seedRouting.primaryMemoryId, 'caroline-said');
  assert.ok(result.candidates.some(item => item.memoryId === 'melanie-said'));
  for (const [id, speaker, statement] of [
    ['caroline-said', 'Caroline', 'I said Melanie has a new job at the library.'],
    ['melanie-said', 'Melanie', 'I said Caroline has a new job at the library.'],
  ]) {
    const record = result.records.find(item => item.memoryId === id);
    assert.ok(record, `${speaker}'s original statement is delivered.`);
    assert.ok(record.text.includes(`${speaker}：${statement}`), 'The displayed speaker owns this exact statement.');
    assert.ok(result.context.includes(record.text));
  }
});

test('English recent overview and vague topic recall share the standard temporal route', async t => {
  const recall = fixture(t, [
    { id: 'old', eventDate: '2026-09-13' }, { id: 'recent', eventDate: '2026-10-20' },
    { id: 'newest', eventDate: '2026-10-22', content: 'Caroline adopted a cat.' },
  ]);
  const recent = await recall('What did we discuss recently?');
  assert.equal(recent.status, 'ready');
  assert.deepEqual(recent.candidates.map(candidate => candidate.memoryId), ['newest', 'recent']);
  const topic = await recall('Did Caroline visit the lighthouse museum a few days ago?');
  assert.equal(topic.status, 'ready');
  assert.equal(topic.candidates[0].memoryId, 'recent');
  assert.ok(topic.candidates.some(candidate => candidate.memoryId === 'old'));
  assert.ok(topic.candidates.every(candidate => candidate.memoryId !== 'newest'));
});

test('SQL prefilter and worker preserve full retrieval results for representative English inflections', async t => {
  for (const [query, content] of [['cats', 'Caroline adopted a cat.'], ['hope', 'Caroline was hoping to visit.'],
    ['hopping', 'Caroline hopped away.'], ['choose', 'Caroline chose a marine lab.']]) {
    const recall = fixture(t, [{ id: 'matching', content },
      { id: 'education', content: 'Caroline discussed education at school.' }]);
    const complete = await recall(query, { execution: 'inline', sqlPrefilter: false });
    assert.equal(complete.status, 'ready');
    assert.ok(complete.candidates.some(item => item.memoryId === 'matching'));
    assert.ok(complete.candidates.every(item => item.memoryId !== 'education'));
    for (const execution of ['inline', 'worker']) {
      const filtered = await recall(query, { execution, sqlPrefilterThreshold: 0 });
      assert.deepEqual(JSON.parse(JSON.stringify(filtered)), JSON.parse(JSON.stringify(complete)));
    }
  }
});

test('topicless dated questions keep the date route after grammatical prepositions are removed', async t => {
  const recall = fixture(t, [
    { id: 'may-2026', eventDate: '2026-05-25' }, { id: 'may-2025', eventDate: '2025-05-26' },
    { id: 'october', eventDate: '2026-10-19' },
  ]);
  for (const [query, expected] of [
    ['What happened on May 25?', 'may-2026'], ['What did we discuss on the 25th of May?', 'may-2026'],
    ['What happened on the last Monday of May?', 'may-2026'],
    ['What happened in 2025 on the last Monday of May?', 'may-2025'],
    ['五月最后一个星期一发生了什么', 'may-2026'], ['去年五月最后一个星期一发生了什么', 'may-2025'],
  ]) {
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.deepEqual(result.candidates.map(item => item.memoryId), [expected], query);
  }
});

test('English ordinal calendar dates keep their month and year anchor', () => {
  for (const [query, expected] of [
    ['last Monday of May', '2026-05-25'], ['first Friday of June', '2026-06-05'],
    ['third Wednesday in March', '2026-03-18'], ['the first day of June', '2026-06-01'],
    ['the last day of February', '2026-02-28'], ['last day of February 2024', '2024-02-29'],
    ['last Monday of May of last year', '2025-05-26'], ['first Monday of next May', '2027-05-03'],
    ['in 2025 on the last Monday of May', '2025-05-26'],
    ['last day of December 9999', '9999-12-31'],
    ['五月最后一个星期一', '2026-05-25'], ['今年六月第一个星期五', '2026-06-05'],
    ['去年五月的最后一个周一', '2025-05-26'], ['2024年二月最后一天', '2024-02-29'],
    ['上个月最后一个星期一', '2026-09-28'],
  ]) {
    const temporal = resolveTemporalQuery(query, now);
    assert.equal(temporal.precision, 'exact', query);
    assert.deepEqual(temporal.coreWindow, { startDate: expected, endDate: expected }, query);
    assert.ok(!/Monday|Friday|Wednesday|May|June|March|February|\d{4}/iu.test(temporal.remainingQuery), query);
  }
  for (const query of ['last week of May', 'last week in May', 'first week of May',
    'fifth Monday of February 2026', 'first Friday of June 0000',
    '今年五月最后一周', '上个月最后一周', '2026年二月第五个星期一',
    'second to last Monday of May', 'second-last Monday of May']) {
    assert.equal(resolveTemporalQuery(query, now).matched, false, query);
  }
});

test('date corrections remove rejected windows before and after the requested date in both languages', async t => {
  const recall = fixture(t, ['2026-10-18', '2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']
    .map(eventDate => ({ id: eventDate, eventDate })));
  for (const [query, date] of [
    ['What happened not on October 20 but on October 21?', '2026-10-21'],
    ['What happened on October 21, not on October 20?', '2026-10-21'],
    ['不是10月20号，是10月21号发生了什么', '2026-10-21'],
    ['10月21号发生了什么，不是10月20号', '2026-10-21'],
    ['What happened not yesterday but today?', '2026-10-23'],
    ['不是昨天，是今天发生了什么', '2026-10-23'],
    ['What happened not from October 18 to October 19 but on October 21?', '2026-10-21'],
    ['不是从10月18号到10月19号，是10月21号发生了什么', '2026-10-21'],
  ]) await t.test(query, async () => {
    const parsed = resolveTemporalQuery(query, now);
    assert.deepEqual(parsed.coreWindow, { startDate: date, endDate: date });
    assert.deepEqual(recallCorePhrases(parsed.remainingQuery), [], 'Rejected dates cannot become a retrieval topic.');
    const result = await recall(query);
    assert.equal(result.status, 'ready');
    assert.deepEqual(result.candidates.map(item => item.memoryId), [date]);
  });
  for (const query of ['What did I say about "Yesterday" on October 21, not on October 20?',
    '我10月21号对《昨天》的原话是什么，不是10月20号']) {
    const parsed = resolveTemporalQuery(query, now);
    assert.equal(parsed.startDate, '2026-10-21');
    assert.ok(parsed.remainingQuery.includes(query.includes('Yesterday') ? '"Yesterday"' : '《昨天》'));
    assert.doesNotMatch(parsed.remainingQuery, /October 20|10月20号/u);
    assert.deepEqual(Object.getOwnPropertySymbols(parsed), []);
  }
});

test('negated dates are excluded in either language without negating an event date', () => {
  for (const date of ['yesterday', 'May 25', 'last year', 'the last Monday of May']) {
    for (const prefix of ['not', 'except for', 'other than', 'with the exception of']) {
      const query = `${prefix} ${date}`;
      assert.equal(resolveTemporalQuery(query, now).matched, false, query);
    }
  }
  for (const date of ['昨天', '去年', '去年五月最后一个星期一']) {
    for (const prefix of ['不是', '并非', '除了', '排除']) {
      assert.equal(resolveTemporalQuery(prefix + date, now).matched, false, prefix + date);
    }
  }
  assert.equal(resolveTemporalQuery('not on the 25th of May', now).matched, false);
  assert.equal(resolveTemporalQuery("I didn't visit the museum yesterday", now).startDate, '2026-10-22');
  assert.equal(resolveTemporalQuery('我昨天没有去博物馆', now).startDate, '2026-10-22');
});

test('positioned weekdays share calendar results across Chinese and English', () => {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ordinals = ['first', 'second', 'third', 'fourth', 'fifth', 'last'];
  for (const year of [2024, 2025, 2026, 2027]) for (let month = 1; month <= 12; month++) {
    const days = [];
    for (let day = 1; day <= 31; day++) {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (date.getUTCMonth() !== month - 1) break;
      days.push({ date: date.toISOString().slice(0, 10), weekday: date.getUTCDay() });
    }
    for (let weekday = 0; weekday < 7; weekday++) for (let rank = 0; rank < ordinals.length; rank++) {
      const occurrences = days.filter(day => day.weekday === weekday);
      const expected = (rank === 5 ? occurrences.at(-1) : occurrences[rank])?.date;
      for (const query of [
        `${ordinals[rank]} ${weekdays[weekday]} of ${months[month - 1]} ${year}`,
        `${year}年${month}月${rank === 5 ? '最后一个' : `第${rank + 1}个`}星期${'日一二三四五六'[weekday]}`,
      ]) {
        const actual = resolveTemporalQuery(query, now);
        assert.equal(actual.matched, Boolean(expected), query);
        if (expected) assert.deepEqual(actual.coreWindow, { startDate: expected, endDate: expected }, query);
      }
    }
  }
});

test('generated topic summaries are retrievable only in their source world in both languages', async t => {
  const summaries = new Map();
  const memories = ['story-a', 'story-b'].flatMap(worldId => ['painting', 'camping'].map(activity => ({
    id: worldId + '-' + activity, reality: 'fictional', worldId, worldFrame: 'fictional',
    content: 'Caroline enjoys ' + activity + '. 我喜欢' + (activity === 'painting' ? '绘画' : '露营') + '。',
  })));
  const recall = fixture(t, memories, repository => {
    for (const worldId of ['story-a', 'story-b']) {
      const proposal = proposeMemoryStructure(repository, { agentId: 'melanie', kind: 'topic',
        title: 'Caroline hobbies 爱好', content: worldId + ': Caroline enjoys painting and camping. 我喜欢绘画和露营。',
        subjectRole: 'user', subjectKey: 'caroline',
        memberIds: [worldId + '-painting', worldId + '-camping'],
      });
      summaries.set(worldId, proposal.result_memory_id);
      repository.upsertEmbedding({ memoryId: proposal.result_memory_id, model: 'structure-scope', vector: [1, 0] });
    }
  });
  for (const query of ["What are Caroline's hobbies?", '我有哪些爱好']) {
    const result = await recall(query, { sqlPrefilterThreshold: 0 }, {
      world: { id: 'story-a', frame: 'fictional' },
      embeddingProvider: async () => ({ model: 'structure-scope', vector: [1, 0] }),
    });
    assert.equal(result.status, 'ready', query);
    assert.ok(result.graph.selectedMemoryIds.includes(summaries.get('story-a')), query);
    assert.ok(!result.graph.selectedMemoryIds.includes(summaries.get('story-b')), query);
    assert.match(result.context, /painting and camping/u);
    assert.doesNotMatch(result.context, /story-b/u);
  }
});
