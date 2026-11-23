import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncResource } from 'node:async_hooks';
import { DatabaseSync } from 'node:sqlite';
import { executionEventSourceView, withEventSourceExecution, eventSourceMaterial, proposeMemoryStructure, resolveMemoryStructureProposal } from '@suzu-memory/core';
import { createMemoryService } from '../src/index.mjs';
import { buildStructureSnapshot, buildRelationSnapshot, refreshStructureSummary } from '@suzu-memory/structurer';
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

test('scoped derived summaries progress through queued indexing and both retrieval executors', async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const { episode, topic } = memory.withRepository(repository => {
    const episode = proposeMemoryStructure(repository, { agentId, kind: 'episode', eventDate: '2026-09-06',
      title: 'Scoped visit', content: 'The two records describe a museum visit.', memberIds: [nodes[1].node.id, nodes[2].node.id] });
    const topic = proposeMemoryStructure(repository, { agentId, kind: 'topic', title: 'Museum topic',
      content: 'Museum discussions and the scoped visit.', memberIds: [episode.result_memory_id, nodes[1].node.id] });
    return { episode: episode.result_memory_id, topic: topic.result_memory_id };
  }, { sourceScope: scope(2) });
  const idsAt = upper => memory.withRepository(repository => executionEventSourceView(repository, agentId).memoryIds, { sourceScope: scope(upper) });
  for (const id of [episode, topic]) { assert.ok(idsAt(2).has(id)); assert.ok(!idsAt(1).has(id)); }
  const calls = [];
  const provider = Object.assign(async (text, context) => { calls.push(context); return { model: 'derived-vector', vector: [1,2,3] }; },
    { model: 'derived-vector', dimensions: 3 });
  await memory.runEmbeddingMaintenance({ sourceScope: scope(2), embeddingProvider: provider, maximumTasks: 100 });
  const indexed = memory.withRepository(repository => repository.listEmbeddings(agentId, provider.model).map(row => row.memory_id));
  for (const id of [episode, topic]) assert.ok(indexed.includes(id));
  assert.ok(calls.some(call => call.sourceMaterial.memoryIds.includes(topic)
    && call.sourceMaterial.eventSources.length === 2));
  for (const execution of ['inline', 'worker']) {
    const result = await memory.search('Museum topic', { sourceScope: scope(2), anchors: [topic], persistTrace: false,
      options: { execution, sqlPrefilterThreshold: 1 } });
    const record = result.records.find(row => row.memoryId === topic);
    assert.ok(record, execution);
    assert.deepEqual(record.eventSources.map(source => source.eventId).sort(), ['event-1', 'event-2']);
    const earlier = await memory.search('Museum topic', { sourceScope: scope(1), anchors: [topic], persistTrace: false,
      options: { execution, sqlPrefilterThreshold: 1 } });
    assert.ok(!earlier.records.some(row => [topic, episode].includes(row.memoryId)));
  }
});

for (const change of ['detach', 'delete']) test(`summary provenance survives ${change} until regeneration and refresh claims use current members`, async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const topic = memory.withRepository(repository => {
    const proposal = proposeMemoryStructure(repository, { agentId, kind: 'topic',
      title: 'Original topic', content: 'Summary includes information from all three records.',
      memberIds: [1,2,3].map(n => nodes[n].node.id) });
    resolveMemoryStructureProposal(repository, { agentId, proposalId: proposal.id, action: 'accept' });
    return proposal.result_memory_id;
  }, { sourceScope: scope(3) });
  if (change === 'detach') memory.withRepository(repository => repository.unlinkMemoryFromTopic({ agentId, memoryId: nodes[3].node.id, topicId: topic }));
  else memory.deleteMemory(nodes[3].node.id);
  const eligible = () => memory.withRepository(repository => executionEventSourceView(repository, agentId).memoryIds.has(topic), { sourceScope: scope(2) });
  assert.equal(eligible(), false, 'removing a membership must not launder a future summary into an earlier scope');
  const queued = tasks(memory).find(task => task.task_type === 'structure-summary' && task.payload.memoryIds.includes(topic));
  assert.ok(queued, 'Changing the contributing members must schedule a refresh at the mutation entry point.');
  const before = await memory.search('Original topic', { anchors: [topic], persistTrace: false });
  assert.ok(!before.records.some(record => record.memoryId === topic));
  let calls = 0;
  await memory.runSemanticMaintenance({ sourceScope: scope(2), processInputEvents: false, generator: null,
    structureGenerator: async request => {
      calls++;
      assert.equal(request.schemaName, 'memory-structure-summary-v1');
      assert.deepEqual(request.sourceMaterial.eventSources.map(source => source.eventId).sort(), ['event-1', 'event-2']);
      return { output: { title: 'Earlier topic', content: 'A summary of only the first two records.' } };
    } });
  assert.equal(calls, 1);
  assert.equal(tasks(memory).find(task => task.id === queued.id).status, 'completed');
  assert.equal(eligible(), true);
  assert.deepEqual(memory.getMemory(topic).memory.metadata.structureSummaryMaterial.memoryIds, [nodes[1].node.id, nodes[2].node.id].sort());
});

for (const dismissFailure of [false, true]) test(`stale summary availability follows the published version, failure dismissed ${dismissFailure}`, async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const summary = { title: 'Museum outings', content: 'The records describe visits to museums.' };
  const memberIds = [nodes[1].node.id, nodes[2].node.id];
  const topic = memory.withRepository(repository => {
    const proposal = proposeMemoryStructure(repository, { agentId, kind: 'topic', memberIds, ...summary });
    return resolveMemoryStructureProposal(repository, { agentId, proposalId: proposal.id, action: 'accept' }).memory.id;
  });
  const recalled = async () => (await memory.search(summary.title, { anchors: [topic], persistTrace: false }))
    .records.some(record => record.memoryId === topic);
  const run = structureGenerator => memory.runSemanticMaintenance({ sourceScope: scope(3), processInputEvents: false,
    generator: null, structureGenerator });
  assert.equal(await recalled(), true);
  memory.editMemory(memberIds[0], { content: 'Correction: the first museum visit was in the morning.' });
  await run(async request => {
    if (request.schemaName !== 'memory-structure-summary-v1') return { output: { proposals: [] } };
    throw Object.assign(new Error('Terminal summary provider limit.'), { code: 'MAX_TOKENS' });
  });
  const failed = tasks(memory).find(task => task.task_type === 'structure-summary' && task.status === 'failed');
  assert.ok(failed);
  assert.equal(await recalled(), false);
  if (dismissFailure) {
    memory.resolveHighLevelProposal('maintenance-failure', failed.id, { action: 'dismiss' });
    assert.equal(await recalled(), false, 'Closing the failed task cannot validate its old summary.');
  }
  memory.editMemory(memberIds[1], { content: 'Correction: the second museum visit was with Lin.' });
  let refreshes = 0;
  await run(async request => {
    if (request.schemaName !== 'memory-structure-summary-v1') return { output: { proposals: [] } };
    assert.match(request.input, /first museum visit was in the morning/);
    assert.match(request.input, /second museum visit was with Lin/);
    refreshes++;
    return { output: summary };
  });
  assert.equal(refreshes, 1);
  assert.equal(await recalled(), true, 'An identical summary recomputed from current members is a valid publication.');
});

test('attachment dismissal restores summary provenance and source clearing follows typed dependencies', async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const { topic, independent } = memory.withRepository(repository => {
    const proposal = proposeMemoryStructure(repository, { agentId, kind: 'topic', title: 'Earlier topic',
      content: 'A summary of the first two records.', memberIds: [nodes[1].node.id, nodes[2].node.id] });
    const topic = proposal.result_memory_id;
    const attachment = proposeMemoryStructure(repository, { agentId, operation: 'attach', kind: 'topic', targetMemoryId: topic,
      title: 'Later topic', content: 'The third record adds later information.', memberIds: [nodes[3].node.id] });
    resolveMemoryStructureProposal(repository, { agentId, proposalId: attachment.id, action: 'dismiss' });
    const independent = proposeMemoryStructure(repository, { agentId, kind: 'topic', title: 'Independent topic',
      content: 'Only the second and third records.', memberIds: [nodes[2].node.id, nodes[3].node.id] }).result_memory_id;
    repository.upsertEdge({ agentId, fromMemoryId: nodes[1].node.id, toMemoryId: independent,
      relation: 'related_to', weight: 0.5, confidence: 0.5 });
    repository.unlinkMemoryFromTopic({ agentId, memoryId: nodes[1].node.id, topicId: topic });
    return { topic, independent };
  });
  const material = memory.withRepository(repository => executionEventSourceView(repository, agentId).sourcesFor([topic]), { sourceScope: scope(2) });
  assert.deepEqual(material.map(source => source.eventId).sort(), ['event-1', 'event-2']);
  const cleared = memory.eraseEventSources({ id: 'summary-source-clear', scope: scope(3, [{ spaceId: 'direct-a', throughSequence: 1 }]) });
  assert.equal(cleared.complete, true);
  assert.equal(memory.getMemory(topic).memory.status, 'deleted', 'the stored summary still depended on the detached record');
  assert.equal(memory.getMemory(topic).memory.content, '');
  assert.equal(memory.getMemory(independent).memory.status, 'active', 'an association is not a provenance dependency');
});

test('withdrawing an attachment after a member edit keeps an obsolete summary out of recall', async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const { topicId, attachmentId } = memory.withRepository(repository => {
    const accept = proposal => resolveMemoryStructureProposal(repository, { agentId, proposalId: proposal.id, action: 'accept' });
    const topic = accept(proposeMemoryStructure(repository, { agentId, kind: 'topic', title: 'Museum topic',
      content: 'The first visit was in the afternoon.', memberIds: [nodes[1].node.id, nodes[2].node.id] })).memory;
    const attachment = accept(proposeMemoryStructure(repository, { agentId, operation: 'attach', kind: 'topic', targetMemoryId: topic.id,
      title: 'Museum topic', content: 'The first visit was in the afternoon and the third visit was yesterday.', memberIds: [nodes[3].node.id] }));
    return { topicId: topic.id, attachmentId: attachment.proposal.id };
  });
  memory.editMemory(nodes[1].node.id, { content: 'The first visit was in the morning.' });
  const run = content => memory.runSemanticMaintenance({ processInputEvents: false, generator: null, sourceScope: scope(3),
    structureGenerator: async request => ({ output: request.schemaName === 'memory-structure-summary-v1'
      ? { title: 'Museum topic', content } : { proposals: [] } }) });
  await run('The first visit was in the morning and the third visit was yesterday.');
  memory.resolveHighLevelProposal('structure', attachmentId, { action: 'dismiss' });
  const recall = () => memory.search('Museum topic', { anchors: [topicId], persistTrace: false });
  assert.ok(!(await recall()).records.some(record => record.memoryId === topicId));
  await run('The first visit was in the morning.');
  assert.ok((await recall()).records.some(record => record.memoryId === topicId));
  assert.equal(memory.getMemory(topicId).memory.content, 'The first visit was in the morning.');
});

test('organization summary versions support derived containers within a fixed source cutoff', async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const topic = memory.withRepository(repository => {
    const result = repository.upsertTopic({ agentId, content: 'Original summary.',
      reality: nodes[1].node.reality, worldId: nodes[1].node.world_id, worldFrame: nodes[1].node.world_frame });
    for (const n of [1, 2]) repository.linkMemoryToTopic({ agentId, memoryId: nodes[n].node.id, topicId: result.id });
    return result;
  });
  const result = await memory.withRepository(repository => refreshStructureSummary({ repository, agentId, memoryId: topic.id,
    generator: async request => {
      assert.equal(JSON.parse(request.input).members.length, 2);
      assert.ok(!request.input.includes('FUTURE_SOURCE_3'));
      return { output: { title: 'Current summary', content: 'Summary of the two eligible sources.' } };
    } }), { sourceScope: scope(2) });
  assert.equal(result.status, 'completed');
  assert.equal(memory.getMemory(topic.id).memory.content, 'Summary of the two eligible sources.');
});

test('a short incoming tail does not block maintenance of already archived evidence', async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const task = memory.withRepository(repository => repository.enqueueMaintenanceTask({ agentId, lane: 'semantic',
    taskType: 'structure-proposal', payload: { batchId: 'previous-archive', memoryIds: [nodes[1].node.id, nodes[2].node.id] } }));
  memory.appendEventSources({ scope: scope(4), events: [{ occurredAt: at, content: { text: 'A short new message.' },
    source: { version: 1, owner: 'product-events', recipientAgentId: agentId, eventId: 'event-4', commitSequence: 4,
      spaceId: 'direct-a', eventType: 'message.created', sender: { kind: 'local-user', id: 'user-a' }, topology: { kind: 'space' } } }] });
  const calls = [];
  const options = { sourceScope: scope(4), minimumStructureMemories: 2,
    chunkPolicy: { maximumCoreCharacters: 12000, maximumCoreMessages: 100, maximumContextCharacters: 12000,
      maximumRequestCharacters: 64000, flush: false },
    generator: async () => { throw new Error('An insufficient new batch must not invoke extraction.'); },
    structureGenerator: async request => { calls.push(request); return { output: { proposals: [] } }; } };
  const result = await memory.runSemanticMaintenance(options);
  assert.equal(result.inputBatches[0].status, 'waiting');
  assert.equal(tasks(memory).find(item => item.id === task.id).status, 'completed');
  assert.equal(memory.listInputEvents({ statuses: ['pending'] }).total, 1);
  assert.deepEqual(calls.map(request => request.schemaName).sort(),
    ['memory-relation-proposals-v2', 'memory-structure-proposals-v2']);
  assert.ok(calls.every(request => !request.input.includes('A short new message.')));
  await memory.runSemanticMaintenance(options);
  assert.equal(calls.length, 2, 'An unchanged queue makes no additional generation calls.');
});

for (const work of ['completed', 'deferred', 'short-input']) test(`idle scoped maintenance avoids historical material reads with ${work} work`, async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  const future = new Date(Date.now() + 86_400_000).toISOString();
  memory.withRepository(repository => {
    repository.database.prepare("UPDATE memory_maintenance_tasks SET status='completed'").run();
    repository.database.prepare("UPDATE memory_consolidation_runs SET status='completed'").run();
    if (work === 'deferred') {
      repository.enqueueMaintenanceTask({ agentId, lane: 'embedding', taskType: 'memory-embedding',
        payload: { memoryIds: [nodes[1].node.id], reason: 'deferred' }, availableAt: future });
      repository.enqueueMaintenanceTask({ agentId, lane: 'semantic', taskType: 'structure-proposal',
        payload: { memoryIds: [nodes[1].node.id], reason: 'deferred' }, availableAt: future });
      repository.recordConsolidationRun({ id: 'deferred-run', agentId, policyVersion: 'test',
        triggerIds: [nodes[1].node.id], inputHash: 'deferred-run', createdAt: future });
    }
  });
  if (work === 'short-input') memory.appendEventSources({ scope: scope(4), events: [{ occurredAt: at,
    content: { text: 'A short new message.' }, source: { version: 1, owner: 'product-events', recipientAgentId: agentId,
      eventId: 'short-tail', commitSequence: 4, spaceId: 'direct-a', eventType: 'message.created',
      sender: { kind: 'local-user', id: 'user-a' }, topology: { kind: 'space' } } }] });
  let historicalRows = 0, providerCalls = 0;
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    return new Proxy(statement, { get(target, key) {
      const value = target[key];
      if (key === 'all') return (...args) => {
        const result = value.apply(target, args);
        if (/FROM memory_input_events\b/u.test(sql)) historicalRows += result.filter(row => row.status === 'archived').length;
        else if (/FROM (?:source_records|memory_sources|memory_state_analysis_runs)\b/u.test(sql)) historicalRows += result.length;
        return result;
      };
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  };
  const provider = Object.assign(async () => { providerCalls++; throw new Error('Idle maintenance called a provider.'); },
    { model: 'test-vector', dimensions: 3 });
  try {
    const result = await memory.runMaintenance({ lane: 'all', sourceScope: scope(work === 'short-input' ? 4 : 3),
      chunkPolicy: { flush: work !== 'short-input', maximumCoreCharacters: 12_000 },
      generator: provider, structureGenerator: provider, embeddingProvider: provider });
    assert.equal(result.status, 'completed');
    assert.equal(result.semantic.inputBatches[0].reason, work === 'short-input' ? 'content-length' : 'no-pending-events');
    assert.equal(providerCalls, 0);
    assert.equal(historicalRows, 0, 'No pending work requires loading archived input or provenance collections.');
  } finally { DatabaseSync.prototype.prepare = prepare; }
  if (work === 'deferred') {
    assert.equal(tasks(memory).filter(task => task.status === 'pending').length, 2);
    assert.equal(memory.withRepository(repository => repository.getConsolidationRun(agentId, 'deferred-run')).status, 'planned');
  }
  memory.withRepository(repository => {
    assert.throws(() => repository.listStateAnalysisRequests('other-agent', { statuses: ['pending'] }),
      { code: 'EVENT_SOURCE_AGENT_CONFLICT' });
    assert.throws(() => repository.claimMaintenanceTasks({ agentId: 'other-agent', lane: 'semantic' }),
      { code: 'EVENT_SOURCE_AGENT_CONFLICT' });
    assert.throws(() => repository.listInputEvents('other-agent'), { code: 'EVENT_SOURCE_AGENT_CONFLICT' });
  }, { sourceScope: scope(work === 'short-input' ? 4 : 3) });
});

test('structure continuation material respects the selected source cutoff at both endpoints and evidence', async t => {
  const { memory, dataRoot, nodes } = await fixture();
  t.after(async () => { await memory.close(); fs.rmSync(dataRoot, { recursive: true, force: true }); });
  memory.withRepository(repository => {
    repository.bindEventContinuity({ agentId, memoryId: nodes[2].node.id, candidateId: nodes[1].node.id,
      resolution: 'matched', relation: 'completes', contentHash: 'completion', rationale: '同一事件完成。',
      evidenceSourceIds: [nodes[1].source.id, nodes[2].source.id] });
    repository.bindEventContinuity({ agentId, memoryId: nodes[3].node.id, candidateId: nodes[2].node.id,
      resolution: 'matched', relation: 'same_thread', contentHash: 'future', rationale: '后续记录。',
      evidenceSourceIds: [nodes[2].source.id, nodes[3].source.id] });
  });
  const selected = Object.values(nodes).map(item => item.node.id);
  const snapshot = memory.withRepository(repository => buildStructureSnapshot({ repository, agentId, memoryIds: selected }), { sourceScope: scope(2) });
  assert.deepEqual(snapshot.eventContinuity.groups, [[nodes[1].node.id, nodes[2].node.id].sort()]);
  assert.ok(!JSON.stringify(snapshot).includes(nodes[3].node.id));

  memory.withRepository(repository => repository.bindEventContinuity({ agentId, memoryId: nodes[2].node.id, candidateId: nodes[1].node.id,
    resolution: 'matched', relation: 'completes', contentHash: 'later-evidence', rationale: '判定依赖后续证据。',
    evidenceSourceIds: [nodes[1].source.id, nodes[2].source.id, nodes[3].source.id] }));
  const historical = memory.withRepository(repository => buildStructureSnapshot({ repository, agentId, memoryIds: selected }), { sourceScope: scope(2) });
  assert.deepEqual(historical.eventContinuity?.groups || [], []);
  const complete = memory.withRepository(repository => buildStructureSnapshot({ repository, agentId, memoryIds: selected }), { sourceScope: scope(3) });
  assert.deepEqual(complete.eventContinuity.groups, [selected.sort()]);
});

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
      if (request.schemaName === 'memory-structure-proposals-v2') calls.push(request);
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
  const unbound = { content: { text: 'UNTRACKED_SOURCE' }, occurredAt: at, actor: { role: 'user', id: 'user-a' } };
  let request;
  const result = await memory.processPendingEvents({ maximumEvents: 3, sourceScope: scope(), previousContextEvents: [future, unbound],
    generator: async value => { request = value; return { output: { memories: [] } }; } });
  assert.equal(result.eventsProcessed, 1); assert.equal(request.input.includes('FUTURE_SOURCE'), false);
  assert.doesNotMatch(request.input, /UNTRACKED_SOURCE/);
  assert.deepEqual(request.sourceMaterial.eventSources.map(source => source.eventId), ['event-1']);
  assert.equal(request.sourceMaterial.inputEventIds.length, 1);
  assert.equal(memory.listInputEvents({ statuses: ['pending'] }).total, 2);
});

test('cancellation fences late embedding writes and leaves the original lease for expiry recovery', async () => {
  const { memory } = await fixture();
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
  memory.withRepository(repository => repository.recordStateAnalysisRun({
    agentId, stateFamily: 'goal', analyzerRole: 'lifecycle', subjectRole: 'user', subjectKey: 'user-a',
    canonicalKey: 'goal:visit', promptVersion: 'fixture', schemaVersion: 'fixture', inputHash: 'fixture',
    status: 'completed', memoryIds: [nodes[1].node.id], sourceIds: [nodes[1].source.id],
    sourceMaterial: eventSourceMaterial(repository, agentId, [nodes[1].node.id], [nodes[1].source.id]),
  }), { sourceScope: scope() });
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
