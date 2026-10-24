import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { classifyChainIntent, closeRetrievalWorkers, DEFAULT_RETRIEVAL_OPTIONS, lexicalScore, prepareLexicalQuery, retrieveMemories } from '../src/index.mjs';
import { buildOrdinarySeedCandidates } from '../src/seed-routes.mjs';

const query = '赵齐让白羽岚称呼他为什么？A 大佬 B 军人 C sensei D 小齐';
const personNames = ['赵齐', '白羽岚'];

test('naming questions request the name while questions about the reason retain their causal intent', () => {
  for (const text of ['赵齐让白羽岚称呼他为什么？', '他们把这条船命名为什么？', '她把这个项目改名为什么？']) {
    assert.equal(classifyChainIntent(text).mode, 'none', text);
  }
  for (const text of ['为什么称呼他为sensei？', '他为什么要求别人称呼他为老师？', '她为何把项目改名？',
    '这个称呼为什么不合适？', '我称呼了他，为什么？']) {
    assert.deepEqual(classifyChainIntent(text), { mode: 'causal', direction: 'backward' }, text);
  }
});

test('overlapping query spans share credit even when a document repeats the same name', () => {
  const prepared = prepareLexicalQuery(query);
  const content = '赵齐为了不让白羽岚伤心，纠正说自己是军人。';
  const match = lexicalScore(prepared, content);
  assert.equal(match.score, 5);
  assert.deepEqual(new Set(match.matchedTerms), new Set(['赵齐', '让白羽岚', '军人']));
  assert.deepEqual(lexicalScore(prepared, content.repeat(10)), match);
  assert.ok(lexicalScore(prepared, '你可以称呼我为sensei。').score > match.score);
  assert.deepEqual(lexicalScore(query, content), match);
});

test('declared people retain candidate lookup terms while topic scoring excludes their name spans', () => {
  const prepared = prepareLexicalQuery(query, { personNames });
  assert.ok(prepared.queryTerms.includes('白羽岚'));
  const office = lexicalScore(prepared, '赵齐为了不让白羽岚伤心，说自己是军人。');
  assert.deepEqual(office.matchedTerms, ['军人']);
  assert.equal(office.score, 1);
  const quote = lexicalScore(prepared, '你可以称呼我为sensei。');
  assert.deepEqual(quote.matchedTerms, ['称呼', 'sensei']);
  assert.equal(quote.score, 6);
  assert.equal(lexicalScore(prepareLexicalQuery('Anna annual report', { personNames: ['Ann'] }), 'annual report').matchedTerms.includes('annual'), true);
  assert.ok(lexicalScore(prepareLexicalQuery('赵齐', { personNames }), '赵齐的工作记录。').exactPhrase);
  const question = lexicalScore(prepareLexicalQuery('赵齐和白羽岚一起发现了什么？', { personNames }), '赵齐当时在做什么？');
  assert.deepEqual(question.matchedTerms, []);
});

test('strong entity and vector routes retain BM25 evidence within one text scoring budget', () => {
  const nodes = ['fts', 'other'].map(id => ({ id, kind: 'event', title: '', content: '整理旧资料。', status: 'active', importance: 0.5 }));
  const options = DEFAULT_RETRIEVAL_OPTIONS;
  const input = { nodes, query: 'university education', intent: 'auto', options,
    entityScores: new Map(nodes.map(node => [node.id, 0.8])), vectorScores: new Map(nodes.map(node => [node.id, 0.7])),
    bm25Scores: new Map([['fts', { normalizedScore: 0.9, bestSearchRank: -5 }]]) };
  const [fts, other] = buildOrdinarySeedCandidates(input);
  assert.equal(fts.node.id, 'fts');
  assert.ok(fts.routeContributions.bm25 > 0);
  assert.equal(fts.routeContributions.bm25, 0.9 * options.bm25ContributionWeight);
  assert.ok(fts.score > other.score);
  const [both] = buildOrdinarySeedCandidates({ ...input, nodes: [{ ...nodes[0], content: 'University education at the local college.' }] });
  const text = both.routeMatches.filter(route => ['lexical', 'bm25'].includes(route.route));
  assert.equal(text.filter(route => route.contribution > 0).length, 1);
  assert.ok(both.routeContributions.lexical > 0);
  const [ftsWithLexical] = buildOrdinarySeedCandidates({ ...input, options: { ...options, strongLexicalScore: 100 },
    nodes: [{ ...nodes[0], content: 'education' }] });
  assert.ok(ftsWithLexical.routeContributions.bm25 > 0);
  assert.equal(ftsWithLexical.routeContributions.lexical, 0);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-relevance-'));
  const databasePath = path.join(root, 'memory.db');
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  t.after(async () => { database.close(); await closeRetrievalWorkers(); fs.rmSync(root, { recursive: true, force: true }); });
  return { databasePath, repository };
}

function add(repository, id, content, { kind = 'event', similarity = 0.8, ...extra } = {}) {
  const node = repository.upsertMemory({ id, agentId: 'relevance-agent', kind, layer: kind === 'utterance' ? 'evidence' : 'episodic',
    content, importance: 0.5, subjectRole: 'user', subjectKey: 'user', worldId: 'story', worldFrame: 'fictional',
    recordedAt: '2026-10-20T08:00:00Z', eventStart: '2026-10-20T08:00:00Z', metadata: { speaker: '赵齐' }, ...extra });
  repository.upsertEmbedding({ memoryId: id, model: 'fixture', vector: [similarity, Math.sqrt(1 - similarity ** 2)] });
  return node;
}

function recall(databasePath, options = {}) {
  return retrieveMemories({ databasePath, agentId: 'relevance-agent', query, now: new Date('2026-10-25T00:00:00Z'),
    world: { id: 'story', frame: 'fictional' },
    queryPerspective: { speakerNames: ['赵齐'], addresseeNames: ['白羽岚'] }, options,
    embeddingProvider: async () => ({ model: 'fixture', vector: new Float32Array([1, 0]) }) });
}

test('a relevant unconnected quote and its nearby reply reach context without promoting name-only distractions', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'office', '赵齐为了不让白羽岚伤心，说自己是军人。', { importance: 1, similarity: 1 });
  add(repository, 'address', '你可以称呼我为sensei。', { kind: 'utterance', similarity: 0.5, importance: 0.1 });
  add(repository, 'reply', '好的，sensei。', { kind: 'utterance', similarity: 0.5, subjectRole: 'agent', subjectKey: 'relevance-agent',
    eventStart: '2026-10-20T08:00:01Z', metadata: { speaker: '白羽岚' } });
  add(repository, 'garden', '赵齐和白羽岚在院子吃饭。', { similarity: 0.95 });
  add(repository, 'other-world', '你可以称呼我为FORBIDDEN_WORLD。', { kind: 'utterance', similarity: 1, worldId: 'other-story' });
  add(repository, 'other-agent', '你可以称呼我为FORBIDDEN_AGENT。', { kind: 'utterance', similarity: 1, agentId: 'other-agent' });
  const person = repository.upsertEntity({ agentId: 'relevance-agent', kind: 'person', canonicalName: '赵齐' });
  for (const id of ['office', 'address', 'garden']) repository.linkMemoryEntity({ memoryId: id, entityId: person.id, role: 'participant' });
  repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'address', toMemoryId: 'reply', relation: 'followed_by', weight: 1, confidence: 1 });
  const expansions = [];
  const expand = MemoryRepository.prototype.expand;
  MemoryRepository.prototype.expand = function (agentId, ids, options) {
    expansions.push({ ids, maxNodes: options.maxNodes });
    return expand.call(this, agentId, ids, options);
  };
  let result;
  try { result = await recall(databasePath); }
  finally { MemoryRepository.prototype.expand = expand; }
  assert.ok(expansions.length <= 2);
  assert.equal(expansions.filter(value => value.ids.includes('address')).length, 1);
  assert.ok(expansions.every(value => value.maxNodes <= 100));
  assert.equal(result.status, 'ready');
  assert.equal(result.seedRouting.primaryMemoryId, 'office');
  assert.match(result.context, /赵齐：你可以称呼我为sensei/u);
  assert.match(result.context, /白羽岚：好的，sensei/u);
  assert.doesNotMatch(result.context, /院子吃饭|FORBIDDEN/u);
  assert.ok(result.graph.selectedMemoryIds.includes('address'));
  assert.equal(result.graph.paths.some(value => value.memoryId === 'address'), false);
  assert.deepEqual(result.graph.convergedSeeds.connections, []);
  assert.equal(new Set(result.graph.evidenceMemoryIds).size, result.graph.evidenceMemoryIds.length);
  assert.ok(result.graph.evidenceMemoryIds.length <= 2);
  assert.equal((result.context.match(/你可以称呼我为sensei/gu) || []).length, 1);
});

test('independent evidence selection respects message, chain and character limits', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'office', '赵齐为了不让白羽岚伤心，说自己是军人。', { importance: 1, similarity: 1 });
  add(repository, 'address', '你可以称呼我为sensei。', { kind: 'utterance', similarity: 0.9 });
  add(repository, 'another-quote', '赵齐说小齐这个称呼也有人使用。', { kind: 'utterance', similarity: 0.85 });
  const result = await recall(databasePath, { maximumEvidenceMessages: 1, maximumChainMemories: 2, maximumContextChars: 450 });
  assert.ok(result.context.length <= 450);
  assert.ok(result.graph.selectedMemoryIds.length <= 2);
  assert.ok(result.graph.evidenceMemoryIds.length <= 1);
  const withoutEvidence = await recall(databasePath, { maximumEvidenceMessages: 0 });
  assert.deepEqual(withoutEvidence.graph.evidenceMemoryIds, []);
  assert.ok(withoutEvidence.graph.selectedMemoryIds.filter(id => id.includes('quote') || id === 'address').length <= 1);
});

test('source exchange selection ranks question relevance ahead of the earliest attached exchange', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'summary', '赵齐让白羽岚称呼自己为sensei，白羽岚答应了。', { similarity: 1, importance: 1 });
  for (const [id, text, role, second] of [
    ['old-user', '今天去院子转一转。', 'user', '00'], ['old-agent', '好呀。', 'agent', '01'],
    ['new-user', '你可以称呼我为sensei。', 'user', '10'], ['new-agent', '好的，sensei。', 'agent', '11'],
  ]) {
    add(repository, id, text, { kind: 'utterance', similarity: 0.5, subjectRole: role, eventStart: `2026-10-20T08:00:${second}Z` });
    repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'summary', toMemoryId: id, relation: 'supported_by', weight: 1, confidence: 1 });
  }
  for (const [fromMemoryId, toMemoryId] of [['old-user', 'old-agent'], ['new-user', 'new-agent']]) {
    repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId, toMemoryId, relation: 'followed_by', weight: 1, confidence: 1 });
  }
  const result = await recall(databasePath, { maximumConvergedSeeds: 1 });
  assert.equal(result.seedRouting.primaryMemoryId, 'summary');
  assert.deepEqual(result.graph.evidenceMemoryIds, ['new-user', 'new-agent']);
  assert.doesNotMatch(result.context, /院子转一转/u);
});

test('an incidental state seed does not block independent event evidence for an event question', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'incidental-state', '赵齐说自己是军人。', { kind: 'fact', similarity: 1, importance: 1,
    canonicalKey: 'user:identity:occupation', stateFamily: 'identity', statePhase: 'active', stateScopeKey: 'root',
    representationLayer: 'reported', temporalState: 'current' });
  add(repository, 'address', '赵齐让白羽岚称呼自己为sensei。', { kind: 'event', similarity: 0.5, importance: 0.1 });
  const result = await recall(databasePath);
  assert.equal(result.seedRouting.primaryMemoryId, 'incidental-state');
  assert.match(result.context, /称呼自己为sensei/u);
  assert.ok(result.graph.selectedMemoryIds.includes('address'));
  assert.deepEqual(result.graph.convergedSeeds.connections, []);
});

test('an unconnected weak text clue requires independent admission before it can enter context', async t => {
  const { databasePath, repository } = fixture(t);
  add(repository, 'museum', '用户去了科技馆。');
  add(repository, 'dinner', '后来一起吃了晚饭。');
  const input = { databasePath, agentId: 'relevance-agent', query: '还记得科技馆和那顿晚饭吗',
    options: { strongBm25Score: 1 }, world: { id: 'story', frame: 'fictional' } };
  const result = await retrieveMemories(input);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.graph.selectedMemoryIds, ['museum']);
  assert.doesNotMatch(result.context, /吃了晚饭/u);
  repository.upsertEdge({ agentId: 'relevance-agent', fromMemoryId: 'museum', toMemoryId: 'dinner', relation: 'timeline_next', weight: 1, confidence: 1 });
  const connected = await retrieveMemories(input);
  assert.match(connected.context, /吃了晚饭/u);
  assert.equal(connected.graph.convergedSeeds.connections[0].relation, 'timeline_next');
});
