import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryService } from '../src/index.mjs';

const agentId = 'agent-a';
const scope = { owner: 'test-events', agentId, eventUpperBound: 100, clears: [] };
const occurredAt = '2026-09-21T08:00:00.000Z';
function candidate(overrides = {}) {
  return { kind: 'event', title: '参观博物馆', content: 'Mio 今天参观了博物馆。', subjectRole: 'other', subjectName: 'Mio',
    actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: 'Mio', confidence: 1 }],
    canonicalKey: '', stateFamily: 'not_applicable', stateLabel: '',
    reality: 'real', evidenceMode: 'explicit', temporalState: 'historical', revisionAction: 'add', retentionReason: 'episodic_event',
    eventDate: '2026-09-21', eventStart: '', eventEnd: '', confidence: 0.95, importance: 0.5,
    sourceRefs: ['M0001'], ...overrides };
}
function event(id, senderId, name, text, extra = {}) {
  return { occurredAt, content: { text }, source: { version: 1, owner: scope.owner, recipientAgentId: agentId,
    eventId: `event-${id}`, commitSequence: id, spaceId: 'group-only', eventType: 'group.message',
    sender: { kind: 'agent', id: senderId, name }, topology: { kind: 'space', spaceKind: 'group' },
    contentHash: 'INTERNAL_HASH_NOT_MODEL_CONTEXT', sourceRunId: 'INTERNAL_RUN_NOT_MODEL_CONTEXT', ...extra } };
}
function fixture(t, defaults = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-extraction-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  return createMemoryService({ dataRoot, agentId, defaults: { memoryOwner: 'Suzu', primaryUserId: 'absent-human',
    userName: 'Absent Human', createPrimaryRelationship: false, ...defaults } });
}
async function process(memory, memories) {
  let request;
  const result = await memory.processPendingEvents({ sourceScope: scope, generator: async value => {
    request = value;
    return { output: { memories }, usage: {} };
  } });
  return { result, request };
}

test('named extraction preserves its narrative in storage, embeddings, presentation and recall', async t => {
  const memory = fixture(t, { primaryUserId: '', userName: '' });
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'Mio', '我想独自练习，请Suzu来看。')] });
  const title = 'Mio邀请Suzu看练习';
  const content = 'Mio请Suzu看练习。Mio说：“我想独自练习。”';
  const { request } = await process(memory, [candidate({ title, content })]);
  assert.match(request.systemPrompt, /叙述者不用“我”或“你”代替姓名/);
  const saved = memory.listMemories({ kinds: ['event'] }).items[0];
  assert.equal(saved.content, content);
  assert.equal(saved.title, title);
  const detail = memory.getMemory(saved.id);
  assert.equal(detail.memory.content, content, 'The editor receives the stored narrative.');
  assert.equal(detail.memory.title, title);
  assert.equal(detail.sources[0].content, '我想独自练习，请Suzu来看。');
  const graph = memory.brainSnapshot();
  assert.equal(graph.nodes.find(n => n.id === saved.id).preview, content);
  const calls = [];
  const embeddingProvider = async text => { calls.push(text); return { model: 'perspective-test', vector: new Float32Array([1, 0]), usage: {} }; };
  embeddingProvider.model = 'perspective-test';
  embeddingProvider.dimensions = 2;
  await memory.syncEmbeddings({ embeddingProvider, memoryIds: [saved.id], sourceScope: scope });
  assert.deepEqual(calls, [`标题：${title}\n内容：${content}`]);
  const recalled = await memory.search('Mio Suzu 练习', { sourceScope: scope, persistTrace: false,
    now: '2026-09-21T10:00:00Z', options: { heading: '我想起了：', guidance: '', maximumContextChars: 3000 } });
  assert.equal(recalled.status, 'ready');
  assert.match(recalled.context, /Mio请Suzu看练习/);
  assert.match(recalled.context, /Mio说：“我想独自练习。”/);
  assert.equal(memory.getMemory(saved.id).memory.content, content);
});

test('the service uses its retrieval timezone for extraction while retaining UTC source instants', async t => {
  const memory = fixture(t, { retrieval: { timeZone: 'America/Los_Angeles' } });
  const source = { ...event(1, 'agent-b', 'Mio', '今天聊了灯塔博物馆。'), occurredAt: '2026-08-04T03:30:00.000Z' };
  memory.appendEventSources({ scope, events: [source] });
  const { request } = await process(memory, []);
  assert.match(request.input, /America\/Los_Angeles/);
  assert.match(request.input, /2026-08-03T20:30:00\.000-07:00/);
  const utterances = memory.listMemories({ kinds: ['utterance'] }).items;
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].event_start, source.occurredAt);
  const recalled = await memory.search('昨天聊了灯塔博物馆', { sourceScope: scope,
    now: '2026-08-04T19:00:00Z', persistTrace: false });
  assert.equal(recalled.status, 'ready');
  assert.ok(recalled.candidates.some(candidate => candidate.memoryId === utterances[0].id));
});

test('legacy owner-only input preserves the absence of a human through extraction and archive', async t => {
  const memory = fixture(t, { primaryUserId: '', userName: '' });
  memory.appendEvents([{ protocolVersion: 1, eventId: 'owner-only', spaceId: agentId, eventType: 'conversation.turn',
    occurredAt, actor: { id: agentId, role: 'companion', name: 'Suzu' },
    participants: [{ id: agentId, role: 'companion', name: 'Suzu' }], content: { text: '我独自整理好了书单。' } }]);
  let input;
  await memory.processPendingEvents({ generator: async request => { input = request.input; return { output: { memories: [] } }; } });
  assert.doesNotMatch(input, /"role":"user"/);
  const utterances = memory.listMemories({ kinds: ['utterance'] }).items;
  assert.equal(utterances.length, 1);
  assert.ok(memory.getMemory(utterances[0].id).roles.every(role => role.actor_key === agentId));
});

test('unresolved names are evidence-scoped references instead of global person IDs', async t => {
  const memory = fixture(t, { primaryUserId: '', userName: '' });
  for (let index = 1; index <= 2; index++) {
    const text = `第 ${index} 组的小明整理好了书单。`;
    memory.appendEventSources({ scope, events: [event(index, `reporter-${index}`, `讲述者${index}`, text, { spaceId: `group-${index}` })] });
    await process(memory, [candidate({ subjectName: '小明', content: text, evidenceMode: 'observed',
      actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: '小明', confidence: 1 }] })]);
  }
  const nodes = memory.listMemories({ kinds: ['event'] }).items;
  assert.equal(nodes.length, 2);
  assert.equal(new Set(nodes.map(node => node.subject_key)).size, 2);
  for (const node of nodes) {
    assert.match(node.subject_key, /^unresolved-person-/);
    const actor = memory.getMemory(node.id).roles.find(role => role.role === 'experiencer');
    assert.equal(actor.actor_key, node.subject_key);
    assert.equal(actor.metadata.identityStatus, 'unresolved');
  }
});

test('human approval preserves distinct known people and the observing owner', async t => {
  const memory = fixture(t, { primaryUserId: '', userName: '' });
  memory.appendEventSources({ scope, events: [event(1, 'ren', 'Ren', '你好。'), event(2, 'mio', 'Mio', '我想和 Ren 再合作一次。')] });
  const { result } = await process(memory, [candidate({ kind: 'relationship', stateFamily: 'relationship',
    title: 'Mio 对 Ren 的信任', content: '我觉得 Mio 对 Ren 渐渐有了信任。',
    canonicalKey: 'trust-ren', stateLabel: '对 Ren 的信任', stateTarget: { counterpartRole: 'other', counterpartName: 'Ren' },
    evidenceMode: 'inferred', temporalState: 'current', retentionReason: 'relationship', sourceRefs: ['M0002'],
    actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: 'Mio', confidence: .9 },
      { role: 'participant', actorRole: 'other', actorName: 'Ren', confidence: .9 }] })]);
  const review = result.candidateResults[0];
  const before = memory.getMemory(review.provisionalMemoryId).roles;
  assert.ok(before.some(role => role.actor_key === 'ren'));
  const accepted = memory.resolveHighLevelProposal('ingestion', review.ingestionDecisionId, { action: 'accept' });
  assert.equal(accepted.resolution.status, 'accepted');
  const after = memory.getMemory(accepted.resolution.memory.id).roles;
  assert.ok(after.some(role => role.role === 'participant' && role.actor_key === 'ren'));
  assert.ok(after.some(role => role.role === 'experiencer' && role.actor_key === 'mio'));
  assert.ok(after.some(role => role.role === 'observer' && role.actor_key === agentId));
});

test('review retains known identities even when evidence alignment produces no provisional memory', async t => {
  const memory = fixture(t);
  memory.appendEventSources({ scope, events: [event(1, 'ren', 'Ren', 'Mio 今天参观了博物馆。'), event(2, 'mio', 'Mio', '你好。')] });
  const { result } = await process(memory, [candidate()]);
  const review = result.candidateResults[0];
  assert.ok(review.reasons.includes('explicit-memory-without-subject-source'));
  assert.equal(review.provisionalMemoryId, '');
  const accepted = memory.resolveHighLevelProposal('ingestion', review.ingestionDecisionId, { action: 'accept' });
  assert.equal(accepted.resolution.status, 'accepted');
  assert.equal(accepted.resolution.memory.subject_key, 'mio');
  assert.ok(memory.getMemory(accepted.resolution.memory.id).roles.some(role => role.actor_key === 'mio'));
});

test('ambiguous people can only be bound to a supplied identity during human review', async t => {
  const memory = fixture(t);
  memory.appendEventSources({ scope, events: [event(1, 'mio-one', 'Mio', '我去了博物馆。'), event(2, 'mio-two', 'Mio', '我去了公园。')] });
  const { result } = await process(memory, [candidate()]);
  const id = result.candidateResults[0].ingestionDecisionId;
  const detail = memory.getReviewConsoleProposal('ingestion', id);
  assert.equal(detail.identityChoices.length, 1);
  const choice = detail.identityChoices[0];
  const pending = memory.resolveHighLevelProposal('ingestion', id, { action: 'accept' });
  assert.equal(pending.resolution.status, 'needs-correction');
  assert.equal(pending.resolution.decision.review_state, 'pending');
  assert.throws(() => memory.resolveHighLevelProposal('ingestion', id, { action: 'accept',
    identityBindings: { [choice.key]: JSON.stringify(['other', 'not-in-this-batch']) } }), /not an identity candidate/);
  const bindings = { [choice.key]: choice.options.find(option => option.actorKey === 'mio-one').value };
  const accepted = memory.resolveHighLevelProposal('ingestion', id, { action: 'accept', identityBindings: bindings });
  assert.equal(accepted.resolution.status, 'accepted');
  assert.equal(accepted.resolution.memory.subject_key, 'mio-one');
  assert.ok(memory.getMemory(accepted.resolution.memory.id).roles.every(role => role.actor_key === 'mio-one'));
  assert.deepEqual(accepted.resolution.decision.resolvedCandidate.metadata.humanIdentityBindings, bindings);
});

test('group-only Agent extracts another Agent experience with stable identity and no invented human relationship', async t => {
  const memory = fixture(t);
  assert.equal(memory.initialize().identityStructure.userEntityId, '');
  const source = event(1, 'agent-b', 'Mio', '我今天参观了博物馆。');
  memory.appendEventSources({ scope, events: [source] });
  const { result, request } = await process(memory, [candidate({ subjectRole: 'agent',
    actorRoles: [{ role: 'experiencer', actorRole: 'agent', actorName: 'Mio', confidence: 1 }] })]);
  assert.equal(result.memoriesStored, 1);
  const node = memory.listMemories({ kinds: ['event'] }).items[0];
  assert.equal(node.subject_role, 'other');
  assert.equal(node.subject_key, 'agent-b');
  assert.doesNotMatch(request.input, /Absent Human|absent-human|对方名字|INTERNAL_HASH_NOT_MODEL_CONTEXT|INTERNAL_RUN_NOT_MODEL_CONTEXT/u);
  assert.match(request.input, /"role":"other","name":"Mio"/u);
  assert.doesNotMatch(request.input, /agent-a|agent-b/u);
  assert.deepEqual(request.sourceMaterial.eventSources, [source.source], 'Full audit provenance remains in code.');
  memory.withRepository(repository => {
    assert.deepEqual(repository.listRelationships(agentId), []);
    assert.ok(repository.listMemoryRoles(node.id).some(role => role.actor_key === 'agent-b'));
  });
});

test('owner perspective works without a primary human and preserves who experienced each event', async t => {
  const memory = fixture(t, {primaryUserId: '', userName: ''});
  assert.equal(memory.companionIdentity().primaryUserId, '');
  assert.equal(memory.initialize().identityStructure.userEntityId, '');
  memory.appendEventSources({scope, events: [event(1, 'agent-b', 'Mio', '我今天参观了博物馆。'),
    event(2, 'agent-a', 'Suzu', '我今天独自去了书店。')]});
  const {result, request} = await process(memory, [candidate({content: 'Mio 告诉我，他今天参观了博物馆。'}),
    candidate({subjectRole: 'agent', subjectName: 'Suzu', content: '我今天独自去了书店。', sourceRefs: ['M0002'],
      actorRoles: [{role: 'experiencer', actorRole: 'agent', actorName: 'Suzu', confidence: 1}]})]);
  assert.equal(result.memoriesStored, 2);
  assert.match(request.input, /标题和正文叙述使用人物完整姓名，包括拥有者/);
  assert.match(request.systemPrompt, /原消息和引语里的“我”属于该消息的实际说话者/);
  assert.doesNotMatch(request.input, /"role":"user"|Absent Human|absent-human/);
  const nodes = memory.listMemories({kinds: ['event']}).items;
  assert.equal(nodes.find(node => node.content.startsWith('我今天')).subject_key, 'agent-a');
  assert.equal(nodes.find(node => node.content.startsWith('Mio 告诉我')).subject_key, 'agent-b');
});

test('Direct extraction does not create a privileged human relationship from the conversation alone', async t => {
  const memory = fixture(t, {primaryUserId: 'human', userName: '小夏'});
  memory.appendEventSources({scope, events: [event(1, 'human', '小夏', '你好。', {
    sender: {kind: 'local-user', id: 'human', name: '小夏'},
    topology: {kind: 'direct-user-agent-dm', spaceKind: 'direct', participants: [
      {kind: 'local-user', id: 'human', name: '小夏'}, {kind: 'agent', id: agentId, name: 'Suzu'}]},
  })]});
  await process(memory, []);
  memory.withRepository(repository => assert.equal(repository.listRelationships(agentId).length, 0));
});

test('same-name Agents use distinct supplied names and unresolved names are reviewed', async t => {
  const memory = fixture(t);
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'Mio', '我去了博物馆。'), event(2, 'agent-c', 'Mio', '我去了公园。')] });
  const { result, request } = await process(memory, [candidate(), candidate({ subjectName: 'Mio [other:agent-b]',
    actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: 'Mio [other:agent-b]', confidence: 1 }] })]);
  assert.match(request.input, /Mio \[other:agent-b\]/u);
  assert.match(request.input, /Mio \[other:agent-c\]/u);
  assert.ok(result.candidateResults[0].reasons.includes('ambiguous-participant-identity'));
  assert.equal(result.candidateResults[1].status, 'created');
  assert.equal(memory.listMemories({ kinds: ['event'] }).items[0].subject_key, 'agent-b');
});

test('shared group events use actual participants instead of a default user pair', async t => {
  const memory = fixture(t);
  memory.appendEventSources({ scope, events: [event(1, 'agent-a', 'Suzu', '我和 Mio 一起整理完了书单。'),
    event(2, 'agent-b', 'Mio', '我们把书单整理完了。')] });
  const { result } = await process(memory, [candidate({ subjectRole: 'shared', subjectName: 'Suzu 与 Mio',
    content: 'Suzu 与 Mio 一起整理完了书单。', sourceRefs: ['M0001', 'M0002'],
    actorRoles: [{ role: 'participant', actorRole: 'agent', actorName: 'Suzu', confidence: 1 },
      { role: 'participant', actorRole: 'other', actorName: 'Mio', confidence: 1 }] })]);
  assert.equal(result.memoriesStored, 1);
  const node = memory.listMemories({ kinds: ['event'] }).items[0];
  assert.equal(node.subject_key, 'shared:agent:agent-a|other:agent-b');
  assert.doesNotMatch(node.subject_key, /user|absent-human/u);
});

test('explicit other-person state needs that person as source; observed owner events need no owner reply', async t => {
  const memory = fixture(t);
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'Mio', 'Suzu 被分配了整理书单的任务。'),
    event(2, 'agent-c', 'Ren', '我去了公园。')] });
  const { result } = await process(memory, [candidate({ subjectName: 'Ren', actorRoles: [], sourceRefs: ['M0001'] }),
    candidate({ subjectName: 'Suzu', subjectRole: 'agent', actorRoles: [], evidenceMode: 'observed',
      content: 'Mio 报告 Suzu 被分配了整理书单的任务。' })]);
  assert.ok(result.candidateResults[0].reasons.includes('explicit-memory-without-subject-source'));
  assert.equal(result.candidateResults[1].status, 'created');
});

test('known relationship target and holder resolve to actual Agent IDs', async t => {
  const memory = fixture(t);
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'Mio', '我信任 Suzu，会和它继续合作。')] });
  const { result } = await process(memory, [candidate({ kind: 'relationship', stateFamily: 'relationship',
    stateLabel: '对 Suzu 的信任', canonicalKey: 'mio-trust-suzu', temporalState: 'current', retentionReason: 'relationship',
    stateTarget: { counterpartRole: 'other', counterpartName: 'Suzu' } })]);
  const requestId = result.candidateResults[0].stateAnalysisRequestId;
  assert.ok(requestId, JSON.stringify(result.candidateResults));
  memory.withRepository(repository => {
    const request = repository.getStateAnalysisRequest(agentId, requestId);
    assert.equal(request.subject_key, 'agent-b');
    assert.equal(request.targetSpec.counterpartKey, 'agent-a');
    assert.equal(request.targetSpec.counterpartRole, 'agent');
  });
});

function directStateAnalysis({ input, analyzerRole, stateFamily }) {
  const snapshot = JSON.parse(input.slice(input.indexOf('\n\n{') + 2));
  assert.equal(snapshot.inputPolicy.memoryNarratorActorKey, agentId);
  assert.equal(snapshot.inputPolicy.firstPersonInUtterancesAndSourcesRefersToSpeaker, true);
  assert.equal(snapshot.currentState, null, 'Each personal target starts with its own state.');
  const common = { memoryId: snapshot.memories[0].id, sourceIds: snapshot.memories[0].sourceIds,
    confidence: 0.98, rationale: '固定主体的原话明确支持。' };
  const fields = stateFamily === 'relationship' ? {
    'relation-grounding': { targetMatch: 'exact', relationType: 'trust', polarity: 'affirms',
      relationLabel: '信任', scopeLabel: '', conditionLabel: '' },
    'perspective-direction': { holderMatch: 'yes', counterpartMatch: 'yes',
      direction: 'holder_to_counterpart', attribution: 'explicit_self_statement' },
    'scope-time': { stateTime: 'current', duration: 'ongoing', revocationCue: 'none' },
    'current-relation': { currentStatePresent: false, relation: 'no_current_state', scopeOverlap: 'unknown' },
  } : {
    'target-intent': { targetMatch: 'exact', goalText: '整理书单', intentionLevel: 'plan', specificity: 'actionable' },
    'holder-responsibility': { holderMatch: 'yes', attribution: 'explicit_self_statement',
      responsibility: 'subject', agency: 'self_chosen', acceptsResponsibility: 'yes' },
    'lifecycle': { lifecycle: 'active', completionBasis: 'none', timeReference: '' },
    'current-relation': { currentStatePresent: false, relation: 'no_current_state' },
  };
  assert.ok(fields[analyzerRole], analyzerRole);
  return { output: { analyses: [{ ...common, ...fields[analyzerRole] }] }, usage: {} };
}

test('one Agent keeps separate states for same-name Agents and humans across group spaces', async t => {
  const memory = fixture(t);
  const people = [
    { kind: 'agent', id: 'agent-b', name: 'Mio' },
    { kind: 'agent', id: 'agent-c', name: 'Mio' },
    { kind: 'local-user', id: 'human-b', name: '小夏' },
    { kind: 'local-user', id: 'human-c', name: '小夏' },
  ];
  memory.appendEventSources({ scope, events: people.map((person, index) => event(index + 1, person.id, person.name,
    '我打算整理书单。', { sender: person, spaceId: `group-${index % 2}` })) });
  await process(memory, people.map((person, index) => {
    const name = `${person.name} [other:${person.id}]`;
    return candidate({ kind: 'plan', stateFamily: 'goal', stateLabel: '整理书单', canonicalKey: 'goal:reading-list',
      title: '整理书单', content: `${name} 打算整理书单。`, subjectName: name,
      actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: name, confidence: 1 }],
      temporalState: 'current', retentionReason: 'open_loop', sourceRefs: [`M000${index + 1}`] });
  }));
  const result = await memory.runSemanticMaintenance({ processInputEvents: false, sourceScope: scope,
    generator: directStateAnalysis, structureGenerator: null });
  assert.equal(result.automaticStateAcceptance.accepted.length, people.length, JSON.stringify(result));
  const states = memory.listMemories({ kinds: ['plan'] }).items;
  assert.equal(states.length, people.length);
  assert.deepEqual(new Set(states.map(state => state.subject_key)), new Set(people.map(person => person.id)));
  assert.ok(states.every(state => state.agent_id === agentId && state.subject_role === 'other'));
  memory.withRepository(repository => {
    assert.deepEqual(repository.listRelationships(agentId), [], 'No default human dyad is invented.');
    for (const state of states) {
      const sources = repository.getMemoryDetail(agentId, state.id).sources;
      assert.ok(sources.length > 0);
      assert.equal(new Set(sources.map(source => source.id)).size, 1, 'Other speakers do not become evidence for this holder.');
    }
  });
});

test('group relationship analysis accepts owner and multiple counterpart identities without inventing reverse relations', async t => {
  const memory = fixture(t);
  const people = [
    { kind: 'agent', id: 'agent-b', name: 'Mio' },
    { kind: 'agent', id: 'agent-c', name: 'Ren' },
    { kind: 'local-user', id: 'human-b', name: '小夏' },
  ];
  const pairs = [['agent-b', 'Mio', 'agent-a', 'Suzu'], ['agent-b', 'Mio', 'agent-c', 'Ren'],
    ['agent-b', 'Mio', 'human-b', '小夏']];
  memory.appendEventSources({ scope, events: [
    event(1, 'agent-c', 'Ren', '我来了。'),
    event(2, 'human-b', '小夏', '我也来了。', { sender: people[2] }),
    ...pairs.map((pair, index) => event(index + 3, pair[0], pair[1], `我信任 ${pair[3]}。`)),
  ] });
  await process(memory, pairs.map(([holder, name, counterpart, counterpartName], index) => candidate({
    kind: 'relationship', stateFamily: 'relationship', stateLabel: `对 ${counterpartName} 的信任`,
    canonicalKey: `trust:${counterpart}`, subjectName: name, content: `${name} 信任 ${counterpartName}。`,
    temporalState: 'current', retentionReason: 'relationship', sourceRefs: [`M000${index + 3}`],
    stateTarget: { counterpartRole: 'other', counterpartName },
  })));
  const result = await memory.runSemanticMaintenance({ processInputEvents: false, sourceScope: scope,
    generator: directStateAnalysis, structureGenerator: null });
  assert.equal(result.automaticStateAcceptance.accepted.length, pairs.length, JSON.stringify(result));
  const states = memory.listMemories({ kinds: ['relationship'] }).items;
  assert.equal(states.length, pairs.length);
  assert.ok(states.every(state => state.subject_key === 'agent-b' && state.subject_role === 'other'));
  const aboutOwner = states.find(state => state.content === 'Mio 信任 Suzu。');
  assert.ok(aboutOwner, 'State materialization keeps the extracted named narrative without an embedding provider.');
  assert.equal(memory.getMemory(aboutOwner.id).memory.content, 'Mio 信任 Suzu。');
  const requests = result.stateAnalysis.results.map(item => item.request);
  assert.deepEqual(new Set(requests.map(request => request.targetSpec.counterpartKey)), new Set(pairs.map(pair => pair[2])));
});
