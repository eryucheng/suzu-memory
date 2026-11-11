import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase, proposeMemoryStructure,
  materializeMemoryStructureProposal, resolveMemoryStructureProposal, SCHEMA_VERSION } from '../src/index.mjs';

const scope = { reality: 'fictional', worldId: 'story-a', worldFrame: 'fictional' };
const differentScopes = [
  { ...scope, worldId: 'story-b' },
  { ...scope, worldFrame: 'hypothetical' },
  { ...scope, reality: 'hypothetical' },
];
function fixture(t, databasePath = ':memory:') {
  const database = openMemoryDatabase(databasePath);
  t.after(() => { if (database.isOpen) database.close(); });
  const repository = new MemoryRepository(database);
  const event = (id, overrides = {}) => repository.upsertMemory({ id, agentId: 'test',
    kind: 'event', layer: 'episodic', content: `${id}: outdoor activities and pottery.`,
    eventDate: '2026-10-20', ...scope, ...overrides });
  const propose = (kind, memberIds, overrides = {}) => proposeMemoryStructure(repository, {
    agentId: 'test', kind, title: 'Creative hobbies', content: 'Painting and pottery.',
    ...(kind === 'episode' ? { eventDate: '2026-10-20' } : {}), memberIds, ...overrides,
  });
  return { database, repository, event, propose };
}

test('summary updates persist with memberships, refresh search, invalidate vectors and restore on dismissal', t => {
  const {database, repository, event} = fixture(t);
  for (const kind of ['topic', 'episode']) for (const language of ['zh', 'en']) {
    const base = language === 'zh' ? '林正在准备徒步。' : 'Lin is preparing to hike.';
    const updated = language === 'zh' ? '林已完成徒步并回家。' : 'Lin completed the hike and returned home.';
    const prefix = `${kind}-${language}`;
    const members = ['first', 'second', 'later'].map(id => event(`${prefix}-${id}`));
    const proposal = proposeMemoryStructure(repository, {agentId: 'test', kind, title: 'Hiking', content: base,
      eventDate: kind === 'episode' ? '2026-10-20' : null, memberIds: members.slice(0,2).map(m => m.id)});
    const memory = repository.getMemory(proposal.result_memory_id);
    repository.upsertEmbedding({memoryId: memory.id, model: 'fixture', vector: [1,0], contentHash: 'old'});
    const attached = proposeMemoryStructure(repository, {agentId: 'test', operation: 'attach', kind,
      targetMemoryId: memory.id, content: updated, memberIds: [members[2].id]});
    const current = repository.getMemory(memory.id);
    assert.equal(current.content, updated);
    assert.equal(current.recorded_at, memory.recorded_at);
    assert.equal(current.evidence_mode, memory.evidence_mode);
    assert.equal(database.prepare('SELECT count(*) n FROM memory_embeddings WHERE memory_id=?').get(memory.id).n, 0);
    assert.equal(database.prepare('SELECT content FROM memory_fts WHERE memory_id=?').get(memory.id).content, updated);
    assert.ok(repository.listMaintenanceTasks('test', {taskTypes:['memory-embedding']}).some(task => task.payload.memoryIds.includes(memory.id)));
    assert.equal(repository.listContainerMembers({agentId:'test',containerId:memory.id,containerKind:kind,
      relation:kind === 'episode' ? 'part_of_episode' : 'supports_topic'}).length, 3);
    materializeMemoryStructureProposal(repository, {agentId:'test',proposalId:attached.id});
    assert.equal(repository.getMemory(memory.id).content, updated);
    const reverted = resolveMemoryStructureProposal(repository, {agentId:'test',proposalId:attached.id,action:'dismiss'});
    assert.equal(reverted.memory.content, base);
    assert.equal(database.prepare('SELECT content FROM memory_fts WHERE memory_id=?').get(memory.id).content, base);
  }
});

test('dismissal follows summary dependencies without resurrecting rejected content or overwriting manual edits', t => {
  const {repository, event} = fixture(t);
  const members = ['a','b','c','d','e'].map(id => event(id));
  const topic = repository.upsertTopic({agentId:'test',title:'Hiking',content:'Base summary.',...scope});
  repository.linkMemoryToTopic({agentId:'test',topicId:topic.id,memoryId:members[0].id});
  const add = (index, content) => proposeMemoryStructure(repository, {agentId:'test',operation:'attach',kind:'topic',
    targetMemoryId:topic.id,content,memberIds:[members[index].id]});
  const first = add(1, 'First added fact.');
  const second = add(2, 'First and second added facts.');
  resolveMemoryStructureProposal(repository,{agentId:'test',proposalId:first.id,action:'dismiss'});
  assert.equal(repository.getMemory(topic.id).content,'Base summary.');
  resolveMemoryStructureProposal(repository,{agentId:'test',proposalId:second.id,action:'dismiss'});
  assert.equal(repository.getMemory(topic.id).content,'Base summary.');
  const manual = add(3,'Generated summary.');
  repository.editMemoryManually({agentId:'test',memoryId:topic.id,patch:{content:'Manually edited summary.'}});
  resolveMemoryStructureProposal(repository,{agentId:'test',proposalId:manual.id,action:'dismiss'});
  assert.equal(repository.getMemory(topic.id).content,'Manually edited summary.');
  const later = add(4,'New generated summary based on the manual revision.');
  resolveMemoryStructureProposal(repository,{agentId:'test',proposalId:later.id,action:'dismiss'});
  assert.equal(repository.getMemory(topic.id).content,'Manually edited summary.');
});

test('a failed summary index update rolls back the proposal, membership and vector changes', t => {
  const {database, repository, event} = fixture(t);
  const member = event('member');
  const topic = repository.upsertTopic({agentId:'test',title:'Hiking',content:'Base summary.',...scope});
  repository.upsertEmbedding({memoryId:topic.id,model:'fixture',vector:[1,0]});
  const sync = repository.syncSearch;
  repository.syncSearch = () => {throw new Error('simulated index failure');};
  try {
    assert.throws(() => proposeMemoryStructure(repository,{agentId:'test',operation:'attach',kind:'topic',targetMemoryId:topic.id,
      memberIds:[member.id],content:'Updated summary.'}),/simulated index failure/);
  } finally {repository.syncSearch = sync;}
  assert.equal(repository.getMemory(topic.id).content,'Base summary.');
  assert.equal(repository.listTopicMembers({agentId:'test',topicId:topic.id}).length,0);
  assert.equal(repository.listStructureProposals('test').length,0);
  assert.equal(database.prepare('SELECT count(*) n FROM memory_embeddings WHERE memory_id=?').get(topic.id).n,1);
});

test('created topics and episodes inherit member scope through review and attachment', t => {
  const { repository, event, propose } = fixture(t);
  for (const kind of ['topic', 'episode']) {
    const members = ['first', 'second', 'later'].map(suffix => event(`${kind}-${suffix}`).id);
    const proposal = propose(kind, members.slice(0, 2));
    const result = repository.getMemory(proposal.result_memory_id);
    const embeddingTasks = () => repository.listMaintenanceTasks('test', { taskTypes: ['memory-embedding'] })
      .filter(task => task.payload.memoryIds.includes(result.id));
    assert.equal(embeddingTasks().length, 1, 'every structure creator must queue its embedding');
    materializeMemoryStructureProposal(repository, { agentId: 'test', proposalId: proposal.id });
    assert.equal(embeddingTasks().length, 1, 'already materialized structures must not queue duplicate work');
    assert.deepEqual([result.reality, result.world_id, result.world_frame],
      [scope.reality, scope.worldId, scope.worldFrame]);
    const reviewed = resolveMemoryStructureProposal(repository, { agentId: 'test',
      proposalId: proposal.id, action: 'accept' });
    assert.equal(reviewed.memory.world_id, scope.worldId);
    const attach = propose(kind, [members[2]], { operation: 'attach', targetMemoryId: result.id });
    assert.equal(attach.result_memory_id, result.id);
    assert.equal(repository.getMemory(result.id).world_frame, scope.worldFrame);
  }
});

test('Chinese and English containers inherit information time through creation and attachment', t => {
  const { repository, event, propose } = fixture(t);
  for (const kind of ['topic', 'episode']) for (const language of ['zh', 'en']) {
    const prefix = `${kind}-${language}`;
    const early = event(prefix + '-early', { content: language === 'zh' ? '参赛并认识朋友。' : 'Met friends at a tournament.',
      knownAt: '2022-06-01T08:00:00Z', recordedAt: '2026-10-01T08:00:00Z' });
    const recent = event(prefix + '-recent', { knownAt: '2022-06-03T08:00:00Z' });
    const older = event(prefix + '-older', { knownAt: '2022-05-01T08:00:00Z' });
    const newer = event(prefix + '-newer', { knownAt: '2022-07-01T08:00:00Z' });
    const proposal = propose(kind, [early.id, recent.id]);
    const memory = repository.getMemory(proposal.result_memory_id);
    assert.equal(memory.known_at, '2022-06-03T08:00:00.000Z');
    if (kind === 'episode') assert.equal(memory.event_date, '2026-10-20');
    assert.notEqual(memory.recorded_at, memory.known_at);
    resolveMemoryStructureProposal(repository, { agentId: 'test', proposalId: proposal.id, action: 'accept' });
    repository.database.prepare("UPDATE memory_nodes SET status='superseded' WHERE id=?").run(recent.id);
    for (const [member, expected] of [[older, memory.known_at], [newer, '2022-07-01T08:00:00.000Z']]) {
      const attached = propose(kind, [member.id], { operation: 'attach', targetMemoryId: memory.id });
      const after = repository.getMemory(attached.result_memory_id);
      assert.equal(after.known_at, expected);
      assert.equal(after.recorded_at, memory.recorded_at);
      assert.equal(after.content, memory.content);
      if (kind === 'episode') assert.equal(after.event_date, memory.event_date);
    }
  }
});

test('database upgrade repairs proven structure information times once and preserves edited records', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-structure-time-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'memory.db');
  const { database, repository, event, propose } = fixture(t, databasePath);
  event('early', { knownAt: '2022-06-01T08:00:00Z' });
  event('recent', { knownAt: '2022-06-03T08:00:00Z' });
  event('later', { knownAt: '2022-07-01T08:00:00Z' });
  const episode = propose('episode', ['early', 'recent']);
  const topic = propose('topic', [episode.result_memory_id, 'early']);
  resolveMemoryStructureProposal(repository, { agentId: 'test', proposalId: topic.id, action: 'accept' });
  propose('topic', ['later'], { operation: 'attach', targetMemoryId: topic.result_memory_id });
  const edited = propose('topic', ['early', 'recent'], { content: 'Edited container.' });
  repository.editMemoryManually({ agentId: 'test', memoryId: edited.result_memory_id, patch: { content: 'A human correction.' } });
  const explicit = propose('topic', ['early', 'recent'], { content: 'Explicit information time.' });
  const missing = propose('topic', ['early', 'recent'], { content: 'Missing member.' });
  const manual = repository.upsertTopic({ agentId: 'test', content: 'Manual.', ...scope,
    knownAt: '2024-01-01T00:00:00Z' });
  const legacyIds = [episode, topic, edited, missing].map(p => p.result_memory_id);
  database.prepare('UPDATE memory_nodes SET known_at=recorded_at WHERE id IN (SELECT value FROM json_each(?))')
    .run(JSON.stringify(legacyIds));
  database.prepare('UPDATE memory_structure_proposals SET member_ids_json=? WHERE id=?')
    .run(JSON.stringify(['early', 'absent']), missing.id);
  const before = database.prepare('SELECT * FROM memory_nodes ORDER BY id').all();
  database.prepare('DELETE FROM schema_migrations WHERE name=?').run('inherit-structure-information-time');
  database.close();
  const upgraded = openMemoryDatabase(databasePath);
  const after = upgraded.prepare('SELECT * FROM memory_nodes ORDER BY id').all();
  try {
    const expected = new Map([[episode.result_memory_id, '2022-06-03T08:00:00.000Z'],
      [topic.result_memory_id, '2022-07-01T08:00:00.000Z']]);
    for (const current of after) {
      const previous = before.find(n => n.id === current.id);
      if (expected.has(current.id)) {
        assert.equal(current.known_at, expected.get(current.id));
        assert.deepEqual({ ...current, known_at: previous.known_at, updated_at: previous.updated_at }, { ...previous });
      } else assert.deepEqual(current, previous);
    }
    assert.ok(after.some(n => n.id === manual.id));
    assert.ok(after.some(n => n.id === explicit.result_memory_id));
    assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { upgraded.close(); }
  const reopened = openMemoryDatabase(databasePath);
  try { assert.deepEqual(reopened.prepare('SELECT * FROM memory_nodes ORDER BY id').all(), after); }
  finally { reopened.close(); }
});

test('structure creation, attachment and direct membership reject mismatched scopes atomically', t => {
  const { database, repository, event, propose } = fixture(t);
  event('first'); event('second');
  for (const kind of ['topic', 'episode']) {
    const container = propose(kind, ['first', 'second']).result_memory_id;
    for (const [index, foreignScope] of differentScopes.entries()) {
      const foreign = event(`foreign-${kind}-${index}`, foreignScope);
      const counts = () => [database.prepare('SELECT count(*) n FROM memory_nodes').get().n,
        database.prepare('SELECT count(*) n FROM memory_structure_proposals').get().n,
        database.prepare('SELECT count(*) n FROM memory_edges').get().n];
      const before = counts();
      assert.throws(() => propose(kind, ['first', foreign.id]), /reality and world scope/u);
      assert.throws(() => propose(kind, [foreign.id], { operation: 'attach', targetMemoryId: container }),
        /reality and world scope/u);
      const link = kind === 'topic' ? 'linkMemoryToTopic' : 'linkMemoryToEpisode';
      assert.throws(() => repository[link]({ agentId: 'test', memoryId: foreign.id,
        [`${kind}Id`]: container }), /reality and world scope/u);
      if (kind === 'episode') assert.throws(() => repository.expandEpisodeToMemories({
        agentId: 'test', episodeId: container, memoryIds: [foreign.id] }), /reality and world scope/u);
      assert.deepEqual(counts(), before, 'Rejected operations leave no nodes, proposals or memberships.');
    }
  }
});

test('review rechecks member and result scopes after a proposal has been materialized', t => {
  const { database, repository, event, propose } = fixture(t);
  for (const kind of ['topic', 'episode']) {
    for (const changed of ['member', 'result']) {
      const members = ['first', 'second'].map(suffix => event(`${kind}-${changed}-${suffix}`).id);
      const proposal = propose(kind, members);
      database.prepare('UPDATE memory_nodes SET world_id=? WHERE id=?')
        .run('story-b', changed === 'member' ? members[1] : proposal.result_memory_id);
      assert.throws(() => resolveMemoryStructureProposal(repository, {
        agentId: 'test', proposalId: proposal.id, action: 'accept',
      }), /reality and world scope/u);
      assert.equal(repository.getStructureProposal('test', proposal.id).review_state, 'pending');
      assert.equal(repository.getMemory(proposal.result_memory_id).metadata.structureReviewState, 'pending');
    }
  }
});

test('database upgrade restores proven legacy structure scopes and preserves ambiguous and manual records', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-structure-scope-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const databasePath = path.join(directory, 'memory.db');
  const { database, repository, event, propose } = fixture(t, databasePath);
  event('first'); event('second'); event('third'); event('fourth');
  const episode = propose('episode', ['first', 'second']);
  resolveMemoryStructureProposal(repository, { agentId: 'test', proposalId: episode.id, action: 'accept' });
  const topic = propose('topic', [episode.result_memory_id, 'third']);
  propose('topic', ['fourth'], { operation: 'attach', targetMemoryId: topic.result_memory_id });
  event('ambiguous-foreign');
  const ambiguous = propose('topic', ['first', 'ambiguous-foreign'], { content: 'Ambiguous members.' });
  const attachedForeign = propose('topic', ['first', 'second'], { content: 'Changed attached member.' });
  event('attached-later');
  propose('topic', ['attached-later'], { operation: 'attach', targetMemoryId: attachedForeign.result_memory_id });
  const missing = propose('topic', ['first', 'second'], { content: 'Missing member.' });
  const explicit = propose('topic', ['first', 'second'], { content: 'Explicitly scoped result.' });
  const manual = repository.upsertTopic({ agentId: 'test', content: 'Manual container.', ...scope });
  repository.linkMemoryToTopic({ agentId: 'test', memoryId: 'first', topicId: manual.id });
  // Reproduce the v45 materializer's defaults without altering the source evidence.
  const legacyIds = [episode, topic, ambiguous, attachedForeign, missing].map(p => p.result_memory_id);
  database.prepare("UPDATE memory_nodes SET reality='real',world_id='primary',world_frame='unknown' WHERE id IN (SELECT value FROM json_each(?))")
    .run(JSON.stringify([...legacyIds, manual.id]));
  database.prepare('UPDATE memory_nodes SET world_id=? WHERE id IN (?,?)')
    .run('story-b', 'ambiguous-foreign', 'attached-later');
  database.prepare('UPDATE memory_structure_proposals SET member_ids_json=? WHERE id=?')
    .run(JSON.stringify(['first', 'absent']), missing.id);
  database.prepare("UPDATE memory_nodes SET world_id='explicit-world' WHERE id=?").run(explicit.result_memory_id);
  const preservedIds = [ambiguous, attachedForeign, missing, explicit].map(p => p.result_memory_id).concat(manual.id);
  const read = connection => connection.prepare('SELECT * FROM memory_nodes ORDER BY id').all();
  const before = read(database);
  const reviewStates = database.prepare('SELECT id,review_state FROM memory_structure_proposals ORDER BY id').all();
  database.prepare('DELETE FROM schema_migrations WHERE name=?').run('inherit-structure-world-scope');
  database.close();

  const upgraded = openMemoryDatabase(databasePath);
  try {
    const after = read(upgraded);
    for (const id of [episode.result_memory_id, topic.result_memory_id]) {
      const previous = before.find(n => n.id === id), current = after.find(n => n.id === id);
      assert.deepEqual([current.reality, current.world_id, current.world_frame],
        [scope.reality, scope.worldId, scope.worldFrame]);
      const unchanged = n => Object.fromEntries(Object.entries(n)
        .filter(([key]) => !['reality', 'world_id', 'world_frame', 'updated_at'].includes(key)));
      assert.deepEqual(unchanged(current), unchanged(previous));
    }
    for (const id of preservedIds) assert.deepEqual(after.find(n => n.id === id), before.find(n => n.id === id));
    assert.deepEqual(upgraded.prepare('SELECT id,review_state FROM memory_structure_proposals ORDER BY id').all(), reviewStates);
    assert.equal(upgraded.prepare('SELECT max(version) v FROM schema_migrations').get().v, SCHEMA_VERSION);
    assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
    const revision = upgraded.prepare("SELECT value FROM memory_meta WHERE key='retrieval-revision'").get().value;
    upgraded.close();
    const reopened = openMemoryDatabase(databasePath);
    try {
      assert.deepEqual(read(reopened), after, 'An already upgraded database is not rewritten again.');
      assert.equal(reopened.prepare("SELECT value FROM memory_meta WHERE key='retrieval-revision'").get().value, revision);
    } finally { reopened.close(); }
  } finally { if (upgraded.isOpen) upgraded.close(); }
});
