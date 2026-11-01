import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncResource } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { executionEventSourceView, withEventSourceExecution } from '@suzu-memory/core';
import { createMemoryService } from '../src/index.mjs';
import { buildStructureSnapshot, buildRelationSnapshot } from '@suzu-memory/structurer';
import { buildPreferenceEvidenceSnapshot } from '@suzu-memory/analysis';

const agentId = 'maintenance-agent';
const at = '2026-09-06T00:00:00.000Z';
const scope = (upper = 1, clears = []) => ({ owner: 'product-events', agentId, eventUpperBound: upper, clears });
async function fixture({ archive = true } = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-maintenance-'));
  const memory = createMemoryService({ dataRoot, agentId, defaults: { primaryUserId: 'user-a', userName: 'User', memoryOwner: 'A' } });
  memory.appendEventSources({ scope: scope(3), events: [1, 2, 3].map(n => ({ occurredAt: at, content: { text: `${n === 1 ? 'VALID' : 'FUTURE'}_SOURCE_${n}` },
    source: { version: 1, owner: 'product-events', recipientAgentId: agentId, eventId: `event-${n}`, commitSequence: n, spaceId: 'direct-a',
      eventType: 'message.created', sender: { kind: 'local-user', id: 'user-a' }, topology: { kind: 'space' } } })) });
  if (!archive) return { memory, dataRoot };
  for (let n = 1; n <= 3; n++) await memory.processPendingEvents({ maximumEvents: 1, memoriesOverride: [] });
  const utterances = memory.listMemories({ kinds: ['utterance'] }).items.sort((a, b) => a.content.localeCompare(b.content));
  const nodes = memory.withRepository(repository => Object.fromEntries([1, 2, 3].map(n => {
    const utterance = utterances.find(node => node.content.endsWith(`_${n}`));
    const source = repository.getMemoryDetail(agentId, utterance.id).sources[0];
    const node = repository.upsertMemory({ id: `direct-${n}`, agentId, kind: 'event', layer: 'long_term', title: utterance.content,
      content: utterance.content, subjectRole: 'user', subjectKey: 'user-a', reality: 'real', evidenceMode: 'explicit', recordedAt: at, eventStart: at });
    repository.linkSource(node.id, source.id);
    return [n, { node, utterance, source }];
  })));
  return { memory, dataRoot, nodes };
}
const tasks = memory => memory.withRepository(repository => repository.listMaintenanceTasks(agentId, { limit: 500 }), { readOnly: true });

test('completed scopes do not leak through long-lived Host callbacks into later Memory work', async () => {
  const { memory } = await fixture();
  let resource;
  await memory.withRepository(async () => { resource = new AsyncResource('host-callback-fixture'); }, { sourceScope: scope() });
  memory.eraseEventSources({ id: 'scope-completed', scope: scope(3, [{ spaceId: 'direct-a', throughSequence: 1 }]) });
  const status = resource.runInAsyncScope(() => memory.managementStatus());
  assert.equal(status.status, 'ready');
  resource.emitDestroy();
});

test('scoped claims filter before LIMIT and preserve mixed or unknown-source tasks while eligible peers advance', async () => {
  const { memory, nodes } = await fixture();
  const queued = memory.withRepository(repository => {
    const mixed = repository.upsertMemory({ id: 'mixed', agentId, kind: 'event', layer: 'long_term', content: 'MIXED_BODY', subjectRole: 'user', subjectKey: 'user-a' });
    repository.linkSource(mixed.id, nodes[1].source.id); repository.linkSource(mixed.id, nodes[2].source.id);
    const unknown = repository.upsertMemory({ id: 'unknown', agentId, kind: 'event', layer: 'long_term', content: 'UNKNOWN_BODY' });
    return [nodes[2].node, mixed, unknown, nodes[1].node].map((node, i) => {
      const peer = repository.upsertMemory({ id: `${node.id}-peer`, agentId, kind: 'event', layer: 'episodic',
        content: node.content, eventStart: at });
      for (const source of repository.getMemoryDetail(agentId, node.id).sources) repository.linkSource(peer.id, source.id);
      return repository.enqueueMaintenanceTask({ agentId, lane: 'semantic', taskType: 'structure-proposal',
        priority: 100-i, payload: { batchId: `task-${i}`, memoryIds: [node.id, peer.id] } });
    });
  });
  await assert.rejects(memory.runSemanticMaintenance({ processInputEvents: false }), { code: 'EVENT_SOURCE_SCOPE_REQUIRED' });
  const calls = [];
  const options = { processInputEvents: false, maximumTasks: 1, minimumStructureMemories: 2,
    generator: null, retrievalContextGenerator: null,
    structureGenerator: async request => {
      if (request.schemaName === 'memory-structure-proposals-v1') calls.push(request);
      return { output: { proposals: [] } };
    } };
  await memory.runSemanticMaintenance({ ...options, sourceScope: scope() });
  assert.equal(calls.length, 1); assert.ok(calls[0].input.includes('VALID_SOURCE_1'));
  assert.equal(/FUTURE|UNKNOWN|MIXED/u.test(calls[0].input), false);
  assert.deepEqual(calls[0].sourceMaterial.eventSources.map(source => source.eventId), ['event-1']);
  assert.equal(tasks(memory).find(task => task.id === queued[3].id).status, 'completed');
  for (const task of queued.slice(0,3)) assert.equal(tasks(memory).find(row => row.id === task.id).attempt_count, 0);
  await memory.runSemanticMaintenance({ ...options, sourceScope: scope(2) });
  assert.equal(calls.length, 2); assert.ok(calls[1].input.includes('FUTURE_SOURCE_2'));
  assert.equal(tasks(memory).find(task => task.id === queued[0].id).status, 'completed');
});

test('snapshot graph traversal, explicit sources and utterance embedding context all honor the same scope', async () => {
  const { memory, nodes } = await fixture();
  memory.withRepository(repository => repository.upsertEdge({ agentId, fromMemoryId: nodes[1].utterance.id,
    toMemoryId: nodes[2].utterance.id, relation: 'followed_by', weight: 1, confidence: 1 }));
  const snapshots = memory.withRepository(repository => ({
    structure: buildStructureSnapshot({ repository, agentId, memoryIds: [nodes[1].node.id, nodes[2].node.id] }),
    relation: buildRelationSnapshot({ repository, agentId, memoryIds: [nodes[1].node.id, nodes[2].node.id] }),
    analysis: buildPreferenceEvidenceSnapshot({ repository, agentId, subjectRole: 'user', subjectKey: 'user-a', canonicalKey: 'user:preference:test',
      memoryIds: [nodes[1].node.id, nodes[2].node.id] }),
  }), { sourceScope: scope() });
  assert.equal(JSON.stringify(snapshots).includes('FUTURE_SOURCE'), false);
  const calls = [];
  const provider = Object.assign(async (text, context) => { calls.push({ text, context }); return { vector: [1,2,3], model: 'test-vector' }; }, { model: 'test-vector', dimensions: 3 });
  const result = await memory.syncEmbeddings({ embeddingProvider: provider, memoryIds: [nodes[1].utterance.id], sourceScope: scope() });
  assert.equal(result.added, 1); assert.equal(calls.length, 1); assert.equal(calls[0].text.includes('FUTURE_SOURCE'), false);
  assert.deepEqual(calls[0].context.sourceMaterial.eventSources.map(source => source.eventId), ['event-1']);
});

test('state selection defers an ineligible current state before the request limit', async () => {
  const { memory, nodes } = await fixture();
  memory.withRepository(repository => {
    const current = repository.upsertMemory({ id: 'future-current', agentId, kind: 'plan', layer: 'long_term', content: 'FUTURE_CURRENT',
      subjectRole: 'user', subjectKey: 'user-a', canonicalKey: 'goal:blocked', stateFamily: 'goal', representationLayer: 'reported',
      statePhase: 'active', temporalState: 'current', evidenceMode: 'explicit', recordedAt: at });
    repository.linkSource(current.id, nodes[2].source.id);
    for (const [index, key] of ['blocked', 'allowed'].entries()) repository.recordStateAnalysisRequest({ agentId, batchId: `batch-${key}`,
      candidateIndex: index, stateFamily: 'goal', subjectRole: 'user', subjectKey: 'user-a', canonicalKey: `goal:${key}`, targetLabel: key,
      representationLayer: 'reported', evidenceMode: 'explicit', memoryIds: [nodes[1].utterance.id], sourceIds: [nodes[1].source.id], createdAt: at });
  });
  const selected = memory.withRepository(repository => repository.listStateAnalysisRequests(agentId, { statuses: ['pending'], limit: 1 }), { sourceScope: scope() });
  assert.equal(selected.length, 1); assert.equal(selected[0].canonical_key, 'goal:allowed');
  assert.throws(() => memory.withRepository(repository => repository.getCurrentCanonicalMemory({ agentId, subjectRole: 'user', subjectKey: 'user-a',
    canonicalKey: 'goal:blocked', stateFamily: 'goal', representationLayer: 'reported' }), { sourceScope: scope() }), { code: 'EVENT_SOURCE_TASK_DEFERRED' });
});

test('extraction filters claims and uses canonical eligible context plus exact input provenance', async () => {
  const { memory } = await fixture({ archive: false });
  const future = memory.listInputEvents().items.find(row => row.metadata.eventSource.eventId === 'event-2');
  let request;
  const result = await memory.processPendingEvents({ maximumEvents: 3, sourceScope: scope(), previousContextEvents: [future],
    generator: async value => { request = value; return { output: { memories: [] } }; } });
  assert.equal(result.eventsProcessed, 1); assert.equal(request.input.includes('FUTURE_SOURCE'), false);
  assert.deepEqual(request.sourceMaterial.eventSources.map(source => source.eventId), ['event-1']);
  assert.equal(request.sourceMaterial.inputEventIds.length, 1);
  assert.equal(memory.listInputEvents({ statuses: ['pending'] }).total, 2);
});

test('cancellation fences late embedding writes and leaves the original lease for expiry recovery', async () => {
  const { memory, nodes } = await fixture();
  const begun = Promise.withResolvers(), release = Promise.withResolvers();
  const provider = Object.assign(async () => { begun.resolve(); await release.promise; return { model: 'cancel-vector', vector: [1,2,3] }; },
    { model: 'cancel-vector', dimensions: 3 });
  const controller = new AbortController();
  const running = memory.runEmbeddingMaintenance({ sourceScope: scope(), signal: controller.signal, embeddingProvider: provider });
  const rejected = assert.rejects(running, { name: 'AbortError' });
  await begun.promise; controller.abort(); release.resolve(); await rejected;
  const active = tasks(memory).filter(task => task.status === 'running');
  assert.ok(active.length > 0); assert.ok(active.every(task => task.attempt_count === 1 && task.lease_owner));
  const vectors = memory.withRepository(repository => repository.listEmbeddings(agentId, 'cancel-vector'), { readOnly: true });
  assert.equal(vectors.length, 0);
  const recovered = memory.recoverRunningMaintenance({ now: new Date(Date.now() + 3600000) });
  assert.equal(recovered.tasks.requeued, active.length);
  assert.ok(tasks(memory).filter(task => active.some(row => row.id === task.id)).every(task => task.status === 'pending' && !task.lease_owner));
});

// Verify the fixed source snapshot is reused, but never outlives writes or scope changes.
test('source views reuse unchanged reads and invalidate for local writes, external writes and nested scopes', async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  let collections = 0, rows = 0;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    return new Proxy(statement, { get(target, key) {
      const value = target[key];
      if (key === 'all') return (...args) => {
        const result = value.apply(target, args);
        if (/FROM (?:memory_input_events|source_records|memory_sources link|memory_state_analysis_runs|memory_state_evidence_observations observation)/u.test(sql)) {
          collections += 1; rows += result.length;
        }
        return result;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  try {
    memory.withRepository(repository => {
      const first = executionEventSourceView(repository, agentId);
      const initial = { collections, rows };
      assert.ok(initial.collections > 0 && initial.rows > 0);
      assert.equal(executionEventSourceView(repository, agentId), first);
      assert.deepEqual({ collections, rows }, initial, 'No additional collections are read without a change.');
      assert.equal(first.memoryIds.has(nodes[2].node.id), false);
      repository.database.prepare('UPDATE memory_nodes SET title=? WHERE id=?').run('Local update', nodes[1].node.id);
      const local = executionEventSourceView(repository, agentId);
      assert.notEqual(local, first);
      const external = new DatabaseSync(memory.paths.databasePath);
      try { external.prepare('UPDATE memory_nodes SET title=? WHERE id=?').run('External update', nodes[1].node.id); }
      finally { external.close(); }
      const refreshed = executionEventSourceView(repository, agentId);
      assert.notEqual(refreshed, local);
      assert.equal(executionEventSourceView(repository, agentId), refreshed);
      withEventSourceExecution(repository, () => {
        const wider = executionEventSourceView(repository, agentId);
        assert.notEqual(wider, refreshed);
        assert.equal(wider.memoryIds.has(nodes[2].node.id), true);
      }, { sourceScope: scope(2) });
      const restored = executionEventSourceView(repository, agentId);
      assert.equal(restored.memoryIds.has(nodes[2].node.id), false);
      assert.equal(executionEventSourceView(repository, agentId), restored);
    }, { sourceScope: scope() });
  } finally { DatabaseSync.prototype.prepare = prepare; }
});
