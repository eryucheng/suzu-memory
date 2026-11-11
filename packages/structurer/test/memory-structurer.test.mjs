import { createTestDirectory, closeAfterTests } from '../../../test/support/suite-resources.mjs';
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';

import { readUsageEvents } from "@suzu-memory/usage-ledger";
import { syncMemoryEmbeddings } from '@suzu-memory/embedding-indexer';
import { runSemanticTaskMaintenance } from '@suzu-memory/maintenance';
import {
  MemoryRepository,
  openMemoryDatabase,
  proposeMemoryStructure,
  resolveMemoryStructureProposal,
} from "@suzu-memory/core";

import {
  buildRelationSnapshot,
  buildRelationGenerationInput,
  buildStructureSnapshot,
  buildStructureGenerationInput,
  planMemoryConsolidation,
  processPlannedConsolidationRuns,
  proposeSubjectAttributionForMemory,
  proposeSubjectAttributionsBatch,
  proposeRelationsForBatch,
  proposeStructuresForBatch,
  runMemoryConsolidation,
  prepareStructureGeneration,
  runBudgetedMemoryParts,
} from "../src/index.mjs";

test('attachment repair sends surviving evidence and completes the superseded background task', async t => {
  const { database, repository, topic } = fixture();
  t.after(() => database.close());
  for (const [id, content] of [['retained', 'They shared space news.'], ['incoming', 'They watched a rocket launch.']]) {
    repository.upsertMemory({ id, agentId: 'agent-test', kind: 'event', layer: 'episodic', content });
  }
  const attach = (id, content) => proposeMemoryStructure(repository, { agentId: 'agent-test', operation: 'attach',
    kind: 'topic', targetMemoryId: topic.id, memberIds: [id], content });
  const removed = attach('batch-dinner', 'Museum visits and dinner.');
  const retained = attach('retained', 'Museum visits, dinner and space news.');
  resolveMemoryStructureProposal(repository, { agentId: 'agent-test', proposalId: retained.id, action: 'accept' });
  resolveMemoryStructureProposal(repository, { agentId: 'agent-test', proposalId: removed.id, action: 'dismiss' });
  const repair = repository.listMaintenanceTasks('agent-test', { taskTypes: ['structure-summary'], statuses: ['pending'] })[0];
  assert.ok(repair);
  const noOp = await proposeStructuresForBatch({ repository, agentId: 'agent-test', memoryIds: ['retained', 'incoming'],
    nearbyContainerIds: [topic.id], generator: async request => {
      assert.notEqual(request.schemaName, 'memory-structure-summary-v1', 'An unchanged membership must not trigger a paid summary.');
      return { output: { proposals: [{ operation: 'attach', targetMemoryId: topic.id,
        memberIds: ['retained'], content: 'An update without any new evidence.' }] } };
    } });
  assert.equal(noOp.rejected.length, 1);
  assert.match(noOp.rejected[0].error, /at least one new member/);
  const result = await proposeStructuresForBatch({ repository, agentId: 'agent-test', memoryIds: ['incoming'],
    nearbyContainerIds: [topic.id], generator: async request => {
      if (request.schemaName === 'memory-structure-summary-v1') {
        assertMemoryTaskRequest(request);
        const input = JSON.parse(request.input);
        assert.ok(input.members.some(memory => memory.content === 'They shared space news.'));
        assert.ok(input.members.some(memory => memory.content === 'They watched a rocket launch.'));
        assert.ok(!input.members.some(memory => memory.content === repository.getMemory('batch-dinner').content));
        return { output: { title: 'Exploring space', content: 'They explore space through museum visits, news and launches.' } };
      }
      return { output: { proposals: [{ operation: 'attach', targetMemoryId: topic.id, kind: 'topic',
        memberIds: ['incoming'], content: 'An incomplete update based on the safe older summary.' }] } };
    } });
  assert.deepEqual(result.rejected, []);
  assert.equal(repository.getMemory(topic.id).content, 'They explore space through museum visits, news and launches.');
  await runSemanticTaskMaintenance({ repository, agentId: 'agent-test',
    structureGenerator: async () => { throw new Error('Superseded work must not generate.'); } });
  assert.equal(repository.getMaintenanceTask('agent-test', repair.id).status, 'completed');
  assert.equal(repository.getMemory(topic.id).content, 'They explore space through museum visits, news and launches.');
});

test('failed combined-attachment summary is billed and retry preserves one complete membership update', async t => {
  const { database, repository, topic } = fixture(); t.after(() => database.close());
  repository.upsertMemory({ id: 'later', agentId: 'agent-test', kind: 'event', layer: 'episodic', content: 'They discussed a rocket launch.' });
  const usageLedgerPath = path.join(createTestDirectory(path.join(os.tmpdir(), 'suzu-summary-usage-')), 'usage.jsonl');
  let summaryAttempts = 0;
  const generator = async request => {
    if (request.schemaName === 'memory-structure-summary-v1') {
      summaryAttempts++;
      if (summaryAttempts === 1) throw Object.assign(new Error('Summary connection failed after a paid response.'), {
        model: 'fixture', usage: { prompt_tokens: 57, completion_tokens: 9 }, requestId: 'failed-summary',
      });
      return { output: { title: 'Exploring space', content: 'They share an interest in space through museum visits and rocket launches.' },
        model: 'fixture', usage: { prompt_tokens: 59, completion_tokens: 11 }, requestId: 'successful-summary' };
    }
    return { output: { proposals: ['batch-dinner', 'later'].map(id => ({ operation: 'attach', targetMemoryId: topic.id,
      content: 'Shared space activities.', memberIds: [id] })) }, model: 'fixture',
      usage: { prompt_tokens: 12, completion_tokens: 8 }, requestId: `grouping-${summaryAttempts}` };
  };
  const args = { repository, agentId: 'agent-test', memoryIds: ['batch-dinner', 'later'], nearbyContainerIds: [topic.id], generator, usageLedgerPath };
  assert.equal((await proposeStructuresForBatch(args)).status, 'partial-failure');
  assert.deepEqual(repository.listTopicMembers({ agentId: 'agent-test', topicId: topic.id }).map(row => row.id), ['batch-museum']);
  const first = await readUsageEvents(usageLedgerPath);
  assert.equal(first.events.length, 2);
  assert.equal(first.events.filter(row => row.requestId === 'failed-summary').length, 1);
  assert.equal(first.events.reduce((sum, row) => sum + row.usage.prompt_tokens, 0), 69);
  const result = await proposeStructuresForBatch(args);
  assert.equal(result.status, 'proposed'); assert.equal(result.proposed.length, 1);
  assert.deepEqual(repository.listTopicMembers({ agentId: 'agent-test', topicId: topic.id }).map(row => row.id).sort(), ['batch-dinner', 'batch-museum', 'later']);
  assert.match(repository.getMemory(topic.id).content, /rocket launches/);
  assert.equal((await readUsageEvents(usageLedgerPath)).events.length, 4);
});

test('one batch updates a shared container from all new members, or keeps rejected work pending', async t => {
  const { database, repository, topic } = fixture();
  t.after(() => database.close());
  repository.upsertMemory({ id: 'later', agentId: 'agent-test', kind: 'event', layer: 'episodic', content: 'They discussed the space exhibit again.' });
  const members = ['batch-dinner', 'later'];
  const overall = 'Their shared exploration of space includes museum visits and later conversations.';
  const generator = async request => {
    if (request.schemaName === 'memory-structure-summary-v1') {
      const input = JSON.parse(request.input);
      assert.ok(input.members.some(memory => memory.content === 'They discussed the space exhibit again.'));
      assert.ok(input.members.some(memory => memory.content === repository.getMemory('batch-dinner').content));
      assert.ok(input.members.every(memory => !Object.hasOwn(memory, 'id') && !Object.hasOwn(memory, 'subjectKey')));
      return { output: { title: 'Exploring space', content: overall } };
    }
    return { output: { proposals: members.map(id => ({ operation: 'attach', targetMemoryId: topic.id,
      kind: 'topic', title: '', content: repository.getMemory(id).content, memberIds: [id] })) } };
  };
  const args = { repository, agentId: 'agent-test', memoryIds: members, nearbyContainerIds: [topic.id], generator };
  const parts = [{ id: 'shared-target', memoryIds: members, status: 'pending' }];
  await runBudgetedMemoryParts({ parts, prepare: () => prepareStructureGeneration(args),
    execute: (_part, preparedGeneration) => proposeStructuresForBatch({ ...args, preparedGeneration }), checkpoint() {} });
  assert.equal(parts[0].status, 'completed');
  assert.deepEqual(parts[0].result.rejected, []);
  assert.equal(repository.getMemory(topic.id).content, overall);
  assert.ok(members.every(id => repository.listTopicMembers({ agentId: 'agent-test', topicId: topic.id }).some(memory => memory.id === id)));

  repository.upsertMemory({ id: 'unwritten', agentId: 'agent-test', kind: 'event', layer: 'episodic', content: 'A later space visit.' });
  const staleArgs = { ...args, memoryIds: ['unwritten'] };
  const pending = [{ id: 'stale-update', memoryIds: ['unwritten'], status: 'pending' }];
  await assert.rejects(runBudgetedMemoryParts({ parts: pending, prepare: () => prepareStructureGeneration(staleArgs),
    execute: (_part, preparedGeneration) => proposeStructuresForBatch({ ...staleArgs, preparedGeneration,
      generator: async () => {
        repository.editMemoryManually({ agentId: 'agent-test', memoryId: topic.id, patch: { content: 'Manual revision.' } });
        return { output: { proposals: [{ operation: 'attach', kind: 'topic', targetMemoryId: topic.id,
          memberIds: ['unwritten'], content: 'Stale update.' }] } };
      } }), checkpoint() {} }),
  { code: 'MEMORY_STRUCTURE_PARTIAL_FAILURE' });
  assert.equal(pending[0].status, 'pending');
  assert.equal(repository.getMemory(topic.id).content, 'Manual revision.');
});

function fixture() {
  const database = closeAfterTests(openMemoryDatabase(":memory:"));
  const repository = new MemoryRepository(database);
  for (const [id, content, eventStart] of [
    ["batch-museum", "用户去了科技馆并参观航天展。", "2026-07-11T03:00:00.000Z"],
    ["batch-dinner", "两人从科技馆离开后一起吃晚饭。", "2026-07-11T10:00:00.000Z"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      eventStart,
      metadata: { forbiddenRawPath: "C:/private/transcript.jsonl" },
    });
  }
  repository.upsertMemory({
    id: "raw-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "绝不能发送给结构生成器的逐字原话。",
  });
  repository.upsertMemory({
    id: "outside-current-batch",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "存在于数据库但不属于当前批次。",
    eventStart: "2026-07-10T03:00:00.000Z",
  });
  const topic = repository.upsertTopic({
    id: "topic-space",
    agentId: "agent-test",
    title: "航天兴趣",
    content: "围绕航天展览和航天内容形成的兴趣主题。",
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: "batch-museum",
    topicId: topic.id,
  });
  return { database, repository, topic };
}

test('structure generation groups undated evidence and evidence with only one known date in either language', async () => {
  for (const language of ['zh', 'en']) for (const timed of [false, true]) for (const kind of ['episode', 'topic']) {
    const database = closeAfterTests(openMemoryDatabase(':memory:'));
    try {
      const repository = new MemoryRepository(database);
      const ids = ['first', 'second'];
      for (const [index, id] of ids.entries()) repository.upsertMemory({id, agentId: 'grouping', kind: 'event', layer: 'episodic',
        content: language === 'zh' ? ['林准备了旅行装备。', '林预订了这次旅行的营地。'][index]
          : ['Lin packed for a hiking trip.', 'Lin booked the campsite for that trip.'][index],
        knownAt: '2026-11-01T08:00:00Z', eventDate: timed && !index ? '2026-10-20' : null });
      let calls = 0;
      const result = await proposeStructuresForBatch({repository, agentId: 'grouping', memoryIds: ids,
        generator: async request => {
          calls++;
          assertMemoryTaskRequest(request);
          const output = {proposals: [{operation: 'create', kind, title: 'Trip',
            content: language === 'zh' ? '林为徒步旅行准备装备并预订营地。' : 'Lin prepared equipment and booked a campsite for the hiking trip.',
            subjectRole: 'unknown', subjectKey: '',
            memberIds: ids, actorRoles: [], confidence: 0.9, rationale: 'The records describe the same trip.'}]};
          validateMemoryTaskOutput(request, output);
          return {output};
        }});
      assert.equal(calls, 1);
      assert.equal(result.proposed.length, 1, JSON.stringify(result.rejected));
      const saved = repository.getMemory(result.proposed[0].result_memory_id);
      assert.equal(saved.event_date, kind === 'episode' && timed ? '2026-10-20' : null);
      assert.equal(saved.event_start, null);
    } finally { database.close(); }
  }
});

test('attachment uses the same structure call to refresh its summary and rejects a stale generated update', async t => {
  const {database, repository, topic} = fixture();
  t.after(() => database.close());
  const next = '参观航天展并在晚餐中交流，是两人共同探索航天的经历。';
  let calls = 0;
  const generate = async request => {
    calls++;
    const input = JSON.parse(request.input);
    assert.equal(input.candidateContainers[0].content, topic.content);
    const output = {proposals: [{operation: 'attach', targetMemoryId: topic.id, title: '', content: next,
      memberIds: ['batch-dinner'], confidence: 0.9, rationale: 'Shared space exploration.'}]};
    validateMemoryTaskOutput(request, output);
    return {output};
  };
  const result = await proposeStructuresForBatch({repository, agentId: 'agent-test', memoryIds: ['batch-dinner'],
    nearbyContainerIds: [topic.id], generator: generate});
  assert.equal(calls, 1);
  assert.equal(result.proposed.length, 1, JSON.stringify(result.rejected));
  assert.equal(repository.getMemory(topic.id).content, next);
  const embedded = [];
  const embeddingProvider = Object.assign(async text => {
    embedded.push(text);
    return {model:'fixture',vector:[1,0]};
  }, {model:'fixture',dimensions:2});
  const indexing = {repository,agentId:'agent-test',embeddingProvider,memoryIds:[topic.id]};
  await syncMemoryEmbeddings(indexing);
  assert.equal(embedded.length,1);
  assert.ok(embedded[0].includes(next));
  assert.ok(!embedded[0].includes(topic.content));
  assert.equal(repository.listEmbeddings('agent-test','fixture').length,1);
  await syncMemoryEmbeddings(indexing);
  assert.equal(embedded.length,1,'Unchanged summary reuses its stored vector.');
  repository.upsertMemory({id: 'new-member', agentId: 'agent-test', kind: 'event', layer: 'episodic', content: '后来又分享了航天新闻。'});
  const stale = await proposeStructuresForBatch({repository, agentId: 'agent-test', memoryIds: ['new-member'],
    nearbyContainerIds: [topic.id], generator: async () => {
      repository.editMemoryManually({agentId: 'agent-test', memoryId: topic.id, patch: {content: '用户修订的主题概述。'}});
      return {output: {proposals: [{operation: 'attach', targetMemoryId: topic.id, kind: 'topic', title: '', content: '过时的生成结果。',
        subjectRole: 'unknown', subjectKey: '', memberIds: ['new-member'], actorRoles: [], confidence: 0.9, rationale: 'stale'}]}};
    }});
  assert.equal(stale.proposed.length, 0);
  assert.match(stale.rejected[0].error, /changed after generation/);
  assert.equal(repository.getMemory(topic.id).content, '用户修订的主题概述。');
  assert.equal(repository.listTopicMembers({agentId: 'agent-test', topicId: topic.id}).length, 2);
});

test('organization requests keep semantic material and leave local bookkeeping in their snapshots', t => {
  const { database, repository } = fixture();
  t.after(() => database.close());
  for (const [build, render] of [[buildStructureSnapshot, buildStructureGenerationInput],
    [buildRelationSnapshot, buildRelationGenerationInput]]) {
    const snapshot = build({ repository, agentId: 'agent-test', batchId: 'local-audit-batch',
      memoryIds: ['batch-museum', 'batch-dinner'] });
    const original = JSON.stringify(snapshot);
    const material = JSON.parse(render(snapshot));
    for (const key of ['schemaVersion', 'batchId', 'inputPolicy', 'omitted', 'sourceMaterial']) {
      assert.equal(Object.hasOwn(material, key), false, key);
    }
    for (const [key, value] of Object.entries(snapshot)) {
      if (['schemaVersion', 'batchId', 'inputPolicy', 'omitted', 'sourceMaterial'].includes(key)) continue;
      if (key === 'candidateContainers') {
        for (const container of value) {
          const modelContainer = material.candidateContainers.find(item => item.id === container.id);
          assert.equal(modelContainer.content, container.content);
          assert.equal(modelContainer.memberCount, container.memberIds.length);
          for (const memory of material.memories) {
            assert.equal(modelContainer.memberIds.includes(memory.id), container.memberIds.includes(memory.id));
            assert.equal(modelContainer.addableMemberIds.includes(memory.id), !container.memberIds.includes(memory.id));
          }
        }
        continue;
      }
      assert.deepEqual(material[key === 'currentMemories' ? 'memories' : key], value, key);
    }
    assert.ok(snapshot.inputPolicy);
    assert.equal(snapshot.batchId, 'local-audit-batch');
    assert.equal(JSON.stringify(snapshot), original);
  }
});

function subjectAttributionFixture() {
  const database = closeAfterTests(openMemoryDatabase(":memory:"));
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "subject-source-1",
    occurredAt: "2026-07-04T02:00:00.000Z",
    speaker: "User",
    content: "我今天去了科技馆，还看了机器人展。",
    metadata: { privatePath: "C:/private/conversation.jsonl" },
  });
  const memory = repository.upsertMemory({
    id: "legacy-unknown-subject",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "2026年7月4日去科技馆看了机器人展。",
    subjectRole: "unknown",
    evidenceMode: "imported",
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "legacy_unknown",
    provenance: "test",
  });
  return {
    database,
    repository,
    source,
    memory,
    allowedActors: [
      { role: "user", key: "user", name: "用户" },
      { role: "agent", key: "agent-test", name: "Agent" },
    ],
  };
}

test("creates only a pending bounded subject attribution proposal", async () => {
  const { database, repository, source, memory, allowedActors } = subjectAttributionFixture();
  const directory = createTestDirectory(path.join(os.tmpdir(), "suzu-subject-attribution-"));
  const ledgerPath = path.join(directory, "cost-ledger", "events.jsonl");
  let received = null;
  const result = await proposeSubjectAttributionForMemory({
    repository,
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
    usageLedgerPath: ledgerPath,
    generator: async (request) => {
      received = request;
      return {
        output: {
          decision: "propose",
          subjectRole: "user",
          subjectKey: "user",
          sourceIds: [source.id],
          actorRoles: [{
            role: "experiencer",
            actorRole: "user",
            actorKey: "user",
            isPrimary: true,
            confidence: 0.98,
            sourceIds: [source.id],
          }],
          confidence: 0.96,
          rationale: "第一人称原话直接说明用户是经历者。",
        },
        model: "fake-model",
        requestId: "request-1",
        usage: { inputTokens: 120, outputTokens: 40 },
        metadata: { provider: "fake-provider" },
      };
    },
  });
  assert.equal(result.status, "proposed");
  assert.equal(result.proposal.review_state, "pending");
  assert.equal(repository.getMemory(memory.id).subject_role, "unknown");
  assert.equal(received.schemaName, "memory-subject-attribution-v1");
  const sent = JSON.parse(received.input);
  assert.equal(sent.memory.content, memory.content);
  assert.deepEqual(sent.sources.map(({ id, speaker, content }) => ({ id, speaker, content })),
    [{ id: source.id, speaker: 'User', content: source.content }]);
  assert.deepEqual(new Set(sent.allowedActors.map(({ role, key, name }) => JSON.stringify({ role, key, name }))),
    new Set(allowedActors.map(({ role, key, name }) => JSON.stringify({ role, key, name }))));
  assert.doesNotMatch(received.input, /private\/conversation/u);
  const ledger = await readUsageEvents(ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].feature, "memory-subject-attribution");
  database.close();
});

test("lets the subject attribution specialist abstain without writing a proposal", async () => {
  const { database, repository, memory, allowedActors } = subjectAttributionFixture();
  const result = await proposeSubjectAttributionForMemory({
    repository,
    agentId: "agent-test",
    memoryId: memory.id,
    allowedActors,
    generator: async () => ({
      output: {
        decision: "abstain",
        subjectRole: "",
        subjectKey: "",
        sourceIds: [],
        actorRoles: [],
        confidence: 0.2,
        rationale: "来源中的指代不足以确认事件主人。",
      },
    }),
  });
  assert.equal(result.status, "abstained");
  assert.equal(repository.listSubjectAttributionProposals("agent-test").length, 0);
  assert.equal(repository.getMemory(memory.id).subject_role, "unknown");
  database.close();
});

test("bounds subject attribution batches and isolates a failed memory", async () => {
  const { database, repository, memory, allowedActors } = subjectAttributionFixture();
  const secondSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "subject-source-2",
    speaker: "User",
    content: "我以前反复读过这套科幻小说。",
  });
  const secondMemory = repository.upsertMemory({
    id: "legacy-unknown-reading",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "过去反复阅读过一套科幻小说。",
    subjectRole: "unknown",
    evidenceMode: "imported",
  });
  repository.linkSource(secondMemory.id, secondSource.id, "evidence", {
    authority: "legacy_unknown",
    provenance: "test",
  });
  const generator = async ({ input }) => {
    const snapshot = JSON.parse(input);
    const sourceId = snapshot.sources[0].id;
    return {
      output: {
        decision: "propose",
        subjectRole: "user",
        subjectKey: "user",
        sourceIds: [sourceId],
        actorRoles: [{
          role: "experiencer",
          actorRole: "user",
          actorKey: "user",
          isPrimary: true,
          confidence: 0.9,
          sourceIds: [sourceId],
        }],
        confidence: 0.9,
        rationale: "第一人称直接证据。",
      },
    };
  };
  const result = await proposeSubjectAttributionsBatch({
    repository,
    agentId: "agent-test",
    memoryIds: [memory.id, "missing-memory", secondMemory.id, "truncated-memory"],
    maximumMemories: 3,
    allowedActors,
    generator,
  });
  assert.equal(result.status, "completed-with-failures");
  assert.equal(result.selected, 3);
  assert.equal(result.truncated, 1);
  assert.deepEqual(result.counts, { proposed: 2, failed: 1 });
  assert.equal(repository.listSubjectAttributionProposals("agent-test").length, 2);
  await assert.rejects(() => proposeSubjectAttributionsBatch({
    repository,
    agentId: "agent-test",
    memoryIds: [memory.id],
    maximumMemories: 0,
    allowedActors,
    generator,
  }), /maximumMemories/u);
  database.close();
});

test("builds a bounded proposal snapshot without raw evidence or metadata", () => {
  const { database, repository, topic } = fixture();
  const snapshot = buildStructureSnapshot({
    repository,
    agentId: "agent-test",
    batchId: "batch-1",
    memoryIds: ["batch-museum", "batch-dinner", "raw-utterance"],
    nearbyContainerIds: [topic.id],
  });
  assert.deepEqual(snapshot.currentMemories.map((memory) => memory.id), [
    "batch-museum",
    "batch-dinner",
  ]);
  assert.equal(snapshot.candidateContainers.length, 1);
  assert.equal(snapshot.candidateContainers[0].id, topic.id);
  assert.equal(snapshot.inputPolicy.includesRawUtterances, false);
  assert.match(JSON.stringify(snapshot), /航天兴趣/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /绝不能发送/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /private\/transcript/u);
  assert.throws(() => buildStructureSnapshot({
    repository,
    agentId: "agent-test",
    memoryIds: ["missing-memory"],
  }), /must exist for the same Agent/u);
  database.close();
});

test("records only pending create and attach proposals with metered fake generation", async () => {
  const { database, repository, topic } = fixture();
  const directory = createTestDirectory(path.join(os.tmpdir(), "suzu-structurer-"));
  const ledgerPath = path.join(directory, "cost-ledger", "events.jsonl");
  let received = null;
  const generator = async (request) => {
    received = request;
    return {
      output: {
        proposals: [
          {
            operation: "attach",
            targetMemoryId: topic.id,
            kind: "topic",
            title: "",
            content: "围绕航天展览、参观及同行讨论形成的兴趣主题。",
            subjectRole: "unknown",
            subjectKey: "",
            eventDate: null,
            eventStart: null,
            eventEnd: null,
            memberIds: ["batch-museum", "batch-dinner"],
            actorRoles: [],
            confidence: 0.81,
            rationale: "晚饭事件仍属于同一次航天兴趣讨论。",
          },
          {
            operation: "create",
            targetMemoryId: "",
            kind: "episode",
            title: "科技馆之行",
            content: "参观科技馆并在离开后一起吃饭的连续经历。",
            subjectRole: "shared",
            subjectKey: "agent-test:user",
            eventDate: "2026-07-11",
            eventStart: "2026-07-11T03:00:00.000Z",
            eventEnd: "2026-07-11T10:00:00.000Z",
            memberIds: ["batch-museum", "batch-dinner"],
            actorRoles: [],
            confidence: 0.9,
            rationale: "时间连续并且属于同一次出行。",
          },
          {
            operation: "attach",
            targetMemoryId: topic.id,
            kind: "topic",
            title: "",
            content: "",
            subjectRole: "unknown",
            subjectKey: "",
            eventDate: null,
            eventStart: null,
            eventEnd: null,
            memberIds: ["invented-memory-id"],
            actorRoles: [],
            confidence: 0.2,
            rationale: "非法 ID 应被拒绝。",
          },
          {
            operation: "create",
            targetMemoryId: "",
            kind: "episode",
            title: "越界候选",
            content: "不能读取当前批次以外的节点来拼结构。",
            subjectRole: "shared",
            subjectKey: "agent-test:user",
            eventDate: "2026-07-10",
            eventStart: "2026-07-10T03:00:00.000Z",
            eventEnd: "2026-07-11T03:00:00.000Z",
            memberIds: ["outside-current-batch", "batch-museum"],
            actorRoles: [],
            confidence: 0.7,
            rationale: "已知但越界的成员仍应被拒绝。",
          },
        ],
      },
      model: "fake-structure-model",
      usage: { input_tokens: 120, output_tokens: 80 },
      requestId: "fake-request-1",
      durationMs: 25,
      metadata: { provider: "test-provider" },
    };
  };
  const result = await proposeStructuresForBatch({
    repository,
    agentId: "agent-test",
    batchId: "batch-1",
    memoryIds: ["batch-museum", "batch-dinner", "raw-utterance"],
    nearbyContainerIds: [topic.id],
    generator,
    usageLedgerPath: ledgerPath,
  });
  assert.equal(result.status, "proposed");
  assert.equal(result.proposed.length, 2);
  assert.equal(result.duplicates.length, 0);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].error, /currentMemories/u);
  assert.match(result.rejected[1].error, /currentMemories/u);
  assert.equal(result.usageRecorded, true);
  assert.equal(repository.listStructureProposals("agent-test", {
    reviewStates: ["pending"],
  }).length, 2);
  assert.equal(repository.listMemories("agent-test", { kinds: ["episode"] }).total, 1);
  assert.equal(repository.getMemory(result.proposed.find((proposal) => proposal.kind === "episode").result_memory_id).metadata.structureReviewState, "pending");
  assert.equal(repository.listTopicMembers({
    agentId: "agent-test",
    topicId: topic.id,
  }).length, 2);
  assert.equal(received.schemaName, "memory-structure-proposals-v2");
  assert.equal(received.schema.type, "object");
  assert.doesNotMatch(received.input, /绝不能发送/u);

  const duplicateResult = await proposeStructuresForBatch({
    repository,
    agentId: "agent-test",
    batchId: "batch-2",
    memoryIds: ["batch-museum", "batch-dinner"],
    nearbyContainerIds: [topic.id],
    generator,
  });
  assert.equal(duplicateResult.proposed.length, 0);
  assert.equal(duplicateResult.duplicates.length, 1);
  // The previously pending topic attachment is now an actual, pending node
  // relationship. On replay, only its already-linked museum member is
  // filtered; dinner is already linked as well, so the attach candidate is
  // rejected as a no-op while the episode remains a hash duplicate.
  assert.equal(duplicateResult.rejected.length, 3);
  const ledger = await readUsageEvents(ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].feature, "memory-structure-proposal");
  database.close();
});

test("does not write proposals when generation fails", async () => {
  const { database, repository, topic } = fixture();
  await assert.rejects(() => proposeStructuresForBatch({
    repository,
    agentId: "agent-test",
    memoryIds: ["batch-museum", "batch-dinner"],
    nearbyContainerIds: [topic.id],
    generator: async () => {
      throw new Error("simulated provider failure");
    },
  }), /simulated provider failure/u);
  assert.equal(repository.listStructureProposals("agent-test").length, 0);
  database.close();
});

function relationFixture() {
  const database = closeAfterTests(openMemoryDatabase(":memory:"));
  const repository = new MemoryRepository(database);
  const directSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "rain-cancel-source",
    occurredAt: "2026-07-11T08:00:00.000Z",
    speaker: "User",
    content: "因为突然下大雨，所以我把晚上的出门计划取消了。",
    metadata: { forbiddenPath: "C:/private/transcript.jsonl" },
  });
  const unrelatedSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "unrelated-source",
    speaker: "User",
    content: "今天吃了面。",
  });
  for (const [id, content, source] of [
    ["relation-rain", "当天突然下起大雨。", directSource],
    ["relation-cancel", "用户取消了晚上的出门计划。", directSource],
    ["relation-dinner", "用户当天吃了面。", unrelatedSource],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      subjectRole: id === "relation-rain" ? "world" : "user",
      subjectKey: id === "relation-rain" ? "" : "user",
      metadata: { forbiddenPath: "D:/private/memory.jsonl" },
    });
    repository.linkSource(id, source.id, "evidence");
  }
  return { database, repository, directSource, unrelatedSource };
}

test('structure and relation budgets reach the model and validator without fixed twenty or hundred item caps', async t => {
  for (const kind of ['structure', 'relations']) {
    const f = kind === 'structure' ? fixture() : relationFixture();
    t.after(() => f.database.close());
    const operation = kind === 'structure' ? proposeStructuresForBatch : proposeRelationsForBatch;
    const memoryIds = kind === 'structure' ? ['batch-museum', 'batch-dinner'] : ['relation-rain', 'relation-cancel'];
    let calls = 0;
    for (const maximumProposals of [0, 31, 101]) {
      const result = await operation({ repository: f.repository, agentId: 'agent-test', memoryIds, maximumProposals,
        generator: async request => {
          calls += 1;
          assertMemoryTaskRequest(request);
          assert.equal(request.schema.properties.proposals.maxItems, maximumProposals);
          const proposal = kind === 'structure' ? { operation: 'create', kind: 'topic', title: 'Museum visit',
            content: 'A visit to the museum and dinner afterwards.', subjectRole: 'unknown', subjectKey: '',
            memberIds: memoryIds, actorRoles: [], confidence: 0.9, rationale: 'A shared subject.' }
            : { relation: 'causes', fromMemoryId: memoryIds[0], toMemoryId: memoryIds[1], evidenceSourceIds: [f.directSource.id], confidence: 0.9, rationale: 'The speaker explicitly describes the cause.' };
          const proposals = Array.from({ length: maximumProposals }, () => proposal);
          assert.equal(validateMemoryTaskOutput(request, { proposals }).proposals.length, maximumProposals);
          assert.throws(() => validateMemoryTaskOutput(request, { proposals: [...proposals, proposal] }), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
          return { output: { proposals: [] } };
        } });
      if (maximumProposals === 0) {
        assert.equal(result.status, 'skipped');
        assert.equal(calls, 0);
      }
    }
    assert.equal(calls, 2);
    for (const maximumProposals of [-1, 1.5, Infinity]) await assert.rejects(operation({ repository: f.repository,
      agentId: 'agent-test', memoryIds, maximumProposals, generator: () => { throw new Error('Should not call provider.'); } }), /maximumProposals/);
  }
});

test("builds a bounded causal snapshot with source evidence but no paths or metadata", () => {
  const { database, repository, directSource } = relationFixture();
  const snapshot = buildRelationSnapshot({
    repository,
    agentId: "agent-test",
    batchId: "relation-batch",
    memoryIds: ["relation-rain", "relation-cancel"],
  });
  assert.deepEqual(snapshot.memories.map((memory) => memory.id), [
    "relation-rain",
    "relation-cancel",
  ]);
  assert.deepEqual(snapshot.sourceRecords.map((source) => source.id), [directSource.id]);
  assert.match(snapshot.sourceRecords[0].content, /因为突然下大雨/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /private[\\/]transcript|private[\\/]memory/u);
  assert.equal(snapshot.inputPolicy.modelCannotWriteEdges, true);
  database.close();
});

test("turns generated causes into pending proposals without writing graph edges", async () => {
  const { database, repository, directSource, unrelatedSource } = relationFixture();
  const directory = createTestDirectory(path.join(os.tmpdir(), "suzu-relation-structurer-"));
  const ledgerPath = path.join(directory, "usage.jsonl");
  let received;
  const generator = async (request) => {
    received = request;
    return {
      output: {
        proposals: [
          {
            relation: "causes",
            fromMemoryId: "relation-rain",
            toMemoryId: "relation-cancel",
            evidenceSourceIds: [directSource.id],
            confidence: 0.91,
            rationale: "原话使用因为和所以明确连接了大雨与取消计划。",
          },
          {
            relation: "causes",
            fromMemoryId: "relation-dinner",
            toMemoryId: "relation-cancel",
            evidenceSourceIds: [unrelatedSource.id],
            confidence: 0.2,
            rationale: "把同一天发生的事误当成因果，应由边界策略拒绝。",
          },
          {
            relation: "causes",
            fromMemoryId: "invented-memory",
            toMemoryId: "relation-cancel",
            evidenceSourceIds: [directSource.id],
            confidence: 0.2,
            rationale: "编造端点必须被拒绝。",
          },
        ],
      },
      model: "fake-relation-model",
      usage: { input_tokens: 160, output_tokens: 60 },
      requestId: "fake-relation-request",
      durationMs: 18,
      metadata: { provider: "test-provider" },
    };
  };
  const result = await proposeRelationsForBatch({
    repository,
    agentId: "agent-test",
    batchId: "relation-batch",
    memoryIds: ["relation-rain", "relation-cancel", "relation-dinner"],
    generator,
    usageLedgerPath: ledgerPath,
  });
  assert.equal(result.status, "proposed");
  assert.equal(result.proposed.length, 1);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].error, /cover both endpoints/u);
  assert.match(result.rejected[1].error, /bounded snapshot/u);
  assert.equal(repository.listRelationProposals("agent-test", {
    reviewStates: ["pending"],
  }).length, 1);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: "relation-rain",
    toMemoryId: "relation-cancel",
    relation: "causes",
  }), null);
  assert.equal(received.schemaName, "memory-relation-proposals-v1");
  assert.equal(received.schema.type, "object");
  assert.match(received.input, /因为突然下大雨/u);
  const ledger = await readUsageEvents(ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].feature, "memory-relation-proposal");

  const duplicate = await proposeRelationsForBatch({
    repository,
    agentId: "agent-test",
    batchId: "relation-batch-2",
    memoryIds: ["relation-rain", "relation-cancel", "relation-dinner"],
    generator,
  });
  assert.equal(duplicate.proposed.length, 0);
  assert.equal(duplicate.duplicates.length, 1);
  assert.equal(duplicate.rejected.length, 2);
  database.close();
});

test("allows the relation generator to abstain without creating forced memories", async () => {
  const { database, repository } = relationFixture();
  const result = await proposeRelationsForBatch({
    repository,
    agentId: "agent-test",
    memoryIds: ["relation-rain", "relation-cancel"],
    generator: async () => ({ output: { proposals: [] } }),
  });
  assert.equal(result.status, "no-valid-proposals");
  assert.equal(repository.listRelationProposals("agent-test").length, 0);
  database.close();
});

test("plans bounded retrospective consolidation without changing the memory graph", () => {
  const database = closeAfterTests(openMemoryDatabase(":memory:"));
  const repository = new MemoryRepository(database);
  for (const [id, content, agentId = "agent-test", kind = "event"] of [
    ["new-trigger", "用户刚明确说自己一直喜欢航天。"],
    ["old-space-museum", "用户以前参观过航天展。"],
    ["old-rocket-search", "用户以前主动搜索过火箭内容。"],
    ["weak-neighbor", "只是很弱的相似内容。"],
    ["raw-old-utterance", "旧对话原话。", "agent-test", "utterance"],
    ["foreign-memory", "另一个 Agent 的记忆。", "agent-foreign"],
  ]) {
    repository.upsertMemory({
      id,
      agentId,
      kind,
      layer: kind === "utterance" ? "evidence" : "episodic",
      content,
    });
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "new-trigger",
    toMemoryId: "old-space-museum",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.92,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "old-space-museum",
    toMemoryId: "old-rocket-search",
    relation: "same_thread",
    direction: "undirected",
    weight: 0.85,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "new-trigger",
    toMemoryId: "weak-neighbor",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.4,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "new-trigger",
    toMemoryId: "raw-old-utterance",
    relation: "same_thread",
    direction: "undirected",
    weight: 0.9,
  });
  const beforeNodes = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const beforeEdges = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count);
  const plan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["new-trigger"],
    maximumCandidates: 4,
  });
  assert.equal(plan.status, "planned");
  assert.deepEqual(plan.triggerIds, ["new-trigger"]);
  assert.deepEqual(plan.candidateIds, ["old-rocket-search", "old-space-museum"].sort());
  assert.deepEqual(plan.candidateReasons["old-space-museum"].relations, [
    "associated_with",
    "same_thread",
  ]);
  assert.ok(plan.candidateReasons["old-rocket-search"].depth >= 1);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), beforeNodes);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count), beforeEdges);
  assert.equal(repository.listStructureProposals("agent-test").length, 0);
  assert.equal(repository.listRelationProposals("agent-test").length, 0);

  const duplicate = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["new-trigger"],
    maximumCandidates: 4,
  });
  assert.equal(duplicate.id, plan.id);
  assert.equal(duplicate.wasInserted, false);
  assert.equal(repository.listConsolidationRuns("agent-test").length, 1);
  assert.throws(() => planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["foreign-memory"],
  }), /same Agent/u);
  database.close();
});

test("records an empty consolidation plan without calling a generator or inventing links", async () => {
  const database = closeAfterTests(openMemoryDatabase(":memory:"));
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "isolated-trigger",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "一条没有既有联系的新记忆。",
  });
  const plan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["isolated-trigger"],
  });
  assert.deepEqual(plan.candidateIds, []);
  assert.deepEqual(plan.graphEdgeIds, []);
  let generatorCalls = 0;
  const result = await runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: async () => {
      generatorCalls += 1;
      return { output: { proposals: [] } };
    },
  });
  assert.equal(result.status, "no-proposals");
  assert.equal(result.run.status, "no_proposals");
  assert.equal(generatorCalls, 0);
  assert.equal(repository.listConsolidationRuns("agent-test", {
    statuses: ["planned"],
  }).length, 0);
  database.close();
});

test("honors an explicit zero consolidation candidate limit", () => {
  const database = closeAfterTests(openMemoryDatabase(":memory:"));
  const repository = new MemoryRepository(database);
  for (const id of ["zero-trigger", "zero-neighbor"]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: id,
    });
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "zero-trigger",
    toMemoryId: "zero-neighbor",
    relation: "associated_with",
    direction: "undirected",
    weight: 1,
  });
  const plan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["zero-trigger"],
    maximumCandidates: 0,
  });
  assert.deepEqual(plan.candidateIds, []);
  assert.deepEqual(plan.graphEdgeIds, []);
  assert.equal(plan.metadata.selectionPolicy.maximumCandidates, 0);
  database.close();
});

function consolidationFixture() {
  const database = closeAfterTests(openMemoryDatabase(":memory:"));
  const repository = new MemoryRepository(database);
  const sharedSource = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "storm-cancel-retrospective-source",
    occurredAt: "2026-07-12T08:30:00.000Z",
    speaker: "User",
    content: "昨晚预报今天有暴雨，早上果然下了大雨，所以我取消了今天的航天展行程。",
  });
  for (const memory of [
    {
      id: "new-cancel",
      content: "用户今天因为暴雨取消了航天展行程。",
      eventStart: "2026-07-12T08:30:00.000Z",
    },
    {
      id: "old-heavy-rain",
      content: "当天早上出现了暴雨。",
      eventStart: "2026-07-12T07:30:00.000Z",
    },
    {
      id: "old-forecast",
      content: "前一晚的天气预报提示次日有暴雨。",
      eventStart: "2026-07-11T20:00:00.000Z",
    },
  ]) {
    repository.upsertMemory({
      ...memory,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      subjectRole: memory.id === "new-cancel" ? "user" : "world",
      subjectKey: memory.id === "new-cancel" ? "user" : "",
    });
    repository.linkSource(memory.id, sharedSource.id, "evidence");
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "new-cancel",
    toMemoryId: "old-heavy-rain",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.94,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "old-heavy-rain",
    toMemoryId: "old-forecast",
    relation: "same_thread",
    direction: "undirected",
    weight: 0.88,
  });
  const plan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["new-cancel"],
    maximumCandidates: 4,
  });
  return { database, repository, plan, sharedSource };
}

function retrospectiveStructureOutput() {
  const base = {
    operation: "create",
    targetMemoryId: "",
    kind: "episode",
    title: "暴雨取消航天展",
    content: "暴雨导致当天的航天展行程被取消。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: null,
    eventStart: null,
    eventEnd: null,
    actorRoles: [],
    confidence: 0.9,
    rationale: "两条有时间的记忆描述同一次连续事件。",
  };
  return {
    proposals: [
      { ...base, memberIds: ["old-heavy-rain", "new-cancel"] },
      {
        ...base,
        title: "只整理旧记忆",
        content: "这条候选没有包含新记忆。",
        memberIds: ["old-forecast", "old-heavy-rain"],
      },
    ],
  };
}

test("retrospective consolidation materializes reviewable groups and leaves causal links pending", async () => {
  const { database, repository, plan, sharedSource } = consolidationFixture();
  const beforeNodes = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const beforeEdges = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count);
  const received = [];
  const result = await runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: async (request) => {
      received.push(request.input);
      return { output: retrospectiveStructureOutput() };
    },
    relationGenerator: async (request) => {
      received.push(request.input);
      return {
        output: {
          proposals: [
            {
              relation: "causes",
              fromMemoryId: "old-heavy-rain",
              toMemoryId: "new-cancel",
              evidenceSourceIds: [sharedSource.id],
              confidence: 0.92,
              rationale: "原话明确使用所以说明暴雨导致行程取消。",
            },
            {
              relation: "causes",
              fromMemoryId: "old-forecast",
              toMemoryId: "old-heavy-rain",
              evidenceSourceIds: [sharedSource.id],
              confidence: 0.4,
              rationale: "这条候选只连接旧记忆，应被回顾策略拒绝。",
            },
          ],
        },
      };
    },
  });
  assert.equal(result.status, "completed");
  assert.equal(result.run.status, "completed");
  assert.equal(result.structure.proposed.length, 1);
  assert.equal(result.structure.rejected.length, 1);
  assert.equal(result.relations.proposed.length, 1);
  assert.equal(result.relations.rejected.length, 1);
  assert.equal(result.run.structureProposalIds.length, 1);
  assert.equal(result.run.relationProposalIds.length, 1);
  assert.ok(received.every((input) => input.includes('"retrospectiveContext"')));
  assert.ok(received.every((input) => input.includes('"triggerMemoryIds"')));
  assert.ok(received.every((input) => input.includes('"historicalMemoryIds"')));
  assert.equal(repository.listStructureProposals("agent-test")[0].review_state, "pending");
  assert.equal(repository.listRelationProposals("agent-test")[0].review_state, "pending");
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count), beforeNodes + 1);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count), beforeEdges + 2);
  assert.equal(repository.listMemories("agent-test", { kinds: ["episode"] }).total, 1);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: "old-heavy-rain",
    toMemoryId: "new-cancel",
    relation: "causes",
  }), null);

  let rerunCalls = 0;
  const rerun = await runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: async () => {
      rerunCalls += 1;
      return { output: { proposals: [] } };
    },
  });
  assert.equal(rerun.status, "already-finished");
  assert.equal(rerunCalls, 0);
  database.close();
});

test("combines retrospective structure and relation generation into one provider call", async () => {
  const { database, repository, plan, sharedSource } = consolidationFixture();
  const calls = [];
  const generator = async (request) => {
    calls.push(request);
    assert.equal(request.schemaName, "memory-consolidation-combined-v1");
    assert.deepEqual(request.combinedOutputs, ["structure", "relations"]);
    assert.equal(request.schema.properties.structure.properties.proposals.maxItems, 31);
    assert.equal(request.schema.properties.relations.properties.proposals.maxItems, 43);
    assertMemoryTaskRequest(request);
    return {
      output: {
        structure: retrospectiveStructureOutput(),
        relations: {
          proposals: [{
            relation: "causes",
            fromMemoryId: "old-heavy-rain",
            toMemoryId: "new-cancel",
            evidenceSourceIds: [sharedSource.id],
            confidence: 0.92,
            rationale: "原话明确说明暴雨导致行程取消。",
          }],
        },
      },
      model: "fake-combined-consolidation",
      usage: { input_tokens: 240, output_tokens: 80 },
      metadata: { provider: "test-provider" },
    };
  };
  generator.supportsCombinedConsolidation = true;
  const result = await runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: generator,
    relationGenerator: generator,
    structureOptions: { maximumProposals: 31 },
    relationOptions: { maximumProposals: 43 },
  });
  assert.equal(result.status, "completed");
  assert.equal(calls.length, 1);
  assert.equal(result.structure.proposed.length, 1);
  assert.equal(result.relations.proposed.length, 1);
  database.close();
});

test("retries retrospective consolidation three times, preserves partial proposals, and queues terminal review", async () => {
  const { database, repository, plan } = consolidationFixture();
  const beforeEdges = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count);
  const attempts = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    attempts.push(await runMemoryConsolidation({
      repository,
      agentId: "agent-test",
      runId: plan.id,
      structureGenerator: async () => ({ output: retrospectiveStructureOutput() }),
      relationGenerator: async () => {
        throw new Error(`simulated relation provider failure ${attempt}`);
      },
    }));
  }
  assert.deepEqual(attempts.map((result) => result.status), [
    "retry-pending",
    "retry-pending",
    "failed",
  ]);
  const failed = attempts.at(-1).run;
  assert.match(attempts.at(-1).error, /simulated relation provider failure 3/u);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempt_count, 3);
  assert.equal(failed.review_state, "pending");
  assert.equal(failed.failureHistory.length, 3);
  assert.equal(failed.structureProposalIds.length, 1);
  assert.deepEqual(failed.relationProposalIds, []);
  assert.equal(repository.listStructureProposals("agent-test").length, 1);
  assert.equal(repository.listRelationProposals("agent-test").length, 0);
  assert.equal(Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count), beforeEdges + 2);
  const reviewed = repository.reviewConsolidationFailure({
    agentId: "agent-test",
    runId: plan.id,
    action: "accept",
    reviewedBy: "human:test",
    note: "保留已经生成的结构候选，关系候选以后再判断。",
  });
  assert.equal(reviewed.status, "completed");
  assert.equal(reviewed.review_state, "accepted");
  assert.equal(repository.listStructureProposals("agent-test")[0].review_state, "pending");
  database.close();
});

test("refuses to execute a consolidation run already claimed by another worker", async () => {
  const { database, repository, plan } = consolidationFixture();
  repository.claimConsolidationRun({
    agentId: "agent-test",
    runId: plan.id,
    workerId: "worker-one",
  });
  await assert.rejects(runMemoryConsolidation({
    repository,
    agentId: "agent-test",
    runId: plan.id,
    structureGenerator: async () => ({ output: { proposals: [] } }),
  }), /not claimable from running/u);
  assert.equal(repository.getConsolidationRun("agent-test", plan.id).status, "running");
  assert.equal(repository.listStructureProposals("agent-test").length, 0);
  database.close();
});

test("reclaims an expired consolidation lease and rejects the stale worker", async () => {
  const { database, repository, plan } = consolidationFixture();
  const startedAt = new Date(new Date(plan.created_at).getTime() + 1000);
  const expiredAt = new Date(startedAt.getTime() + 2000);
  const finishedAt = new Date(expiredAt.getTime() + 1000);
  const claimed = repository.claimConsolidationRun({
    agentId: "agent-test",
    runId: plan.id,
    workerId: "stale-worker",
    leaseSeconds: 1,
    now: startedAt.toISOString(),
  });
  assert.equal(claimed.attempt_count, 1);
  assert.equal(repository.listClaimableConsolidationRuns("agent-test", {
    now: expiredAt.toISOString(),
  }).length, 1);
  const reclaimed = repository.claimConsolidationRun({
    agentId: "agent-test",
    runId: plan.id,
    workerId: "recovery-worker",
    leaseSeconds: 60,
    now: expiredAt.toISOString(),
  });
  assert.equal(reclaimed.attempt_count, 2);
  assert.equal(reclaimed.lease_owner, "recovery-worker");
  assert.throws(() => repository.finishConsolidationRun({
    agentId: "agent-test",
    runId: plan.id,
    status: "no_proposals",
    workerId: "stale-worker",
    now: finishedAt.toISOString(),
  }), /no longer owned/u);
  const finished = repository.finishConsolidationRun({
    agentId: "agent-test",
    runId: plan.id,
    status: "no_proposals",
    workerId: "recovery-worker",
    now: finishedAt.toISOString(),
  });
  assert.equal(finished.status, "no_proposals");
  assert.equal(finished.lease_owner, "");
  database.close();
});

test("a local restart immediately requeues an interrupted consolidation lease", () => {
  const { database, repository, plan } = consolidationFixture();
  const claimed = repository.claimConsolidationRun({
    agentId: "agent-test",
    runId: plan.id,
    workerId: "old-desktop-process",
    leaseSeconds: 3600,
    now: new Date(new Date(plan.created_at).getTime() + 1000).toISOString(),
  });
  const recovery = repository.recoverRunningConsolidationRuns("agent-test", {
    force: true,
    recoveredAt: new Date(new Date(claimed.created_at).getTime() + 2000).toISOString(),
  });
  assert.equal(recovery.requeued, 1);
  assert.equal(recovery.failed, 0);
  const requeued = repository.getConsolidationRun("agent-test", plan.id);
  assert.equal(requeued.status, "planned");
  assert.equal(requeued.lease_owner, "");
  assert.equal(requeued.failureHistory.at(-1).details.reason, "desktop-restart");
  const reclaimed = repository.claimConsolidationRun({
    agentId: "agent-test",
    runId: plan.id,
    workerId: "new-desktop-process",
    leaseSeconds: 60,
    now: new Date(new Date(claimed.created_at).getTime() + 2000).toISOString(),
  });
  assert.equal(reclaimed.attempt_count, 2);
  database.close();
});

test("routes a consolidation lease crash on the final attempt to human review", () => {
  const { database, repository, plan } = consolidationFixture();
  const base = new Date(plan.created_at).getTime() + 1000;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    repository.claimConsolidationRun({
      agentId: "agent-test",
      runId: plan.id,
      workerId: `crashed-worker-${attempt}`,
      leaseSeconds: 1,
      now: new Date(base + (attempt - 1) * 2000).toISOString(),
    });
  }
  const recovery = repository.recoverExpiredConsolidationRuns("agent-test", {
    now: new Date(base + 6000).toISOString(),
  });
  assert.equal(recovery.failed, 1);
  const failed = repository.getConsolidationRun("agent-test", plan.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempt_count, 3);
  assert.equal(failed.review_state, "pending");
  assert.equal(failed.failureHistory.length, 1);
  assert.equal(
    failed.failureHistory[0].details.reason,
    "lease-expired-after-maximum-attempts",
  );
  database.close();
});

test("processes a bounded planned batch, retries failures, and keeps later runs moving", async () => {
  const database = closeAfterTests(openMemoryDatabase(":memory:"));
  const repository = new MemoryRepository(database);
  for (const id of ["fail-trigger", "fail-history", "ok-trigger", "ok-history"]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `${id} 的直接事件记忆。`,
      eventStart: id.startsWith("fail")
        ? "2026-07-10T08:00:00.000Z"
        : "2026-07-11T08:00:00.000Z",
    });
  }
  for (const prefix of ["fail", "ok"]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: `${prefix}-trigger`,
      toMemoryId: `${prefix}-history`,
      relation: "associated_with",
      direction: "undirected",
      weight: 1,
    });
  }
  const failedPlan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["fail-trigger"],
  });
  const okPlan = planMemoryConsolidation({
    repository,
    agentId: "agent-test",
    triggerMemoryIds: ["ok-trigger"],
  });
  const generator = async ({ input }) => {
    if (input.includes('"fail-trigger"')) throw new Error("simulated provider failure");
    return { output: { proposals: [] } };
  };
  const first = await processPlannedConsolidationRuns({
    repository,
    agentId: "agent-test",
    maximumRuns: 2,
    generator,
  });
  assert.equal(first.status, "completed");
  assert.equal(first.selected, 2);
  assert.equal(first.counts["retry-pending"], 1);
  assert.equal(first.counts["no-proposals"], 1);
  assert.equal(repository.getConsolidationRun("agent-test", failedPlan.id).status, "planned");
  assert.equal(repository.getConsolidationRun("agent-test", okPlan.id).status, "no_proposals");
  const second = await processPlannedConsolidationRuns({
    repository,
    agentId: "agent-test",
    maximumRuns: 2,
    generator,
  });
  assert.equal(second.counts["retry-pending"], 1);
  const third = await processPlannedConsolidationRuns({
    repository,
    agentId: "agent-test",
    maximumRuns: 2,
    generator,
  });
  assert.equal(third.status, "completed-with-failures");
  assert.equal(third.counts.failed, 1);
  const terminal = repository.getConsolidationRun("agent-test", failedPlan.id);
  assert.equal(terminal.status, "failed");
  assert.equal(terminal.review_state, "pending");
  assert.equal(terminal.failureHistory.length, 3);
  await assert.rejects(processPlannedConsolidationRuns({
    repository,
    agentId: "agent-test",
    maximumRuns: 0,
    generator: async () => ({ output: { proposals: [] } }),
  }), /1 to 100/u);
  database.close();
});


test('generated structures retain the nondefault world carried by their snapshot members', async () => {
  const { database, repository } = fixture();
  try {
    database.prepare("UPDATE memory_nodes SET reality='fictional',world_id='story',world_frame='fictional' WHERE id IN (?,?)")
      .run('batch-museum', 'batch-dinner');
    database.prepare('UPDATE memory_nodes SET event_start=? WHERE id=?')
      .run('2026-07-12T10:00:00Z', 'batch-dinner');
    const result = await proposeStructuresForBatch({ repository, agentId: 'agent-test',
      memoryIds: ['batch-museum', 'batch-dinner'],
      generator: async () => ({ model: 'fixture', output: { proposals: ['topic', 'episode'].map(kind => ({
        operation: 'create', targetMemoryId: '', kind, title: 'Museum visit', content: 'A museum visit and dinner.',
        subjectRole: 'shared', subjectKey: 'agent-test:user', eventDate: kind === 'episode' ? '2026-07-11' : null,
        eventStart: null, eventEnd: null, memberIds: ['batch-museum', 'batch-dinner'], actorRoles: [],
        confidence: 0.9, rationale: 'Related experiences in the same world.',
      })) } }),
    });
    assert.equal(result.proposed.length, 2);
    assert.deepEqual(result.rejected, []);
    for (const proposal of result.proposed) {
      const memory = repository.getMemory(proposal.result_memory_id);
      assert.deepEqual([memory.reality, memory.world_id, memory.world_frame], ['fictional', 'story', 'fictional']);
    }
  } finally { database.close(); }
});
