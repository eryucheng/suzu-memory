import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MemoryRepository,
  ensureCompanionRelationshipStructure,
  openMemoryDatabase,
  syncMemoryRelationshipMemberships,
} from "@suzu-memory/core";
import {
  createBrainSnapshot,
  layoutBrainGraph,
  nodeVisualProfile,
  relationVisualFamily,
} from "../src/index.mjs";

test('an empty memory graph starts with its owning Agent only, including legacy identity roots', () => {
  const database = openMemoryDatabase(':memory:');
  const repository = new MemoryRepository(database);
  ensureCompanionRelationshipStructure({ repository, agentId: 'owner', companionName: 'Suzu',
    primaryUserId: 'human', primaryUserName: '小夏' });
  const snapshot = createBrainSnapshot({ repository, agentId: 'owner' });
  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0].title, '我');
  assert.equal(snapshot.nodes[0].preview, 'Suzu');
  assert.equal(snapshot.nodes[0].actorKey, 'owner');
  assert.deepEqual(snapshot.nodes[0].position, { x: 0, y: 0, z: 0 });
  assert.deepEqual(snapshot.edges, []);
  database.close();
});

test('centering the owner keeps the layout version and every other cached position', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-owner-position-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cachePath = path.join(root, 'layout.json');
  const positions = { 'topology:agent': { x: .7, y: .2, z: -.1 }, event: { x: -.5, y: .2, z: .3 }, topic: { x: .4, y: -.3, z: .1 } };
  fs.writeFileSync(cachePath, JSON.stringify({ layoutVersion: 'brain-v7', positions }));
  const nodes = [{ id: 'topology:agent', graphNodeType: 'actor', actorRole: 'agent', isOwner: true },
    { id: 'event', kind: 'event' }, { id: 'topic', kind: 'topic' }];
  const first = layoutBrainGraph({ nodes, cachePath });
  assert.equal(first.layoutVersion, 'brain-v7');
  assert.deepEqual(first.positions['topology:agent'], { x: 0, y: 0, z: 0 });
  assert.deepEqual(first.positions.event, positions.event);
  assert.deepEqual(first.positions.topic, positions.topic);
  const second = layoutBrainGraph({ nodes: [...nodes, { id: 'new-memory', kind: 'event' }], cachePath });
  for (const node of nodes) assert.deepEqual(second.positions[node.id], first.positions[node.id]);
});

test('people connect to the owner and their own memories; shared events remain single nodes', () => {
  const database = openMemoryDatabase(':memory:');
  const repository = new MemoryRepository(database);
  const agentId = 'owner';
  ensureCompanionRelationshipStructure({ repository, agentId, companionName: 'Suzu', createPrimaryRelationship: false });
  for (const key of ['mio-one', 'mio-two', 'ren']) repository.ensureActorEntity({ agentId,
    actorRole: 'other', actorKey: key, displayName: key === 'ren' ? 'Ren' : 'Mio' });
  for (const [id, participants] of [['first', ['owner', 'mio-one']], ['second', ['mio-two', 'ren']], ['group', ['owner', 'mio-one', 'ren']]]) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: `${id}共同整理书单`,
      subjectRole: 'shared', subjectKey: `shared:${id}`, reality: 'real', worldFrame: 'physical',
      actorRoles: participants.map(key => ({ role: 'participant', actorRole: key === 'owner' ? 'agent' : 'other', actorKey: key })) });
  }
  repository.upsertMemoryRole({ agentId, memoryId: 'second', role: 'observer', actorRole: 'agent', actorKey: 'owner' });
  repository.upsertMemory({ id: 'unassigned', agentId, kind: 'event', layer: 'episodic', content: '没有人物证据的共同事件', subjectRole: 'shared', subjectKey: 'shared:unknown' });
  syncMemoryRelationshipMemberships({ repository, agentId, memoryIds: ['first', 'second', 'group'] });
  const snapshot = createBrainSnapshot({ repository, agentId });
  const relationships = snapshot.nodes.filter(node => node.graphNodeType === 'relationship');
  assert.equal(relationships.length, 0);
  assert.equal(repository.listRelationships(agentId).length, 3, 'Rendering preserves the recorded relationships.');
  const person = key => snapshot.nodes.find(node => node.actorKey === key).id;
  assert.notEqual(person('mio-one'), person('mio-two'));
  assert.ok(snapshot.edges.some(edge => edge.source === 'first' && edge.target === person('mio-one')));
  assert.ok(!snapshot.edges.some(edge => edge.source === 'first' && edge.target === person('mio-two')));
  const people = memory => snapshot.edges.filter(edge => edge.source === memory && edge.relation === 'about_subject').map(edge => edge.target);
  assert.deepEqual(new Set(people('second')), new Set([person('mio-two'), person('ren')]));
  assert.deepEqual(new Set(people('group')), new Set([person('owner'), person('mio-one'), person('ren')]));
  assert.equal(snapshot.nodes.filter(node => node.id === 'group').length, 1);
  for (const key of ['mio-one', 'mio-two', 'ren']) {
    assert.ok(snapshot.edges.some(edge => edge.source === person(key) && edge.target === person('owner') && edge.relation === 'remembered_by'));
  }
  assert.ok(snapshot.edges.some(edge => edge.source === 'second' && edge.target === person('owner') && edge.relation === 'observed_by'));
  assert.ok(!snapshot.edges.some(edge => edge.source === 'unassigned'), 'Unknown participants must not be guessed.');
  assert.ok(!snapshot.edges.some(edge => ['member_of_relationship', 'belongs_to_relationship'].includes(edge.relation)));
  assert.equal(new Set(snapshot.nodes.map(node => node.id)).size, snapshot.nodes.length);
  const ids = new Set(snapshot.nodes.map(node => node.id));
  assert.ok(snapshot.edges.every(edge => ids.has(edge.source) && ids.has(edge.target)));
  database.close();
});

test('confirmed identity aliases share one stable person node, including aliases of the owner', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-person-alias-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cachePath = path.join(root, 'layout.json');
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const agentId = 'owner';
  const owner = repository.ensureActorEntity({ agentId, actorRole: 'agent', actorKey: agentId, displayName: 'Suzu' });
  const friend = repository.ensureActorEntity({ agentId, actorRole: 'other', actorKey: 'panda-a', displayName: '熊猫' });
  repository.bindActorEntity({ agentId, actorRole: 'other', actorKey: 'panda-b', entityId: friend.entity.id });
  repository.bindActorEntity({ agentId, actorRole: 'other', actorKey: 'owner-alias', entityId: owner.entity.id });
  repository.ensureActorEntity({ agentId, actorRole: 'other', actorKey: 'different-panda', displayName: '熊猫' });
  const add = (id, actorKey) => repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic',
    content: id, subjectRole: 'other', subjectKey: actorKey });
  add('event-b', 'panda-b');
  add('event-owner', 'owner-alias');
  add('event-other', 'different-panda');
  const first = createBrainSnapshot({ repository, agentId, cachePath });
  const person = first.nodes.find(n => n.entityId === friend.entity.id);
  assert.equal(first.nodes.filter(n => n.graphNodeType === 'actor').length, 3);
  assert.equal(first.nodes.filter(n => n.title === '熊猫').length, 2, 'Names alone never merge people.');
  assert.equal(first.nodes.filter(n => n.entityId === owner.entity.id).length, 1);
  assert.ok(first.edges.some(e => e.source === 'event-owner' && e.target === 'topology:agent'));
  add('event-a', 'panda-a');
  const second = createBrainSnapshot({ repository, agentId, cachePath });
  assert.equal(second.nodes.filter(n => n.entityId === friend.entity.id).length, 1);
  for (const id of ['event-a', 'event-b']) {
    assert.ok(second.edges.some(e => e.source === id && e.target === person.id));
  }
  assert.equal(second.edges.filter(e => e.source === person.id && e.relation === 'remembered_by').length, 1);
  for (const node of first.nodes) assert.deepEqual(second.nodes.find(n => n.id === node.id).position, node.position);
});

test('multiple roles retain their edges but count one memory per person', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  repository.upsertMemory({ id: 'event', agentId: 'owner', kind: 'event', layer: 'episodic', content: '一起观察日食',
    subjectRole: 'other', subjectKey: 'friend', actorRoles: [
      { role: 'observer', actorRole: 'other', actorKey: 'friend' },
      { role: 'participant', actorRole: 'other', actorKey: 'friend' },
      { role: 'participant', actorRole: 'other', actorKey: 'another' },
    ] });
  const graph = createBrainSnapshot({ repository, agentId: 'owner' });
  const friend = graph.nodes.find(n => n.actorKey === 'friend');
  const another = graph.nodes.find(n => n.actorKey === 'another');
  const event = graph.nodes.find(n => n.id === 'event');
  assert.equal(friend.memberCount, 1);
  assert.equal(another.memberCount, 1);
  assert.deepEqual(new Set(event.containerIds), new Set([friend.id, another.id]));
  assert.equal(event.containerIds.length, 2);
  assert.deepEqual(new Set(graph.edges.filter(e => e.source === 'event' && e.target === friend.id).map(e => e.relation)),
    new Set(['observed_by', 'about_subject']));
});

test("builds a stable structured-memory brain snapshot without raw utterances", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-brain-layout-"));
  const cachePath = path.join(root, "brain-layout.json");
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "event-a",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "第一次见面",
    content: "第一次见面的事情。",
    eventDate: "2026-07-01",
  });
  repository.upsertMemory({
    id: "event-b",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "后来继续聊天",
    content: "后来继续聊了很久。",
    eventDate: "2026-07-02",
  });
  repository.upsertMemory({
    id: "utterance-a",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "原始对话不应常驻大脑视图。",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "event-a",
    toMemoryId: "event-b",
    relation: "timeline_next",
    weight: 0.9,
  });
  const first = createBrainSnapshot({
    repository,
    agentId: "agent-test",
    cachePath,
  });
  assert.deepEqual(first.nodes.map((node) => node.id), ["event-a", "event-b", "topology:agent"]);
  assert.equal(first.edges.length, 1);
  assert.equal(first.nodes[0].visualTier, "minor");
  assert.deepEqual(first.counts, {
    nodes: 3,
    edges: 1,
    major: 1,
    state: 0,
    minor: 2,
  });
  assert.equal(first.layout.created, 3);
  assert.equal(fs.existsSync(cachePath), true);
  const originalPosition = first.nodes[0].position;

  repository.upsertMemory({
    id: "event-c",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "新的关联事件",
    content: "新事件靠近已有的相关节点。",
    eventDate: "2026-07-03",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "event-b",
    toMemoryId: "event-c",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.9,
  });
  const second = createBrainSnapshot({
    repository,
    agentId: "agent-test",
    cachePath,
  });
  assert.equal(second.layout.reused, 3);
  assert.equal(second.layout.created, 1);
  assert.deepEqual(second.nodes.find((node) => node.id === "event-a").position, originalPosition);
  for (const node of second.nodes) {
    assert.equal(Number.isFinite(node.position.x), true);
    assert.equal(Number.isFinite(node.position.y), true);
    assert.equal(Number.isFinite(node.position.z), true);
  }
  database.close();
});

test("renders formal big neurons, state nodes, overlapping memberships, and all real edge families", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-brain-semantics-"));
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const event = repository.upsertMemory({
    id: "event-museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "参观科技馆",
    content: "用户参观了科技馆。",
    eventStart: "2026-07-11T03:00:00.000Z",
  });
  const episode = repository.upsertEpisode({
    id: "episode-weekend",
    agentId: "agent-test",
    title: "周末出行",
    content: "同一次周末出行中的连续经历。",
    eventStart: "2026-07-11T03:00:00.000Z",
    eventEnd: "2026-07-11T12:00:00.000Z",
  });
  const topic = repository.upsertTopic({
    id: "topic-science",
    agentId: "agent-test",
    title: "科学展览",
    content: "与科学展览有关的长期主题。",
  });
  const preference = repository.upsertMemory({
    id: "state-science-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    title: "喜欢科学展览",
    content: "用户喜欢科学展览。",
    subjectRole: "user",
    subjectKey: "user:owner",
    canonicalKey: "preference:science-exhibition",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-11T03:00:00.000Z",
  });
  repository.upsertMemory({
    id: "utterance-private",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "原始对话不进入大脑画面。",
  });
  repository.linkMemoryToEpisode({
    agentId: "agent-test",
    memoryId: event.id,
    episodeId: episode.id,
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: event.id,
    topicId: topic.id,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: preference.id,
    toMemoryId: event.id,
    relation: "established_from",
    weight: 0.86,
  });
  const snapshot = createBrainSnapshot({
    repository,
    agentId: "agent-test",
    cachePath: path.join(root, "brain-layout.json"),
  });

  assert.deepEqual(snapshot.counts, {
    nodes: 6,
    edges: 5,
    major: 4,
    state: 1,
    minor: 1,
  });
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  assert.equal(byId.get(episode.id).visualTier, "major");
  assert.equal(byId.get(episode.id).visualFamily, "episode");
  assert.equal(byId.get(topic.id).visualTier, "major");
  assert.equal(byId.get(topic.id).visualFamily, "topic");
  assert.equal(byId.get(preference.id).visualTier, "state");
  assert.equal(byId.get(preference.id).stateFamily, "preference");
  assert.equal(byId.get(event.id).visualTier, "minor");
  assert.deepEqual(new Set(byId.get(event.id).containerIds), new Set([episode.id, topic.id]));
  assert.equal(byId.get(episode.id).memberCount, 1);
  assert.equal(byId.get(topic.id).memberCount, 1);
  assert.equal(snapshot.nodes.some((node) => node.id === "utterance-private"), false);
  assert.deepEqual(
    new Set(snapshot.edges.map((edge) => edge.visualFamily)),
    new Set(["structural", "lifecycle", "actor"]),
  );
  for (const node of snapshot.nodes) {
    assert.equal(Number.isFinite(node.position.x), true);
    assert.equal(Number.isFinite(node.position.y), true);
    assert.equal(Number.isFinite(node.position.z), true);
  }
  assert.deepEqual(nodeVisualProfile({ kind: "topic" }), {
    visualTier: "major",
    visualFamily: "topic",
  });
  assert.equal(relationVisualFamily("causes"), "causal");
  assert.equal(relationVisualFamily("future-real-relation"), "associative");
  database.close();
});

test("connects each person by identity and only uses recorded relationship memberships", () => {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const identity = ensureCompanionRelationshipStructure({
    repository,
    agentId: "agent-test",
    primaryUserId: "user-primary",
    primaryUserName: "小夏",
    companionId: "agent-test",
    companionName: "Agent",
  });
  repository.upsertMemory({
    id: "user-memory",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    title: "我的工作",
    content: "用户的工作信息。",
    subjectRole: "user",
    subjectKey: "user-primary",
  });
  repository.upsertMemory({
    id: "agent-memory",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    title: "Agent 的偏好",
    content: "Agent 的偏好信息。",
    subjectRole: "agent",
    subjectKey: "agent-test",
  });
  repository.upsertMemory({
    id: "shared-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "共同经历",
    content: "双方共同经历的一件事。",
    subjectRole: "user",
    subjectKey: "user-primary",
  });
  repository.upsertMemoryRole({
    memoryId: "shared-memory",
    agentId: "agent-test",
    role: "participant",
    actorRole: "agent",
    actorKey: "agent-test",
  });
  repository.upsertMemory({
    id: "relationship-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "关系里的一件事",
    content: "这是一条直接归属共同关系的记忆。",
    subjectRole: "shared",
    subjectKey: "relationship",
  });

  syncMemoryRelationshipMemberships({ repository, agentId: 'agent-test', memoryIds: ['shared-memory'] });
  repository.linkMemoryToRelationship({ agentId: 'agent-test', memoryId: 'relationship-memory', relationshipId: identity.relationship.id });
  const snapshot = createBrainSnapshot({ repository, agentId: "agent-test" });
  const personId = 'topology:actor:user:user-primary';
  const topologyEdges = new Set(snapshot.edges.map((edge) => (
    `${edge.source}\u001f${edge.target}\u001f${edge.relation}`
  )));
  assert.equal(topologyEdges.has(`user-memory\u001f${personId}\u001fabout_subject`), true);
  assert.equal(topologyEdges.has("agent-memory\u001ftopology:agent\u001fabout_subject"), true);
  assert.equal(topologyEdges.has(`shared-memory\u001f${personId}\u001fabout_subject`), true);
  assert.equal(topologyEdges.has("shared-memory\u001ftopology:agent\u001fabout_subject"), true);
  assert.equal(topologyEdges.has(`relationship-memory\u001f${personId}\u001fabout_subject`), true);
  assert.equal(topologyEdges.has('relationship-memory\u001ftopology:agent\u001fabout_subject'), true);
  assert.equal(topologyEdges.has(`${personId}\u001ftopology:agent\u001fremembered_by`), true);
  const roots = new Map(snapshot.nodes.map((node) => [node.id, node]));
  assert.equal(roots.get(personId).title, '小夏');
  assert.equal(roots.get("topology:agent").visualTier, "major");
  assert.equal(snapshot.nodes.some(node => node.graphNodeType === 'relationship'), false);
  assert.equal(roots.get('topology:agent').title, '我');
  assert.deepEqual(roots.get('topology:agent').position, { x: 0, y: 0, z: 0 });
  database.close();
});
