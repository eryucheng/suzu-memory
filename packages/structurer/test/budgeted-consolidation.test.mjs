import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase, locateCausalExcerpt } from "@suzu-memory/core";
import { planMemoryConsolidation, runMemoryConsolidation, processPlannedConsolidationRuns, proposeRelationsForBatch, memoryBudgetError, runBudgetedMemoryParts, blockedMemoryPartsError } from "../src/index.mjs";
import { deferSmallConsolidationRuns } from '../../maintenance/src/structure-batching.mjs';
import { prepareRelationGeneration } from '../src/relation-service.mjs';
import { createOpenAiCompatibleStructuredGenerator } from '@suzu-memory/providers';
import { readUsageEvents } from '@suzu-memory/usage-ledger';
import { createTestDirectory } from '../../../test/support/suite-resources.mjs';
import os from 'node:os';
import path from 'node:path';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';

test("organization budget splits preserve new/old and same-batch pairs and resume completed parts", async t => {
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
    return { output: request.schemaName === 'memory-consolidation-combined-v2'
      ? { structure: { proposals: [] }, relations: { proposals: [] } } : { proposals: [] } };
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
  const currentPairs = new Set(), pairCounts = new Map();
  const historicalPrefixes = new Map();
  const quotedEvidence = JSON.stringify(source.content);
  for (const request of succeeded) {
    const snapshot = JSON.parse(request.input);
    const evidenceStart = request.modelInput.indexOf(quotedEvidence);
    assert.ok(evidenceStart >= 0, 'The model receives the complete source evidence.');
    const prefix = request.modelInput.slice(0, evidenceStart + quotedEvidence.length);
    const scope = snapshot.relationContext || { anchorMemoryIds: snapshot.retrospectiveContext.triggerMemoryIds,
      candidateMemoryIds: snapshot.retrospectiveContext.historicalMemoryIds, includeAnchorPairs: false };
    const candidates = [...scope.candidateMemoryIds, ...(scope.includeAnchorPairs ? scope.anchorMemoryIds : [])];
    for (const a of scope.anchorMemoryIds) for (const b of candidates) {
      if (a !== b && a.startsWith('new-') && b.startsWith('new-')) currentPairs.add([a, b].sort().join(':'));
    }
    const requestPairs = new Set(scope.anchorMemoryIds.flatMap(a => candidates.filter(b => b !== a).map(b => [a, b].sort().join(':'))));
    for (const pair of requestPairs) pairCounts.set(pair, (pairCounts.get(pair) || 0) + 1);
    if (!snapshot.retrospectiveContext) continue;
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
  assert.equal(currentPairs.size, 6, 'Splitting must also examine pairs of new memories on opposite sides of a split.');
  assert.ok([...pairCounts.values()].every(count => count === 1), 'A historical split must not duplicate within-batch comparisons.');
});

for (const withHistory of [false, true]) test(`causal organization includes within-batch links ${withHistory ? 'alongside historical links' : 'without historical candidates'}`, async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'first',
    content: 'Because the venue was closed, Lin cancelled the museum visit. This cancellation led to a refund.' });
  for (const [id, content] of [['closure', 'The venue was closed.'], ['cancellation', 'Lin cancelled the museum visit.']]) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content });
    repository.linkSource(id, source.id);
  }
  if (withHistory) {
    repository.upsertMemory({ id: 'refund', agentId, kind: 'event', layer: 'episodic', content: 'Lin received a refund.' });
    repository.linkSource('refund', source.id);
    repository.upsertEdge({ agentId, fromMemoryId: 'cancellation', toMemoryId: 'refund', relation: 'associated_with', weight: 1, confidence: 1 });
  }
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['closure', 'cancellation'] });
  assert.deepEqual(plan.candidateIds, withHistory ? ['refund'] : []);
  let calls = 0;
  const generator = async request => {
    calls++;
    assert.equal(request.schemaName, withHistory ? 'memory-consolidation-combined-v2' : 'memory-relation-proposals-v2');
    const relations = { proposals: [{ relation: 'causes', fromMemoryId: 'closure', toMemoryId: 'cancellation',
      evidenceSourceIds: [source.id], confidence: 0.9, rationale: 'The source explicitly gives closure as the cause.' }] };
    if (withHistory) relations.proposals.push({ relation: 'causes', fromMemoryId: 'cancellation', toMemoryId: 'refund',
      evidenceSourceIds: [source.id], confidence: 0.9, rationale: 'The cancellation led to the refund.' });
    return { output: withHistory ? { structure: { proposals: [] }, relations } : relations };
  };
  generator.supportsCombinedConsolidation = true;
  const args = { repository, agentId, runId: plan.id, structureGenerator: generator, relationGenerator: generator };
  const result = await runMemoryConsolidation(args);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(calls, 1);
  const proposals = repository.listRelationProposals(agentId);
  assert.equal(proposals.length, withHistory ? 2 : 1);
  const proposal = proposals.find(item => item.from_memory_id === 'closure');
  assert.equal(proposal.from_memory_id, 'closure'); assert.equal(proposal.to_memory_id, 'cancellation');
  assert.equal(proposal.review_state, 'pending');
  const applied = repository.findEdge({ agentId, fromMemoryId: 'closure', toMemoryId: 'cancellation', relation: 'causes' });
  assert.ok(applied, 'Validated same-batch causality must be usable before human review.');
  assert.equal(repository.getRelationProposal(agentId, applied.metadata.relationProposalId).review_state, 'pending');
  assert.equal((await runMemoryConsolidation(args)).status, 'already-finished');
  assert.equal(calls, 1);
});

test('an older pending checkpoint adds same-batch coverage once and keeps its completed comparisons', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'history',
    content: 'The closure caused a cancellation. Earlier Lin had planned the visit.' });
  for (const id of ['closure', 'cancellation', 'old-plan']) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: id }); repository.linkSource(id, source.id);
  }
  repository.upsertEdge({ agentId, fromMemoryId: 'closure', toMemoryId: 'old-plan', relation: 'associated_with', weight: 1, confidence: 1 });
  const completed = { status: 'no-valid-proposals', proposed: [], duplicates: [], rejected: [] };
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['closure', 'cancellation'], metadata: {
    organizationProgress: { parts: [{ id: 'legacy-part', memoryIds: ['closure', 'cancellation'], historicalIds: ['old-plan'],
      status: 'completed', structure: completed, relations: completed }] },
  } });
  let calls = 0;
  const generator = async request => {
    assert.equal(request.schemaName, 'memory-relation-proposals-v2');
    assert.ok(JSON.parse(request.input).memories.every(memory => memory.id !== 'old-plan'));
    if (++calls === 1) throw new Error('Interrupted before the missing comparisons completed.');
    return { output: { proposals: [] } };
  };
  const args = { repository, agentId, runId: plan.id, structureGenerator: generator, relationGenerator: generator };
  assert.equal((await runMemoryConsolidation(args)).status, 'retry-pending');
  const result = await runMemoryConsolidation(args);
  assert.equal(result.status, 'no-proposals', result.error); assert.equal(calls, 2);
  assert.equal(result.run.metadata.organizationProgress.parts.length, 2);
  assert.deepEqual(result.run.metadata.organizationProgress.parts[0].structure, completed);
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
    assert.deepEqual(container.memberIds, [old.id]);
    assert.equal(input.currentMemories, undefined);
    const output = { structure: { proposals: [{ operation: 'attach', targetMemoryId: container.id,
      title: '', content: 'Lin 参观过博物馆，后来因场馆闭馆取消了一次参观。', memberIds: [incoming.id], confidence: 0.9,
      rationale: 'The new visit belongs to the same ongoing topic.' }] }, relations: { proposals: [{ relation: 'causes',
      fromMemoryId: old.id, toMemoryId: incoming.id, evidenceSourceIds: [historicalSources[0].id], confidence: 0.95,
      rationale: 'The original statement explicitly links the closure to cancellation.' }] } };
    output.structure.proposals.push({ ...output.structure.proposals[0], memberIds: ['not-in-the-supplied-memories'] });
    output.relations.proposals.push({ ...output.relations.proposals[0], fromMemoryId: 'not-in-the-supplied-memories' });
    output.relations.proposals = output.relations.proposals.map(({ relation, fromMemoryId, toMemoryId, ...fields }) => ({
      ...fields, relation, scope: '', anchorMemoryId: toMemoryId, relatedMemoryId: fromMemoryId, direction: 'related_to_anchor',
    }));
    output.relations.proposals.push(null, { ...output.relations.proposals[0], direction: 'invalid-direction' });
    const { proposals } = output.structure;
    output.structure = { creations: [{ kind: 'episode', title: 'Cancelled museum visit',
      content: 'The venue closure caused Lin to cancel the museum visit.', firstMemberId: incoming.id, secondMemberId: old.id, additionalMemberIds: [],
      subjectRole: 'user', subjectKey: 'r1', actorRoles: [], confidence: 0.9, rationale: 'The closure and cancellation describe the same visit.' }],
      attachments: proposals.map(({ operation, targetMemoryId, memberIds, ...item }) => ({ ...item,
        selection: { targetMemoryId, firstMemberId: memberIds[0] }, additionalMemberIds: memberIds.slice(1) })) };
    const schema = wire.tools[0].function.parameters.properties;
    const creations = schema.structure.properties.creations.items.properties;
    assert.deepEqual(creations.firstMemberId?.enum, [incoming.id], 'Creation must offer only the selected incoming members.');
    assert.deepEqual(creations.secondMemberId.enum, [old.id]);
    assert.ok(schema.structure.properties.creations.items.required.includes('firstMemberId'));
    assert.ok(schema.structure.properties.creations.items.required.includes('secondMemberId'));
    const attachments = schema.structure.properties.attachments.items.properties;
    const targets = attachments.selection.anyOf;
    assert.equal(targets.length, 1); assert.deepEqual(targets[0].properties.targetMemoryId.enum, [container.id]);
    assert.deepEqual(targets[0].properties.firstMemberId.enum, [incoming.id], 'Existing members must not be offered as additions.');
    assert.deepEqual(attachments.additionalMemberIds.items.enum, [incoming.id]);
    const causal = schema.relations.properties.proposals.items.properties;
    assert.deepEqual(causal.anchorMemoryId.enum, [incoming.id]);
    assert.deepEqual(causal.relatedMemoryId.enum, [old.id]);
    assert.deepEqual(causal.direction.enum, ['anchor_to_related', 'related_to_anchor'], 'History does not determine causal direction.');
    return Response.json({ model: wire.model, choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
      tool_calls: [{ type: 'function', function: { name: wire.tools[0].function.name, arguments: JSON.stringify(output) } }] } }],
      usage: { prompt_tokens: 123, completion_tokens: 33 } });
  } });
  const result = await runMemoryConsolidation({ repository, agentId, runId: plan.id, structureGenerator: generator, relationGenerator: generator });
  assert.equal(result.status, 'completed', result.error); assert.equal(calls, 1);
  assert.equal(result.structure.proposed.length, 2); assert.equal(result.structure.rejected.length, 1);
  assert.deepEqual(new Set(result.structure.proposed.find(proposal => proposal.operation === 'create').memberIds), new Set(['old', 'new']));
  assert.equal(result.relations.proposed.length, 1); assert.equal(result.relations.rejected.length, 3);
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
      const combined = schemas.at(-1) === 'memory-consolidation-combined-v2';
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
      const proposal = { relation: 'reason_for', scope: '这次场馆参观',
        anchorMemoryId: newer.id, relatedMemoryId: older.id, direction: 'related_to_anchor',
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
    assert.deepEqual(schemas, ['memory-consolidation-combined-v2', ...(needsFullEvidence ? ['memory-relation-proposals-v2'] : [])]);
    assert.deepEqual(result.relations.rejected, []);
    const relation = repository.listRelationProposals(agentId)[0];
    assert.equal(relation.from_memory_id, 'old'); assert.equal(relation.to_memory_id, 'new');
    assert.equal(relation.relation, 'reason_for');
    assert.equal(relation.metadata.scope, '这次场馆参观');
    assert.equal(repository.getEdge(agentId, relation.result_edge_id).metadata.scope, '这次场馆参观');
    assert.deepEqual(relation.evidence.map(item => item.id), [source.id]);
    assert.equal(repository.getSource(source.id).content, content);
    const usage = await readUsageEvents(ledgerPath);
    assert.equal(usage.events.length, schemas.length);
    assert.equal(usage.events.reduce((total, item) => total + item.usage.prompt_tokens, 0), schemas.length * 100);
  }
});

test('verified causal passages fit independently of unused full evidence, including an indivisible fallback', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const passage = 'Because the venue was closed, Lin cancelled the visit.';
  const content = 'Unrelated background. '.repeat(5000) + passage;
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'long-causal-source', content,
    metadata: { causalExcerpt: locateCausalExcerpt(content, { start: 'Because the venue was closed,', end: 'Lin cancelled the visit.' }) } });
  for (const [id, text] of [['old', 'The venue was closed.'], ['new', 'Lin cancelled the visit.']]) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: text });
    repository.linkSource(id, source.id);
  }
  repository.upsertEdge({ agentId, fromMemoryId: 'new', toMemoryId: 'old', relation: 'associated_with', weight: 1, confidence: 1 });
  let needsFullEvidence = false;
  const calls = [];
  const generator = Object.assign(async request => {
    calls.push(request);
    const input = JSON.parse(request.input);
    assert.equal(input.sourceRecords[0].content, passage);
    return { output: request.schemaName === 'memory-consolidation-combined-v2'
      ? { structure: { proposals: [] }, relations: { needsFullEvidence, proposals: [] } }
      : { needsFullEvidence, proposals: [] } };
  }, { supportsCombinedConsolidation: true });
  const standalone = await proposeRelationsForBatch({ repository, agentId, memoryIds: ['old', 'new'],
    generator, maximumRequestCharacters: 10000 });
  assert.equal(standalone.status, 'no-valid-proposals');
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['new'] });
  const result = await runMemoryConsolidation({ repository, agentId, runId: plan.id,
    structureGenerator: generator, relationGenerator: generator });
  assert.equal(result.status, 'no-proposals', result.error);
  assert.equal(calls.length, 2, 'Unused full evidence must not partition or block a request.');
  needsFullEvidence = true;
  const fallback = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['new'], policyVersion: 'fallback-review' });
  const blocked = await runMemoryConsolidation({ repository, agentId, runId: fallback.id,
    structureGenerator: generator, relationGenerator: generator });
  assert.equal(blocked.status, 'failed');
  assert.equal(blocked.run.review_state, 'pending');
  assert.equal(calls.length, 3, 'An indivisible full request must enter review before contacting the provider.');
  assert.equal(repository.getSource(source.id).content, content);
});

test('requested full evidence partitions and resumes without repeating excerpts or completed structure work', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const incoming = ['visit-a', 'visit-b', 'visit-c', 'visit-d'];
  repository.upsertMemory({ id: 'closure', agentId, kind: 'event', layer: 'episodic', content: 'The venue was closed.' });
  for (const id of incoming) {
    const passage = `Because the venue was closed, Lin cancelled ${id}.`;
    const content = 'Other background. '.repeat(260) + passage;
    const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: id, content,
      metadata: { causalExcerpt: locateCausalExcerpt(content, { start: 'Because the venue was closed,', end: `Lin cancelled ${id}.` }) } });
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: `Lin cancelled ${id}.` });
    repository.linkSource(id, source.id);
    repository.upsertEdge({ agentId, fromMemoryId: id, toMemoryId: 'closure', relation: 'associated_with', weight: 1, confidence: 1 });
  }
  let excerptCalls = 0, fullCalls = 0;
  const pairs = new Set(), successfulInputs = new Set();
  const generator = Object.assign(async request => {
    const input = JSON.parse(request.input);
    if (request.schemaName === 'memory-consolidation-combined-v2') {
      excerptCalls++;
      assert.ok(input.sourceRecords.every(source => source.excerpt));
      return { output: { structure: { proposals: [] }, relations: { needsFullEvidence: true, proposals: [] } } };
    }
    fullCalls++;
    assert.ok(input.sourceRecords.every(source => !source.excerpt && source.content.startsWith('Other background. ')));
    if (fullCalls === 2) throw new Error('Temporary full-evidence provider failure.');
    const scope = input.relationContext;
    for (const a of scope.anchorMemoryIds) for (const b of [...scope.candidateMemoryIds,
      ...(scope.includeAnchorPairs ? scope.anchorMemoryIds : [])]) if (a !== b) pairs.add([a, b].sort().join(':'));
    assert.ok(!successfulInputs.has(request.input), 'Completed full-evidence scopes must not replay.');
    successfulInputs.add(request.input);
    return { output: { proposals: [] } };
  }, { supportsCombinedConsolidation: true });
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: incoming });
  // Full evidence for two incoming memories plus the closure fits exactly;
  // the complete four-memory batch must split. The newly covered incoming
  // pairs each have two full sources and must also fit this same budget.
  const sample = prepareRelationGeneration({ repository, agentId, memoryIds: [...incoming.slice(0, 2), 'closure'],
    snapshotOptions: { retrospective: { triggerMemoryIds: incoming.slice(0, 2), historicalMemoryIds: ['closure'] },
      relationContext: { anchorMemoryIds: incoming.slice(0, 2), candidateMemoryIds: ['closure'], includeAnchorPairs: true } },
    useSourceExcerpts: false, maximumRequestCharacters: Infinity }).request;
  const fullBudget = sample.input.length + sample.systemPrompt.length + JSON.stringify(sample.schema).length;
  const run = () => runMemoryConsolidation({ repository, agentId, runId: plan.id,
    structureGenerator: generator, relationGenerator: generator,
    structureOptions: { maximumRequestCharacters: 5000 }, relationOptions: { maximumRequestCharacters: fullBudget } });
  assert.equal((await run()).status, 'retry-pending');
  const result = await run();
  assert.equal(result.status, 'no-proposals', result.error);
  assert.equal(excerptCalls, 1, 'A request for full evidence survives partitioning and provider retries.');
  const expected = new Set(incoming.map(id => ['closure', id].sort().join(':')));
  for (const a of incoming) for (const b of incoming) if (a !== b) expected.add([a, b].sort().join(':'));
  assert.deepEqual(pairs, expected);
  assert.equal(fullCalls, successfulInputs.size + 1, 'Only the failed full-evidence call repeats.');
});

test('a relation persistence failure stays retryable and does not replay successful structure work', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'cause',
    content: 'Because the venue was closed, Lin cancelled the visit.' });
  for (const [id, content] of [['old', 'The venue was closed.'], ['new', 'Lin cancelled the visit.']]) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content });
    repository.linkSource(id, source.id);
  }
  repository.upsertEdge({ agentId, fromMemoryId: 'new', toMemoryId: 'old', relation: 'associated_with', weight: 1, confidence: 1 });
  const original = repository.recordRelationProposal.bind(repository);
  let writes = 0, structureCalls = 0, relationCalls = 0;
  repository.recordRelationProposal = value => {
    if (++writes === 1) throw new Error('Temporary persistence failure.');
    return original(value);
  };
  const structureGenerator = async () => { structureCalls++; return { output: { proposals: [] } }; };
  const relationGenerator = async () => {
    relationCalls++;
    return { output: { proposals: [{ relation: 'causes', fromMemoryId: 'old', toMemoryId: 'new',
      evidenceSourceIds: [source.id], confidence: 0.95, rationale: source.content }] } };
  };
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['new'] });
  const run = () => runMemoryConsolidation({ repository, agentId, runId: plan.id, structureGenerator, relationGenerator });
  const first = await run();
  assert.equal(first.status, 'retry-pending');
  assert.match(first.relations.rejected[0].error, /Temporary persistence failure/);
  assert.equal(repository.listRelationProposals(agentId).length, 0);
  assert.equal((await run()).status, 'completed');
  assert.equal(repository.listRelationProposals(agentId).length, 1);
  assert.equal(structureCalls, 1);
  assert.equal(relationCalls, 2);
});

test('organization rejects unrelated causal evidence once, preserves valid siblings and records actionable diagnostics', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'cause',
    content: 'Because the venue was closed, Lin cancelled the visit.' });
  const unrelated = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'other', content: 'Lin likes tea.' });
  for (const [id, evidence] of [['closed', source], ['cancelled', source], ['tea', unrelated]]) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: id });
    repository.linkSource(id, evidence.id);
  }
  let calls = 0;
  const relationGenerator = async () => {
    calls++;
    const valid = { relation: 'causes', fromMemoryId: 'closed', toMemoryId: 'cancelled',
      evidenceSourceIds: [source.id], confidence: 0.9, rationale: source.content };
    return { requestId: 'provider-request-1', output: { proposals: [
      { ...valid, evidenceSourceIds: [source.id, unrelated.id] }, valid,
    ] } };
  };
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['closed', 'cancelled', 'tea'] });
  const run = () => runMemoryConsolidation({ repository, agentId, runId: plan.id, relationGenerator });
  const report = await run();
  assert.equal(report.status, 'completed');
  assert.equal(report.relations.proposed.length, 1);
  const rejection = report.relations.rejected[0];
  assert.equal(rejection.category, 'invalid-candidate');
  assert.equal(rejection.retryable, false);
  assert.deepEqual(rejection.candidate.evidenceSourceIds, [source.id, unrelated.id]);
  assert.ok(rejection.inputHash);
  assert.equal(rejection.requestId, 'provider-request-1');
  assert.equal((await run()).status, 'already-finished');
  assert.equal(calls, 1, 'A deterministic candidate error must not purchase another generation.');
  assert.deepEqual(repository.getConsolidationRun(agentId, plan.id).metadata.organizationProgress.parts[0].relations.rejected, [rejection]);
});

test('organization replans changed input after a partial run while retaining its recorded outputs', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'cause', content: 'Because the old event happened, the new event followed.' });
  for (const id of ['old', 'new']) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: id });
    repository.linkSource(id, source.id);
  }
  repository.upsertEdge({ agentId, fromMemoryId: 'new', toMemoryId: 'old', relation: 'associated_with', weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['new'] });
  let calls = 0;
  const first = await runMemoryConsolidation({ repository, agentId, runId: plan.id,
    structureGenerator: async () => { calls++; return { output: { proposals: [{ operation: 'create', kind: 'topic',
      memberIds: ['new', 'old'], content: 'These events form a topic.' }] } }; },
    relationGenerator: async () => { throw new Error('Provider temporarily unavailable.'); } });
  assert.equal(first.status, 'retry-pending');
  assert.equal(first.run.structureProposalIds.length, 1);
  repository.editMemoryManually({ agentId, memoryId: 'old', patch: { content: 'Corrected historical event.' } });
  const resumed = await runMemoryConsolidation({ repository, agentId, runId: plan.id,
    structureGenerator: async () => { throw new Error('Stale work must be replanned before generation.'); } });
  assert.equal(resumed.status, 'replanned');
  assert.equal(resumed.run.status, 'cancelled');
  assert.deepEqual(resumed.run.structureProposalIds, first.run.structureProposalIds, 'Retiring a run must preserve its audit trail.');
  assert.notEqual(resumed.replacementRun.id, plan.id);
  assert.equal(repository.getStructureProposal(agentId, first.run.structureProposalIds[0]).review_state, 'dismissed');
  const generator = async request => {
    calls++;
    assert.match(request.input, /Corrected historical event/);
    return { output: { proposals: [] } };
  };
  deferSmallConsolidationRuns({ repository, agentId, minimumMemories: 20 });
  const finished = await processPlannedConsolidationRuns({ repository, agentId, generator, minimumTriggerMemories: 20, maximumRuns: 10 });
  assert.equal(finished.selected, 1, 'A replacement for already started work must not return to the initial accumulation threshold.');
  assert.equal(finished.results[0].runId, resumed.replacementRun.id);
  assert.equal(finished.results[0].status, 'no-proposals');
  assert.equal(calls, 3);
});

test('organization preserves an unaffected causal sibling when evidence changes while the model is running', async t => {
  const database = openMemoryDatabase(':memory:'); t.after(() => database.close());
  const repository = new MemoryRepository(database), agentId = 'owner';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'cause', content: 'Because A, B. Because C, D.' });
  for (const id of ['a', 'b', 'c', 'd']) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', content: id });
    repository.linkSource(id, source.id);
  }
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['a', 'b', 'c', 'd'] });
  const report = await runMemoryConsolidation({ repository, agentId, runId: plan.id, relationGenerator: async () => {
    repository.editMemoryManually({ agentId, memoryId: 'a', patch: { content: 'Corrected A.' } });
    return { output: { proposals: [['a', 'b'], ['c', 'd']].map(([fromMemoryId, toMemoryId]) => ({ relation: 'causes',
      fromMemoryId, toMemoryId, evidenceSourceIds: [source.id], rationale: source.content, confidence: 0.9 })) } };
  } });
  assert.equal(report.status, 'replanned');
  const pending = repository.listRelationProposals(agentId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].from_memory_id, 'c');
  assert.deepEqual(report.run.relationProposalIds, [pending[0].id]);
  assert.equal(report.run.metadata.organizationProgress.parts[0].relations.rejected[0].category, 'stale-input');
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
      assert.ok(target.memberIds.includes(material.memories[0].id));
      const selection = wire.tools[0].function.parameters.properties.structure.properties.attachments.items.properties.selection;
      assert.deepEqual(selection.anyOf[0].properties.firstMemberId.enum, [older.id]);
      return Response.json({ model: 'fixture', choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function',
        function: { name: wire.tools[0].function.name, arguments: JSON.stringify({
          structure: { creations: [], attachments: [{ selection: { targetMemoryId: target.id, firstMemberId: older.id }, title: '', content: summary,
            additionalMemberIds: [], confidence: 0.9, rationale: 'The earlier activities develop the same topic.' }] },
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
    if (!selected) return { output: { proposals: [] } }; // The two cancellations do not cause each other.
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
