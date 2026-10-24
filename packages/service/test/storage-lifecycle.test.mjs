import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRepository, openMemoryDatabase, ensureCompanionRelationshipStructure } from '@suzu-memory/core';
import { MemoryService } from '../src/index.mjs';
import { runImmediateMemoryMaintenance, runEventContinuityMaintenance } from '@suzu-memory/maintenance';

function fixture(t, resolution = 'matched') {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const service = Object.assign(Object.create(MemoryService.prototype), { paths: { agentId: 'owner' }, withRepository: callback => callback(repository) });
  const embeddingProvider = Object.assign(async () => ({ model: 'test', vector: [1, 0] }), { model: 'test', dimensions: 2 });
  let calls = 0;
  const generator = async request => {
    calls++;
    const input = JSON.parse(request.input), byId = new Map(input.memories.map(memory => [memory.id, memory]));
    return { output: { matches: input.events.map(({ memoryId }) => {
      const memory = byId.get(memoryId), candidates = input.memories.filter(candidate => candidate.id !== memoryId);
      return {
        memoryId: memory.id, resolution, candidateId: resolution === 'matched' ? candidates[0].id : '',
        relation: resolution === 'matched' ? 'completes' : '', rationale: '对照原始材料判断具体事件。',
        evidenceSourceIds: resolution === 'matched' ? [memory.sources[0].id, candidates[0].sources[0].id] : [],
      };
    }) } };
  };
  const run = () => runEventContinuityMaintenance({repository, agentId: 'owner', generator, embeddingProvider});
  function seed(id, content, actorRoles = [{ role: 'participant', actorRole: 'agent', actorKey: 'owner' },
    { role: 'participant', actorRole: 'other', actorKey: 'friend', metadata: { actorName: '小明' } }]) {
    const memory = repository.upsertMemory({id, agentId: 'owner', kind: 'event', layer: 'episodic', content,
      reality: 'real', worldId: 'room', worldFrame: 'physical', subjectRole: 'agent', subjectKey: 'owner', actorRoles});
    const source = repository.upsertSource({agentId: 'owner', sourceKind: 'conversation', externalId: id, content});
    repository.linkSource(id, source.id);
    const maintenance = runImmediateMemoryMaintenance({repository, agentId: 'owner', memoryIds: [id], batchId: id});
    return {memory, source, maintenance};
  }
  return {repository, database, service, seed, run, setResolution: value => { resolution = value; }, calls: () => calls};
}

test('editing an event invalidates its affected chain, preserves unrelated links and requeues every affected decision', async t => {
  const f = fixture(t);
  f.seed('old', '我们约好整理书单。'); await f.run();
  f.seed('middle', '我们开始整理书单。'); await f.run();
  f.seed('last', '我们完成了书单。'); await f.run();
  f.repository.upsertEdge({ agentId: 'owner', fromMemoryId: 'old', toMemoryId: 'middle', relation: 'associated_with', provenance: 'human' });
  const original = f.repository.getMemoryDetail('owner', 'middle');
  const enqueue = f.repository.enqueueMaintenanceTask.bind(f.repository);
  f.repository.enqueueMaintenanceTask = () => { throw new Error('queue unavailable'); };
  assert.throws(() => f.service.editMemory('middle', {content: '人工更正：这是另一件事，我独自修好了自行车。'}), /queue unavailable/);
  assert.deepEqual(f.repository.getMemoryDetail('owner', 'middle'), original, 'Failed requeue rolls back both content and dependent graph edits.');
  f.repository.enqueueMaintenanceTask = enqueue;
  const edited = f.service.editMemory('middle', {content: '人工更正：这是另一件事，我独自修好了自行车。'});
  assert.equal(edited.metadata.eventContinuity, undefined);
  assert.equal(f.repository.getMemory('last').metadata.eventContinuity, undefined);
  assert.notEqual(edited.canonical_key, f.repository.getMemory('old').canonical_key);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM memory_edges WHERE provenance='event-continuity-v1'").get().n, 0);
  assert.equal(f.database.prepare("SELECT COUNT(*) AS n FROM memory_edges WHERE provenance='human'").get().n, 1);
  const task = f.repository.listMaintenanceTasks('owner', {statuses: ['pending'], taskTypes: ['event-continuity']});
  assert.deepEqual(new Set(task.flatMap(item => item.payload.memoryIds)), new Set(['middle', 'last']));
  f.setResolution('new');
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(new Set(['old', 'middle', 'last'].map(id => f.repository.getMemory(id).canonical_key)).size, 3);
  const calls = f.calls(); await f.run(); assert.equal(f.calls(), calls);
});

test('importance-only edits retain event identity without calling the matcher again', async t => {
  const f = fixture(t); f.seed('old', '整理书单。'); await f.run(); f.seed('new', '完成书单。'); await f.run();
  const before = f.repository.getMemory('new');
  const edited = f.service.editMemory('new', { importance: 0.9 });
  assert.deepEqual(edited.metadata.eventContinuity, before.metadata.eventContinuity);
  assert.equal(edited.maintenance.queued.some(task => task.taskType === 'event-continuity'), false);
});

test('returning an edited event to earlier text creates a fresh actionable review', async t => {
  const f = fixture(t, 'ambiguous');
  f.seed('old', '整理书单。'); await f.run(); f.seed('new', '完成书单。'); await f.run();
  const original = f.service.listHighLevelProposals().items[0].id;
  f.service.editMemory('new', {content: '完成另一份书单。'}); await f.run();
  f.service.editMemory('new', {content: '完成书单。'}); await f.run();
  const reviews = f.service.listHighLevelProposals().items;
  assert.equal(reviews.length, 1);
  assert.notEqual(reviews[0].id, original);
  f.service.resolveHighLevelProposal('event-continuity', reviews[0].id, {action: 'accept', candidateMemoryId: 'old'});
  assert.equal(f.repository.getMemory('old').canonical_key, f.repository.getMemory('new').canonical_key);
});

for (const resolution of ['matched', 'ambiguous']) test(`deleting an event invalidates its ${resolution} dependents and restore queues fresh analysis`, async t => {
  const f = fixture(t, resolution);
  f.seed('old', '整理书单。'); await f.run(); f.seed('new', '完成书单。'); await f.run();
  const reviewId = f.service.listHighLevelProposals().items[0]?.id;
  const original = f.repository.getMemoryDetail('owner', 'old');
  const enqueue = f.repository.enqueueMaintenanceTask.bind(f.repository);
  f.repository.enqueueMaintenanceTask = () => { throw new Error('queue unavailable'); };
  assert.throws(() => f.service.deleteMemory('old'), /queue unavailable/);
  assert.deepEqual(f.repository.getMemoryDetail('owner', 'old'), original);
  f.repository.enqueueMaintenanceTask = enqueue;
  const deleted = f.service.deleteMemory('old');
  assert.deepEqual(deleted.maintenance.queued.map(task => task.taskType), ['event-continuity']);
  assert.equal(f.repository.getMemory('old').status, 'deleted');
  assert.equal(f.repository.getMemory('new').metadata.eventContinuity, undefined);
  assert.equal(f.service.listHighLevelProposals().total, 0);
  if (reviewId) assert.throws(() => f.service.resolveHighLevelProposal('event-continuity', reviewId,
    {action: 'accept', candidateMemoryId: 'old'}), /awaiting review/);
  assert.notEqual(f.repository.getMemory('old').canonical_key, f.repository.getMemory('new').canonical_key);
  f.repository.enqueueMaintenanceTask = () => { throw new Error('queue unavailable'); };
  assert.throws(() => f.service.restoreMemory('old'), /queue unavailable/);
  assert.equal(f.repository.getMemory('old').status, 'deleted');
  f.repository.enqueueMaintenanceTask = enqueue;
  f.service.restoreMemory('old');
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.repository.getMemory('old').status, 'active');
  assert.equal(f.repository.getMemory('new').metadata.eventContinuity.resolution, resolution);
});

test('maintenance after deletion cannot reuse the removed event as an association candidate', async t => {
  const f = fixture(t);
  f.seed('old', '整理书单。'); await f.run(); f.seed('new', '完成书单。'); await f.run();
  f.service.deleteMemory('old');
  const calls = f.calls();
  assert.equal((await f.run()).failed.length, 0);
  assert.equal(f.calls(), calls, 'Without any remaining older event no model call is needed.');
  assert.equal(f.repository.getMemory('new').metadata.eventContinuity.resolution, 'new');
  assert.equal(f.repository.getMemory('old').status, 'deleted');
  assert.equal(f.repository.listMemoryRelationships('old').length, 0);
});

for (const action of ['accept', 'dismiss']) test(`uncertain event association has one selectable review and can ${action} without another model call`, async t => {
  const f = fixture(t, 'ambiguous'); f.seed('old', '整理书单。'); await f.run(); f.seed('new', '那份书单完成了。'); await f.run();
  const reviews = f.service.listHighLevelProposals();
  assert.equal(reviews.total, 1); assert.equal(reviews.items[0].type, 'event-continuity');
  const id = reviews.items[0].id;
  const detail = f.service.getReviewConsoleProposal('event-continuity', id);
  assert.deepEqual(detail.eventContinuity.candidates.map(memory => memory.id), ['old']);
  assert.equal(detail.permissions.canAccept, true);
  assert.throws(() => f.service.resolveHighLevelProposal('event-continuity', id, {action: 'accept', candidateMemoryId: 'not-a-candidate'}), /reviewed candidates/);
  const calls = f.calls();
  f.service.resolveHighLevelProposal('event-continuity', id, {action, candidateMemoryId: 'old'});
  assert.equal(f.calls(), calls); assert.equal(f.service.listHighLevelProposals().total, 0);
  assert.equal(f.repository.getMemory('new').canonical_key === f.repository.getMemory('old').canonical_key, action === 'accept');
  assert.equal(f.repository.getMemory('new').content, '那份书单完成了。');
  assert.throws(() => f.service.resolveHighLevelProposal('event-continuity', id, {action, candidateMemoryId: 'old'}), /awaiting review/);
  if (action === 'accept') {
    f.service.editMemory('old', { content: '更正：那次实际是修自行车。' });
    assert.notEqual(f.repository.getMemory('new').canonical_key, f.repository.getMemory('old').canonical_key);
  }
});

test('editing a review candidate expires the old review instead of accepting stale evidence', async t => {
  const f = fixture(t, 'ambiguous'); f.seed('old', '整理书单。'); await f.run(); f.seed('new', '完成书单。'); await f.run();
  const id = f.service.listHighLevelProposals().items[0].id;
  f.service.editMemory('old', { content: '更正为修自行车。' });
  assert.equal(f.service.getHighLevelProposal('event-continuity', id).proposal.review_state, 'dismissed');
  assert.throws(() => f.service.resolveHighLevelProposal('event-continuity', id, {action: 'accept', candidateMemoryId: 'old'}), /awaiting review/);
  assert.equal(f.repository.getMemory('new').metadata.eventContinuity, undefined);
  const queued = f.repository.listMaintenanceTasks('owner', {statuses: ['pending'], taskTypes: ['event-continuity']});
  assert.deepEqual(new Set(queued.flatMap(task => task.payload.memoryIds)), new Set(['old', 'new']));
  assert.equal((await f.run()).failed.length, 0);
  const replacement = f.service.listHighLevelProposals().items;
  assert.equal(replacement.length, 1);
  assert.notEqual(replacement[0].id, id);
});

test('human-approved events enter both association and accumulated organization, atomically with approval', t => {
  const f = fixture(t);
  const source = f.repository.upsertSource({agentId: 'owner', sourceKind: 'conversation', externalId: 'review', content: '我整理完书单。'});
  const decision = f.repository.recordIngestionDecision({ agentId: 'owner', batchId: 'human-review', candidateIndex: 0,
    decision: 'review', resultStatus: 'review', sourceIds: [source.id], candidate: {
      kind: 'event', title: '整理书单', content: source.content, subjectRole: 'agent', subjectKey: 'owner',
      reality: 'real', evidenceMode: 'explicit', temporalState: 'historical', revisionAction: 'add',
      eventDate: '2026-09-23', eventStart: '2026-09-23T08:00:00Z', stateFamily: 'not_applicable',
      confidence: 0.9, importance: 0.7, retentionReason: 'significant_event',
    } });
  const enqueue = f.repository.enqueueMaintenanceTask.bind(f.repository);
  f.repository.enqueueMaintenanceTask = () => { throw new Error('queue unavailable'); };
  assert.throws(() => f.service.resolveHighLevelProposal('ingestion', decision.id, {action: 'accept'}), /queue unavailable/);
  assert.equal(f.repository.getIngestionDecision('owner', decision.id).review_state, 'pending');
  f.repository.enqueueMaintenanceTask = enqueue;
  const accepted = f.service.resolveHighLevelProposal('ingestion', decision.id, {action: 'accept'});
  assert.deepEqual(new Set(accepted.maintenance.queued.map(task => task.taskType)), new Set(['memory-embedding', 'event-continuity', 'structure-proposal']));
});

test('a group-only Agent creates participant containers once and never includes an observer', t => {
  const f = fixture(t);
  ensureCompanionRelationshipStructure({repository: f.repository, agentId: 'owner', createPrimaryRelationship: false});
  const roles = ['owner', 'friend', 'third', 'observer'].map((actorKey, index) => ({actorRole: index === 0 ? 'agent' : 'other', actorKey,
    role: actorKey === 'observer' ? 'observer' : 'participant', metadata: {actorName: actorKey === 'owner' ? '自己' : '同名角色'} }));
  f.seed('first', '我们三人一起完成书单。', roles);
  f.seed('second', '我们三人又去整理工具。', [...roles].reverse());
  const relationships = f.repository.listRelationships('owner');
  assert.equal(relationships.length, 1); assert.equal(relationships[0].kind, 'group');
  assert.equal(relationships[0].members.length, 3);
  assert.equal(f.repository.listMemoryRelationships('first').length, 1);
  assert.equal(f.repository.listMemoryRelationships('second')[0].relationship_id, relationships[0].id);
});
