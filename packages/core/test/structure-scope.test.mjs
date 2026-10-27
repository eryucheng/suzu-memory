import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase, proposeMemoryStructure,
  resolveMemoryStructureProposal, SCHEMA_VERSION } from '../src/index.mjs';

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

test('created topics and episodes inherit member scope through review and attachment', t => {
  const { repository, event, propose } = fixture(t);
  for (const kind of ['topic', 'episode']) {
    const members = ['first', 'second', 'later'].map(suffix => event(`${kind}-${suffix}`).id);
    const proposal = propose(kind, members.slice(0, 2));
    const result = repository.getMemory(proposal.result_memory_id);
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
  database.prepare('DELETE FROM schema_migrations WHERE version=?').run(SCHEMA_VERSION);
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
