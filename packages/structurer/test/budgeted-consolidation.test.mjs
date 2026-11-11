import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase, locateCausalExcerpt } from "@suzu-memory/core";
import { planMemoryConsolidation, runMemoryConsolidation, memoryBudgetError, runBudgetedMemoryParts, blockedMemoryPartsError } from "../src/index.mjs";
import { createOpenAiCompatibleStructuredGenerator } from '@suzu-memory/providers';
import { readUsageEvents } from '@suzu-memory/usage-ledger';
import { createTestDirectory } from '../../../test/support/suite-resources.mjs';
import os from 'node:os';
import path from 'node:path';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';

test("retrospective budget splits preserve every new/old pair and resume completed parts", async t => {
  const database = openMemoryDatabase(":memory:");
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({ agentId: "owner", sourceKind: "conversation", externalId: "source",
    content: "因为上次遇到这些情况，这次大家一起调整了安排。" });
  for (const prefix of ["new", "old"]) for (let i = 0; i < 4; i += 1) {
    const id = `${prefix}-${i}`;
    repository.upsertMemory({ id, agentId: "owner", kind: "event", layer: "episodic",
      content: `${id}:` + "完整事件".repeat(60) + "尾部", eventStart: "2026-09-20T08:00:00Z" });
    repository.linkSource(id, source.id);
  }
  for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) repository.upsertEdge({ agentId: "owner",
    fromMemoryId: `new-${i}`, toMemoryId: `old-${j}`, relation: "associated_with", weight: 0.9, confidence: 0.9 });
  const plan = planMemoryConsolidation({ repository, agentId: "owner", triggerMemoryIds: [0, 1, 2, 3].map(i => `new-${i}`) });
  const calls = [];
  const succeeded = [];
  const generator = async request => {
    assert.ok(request.input.length <= 4000);
    calls.push(request);
    if (calls.length === 2) throw new Error("transient provider failure");
    succeeded.push(request);
    return { output: { structure: { proposals: [] }, relations: { proposals: [] } } };
  };
  generator.supportsCombinedConsolidation = true;
  generator.assertRequestBudget = request => {
    if (request.input.length > 4000) throw memoryBudgetError("Test complete-request budget exceeded.");
  };
  const run = () => runMemoryConsolidation({ repository, agentId: "owner", runId: plan.id,
    structureGenerator: generator, relationGenerator: generator });
  assert.equal((await run()).status, "retry-pending");
  assert.equal((await run()).status, "no-proposals");
  assert.equal(calls[1].input, calls[2].input);
  assert.equal(calls[1].modelInput, calls[2].modelInput);
  assert.equal(new Set(succeeded.map(request => request.input)).size, succeeded.length);
  const pairs = new Set();
  const historicalPrefixes = new Map();
  const quotedEvidence = JSON.stringify(source.content);
  for (const request of succeeded) {
    const snapshot = JSON.parse(request.input);
    const evidenceStart = request.modelInput.indexOf(quotedEvidence);
    assert.ok(evidenceStart >= 0, 'The model receives the complete source evidence.');
    const prefix = request.modelInput.slice(0, evidenceStart + quotedEvidence.length);
    const historicalIds = JSON.stringify(snapshot.retrospectiveContext.historicalMemoryIds);
    if (historicalPrefixes.has(historicalIds)) {
      assert.ok(prefix === historicalPrefixes.get(historicalIds), 'The common prefix must extend through the historical evidence.');
    } else historicalPrefixes.set(historicalIds, prefix);
    for (const current of snapshot.retrospectiveContext.triggerMemoryIds) {
      for (const old of snapshot.retrospectiveContext.historicalMemoryIds) pairs.add(`${current}:${old}`);
    }
    assert.ok(snapshot.memories.every(memory => memory.content.endsWith("尾部")));
  }
  assert.ok(historicalPrefixes.size < succeeded.length, 'Distinct parts must share a historical prefix.');
  assert.equal(pairs.size, 16);
});

test("consolidation output exhaustion retains diagnostics and stops automatic retry", async t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({ agentId: 'owner', sourceKind: 'conversation', externalId: 'source', content: '两次相关经历。' });
  for (const id of ['new', 'old']) {
    repository.upsertMemory({ id, agentId: 'owner', kind: 'event', layer: 'episodic', content: id, eventStart: '2026-09-20T08:00:00Z' });
    repository.linkSource(id, source.id);
  }
  repository.upsertEdge({ agentId: 'owner', fromMemoryId: 'new', toMemoryId: 'old', relation: 'associated_with', weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ repository, agentId: 'owner', triggerMemoryIds: ['new'] });
  const diagnostics = { maxOutputTokens: 65536, usage: { outputTokens: 65536 } };
  const ledgerPath = path.join(createTestDirectory(path.join(os.tmpdir(), 'organization-usage-')), 'usage.jsonl');
  let calls = 0;
  const generator = async () => { calls++; throw Object.assign(new Error('Output protection reached'), {
    code: 'MAX_TOKENS', diagnostics, model: 'fixture-model', usage: { prompt_tokens: 19, completion_tokens: 65536 } }); };
  generator.supportsCombinedConsolidation = true;
  const result = await runMemoryConsolidation({ repository, agentId: 'owner', runId: plan.id, structureGenerator: generator, relationGenerator: generator,
    structureOptions: { usageLedgerPath: ledgerPath }, relationOptions: { usageLedgerPath: ledgerPath } });
  assert.equal(calls, 1);
  assert.equal(result.status, 'failed');
  assert.equal(result.run.review_state, 'pending');
  assert.equal(result.run.attempt_count, 1);
  assert.equal(result.run.failureHistory[0].details.errorCode, 'MAX_TOKENS');
  assert.deepEqual(result.run.failureHistory[0].details.providerDiagnostics, diagnostics);
  const usage = await readUsageEvents(ledgerPath);
  assert.equal(usage.events.length, 1, 'A failed combined HTTP call must be billed once.');
  assert.equal(usage.events[0].usage.prompt_tokens, 19); assert.equal(usage.events[0].usage.completion_tokens, 65536);
});

test("oversized evidence for one new/old pair is preserved and does not retry the model", async t => {
  const database = openMemoryDatabase(":memory:");
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const source = repository.upsertSource({ agentId: "owner", sourceKind: "conversation", externalId: "large-source",
    content: "完整证据".repeat(13000) + "结尾证据" });
  for (const id of ["new", "old"]) {
    repository.upsertMemory({ id, agentId: "owner", kind: "event", layer: "episodic", content: id,
      eventStart: "2026-09-20T08:00:00Z" });
    repository.linkSource(id, source.id);
  }
  repository.upsertEdge({ agentId: "owner", fromMemoryId: "new", toMemoryId: "old", relation: "associated_with", weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ repository, agentId: "owner", triggerMemoryIds: ["new"] });
  let calls = 0;
  const generator = async () => { calls += 1; return { output: { proposals: [] } }; };
  const result = await runMemoryConsolidation({ repository, agentId: "owner", runId: plan.id,
    structureGenerator: generator, relationGenerator: generator,
    structureOptions: { maximumRequestCharacters: 8000 }, relationOptions: { maximumRequestCharacters: 8000 } });
  assert.equal(result.status, "failed");
  assert.equal(result.run.review_state, "pending");
  assert.equal(result.run.attempt_count, 1);
  assert.equal(calls, 0);
  assert.ok(repository.getMemoryDetail("owner", "new").sources[0].content.endsWith("结尾证据"));
});

test('native consolidation shares full evidence and restores references without changing people, time or membership', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const sourceText = '2026-10-21: Because the venue was closed, Lin cancelled the museum visit. '
    + '这是这次参观的相关背景。'.repeat(150) + '最后确认：不是因为下雨，而是场馆闭馆。';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'conversation-1',
    content: sourceText, occurredAt: '2026-10-21T08:00:00Z', speaker: 'Lin' });
  const update = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'conversation-2',
    content: 'Lin rebooked for Friday.', occurredAt: '2026-10-22T08:00:00Z', speaker: 'Lin' });
  for (const [id, content] of [['old', 'The venue was closed.'], ['new', 'Lin cancelled the museum visit.'],
    ['outside-1', 'An earlier visit to another museum.'], ['outside-2', 'Another earlier museum visit.']]) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content,
      subjectRole: 'user', subjectKey: 'r1', worldId: 'shared-history', worldFrame: 'physical',
      eventDate: '2026-10-21', eventStart: '2026-10-21T08:00:00Z' });
    repository.linkSource(id, source.id);
    repository.upsertMemoryRole({ agentId, memoryId: id, role: 'speaker', actorRole: 'user', actorKey: 'r1', isPrimary: true, confidence: 1 });
  }
  repository.linkSource('new', update.id);
  const topic = repository.upsertTopic({ agentId, title: 'Lin 的博物馆参观', content: 'Lin 的博物馆参观经历。',
    worldId: 'shared-history', worldFrame: 'physical' });
  for (const id of ['old', 'outside-1', 'outside-2']) repository.linkMemoryToTopic({ agentId, topicId: topic.id, memoryId: id });
  repository.upsertEdge({ agentId, fromMemoryId: 'new', toMemoryId: 'old', relation: 'associated_with', weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['new'], maximumCandidates: 1 });
  let wire, calls = 0;
  const generator = createOpenAiCompatibleStructuredGenerator({ connection: { baseUrl: 'https://fixture.test/v1',
    apiKey: 'fixture-only', model: 'fixture-model', structuredOutputMode: 'strict-tool' }, fetchImpl: async (_url, init) => {
    calls++; wire = JSON.parse(init.body);
    assert.equal((wire.messages[1].content.match(/Lin cancelled the museum visit\./g) || []).length, 2,
      'The memory appears once and the unchanged original source contains its own occurrence.');
    const input = JSON.parse(wire.messages[1].content);
    const { memories: historical, sourceRecords: historicalSources } = input.historicalMaterial;
    const [old] = historical, [incoming] = input.memories, [container] = input.candidateContainers;
    assert.deepEqual(historical.map(memory => memory.content), ['The venue was closed.']);
    assert.deepEqual(input.memories.map(memory => memory.content), ['Lin cancelled the museum visit.']);
    assert.deepEqual(historicalSources.map(record => record.content), [sourceText]);
    assert.deepEqual(input.sourceRecords.map(record => record.content), [update.content]);
    assert.deepEqual(old.sourceIds, [historicalSources[0].id]);
    assert.deepEqual(new Set(incoming.sourceIds), new Set([historicalSources[0].id, input.sourceRecords[0].id]));
    assert.equal(incoming.subjectKey, 'r1'); assert.notEqual(incoming.id, 'r1');
    assert.equal(incoming.actorRoles[0].actorKey, 'r1');
    assert.equal(incoming.eventDate, '2026-10-21'); assert.equal(incoming.worldId, 'shared-history');
    assert.equal(container.content, 'Lin 的博物馆参观经历。'); assert.equal(container.memberCount, 3);
    assert.deepEqual(container.memberIds, [old.id]); assert.deepEqual(container.addableMemberIds, [incoming.id]);
    assert.equal(input.currentMemories, undefined);
    const output = { structure: { proposals: [{ operation: 'attach', targetMemoryId: container.id,
      title: '', content: 'Lin 参观过博物馆，后来因场馆闭馆取消了一次参观。', memberIds: [incoming.id], confidence: 0.9,
      rationale: 'The new visit belongs to the same ongoing topic.' }] }, relations: { proposals: [{ relation: 'causes',
      fromMemoryId: old.id, toMemoryId: incoming.id, evidenceSourceIds: [historicalSources[0].id], confidence: 0.95,
      rationale: 'The original statement explicitly links the closure to cancellation.' }] } };
    output.structure.proposals.push({ ...output.structure.proposals[0], memberIds: ['not-in-the-supplied-memories'] });
    output.relations.proposals.push({ ...output.relations.proposals[0], fromMemoryId: 'not-in-the-supplied-memories' });
    const { proposals } = output.structure;
    output.structure = { creations: [], attachments: proposals.map(({ operation, ...item }) => item) };
    assert.ok(wire.tools[0].function.parameters.properties.structure.properties.attachments);
    return Response.json({ model: wire.model, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ type: 'function', function: { name: wire.tools[0].function.name, arguments: JSON.stringify(output) } }] } }],
      usage: { prompt_tokens: 123, completion_tokens: 33 } });
  } });
  const result = await runMemoryConsolidation({ repository, agentId, runId: plan.id, structureGenerator: generator, relationGenerator: generator });
  assert.equal(result.status, 'completed', result.error); assert.equal(calls, 1);
  assert.equal(result.structure.proposed.length, 1); assert.equal(result.structure.rejected.length, 1);
  assert.equal(result.relations.proposed.length, 1); assert.equal(result.relations.rejected.length, 1);
  assert.deepEqual(repository.listTopicMembers({ agentId, topicId: topic.id }).map(memory => memory.id).sort(), ['new', 'old', 'outside-1', 'outside-2']);
  const relation = repository.listRelationProposals(agentId)[0];
  assert.equal(relation.from_memory_id, 'old'); assert.equal(relation.to_memory_id, 'new');
  assert.deepEqual(relation.evidence.map(item => item.id), [source.id]);
  assert.ok(JSON.stringify(wire).length <= 80000);
});

test('causal consolidation uses verified passages and restores full evidence on request without repeating structure', async t => {
  for (const needsFullEvidence of [false, true]) {
    const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
    const repository = new MemoryRepository(database), agentId = 'owner';
    const start = needsFullEvidence ? '因为场馆闭馆，' : 'Because the venue was closed,';
    const end = needsFullEvidence ? '林取消了参观。' : 'Lin cancelled the visit.';
    const passage = `${start} ${end}`;
    const content = `Background: ${'Other activities. '.repeat(200)}${passage} ${'Other plans. '.repeat(100)}`;
    const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'causal', content,
      occurredAt: '2026-10-21T08:00:00Z', speaker: 'Lin', metadata: { causalExcerpt: locateCausalExcerpt(content, { start, end }) } });
    const legacy = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'legacy',
      content: 'Lin booked another visit for Friday, subject to reopening.', occurredAt: '2026-10-22T08:00:00Z', speaker: 'Lin' });
    for (const [id, text] of [['old', 'The venue was closed.'], ['new', 'Lin cancelled the visit.']]) {
      repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: text, eventDate: '2026-10-21' });
      repository.linkSource(id, source.id);
    }
    repository.linkSource('new', legacy.id);
    repository.upsertEdge({ agentId, fromMemoryId: 'new', toMemoryId: 'old', relation: 'associated_with', weight: 1, confidence: 1 });
    const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['new'] });
    const ledgerPath = path.join(createTestDirectory(path.join(os.tmpdir(), 'causal-usage-')), 'usage.jsonl');
    const schemas = [];
    const native = createOpenAiCompatibleStructuredGenerator({ connection: { baseUrl: 'https://fixture.test/v1',
      apiKey: 'fixture-only', model: 'fixture-model', structuredOutputMode: 'strict-tool' }, fetchImpl: async (_url, init) => {
      const wire = JSON.parse(init.body), input = JSON.parse(wire.messages[1].content);
      const combined = schemas.at(-1) === 'memory-consolidation-combined-v1';
      const sources = [...(input.historicalMaterial?.sourceRecords || []), ...input.sourceRecords];
      const records = [...(input.historicalMaterial?.memories || []), ...input.memories];
      const older = records.find(memory => memory.content === 'The venue was closed.');
      const newer = records.find(memory => memory.content === 'Lin cancelled the visit.');
      const original = sources.find(item => item.speaker === 'Lin' && item.content.includes(start));
      assert.equal(original.content, combined ? passage : content);
      assert.equal(original.excerpt, combined ? true : undefined);
      assert.equal(sources.find(item => item.id !== original.id).content, legacy.content);
      assert.notEqual(older.id, 'old'); assert.notEqual(newer.id, 'new');
      assert.equal(newer.eventDate, '2026-10-21');
      const proposal = { relation: 'causes', fromMemoryId: older.id, toMemoryId: newer.id,
        evidenceSourceIds: [original.id], confidence: 0.95, rationale: passage };
      const relations = combined ? { needsFullEvidence, proposals: needsFullEvidence ? [] : [proposal] } : { proposals: [proposal] };
      const output = combined ? { structure: { creations: [], attachments: [] }, relations } : relations;
      return Response.json({ model: wire.model, choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{
        type: 'function', function: { name: wire.tools[0].function.name, arguments: JSON.stringify(output) },
      }] } }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    } });
    const generator = Object.assign(async request => {
      schemas.push(request.schemaName);
      assertMemoryTaskRequest(request);
      const result = await native(request);
      validateMemoryTaskOutput(request, result.output);
      return result;
    }, { supportsCombinedConsolidation: true, measureRequest: native.measureRequest });
    const result = await runMemoryConsolidation({ repository, agentId, runId: plan.id,
      structureGenerator: generator, relationGenerator: generator,
      structureOptions: { usageLedgerPath: ledgerPath }, relationOptions: { usageLedgerPath: ledgerPath } });
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(schemas, ['memory-consolidation-combined-v1', ...(needsFullEvidence ? ['memory-relation-proposals-v1'] : [])]);
    assert.deepEqual(result.relations.rejected, []);
    const relation = repository.listRelationProposals(agentId)[0];
    assert.equal(relation.from_memory_id, 'old'); assert.equal(relation.to_memory_id, 'new');
    assert.deepEqual(relation.evidence.map(item => item.id), [source.id]);
    assert.equal(repository.getSource(source.id).content, content);
    const usage = await readUsageEvents(ledgerPath);
    assert.equal(usage.events.length, schemas.length);
    assert.equal(usage.events.reduce((total, item) => total + item.usage.prompt_tokens, 0), schemas.length * 100);
  }
});

test('retrospective attachments join old evidence to a topic already containing the trigger and preserve identity and dates', async t => {
  for (const language of ['zh', 'en']) {
    const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
    const repository = new MemoryRepository(database), agentId = 'owner';
    const content = language === 'zh' ? '林经常游泳和徒步，后来参加了一个徒步社团。'
      : 'Lin regularly swims and hikes, and later joined a hiking club.';
    const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'outdoor-life', content,
      speaker: 'Lin', occurredAt: '2026-10-21T08:00:00Z' });
    for (const [id, text, date] of [['incoming', language === 'zh' ? '林参加徒步社团。' : 'Lin joined a hiking club.', '2026-10-21'],
      ['historical', language === 'zh' ? '林经常游泳和徒步。' : 'Lin regularly swims and hikes.', '2026-10-20']]) {
      repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: text, subjectRole: 'user', subjectKey: 'Lin',
        eventDate: date, knownAt: `${date}T08:00:00Z` });
      repository.linkSource(id, source.id);
    }
    const topic = repository.upsertTopic({ agentId, title: language === 'zh' ? '林的户外活动' : "Lin's outdoor activities",
      content: language === 'zh' ? '林通过徒步社团参加户外活动。' : 'Lin takes part in outdoor activities through a hiking club.',
      subjectRole: 'user', subjectKey: 'Lin', actorRoles: [{ role: 'subject', actorRole: 'user', actorKey: 'Lin', isPrimary: true, confidence: 1 }] });
    repository.linkMemoryToTopic({ agentId, topicId: topic.id, memoryId: 'incoming' });
    repository.upsertEdge({ agentId, fromMemoryId: 'incoming', toMemoryId: 'historical', relation: 'associated_with', weight: 1, confidence: 1 });
    const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['incoming'] });
    const summary = language === 'zh' ? '林经常游泳和徒步，并通过徒步社团参与户外活动。'
      : 'Lin regularly swims and hikes, and joins outdoor activities through a hiking club.';
    let calls = 0;
    const native = createOpenAiCompatibleStructuredGenerator({ connection: { baseUrl: 'https://fixture.test/v1', apiKey: 'fixture',
      model: 'fixture', structuredOutputMode: 'strict-tool' }, fetchImpl: async (_url, init) => {
      calls++; const wire = JSON.parse(init.body), material = JSON.parse(wire.messages[1].content);
      const older = material.historicalMaterial.memories.find(item => item.eventDate === '2026-10-20'), target = material.candidateContainers[0];
      assert.ok(target.memberIds.includes(material.retrospectiveContext.triggerMemoryIds[0]));
      assert.deepEqual(target.addableMemberIds, [older.id]);
      return Response.json({ model: 'fixture', choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function',
        function: { name: wire.tools[0].function.name, arguments: JSON.stringify({
          structure: { creations: [], attachments: [{ targetMemoryId: target.id, title: '', content: summary,
            memberIds: [older.id], confidence: 0.9, rationale: 'The earlier activities develop the same topic.' }] },
          relations: { proposals: [] },
        }) } }] } }], usage: { prompt_tokens: 123, completion_tokens: 45 } });
    } });
    const generator = Object.assign(async request => {
      assertMemoryTaskRequest(request); const result = await native(request);
      validateMemoryTaskOutput(request, result.output); return result;
    }, { supportsCombinedConsolidation: true, measureRequest: native.measureRequest });
    const result = await runMemoryConsolidation({ repository, agentId, runId: plan.id, structureGenerator: generator, relationGenerator: generator });
    assert.equal(result.status, 'completed', result.error); assert.equal(calls, 1);
    assert.equal(result.structure.proposed.length, 1); assert.deepEqual(result.structure.rejected, []);
    assert.deepEqual(result.structure.proposed[0].memberIds, ['historical']);
    const saved = repository.getMemory(topic.id);
    assert.equal(saved.content, summary); assert.equal(saved.subject_key, 'Lin'); assert.equal(saved.subject_role, 'user');
    assert.equal(saved.event_date, null); assert.equal(repository.getMemory('historical').event_date, '2026-10-20');
    assert.deepEqual(repository.listMemoryRoles(topic.id).map(role => role.actor_key), ['Lin']);
    assert.equal(repository.getMemoryDetail(agentId, 'historical').sources[0].content, content);
    assert.deepEqual(repository.listTopicMembers({ agentId, topicId: topic.id }).map(member => member.id).sort(), ['historical', 'incoming']);
  }
});

test('proposal saturation preserves accepted work and resumes only unfinished comparisons', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'causal-history',
    content: '由于暴雨和道路封闭，参观被取消，聚会也被推迟。' });
  for (const [id, content] of [['new-cancel', '参观被取消。'], ['new-delay', '聚会被推迟。'], ['old-rain', '暴雨。'], ['old-road', '道路封闭。']]) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content }); repository.linkSource(id, source.id);
  }
  for (const incoming of ['new-cancel', 'new-delay']) for (const old of ['old-rain', 'old-road']) repository.upsertEdge({
    agentId, fromMemoryId: incoming, toMemoryId: old, relation: 'associated_with', weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['new-cancel', 'new-delay'] });
  let structureCalls = 0, interrupted = false; const requests = [];
  const structureGenerator = async () => { structureCalls++; return { output: { proposals: [] } }; };
  const relationGenerator = async request => {
    requests.push(request.input);
    if (requests.length === 2) { interrupted = true; throw new Error('Temporary connection failure.'); }
    const input = JSON.parse(request.input), selected = input.retrospectiveContext;
    return { output: { proposals: selected.triggerMemoryIds.flatMap(incoming => selected.historicalMemoryIds.map(old => ({
      relation: 'causes', fromMemoryId: old, toMemoryId: incoming, evidenceSourceIds: [source.id],
      confidence: 0.95, rationale: '原话明确说明这两个原因导致了取消和推迟。' }))).slice(0, 2) } };
  };
  const run = () => runMemoryConsolidation({ repository, agentId, runId: plan.id, structureGenerator, relationGenerator,
    relationOptions: { maximumProposals: 2 } });
  assert.equal((await run()).status, 'retry-pending'); assert.equal(interrupted, true);
  assert.equal(repository.listRelationProposals(agentId).length, 2, 'Valid parent results must survive the later interruption.');
  const result = await run(); assert.equal(result.status, 'completed', result.error);
  assert.equal(structureCalls, 1, 'The completed structure task covers descendants and must not call the model again.');
  assert.equal(requests[1], requests[2]);
  assert.equal(result.run.relationProposalIds.length, 4);
  assert.deepEqual(new Set(repository.listRelationProposals(agentId).map(proposal => `${proposal.from_memory_id}:${proposal.to_memory_id}`)),
    new Set(['old-rain:new-cancel', 'old-road:new-cancel', 'old-rain:new-delay', 'old-road:new-delay']));
  assert.ok(result.run.metadata.organizationProgress.parts.some(part => part.status === 'partitioned'));
});

test('output truncation partitions the unfinished task while retaining the completed companion task', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'history', content: '前后的相关经历。' });
  for (const id of ['new-a', 'new-b', 'old-a', 'old-b']) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: id }); repository.linkSource(id, source.id);
  }
  for (const incoming of ['new-a', 'new-b']) for (const old of ['old-a', 'old-b']) repository.upsertEdge({
    agentId, fromMemoryId: incoming, toMemoryId: old, relation: 'associated_with', weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['new-a', 'new-b'] });
  const completePairs = new Set(); let relationCalls = 0;
  const result = await runMemoryConsolidation({ repository, agentId, runId: plan.id,
    structureGenerator: async request => {
      const input = JSON.parse(request.input);
      if (input.memories.length > 2) throw Object.assign(new Error('Output exceeded model capacity.'), { code: 'MAX_TOKENS' });
      for (const incoming of input.retrospectiveContext.triggerMemoryIds) for (const old of input.retrospectiveContext.historicalMemoryIds) completePairs.add(`${incoming}:${old}`);
      return { output: { proposals: [] } };
    }, relationGenerator: async () => { relationCalls++; return { output: { proposals: [] } }; } });
  assert.equal(result.status, 'no-proposals', result.error); assert.equal(completePairs.size, 4);
  assert.equal(relationCalls, 1);
  assert.equal(result.run.metadata.organizationProgress.parts.filter(part => part.status === 'completed').length, 4);
});

test('an irreducible output limit retains its cause and lets independent later work complete without replay', async () => {
  for (const code of ['MAX_TOKENS', 'MEMORY_STRUCTURE_OUTPUT_FULL']) {
    const parts = [{ id: 'too-large', memoryIds: ['large'], status: 'pending' },
      { id: 'independent', memoryIds: ['small'], status: 'pending' }];
    const completed = [];
    const run = () => runBudgetedMemoryParts({ parts, prepare: part => part.memoryIds,
      execute: async part => {
        if (part.id === 'too-large') throw Object.assign(new Error('This single item exceeds the output capacity.'),
          { code, diagnostics: { maxOutputTokens: 17 } });
        completed.push(...part.memoryIds); return { status: 'completed' };
      }, checkpoint() {} });
    await run();
    assert.equal(parts[0].status, 'blocked'); assert.equal(parts[1].status, 'completed');
    assert.equal(blockedMemoryPartsError(parts, 'Remaining work requires review.').code, code);
    assert.equal(parts[0].providerDiagnostics.maxOutputTokens, 17);
    await run(); assert.deepEqual(completed, ['small']);
  }
});
