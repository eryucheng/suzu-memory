import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import { createTestDirectory, closeAfterTests } from '../../../test/support/suite-resources.mjs';
import { locateCausalExcerpt, MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { planMemoryConsolidation, runMemoryConsolidation, memoryBudgetError, refreshStructureSummary } from '../src/index.mjs';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';
import { withUsageRecorder } from '@suzu-memory/usage-ledger';
import { createOpenAiCompatibleStructuredGenerator } from '@suzu-memory/providers';

function fixture(t, databasePath = ':memory:', { content = 'Lin planned a museum visit. The museum was closed, so Lin cancelled it and received a refund.', metadata } = {}) {
  const database = closeAfterTests(openMemoryDatabase(databasePath));
  const repository = new MemoryRepository(database), agentId = 'owner';
  const source = repository.upsertSource({ agentId, sourceKind: 'conversation', externalId: 'evidence',
    content, metadata });
  for (const [id, content] of [['old', 'Lin planned a museum visit.'], ['closed', 'The museum was closed.'],
    ['cancelled', 'Lin cancelled the visit.'], ['refund', 'Lin received a refund.']]) {
    repository.upsertMemory({ id, agentId, kind: 'event', layer: 'episodic', title: id, content,
      subjectRole: 'user', subjectKey: 'lin' });
    repository.linkSource(id, source.id);
  }
  repository.upsertEdge({ agentId, fromMemoryId: 'closed', toMemoryId: 'old', relation: 'associated_with', weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ repository, agentId, triggerMemoryIds: ['closed','cancelled','refund'], organizeNewMemories: true });
  return { database, repository, agentId, source, plan };
}
const creation = (memberIds, title = 'Museum visit') => ({ operation: 'create', kind: 'episode', title, memberIds,
  subjectRole: 'user', subjectKey: 'lin', actorRoles: [], confidence: 0.9, rationale: 'The source describes this one visit.' });

test('one organization plan covers new-only and new/history groups and summarizes the final memberships', async t => {
  const f = fixture(t), calls = [];
  const generator = async request => {
    assertMemoryTaskRequest(request); calls.push(request);
    let output;
    if (request.schemaName === 'memory-organization-decisions-v2') {
      assert.ok(!request.schema.properties.structure.properties.proposals.items.anyOf[0].properties.content);
      const input = JSON.parse(request.input);
      assert.deepEqual(new Set(input.memories.map(memory => memory.id)), new Set(['old','closed','cancelled','refund']));
      output = { structure: { proposals: [creation(['old','closed','cancelled']), creation(['cancelled','refund'], 'Cancellation and refund')] },
        relations: { proposals: [{ relation: 'causes', fromMemoryId: 'closed', toMemoryId: 'cancelled',
          evidenceSourceIds: [f.source.id], confidence: 0.9, rationale: 'The closure caused cancellation.' }] } };
    } else {
      assert.equal(request.schemaName, 'memory-structure-summary-batch-v1');
      const input = JSON.parse(request.input);
      assert.equal(input.memories.length, 4, 'Shared summary members are supplied once.');
      output = Object.fromEntries(input.groups.map(group => [group.key,
        { title: 'Museum visit', content: 'Lin cancelled the museum visit after the closure and received a refund.' }]));
    }
    validateMemoryTaskOutput(request, output);
    return { output };
  };
  generator.supportsCombinedConsolidation = true;
  const run = () => runMemoryConsolidation({ ...f, runId: f.plan.id, structureGenerator: generator, relationGenerator: generator });
  const result = await run();
  assert.equal(result.status, 'completed', result.error);
  assert.equal(calls.length, 2);
  const proposals = f.repository.listStructureProposals(f.agentId);
  assert.equal(proposals.length, 2);
  assert.deepEqual(proposals.map(p => p.memberIds.slice().sort()).sort(), [['old','closed','cancelled'].sort(), ['cancelled','refund'].sort()].sort());
  assert.equal(f.repository.listRelationProposals(f.agentId).length, 1);
  assert.equal((await run()).status, 'already-finished'); assert.equal(calls.length, 2);
});

test('summary partial success retains the good container and retries only the missing summary', async t => {
  const directory = createTestDirectory(path.join(os.tmpdir(), 'planned-organization-'));
  const databasePath = path.join(directory, 'memory.db');
  const f = fixture(t, databasePath); let decisions = 0, summaries = 0;
  const generator = async request => {
    if (request.schemaName === 'memory-organization-decisions-v2') {
      decisions++;
      return { output: { structure: { proposals: [creation(['old','closed']), creation(['cancelled','refund'], 'Refund')] }, relations: { proposals: [] } } };
    }
    summaries++;
    if (summaries === 1) return { output: { group1: { title: 'Visit', content: 'The planned museum visit encountered a closure.' } } };
    assert.equal(request.schemaName, 'memory-structure-summary-v1');
    assert.deepEqual(JSON.parse(request.input).members.map(m => m.title).sort(), ['cancelled','refund']);
    return { output: { title: 'Refund', content: 'Cancellation led to a refund.' } };
  };
  generator.supportsCombinedConsolidation = true;
  const run = () => runMemoryConsolidation({ ...f, runId: f.plan.id, structureGenerator: generator, relationGenerator: generator });
  assert.equal((await run()).status, 'retry-pending');
  assert.equal(f.repository.listStructureProposals(f.agentId).length, 1);
  f.database.close();
  f.database = closeAfterTests(openMemoryDatabase(databasePath));
  f.repository = new MemoryRepository(f.database);
  const second = await run(); assert.equal(second.status, 'completed', second.error);
  assert.equal(decisions, 1); assert.equal(summaries, 2);
  assert.equal(f.repository.listStructureProposals(f.agentId).length, 2);
});

test('partitioned membership decisions extend one planned group and summarize all final members once', async t => {
  const f = fixture(t); let summaries = 0, decisions = 0;
  ['old','closed','cancelled','refund'].forEach((id, index) => f.database.prepare('UPDATE memory_nodes SET event_start = ? WHERE id = ?')
    .run(`2026-01-0${index + 1}T08:00:00.000Z`, id));
  f.plan = planMemoryConsolidation({ ...f, triggerMemoryIds: ['closed','cancelled','refund'], organizeNewMemories: true });
  const generator = Object.assign(async request => {
    const input = JSON.parse(request.input);
    if (request.schemaName === 'memory-structure-summary-v1') {
      summaries++;
      assert.deepEqual(new Set(input.members.map(memory => memory.title)), new Set(['old','closed','cancelled','refund']));
      return { output: { title: 'Museum visit', content: 'The planned visit was cancelled because the museum closed; Lin received a refund.' } };
    }
    assert.equal(request.schemaName, 'memory-structure-memberships-v1'); decisions++;
    assert.equal(f.repository.listStructureProposals(f.agentId).length, 0, 'Incomplete membership has no materialized intermediate summary.');
    const target = input.candidateContainers.find(container => container.planned);
    if (target) assert.ok(target.eventStart, 'Later parts can distinguish a planned episode by its derived time boundary.');
    const additions = input.memories.filter(memory => !target?.memberIds.includes(memory.id)).map(memory => memory.id);
    return { output: { proposals: !additions.length ? [] : target
      ? [{ operation: 'attach', targetMemoryId: target.id, memberIds: additions, confidence: 0.9, rationale: 'Later stages of the same visit.' }]
      : additions.length >= 2 ? [creation(additions)] : [] } };
  }, { assertRequestBudget(request) {
    if (request.schemaName === 'memory-structure-memberships-v1' && JSON.parse(request.input).memories.length > 2) throw memoryBudgetError('Two complete memories fit this fixture budget.');
  } });
  const result = await runMemoryConsolidation({ ...f, runId: f.plan.id, structureGenerator: generator });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(decisions > 1); assert.equal(summaries, 1);
  const proposals = f.repository.listStructureProposals(f.agentId);
  assert.equal(proposals.length, 1);
  assert.deepEqual(new Set(proposals[0].memberIds), new Set(['old','closed','cancelled','refund']));
  assert.equal(proposals[0].event_start, '2026-01-01T08:00:00.000Z');
  assert.equal(proposals[0].event_end, '2026-01-04T08:00:00.000Z');
});

for (const changed of ['source', 'target', 'membership']) test(`planned summaries invalidate changed ${changed} and replan with current evidence`, async t => {
  const f = fixture(t);
  const topic = f.repository.upsertTopic({ agentId: f.agentId, title: 'Museum', content: 'The planned visit.', subjectRole: 'user', subjectKey: 'lin' });
  f.repository.linkMemoryToTopic({ agentId: f.agentId, topicId: topic.id, memoryId: 'old' });
  const plan = planMemoryConsolidation({ ...f, triggerMemoryIds: ['closed','cancelled'], organizeNewMemories: true });
  let decisions = 0, summaries = 0;
  const generator = async request => {
    if (request.schemaName === 'memory-structure-memberships-v1') {
      decisions++;
      assert.ok(JSON.parse(request.input).candidateContainers.some(container => container.id === topic.id));
      return { output: { proposals: [{ operation: 'attach', targetMemoryId: topic.id, memberIds: ['closed','cancelled'], confidence: 0.9, rationale: 'Same visit.' }] } };
    }
    summaries++;
    if (summaries === 1) {
      if (changed === 'source') f.repository.upsertSource({ ...f.source, agentId: f.agentId, sourceKind: 'conversation', externalId: 'evidence', content: 'Correction: the closure was temporary; Lin cancelled this visit.' });
      if (changed === 'target') f.repository.editMemoryManually({ agentId: f.agentId, memoryId: topic.id, patch: { content: 'Reviewed museum plans.' } });
      if (changed === 'membership') f.repository.linkMemoryToTopic({ agentId: f.agentId, topicId: topic.id, memoryId: 'refund' });
    }
    return { output: { title: 'Museum', content: 'The visit was cancelled following a closure.' } };
  };
  const first = await runMemoryConsolidation({ ...f, runId: plan.id, structureGenerator: generator });
  assert.equal(first.status, 'replanned', first.error);
  assert.notEqual(first.replacementRun.id, plan.id);
  assert.equal(f.repository.listStructureProposals(f.agentId).length, 0);
  const second = await runMemoryConsolidation({ ...f, runId: first.replacementRun.id, structureGenerator: generator });
  assert.equal(second.status, 'completed', second.error);
  assert.equal(decisions, 2); assert.equal(summaries, 2);
  assert.equal(f.repository.listStructureProposals(f.agentId).length, 1);
});

test('invalid membership is rejected before summary generation while a valid sibling completes', async t => {
  const f = fixture(t); let summaries = 0;
  const result = await runMemoryConsolidation({ ...f, runId: f.plan.id, structureGenerator: async request => {
    if (request.schemaName === 'memory-structure-memberships-v1') return { output: { proposals: [null,
      { ...creation(['old','closed']), actorRoles: [{ role: 'subject', actorRole: 'user', actorKey: 'someone-else', isPrimary: true, confidence: 0.9 }] },
      creation(['cancelled','refund']),
    ] } };
    summaries++;
    assert.deepEqual(JSON.parse(request.input).members.map(m => m.title).sort(), ['cancelled','refund']);
    return { output: { title: 'Refund', content: 'Cancellation and refund.' } };
  } });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(summaries, 1); assert.equal(f.repository.listStructureProposals(f.agentId).length, 1);
  assert.equal(result.structure.rejected.length, 2);
  assert.ok(result.structure.rejected.some(item => item.code === 'MEMORY_STRUCTURE_INVALID_SUBJECT'));
});

for (const missing of ['structure', 'relations']) test(`the native organization wire retains the valid sibling when ${missing} is absent and bills each call once`, async t => {
  const f = fixture(t), calls = [], charges = [];
  let current;
  const native = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://provider.test', apiKey: 'fixture', model: 'fixture', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, { body }) => {
      const payload = JSON.parse(body), input = JSON.parse(payload.messages[1].content), tool = payload.tools[0].function;
      let output;
      if (current.schemaName === 'memory-structure-summary-v1') output = { title: 'Visit', content: 'The closure caused cancellation.' };
      else {
        const memories = [...(input.historicalMaterial?.memories || []), ...input.memories];
        const id = title => memories.find(memory => memory.title === title).id;
        const structure = { creations: [{ kind: 'episode', title: 'Visit', firstMemberId: id('closed'), secondMemberId: id('cancelled'),
          additionalMemberIds: [], subjectRole: 'user', subjectKey: 'lin', actorRoles: [], confidence: 0.9, rationale: 'Same visit.' }], attachments: null };
        const relations = { proposals: [{ relation: 'reason_for', scope: '这次参观',
          anchorMemoryId: id('closed'), relatedMemoryId: id('cancelled'), direction: 'anchor_to_related',
          evidenceSourceIds: [...(input.historicalMaterial?.sourceRecords || []), ...(input.sourceRecords || [])].slice(0, 1).map(source => source.id),
          confidence: 0.9, rationale: 'Closure caused cancellation.' }] };
        if (current.schemaName === 'memory-organization-decisions-v2') {
          assert.ok(!tool.parameters.properties.structure.properties.creations.items.properties.content);
          output = { structure, relations }; delete output[missing];
        } else output = current.schemaName === 'memory-structure-memberships-v1' ? structure : relations;
      }
      return Response.json({ id: `receipt-${calls.length}`, model: 'fixture', usage: { prompt_tokens: 100, completion_tokens: 20 },
        choices: [{ message: { tool_calls: [{ function: { name: tool.name, arguments: JSON.stringify(output) } }] } }] });
    },
  });
  const generator = Object.assign(request => { current = request; calls.push(request.schemaName); return native(request); },
    { supportsCombinedConsolidation: true, measureRequest: native.measureRequest });
  const options = { ...f, runId: f.plan.id, structureGenerator: generator, relationGenerator: generator,
    structureOptions: { usageLedgerPath: 'unused' }, relationOptions: { usageLedgerPath: 'unused' } };
  await withUsageRecorder(charge => charges.push(charge), async () => {
    assert.equal((await runMemoryConsolidation(options)).status, 'retry-pending');
    const second = await runMemoryConsolidation(options);
    assert.equal(second.status, 'completed', second.error);
  });
  assert.deepEqual(calls, ['memory-organization-decisions-v2', missing === 'structure'
    ? 'memory-structure-memberships-v1' : 'memory-relation-proposals-v2', 'memory-structure-summary-v1']);
  assert.equal(charges.length, 3); assert.equal(new Set(charges.map(charge => charge.requestId)).size, 3);
  assert.equal(f.repository.listRelationProposals(f.agentId).length, 1);
  const relation = f.repository.listRelationProposals(f.agentId)[0];
  assert.equal(relation.relation, 'reason_for');
  assert.equal(f.repository.getEdge(f.agentId, relation.result_edge_id).metadata.scope, '这次参观');
  assert.equal(f.repository.listStructureProposals(f.agentId).length, 1);
});

test('a split of historical candidates keeps the full tool and common new evidence at the start of both requests', async t => {
  const f = fixture(t), wires = [];
  const triggerMemoryIds = ['closed','cancelled'];
  for (const id of ['tickets', 'hours', 'parking']) {
    f.repository.upsertMemory({ id, agentId: f.agentId, kind: 'event', layer: 'episodic', title: id, content: 'Museum ' + id + '.' });
    f.repository.linkSource(id, f.source.id);
    f.repository.upsertEdge({ agentId: f.agentId, fromMemoryId: 'closed', toMemoryId: id,
      relation: 'associated_with', weight: 1, confidence: 1 });
  }
  const plan = planMemoryConsolidation({ ...f, triggerMemoryIds, organizeNewMemories: true });
  assert.deepEqual(new Set(plan.candidateIds), new Set(['old', 'tickets', 'hours', 'parking']));
  const native = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://provider.test', apiKey: 'fixture', model: 'fixture', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, { body }) => {
      const payload = JSON.parse(body);
      wires.push(payload);
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: payload.tools[0].function.name,
        arguments: JSON.stringify({ structure: { creations: [], attachments: [] }, relations: { proposals: [] } }) } }] } }] });
    },
  });
  const generator = Object.assign(request => native(request), { supportsCombinedConsolidation: true,
    measureRequest: native.measureRequest, assertRequestBudget(request) {
      if (JSON.parse(request.input).relationContext.candidateMemoryIds.length > 2) throw memoryBudgetError('Fixture historical budget.');
    },
  });
  const result = await runMemoryConsolidation({ ...f, runId: plan.id, structureGenerator: generator, relationGenerator: generator });
  assert.equal(result.status, 'no-proposals', result.error);
  assert.equal(wires.length, 2);
  const [left, right] = wires;
  assert.deepEqual(left.tools, right.tools, 'Varying candidate IDs must be after the shared tool definition.');
  assert.equal(left.messages[0].content, right.messages[0].content);
  const bodies = wires.map(wire => JSON.parse(wire.messages[1].content));
  const sharedPrefix = JSON.stringify({ memories: bodies[0].memories, sourceRecords: bodies[0].sourceRecords }).slice(0, -1);
  for (const [index, body] of bodies.entries()) {
    assert.deepEqual(new Set(body.memories.map(memory => memory.title)), new Set(triggerMemoryIds));
    assert.deepEqual(body.sourceRecords.map(source => source.content), [f.source.content]);
    assert.ok(wires[index].messages[1].content.startsWith(sharedPrefix), 'The complete common evidence must precede the varying part.');
    const { anchorMemoryId, relatedMemoryId } = body.selectionScope.relations;
    assert.deepEqual(anchorMemoryId, body.memories.map(memory => memory.id));
    assert.ok(body.historicalMaterial.memories.every(memory => relatedMemoryId.includes(memory.id)));
  }
  assert.deepEqual(new Set(bodies.flatMap(body => body.historicalMaterial.memories.map(memory => memory.title))), new Set(plan.candidateIds));
});

test('organization preserves the directed edge of swappable relation slots and rejects out-of-scope siblings', async t => {
  const f = fixture(t);
  const topic = f.repository.upsertTopic({ agentId: f.agentId, title: 'Visit', content: 'This visit was planned.',
    subjectRole: 'user', subjectKey: 'lin' });
  f.repository.linkMemoryToTopic({ agentId: f.agentId, topicId: topic.id, memoryId: 'closed' });
  f.repository.upsertMemory({ id: 'booked', agentId: f.agentId, kind: 'event', layer: 'episodic',
    title: 'booked', content: 'Lin had previously booked the visit.' });
  f.repository.linkSource('booked', f.source.id);
  f.repository.upsertEdge({ agentId: f.agentId, fromMemoryId: 'cancelled', toMemoryId: 'booked',
    relation: 'associated_with', weight: 1, confidence: 1 });
  const plan = planMemoryConsolidation({ ...f, triggerMemoryIds: ['closed','cancelled'], organizeNewMemories: true });
  const generator = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://provider.test', apiKey: 'fixture', model: 'fixture', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, { body }) => {
      const payload = JSON.parse(body), input = JSON.parse(payload.messages[1].content), tool = payload.tools[0].function;
      const summary = { title: 'Visit', content: 'The closure caused a cancelled visit.' };
      let output = input.groups ? Object.fromEntries(input.groups.map(group => [group.key, summary])) : summary;
      if (input.historicalMaterial) {
        const memories = [...input.historicalMaterial.memories, ...input.memories];
        const id = title => memories.find(memory => memory.title === title).id;
        const container = input.candidateContainers.find(item => item.title === 'Visit');
        const evidence = [...input.historicalMaterial.sourceRecords, ...input.sourceRecords];
        const { operation, memberIds, ...fields } = creation(['closed','cancelled']);
        const validCreation = { ...fields, firstMemberId: id('closed'), secondMemberId: id('cancelled'), additionalMemberIds: [] };
        const validRelation = { relation: 'causes', scope: '', anchorMemoryId: id('closed'), relatedMemoryId: id('cancelled'),
          direction: 'anchor_to_related', evidenceSourceIds: [evidence[0].id], confidence: 0.9, rationale: 'Closure caused cancellation.' };
        const swapped = { ...validRelation, relation: 'condition_for', anchorMemoryId: id('old'),
          relatedMemoryId: id('cancelled'), rationale: 'The planned visit was the context for the cancellation.' };
        output = {
          structure: { creations: [validCreation, { ...validCreation, title: 'Invalid history slot',
            firstMemberId: id('old'), secondMemberId: id('cancelled') }],
          attachments: [{ selection: { targetMemoryId: container.id, firstMemberId: id('closed') },
            additionalMemberIds: [id('cancelled')], confidence: 0.9, rationale: 'Proposed addition.' }] },
          relations: { proposals: [validRelation, swapped,
            { ...swapped, relatedMemoryId: id('booked') },
            { ...swapped, direction: 'unknown' },
            { ...swapped, evidenceSourceIds: [] }] },
        };
      }
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: tool.name, arguments: JSON.stringify(output) } }] } }] });
    },
  });
  const result = await runMemoryConsolidation({ ...f, runId: plan.id, structureGenerator: generator, relationGenerator: generator });
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(result.structure.rejected.map(item => item.code), Array(2).fill('MEMORY_ORGANIZATION_INVALID_SELECTION'));
  assert.deepEqual(result.relations.rejected.map(item => item.code),
    ['MEMORY_ORGANIZATION_INVALID_SELECTION', 'MEMORY_ORGANIZATION_INVALID_SELECTION', 'MEMORY_ORGANIZATION_INVALID_CANDIDATE']);
  assert.deepEqual(f.repository.listStructureProposals(f.agentId).map(item => item.memberIds.sort()), [['cancelled','closed']]);
  const relations = f.repository.listRelationProposals(f.agentId);
  assert.deepEqual(relations.map(item => [item.from_memory_id, item.to_memory_id]).sort(), [['closed','cancelled'], ['old','cancelled']]);
  assert.ok(f.repository.findEdge({ agentId: f.agentId, fromMemoryId: 'closed', toMemoryId: 'cancelled', relation: 'causes' }));
  assert.ok(f.repository.findEdge({ agentId: f.agentId, fromMemoryId: 'old', toMemoryId: 'cancelled', relation: 'condition_for' }));
});

for (const fullFits of [true, false]) test(fullFits ? 'a full causal source uses the actual combined request budget'
  : 'when full evidence exceeds the combined budget, excerpted organization can request full evidence and resume', async t => {
  const start = 'The museum was closed,', end = 'Lin cancelled it and received a refund.';
  const excerpt = `${start} so ${end}`;
  const content = 'Details about the planned visit. '.repeat(240) + excerpt;
  const f = fixture(t, ':memory:', { content, metadata: { causalExcerpt: locateCausalExcerpt(content, { start, end }) } });
  const requests = [];
  const generator = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://provider.test', apiKey: 'fixture', model: 'fixture', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, { body }) => {
      const payload = JSON.parse(body), input = JSON.parse(payload.messages[1].content), tool = payload.tools[0].function;
      const combined = Object.hasOwn(tool.parameters.properties, 'structure');
      const schema = combined ? tool.parameters.properties.relations : tool.parameters;
      const memories = [...(input.historicalMaterial?.memories || []), ...input.memories];
      const sources = [...(input.historicalMaterial?.sourceRecords || []), ...input.sourceRecords];
      assert.equal(sources.length, 1);
      const excerpted = Object.hasOwn(schema.properties, 'needsFullEvidence');
      assert.equal(sources[0].content, excerpted ? excerpt : content);
      assert.equal(Boolean(sources[0].excerpt), excerpted);
      requests.push({ combined, excerpted });
      const id = title => memories.find(memory => memory.title === title).id;
      const proposal = { relation: 'causes', scope: '', anchorMemoryId: id('closed'), relatedMemoryId: id('cancelled'),
        direction: 'anchor_to_related', evidenceSourceIds: [sources[0].id], confidence: 0.9,
        rationale: 'The source says Lin cancelled because the museum was closed.' };
      const relations = { proposals: [proposal], ...(excerpted ? { needsFullEvidence: !fullFits } : {}) };
      const output = combined ? { structure: { creations: [], attachments: [] }, relations }
        : requests.length === 2 ? { links: [] } : relations;
      return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: tool.name,
        arguments: JSON.stringify(output) } }] } }] });
    },
  });
  generator.assertRequestBudget = request => {
    if (!fullFits && request.schemaName === 'memory-organization-decisions-v2'
      && !Object.hasOwn(request.schema.properties.relations.properties, 'needsFullEvidence')) {
      throw memoryBudgetError('The complete combined request exceeds the provider budget.');
    }
  };
  const run = () => runMemoryConsolidation({ ...f, runId: f.plan.id, structureGenerator: generator, relationGenerator: generator,
    structureOptions: { maximumRequestCharacters: 20_000 },
    relationOptions: { maximumRequestCharacters: fullFits ? 4_000 : 20_000 } });
  let result = await run();
  if (!fullFits) {
    assert.equal(result.status, 'retry-pending', result.error);
    assert.equal(result.run.metadata.organizationProgress.parts[0].requiresFullRelationEvidence, true);
    result = await run();
  }
  assert.equal(result.status, 'completed', result.error);
  assert.deepEqual(requests, fullFits ? [{ combined: true, excerpted: false }]
    : [{ combined: true, excerpted: true }, { combined: false, excerpted: false }, { combined: false, excerpted: false }]);
  assert.ok(f.repository.findEdge({ agentId: f.agentId, fromMemoryId: 'closed', toMemoryId: 'cancelled', relation: 'causes' }));
});

test('a lost summary lease cannot commit, and its successor reuses the durable membership decisions', async t => {
  const f = fixture(t), charges = []; let decisions = 0, summaries = 0;
  const generator = async request => {
    if (request.schemaName === 'memory-structure-memberships-v1') {
      decisions++; return { output: { proposals: [creation(['closed','cancelled'])] } };
    }
    if (++summaries === 1) {
      f.database.prepare("UPDATE memory_consolidation_runs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(f.plan.id);
      f.repository.claimConsolidationRun({ agentId: f.agentId, runId: f.plan.id, workerId: 'successor' });
    }
    return { output: { title: 'Visit', content: 'Closure and cancellation.' }, model: 'fixture', requestId: `summary-${summaries}`,
      usage: { prompt_tokens: 100, completion_tokens: 20 } };
  };
  const run = workerId => runMemoryConsolidation({ ...f, runId: f.plan.id, structureGenerator: generator, workerId,
    structureOptions: { usageLedgerPath: 'unused' } });
  await withUsageRecorder(charge => charges.push(charge), async () => {
    await assert.rejects(run('original'), /lease|worker/i);
    assert.equal(f.repository.listStructureProposals(f.agentId).length, 0);
    f.repository.failConsolidationRun({ agentId: f.agentId, runId: f.plan.id, workerId: 'successor', errorMessage: 'Resume after takeover.' });
    assert.equal((await run('successor')).status, 'completed');
  });
  assert.equal(decisions, 1); assert.equal(summaries, 2);
  assert.deepEqual(charges.map(charge => charge.requestId), ['summary-1','summary-2']);
  assert.equal(f.repository.listStructureProposals(f.agentId).length, 1);
});

test('a proposal checkpoint rollback preserves the purchased summary and retries persistence without another model call', async t => {
  const f = fixture(t); let calls = 0;
  const generator = async request => {
    calls++;
    return { output: request.schemaName === 'memory-structure-memberships-v1'
      ? { proposals: [creation(['closed','cancelled'])] } : { title: 'Visit', content: 'Closure and cancellation.' } };
  };
  const checkpoint = f.repository.checkpointConsolidationRun.bind(f.repository);
  f.repository.checkpointConsolidationRun = input => {
    if (input.progress.structurePlans.some(group => group.proposalId)) throw new Error('Proposal checkpoint unavailable.');
    return checkpoint(input);
  };
  const run = () => runMemoryConsolidation({ ...f, runId: f.plan.id, structureGenerator: generator });
  const first = await run();
  assert.equal(first.status, 'retry-pending');
  assert.equal(f.repository.listStructureProposals(f.agentId).length, 0);
  assert.deepEqual(first.run.structureProposalIds, []);
  assert.ok(first.run.metadata.organizationProgress.structurePlans[0].summary);
  f.repository.checkpointConsolidationRun = checkpoint;
  const second = await run();
  assert.equal(second.status, 'completed', second.error);
  assert.equal(calls, 2, 'The completed membership decision and summary survive the failed commit.');
  assert.equal(f.repository.listStructureProposals(f.agentId).length, 1);
});

test('summary output truncation splits complete groups and bills the failed batch and both successful halves once', async t => {
  const f = fixture(t), charges = []; let summaries = 0;
  const generator = async request => {
    if (request.schemaName === 'memory-structure-memberships-v1') return { output: { proposals: [creation(['old','closed']), creation(['cancelled','refund'])] } };
    summaries++;
    const receipt = { model: 'fixture', requestId: `summary-${summaries}`, usage: { prompt_tokens: 100, completion_tokens: 20 } };
    if (request.schemaName === 'memory-structure-summary-batch-v1') throw Object.assign(new Error('Output limit'), receipt, { code: 'MAX_TOKENS' });
    assert.equal(JSON.parse(request.input).members.length, 2);
    return { ...receipt, output: { title: 'Visit', content: 'The supplied stage of the visit.' } };
  };
  const result = await withUsageRecorder(charge => charges.push(charge), () => runMemoryConsolidation({ ...f, runId: f.plan.id,
    structureGenerator: generator, structureOptions: { usageLedgerPath: 'unused' } }));
  assert.equal(result.status, 'completed', result.error);
  assert.equal(summaries, 3); assert.equal(charges.length, 3);
  assert.ok(charges.every(charge => charge.feature === 'memory-structure-summary'));
  assert.equal(f.repository.listStructureProposals(f.agentId).length, 2);
});

test('a pending nested summary waits on its existing owner without regenerating membership decisions', async t => {
  const f = fixture(t);
  const episode = f.repository.upsertEpisode({ agentId: f.agentId, title: 'Planning', content: 'The planned museum visit.' });
  f.repository.linkMemoryToEpisode({ agentId: f.agentId, episodeId: episode.id, memoryId: 'old' });
  const topic = f.repository.upsertTopic({ agentId: f.agentId, title: 'Museum', content: 'Museum visits.' });
  for (const id of [episode.id, 'closed']) f.repository.linkMemoryToTopic({ agentId: f.agentId, topicId: topic.id, memoryId: id });
  const task = f.repository.enqueueMaintenanceTask({ agentId: f.agentId, lane: 'semantic', taskType: 'structure-summary',
    payload: { memoryIds: [episode.id], expectedSummary: { title: episode.title, content: episode.content } } });
  const plan = planMemoryConsolidation({ ...f, triggerMemoryIds: ['closed','cancelled'], organizeNewMemories: true });
  let decisions = 0, summaries = 0;
  const generator = async request => {
    if (request.schemaName === 'memory-structure-memberships-v1') {
      decisions++; return { output: { proposals: [{ operation: 'attach', targetMemoryId: topic.id, memberIds: ['cancelled'], confidence: 0.9, rationale: 'Same visit.' }] } };
    }
    summaries++; return { output: { title: 'Museum', content: 'The planned museum visit was cancelled.' } };
  };
  const run = () => runMemoryConsolidation({ ...f, runId: plan.id, structureGenerator: generator });
  const first = await run();
  assert.equal(first.status, 'retry-pending', first.error); assert.equal(summaries, 0);
  assert.equal(first.run.failureHistory.at(-1).details.errorCode, 'MEMORY_STRUCTURE_DEPENDENCY_PENDING');
  const published = await refreshStructureSummary({ ...f, memoryId: episode.id, expectedSummary: task.payload.expectedSummary,
    generator: async () => ({ output: { title: episode.title, content: episode.content } }) });
  assert.equal(published.status, 'completed');
  assert.equal((await run()).status, 'completed');
  assert.equal(decisions, 1); assert.equal(summaries, 1);
});
