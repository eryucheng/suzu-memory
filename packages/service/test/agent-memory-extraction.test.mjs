import { buildLongTermExtractionInput, normalizeGeneratedLongTermExtraction } from '@suzu-memory/extraction';
import { MemoryRepository } from '@suzu-memory/core';
import { extractionModelFixture } from '../../../test/support/extraction-fixtures.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryService } from '../src/index.mjs';
import { createOpenAiCompatibleStructuredGenerator } from '../../providers/src/index.mjs';

const agentId = 'agent-a';
const scope = { owner: 'test-events', agentId, eventUpperBound: 100, clears: [] };
const occurredAt = '2026-09-21T08:00:00.000Z';
function candidate(overrides = {}) {
  return { kind: 'event', title: '参观博物馆', content: 'Mio 今天参观了博物馆。', subjectRole: 'other', subjectName: 'Mio',
    actorRoles: [{ role: 'experiencer', actorRole: 'other', actorName: 'Mio', confidence: 1 }],
    canonicalKey: '', stateFamily: 'not_applicable', stateLabel: '',
    reality: 'real', evidenceMode: 'explicit', temporalState: 'historical', revisionAction: 'add', eventDate: '2026-09-21', eventStart: '', eventEnd: '', confidence: 0.95, importance: 0.5,
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
async function process(memory, memories, entities) {
  let request;
  const result = await memory.processPendingEvents({ sourceScope: scope, generator: async value => {
    request = value;
    return { output: extractionModelFixture({ memories, ...(entities ? { entities } : {}) }), usage: {} };
  } });
  return { result, request };
}

test('a single extraction archives independent facts and their conditions from another Agent’s message', async t => {
  const memory = fixture(t);
  t.after(() => memory.close());
  const text = '林岚雨天爱听老爵士，晴天少听。她吃辣就胃疼。';
  memory.appendEventSources({ scope, events: [event(1, 'agent-b', 'Mio', text)] });
  const facts = [
    { category: 'preference', key: 'music-rain', content: '林岚雨天爱听老爵士，晴天少听。', evidence: ['M0001.1'] },
    { category: 'condition', key: 'spicy-stomach', content: '林岚吃辣就胃疼。', evidence: ['M0001.3'] },
  ];
  let calls = 0;
  const result = await memory.processPendingEvents({ sourceScope: scope, generator: createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://example.test', model: 'fixture', apiKey: 'fixture', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, { body }) => {
      calls += 1;
      const packet = JSON.parse(body);
      assert.match(packet.messages[1].content, /Mio：〔1〕林岚雨天爱听老爵士，〔2〕晴天少听。〔3〕她吃辣就胃疼。/u);
      const tool = packet.tools[0].function;
      assert.equal(tool.parameters.properties.memories.items.properties.evidence.type, 'array');
      const memories = facts.map(({ category, key, content, evidence }) => ({
        title: content, content, classification: { category, key, label: content, target: null },
        subject: { ref: 'E1' }, actors: [], reality: 'real', evidenceMode: 'explicit', temporalState: 'current',
        revisionAction: 'add', time: null, confidence: 0.95, importance: 0.5, evidence,
      }));
      const output = { entities: [{ ref: 'E1', kind: 'person', name: '林岚', aliases: [] }], memories };
      return Response.json({ choices: [{ finish_reason: 'tool_calls',
        message: { tool_calls: [{ function: { name: tool.name, arguments: JSON.stringify(output) } }] } }] });
    },
  }) });
  assert.equal(calls, 1);
  assert.equal(result.stateAnalysisRequestsQueued, 2);
  assert.deepEqual(result.candidateResults.map(item => item.candidate.content), facts.map(fact => fact.content));
  memory.withRepository(repository => {
    const requests = repository.listStateAnalysisRequests(agentId, { statuses: ['pending'] });
    assert.equal(new Set(requests.map(item => item.subject_key)).size, 1);
    for (const item of requests) {
      assert.match(item.subject_key, /^entity:/u);
      assert.equal(item.sourceIds.length, 1);
      const source = repository.getSource(item.sourceIds[0]);
      assert.equal(source.content, text);
      assert.equal(source.speaker, 'Mio');
      assert.equal(repository.getMemory(item.memoryIds[0]).metadata.eventSource.sender.id, 'agent-b');
    }
  });
});

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
  assert.match(request.modelInput, /^【输出语言：沿用直接证据的语言，语种不清时用English】\n/u);
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
    evidenceMode: 'inferred', temporalState: 'current', sourceRefs: ['M0002'],
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
  assert.equal(accepted.resolution.memory.world_id, 'group-only');
  assert.equal(accepted.resolution.memory.metadata.stateTarget?.counterpartKey, 'ren');
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
  assert.match(request.input, /"ref":"P2","name":"Mio"/u);
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
  const { result, request } = await process(memory, [candidate(), { ...extractionModelFixture({ memories: [candidate()] }).memories[0], subject: { ref: 'P2' },
    actors: [{ role: 'experiencer', person: { ref: 'P2' }, confidence: 1 }] }]);
  assert.match(request.input, /"ref":"P2","name":"Mio"/u);
  assert.match(request.input, /"ref":"P3","name":"Mio"/u);
  assert.doesNotMatch(request.input, /agent-b|agent-c|absent-human/u);
  assert.ok(result.candidateResults[0].reasons.includes('ambiguous-participant-identity'));
  assert.equal(result.candidateResults[1].status, 'created');
  assert.equal(memory.listMemories({ kinds: ['event'] }).items[0].subject_key, 'agent-b');
  const detail = memory.getReviewConsoleProposal('ingestion', result.candidateResults[1].ingestionDecisionId);
  assert.deepEqual(detail.identityChoices, []);
  assert.equal(detail.writePreview.subjectKey, 'agent-b');
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
    stateLabel: '对 Suzu 的信任', canonicalKey: 'mio-trust-suzu', temporalState: 'current', stateTarget: { counterpartRole: 'other', counterpartName: 'Suzu', relationshipDimension: 'trust' } })]);
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

test('a commitment and its progress from one message become one sourced current state', async t => {
  const memory = fixture(t);
  t.after(() => memory.close());
  const raw = '我答应把木刻画册借给老贺，下周三之前寄出。现在还在书桌上，没寄呢。';
  const later = '给老贺的木刻画册已经打包了，还没寄。';
  memory.appendEventSources({ scope, events: [{ ...event(1, 'agent-b', 'Mio', raw), occurredAt: '2026-06-22T10:31:00.000Z' }] });
  const goal = (kind, title, content) => candidate({ kind, stateFamily: 'goal', stateLabel: title,
    canonicalKey: title, title, content, temporalState: 'current', eventDate: '' });
  const { result: extracted } = await process(memory, [
    goal('commitment', '寄木刻画册给老贺', 'Mio 答应下周三之前寄出木刻画册。'),
    goal('open_loop', '木刻画册尚未寄出', '木刻画册还在书桌上，尚未寄出。'),
  ]);
  assert.equal(extracted.stateAnalysisRequestsQueued, 2);

  const generator = Object.assign(async ({ input, analyzerRole, schemaName }) => {
    const snapshot = JSON.parse(input.slice(input.indexOf('{')));
    const evidence = snapshot.memories.find(item => item.content === raw || item.content === later);
    assert.ok(evidence, 'Both analyses receive the complete original statement.');
    const common = { memoryId: evidence.id, sourceIds: evidence.sourceIds, confidence: 0.98, rationale: '原话直接支持。' };
    if (analyzerRole === 'current-relation') {
      assert.ok(snapshot.currentState);
      return { output: { analyses: [{ ...common, relation: 'progress_update' }] } };
    }
    const analysis = { results: {
      targetIntent: { analyses: [{ ...common, targetMatch: 'exact', goalText: '寄木刻画册给老贺',
        intentionLevel: 'commitment', specificity: 'actionable', peerRelations: [] }] },
      holderResponsibility: { analyses: [{ ...common, holderMatch: 'yes', attribution: 'explicit_self_statement',
        responsibility: 'subject', agency: 'self_chosen', acceptsResponsibility: 'yes' }] },
      lifecycle: { analyses: [{ ...common, lifecycle: 'in_progress', completionBasis: 'none',
        timeReference: evidence.content === raw ? '下周三之前（发言时为2026-06-22，即2026-06-24前）' : '' }] },
    } };
    if (schemaName !== 'memory-state-match-analysis-v1') return { output: analysis };
    const existing = snapshot.stateCandidates.find(item => item.kind === 'commitment');
    return { output: { stateMatch: { resolution: 'matched', candidateId: existing.id, rationale: '同一承诺的寄出进度。' }, analysis } };
  }, { supportsCombinedStateAnalysis: true });
  const maintained = await memory.runSemanticMaintenance({ processInputEvents: false, sourceScope: scope,
    generator, structureGenerator: null });
  assert.deepEqual(maintained.automaticStateAcceptance.accepted.map(row => row.resolution.proposal.action), ['create', 'progress_update'],
    JSON.stringify(maintained.stateAnalysis.results.map(({ status, reason, evaluation }) => ({ status, reason,
      errors: Object.values(evaluation?.runs || {}).map(run => run.error_message).filter(Boolean),
    }))));
  assert.deepEqual(maintained.automaticStateAcceptance.deferred, []);
  const [creation, progress] = maintained.automaticStateAcceptance.accepted.map(item => item.resolution.proposal);
  assert.equal(creation.review_state, 'pending');
  assert.equal(progress.review_state, 'pending');
  const [state, duplicate] = memory.listMemories({ kinds: ['commitment', 'open_loop'] }).items;
  assert.equal(duplicate, undefined);
  assert.equal(state.temporal_state, 'in_progress');
  assert.equal(state.metadata.reportedStateDraft.goalClaim.timeReference, '下周三之前 (2026-07-01)');
  assert.ok(memory.getMemory(state.id).sources.some(source => source.content === raw));
  const recalled = await memory.search('答应老贺哪天之前寄木刻画册，当时寄了吗？', { sourceScope: scope,
    now: '2026-06-30T12:00:00Z', persistTrace: false });
  assert.match(recalled.context, /下周三之前 \(2026-07-01\)/u);
  assert.match(recalled.context, /没寄呢/u);
  const beforeConfirmation = memory.getMemory(state.id);
  const confirmed = memory.resolveHighLevelProposal('reported-state', creation.id, { action: 'accept' });
  assert.equal(confirmed.resolution.proposal.review_state, 'accepted');
  assert.deepEqual(memory.getMemory(state.id), beforeConfirmation);
  assert.equal(memory.getReviewConsoleProposal('reported-state', creation.id).permissions.canRevoke, true);
  memory.resolveHighLevelProposal('reported-state', progress.id, { action: 'dismiss' });
  assert.equal(memory.getMemory(state.id).memory.status, 'active');

  memory.appendEventSources({ scope, events: [{ ...event(2, 'agent-b', 'Mio', later), occurredAt: '2026-06-23T10:31:00.000Z' }] });
  await process(memory, [goal('open_loop', '画册已打包', '木刻画册已经打包，尚未寄出。')]);
  const subsequent = await memory.runSemanticMaintenance({ processInputEvents: false, sourceScope: scope,
    generator, structureGenerator: null });
  assert.equal(subsequent.automaticStateAcceptance.accepted.length, 0);
  assert.deepEqual(subsequent.automaticStateAcceptance.deferred.map(item => item.reason), ['state-transition-requires-review']);
  assert.equal(memory.listMemories({ kinds: ['commitment'] }).items[0].id, state.id);
  memory.resolveHighLevelProposal('reported-state', creation.id, { action: 'dismiss' });
  assert.equal(memory.getMemory(state.id).memory.status, 'deleted');
});

test('a reported preference change and its scoped exception are usable before confirmation', async t => {
  const memory = fixture(t);
  t.after(() => memory.close());
  const object = '无糖热茶';
  const original = '我平时喜欢喝无糖热茶。';
  const changed = '以前喜欢无糖热茶，现在我不喜欢喝无糖热茶了。';
  const exception = '我平时还是不喜欢无糖热茶，唯独夜班时喜欢喝不加糖的热茶。';
  const now = '2026-10-01T10:00:00Z';
  async function analyze(sequence, raw, {
    expressionType, revisionCue = 'none', contextLabel = '', objectLabel = object, previous, confirmsPrior = false,
    spaceId = 'group-only',
  }) {
    const when = `2026-09-${20 + sequence}T09:00:00.000Z`;
    memory.appendEventSources({ scope, events: [{ ...event(sequence, 'agent-b', 'Mio', raw, { spaceId }), occurredAt: when }] });
    const { result } = await process(memory, [candidate({
      kind: 'preference', stateFamily: 'preference', stateLabel: object, canonicalKey: `mio-tea-${sequence}`,
      title: object, content: raw, temporalState: 'current', eventDate: '',
      actorRoles: [{ role: 'preference_holder', actorRole: 'other', actorName: 'Mio', confidence: 1 }],
    })]);
    assert.equal(result.stateAnalysisRequestsQueued, 1);
    const generator = Object.assign(async request => {
      const supplied = JSON.parse(request.input.slice(request.input.indexOf('{')));
      const evidence = supplied.memories.find(item => item.content === raw);
      assert.ok(evidence);
      const common = { memoryId: evidence.id, sourceIds: evidence.sourceIds, confidence: 0.99, rationale: '原话支持。' };
      const analysis = { results: {
        objectGrounding: { analyses: [{ ...common, targetMatch: 'exact', matchedLabel: objectLabel }] },
        explicitExpression: { analyses: [{ ...common, expressionType, directness: 'explicit_self_statement' }] },
        behaviorConditions: { analyses: [] },
        sharingAffect: { analyses: [] },
        timeScope: { analyses: [{ ...common, stateTime: 'current', occurrencePattern: 'repeated',
          scopeKind: 'exact_object', scopeLabel: objectLabel, contextLabel, revisionCue }] },
      } };
      if (!request.stateMatchAnalysisTask) return { output: analysis };
      assert.ok(supplied.stateCandidates.some(item => item.id === previous));
      return { output: { stateMatch: { resolution: 'matched', candidateId: previous,
        supportingMemoryIds: confirmsPrior ? [evidence.id] : [], rationale: '原话对应这条偏好的对象和场合。' }, analysis } };
    }, { supportsCombinedStateAnalysis: true });
    const report = await memory.runSemanticMaintenance({ processInputEvents: false, sourceScope: scope,
      generator, structureGenerator: null, retrievalContextGenerator: null });
    assert.equal(report.automaticStateAcceptance.accepted.length, 0);
    return report.stateAnalysis.results[0];
  }
  const recall = query => memory.search(query, { sourceScope: scope, now, persistTrace: false });
  const initial = await analyze(1, original, { expressionType: 'likes' });
  assert.equal(initial.proposal?.review_state, 'pending', initial.reason);
  const originalId = initial.proposal.resultMemoryId;
  assert.equal(memory.getMemory(originalId).memory.status, 'active');

  const conflicting = await analyze(2, '我不喜欢喝无糖热茶。', { expressionType: 'dislikes', previous: originalId });
  assert.ok(!conflicting.proposal?.resultMemoryId);
  assert.equal(memory.getMemory(originalId).memory.status, 'active');

  const replacement = await analyze(3, changed, { expressionType: 'dislikes', revisionCue: 'changed', previous: originalId });
  assert.equal(replacement.proposal?.action, 'supersede', replacement.reason);
  const replacementId = replacement.proposal.resultMemoryId;
  assert.equal(replacement.proposal.review_state, 'pending');
  assert.equal(memory.getMemory(originalId).memory.status, 'superseded');
  assert.equal(memory.getMemory(originalId).memory.valid_to, '2026-09-23T09:00:00.000Z');
  assert.equal(memory.getMemory(replacementId).memory.status, 'active');
  assert.ok((await recall('Mio 现在喜欢喝无糖热茶吗？')).graph.selectedMemoryIds.includes(replacementId));

  const scoped = await analyze(4, exception, { expressionType: 'likes', revisionCue: 'clarified',
    contextLabel: '夜班', objectLabel: '不加糖的热茶', previous: replacementId });
  assert.equal(scoped.proposal?.action, 'add_scoped_exception', scoped.reason);
  assert.equal(scoped.proposal.review_state, 'pending');
  const scopedId = scoped.proposal.resultMemoryId;
  const edge = { agentId, fromMemoryId: scopedId, toMemoryId: replacementId, relation: 'scoped_exception_to' };
  assert.ok(memory.withRepository(repository => repository.findEdge(edge)));
  const visible = await recall('Mio 夜班时喜欢喝无糖热茶吗？');
  assert.ok(visible.graph.selectedMemoryIds.includes(scopedId), visible.context);
  assert.ok(visible.graph.selectedMemoryIds.includes(replacementId), visible.context);

  const restated = '夜班的时候我还是喜欢喝无糖热茶。';
  const reinforcement = await analyze(5, restated, {
    expressionType: 'likes', contextLabel: '值夜班', previous: scopedId, confirmsPrior: true,
  });
  assert.equal(reinforcement.proposal?.action, 'reinforce', reinforcement.reason);
  assert.equal(reinforcement.proposal.resultMemoryId, scopedId);
  assert.ok(memory.getMemory(scopedId).sources.some(source => source.content === restated));

  const allScopes = await analyze(6, '我改主意了，平时和夜班我都喜欢喝无糖热茶了。', {
    expressionType: 'likes', revisionCue: 'changed', previous: replacementId,
  });
  assert.equal(allScopes.proposal?.action, 'supersede', allScopes.reason);
  const allScopesId = allScopes.proposal.resultMemoryId;
  const carriedEdge = { ...edge, toMemoryId: allScopesId };
  assert.equal(memory.getMemory(scopedId).memory.status, 'active');
  assert.ok(memory.withRepository(repository => repository.findEdge(carriedEdge)));
  memory.resolveHighLevelProposal('reported-state', allScopes.proposal.id, { action: 'dismiss' });
  assert.equal(memory.getMemory(replacementId).memory.status, 'active');
  assert.equal(memory.getMemory(scopedId).memory.status, 'active');
  assert.equal(memory.withRepository(repository => repository.findEdge(carriedEdge)), null);
  assert.ok(memory.withRepository(repository => repository.findEdge(edge)));

  const changedScope = await analyze(7, '夜班的时候我也改主意了，不喜欢喝无糖热茶了。', {
    expressionType: 'dislikes', contextLabel: '夜班', revisionCue: 'changed', previous: scopedId,
  });
  assert.equal(changedScope.proposal?.action, 'supersede', changedScope.reason);
  const changedScopeId = changedScope.proposal.resultMemoryId;
  assert.equal(memory.getMemory(changedScopeId).memory.state_scope_key, memory.getMemory(scopedId).memory.state_scope_key);
  assert.equal(memory.getMemory(scopedId).memory.status, 'superseded');
  assert.equal(memory.getMemory(replacementId).memory.status, 'active');
  assert.ok(memory.withRepository(repository => repository.findEdge({ ...edge, fromMemoryId: changedScopeId })));
  memory.resolveHighLevelProposal('reported-state', changedScope.proposal.id, { action: 'dismiss' });
  assert.equal(memory.getMemory(scopedId).memory.status, 'active');

  const before = memory.getMemory(replacementId).memory;
  const confirmed = memory.resolveHighLevelProposal('reported-state', replacement.proposal.id, { action: 'accept' });
  assert.equal(confirmed.resolution.proposal.review_state, 'accepted');
  assert.equal(confirmed.maintenance.status, 'not-required');
  assert.deepEqual(memory.getMemory(replacementId).memory, before);
  assert.equal(memory.getReviewConsoleProposal('reported-state', replacement.proposal.id).permissions.canRevoke, true);
  memory.resolveHighLevelProposal('reported-state', scoped.proposal.id, { action: 'dismiss' });
  assert.equal(memory.withRepository(repository => repository.findEdge(edge)), null);
  assert.equal(memory.getMemory(replacementId).memory.status, 'active');
  memory.resolveHighLevelProposal('reported-state', replacement.proposal.id, { action: 'dismiss' });
  assert.equal(memory.getMemory(originalId).memory.status, 'active');
  assert.equal(memory.getMemory(originalId).memory.valid_to, null);
  assert.ok(!(await recall('Mio 现在喜欢喝无糖热茶吗？')).graph.selectedMemoryIds.includes(replacementId));

  const later = await analyze(8, '我还是改主意了，现在不喜欢无糖热茶。', { expressionType: 'dislikes',
    revisionCue: 'changed', previous: originalId, spaceId: 'preference-update' });
  assert.equal(later.proposal?.action, 'supersede', later.reason);
  assert.equal(memory.getMemory(originalId).memory.status, 'superseded');
  const cleared = { ...scope, clears: [{ spaceId: 'preference-update', throughSequence: 8 }] };
  assert.equal(memory.eraseEventSources({ id: 'erase-preference-update', scope: cleared }).complete, true);
  assert.equal(memory.getMemory(originalId).memory.status, 'active');
  assert.equal(memory.getMemory(originalId).memory.valid_to, null);
});

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
    temporalState: 'current', subjectName,
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

test('independent analysis writes separate states for same-name Agents and humans across group spaces', async t => {
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
    const wire = extractionModelFixture({ memories: [candidate({ kind: 'plan', stateFamily: 'goal', stateLabel: '整理书单',
      canonicalKey: 'goal:reading-list', title: '整理书单', content: `${person.name} 打算整理书单。`,
      subjectName: person.name, temporalState: 'current', sourceRefs: [`M000${index + 1}`] })] }).memories[0];
    return { ...wire, subject: { ref: `P${index + 2}` },
      actors: [{ role: 'experiencer', person: { ref: `P${index + 2}` }, confidence: 1 }] };
  }));
  const result = await memory.analyzePendingState({ sourceScope: scope, generator: directStateAnalysis });
  assert.equal(result.results.length, people.length, JSON.stringify(result));
  assert.ok(result.results.every(item => item.request.status === 'completed'
    && item.proposal.review_state === 'pending' && item.proposal.resultMemoryId));
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
  const state = states.find(item => item.subject_key === 'agent-b');
  const originalId = result.results.find(item => item.proposal.resultMemoryId === state.id).request.memoryIds[0];
  memory.deleteMemory(originalId);
  assert.equal(memory.getMemory(state.id).memory.status, 'deleted');
  assert.equal(memory.listMemories({ kinds: ['plan'] }).total, people.length - 1);

  await memory.close();
  const reopened = createMemoryService({ dataRoot: memory.paths.dataRoot, agentId, defaults: memory.defaults });
  t.after(() => reopened.close());
  reopened.initialize();
  assert.equal(reopened.getMemory(state.id).memory.status, 'deleted');
  reopened.restoreMemory(originalId);
  assert.equal(reopened.getMemory(state.id).memory.status, 'active');
  assert.equal(reopened.listMemories({ kinds: ['plan'] }).total, people.length);

  reopened.deleteMemory(originalId);
  const owner = result.results.find(item => item.proposal.resultMemoryId === state.id).proposal.id;
  reopened.resolveHighLevelProposal('reported-state', owner, { action: 'dismiss' });
  reopened.restoreMemory(originalId);
  assert.equal(reopened.getMemory(state.id).memory.status, 'deleted', 'Restoring the original cannot undo a separate withdrawal.');
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
    temporalState: 'current', sourceRefs: [`M000${index + 3}`],
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

for (const language of ['en', 'zh']) test(`world targets keep their meaning when their label matches participants: ${language}`, async t => {
  const label = language === 'en' ? 'Paris' : '巴黎';
  const text = language === 'en' ? 'I think the city Paris is beautiful, and thinking of it calms me.' : '我觉得巴黎这座城市很美，想到它就安心。';
  for (const duplicate of [false, true]) {
    const memory = fixture(t);
    t.after(() => memory.close());
    memory.appendEventSources({ scope, events: [event(1, 'city-name-person', label, text),
      ...(duplicate ? [event(2, 'same-name-peer', label, language === 'en' ? 'Hello.' : '你好。')] : [])] });
    const candidates = ['belief', 'affective_association'].map(category => ({
      title: label, content: text, classification: { category, key: `city-${category}`, label,
        target: { [category === 'belief' ? 'object' : 'trigger']: { world: label } } },
      subject: { ref: 'P2' }, actors: [], reality: 'real', evidenceMode: 'explicit', temporalState: 'current',
      revisionAction: 'add', time: null, confidence: 1, importance: 0.5, sourceRefs: ['M0001'],
    }));
    const { result } = await process(memory, candidates);
    assert.equal(result.stateAnalysisRequestsQueued, 2, JSON.stringify(result.candidateResults));
    assert.equal(result.memoriesForReview, 0);
    const requests = memory.withRepository(repository => repository.listStateAnalysisRequests(agentId, { statuses: ['pending'] }));
    for (const request of requests) {
      const prefix = request.state_family === 'belief' ? 'object' : 'trigger';
      assert.equal(request.subject_key, 'city-name-person');
      assert.equal(request.targetSpec[`${prefix}Role`], 'world');
      assert.equal(request.targetSpec[`${prefix}Key`], '');
      assert.equal(request.targetSpec[`${prefix}Label`], label);
    }
  }
});


for (const language of ['en', 'zh']) test(`named objects reach entity recall without changing the same-name person's identity: ${language}`, async t => {
  const memory = fixture(t); t.after(() => memory.close());
  const city = language === 'en' ? 'Paris' : '巴黎', guild = language === 'en' ? 'Orion Guild' : '猎户公会';
  const raw = language === 'en' ? 'I visited Paris in France, joined the Orion Guild, and bought the Amber Compass. My friend Mira visited Paris in Texas.'
    : '我去了法国的巴黎，加入了猎户公会，还买了琥珀罗盘。我的朋友米拉去了德克萨斯州的巴黎。';
  memory.appendEventSources({ scope, events: [event(1, 'same-name-person', city, raw)] });
  const entities = [{ ref: 'E1', kind: 'place', name: city, aliases: ['City of Light'] },
    { ref: 'E2', kind: 'organization', name: guild, aliases: ['Orion'] },
    { ref: 'E3', kind: 'object', name: 'Amber Compass', aliases: ['琥珀罗盘'] },
    { ref: 'E4', kind: 'person', name: language === 'en' ? 'Mira' : '米拉', aliases: [] },
    { ref: 'E5', kind: 'place', name: city, aliases: ['Paris Texas'] }];
  const base = { title: city, content: raw, classification: { category: 'event' }, actors: [], reality: 'real', evidenceMode: 'explicit',
    temporalState: 'historical', revisionAction: 'add', time: null, confidence: 1, importance: 0.6, sourceRefs: ['M0001'] };
  let reads = 0;
  const find = MemoryRepository.prototype.findEntitiesByNames;
  t.mock.method(MemoryRepository.prototype, 'findEntitiesByNames', function (args) { reads++; return find.call(this, args); });
  const { result } = await process(memory, [{ ...base, subject: { ref: 'P2' }, entityRefs: ['E1', 'E2', 'E3'] },
    { ...base, subject: { ref: 'E4' }, entityRefs: ['E5'] }], entities);
  assert.equal(result.memoriesStored, 2, JSON.stringify(result.candidateResults));
  assert.equal(reads, 1);
  const saved = result.candidateResults.map(item => memory.getMemory(item.memoryId));
  assert.equal(saved[0].memory.subject_key, 'same-name-person');
  assert.ok(saved[1].memory.subject_key.startsWith('entity:'));
  const cities = saved.map(item => item.entities.find(entity => entity.kind === 'place'));
  assert.notEqual(cities[0].id, cities[1].id);
  assert.equal(saved[0].entities.find(entity => entity.kind === 'organization').canonical_name, guild);
  assert.ok(saved[0].entities.some(entity => entity.kind === 'object'));
  assert.equal(saved[0].sources[0].content, raw);
  const recall = await memory.search(guild, { sourceScope: scope, persistTrace: false, now: '2026-09-22T00:00:00Z' });
  assert.ok(recall.candidates.some(item => item.memoryId === saved[0].memory.id && item.routeMatches.some(route => route.route === 'entity')), JSON.stringify(recall.candidates.map(item => ({ id: item.memoryId, routes: item.routeMatches }))));
});


test('source search uses each utterance’s entity mentions while an event retains all its sources', async t => {
  const memory = fixture(t);
  t.after(() => memory.close());
  const inspection = '我完成了服务器巡检。';
  const recovery = '同一次维护里，我把备份的 ＲＰＯ 定为十分钟。';
  memory.appendEventSources({ scope, events: [event(1, 'mio', 'Mio', inspection), event(2, 'mio', 'Mio', recovery)] });
  const base = {
    classification: { category: 'event' }, subject: { ref: 'P2' }, actors: [],
    reality: 'real', evidenceMode: 'explicit', temporalState: 'completed', revisionAction: 'add', time: null,
    confidence: 0.95, importance: 0.8,
  };
  const { result } = await process(memory, [
    { ...base, title: '确定备份恢复点目标', content: 'Mio 完成服务器巡检，并将备份的恢复点目标定为十分钟。',
      sourceRefs: ['M0001', 'M0002'], entityRefs: ['E1'] },
    { ...base, title: '完成服务器巡检', content: 'Mio 完成服务器巡检。',
      sourceRefs: ['M0001'], entityRefs: ['E2'], temporalState: 'unknown' },
  ], [
    { ref: 'E1', kind: 'concept', name: '恢复点目标', aliases: ['RPO'] },
    { ref: 'E2', kind: 'concept', name: '服务器巡检', aliases: [] },
  ]);
  const [saved, review] = result.candidateResults;
  assert.equal(saved.status, 'created');
  assert.equal(review.status, 'review');
  const archived = memory.listMemories({ kinds: ['utterance'] }).items;
  const inspectionId = archived.find(item => item.content === inspection).id;
  const recoveryId = archived.find(item => item.content === recovery).id;
  assert.deepEqual(memory.getMemory(inspectionId).entities.map(entity => entity.canonical_name), []);
  assert.deepEqual(memory.getMemory(recoveryId).entities.map(entity => entity.canonical_name), ['恢复点目标']);
  const detail = memory.getMemory(saved.memoryId);
  assert.ok(detail.entities.some(entity => entity.canonical_name === '恢复点目标'));
  assert.deepEqual(new Set(detail.sources.map(source => source.content)), new Set([inspection, recovery]));
  assert.deepEqual(new Set(detail.edges.filter(edge => edge.relation === 'supported_by').map(edge => edge.to_memory_id)),
    new Set([inspectionId, recoveryId]));
  const recall = await memory.search('恢复点目标', { sourceScope: scope, persistTrace: false, now: '2026-09-22T00:00:00Z' });
  assert.ok(recall.candidates.some(item => item.memoryId === recoveryId && item.routeMatches.some(route => route.route === 'lexical')));
  assert.ok(!recall.candidates.some(item => item.memoryId === inspectionId
    && item.routeMatches.some(route => ['lexical', 'bm25', 'entity'].includes(route.route))));
});

test('entity references survive semantic state materialization and source erasure removes derived names', async t => {
  const memory = fixture(t); t.after(() => memory.close());
  const marker = 'PRIVATE_ENTITY_ASTER';
  const knownAt = '2026-09-22T12:00:00.000Z';
  memory.appendEventSources({ scope, events: [
    { ...event(1, 'mio', 'Mio', `I plan to visit ${marker} with friend Liora from 2026-09-25 through 2026-09-27.`),
      knownAt: '2026-09-23T08:00:00.000Z' },
    { ...event(2, 'mio', 'Mio', 'The visit is confirmed.'), occurredAt: '2026-09-22T08:00:00.000Z', knownAt },
  ] });
  const entities = [{ ref: 'E1', kind: 'place', name: marker, aliases: ['PRIVATE_ALIAS_ASTER'] },
    { ref: 'E2', kind: 'person', name: 'Liora', aliases: [] }];
  const base = { title: marker, content: `Mio plans to visit ${marker} with Liora from 2026-09-25 through 2026-09-27.`,
    subject: { ref: 'P2' }, actors: [], entityRefs: ['E1', 'E2'], reality: 'real', evidenceMode: 'explicit',
    temporalState: 'current', revisionAction: 'add', time: { start: '2026-09-25T08:00:00Z', end: '2026-09-27T08:00:00Z' },
    confidence: 1, importance: 0.5, sourceRefs: ['M0001', 'M0002'] };
  const { result } = await process(memory, [{ ...base, classification: { category: 'plan', key: 'visit-aster', label: 'Visit Aster' } },
    { ...base, subject: { ref: 'E2' }, classification: { category: 'event' } }], entities);
  const requestId = result.candidateResults[0].stateAnalysisRequestId;
  assert.ok(requestId);
  memory.withRepository(repository => {
    const request = repository.getStateAnalysisRequest(agentId, requestId);
    const draft = repository.materializeStateAnalysisMemory(agentId, requestId);
    assert.deepEqual(new Set(repository.listMemoryEntities(draft.id).map(entity => entity.id)), new Set(request.metadata.entityIds));
    assert.equal(draft.known_at, knownAt);
    assert.equal(draft.event_start, '2026-09-25T08:00:00.000Z');
    assert.equal(draft.event_end, '2026-09-27T08:00:00.000Z');
  }, { sourceScope: scope });
  const maintained = await memory.runSemanticMaintenance({ processInputEvents: false, sourceScope: scope,
    generator: directStateAnalysis, structureGenerator: null });
  assert.equal(maintained.automaticStateAcceptance.accepted.length, 1);
  const plan = memory.listMemories({ kinds: ['plan'] }).items[0];
  assert.equal(plan.known_at, knownAt);
  assert.equal(plan.event_start, '2026-09-25T08:00:00.000Z');
  assert.equal(plan.event_end, '2026-09-27T08:00:00.000Z');
  assert.ok(memory.getMemory(plan.id).entities.some(entity => entity.canonical_name === marker));
  const cleared = { ...scope, clears: [{ spaceId: 'group-only', throughSequence: 2 }] };
  assert.equal(memory.eraseEventSources({ id: 'erase-entity-source', scope: cleared }).complete, true);
  memory.withRepository(repository => {
    assert.deepEqual(repository.findEntitiesByName({ agentId, name: marker }), []);
    assert.deepEqual(repository.findEntitiesByName({ agentId, name: 'PRIVATE_ALIAS_ASTER' }), []);
    assert.deepEqual(repository.findEntitiesByName({ agentId, name: 'Liora' }), []);
    assert.ok(repository.listActorEntityBindings(agentId).every(binding => binding.display_name !== 'Liora'));
  });
});


for (const temporalState of ['historical', 'unknown']) test('explicit review commits entity bindings only after acceptance: ' + temporalState, async t => {
  const memory = fixture(t); t.after(() => memory.close());
  const identity = { companionId: agentId, companionName: 'Suzu', primaryUserId: 'u', primaryUserName: 'Lin' };
  const built = buildLongTermExtractionInput({ identity, messages: [{ id: 'review-source', role: 'user', speaker: 'Lin', text: 'I visited the park with Mira.' }] });
  const row = normalizeGeneratedLongTermExtraction({ entities: [{ ref: 'E1', kind: 'person', name: 'Mira', aliases: [] }], memories: [{
    title: 'Park visit', content: 'Lin visited the park with Mira.', classification: { category: 'event' }, subject: { ref: 'P2' },
    actors: [{ role: 'participant', person: { ref: 'E1' }, confidence: 1 }], reality: 'fictional', evidenceMode: 'explicit',
    temporalState, revisionAction: 'add', time: null, confidence: 1, importance: 0.5, sourceRefs: ['M0001'] }] }, built).memories[0];
  const decision = memory.withRepository(repository => {
    const source = repository.upsertSource({ agentId, sourceKind: 'test', externalId: 'review-source', content: built.messages[0].text,
      worldId: 'story-park', worldFrame: 'fictional' });
    return repository.recordIngestionDecision({ agentId, batchId: 'review-with-entity', candidateIndex: 0, decision: 'review', resultStatus: 'review',
      candidate: { ...row, metadata: { actorIdentity: { ...identity, participants: built.participants } } }, sourceIds: [source.id] });
  });
  memory.getReviewConsoleProposal('ingestion', decision.id);
  memory.withRepository(repository => assert.deepEqual(repository.findEntitiesByName({ agentId, name: 'Mira' }), [], 'Reading a review does not create entities.'));
  const entityState = () => memory.withRepository(repository => ({ entities: repository.listEntities(agentId),
    bindings: repository.listActorEntityBindings(agentId), names: repository.database.prepare('SELECT * FROM entity_names ORDER BY entity_id,name_key').all() }));
  const before = entityState();
  const accepted = memory.resolveHighLevelProposal('ingestion', decision.id, { action: 'accept' });
  if (temporalState === 'unknown') {
    assert.equal(accepted.resolution.status, 'needs-correction');
    assert.ok(accepted.resolution.reasons.includes('unknown-temporal-state'));
    assert.deepEqual(entityState(), before, 'An unsuccessful review leaves no new entities, aliases or actor bindings.');
    memory.withRepository(repository => assert.equal(repository.getIngestionDecision(agentId, decision.id).review_state, 'pending'));
    return;
  }
  assert.equal(accepted.resolution.status, 'accepted');
  const detail = memory.getMemory(accepted.resolution.memory.id);
  assert.equal(detail.memory.world_id, 'story-park');
  assert.equal(detail.memory.world_frame, 'fictional');
  const guest = detail.entities.find(entity => entity.canonical_name === 'Mira');
  assert.ok(guest);
  assert.equal(guest.metadata.world.world_id, 'story-park');
  assert.ok(detail.roles.some(role => role.role === 'participant' && role.actor_key === `entity:${guest.id}`));
  assert.equal(accepted.resolution.decision.resolvedCandidate.entityBindings.E1, guest.id);
  memory.withRepository(repository => {
    const captured = repository.listIngestionEntityBindings({ agentId, batchId: 'review-with-entity', entityScopes: [row.entityScope] });
    assert.equal(captured[0].entity.id, guest.id);
  });
});


test('review keeps mixed-world evidence pending until its scope is resolved', async t => {
  const memory = fixture(t); t.after(() => memory.close());
  memory.appendEventSources({ scope, events: [
    { ...event(1, 'mio', 'Mio', 'I saw a gate.'), world: { id: 'story-a', frame: 'fictional' } },
    { ...event(2, 'mio', 'Mio', 'I saw a gate again.'), world: { id: 'story-b', frame: 'fictional' } },
  ] });
  const { result } = await process(memory, [candidate({ title: 'The gate', content: 'Mio saw a gate twice.',
    reality: 'fictional', eventDate: '', sourceRefs: ['M0001', 'M0002'] })]);
  const review = result.candidateResults[0];
  assert.ok(review.reasons.includes('mixed-world-evidence-needs-resolution'));
  const outcome = memory.resolveHighLevelProposal('ingestion', review.ingestionDecisionId, { action: 'accept' });
  assert.equal(outcome.resolution.status, 'needs-correction');
  assert.equal(outcome.resolution.memory, null);
  assert.equal(outcome.resolution.decision.review_state, 'pending');
  assert.equal(memory.listMemories({ kinds: ['event'] }).items.length, 0);
});

for (const variant of ['alias', 'normalized-name']) test('source erasure retains the remaining supported entity name: ' + variant, async t => {
  const memory = fixture(t); t.after(() => memory.close());
  const secondText = variant === 'alias' ? '我再次参观了巴黎。' : 'I visited ＰＡＲＩＳ again.';
  memory.appendEventSources({ scope, events: [
    event(1, 'visitor', 'Lin', 'I visited Paris.', { spaceId: 'first-room' }),
    event(2, 'visitor', 'Lin', secondText, { spaceId: 'second-room' }),
  ] });
  const base = { title: 'Paris', content: 'Lin visited Paris.', classification: { category: 'event' }, subject: { ref: 'P2' },
    actors: [], entityRefs: ['E1'], reality: 'real', evidenceMode: 'explicit', temporalState: 'historical', revisionAction: 'add',
    time: null, confidence: 1, importance: 0.5, sourceRefs: ['M0001'] };
  const secondContent = variant === 'alias' ? 'Lin 再次参观了巴黎。' : 'Lin visited Paris again.';
  const { result } = await process(memory, [base, { ...base, content: secondContent, sourceRefs: ['M0002'] }],
    [{ ref: 'E1', kind: 'place', name: 'Paris', aliases: ['巴黎'] }]);
  assert.equal(result.memoriesStored, 2);
  const id = memory.getMemory(result.candidateResults[0].memoryId).entities.find(entity => entity.kind === 'place').id;
  const cleared = { ...scope, clears: [{ spaceId: 'first-room', throughSequence: 1 }] };
  assert.equal(memory.eraseEventSources({ id: 'clear-first-room', scope: cleared }).complete, true);
  const retained = memory.getMemory(result.candidateResults[1].memoryId);
  assert.equal(retained.memory.content, secondContent);
  const expectedName = variant === 'alias' ? '巴黎' : 'Paris';
  memory.withRepository(repository => {
    assert.equal(repository.getEntity(agentId, id).canonical_name, expectedName);
    assert.equal(repository.findEntitiesByName({ agentId, name: expectedName })[0].id, id);
  });
  assert.ok(retained.entities.some(entity => entity.id === id && entity.canonical_name === expectedName));
});
