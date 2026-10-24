import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { MemoryService, assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';
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
    const input = JSON.parse(request.input), byId = new Map(input.memories.map(memory => [memory.id, memory]));
    const output = { matches: input.events.map(({ memoryId }) => decide({
      memory: byId.get(memoryId), candidates: input.memories.filter(candidate => candidate.id !== memoryId),
    })) };
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

test('shared candidates are transmitted once with complete source evidence', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 5; i++) f.seed(`event-${i}`, { queue: false });
  const original = new Map([1, 2, 3, 4, 5].map(i => [`event-${i}`, f.repository.getMemoryDetail('owner', `event-${i}`)]));
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: [...original.keys()] });
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.calls.length, 1);
  const input = JSON.parse(f.calls[0].input), byId = new Map(input.memories.map(memory => [memory.id, memory]));
  assert.equal(input.memories.length, 5);
  assert.equal(byId.size, 5);
  assert.deepEqual(input.events.map(event => event.memoryId), ['event-2', 'event-3', 'event-4', 'event-5']);
  for (const [id, detail] of original) {
    assert.equal(byId.get(id).content, detail.memory.content);
    assert.deepEqual(byId.get(id).sources.map(source => [source.id, source.content]), detail.sources.map(source => [source.id, source.content]));
  }
  for (const event of input.events) assert.deepEqual(Object.keys(event), ['memoryId']);
});

for (const reciprocal of [false, true]) test(`same-batch forward references share one event identity without repeated execution (reciprocal=${reciprocal})`, async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  f.seed('event-2', { queue: false }); f.seed('event-3', { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-2', 'event-3'] });
  f.setDecision(({ memory, candidates }) => {
    if (memory.id === 'event-3' && !reciprocal) return { memoryId: memory.id, resolution: 'new', candidateId: '',
      relation: '', evidenceSourceIds: [], rationale: '本条为同一事件的起点。' };
    const target = candidates.find(candidate => candidate.id === (memory.id === 'event-2' ? 'event-3' : 'event-2'));
    assert.ok(target, 'A same-batch event in the shared materials remains selectable.');
    return { memoryId: memory.id, resolution: 'matched', candidateId: target.id, relation: 'same_thread',
      evidenceSourceIds: [memory.sources[0].id, target.sources[0].id], rationale: '两条原文描述同一件具体事情。' };
  });
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.repository.getMemory('event-2').canonical_key, f.repository.getMemory('event-3').canonical_key);
  assert.notEqual(f.repository.getMemory('event-1').canonical_key, f.repository.getMemory('event-2').canonical_key);
  assert.equal(f.calls.length, 1);
  await f.run();
  assert.equal(f.calls.length, 1);
});

test('sharing materials still rejects a match across incompatible fictional worlds', async t => {
  const f = fixture(t);
  for (const [id, worldId] of [['event-1', 'story-a'], ['event-2', 'story-a'], ['event-3', 'story-b'], ['event-4', 'story-b']]) {
    f.seed(id, { queue: false, reality: 'fictional', worldFrame: 'fictional', worldId });
  }
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-1', 'event-2', 'event-3', 'event-4'] });
  const result = await runEventContinuityMaintenance({ repository: f.repository, agentId: 'owner', embeddingProvider: f.embeddingProvider,
    generator: async request => {
      const input = JSON.parse(request.input), byId = new Map(input.memories.map(memory => [memory.id, memory]));
      assert.equal(byId.size, 4);
      return { output: { matches: input.events.map(({ memoryId }) => ({ memoryId, resolution: 'matched',
        candidateId: 'event-3', relation: 'same_thread',
        evidenceSourceIds: [byId.get(memoryId).sources[0].id, byId.get('event-3').sources[0].id], rationale: '越过世界范围的错误判断。' })) } };
    } });
  assert.equal(result.failed.length, 1);
  for (const id of ['event-1', 'event-2', 'event-3', 'event-4']) assert.equal(f.repository.getMemory(id).metadata.eventContinuity, undefined);
});

test('the service forwards its configured request limit without requiring a provider budget hook', async t => {
  const f = fixture(t), ids = [];
  for (let i = 1; i <= 20; i++) {
    const memory = f.seed(`event-${i}`, { queue: false });
    f.database.prepare('UPDATE memory_nodes SET content=? WHERE id=?').run(memory.content.repeat(60), memory.id);
    ids.push(memory.id);
  }
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ids });
  const limit = 28000;
  assert.equal(f.generator.assertRequestBudget, undefined);
  const service = new MemoryService({ agentId: 'owner', dataRoot: process.env.TEMP,
    defaults: { ingestion: { maximumRequestCharacters: limit } },
    providers: { generator: f.generator, embedding: f.embeddingProvider } });
  service.withRepository = callback => callback(f.repository);
  const result = await service.runSemanticMaintenance({ processInputEvents: false, structureGenerator: null, minimumStructureMemories: 100 });
  assert.equal(result.eventContinuity.failed.length, 0);
  assert.ok(f.calls.length > 1);
  const judged = [];
  for (const request of f.calls) {
    assert.ok(request.input.length + request.systemPrompt.length + JSON.stringify(request.schema).length <= limit);
    const input = JSON.parse(request.input);
    assert.equal(new Set(input.memories.map(memory => memory.id)).size, input.memories.length);
    judged.push(...input.events.map(event => event.memoryId));
    for (const memory of input.memories) assert.equal(memory.content, f.repository.getMemory(memory.id).content);
  }
  assert.deepEqual(new Set(judged), new Set(ids.slice(1)));
  assert.equal(judged.length, ids.length - 1);
});

for (const fault of ['missing', 'duplicate', 'unexpected']) test(`coverage diagnostics record ${fault} decisions without partially applying them`, async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  f.seed('event-2', { queue: false }); f.seed('event-3', { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-2', 'event-3'] });
  const generator = async request => {
    const matches = JSON.parse(request.input).events.map(({ memoryId }) => ({ memoryId, resolution: 'new', candidateId: '',
      relation: '', evidenceSourceIds: [], rationale: '独立事件。' }));
    if (fault === 'missing') matches.pop();
    if (fault === 'duplicate') matches[1] = matches[0];
    if (fault === 'unexpected') matches.push({ ...matches[0], memoryId: 'unrequested-event' });
    return { output: { matches } };
  };
  const result = await runEventContinuityMaintenance({ repository: f.repository, agentId: 'owner', generator, embeddingProvider: f.embeddingProvider });
  assert.equal(result.failed.length, 1);
  const failure = JSON.parse(result.failed[0].failure_history_json).at(-1).details;
  assert.equal(failure.errorCode, 'MEMORY_EVENT_CONTINUITY_COVERAGE');
  assert.equal(failure.providerDiagnostics.expectedCount, 2);
  assert.deepEqual(failure.providerDiagnostics.missingMemoryIds, fault === 'unexpected' ? [] : ['event-3']);
  assert.deepEqual(failure.providerDiagnostics.duplicateMemoryIds, fault === 'duplicate' ? ['event-2'] : []);
  assert.deepEqual(failure.providerDiagnostics.unexpectedMemoryIds, fault === 'unexpected' ? ['unrequested-event'] : []);
  for (const id of ['event-2', 'event-3']) assert.equal(f.repository.getMemory(id).metadata.eventContinuity, undefined);
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
