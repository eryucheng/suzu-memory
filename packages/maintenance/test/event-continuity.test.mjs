import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryRepository, openMemoryDatabase, resolveEventContinuityReview, withEventSourceExecution } from '@suzu-memory/core';
import { prepareEventContinuity, applyEventContinuity } from '@suzu-memory/analysis';
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
    memorySourceIds: [memory.sources[0].id], candidateSourceIds: [candidates[0].sources[0].id], rationale: '原文明确完成此前约定的同一件事情。' });
  const generator = async request => {
    calls.push(request);
    assertMemoryTaskRequest(request);
    const input = JSON.parse(request.input), byId = new Map(input.memories.map(memory => [memory.id, memory]));
    const output = { matches: input.events.map(({ memoryId, candidateIds }) => decide({
      memory: byId.get(memoryId), candidates: candidateIds.map(id => byId.get(id)), request, input,
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
  const run = (options = {}) => runEventContinuityMaintenance({ repository, agentId: 'owner', generator, embeddingProvider, ...options });
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
    memorySourceIds: [], candidateSourceIds: [], rationale: '仅主题相同，无法认定同一具体事项。' }));
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

for (const fault of ['changed-source', 'coverage']) test(`stale evidence and incomplete coverage cannot partially apply: ${fault}`, async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  const next = f.seed('event-2');
  f.setDecision(({ memory, candidates }) => {
    if (fault === 'changed-source') f.database.prepare('UPDATE source_records SET content = ? WHERE id = ?').run('已修改的证据', memory.sources[0].id);
    return { memoryId: fault === 'coverage' ? 'omitted-event' : memory.id, resolution: 'matched',
      candidateId: candidates[0].id, relation: 'completes',
      memorySourceIds: [memory.sources[0].id], candidateSourceIds: [candidates[0].sources[0].id], rationale: '测试结果校验。' };
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
  for (const event of input.events) {
    assert.deepEqual(Object.keys(event), ['memoryId', 'candidateIds']);
    assert.deepEqual(new Set(event.candidateIds), new Set([...original.keys()].filter(id => id !== event.memoryId)));
  }
});

for (const reciprocal of [false, true]) test(`same-batch forward references share one event identity without repeated execution (reciprocal=${reciprocal})`, async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  f.seed('event-2', { queue: false }); f.seed('event-3', { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-2', 'event-3'] });
  f.setDecision(({ memory, candidates }) => {
    if (memory.id === 'event-3' && !reciprocal) return { memoryId: memory.id, resolution: 'new', candidateId: '',
      relation: '', memorySourceIds: [], candidateSourceIds: [], rationale: '本条为同一事件的起点。' };
    const target = candidates.find(candidate => candidate.id === (memory.id === 'event-2' ? 'event-3' : 'event-2'));
    assert.ok(target, 'A same-batch event in the shared materials remains selectable.');
    return { memoryId: memory.id, resolution: 'matched', candidateId: target.id, relation: 'same_thread',
      memorySourceIds: [memory.sources[0].id], candidateSourceIds: [target.sources[0].id], rationale: '两条原文描述同一件具体事情。' };
  });
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.repository.getMemory('event-2').canonical_key, f.repository.getMemory('event-3').canonical_key);
  assert.notEqual(f.repository.getMemory('event-1').canonical_key, f.repository.getMemory('event-2').canonical_key);
  assert.equal(f.calls.length, 1);
  await f.run();
  assert.equal(f.calls.length, 1);
});

test('sharing materials never binds a match across incompatible fictional worlds, including repair', async t => {
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
        memorySourceIds: [byId.get(memoryId).sources[0].id], candidateSourceIds: [byId.get('event-3').sources[0].id], rationale: '越过世界范围的错误判断。' })) } };
    } });
  assert.equal(result.failed.length, 0);
  assert.equal(f.repository.getMemory('event-2').metadata.eventContinuity.resolution, 'ambiguous');
  assert.equal(f.repository.getMemory('event-4').metadata.eventContinuity.resolution, 'matched');
  const edges = f.database.prepare("SELECT from_memory_id, to_memory_id FROM memory_edges WHERE provenance = 'event-continuity-v1'").all();
  assert.ok(edges.length);
  for (const edge of edges) assert.equal(f.repository.getMemory(edge.from_memory_id).world_id, f.repository.getMemory(edge.to_memory_id).world_id);
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
  let calls = 0;
  const generator = async request => {
    calls++;
    const matches = JSON.parse(request.input).events.map(({ memoryId }) => ({ memoryId, resolution: 'new', candidateId: '',
      relation: '', memorySourceIds: [], candidateSourceIds: [], rationale: '独立事件。' }));
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
  assert.equal(result.failed[0].status, 'failed');
  assert.equal(result.failed[0].review_state, 'pending');
  await runEventContinuityMaintenance({ repository: f.repository, agentId: 'owner', generator, embeddingProvider: f.embeddingProvider });
  assert.equal(calls, 1, 'Deterministic coverage errors never repeat the entire model input.');
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
      memorySourceIds: [memory.sources[0].id], candidateSourceIds: [target.sources[0].id], rationale: '同一事项的进展。' };
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

function matched(memory, candidate) {
  return { memoryId: memory.id, resolution: 'matched', candidateId: candidate.id, relation: 'same_thread',
    memorySourceIds: [memory.sources[0].id], candidateSourceIds: [candidate.sources[0].id], rationale: '两端原文明示同一件具体事项。' };
}

for (const outcome of ['corrected', 'invalid', 'new', 'ambiguous']) test(`citation repair isolates one invalid decision and keeps four valid decisions: ${outcome}`, async t => {
  const f = fixture(t);
  for (let i = 1; i <= 6; i++) f.seed(`event-${i}`, { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: [1, 2, 3, 4, 5, 6].map(i => `event-${i}`) });
  f.setDecision(({ memory, candidates, input }) => {
    const match = matched(memory, candidates.find(candidate => candidate.id === 'event-1'));
    if (memory.id !== 'event-4') return match;
    if (input.validationErrors) {
      assert.deepEqual(input.events, [{ memoryId: 'event-4', candidateIds: ['event-1'], allowNew: false }]);
      assert.deepEqual(input.memories.map(memory => memory.id).sort(), ['event-1', 'event-4']);
      assert.equal(input.validationErrors[0].previousDecision.candidateId, 'event-1');
      assert.deepEqual(input.validationErrors[0].problems, ['candidateSourceIds:source-does-not-belong-to-its-endpoint']);
      if (outcome === 'new' || outcome === 'ambiguous') return { ...match, resolution: outcome, candidateId: '', relation: '',
        memorySourceIds: [], candidateSourceIds: [], rationale: '无法确认这两端属于同一件事。' };
      if (outcome === 'corrected') return match;
    }
    // A real failure pattern: the chosen candidate is B, but citations come from C.
    return { ...match, candidateSourceIds: [f.repository.getMemoryDetail('owner', 'event-3').sources[0].id] };
  });
  const result = await f.run();
  assert.equal(result.failed.length, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.embeddings.length, 6, 'Repair does not repeat embedding or candidate preparation.');
  const part = result.completed[0].result.eventContinuityProgress.parts[0].result;
  assert.deepEqual(part.repair, { requested: 1, repaired: ['corrected', 'ambiguous'].includes(outcome) ? 1 : 0,
    sentToReview: ['invalid', 'new'].includes(outcome) ? 1 : 0 });
  for (const id of ['event-2', 'event-3', 'event-5', 'event-6']) {
    const decision = f.repository.getMemory(id).metadata.eventContinuity;
    assert.equal(decision.resolution, 'matched');
    assert.equal(decision.targetMemoryId, 'event-1');
  }
  const decision = f.repository.getMemory('event-4').metadata.eventContinuity;
  assert.equal(decision.resolution, outcome === 'corrected' ? 'matched' : 'ambiguous');
  const reviews = f.repository.listMaintenanceTasks('owner').filter(task => task.task_type === 'event-continuity-review');
  assert.equal(reviews.length, outcome === 'corrected' ? 0 : 1);
  if (reviews.length) {
    assert.equal(reviews[0].review_state, 'pending');
    assert.deepEqual(new Set(reviews[0].payload.candidateIds), new Set(['event-1', 'event-2', 'event-3', 'event-5', 'event-6']));
    if (outcome !== 'ambiguous') assert.equal(reviews[0].result.diagnostics.origin, 'validation');
    assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM memory_edges WHERE from_memory_id='event-4' OR to_memory_id='event-4'").get().n, 0);
    runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-4'], batchId: 'review-pending' });
    await f.run();
    assert.equal(f.calls.length, 2, 'A pending review must not start automatic analysis again.');
    resolveEventContinuityReview(f.repository, { agentId: 'owner', taskId: reviews[0].id,
      action: outcome === 'new' ? 'dismiss' : 'accept', candidateMemoryId: 'event-1' });
    assert.equal(f.repository.getMemory('event-4').metadata.eventContinuity.resolution, outcome === 'new' ? 'new' : 'matched');
  }
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-4'], batchId: 'repeat' });
  await f.run();
  assert.equal(f.calls.length, 2, 'Completed or reviewed decisions never cause another whole-batch generation.');
});

test('an unavailable candidate can only be repaired using the original allowed candidates', async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run(); f.seed('event-2');
  f.setDecision(({ memory, candidates, input }) => {
    if (input.validationErrors) {
      assert.equal(input.events[0].allowNew, true);
      assert.deepEqual(input.events[0].candidateIds, ['event-1']);
      return matched(memory, candidates[0]);
    }
    return { ...matched(memory, candidates[0]), candidateId: 'unavailable' };
  });
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.calls.length, 2);
  assert.equal(f.repository.getMemory('event-2').metadata.eventContinuity.targetMemoryId, 'event-1');
});

test('a repair batch keeps its corrected decision when another repair still has invalid evidence', async t => {
  const f = fixture(t);
  for (let i = 1; i <= 4; i++) f.seed(`event-${i}`, { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-1', 'event-2', 'event-3', 'event-4'] });
  f.setDecision(({ memory, candidates, input }) => {
    const match = matched(memory, candidates.find(candidate => candidate.id === 'event-1'));
    if (input.validationErrors) {
      assert.deepEqual(input.events.map(event => event.memoryId), ['event-2', 'event-3']);
      assert.deepEqual(input.memories.map(memory => memory.id).sort(), ['event-1', 'event-2', 'event-3']);
    }
    return memory.id === 'event-3' || (memory.id === 'event-2' && !input.validationErrors)
      ? { ...match, candidateSourceIds: ['wrong-source'] } : match;
  });
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.calls.length, 2);
  for (const id of ['event-2', 'event-4']) assert.equal(f.repository.getMemory(id).metadata.eventContinuity.resolution, 'matched');
  assert.equal(f.repository.getMemory('event-3').metadata.eventContinuity.resolution, 'ambiguous');
  assert.equal(f.repository.listMaintenanceTasks('owner').filter(task => task.task_type === 'event-continuity-review').length, 1);
});

test('an invalid initial response schema enters review without repeating the whole input', async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run(); f.seed('event-2');
  f.setDecision(({ memory, candidates }) => ({ ...matched(memory, candidates[0]), memorySourceIds: undefined }));
  const result = await f.run();
  assert.equal(result.failed[0].status, 'failed');
  assert.equal(result.failed[0].review_state, 'pending');
  assert.equal(JSON.parse(result.failed[0].failure_history_json).at(-1).details.errorCode, 'MEMORY_TASK_SCHEMA_INVALID');
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.repository.getMemory('event-2').metadata.eventContinuity, undefined);
});

for (const phase of ['initial', 'repair']) test(`source changes during ${phase} abort all writes and never use stale repair evidence`, async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run();
  for (const id of ['event-2', 'event-3']) f.seed(id, { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-2', 'event-3'] });
  f.setDecision(({ memory, candidates, input }) => {
    if ((phase === 'repair') === Boolean(input.validationErrors)) {
      f.database.prepare('UPDATE source_records SET content=? WHERE id=?').run('已修改的原话', memory.sources[0].id);
    }
    const match = matched(memory, candidates[0]);
    return memory.id === 'event-2' && !input.validationErrors ? { ...match, candidateSourceIds: ['wrong-source'] } : match;
  });
  const result = await f.run();
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error_message, /evidence changed/);
  assert.equal(f.calls.length, phase === 'initial' ? 1 : 2);
  for (const id of ['event-2', 'event-3']) assert.equal(f.repository.getMemory(id).metadata.eventContinuity, undefined);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM memory_edges WHERE provenance='event-continuity-v1'").get().n, 0);
});

for (const failure of ['budget', 'transport', 'schema', 'coverage', 'swapped-endpoints']) test(`bounded repair retains valid decisions and leaves one review after ${failure}`, async t => {
  const f = fixture(t);
  for (let i = 1; i <= 3; i++) f.seed(`event-${i}`, { queue: false });
  runImmediateMemoryMaintenance({ repository: f.repository, agentId: 'owner', memoryIds: ['event-1', 'event-2', 'event-3'] });
  f.setDecision(({ memory, candidates, input }) => {
    const match = matched(memory, candidates.find(candidate => candidate.id === 'event-1'));
    return memory.id === 'event-2' && !input.validationErrors ? { ...match, candidateSourceIds: ['wrong-source'] } : match;
  });
  const generator = Object.assign(async request => {
    const input = JSON.parse(request.input);
    if (input.validationErrors) {
      if (failure === 'transport') throw new Error('temporary connection failure');
      if (failure === 'schema') throw Object.assign(new Error('invalid schema'), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
      if (failure === 'coverage') return { output: { matches: [] } };
      if (failure === 'swapped-endpoints') {
        const byId = new Map(input.memories.map(memory => [memory.id, memory]));
        const match = matched(byId.get('event-2'), byId.get('event-1'));
        return { output: { matches: [{ ...match, memorySourceIds: match.candidateSourceIds, candidateSourceIds: match.memorySourceIds }] } };
      }
    }
    return f.generator(request);
  }, { assertRequestBudget: request => {
    if (failure === 'budget' && JSON.parse(request.input).validationErrors) throw Object.assign(new Error('repair exceeds provider budget'), { code: 'MEMORY_STATE_ANALYSIS_INPUT_TOO_LARGE' });
  } });
  let providerCalls = 0;
  const counted = Object.assign(request => { providerCalls++; return generator(request); }, { assertRequestBudget: generator.assertRequestBudget });
  const result = await f.run({ generator: counted });
  assert.equal(result.failed.length, 0);
  assert.equal(providerCalls, failure === 'budget' ? 1 : 2);
  assert.equal(f.repository.getMemory('event-3').metadata.eventContinuity.resolution, 'matched');
  assert.equal(f.repository.getMemory('event-2').metadata.eventContinuity.resolution, 'ambiguous');
  const review = f.repository.listMaintenanceTasks('owner').find(task => task.task_type === 'event-continuity-review');
  assert.equal(review.review_state, 'pending');
  assert.equal(review.result.diagnostics.origin, 'validation');
  await f.run({ generator: counted });
  assert.equal(providerCalls, failure === 'budget' ? 1 : 2);
});

test('the configured character budget also bounds repair before another model call', async t => {
  const f = fixture(t);
  f.seed('event-1'); await f.run(); f.seed('event-2');
  f.setDecision(({ memory, candidates }) => ({ ...matched(memory, candidates[0]), candidateSourceIds: ['wrong-source'] }));
  const prepared = await prepareEventContinuity({ repository: f.repository, agentId: 'owner', memoryIds: ['event-2'],
    generator: f.generator, embeddingProvider: f.embeddingProvider });
  prepared.maximumRequestCharacters = prepared.request.input.length + prepared.request.systemPrompt.length + JSON.stringify(prepared.request.schema).length;
  const result = await applyEventContinuity({ repository: f.repository, agentId: 'owner', prepared, generator: f.generator });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(result.repair, { requested: 1, repaired: 0, sentToReview: 1 });
  const review = f.repository.getMaintenanceTask('owner', result.reviews[0].taskId);
  assert.match(review.result.diagnostics.repairError, /exceeds maximumRequestCharacters/);
});

for (const failedRepair of [false, true]) test(`usage includes both the original call and the ${failedRepair ? 'failed' : 'successful'} repair`, async t => {
  const f = fixture(t), root = mkdtempSync(join(tmpdir(), 'event-continuity-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  f.seed('event-1'); await f.run(); f.seed('event-2');
  f.setDecision(({ memory, candidates, input }) => ({ ...matched(memory, candidates[0]),
    ...(!input.validationErrors ? { candidateSourceIds: ['wrong-source'] } : {}) }));
  const generator = async request => {
    const repair = Boolean(JSON.parse(request.input).validationErrors);
    if (repair && failedRepair) throw Object.assign(new Error('repair failed'), { usage: { inputTokens: 70, outputTokens: 10, totalTokens: 80 }, model: 'test' });
    return { ...await f.generator(request), usage: { inputTokens: repair ? 70 : 100, outputTokens: 10, totalTokens: repair ? 80 : 110 } };
  };
  const ledger = join(root, 'usage.jsonl');
  assert.equal((await f.run({ generator, usageLedgerPath: ledger })).failed.length, 0);
  const events = readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(event => event.source === 'memory-analysis');
  assert.deepEqual(events.map(event => event.feature), ['event-continuity', 'event-continuity-repair']);
  assert.deepEqual(events.map(event => event.usage.totalTokens), [110, 80]);
});

test('cancellation during repair exits without applying decisions or creating a review', async t => {
  const f = fixture(t), controller = new AbortController();
  f.seed('event-1'); await f.run(); f.seed('event-2');
  f.setDecision(({ memory, candidates, input }) => {
    if (input.validationErrors) controller.abort(new Error('cancelled by host'));
    return { ...matched(memory, candidates[0]), candidateSourceIds: ['wrong-source'] };
  });
  await assert.rejects(withEventSourceExecution(f.repository, () => f.run(), { signal: controller.signal }), /cancelled by host/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.repository.getMemory('event-2').metadata.eventContinuity, undefined);
  assert.equal(f.repository.listMaintenanceTasks('owner').some(task => task.task_type === 'event-continuity-review'), false);
});
