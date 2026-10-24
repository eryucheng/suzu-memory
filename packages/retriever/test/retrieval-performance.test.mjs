import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHook } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { closeRetrievalWorkers, DEFAULT_RETRIEVAL_OPTIONS, lexicalScore, prepareLexicalQuery, retrieveMemories } from '../src/index.mjs';
import { createNodeReader } from '../src/node-reader.mjs';
import { prefilterCandidateIds } from '../src/candidate-prefilter.mjs';
import { buildEpisodicEvidenceSeedCandidates, buildOrdinarySeedCandidates, createSeedLexicalScorer } from '../src/seed-routes.mjs';

function fixture(t, count = 60) {
  const parent = path.join(os.tmpdir(), 'Codex', 'suzu-memory-retrieval-performance-tests');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'execution-'));
  const databasePath = path.join(root, 'memory.db');
  t.after(async () => { await closeRetrievalWorkers(); fs.rmSync(root, { recursive: true, force: true }); });
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  repository.transaction(() => {
    for (let index = 0; index < count; index++) {
      const id = `memory-${index}`;
      repository.upsertMemory({ id, agentId: 'perf-agent', kind: index % 4 === 0 ? 'utterance' : 'event',
        layer: index % 4 === 0 ? 'raw' : 'episodic', subjectRole: 'user', subjectKey: 'user',
        title: index % 7 ? '日常记录' : '灯塔博物馆',
        content: index % 7 ? `用户整理了编号 ${index} 的工作材料。` : '用户去灯塔博物馆看过机器人展。',
        eventDate: '2026-10-20', eventStart: '2026-10-20T07:30:00+08:00', recordedAt: '2026-10-20T07:30:00+08:00' });
      repository.upsertEmbedding({ memoryId: id, model: 'fixture', vector: index % 7 ? [0, 1] : [1, 0], sourceMemoryIds: [id] });
    }
  });
  database.close();
  return { databasePath, recall: (query, options, extra = {}) => retrieveMemories({ databasePath, agentId: 'perf-agent', query,
    now: new Date('2026-10-23T12:00:00+08:00'), options, ...extra }) };
}

test('prepared lexical queries preserve every score and term', () => {
  for (const query of ['我们聊过猫吗', 'Who visited the museum?', 'ＡＢＣ 研究', '灯塔博物馆', '10月20号']) {
    const prepared = prepareLexicalQuery(query);
    for (const content of ['我们聊过猫。', 'User visited the museum.', 'ABC研究', '灯塔 博物馆', '2026-10-20']) {
      assert.deepEqual(lexicalScore(prepared, content), lexicalScore(query, content));
    }
  }
});

test('seed routes share lexical work while retaining their own admission and adjustments', () => {
  const reads = new Map();
  const nodes = [
    ['strong', 'utterance', 'coffee museum visit'],
    ['weak', 'utterance', 'coffee'],
    ['bm25', 'event', 'daily notes'],
    ['vector', 'event', 'daily notes'],
    ['entity', 'event', 'daily notes'],
    ['none', 'utterance', 'unrelated'],
  ].map(([id, kind, content]) => ({
    id, kind, title: '', status: 'active', importance: 0.5, event_date: '2026-10-20', recorded_at: '2026-10-20T00:00:00Z',
    get content() { reads.set(id, (reads.get(id) || 0) + 1); return content; },
  }));
  const input = { nodes, query: 'coffee museum', preparedQuery: prepareLexicalQuery('coffee museum'), intent: 'auto',
    options: DEFAULT_RETRIEVAL_OPTIONS,
    bm25Scores: new Map([['bm25', { normalizedScore: 0.8, bestSearchRank: -3 }]]),
    vectorScores: new Map([['vector', 0.8]]), entityScores: new Map([['entity', 0.75]]) };
  const adjusted = { ...input,
    accessibilityAdjustments: new Map([['strong', { scoreAdjustment: -0.04 }]]),
    recallReactivationAdjustments: new Map([['strong', { scoreAdjustment: 0.02 }]]),
    naturalDecayAdjustments: new Map([['strong', { scoreAdjustment: -0.03 }]]),
    affectiveAdjustments: new Map([['strong', { scoreAdjustment: 0.06 }]]) };
  const collect = (shared = {}) => ({
    direct: buildOrdinarySeedCandidates({ ...adjusted, ...shared }),
    convergence: buildOrdinarySeedCandidates({ ...adjusted, ...shared, includeWeakLexical: true }),
    episodic: buildEpisodicEvidenceSeedCandidates({ ...input, ...shared }),
  });
  const reference = collect();
  assert.equal(reads.get('strong'), 3);
  reads.clear();
  const reused = collect({ scoreLexical: createSeedLexicalScorer(input.preparedQuery) });
  assert.deepEqual(reused, reference);
  assert.deepEqual([...reads.values()], nodes.map(() => 1), 'including rejected and zero-score nodes');
  assert.deepEqual(new Set(reused.direct.map(value => value.node.id)), new Set(['strong', 'bm25', 'vector', 'entity']));
  assert.ok(reused.convergence.some(value => value.node.id === 'weak' && value.admission === 'convergence-only'));
  assert.deepEqual(reused.episodic.map(value => value.node.id), ['strong']);
  assert.notEqual(reused.direct.find(value => value.node.id === 'strong').score, reused.episodic[0].score);
  for (const route of ['lexical', 'bm25', 'vector', 'entity']) {
    assert.ok(reused.direct.some(value => value.routeMatches.some(match => match.route === route)));
  }
});

test('seed lexical reuse is bound to one prepared query and node snapshot', () => {
  const node = { id: 'same-id', event_date: '2026-10-20', title: 'Coffee', content: 'Museum visit' };
  const query = prepareLexicalQuery('coffee museum');
  const score = createSeedLexicalScorer(query);
  assert.deepEqual(score(node), lexicalScore(query, '2026-10-20\nCoffee\nMuseum visit'));
  assert.equal(score({ ...node, title: '', content: 'hiking' }).score, 0, 'a different snapshot with the same ID must not reuse its text');
  assert.equal(createSeedLexicalScorer(prepareLexicalQuery('hiking'))(node).score, 0, 'the next query has its own scores');
  assert.ok(createSeedLexicalScorer(prepareLexicalQuery('2026-10-20'))(node).admissionOverlap > 0, 'event date remains part of seed text');
});

for (const execution of ['inline', 'worker']) test(`a retrieval scores seed text once per node (${execution})`, t => {
  const { databasePath } = fixture(t, 60);
  const coverageDirectory = path.join(path.dirname(databasePath), 'coverage');
  const moduleUrl = new URL('../src/index.mjs', import.meta.url).href;
  const childScript = path.join(path.dirname(databasePath), 'probe.mjs');
  fs.writeFileSync(childScript, `
    import { retrieveMemories, closeRetrievalWorkers } from ${JSON.stringify(moduleUrl)};
    try {
      const result = await retrieveMemories({ databasePath: ${JSON.stringify(databasePath)}, agentId: 'perf-agent',
        query: '灯塔博物馆', now: new Date('2026-10-23T04:00:00Z'), options: { execution: ${JSON.stringify(execution)}, sqlPrefilter: false } });
      if (result.status !== 'ready') throw new Error('Expected a real retrieval result.');
    } finally { await closeRetrievalWorkers(); }
  `);
  const child = spawnSync(process.execPath, [childScript], {
    env: { ...process.env, NODE_V8_COVERAGE: coverageDirectory }, encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr);
  const queryUrl = new URL('../src/query.mjs', import.meta.url).href;
  let calls = 0;
  for (const file of fs.readdirSync(coverageDirectory)) {
    const coverage = JSON.parse(fs.readFileSync(path.join(coverageDirectory, file), 'utf8'));
    for (const script of coverage.result.filter(value => value.url === queryUrl)) {
      calls += script.functions.filter(value => value.functionName === 'lexicalScore').reduce((sum, value) => sum + value.ranges[0].count, 0);
    }
  }
  assert.equal(calls, 60, 'ordinary, convergence and episodic routes must reuse identical seed text scores');
});

test('SQL superset and worker execution preserve complete public retrieval results', async t => {
  const { recall } = fixture(t);
  const embeddingProvider = async () => ({ model: 'fixture', vector: new Float32Array([1, 0]) });
  for (const query of ['灯塔博物馆', '机器人展', '我昨天去过灯塔博物馆吗', '前几天灯塔博物馆', '上次灯塔博物馆']) {
    const reference = await recall(query, { execution: 'inline', sqlPrefilter: false, embeddingCache: false }, { embeddingProvider });
    for (const execution of ['inline', 'worker']) {
      const optimized = await recall(query, { execution, sqlPrefilterThreshold: 1 }, { embeddingProvider });
      assert.deepEqual(JSON.parse(JSON.stringify(optimized)), JSON.parse(JSON.stringify(reference)), `${execution}: ${query}`);
    }
  }
});

test('vector cache cannot retain old vectors, statuses, or caller mutations', t => {
  const { databasePath } = fixture(t);
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  const read = () => repository.listEmbeddings('perf-agent', 'fixture', { cache: true });
  try {
    const before = read();
    before[0].vector[0] = 99;
    assert.notEqual(read()[0].vector[0], 99);
    repository.upsertEmbedding({ memoryId: 'memory-0', model: 'fixture', vector: [0.25, 0.75], sourceMemoryIds: ['memory-0'] });
    assert.equal(read().find(row => row.memory_id === 'memory-0').vector[0], 0.25);
    database.prepare("UPDATE memory_nodes SET status='deleted' WHERE id='memory-0'").run();
    assert.ok(!read().some(row => row.memory_id === 'memory-0'));
  } finally { database.close(); }
});

test('SQL prefilter retains direct SQL edits and missing index rows', async t => {
  const { databasePath, recall } = fixture(t);
  const database = openMemoryDatabase(databasePath);
  database.prepare("UPDATE memory_nodes SET content='用户去了紫藤艺术馆。' WHERE id='memory-1'").run();
  database.prepare("DELETE FROM memory_fts_rows WHERE memory_id='memory-2'").run();
  database.close();
  const reference = await recall('紫藤艺术馆', { execution: 'inline', sqlPrefilter: false });
  const optimized = await recall('紫藤艺术馆', { execution: 'inline', sqlPrefilterThreshold: 1 });
  assert.deepEqual(optimized, reference);
  assert.equal(optimized.candidates[0].memoryId, 'memory-1');
});

test('large candidate selection reads bodies in a batch and hydrates graph targets on demand', t => {
  const { databasePath } = fixture(t, 1100);
  const database = openMemoryDatabase(databasePath, { readOnly: true });
  try {
  const reader = createNodeReader(database, 'perf-agent');
  const nodes = reader.load(['active']);
  assert.deepEqual(reader.stats, { deferred: true, metadataRows: 1100, bodyRows: 0, bodyQueries: 0 });
  const ids = prefilterCandidateIds(database, 'perf-agent', prepareLexicalQuery('灯塔博物馆'), {}, {}, nodes.length);
  const candidates = nodes.filter(node => ids.has(node.id));
  reader.hydrate(candidates);
  assert.equal(reader.stats.bodyQueries, 1);
  assert.equal(reader.stats.bodyRows, candidates.length);
  assert.ok(candidates.length < 200);
  assert.ok(candidates.every(node => node.content.includes('灯塔博物馆')));
  const target = nodes.find(node => !ids.has(node.id));
  assert.match(target.content, /工作材料/);
  assert.ok(target.title);
  assert.equal(reader.stats.bodyRows, candidates.length + 1);
  assert.equal(reader.stats.bodyQueries, 2);
  const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT id,title,content FROM memory_nodes
    WHERE agent_id=? AND id IN (SELECT value FROM json_each(?))`).all('perf-agent', JSON.stringify([...ids]));
  assert.ok(plan.some(row => /SEARCH.*INDEX/u.test(row.detail)), JSON.stringify(plan));
  } finally { database.close(); }
});

test('retained workers survive normal chat pauses and obey idle timeout and close', async t => {
  const { recall } = fixture(t, 3);
  let spawned = 0;
  const hook = createHook({ init(id, type) { if (type === 'WORKER') spawned++; } });
  hook.enable();
  t.after(() => hook.disable());
  await closeRetrievalWorkers();
  const options = { execution: 'worker' };
  const first = await recall('灯塔博物馆', options);
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.deepEqual(await recall('灯塔博物馆', options), first);
  assert.equal(spawned, 1, 'default worker must survive a pause longer than five seconds');
  await closeRetrievalWorkers();
  await recall('灯塔博物馆', { execution: 'worker', workerIdleTimeoutMs: 20 });
  await new Promise(resolve => setTimeout(resolve, 150));
  await recall('灯塔博物馆', options);
  assert.equal(spawned, 3, 'explicit close and short idle expiry must each release their worker');
});

for (const execution of ['inline', 'worker']) test(`deferred bodies retain the eligibility snapshot across concurrent writes (${execution})`, async t => {
  const { databasePath, recall } = fixture(t, 3);
  function update(marker) {
    const database = openMemoryDatabase(databasePath);
    try {
      database.prepare('UPDATE memory_nodes SET content=? WHERE id=?').run(`${marker} 雪山博物馆的展览。`, 'memory-1');
      new MemoryRepository(database).syncSearch('memory-1');
    } finally { database.close(); }
  }
  update('SNAPSHOT_OLD');
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const options = { execution, sqlPrefilterThreshold: 1 };
  const pending = recall('雪山博物馆', options, { embeddingProvider: async () => {
    start(); await waiting; return { model: 'missing-model', vector: [1, 0] };
  } });
  await started;
  update('SNAPSHOT_NEW');
  release();
  const result = await pending;
  assert.match(result.context, /SNAPSHOT_OLD/);
  assert.ok(!JSON.stringify(result).includes('SNAPSHOT_NEW'));
  assert.match((await recall('雪山博物馆', options)).context, /SNAPSHOT_NEW/);
});

test('worker cancellation rejects promptly and subsequent retrieval still works', async t => {
  const { recall } = fixture(t);
  const controller = new AbortController();
  let requested;
  const started = new Promise(resolve => { requested = resolve; });
  const work = recall('灯塔博物馆', { execution: 'worker' }, { signal: controller.signal,
    embeddingProvider: async () => { requested(); return new Promise(() => {}); } });
  const rejected = assert.rejects(work, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  await closeRetrievalWorkers();
  assert.equal((await recall('灯塔博物馆', { execution: 'worker' })).status, 'ready');
});

test('bounded workers handle concurrent databases and cancellation while waiting for capacity', async t => {
  const fixtures = Array.from({ length: 3 }, () => fixture(t, 3));
  const results = await Promise.all(fixtures.map(({ recall }) => recall('灯塔博物馆', { execution: 'worker' })));
  assert.ok(results.every(result => result.status === 'ready'));
  const releases = [], starts = [];
  const waiting = fixtures.slice(0, 2).map(({ recall }) => {
    let start;
    starts.push(new Promise(resolve => { start = resolve; }));
    return recall('灯塔博物馆', { execution: 'worker' }, { embeddingProvider: async () => {
      start(); await new Promise(resolve => releases.push(resolve));
      return { model: 'fixture', vector: [1, 0] };
    } });
  });
  await Promise.all(starts);
  const controller = new AbortController();
  const queued = fixtures[2].recall('灯塔博物馆', { execution: 'worker' }, { signal: controller.signal });
  const rejected = assert.rejects(queued, { name: 'AbortError' });
  controller.abort();
  await rejected;
  for (const release of releases) release();
  assert.ok((await Promise.all(waiting)).every(result => result.status === 'ready'));
});

test('exact dates keep all ordinary routes and fall back when the date differs', async t => {
  const { databasePath, recall } = fixture(t, 1);
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  repository.upsertMemory({ id: 'hotpot', agentId: 'perf-agent', kind: 'preference', layer: 'semantic',
    subjectRole: 'user', subjectKey: 'user', stateFamily: 'preference', canonicalKey: 'user:preference:hotpot',
    content: '用户喜欢吃火锅。', knownAt: '2026-10-21T07:30:00+08:00', temporalState: 'current' });
  database.close();
  for (const query of ['用户喜欢吃火锅吗', '昨天用户说喜欢吃火锅吗', '10月22号用户说喜欢吃火锅吗']) {
    const result = await recall(query, { execution: 'inline' });
    assert.equal(result.status, 'ready', query);
    assert.ok(result.candidates.some(candidate => candidate.memoryId === 'hotpot'), query);
    assert.ok(result.seedRouting.plannedRoutes.includes('bm25'));
    if (result.temporal.matched) assert.equal(result.seedRouting.routeStatus.temporal, 'no-match');
  }
});
