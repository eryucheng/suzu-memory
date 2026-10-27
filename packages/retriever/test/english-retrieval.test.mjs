import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase, memoryRetrievalContextSourceHash,
  proposeMemoryRelation, resolveMemoryRelationProposal, proposeMemoryStructure } from '@suzu-memory/core';
import {
  asksForHistoricalState, classifyChainIntent, classifyLifecycleCompletionIntent, classifyRecallIntent,
  classifyRelationshipQueryIntent, classifyRepresentationIntent, isContinuationQuery, lexicalScore, lexicalTerms, closeRetrievalWorker,
  isGenericQuery,
  planVectorQuery, planBm25Queries, prepareLexicalQuery, recallCorePhrases,
  resolveContinuationAnchors, resolveQuerySubject, resolveTemporalQuery, retrieveMemories,
} from '../src/index.mjs';

const now = new Date('2026-10-23T07:30:00+08:00');
const perspective = { speakerRole: 'user', speakerKey: 'caroline', speakerNames: ['Caroline'],
  addresseeRole: 'agent', addresseeKey: 'melanie', addresseeNames: ['Melanie'] };

test('requested scope is shared by dates, topics and actual retrieval in both languages', async t => {
  const recall = fixture(t, [
    { id: 'earlier', content: 'Caroline visited a museum. 我参观了博物馆。', eventDate: '2026-10-20' },
    { id: 'requested', content: 'Caroline visited a garden. 我参观了花园。', eventDate: '2026-10-21' },
    { id: 'tea', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'tea',
      subjectRole: 'agent', subjectKey: 'melanie', content: 'Melanie likes oolong tea. 你喜欢乌龙茶。', temporalState: 'current' },
    { id: 'coffee', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'coffee',
      subjectRole: 'agent', subjectKey: 'melanie', content: 'Melanie likes coffee. 你喜欢手冲咖啡。', temporalState: 'current' },
  ]);
  for (const [query, expected, options = {}] of [
    ['Do not tell me what happened on October 20; what happened on October 21?', 'requested'],
    ['不要说10月20号发生了什么，10月21号发生了什么', 'requested'],
    ['Do not tell me about coffee; 不要说10月20号发生了什么，10月21号发生了什么', 'requested'],
    ['不要告诉我咖啡的事; do not tell me what happened on October 20; what happened on October 21?', 'requested'],
    ['Do not tell me about "coffee"; what does Melanie like about oolong tea?', 'tea',
      { execution: 'worker', sqlPrefilterThreshold: 0 }],
    ['Ｄｏ ｎｏｔ ｔｅｌｌ ｍｅ ａｂｏｕｔ "coffee"； what does Melanie like about oolong tea?', 'tea'],
    ['不要告诉我《手冲咖啡》的事，你喜欢乌龙茶吗', 'tea'],
  ]) await t.test(query, async () => {
    const embedded = [];
    const result = await recall(query, options, { embeddingProvider: async text => {
      embedded.push(text); return { model: 'scope-fixture', vector: [1, 0] };
    } });
    assert.equal(result.status, 'ready');
    assert.equal(result.seedRouting.primaryMemoryId, expected);
    if (expected === 'requested') {
      assert.deepEqual(result.candidates.map(item => item.memoryId), [expected]);
      assert.equal(result.temporal.startDate, '2026-10-21');
      assert.deepEqual(embedded, [], 'A date overview needs no query embedding.');
    } else {
      const positiveQuery = /\p{Script=Han}/u.test(query) ? '你喜欢乌龙茶吗' : 'what does Melanie like about oolong tea?';
      const positive = await recall(positiveQuery);
      assert.deepEqual(result.candidates, positive.candidates);
      assert.equal(result.context, positive.context);
      assert.equal(embedded.length, 1);
      const topic = planVectorQuery(query).text;
      assert.doesNotMatch(topic, /coffee|咖啡/iu);
      assert.equal(embedded[0], topic);
      assert.ok(!prepareLexicalQuery(query).queryTerms.some(term => /coffee|咖啡/iu.test(term)));
      assert.ok(!planBm25Queries(query).some(plan => /coffee|咖啡/iu.test(plan.text)));
    }
  });
  for (const query of ['Do not tell me about coffee.', '不要告诉我咖啡的事。']) {
    let calls = 0;
    const result = await recall(query, {}, { embeddingProvider: async () => {
      calls++; return { model: 'scope-fixture', vector: [1, 0] };
    } });
    assert.equal(result.status, 'no-match', query);
    assert.equal(calls, 0, query);
    assert.equal(planVectorQuery(query).text, '', query);
    assert.deepEqual(prepareLexicalQuery(query).queryTerms, [], query);
  }
});

test('literal topics survive plain and dated retrieval through lexical and BM25 planning', async t => {
  const recall = fixture(t, [
    { id: 'book', kind: 'utterance', layer: 'evidence',
      content: 'I read the books Why and Who. 我读过《为什么》和《谁》。', metadata: { speaker: 'Caroline' },
      eventStart: '2026-10-20T07:30:00+08:00', eventDate: '2026-10-20' },
    { id: 'fragment', kind: 'utterance', layer: 'evidence',
      content: 'I met Whyatt and whoever was accompanying him. 我去公园散步。', metadata: { speaker: 'Caroline' },
      eventStart: '2026-10-20T08:30:00+08:00', eventDate: '2026-10-20' },
  ]);
  for (const [topic, query, dated = false] of [
    ['Why', 'What did I say about "Why"?'], ['为什么', '我对《为什么》的原话是什么'],
    ['Why', 'What did I say about "Why" on October 20?', true],
    ['Who', 'On October 20, what did I say about "Who"?', true],
    ['为什么', '10月20号我对《为什么》的原话是什么', true], ['谁', '我10月20号对《谁》的原话是什么', true],
  ]) {
    assert.ok(lexicalScore(query, 'I read the books Why and Who. 我读过《为什么》和《谁》。').overlap > 0, query);
    for (const execution of ['inline', 'worker']) for (const sqlPrefilter of [false, true]) {
      const result = await recall(query, { execution, sqlPrefilter, sqlPrefilterThreshold: 0 });
      assert.equal(result.status, 'ready', query);
      assert.equal(result.temporal.matched, dated, query);
      if (dated) assert.equal(result.temporal.startDate, '2026-10-20', query);
      assert.equal(result.recallIntent, 'utterance', query);
      assert.equal(result.seedRouting.primaryMemoryId, 'book', query);
      assert.ok(result.candidates.every(item => item.memoryId !== 'fragment'), query);
      if (topic.length >= 3 && /^[A-Z]/u.test(topic)) {
        assert.equal(result.bm25.status, 'ready', query);
        assert.ok(result.bm25.audit.queries.some(item => item.text === topic.toLowerCase()), query);
        assert.ok(result.bm25.audit.matches.some(item => item.memoryId === 'book'), query);
      }
    }
  }
});

test('quoted greetings are searchable topics while ordinary greetings retain the generic skip', async t => {
  const recall = fixture(t, [{ id: 'title',
    content: 'Caroline wrote the titles Hello, OK, and What time is it. 我读过《好的》《在吗》和《现在几点》。' }]);
  for (const query of ['"Hello"', '‘OK’', '《好的》', '“在吗”', '"What time is it"', '「现在几点」']) {
    assert.equal(isGenericQuery(query), false, query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.seedRouting.primaryMemoryId, 'title', query);
  }
  for (const query of ['Hello', 'OK', '好的', '在吗', 'What time is it', '现在几点']) {
    assert.equal(isGenericQuery(query), true, query);
    assert.equal((await recall(query)).status, 'skipped', query);
  }
  assert.equal(isGenericQuery('"Hello"', ['"hello"']), true, 'Explicit custom generic queries remain effective.');
  assert.deepEqual(lexicalTerms('在吗'), [], 'Unquoted grammatical words keep their existing lexical treatment.');
});

test('short follow-ups use the same chain direction and continue from the last event in both languages', async t => {
  const recall = fixture(t, [
    { id: 'start', content: 'Caroline visited the museum. 我参观了博物馆。', eventStart: '2026-10-20T08:00:00Z' },
    { id: 'middle', content: 'Caroline ate lunch. 我吃了午饭。', eventStart: '2026-10-20T09:00:00Z' },
    { id: 'end', content: 'Caroline returned home. 我回家了。', eventStart: '2026-10-20T10:00:00Z' },
  ], repository => {
    for (const [from, to] of [['start', 'middle'], ['middle', 'end']]) repository.upsertEdge({ agentId: 'melanie',
      fromMemoryId: from, toMemoryId: to, relation: 'timeline_next', direction: 'directed', weight: 1 });
  });
  for (const execution of ['inline', 'worker']) {
    const first = await recall('What happened next?', { execution, maximumChainMemories: 2 }, { anchorMemoryIds: ['start'] });
    assert.deepEqual(first.graph.selectedMemoryIds, ['start', 'middle']);
    for (const [query, mode, direction, ids] of [
      ['Then what?', 'timeline', 'forward', ['middle', 'end']], ['往后呢？', 'timeline', 'forward', ['middle', 'end']],
      ['What happened before?', 'timeline', 'backward', ['start', 'middle']], ['往前呢？', 'timeline', 'backward', ['start', 'middle']],
      ['Anything else?', 'associative', 'both'], ['还有什么？', 'associative', 'both'],
    ]) {
      assert.equal(isContinuationQuery(query), true, query);
      assert.deepEqual(classifyChainIntent(query), { mode, direction }, query);
      const selected = resolveContinuationAnchors(query, { ...first.trace, id: 'previous' });
      assert.deepEqual(selected.memoryIds, ['middle'], query);
      assert.equal(selected.focusRole, 'chain-tail', query);
      const result = await recall(query, { execution, maximumChainMemories: 2 }, {
        anchorMemoryIds: selected.memoryIds, anchorSelection: selected });
      assert.equal(result.status, 'ready', query);
      assert.equal(result.graph.seedId, 'middle', query);
      if (ids) assert.deepEqual(result.graph.selectedMemoryIds, ids, query);
    }
  }
});

test('quoted follow-up words remain new topics rather than selecting a previous focus', async t => {
  const trace = { id: 'old-trace', metadata: { continuationFocuses: { version: 1,
    primaryMemoryId: 'unrelated', chainMemoryId: 'unrelated', representationMemoryIds: [] } } };
  for (const query of ['“为什么”', '"原话"', "'反证'", '「后来呢」', '"Then what"', '《反证》']) {
    assert.equal(isContinuationQuery(query), false, query);
    assert.deepEqual(resolveContinuationAnchors(query, trace).memoryIds, [], query);
  }
  const recall = fixture(t, [
    { id: 'book', content: 'Caroline read the book Counterevidence. 我读过《反证》。' },
    { id: 'unrelated', content: 'Caroline ate lunch. 我吃了午饭。' },
  ]);
  for (const query of ['“反证”', '"Counterevidence"']) {
    const selected = resolveContinuationAnchors(query, trace);
    const result = await recall(query, {}, { anchorMemoryIds: selected.memoryIds, anchorSelection: selected });
    assert.equal(result.status, 'ready', query);
    assert.equal(result.seedRouting.primaryMemoryId, 'book', query);
    assert.ok(!result.graph.selectedMemoryIds.includes('unrelated'), query);
  }
});

test('subject constraints use the same requested scope as retrieval intent in either language', async t => {
  const recall = fixture(t, [
    { id: 'speaker-coffee', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'coffee',
      content: 'Caroline likes coffee. 我喜欢手冲咖啡。', temporalState: 'current' },
    { id: 'addressee-coffee', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'coffee',
      subjectRole: 'agent', subjectKey: 'melanie', content: 'Melanie likes coffee. 你喜欢手冲咖啡。', temporalState: 'current' },
  ]);
  for (const query of ['Do not tell me what I like about coffee; what do you like about coffee?',
    '不要解释我喜欢手冲咖啡的原因，你喜欢手冲咖啡吗', 'What do you like about coffee? Do not tell me what I like.',
    '你喜欢手冲咖啡吗，不要解释我喜欢什么', 'I am not asking what I like about coffee; what do you like about coffee?',
    '我不是在问我喜欢什么手冲咖啡，你喜欢手冲咖啡吗']) {
    const subject = resolveQuerySubject(query, perspective);
    assert.equal(subject.key, 'melanie', query);
    assert.equal(subject.focus, 'state', query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.seedRouting.primaryMemoryId, 'addressee-coffee', query);
    assert.ok(result.candidates.every(item => item.memoryId !== 'speaker-coffee'), query);
  }
  for (const query of ['What did I not say about coffee?', '我不是说过我以前喜欢咖啡吗']) {
    assert.equal(resolveQuerySubject(query, perspective).key, 'caroline', query);
  }
});

test('quoted text supplies retrieval topics without selecting evidence or relationship modes', async t => {
  for (const [query, recall] of [
    ['What did I say about "Are you sure"?', 'utterance'], ['我对《反证》的原话是什么', 'utterance'],
    ['What is the book "Why" about?', 'auto'], ['我对《为什么》的评价是什么', 'auto'],
    ['What did I think about "Why do you think"?', 'event'], ['我对《你为什么觉得》的评价是什么', 'auto'],
    ['Are "you and I friends" the lyrics?', 'auto'], ['我对《你喜欢我》的评价是什么', 'auto'],
    ['What did I say about ‘Are you sure’?', 'utterance'], ["我对'反证'的原话是什么", 'utterance'],
  ]) {
    assert.equal(classifyRecallIntent(query), recall, query);
    assert.equal(classifyRepresentationIntent(query), 'any', query);
    assert.equal(classifyRelationshipQueryIntent(query), 'any', query);
    assert.deepEqual(classifyChainIntent(query), { mode: 'none', direction: 'both' }, query);
  }
  const recall = fixture(t, [
    { id: 'review-raw', kind: 'utterance', layer: 'evidence',
      content: 'I reviewed the documentary "Are you sure". 我对纪录片《反证》的评价是很精彩。', metadata: { speaker: 'Caroline' } },
    { id: 'review-summary', content: 'Caroline reviewed the documentary "Are you sure". 我对纪录片《反证》的评价。' },
  ]);
  for (const query of ['What did I say about the documentary "Are you sure"?', '我对纪录片《反证》的原话是什么']) {
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.recallIntent, 'utterance', query);
    assert.equal(result.seedRouting.primaryMemoryId, 'review-raw', query);
    assert.ok(result.candidates.every(item => item.memoryId !== 'review-summary'), query);
  }
});

test('quoted retrieval topics survive removal of question frames in either language', () => {
  for (const [open, close] of [['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'],
    ['「', '」'], ['『', '』'], ['《', '》'], ['＂', '＂']]) {
    for (const topic of ['Are you sure', 'Why', 'What did I say', 'Counterevidence', 'Do not explain why']) {
      for (const query of [`What did I say about ${open}${topic}${close}?`, `${open}${topic}${close}`]) {
        assert.deepEqual(recallCorePhrases(query), [topic.toLowerCase()], query);
        assert.equal(planVectorQuery(query).text, topic.toLowerCase(), query);
      }
    }
    for (const topic of ['反证', '为什么', '说过什么', '原话', '不要解释为什么']) {
      for (const query of [`${open}${topic}${close}的原话怎么说`, `${open}${topic}${close}`]) {
        assert.deepEqual(recallCorePhrases(query), [topic], query);
        assert.equal(planVectorQuery(query).text, topic, query);
      }
    }
  }
  for (const query of ['Why did I read "Why"?', '为什么我读过《为什么》']) {
    assert.deepEqual(classifyChainIntent(query), { mode: 'causal', direction: 'backward' }, query);
  }
  assert.deepEqual(classifyLifecycleCompletionIntent('Was the "Cancelled" trip cancelled?'),
    { matched: true, target: 'cancelled' });
  assert.deepEqual(recallCorePhrases('What did I say about "\uE0000\uE001"?'), ['\uE0000\uE001']);
});

test('original-wording intent consistently suppresses causal and timeline expansion', async t => {
  for (const query of ['Who said why Caroline likes coffee?', '谁说过我为什么喜欢咖啡',
    'Which person mentioned what happened next?', '谁说过后来发生了什么']) {
    assert.equal(classifyRecallIntent(query), 'utterance', query);
    assert.deepEqual(classifyChainIntent(query), { mode: 'none', direction: 'both' }, query);
  }
  const recall = fixture(t, [
    { id: 'reason-raw', kind: 'utterance', layer: 'evidence',
      content: 'I said why Caroline likes coffee. 我说过我为什么喜欢咖啡。', metadata: { speaker: 'Caroline' } },
    { id: 'reason-event', content: 'Caroline said her coffee preference.' },
    { id: 'unrelated', content: 'Caroline started practicing the piano.' },
  ], repository => {
    const source = repository.upsertSource({ agentId: 'melanie', sourceKind: 'conversation',
      externalId: 'coffee-reason', occurredAt: '2026-10-20T08:00:00Z',
      content: 'Starting piano practice caused Caroline to explain her coffee preference.' });
    for (const id of ['unrelated', 'reason-event']) repository.linkSource(id, source.id, 'evidence');
    const proposal = proposeMemoryRelation(repository, { agentId: 'melanie', relation: 'causes',
      fromMemoryId: 'unrelated', toMemoryId: 'reason-event', evidenceSourceIds: [source.id],
      confidence: 0.95, rationale: 'The source explicitly states this cause.' });
    resolveMemoryRelationProposal(repository, { agentId: 'melanie', proposalId: proposal.id,
      action: 'accept', resolvedBy: 'human:test' });
  });
  for (const query of ['Who said why Caroline likes coffee?', '谁说过我为什么喜欢咖啡']) {
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.chainIntent.mode, 'none', query);
    assert.equal(result.seedRouting.primaryMemoryId, 'reason-raw', query);
    assert.ok(!result.graph.selectedMemoryIds.includes('unrelated'), query);
    assert.ok(!result.graph.selectedMemoryIds.includes('reason-event'), query);
  }
  const causal = await recall('Why did Caroline say her coffee preference?');
  assert.equal(causal.status, 'ready');
  assert.equal(causal.chainIntent.mode, 'causal');
  assert.deepEqual(causal.graph.selectedMemoryIds, ['reason-event', 'unrelated']);
});

test('rejected retrieval instructions cannot override the requested operation in either language', async t => {
  for (const query of ["Don't explain why the repair failed; what happened next?",
    '不要解释为什么维修失败，后来发生了什么', 'Do not quote the exact words; what happened next?',
    '不要引用原话，后来发生了什么', "Don't explain why it failed but tell me what happened next?",
    '不要解释原因而是告诉我后来发生了什么', 'No need to explain why; what happened next?',
    '不用解释原因，只要说后来发生了什么', 'Please do not quote the exact words, just tell me what happened next.',
    '请不要引用原话，只需告诉我后来发生了什么']) {
    assert.equal(classifyRecallIntent(query), 'event', query);
    assert.deepEqual(classifyChainIntent(query), { mode: 'timeline', direction: 'forward' }, query);
  }
  for (const query of ["Why didn't Caroline repair the dishwasher?", '为什么我没有修好洗碗机']) {
    assert.deepEqual(classifyChainIntent(query), { mode: 'causal', direction: 'backward' }, query);
  }
  for (const query of ['What did I not say about coffee?', '我没有说过咖啡的那些原话']) {
    assert.equal(classifyRecallIntent(query), 'utterance', query);
  }
  for (const query of ['Do not explain why', '不要解释为什么']) {
    assert.deepEqual(classifyChainIntent(query), { mode: 'none', direction: 'both' }, query);
  }
  const recall = fixture(t, [
    { id: 'repair-failed', content: 'The dishwasher repair failed. 洗碗机维修失败。',
      eventStart: '2026-10-20T08:00:00Z' },
    { id: 'next-step', content: 'Caroline contacted the supplier. 我联系了供应商。',
      eventStart: '2026-10-20T09:00:00Z' },
  ], repository => repository.upsertEdge({ agentId: 'melanie', fromMemoryId: 'repair-failed',
    toMemoryId: 'next-step', relation: 'timeline_next', direction: 'directed', weight: 1 }));
  for (const query of ["Don't explain why the dishwasher repair failed; what happened next?",
    '不要解释为什么洗碗机维修失败，后来发生了什么']) {
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.deepEqual(result.chainIntent, { mode: 'timeline', direction: 'forward' }, query);
    assert.deepEqual(result.graph.selectedMemoryIds, ['repair-failed', 'next-step'], query);
  }
});

test('lifecycle questions classify their outside predicate rather than a quoted outcome', async t => {
  const recall = fixture(t, [{ id: 'repair',
    content: 'The dishwasher "Cancelled" has not been repaired. 代号《取消》的洗碗机还没修好，正在等配件。' }]);
  for (const query of ['Was the dishwasher "Cancelled" repaired?', '代号《取消》的洗碗机修好了吗']) {
    assert.deepEqual(classifyLifecycleCompletionIntent(query), { matched: true, target: 'completed' }, query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.trace.metadata.lifecycleClosure.target, 'completed', query);
    assert.equal(result.trace.metadata.lifecycleClosure.status, 'pending', query);
    assert.equal(result.trace.metadata.lifecycleClosure.boundaryRequired, true, query);
  }
  for (const query of ['Did I read "Cancelled"?', '我读过《取消》吗']) {
    assert.deepEqual(classifyLifecycleCompletionIntent(query), { matched: false, target: '' }, query);
  }
});

test('negative past auxiliaries request historical state in the same way as their full forms', async t => {
  const recall = fixture(t, [
    { id: 'old-coffee', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'coffee',
      content: 'Caroline liked latte coffee. 我以前喜欢拿铁咖啡。', temporalState: 'historical', status: 'superseded',
      knownAt: '2024-05-01T10:00:00Z', validFrom: '2024-05-01T10:00:00Z', validTo: '2025-01-01T10:00:00Z' },
    { id: 'current-coffee', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'coffee',
      content: 'Caroline likes espresso coffee. 我现在喜欢浓缩咖啡。', temporalState: 'current',
      knownAt: '2025-01-01T10:00:00Z', validFrom: '2025-01-01T10:00:00Z' },
  ], repository => repository.upsertEdge({ agentId: 'melanie', fromMemoryId: 'current-coffee',
    toMemoryId: 'old-coffee', relation: 'supersedes', direction: 'directed', confidence: 1, weight: 1, provenance: 'test' }));
  for (const query of ["Didn't I like latte coffee?", 'Didn’t I like latte coffee?',
    'Did I not like latte coffee?', "Hadn't I liked latte coffee?", 'Had I not liked latte coffee?',
    "Wasn't my favorite coffee a latte?", 'Was my favorite coffee not a latte?',
    '我以前不是喜欢拿铁咖啡吗', '我当时不喜欢拿铁咖啡吗']) {
    assert.equal(asksForHistoricalState(query), true, query);
    const subject = resolveQuerySubject(query, perspective);
    if (subject.matched) assert.equal(subject.stateTime, 'historical', query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.seedRouting.stateRouting.mode, 'historical-allowed', query);
    assert.equal(result.seedRouting.primaryMemoryId, 'old-coffee', query);
    assert.deepEqual(result.seedRouting.stateRouting.forwarded, [], query);
  }
});

test('rejected historical scope cannot override a current state request in either language', async t => {
  const recall = fixture(t, [
    { id: 'old-coffee', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'coffee',
      content: 'Caroline liked latte coffee. 我以前喜欢拿铁咖啡。', temporalState: 'historical', status: 'superseded',
      knownAt: '2024-05-01T10:00:00Z', validFrom: '2024-05-01T10:00:00Z', validTo: '2025-01-01T10:00:00Z' },
    { id: 'current-coffee', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'coffee',
      content: 'Caroline likes espresso coffee. 我现在喜欢浓缩咖啡。', temporalState: 'current',
      knownAt: '2025-01-01T10:00:00Z', validFrom: '2025-01-01T10:00:00Z' },
  ], repository => repository.upsertEdge({ agentId: 'melanie', fromMemoryId: 'current-coffee',
    toMemoryId: 'old-coffee', relation: 'supersedes', direction: 'directed', confidence: 1, weight: 1, provenance: 'test' }));
  for (const query of [
    'What is my current latte coffee preference? I am not asking about the past.',
    'What is my current latte coffee preference, not my old preference?',
    'What is my latte coffee preference now, rather than before?',
    '我现在喜欢拿铁咖啡吗，不是问以前', '我现在喜欢拿铁咖啡吗，别说以前的',
    '我现在喜欢拿铁咖啡吗？我不是问以前的', '回答之前，先告诉我现在喜欢拿铁咖啡吗',
  ]) {
    assert.equal(asksForHistoricalState(query), false, query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.seedRouting.stateRouting.mode, 'current-only', query);
    assert.equal(result.seedRouting.primaryMemoryId, 'current-coffee', query);
    assert.ok(result.candidates.every(item => item.memoryId !== 'old-coffee'), query);
  }
  for (const query of [
    'Not last year but today, what is my latte coffee preference?',
    'What is my latte coffee preference today, not last year?',
    '我问的是今天，不是以前：我喜欢拿铁咖啡吗',
    '不是以前，而是今天，我的拿铁咖啡偏好是什么',
    'When I was young, what is my latte coffee preference today?',
    '我以前喜欢拿铁咖啡，我今天的拿铁咖啡偏好是什么',
  ]) await t.test(query, async () => {
    const temporal = resolveTemporalQuery(query, now);
    assert.equal(temporal.startDate, '2026-10-23');
    assert.equal(asksForHistoricalState(query, { temporal, today: '2026-10-23' }), false);
    const result = await recall(query);
    assert.equal(result.status, 'ready');
    assert.equal(result.seedRouting.stateRouting.mode, 'current-only');
    assert.equal(result.seedRouting.primaryMemoryId, 'current-coffee');
    assert.ok(result.candidates.every(item => item.memoryId !== 'old-coffee'));
  });
});

test('state time scope preserves comparisons and past facts but ignores quoted titles', () => {
  for (const [query, expected] of [
    ['What is my coffee preference now compared with before?', true], ['我现在和以前的咖啡偏好有什么不同', true],
    ['What was my previous coffee preference, not my current preference?', true], ['我以前的咖啡偏好是什么，不是问现在', true],
    ['I did not like latte coffee.', true], ['我以前不喜欢拿铁咖啡', true],
    ["Weren't my coffee preferences different?", true], ['Were my coffee preferences not different?', true],
    ['What is my favorite movie "Before Sunrise"?', false], ['我喜欢的电影《从前》是什么', false],
    ['What was my favorite movie "Now"?', true], ['我以前喜欢的电影《现在》是什么', true],
    ["Don't I like coffee?", false], ["Isn't my favorite coffee a latte?", false],
    ['Before answering, what coffee do I like?', false], ['Before you answer, what coffee do I like?', false],
    ['回答之前，我喜欢什么咖啡', false], ['在回复我之前，我喜欢什么咖啡', false],
  ]) assert.equal(asksForHistoricalState(query), expected, query);
  for (const query of ['In 2024, what is my current coffee preference?', '2024年，我当前的咖啡偏好是什么',
    'What is my current coffee preference in 2024?', '2024年我现在的咖啡偏好是什么']) {
    const temporal = resolveTemporalQuery(query, now);
    assert.equal(asksForHistoricalState(query, { temporal, today: '2026-10-23' }), true, query);
  }
  for (const query of ['What is my current coffee preference? I am not asking about 2024.',
    '我现在的咖啡偏好是什么，不是问2024年的']) {
    const temporal = resolveTemporalQuery(query, now);
    assert.equal(asksForHistoricalState(query, { temporal, today: '2026-10-23' }), false, query);
  }
});

test('negative past questions preserve original-wording and lifecycle intent', async t => {
  for (const query of ["What didn't I say about coffee?", 'What did I not say about coffee?']) {
    assert.equal(classifyRecallIntent(query), 'utterance', query);
  }
  const recall = fixture(t, [{ id: 'repair', content: 'The dishwasher has not been repaired. 洗碗机还没修好，正在等配件。' }]);
  for (const query of ["Didn't the dishwasher get repaired?", 'Did the dishwasher not get repaired?',
    "Wasn't the dishwasher repaired?", 'Was the dishwasher not repaired?',
    "Hadn't the dishwasher been repaired?", 'Had the dishwasher not been repaired?', '洗碗机不是修好了吗']) {
    assert.deepEqual(classifyLifecycleCompletionIntent(query), { matched: true, target: 'completed' }, query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.trace.metadata.lifecycleClosure.status, 'pending', query);
    assert.equal(result.trace.metadata.lifecycleClosure.boundaryRequired, true, query);
  }
});

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

test('Chinese and English multi-person questions preserve both state holders', async t => {
  const queries = [
    '我喜欢咖啡，你喜欢咖啡吗', '我的咖啡偏好和你的咖啡偏好有什么不同',
    '我和你喜欢咖啡吗', '你和我喜欢咖啡吗',
    'What do I like about coffee and what do you like about coffee?',
    'Do you and I like coffee?',
  ];
  const recall = fixture(t, [
    { id: 'speaker-coffee', kind: 'preference', stateFamily: 'preference', canonicalKey: 'coffee',
      content: '我的咖啡偏好：我喜欢咖啡。Caroline likes coffee.', temporalState: 'current' },
    { id: 'addressee-coffee', kind: 'preference', stateFamily: 'preference', canonicalKey: 'coffee',
      subjectRole: 'agent', subjectKey: 'melanie', content: '你的咖啡偏好：你喜欢咖啡。Melanie likes coffee.', temporalState: 'current' },
  ]);
  for (const query of queries) {
    assert.notEqual(resolveQuerySubject(query, perspective).mode, 'personal', query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.deepEqual(new Set(result.candidates.map(item => item.memoryId)), new Set(['speaker-coffee', 'addressee-coffee']), query);
  }
});

test('reported Chinese clauses cannot replace the matrix speaker or supply an unknown speaker', async t => {
  const recall = fixture(t, [
    { id: 'speaker-said', kind: 'utterance', layer: 'evidence',
      content: '我说你喜欢咖啡。I said you like coffee.', metadata: { speaker: 'Caroline' } },
    { id: 'addressee-said', kind: 'utterance', layer: 'evidence', subjectRole: 'agent', subjectKey: 'melanie',
      content: '我说你喜欢咖啡。I said you like coffee.', metadata: { speaker: 'Melanie' } },
  ]);
  for (const [query, key, memoryId] of [
    ['我说过你喜欢咖啡时的原话', 'caroline', 'speaker-said'],
    ['你说过我喜欢咖啡时的原话', 'melanie', 'addressee-said'],
    ['What did I say about you liking coffee?', 'caroline', 'speaker-said'],
    ['What did you say about me liking coffee?', 'melanie', 'addressee-said'],
  ]) {
    const subject = resolveQuerySubject(query, perspective);
    assert.equal(subject.key, key, query);
    assert.equal(subject.focus, 'event', query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.deepEqual(result.candidates.map(item => item.memoryId), [memoryId], query);
  }
  for (const query of ['谁说过你喜欢咖啡', '谁说过我喜欢咖啡', '哪位说过你喜欢咖啡',
    'Who said you like coffee?', 'Which person said I like coffee?']) {
    assert.equal(resolveQuerySubject(query, perspective).matched, false, query);
    assert.equal(classifyRecallIntent(query), 'utterance', query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.deepEqual(new Set(result.candidates.map(item => item.memoryId)), new Set(['speaker-said', 'addressee-said']), query);
  }
});

test('quoted topics preserve outside speakers without interpreting quoted pronouns', async t => {
  const recall = fixture(t, [
    { id: 'speaker-said', kind: 'utterance', layer: 'evidence',
      content: '我喜欢咖啡。I like coffee.', metadata: { speaker: 'Caroline' } },
    { id: 'addressee-said', kind: 'utterance', layer: 'evidence', subjectRole: 'agent', subjectKey: 'melanie',
      content: '我喜欢咖啡。I like coffee.', metadata: { speaker: 'Melanie' } },
  ]);
  for (const [query, key, memoryId] of [
    ['我说过“你喜欢咖啡”的原话', 'caroline', 'speaker-said'],
    ['你说过“我喜欢咖啡”的原话', 'melanie', 'addressee-said'],
    ['What did I say about "coffee"?', 'caroline', 'speaker-said'],
    ['What did you say about "coffee"?', 'melanie', 'addressee-said'],
    ["What did I say about 'you like coffee'?", 'caroline', 'speaker-said'],
    ['What did you say about ‘I like coffee’?', 'melanie', 'addressee-said'],
    ['我对“咖啡”的原话是什么', 'caroline', 'speaker-said'],
    ['你对「咖啡」的原话是什么', 'melanie', 'addressee-said'],
  ]) {
    assert.equal(resolveQuerySubject(query, perspective).key, key, query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.deepEqual(result.candidates.map(item => item.memoryId), [memoryId], query);
  }
  for (const query of ['"I like coffee"', "'I like coffee'", '‘I like coffee’', '“我喜欢咖啡”',
    '「你喜欢咖啡」', '『我说过你喜欢咖啡』', "'O’Neill said I like coffee'", "'Caroline's job is great'"]) {
    assert.equal(resolveQuerySubject(query, perspective).matched, false, query);
  }
});

test('speech subjects keep their perspective across framing, quotation and state-noun objects', () => {
  for (const configuration of [perspective, { speakerRole: 'agent', speakerKey: 'melanie', speakerNames: ['Melanie'],
    addresseeRole: 'user', addresseeKey: 'caroline', addresseeNames: ['Caroline'] }]) {
    for (const [cn, en, key] of [['我', 'I', configuration.speakerKey], ['你', 'you', configuration.addresseeKey]]) {
      for (const [frame, queries] of [
        ['', [`${cn}说过你喜欢咖啡时的原话`, `${cn}对你的偏好的原话是什么`, `${cn}对「咖啡」的原话是什么`]],
        ['你还记得', [`${cn}说过你喜欢咖啡时的原话`, `${cn}对你的偏好的原话是什么`]],
        ['', [`What did ${en} say about "your plans"?`, `What did ${en} say about 'Caroline's job'?`,
          `What did ${en} say about ＂Melanie's preferences＂?`]],
        ['Can you tell me ', [`what did ${en} say about ‘your plans’?`]],
      ]) for (const query of queries) {
        const subject = resolveQuerySubject(frame + query, configuration);
        assert.equal(subject.key, key, frame + query);
        assert.equal(subject.focus, 'event', frame + query);
      }
    }
    for (const query of ['你还记得谁说过我喜欢咖啡吗', '谁说过“你喜欢咖啡”',
      'Do you remember who said I like coffee?', 'Who said "you like coffee"?']) {
      assert.equal(resolveQuerySubject(query, configuration).matched, false, query);
    }
  }
  const namedPerspective = { ...perspective, speakerKey: 'oneill', speakerNames: ["O'Neill"] };
  assert.equal(resolveQuerySubject("What did O’Neill say about 'coffee'?", namedPerspective).key, 'oneill');
  assert.equal(resolveQuerySubject('我喜欢一起去博物馆', perspective).key, 'caroline');
  assert.equal(resolveQuerySubject('你喜欢一起去博物馆', perspective).key, 'melanie');
  assert.equal(resolveQuerySubject("我喜欢'你喜欢的咖啡'吗", perspective).key, 'caroline');
  assert.equal(resolveQuerySubject("你喜欢'我喜欢的咖啡'吗", perspective).key, 'melanie');
});

test('original-wording query planning separates speech grammar from the requested topic', () => {
  for (const query of ['What did I say about coffee?', 'What did Caroline say about coffee?',
    'Can you tell me what did you say about coffee?', '我对“咖啡”的原话是什么', '你对「咖啡」的原话是什么']) {
    const expected = query.includes('coffee') ? ['coffee'] : ['咖啡'];
    assert.deepEqual(recallCorePhrases(query), expected, query);
    assert.ok(lexicalScore(query, query.includes('coffee') ? 'I like coffee.' : '我喜欢咖啡。').exactPhrase, query);
  }
  assert.deepEqual(recallCorePhrases('What did Caroline research?'), ['caroline research']);
  assert.deepEqual(recallCorePhrases('What did I say?'), []);
});

test('English questions about multiple people never impose a single-person exclusion', async t => {
  const queries = [
    'What does Caroline like and what does Melanie prefer?',
    'Does Caroline or Melanie like tea?',
    "What are Caroline's and Melanie's preferences?",
    'What do I like compared with what you like?',
    'What does Caroline like? What does Melanie like?',
    'Caroline likes tea and Melanie likes coffee.',
    'Caroline likes tea, and Melanie likes coffee.',
    'What does Caroline prefer compared with Melanie?',
    'What does Melanie prefer compared to Caroline?',
    'What do I prefer compared with you?',
    'What do you prefer compared with me?',
    'Are your preferences different compared with mine?',
    'What does Caroline prefer compared with your preferences?',
    'Can you tell me what Caroline prefers compared with Melanie?',
  ];
  const recall = fixture(t, [
    { id: 'caroline-tea', kind: 'preference', stateFamily: 'preference', canonicalKey: 'tea',
      content: 'Caroline likes tea.', temporalState: 'current' },
    { id: 'melanie-tea', kind: 'preference', stateFamily: 'preference', canonicalKey: 'tea',
      subjectRole: 'agent', subjectKey: 'melanie', content: 'Melanie likes tea.', temporalState: 'current' },
  ]);
  for (const query of queries) {
    const subject = resolveQuerySubject(query, perspective);
    assert.notEqual(subject.mode, 'personal', query);
  }
  const result = await recall('Does Caroline or Melanie like tea?');
  assert.equal(result.status, 'ready');
  assert.deepEqual(new Set(result.candidates.map(item => item.memoryId)), new Set(['caroline-tea', 'melanie-tea']));
});

test('explicit past calendar windows retain historical states in both languages', async t => {
  for (const [query, oldContent, newContent] of [
    ["What is Caroline's coffee preference in 2024?", 'Caroline has a coffee preference for lattes.',
      'Caroline has a coffee preference for espresso.'],
    ['2024年我的偏好是咖啡吗', 'Caroline的咖啡偏好是拿铁。', 'Caroline的咖啡偏好是美式。'],
  ]) {
    const recall = fixture(t, [
      { id: 'old-coffee', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'coffee',
        representationLayer: 'reported', content: oldContent, temporalState: 'historical', status: 'superseded',
        knownAt: '2024-05-01T10:00:00Z', validFrom: '2024-05-01T10:00:00Z', validTo: '2025-01-01T10:00:00Z' },
      { id: 'current-coffee', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'coffee',
        representationLayer: 'reported', content: newContent, temporalState: 'current',
        knownAt: '2025-01-01T10:00:00Z', validFrom: '2025-01-01T10:00:00Z' },
    ], repository => repository.upsertEdge({ agentId: 'melanie', fromMemoryId: 'current-coffee',
      toMemoryId: 'old-coffee', relation: 'supersedes', direction: 'directed', confidence: 1, weight: 1, provenance: 'test' }));
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.seedRouting.stateRouting.mode, 'historical-allowed', query);
    assert.deepEqual(result.seedRouting.stateRouting.forwarded, [], query);
    assert.equal(result.seedRouting.primaryMemoryId, 'old-coffee', query);
    const currentQuery = query.startsWith('2024') ? '我的偏好是咖啡吗' : "What is Caroline's coffee preference?";
    const current = await recall(currentQuery);
    assert.equal(current.status, 'ready', currentQuery);
    assert.equal(current.seedRouting.stateRouting.mode, 'current-only', currentQuery);
    assert.equal(current.seedRouting.primaryMemoryId, 'current-coffee', currentQuery);
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

for (const [family, noun] of [
  ['preference', 'preferences'], ['goal', 'plans'], ['value', 'values'], ['capability', 'skills'],
  ['self_concept', 'self-concept'], ['condition', 'health condition'], ['habit', 'habits'],
  ['disposition', 'personality'], ['identity', 'occupation'], ['belief', 'beliefs'],
  ['relationship', 'relationship status'], ['affective_association', 'feelings about the museum'],
]) test(`English ${family} state nouns use the same current-state contract`, () => {
  for (const query of [`What is Caroline's current ${noun}?`, `What's Caroline's current ${noun}?`,
    `What’s my current ${noun}?`]) {
    const subject = resolveQuerySubject(query, perspective);
    assert.equal(subject.key, 'caroline', query);
    assert.equal(subject.focus, 'state', query);
    assert.equal(subject.stateTime, 'current', query);
  }
});

test('English state nouns in a question preamble remain nouns rather than reporting predicates', () => {
  for (const query of ['What plans does Caroline have?', 'What promises has Caroline made?',
    'Which goals does Caroline have?', 'How many plans does Caroline have?']) {
    const subject = resolveQuerySubject(query, perspective);
    assert.equal(subject.key, 'caroline', query);
    assert.equal(subject.focus, 'state', query);
  }
});

test('English question contractions retain intent and current-time guards', async () => {
  for (const query of ["What's our relationship?", 'What’s our relationship?',
    'Are Caroline and Melanie dating?', 'Are Melanie and Caroline partners?']) {
    assert.equal(classifyRelationshipQueryIntent(query), 'role', query);
  }
  for (const query of ["What's the evidence?", 'What’s the evidence?']) {
    assert.equal(classifyRecallIntent(query), 'evidence', query);
    assert.equal(isContinuationQuery(query), true, query);
  }
  for (const query of ['What time is it?', 'What’s the time?', "What's today’s date?"]) {
    assert.equal(isGenericQuery(query), true, query);
    const result = await retrieveMemories({ databasePath: path.join(os.tmpdir(), 'Codex', 'english-time-no-database', 'missing.db'), agentId: 'audit', query });
    assert.equal(result.status, 'skipped', query);
  }
});

test('English pronouns follow the configured speaker in both user and Agent perspectives', () => {
  for (const configuration of [perspective, { speakerRole: 'agent', speakerKey: 'melanie', speakerNames: ['Melanie'],
    addresseeRole: 'user', addresseeKey: 'caroline', addresseeNames: ['Caroline'] }]) {
    for (const [query, role, key] of [['What do I like?', configuration.speakerRole, configuration.speakerKey],
      ['What do you like?', configuration.addresseeRole, configuration.addresseeKey],
      ['What are my plans?', configuration.speakerRole, configuration.speakerKey],
      ['What are your beliefs?', configuration.addresseeRole, configuration.addresseeKey]]) {
      const subject = resolveQuerySubject(query, configuration);
      assert.equal(subject.role, role, query);
      assert.equal(subject.key, key, query);
    }
  }
});

test('English nested reporting does not constrain retrieval to a person inside the reported clause', () => {
  for (const query of ['Who said Caroline likes coffee?', 'Which person said Caroline likes coffee?',
    "Who has mentioned Caroline's job?", 'Who said Caroline and Melanie went together?']) {
    assert.equal(resolveQuerySubject(query, perspective).matched, false, query);
  }
  for (const query of ['Who did Caroline help?', "Who is Caroline's partner?", "Why couldn't Caroline attend?"]) {
    assert.equal(resolveQuerySubject(query, perspective).key, 'caroline', query);
  }
  for (const [subject, object, key] of [['Caroline', 'Melanie', 'caroline'], ['Melanie', 'Caroline', 'melanie']]) {
    for (const frame of ['', 'Can you tell me ', 'Do you remember ', 'Please remind me ']) {
      for (const query of [`Who said ${object} was ${subject}'s partner?`,
        `Which person said ${object} is ${subject}'s friend?`,
        `Who knows whether ${object} is ${subject}'s partner?`]) {
        assert.equal(resolveQuerySubject(frame + query, perspective).matched, false, frame + query);
      }
      for (const query of [`What did ${subject} say about ${object}'s job?`,
        ...['When', 'While', 'After', 'Before', 'Although', 'Because', 'Since']
          .map(word => `${word} ${object} was young, what did ${subject} like?`),
        `Did ${subject} say ${object} is a teacher?`]) {
        assert.equal(resolveQuerySubject(frame + query, perspective).key, key, frame + query);
      }
    }
  }
});

test('English name typography is canonical across subject attribution and retrieval execution', async t => {
  const namedPerspective = { ...perspective, speakerKey: 'oneill', speakerNames: ['O’Neill'] };
  assert.equal(resolveQuerySubject("What does O'Neill like?", namedPerspective).key, 'oneill');
  assert.equal(resolveQuerySubject('What does O’Neill like?', namedPerspective).key, 'oneill');
  const recall = fixture(t, [{ id: 'oneill', content: 'O’Neill visited the museum.', subjectKey: 'oneill' }]);
  const reference = await recall("O'Neill", { execution: 'inline', sqlPrefilter: false }, { queryPerspective: namedPerspective });
  assert.equal(reference.status, 'ready');
  for (const query of ["O'Neill", 'O’Neill']) for (const execution of ['inline', 'worker']) {
    const optimized = await recall(query, { execution, sqlPrefilterThreshold: 0 }, { queryPerspective: namedPerspective });
    assert.deepEqual(optimized.candidates.map(item => item.memoryId), reference.candidates.map(item => item.memoryId));
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
  const recall = fixture(t, [{ id: 'first', eventDate: '2026-05-26' },
    { id: 'second', eventDate: '2026-06-10' }, { id: 'outside', eventDate: '2026-07-01' }]);
  const result = await recall('What happened from May 25 to June 25?');
  assert.equal(result.status, 'ready');
  assert.deepEqual(new Set(result.candidates.map(item => item.memoryId)), new Set(['first', 'second']));
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

for (const [query, key, focus] of [
  ["What did Caroline say about Melanie's job?", 'caroline', 'event'],
  ["What did I say about Melanie's job?", 'caroline', 'event'],
  ["What did Melanie say about Caroline's job?", 'melanie', 'event'],
  ["How did Caroline help Melanie with her job?", 'caroline', 'event'],
  ['Can you tell me what Caroline likes?', 'caroline', 'state'],
  ['What do you think I like?', 'caroline', 'state'],
  ['Why do you think Caroline likes coffee?', 'caroline', 'state'],
  ['What did Caroline say Caroline and Melanie did together?', 'caroline', 'event'],
  ["Why can't Caroline swim?", 'caroline', 'event'],
  ["Why won't Melanie come?", 'melanie', 'event'],
  ['When Caroline was young, what did Melanie like?', 'melanie', 'state'],
]) test(`English matrix-clause subject: ${query}`, () => {
  const subject = resolveQuerySubject(query, perspective);
  assert.equal(subject.key, key);
  assert.equal(subject.focus, focus);
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

for (const [query, expected] of [
  ['What did I use to like?', 'historical'], ['What did Caroline like before?', 'historical'],
  ["What was Melanie's relationship status?", 'historical'],
  ['What does Caroline like?', 'current'], ["What is Melanie's relationship status?", 'current'],
  ["What is Caroline's current job?", 'current'], ["What is my former occupation?", 'historical'],
  ['Does Caroline still like tea now, as she did before?', 'current'],
  ['While Caroline was working, what does Melanie like now?', 'current'],
]) test(`English state tense: ${query}`, () => {
  const subject = resolveQuerySubject(query, perspective);
  assert.equal(subject.matched, true);
  assert.equal(subject.focus, 'state');
  assert.equal(subject.stateTime, expected);
  assert.equal(asksForHistoricalState(query), expected === 'historical');
});

for (const [query, intent] of [
  ['Are we dating?', 'role'], ['What is our relationship?', 'role'],
  ['Are we exclusive?', 'exclusivity'], ['Do you understand me?', 'understanding'],
  ['Do you have feelings for me?', 'affection'], ['Does Caroline love me?', 'affection'],
]) test(`English relationship intent: ${query}`, () => assert.equal(classifyRelationshipQueryIntent(query), intent));

for (const [query, target] of [
  ['Has the dishwasher been repaired yet?', 'completed'], ['Did Melanie finish the painting?', 'completed'],
  ['Was the trip called off?', 'cancelled'], ['Did Caroline give up?', 'cancelled'],
]) test(`English completion intent: ${query}`, () => {
  assert.deepEqual(classifyLifecycleCompletionIntent(query), { matched: true, target });
});

for (const [query, mode, direction] of [
  ['Why?', 'causal', 'backward'], ['How come?', 'causal', 'backward'],
  ['What happened next?', 'timeline', 'forward'], ['What happened before?', 'timeline', 'backward'],
  ['What else?', 'associative', 'both'],
]) test(`English follow-up: ${query}`, () => {
  assert.equal(isContinuationQuery(query), true);
  assert.deepEqual(classifyChainIntent(query), { mode, direction });
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

test('personal state questions retain relevant events and statements across both languages', async t => {
  const recall = fixture(t, [
    { id: 'career', content: 'Caroline is exploring a career in marine conservation. 我正在考虑从事海洋保护工作。' },
    { id: 'song', kind: 'preference', layer: 'semantic', stateFamily: 'preference', canonicalKey: 'song',
      temporalState: 'current', content: 'Caroline likes a song about choosing a path. 我喜欢一首关于选择道路的歌。' },
    { id: 'book-answer', kind: 'utterance', layer: 'evidence', metadata: { speaker: 'Caroline' },
      content: 'I loved the book The Secret Garden as a child. 我小时候最喜欢读《秘密花园》这本书。' },
    { id: 'book-question', kind: 'utterance', layer: 'evidence', metadata: { speaker: 'Caroline' },
      content: 'Wow, Melanie! What was your favorite book as a child? 你小时候最喜欢哪本书？' },
  ], repository => {
    for (const id of ['career', 'song']) repository.upsertEmbedding({ memoryId: id, model: 'state-fixture', vector: [1, 0] });
  });
  const embeddingProvider = async () => ({ model: 'state-fixture', vector: [1, 0] });
  for (const query of ['What career has Caroline decided to pursue?', '我决定从事什么工作？']) {
    const result = await recall(query, {}, { embeddingProvider });
    assert.equal(result.seedRouting.primaryMemoryId, 'career', query);
    assert.ok(result.graph.selectedMemoryIds.includes('career'), query);
  }
  for (const query of ["What was Caroline's favorite book as a child?", '我小时候最喜欢哪本书？']) {
    const result = await recall(query);
    assert.equal(result.seedRouting.primaryMemoryId, 'book-answer', query);
    assert.ok(result.graph.selectedMemoryIds.includes('book-answer'), query);
    assert.ok(!result.graph.selectedMemoryIds.includes('book-question'), query);
  }
  const quoted = await recall('What did Caroline say about books?');
  assert.ok(quoted.candidates.some(candidate => candidate.memoryId === 'book-question'), 'Explicit wording queries may retrieve a question.');
  for (const query of ["What is Caroline's identity?", '我的身份是什么？']) {
    assert.equal(resolveQuerySubject(query, perspective).focus, 'state', query);
  }
});

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
    assert.doesNotMatch(result.context, /Wonderful|太棒了/u);
  }
});

test('resolved event dates retain their separate knowledge clock in either query language', async t => {
  const recall = fixture(t, [{ id: 'museum', eventDate: '2026-10-20', knownAt: '2026-10-21T01:00:00Z',
    content: 'Caroline said she visited the museum yesterday. 我昨天参观了博物馆。' }]);
  for (const query of ['When did Caroline visit the museum?', '我什么时候参观了博物馆？']) {
    const result = await recall(query);
    assert.match(result.context, /事件日期：2026-10-20（已解析）；获知时间：2026-10-21/u);
    assert.match(result.context, /不再次扣减/u);
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

test('English irregular verb forms share lexical evidence across retrieval modes', async t => {
  for (const [query, document] of [['choose', 'chose'], ['go', 'went'], ['write', 'written'], ['teach', 'taught']]) {
    assert.equal(lexicalScore(query, document).overlap, 1);
    assert.equal(lexicalScore(document, query).overlap, 1);
  }
  assert.equal(lexicalScore('choose', 'choosesomething').overlap, 0);
  const recall = fixture(t, [{ id: 'choice', content: 'Caroline chose a marine lab.' }]);
  const reference = await recall('Why did Caroline choose the lab?', { sqlPrefilter: false });
  for (const execution of ['inline', 'worker']) {
    const optimized = await recall('Why did Caroline choose the lab?', { execution, sqlPrefilterThreshold: 0 });
    assert.equal(optimized.status, 'ready');
    assert.deepEqual(optimized.candidates, reference.candidates);
  }
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

test('English original-wording recall follows the matrix speaker rather than an object-clause holder', async t => {
  const recall = fixture(t, [
    { id: 'caroline-said', kind: 'utterance', layer: 'evidence',
      content: 'I said Melanie has a new job at the library.', metadata: { speaker: 'Caroline' } },
    { id: 'melanie-said', kind: 'utterance', layer: 'evidence', subjectRole: 'agent', subjectKey: 'melanie',
      content: 'I said Caroline has a new job at the library.', metadata: { speaker: 'Melanie' } },
  ]);
  const result = await recall("What did Caroline say about Melanie's job?");
  assert.equal(result.status, 'ready');
  assert.equal(result.seedRouting.primaryMemoryId, 'caroline-said');
  assert.ok(result.candidates.every(item => item.memoryId !== 'melanie-said'));
});

test('unknown-speaker recall preserves speech tense and returns the speaker rather than the reported holder', async t => {
  const recall = fixture(t, [
    { id: 'caroline-said', kind: 'utterance', layer: 'evidence',
      content: 'I like tea.', metadata: { speaker: 'Caroline' } },
    { id: 'melanie-said', kind: 'utterance', layer: 'evidence', subjectRole: 'agent', subjectKey: 'melanie',
      content: 'I said Caroline likes coffee. 我说过我喜欢咖啡。', metadata: { speaker: 'Melanie' } },
    { id: 'coffee-summary', content: 'Caroline likes coffee. 我喜欢咖啡。' },
  ]);
  for (const query of ['Who said Caroline likes coffee?', 'Who has mentioned why Caroline likes coffee?',
    'Who has said that Caroline likes coffee?', 'Which person was saying Caroline likes coffee?',
    'Which speaker has ever told you Caroline likes coffee?', '谁曾经说过我为什么喜欢咖啡', '谁说过我喜欢咖啡']) {
    assert.equal(resolveQuerySubject(query, perspective).matched, false, query);
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.recallIntent, 'utterance', query);
    assert.equal(result.chainIntent.mode, 'none', query);
    assert.equal(result.seedRouting.primaryMemoryId, 'melanie-said', query);
    assert.ok(result.candidates.every(item => item.memoryId !== 'coffee-summary'), query);
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

test('English past-state questions keep superseded evidence instead of forwarding to the current state', async t => {
  const recall = fixture(t, [{ id: 'old-state', kind: 'preference', layer: 'semantic', stateFamily: 'preference',
    canonicalKey: 'coffee', representationLayer: 'reported', content: 'Caroline liked coffee.',
    temporalState: 'historical', status: 'superseded' }]);
  const result = await recall('What did Caroline like before?');
  assert.equal(result.status, 'ready');
  assert.equal(result.seedRouting.stateRouting.mode, 'historical-allowed');
  assert.ok(result.candidates.some(candidate => candidate.memoryId === 'old-state'));
});

test('SQL prefilter and worker preserve full retrieval results for representative English inflections', async t => {
  for (const [query, content] of [['cats', 'Caroline adopted a cat.'], ['hope', 'Caroline was hoping to visit.'],
    ['hopping', 'Caroline hopped away.']]) {
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

for (const [content, status] of [
  ['The dishwasher was repaired yesterday.', 'completed'],
  ["The dishwasher hasn't been repaired yet; we are waiting for parts.", 'pending'],
  ['The dishwasher will be repaired next week.', 'unknown'],
  ['The dishwasher repair was cancelled.', 'cancelled'],
  ['Caroline planned to get the dishwasher repaired.', 'unknown'],
  ['Caroline wanted the dishwasher repaired.', 'unknown'],
  ['Caroline hoped the dishwasher was repaired.', 'unknown'],
  ['The dishwasher needed to be repaired.', 'unknown'],
  ['If the dishwasher is repaired, Caroline can use it.', 'unknown'],
  ['Caroline asked whether the dishwasher was repaired.', 'unknown'],
  ['Was the dishwasher repaired?', 'unknown'],
  ['The dishwasher repair was cancelled, but later it was completed.', 'completed'],
  ['We were waiting for dishwasher parts and finally it was repaired.', 'completed'],
  ['The dishwasher was repaired, but later broke again.', 'pending'],
  ["The dishwasher was repaired and didn't need another visit.", 'completed'],
  ['Caroline thought the dishwasher was repaired.', 'unknown'],
  ['Caroline believed the dishwasher had been repaired.', 'unknown'],
  ['The dishwasher was repaired if the parts arrived.', 'unknown'],
  ['The dishwasher was repaired unless the technician was mistaken.', 'unknown'],
  ['The dishwasher will be waiting for parts.', 'unknown'],
  ['The dishwasher is not waiting for parts.', 'unknown'],
  ['Caroline hoped the dishwasher was waiting for parts.', 'unknown'],
  ['The dishwasher has never been repaired.', 'pending'],
  ['The technician did not finish the dishwasher repair.', 'pending'],
  ['The dishwasher was not done.', 'pending'],
  ['The dishwasher was repaired after waiting for parts.', 'completed'],
  ['The dishwasher is waiting for parts after it was repaired.', 'pending'],
  ['After waiting for parts, the dishwasher was repaired.', 'completed'],
  ["The dishwasher hasn't needed to be repaired.", 'unknown'],
  ['We needed dishwasher parts, and now it was repaired.', 'completed'],
  ['Caroline was thinking the dishwasher was repaired.', 'unknown'],
]) test(`English closure respects tense and negation: ${status}`, async t => {
  const recall = fixture(t, [{ id: 'repair', content }]);
  const result = await recall('Has the dishwasher been repaired yet?');
  assert.equal(result.status, 'ready');
  assert.equal(result.trace.metadata.lifecycleClosure.status, status);
  assert.equal(result.trace.metadata.lifecycleClosure.boundaryRequired, !['completed', 'cancelled'].includes(status));
});

test('completion boundaries follow the body rather than a misleading title in either language', async t => {
  for (const [title, content, query, status] of [
    ['The dishwasher repair was completed.', 'The dishwasher has never been repaired.', 'Has the dishwasher been repaired yet?', 'pending'],
    ['Dishwasher repaired', 'Caroline thought the dishwasher was repaired.', 'Has the dishwasher been repaired yet?', 'unknown'],
    ['洗碗机已经修好了', '洗碗机还没修好，正在等配件。', '洗碗机修好了没', 'pending'],
  ]) {
    const recall = fixture(t, [{ id: 'repair', title, content }]);
    const result = await recall(query);
    assert.equal(result.status, 'ready');
    assert.equal(result.trace.metadata.lifecycleClosure.status, status);
    assert.equal(result.trace.metadata.lifecycleClosure.boundaryRequired, true);
  }
});

test('Chinese and English closure apply the same certainty and chronology rules', async t => {
  for (const [content, status] of [
    ['我以为洗碗机已经修好了。', 'unknown'],
    ['如果配件到了，洗碗机就修好了。', 'unknown'],
    ['洗碗机修好了，除非师傅判断错了。', 'unknown'],
    ['明天洗碗机将会等待配件。', 'unknown'],
    ['洗碗机不再等待配件。', 'unknown'],
    ['洗碗机还没修好。', 'pending'],
    ['洗碗机修好了，但后来又坏了。', 'pending'],
    ['本来取消了维修，但是后来洗碗机修好了。', 'completed'],
    ['洗碗机已经修好了；之前一直在等配件。', 'completed'],
    ['The dishwasher was repaired; previously we were waiting for parts.', 'completed'],
    ['洗碗机未能成功修好。', 'pending'],
    ['先前需要等配件，后来洗碗机已经修好了。', 'completed'],
    ['洗碗机已经修好了，但我还没吃饭。', 'completed'],
  ]) {
    const recall = fixture(t, [{ id: 'repair', content }]);
    const query = /\p{Script=Han}/u.test(content) ? '洗碗机修好了没' : 'Has the dishwasher been repaired yet?';
    const result = await recall(query);
    assert.equal(result.status, 'ready', content);
    assert.equal(result.trace.metadata.lifecycleClosure.status, status, content);
    assert.equal(result.trace.metadata.lifecycleClosure.boundaryRequired, !['completed', 'cancelled'].includes(status), content);
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

test('dated original-wording questions keep utterance intent in Chinese and English', async t => {
  const memories = [
    { id: 'summary', kind: 'event', content: 'Caroline visited the museum. Caroline参观了博物馆。',
      eventDate: '2026-05-25', importance: 0.9 },
    { id: 'raw', kind: 'utterance', layer: 'evidence', content: 'I visited the museum. 我参观了博物馆。',
      eventStart: '2026-05-25T10:00:00Z', importance: 0.1 },
    { id: 'recent-summary', kind: 'event', content: 'Caroline visited the library. Caroline参观了图书馆。',
      eventDate: '2026-10-20', importance: 0.9 },
    { id: 'recent-raw', kind: 'utterance', layer: 'evidence', content: 'I visited the library. 我参观了图书馆。',
      eventStart: '2026-10-20T10:00:00Z', importance: 0.1 },
  ];
  const recall = fixture(t, memories);
  for (const [query, expected] of [
    ['What did I say on May 25?', 'raw'], ['5月25号我说过什么', 'raw'],
    ['What did I say recently?', 'recent-raw'], ['最近我说过什么', 'recent-raw'],
  ]) {
    const result = await recall(query);
    assert.equal(result.status, 'ready', query);
    assert.equal(result.recallIntent, 'utterance', query);
    assert.equal(result.seedRouting.primaryMemoryId, expected, query);
    assert.deepEqual(result.candidates.map(item => item.memoryId), [expected], query);
  }
  const onlySummaries = fixture(t, memories.filter(memory => memory.kind === 'event'));
  for (const query of ['What did I say on May 25?', '5月25号我说过什么']) {
    assert.equal((await onlySummaries(query)).status, 'no-match', query);
  }
});

test('arrival progress closes an arrival question without closing a repair question', async t => {
  for (const [content, arrivalQueries, repairQuery] of [
    ['The dishwasher parts have arrived.', ['Have the dishwasher parts arrived?',
      'Do not tell me if the dishwasher has been repaired; have the dishwasher parts arrived?',
      'Have the dishwasher parts named "Repaired" arrived?'], 'Has the dishwasher been repaired?'],
    ['洗碗机的维修配件已经到货了。', ['洗碗机的配件到货了吗',
      '不要告诉我洗碗机修好了没，洗碗机的配件到货了吗',
      '代号《修好》的洗碗机配件到货了吗'], '洗碗机修好了没'],
  ]) {
    const recall = fixture(t, [{ id: 'parts', content }]);
    for (const [query, status] of [...arrivalQueries.map(query => [query, 'completed']), [repairQuery, 'unknown']]) {
      const result = await recall(query);
      assert.equal(result.status, 'ready', query);
      assert.equal(result.trace.metadata.lifecycleClosure.status, status, query);
    }
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
  for (const execution of ['inline', 'worker']) for (const query of ["What are Caroline's hobbies?", '我有哪些爱好']) {
    const result = await recall(query, { execution, sqlPrefilterThreshold: 0 }, {
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
