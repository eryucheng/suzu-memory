import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';
import { runEventContinuityMaintenance, runImmediateMemoryMaintenance, runEmbeddingMaintenance } from '../src/index.mjs';

function fixture(t) {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const calls = [], embeddings = [];
  const embeddingProvider = Object.assign(async text => {
    embeddings.push(text);
    return { model: 'event-test', vector: [1, 0, 0] };
  }, { model: 'event-test', dimensions: 3 });
  let decide = ({ memory, candidates }) => ({ memoryId: memory.id, resolution: 'matched',
    candidateId: candidates[0].id, relation: 'completes',
    evidenceSourceIds: [memory.sources[0].id, candidates[0].sources[0].id], rationale: '原文明确完成此前约定的同一件事情。' });
  const generator = async request => {
    calls.push(request);
    assertMemoryTaskRequest(request);
    const output = { matches: JSON.parse(request.input).events.map(decide) };
    validateMemoryTaskOutput(request, output);
    return { output, model: 'test' };
  };
  function seed(id, { agentId = 'owner', worldId = 'room-a', reality = 'real', worldFrame = 'physical', queue = true } = {}) {
    const memory = repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic',
      title: '整理书单', content: `${id}：我和小明整理同一份书单。`, subjectRole: 'agent', subjectKey: agentId,
      canonicalKey: 'unreliable-model-key', reality, worldId, worldFrame,
      knownAt: `2026-09-${String(Number(id.replace(/\D/g, '')) || 1).padStart(2, '0')}T08:00:00.000Z` });
    const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: id, content: memory.content });
    repository.linkSource(memory.id, source.id);
    if (queue) runImmediateMemoryMaintenance({ repository, agentId, memoryIds: [id], batchId: id });
    return memory;
  }
  const run = () => runEventContinuityMaintenance({ repository, agentId: 'owner', generator, embeddingProvider });
  return { database, repository, calls, embeddings, embeddingProvider, generator, seed, run,
    setDecision: callback => { decide = callback; } };
}

test('event progress shares identity across spaces, preserves records and reuses early embeddings', async t => {
  const f = fixture(t);
  const old = f.seed('event-1');
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.calls.length, 0);
  const next = f.seed('event-2', { worldId: 'room-b' });
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.embeddings.length, 2);
  const stored = f.repository.getMemory(next.id);
  assert.equal(stored.canonical_key, f.repository.getMemory(old.id).canonical_key);
  assert.equal(stored.content, next.content);
  assert.equal(f.repository.getMemory(old.id).content, old.content);
  assert.equal(f.repository.getMemory(old.id).status, 'active');
  const edges = f.database.prepare("SELECT relation FROM memory_edges WHERE provenance = 'event-continuity-v1'").all();
  assert.deepEqual(edges.map(edge => edge.relation).sort(), ['completes', 'same_thread']);
  await runEmbeddingMaintenance({ repository: f.repository, agentId: 'owner', embeddingProvider: f.embeddingProvider });
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.embeddings.length, 2);
});

for (const resolution of ['new', 'ambiguous']) test(`similar events remain independent when ${resolution}`, async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  f.seed('event-2');
  f.setDecision(({ memory }) => ({ memoryId: memory.id, resolution, candidateId: '', relation: '',
    evidenceSourceIds: [], rationale: '仅主题相同，无法认定同一具体事项。' }));
  assert.equal((await f.run()).failed.length, 0);
  assert.notEqual(f.repository.getMemory('event-1').canonical_key, f.repository.getMemory('event-2').canonical_key);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM memory_edges WHERE provenance = 'event-continuity-v1'").get().n, 0);
});

test('event candidates exclude other owners and incompatible fictional worlds', async t => {
  const f = fixture(t);
  f.seed('event-1', { agentId: 'other' });
  f.seed('event-2', { reality: 'fictional', worldId: 'story-a', worldFrame: 'fictional' }); await f.run();
  f.seed('event-3', { reality: 'fictional', worldId: 'story-b', worldFrame: 'fictional' }); await f.run();
  f.seed('event-4'); await f.run();
  assert.equal(f.calls.length, 0);
});

for (const fault of ['candidate', 'evidence', 'changed-source', 'coverage']) test(`invalid event match is atomic and retryable: ${fault}`, async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  const next = f.seed('event-2');
  f.setDecision(({ memory, candidates }) => {
    if (fault === 'changed-source') f.database.prepare('UPDATE source_records SET content = ? WHERE id = ?').run('已修改的证据', memory.sources[0].id);
    return { memoryId: fault === 'coverage' ? 'omitted-event' : memory.id, resolution: 'matched',
      candidateId: fault === 'candidate' ? 'unavailable' : candidates[0].id, relation: 'completes',
      evidenceSourceIds: fault === 'evidence' ? ['unrelated-source'] : [memory.sources[0].id, candidates[0].sources[0].id], rationale: '测试结果校验。' };
  });
  const result = await f.run();
  assert.equal(result.failed.length, 1);
  if (fault === 'changed-source') assert.match(result.failed[0].error_message, /evidence changed/);
  assert.equal(f.repository.getMemory(next.id).canonical_key, next.canonical_key);
  assert.equal(f.repository.getMemory(next.id).metadata.eventContinuity, undefined);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM memory_edges WHERE provenance = 'event-continuity-v1'").get().n, 0);
});

test('one batch resolves a chain in storage order and uses one matching call', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) f.seed(`event-${i}`, { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-3', 'event-1', 'event-2'] });
  const result = await f.run();
  assert.equal(result.failed.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(new Set([1, 2, 3].map(i => f.repository.getMemory(`event-${i}`).canonical_key)).size, 1);
});

test('a late-arriving account can reference an already stored event with a later knowledge date', async t => {
  const f = fixture(t);
  f.seed('event-9'); await f.run();
  f.seed('event-1');
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.calls.length, 1);
  assert.equal(f.repository.getMemory('event-9').canonical_key, f.repository.getMemory('event-1').canonical_key);
});

test('retrying an older event carries its already linked descendants into the resolved identity', async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  f.seed('event-2');
  f.setDecision(() => { throw new Error('temporary outage'); });
  assert.equal((await f.run()).failed.length, 1);
  f.seed('event-3');
  f.setDecision(({ memory, candidates }) => {
    const target = candidates.find(candidate => candidate.id === (memory.id === 'event-3' ? 'event-2' : 'event-1'));
    return { memoryId: memory.id, resolution: 'matched', candidateId: target.id, relation: 'same_thread',
      evidenceSourceIds: [memory.sources[0].id, target.sources[0].id], rationale: '同一事项的进展。' };
  });
  await f.run();
  assert.equal(f.repository.getMemory('event-3').canonical_key, f.repository.getMemory('event-2').canonical_key);
  f.database.prepare("UPDATE memory_maintenance_tasks SET available_at = '2000-01-01' WHERE task_type = 'event-continuity' AND status = 'pending'").run();
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(new Set([1, 2, 3].map(i => f.repository.getMemory(`event-${i}`).canonical_key)).size, 1);
});

test('embedding-only follow-ups do not schedule event analysis', t => {
  const f = fixture(t);
  f.seed('event-1', { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-1'],
    followUpTaskTypes: ['memory-embedding'], planConsolidation: false });
  assert.deepEqual(f.repository.listMaintenanceTasks('owner').map(task => task.task_type), ['memory-embedding']);
});

test('retracted historical evidence is excluded from event candidates', async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  f.database.prepare("UPDATE source_records SET lifecycle = 'retracted'").run();
  f.seed('event-2');
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.calls.length, 0);
});

test('event input overflow partitions complete events and reuses already prepared embeddings', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) f.seed(`event-${i}`, { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-1', 'event-2', 'event-3'] });
  f.generator.assertRequestBudget = request => {
    if (JSON.parse(request.input).events.length > 1) throw Object.assign(new Error('input budget'), { code: 'MEMORY_STATE_ANALYSIS_INPUT_TOO_LARGE' });
  };
  const report = await f.run();
  assert.equal(report.failed.length, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.embeddings.length, 3);
  assert.equal(new Set([1, 2, 3].map(i => f.repository.getMemory(`event-${i}`).canonical_key)).size, 1);
  await f.run();
  assert.equal(f.calls.length, 2);
});

test('an indivisible event request retains evidence and stops before provider invocation', async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  const next = f.seed('event-2');
  f.generator.assertRequestBudget = () => { throw Object.assign(new Error('complete material too large'), { code: 'MEMORY_STATE_ANALYSIS_INPUT_TOO_LARGE' }); };
  const result = await f.run();
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].status, 'failed');
  assert.equal(result.failed[0].review_state, 'pending');
  assert.equal(f.calls.length, 0);
  assert.equal(f.repository.getMemory(next.id).content, next.content);
  assert.equal((await f.run()).failed.length, 0);
});
