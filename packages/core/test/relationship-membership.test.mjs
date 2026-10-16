import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase, syncMemoryRelationshipMemberships, ensureCompanionRelationshipStructure } from '../src/index.mjs';

test('a shared subject does not imply the old primary human relationship', t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const structure = ensureCompanionRelationshipStructure({repository, agentId: 'owner'});
  repository.upsertMemory({id: 'unspecified-group', agentId: 'owner', kind: 'event', layer: 'episodic',
    content: '几个人一起完成了任务。', subjectRole: 'shared', subjectKey: 'unspecified-participants',
    worldId: 'relationship', worldFrame: 'relational'});
  syncMemoryRelationshipMemberships({repository, agentId: 'owner', memoryIds: ['unspecified-group']});
  assert.equal(repository.listMemoryRelationships('unspecified-group').length, 0);
  assert.ok(repository.getRelationship('owner', structure.relationship.id), 'Existing relationship data remains available.');
});

test('Agent pairs and groups use actual participants and exclude observers and other worlds', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const actors = ['owner', 'friend', 'human'].map(actorKey => ({ actorRole: actorKey === 'human' ? 'user' : 'agent', actorKey }));
  const entities = actors.map(actor => repository.ensureActorEntity({ agentId: 'owner', ...actor, displayName: actor.actorKey }).entity);
  function relationship(key, members, world = {}) {
    const result = repository.upsertRelationship({ agentId: 'owner', relationshipKey: key, kind: members.length === 2 ? 'dyad' : 'group',
      label: key, worldId: 'room', worldFrame: 'relational', ...world });
    members.forEach(i => repository.addRelationshipMember({ agentId: 'owner', relationshipId: result.id, entityId: entities[i].id,
      memberRole: actors[i].actorRole }));
    return result;
  }
  const pair = relationship('two-agents', [0, 1]);
  const group = relationship('three-people', [0, 1, 2]);
  relationship('fictional-pair', [0, 1], { worldId: 'story', worldFrame: 'fictional' });
  function memory(id, observer = false) {
    return repository.upsertMemory({ id, agentId: 'owner', kind: 'event', layer: 'episodic', content: '一起整理书单。',
      worldId: 'another-room', worldFrame: 'physical', actorRoles: actors.map((actor, i) => ({ ...actor,
        role: observer && i === 1 ? 'observer' : 'participant' })) });
  }
  const shared = memory('shared'), observed = memory('observed', true);
  const result = syncMemoryRelationshipMemberships({ repository, agentId: 'owner', memoryIds: [shared.id, observed.id] });
  assert.equal(result.linked, 4);
  const memberships = repository.listMemoryRelationships(shared.id).map(row => row.relationship_id);
  assert.ok(memberships.includes(pair.id) && memberships.includes(group.id));
  const observedRelationships = repository.listMemoryRelationships(observed.id);
  assert.equal(observedRelationships.length, 1);
  const observedMembers = repository.getRelationship('owner', observedRelationships[0].relationship_id).members;
  assert.deepEqual(new Set(observedMembers.map(member => member.entity_id)), new Set([entities[0].id, entities[2].id]));
  assert.equal(syncMemoryRelationshipMemberships({ repository, agentId: 'owner', memoryIds: [shared.id] }).linked, 0);
});

test('automatic participant containers reuse real spaces and isolate fictional worlds and other Agents', t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const roles = ['first', 'second'].map(actorKey => ({actorRole: 'agent', actorKey, role: 'participant'}));
  const seed = (id, agentId, reality, worldId, worldFrame) => {
    repository.upsertMemory({id, agentId, kind: 'event', layer: 'episodic', content: '两人一起完成任务。',
      reality, worldId, worldFrame, actorRoles: roles});
    syncMemoryRelationshipMemberships({repository, agentId, memoryIds: [id]});
    return repository.listMemoryRelationships(id)[0].relationship_id;
  };
  const real = seed('real-one', 'owner', 'real', 'room-a', 'physical');
  assert.equal(seed('real-two', 'owner', 'real', 'room-b', 'physical'), real);
  const story = seed('fiction-one', 'owner', 'fictional', 'story-a', 'fictional');
  assert.equal(seed('fiction-two', 'owner', 'fictional', 'story-a', 'fictional'), story);
  const otherStory = seed('fiction-three', 'owner', 'fictional', 'story-b', 'fictional');
  const otherAgent = seed('another-owner', 'another-agent', 'real', 'room-a', 'physical');
  assert.equal(new Set([real, story, otherStory, otherAgent]).size, 4);
  assert.equal(repository.listRelationships('owner').length, 3);
  assert.equal(repository.listRelationships('another-agent').length, 1);
});
