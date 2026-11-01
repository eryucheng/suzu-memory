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

test('English evidence retains language, names, quotation and source identity through archive and recall', async t => {
  const memory = fixture(t, { primaryUserId: '', userName: '' });
  t.after(() => memory.close());
  const raw = 'I painted a sunrise yesterday. I called it "A New Beginning".';
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'Melanie', raw)] });
  const content = 'Melanie painted a sunrise—she named it "A New Beginning".';
  const { request, result } = await process(memory, [candidate({
    title: 'Melanie painted a sunrise', content, subjectName: 'Melanie',
    actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: 'Melanie', confidence: 1 }],
    eventDate: '2026-09-20',
  })]);
  assert.equal(result.memoriesStored, 1);
  assert.match(request.input, /本窗口输出语言：English/);
  const saved = memory.listMemories({ kinds: ['event'] }).items[0];
  assert.equal(saved.content, content);
  assert.equal(saved.subject_key, 'agent-b');
  const detail = memory.getMemory(saved.id);
  assert.equal(detail.sources[0].content, raw);
  const recalled = await memory.search('When did Melanie paint a sunrise?', { sourceScope: scope,
    now: '2026-09-22T10:00:00Z', persistTrace: false });
  assert.equal(recalled.status, 'ready');
  assert.ok(recalled.candidates.some(item => item.memoryId === saved.id));
  assert.match(recalled.context, /Melanie painted a sunrise/);
  assert.match(recalled.context, /A New Beginning/);
});

test('English name apostrophe typography preserves host identity through extraction and recall', async t => {
  const memory = fixture(t, { primaryUserId: '', userName: '' });
  t.after(() => memory.close());
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'O’Neill', 'I visited the lighthouse museum.')] });
  const { result } = await process(memory, [candidate({ subjectName: "O'Neill", title: 'Museum visit',
    content: "O'Neill visited the lighthouse museum.",
    actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: "O'Neill", confidence: 1 }] })]);
  assert.equal(result.memoriesStored, 1);
  const saved = memory.listMemories({ kinds: ['event'] }).items[0];
  assert.equal(saved.subject_key, 'agent-b');
  assert.ok(memory.getMemory(saved.id).roles.every(actor => actor.actor_key === 'agent-b'));
  for (const name of ["O'Neill", 'O’Neill']) {
    const recalled = await memory.search(`When did ${name} visit the lighthouse museum?`, { sourceScope: scope,
      now: '2026-09-22T10:00:00Z', persistTrace: false });
    assert.equal(recalled.status, 'ready');
    assert.ok(recalled.candidates.some(item => item.memoryId === saved.id));
  }
});

test('named extraction preserves its narrative in storage, embeddings, presentation and recall', async t => {
  const memory = fixture(t, { primaryUserId: '', userName: '' });
  const raw = '我想独自练习《海边—灯塔》，时间是18:00–19:00，请Suzu来看。';
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'Mio', raw)] });
  const title = 'Mio邀请Suzu看《海边—灯塔》练习';
  const content = 'Mio请Suzu看练习。Mio说：“我想独自练习《海边—灯塔》，时间是18:00–19:00。”';
  await process(memory, [candidate({ title, content })]);
  const saved = memory.listMemories({ kinds: ['event'] }).items[0];
  assert.equal(saved.content, content);
  assert.equal(saved.title, title);
  const detail = memory.getMemory(saved.id);
  assert.equal(detail.memory.content, content, 'The editor receives the stored narrative.');
  assert.equal(detail.memory.title, title);
  assert.equal(detail.sources[0].content, raw);
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
  assert.ok(recalled.context.includes(content));
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

test('human approval preserves known people separately from the memory owner', async t => {
  const memory = fixture(t, { primaryUserId: '', userName: '' });
  memory.appendEventSources({ scope, events: [event(1, 'ren', 'Ren', '你好。'), event(2, 'mio', 'Mio', '我想和 Ren 再合作一次。')] });
  const { result } = await process(memory, [candidate({ kind: 'relationship', stateFamily: 'relationship',
    title: 'Mio 对 Ren 的信任', content: '我觉得 Mio 对 Ren 渐渐有了信任。',
    canonicalKey: 'trust-ren', stateLabel: '对 Ren 的信任', stateTarget: { counterpartRole: 'other', counterpartName: 'Ren', relationshipDimension: 'trust' },
    evidenceMode: 'inferred', temporalState: 'current', retentionReason: 'relationship', sourceRefs: ['M0002'],
    actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: 'Mio', confidence: .9 },
      { role: 'participant', actorRole: 'other', actorName: 'Ren', confidence: .9 }] })]);
  const review = result.candidateResults[0];
  await memory.runSemanticMaintenance({ processInputEvents: false, sourceScope: scope,
    generator: async () => { throw new Error('fixture provider unavailable'); }, structureGenerator: null });
  const detail = memory.getReviewConsoleProposal('ingestion', review.ingestionDecisionId);
  const before = memory.getMemory(detail.members.find(item => item.memory.layer === 'provisional').memory.id).roles;
  assert.ok(before.some(role => role.actor_key === 'ren'));
  const accepted = memory.resolveHighLevelProposal('ingestion', review.ingestionDecisionId, { action: 'accept' });
  assert.equal(accepted.resolution.status, 'accepted');
  const after = memory.getMemory(accepted.resolution.memory.id).roles;
  assert.ok(after.some(role => role.role === 'participant' && role.actor_key === 'ren'));
  assert.ok(after.some(role => role.role === 'experiencer' && role.actor_key === 'mio'));
  assert.equal(accepted.resolution.memory.agent_id, agentId);
  assert.equal(after.some(role => role.role === 'experiencer' && role.actor_key === agentId), false);
});

test('third-party reports retain the described identity and their hearsay authority', async t => {
  const memory = fixture(t);
  memory.appendEventSources({ scope, events: [event(1, 'ren', 'Ren', 'Mio 今天参观了博物馆。'), event(2, 'mio', 'Mio', '你好。')] });
  const { result } = await process(memory, [candidate()]);
  assert.equal(result.candidateResults[0].status, 'created');
  const stored = memory.listMemories({ kinds: ['event'] }).items[0];
  assert.equal(stored.subject_key, 'mio');
  const detail = memory.getMemory(stored.id);
  assert.ok(detail.roles.some(role => role.actor_key === 'mio'));
  assert.equal(detail.sources[0].speaker, 'Ren');
  assert.equal(detail.sources[0].authority, 'hearsay');
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

test('third-party reports and observed owner events retain separate source authority', async t => {
  const memory = fixture(t);
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'Mio', 'Ren 今天参观了博物馆，Suzu 被分配了整理书单的任务。'),
    event(2, 'agent-c', 'Ren', '我去了公园。')] });
  const { result } = await process(memory, [candidate({ subjectName: 'Ren', content: 'Ren 今天参观了博物馆。', actorRoles: [], sourceRefs: ['M0001'] }),
    candidate({ subjectName: 'Suzu', subjectRole: 'agent', actorRoles: [], evidenceMode: 'observed',
      content: 'Mio 报告 Suzu 被分配了整理书单的任务。' })]);
  assert.ok(result.candidateResults.every(item => item.status === 'created'));
  const nodes = memory.listMemories({ kinds: ['event'] }).items;
  const report = memory.getMemory(nodes.find(node => node.subject_key === 'agent-c').id);
  const observation = memory.getMemory(nodes.find(node => node.subject_key === agentId).id);
  assert.equal(report.sources[0].authority, 'hearsay');
  assert.equal(observation.sources[0].authority, 'direct_observation');
  assert.equal(report.sources[0].speaker, 'Mio');
});

test('known relationship target and holder resolve to actual Agent IDs', async t => {
  const memory = fixture(t);
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'Mio', '我信任 Suzu，会和它继续合作。')] });
  const { result } = await process(memory, [candidate({ kind: 'relationship', stateFamily: 'relationship',
    stateLabel: '对 Suzu 的信任', canonicalKey: 'mio-trust-suzu', temporalState: 'current', retentionReason: 'relationship',
    stateTarget: { counterpartRole: 'other', counterpartName: 'Suzu', relationshipDimension: 'trust' } })]);
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
  const snapshot = JSON.parse(input);
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
    'current-relation': { currentStatePresent: false, relation: 'no_current_state', scopeOverlap: 'unknown',
      comparisonMemoryId: '', comparisonRelation: 'no_comparison', comparisonScopeOverlap: 'unknown' },
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

test('state holders use resolved identities across English apostrophes and Chinese name typography', async t => {
  const memory = fixture(t);
  t.after(() => memory.close());
  memory.appendEventSources({ scope, events: [
    event(1, 'agent-b', 'O’Neill', 'I like sunrise painting.'),
    event(2, 'agent-c', 'Ｍｉｏ', '我喜欢灯塔画。'),
  ] });
  const preference = (subjectName, holderName, sourceRef) => candidate({
    kind: 'preference', stateFamily: 'preference', stateLabel: 'painting', canonicalKey: 'painting',
    title: sourceRef === 'M0001' ? 'Sunrise painting' : '灯塔画',
    content: sourceRef === 'M0001' ? `${subjectName} likes sunrise painting.` : `${subjectName}喜欢灯塔画。`,
    temporalState: 'current', retentionReason: 'explicit_preference', subjectName,
    actorRoles: [{ role: 'preference_holder', actorRole: 'other', actorName: holderName, confidence: 1 }],
    sourceRefs: [sourceRef],
  });
  const { result } = await process(memory, [preference("O'Neill", 'O’Neill', 'M0001'),
    preference('Mio', 'Ｍｉｏ', 'M0002'), preference("O'Neill", 'Mio', 'M0001')]);
  for (const [index, expectedKey] of ['agent-b', 'agent-c'].entries()) {
    const id = result.candidateResults[index].stateAnalysisRequestId;
    assert.ok(id, JSON.stringify(result.candidateResults[index]));
    memory.withRepository(repository => assert.equal(repository.getStateAnalysisRequest(agentId, id).subject_key, expectedKey));
  }
  assert.ok(result.candidateResults[2].reasons.includes('holder-conflicts-with-subject'));
});

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
    stateTarget: { counterpartRole: 'other', counterpartName, relationshipDimension: 'trust' },
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
