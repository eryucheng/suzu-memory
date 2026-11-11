import { extractionModelFixture } from '../../../test/support/extraction-fixtures.mjs';
import { createTestDirectory, closeAfterTests } from '../../../test/support/suite-resources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryService } from '../src/index.mjs';

for (const [earlyEmbedding, action, reality] of [
  [false, 'accept', 'real'], [false, 'dismiss', 'real'], [true, 'accept', 'real'], [true, 'dismiss', 'real'],
  [false, 'accept', 'fictional'],
]) test(`event-source ingestion accumulates preferences and supports human ${action}, early embedding ${earlyEmbedding}, ${reality}`, async () => {
  const root = os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const dataRoot = createTestDirectory(path.join(root, 'service-'));
  const agentId = 'owner';
  const memory = closeAfterTests(createMemoryService({ dataRoot, agentId,
    defaults: { primaryUserId: 'human-a', userName: '阿宁', memoryOwner: 'Suzu' } }));
  const scope = upper => ({ owner: 'product-events', agentId, eventUpperBound: upper, clears: [] });
  let calls = 0;
  const embeddingCalls = [];
  const embeddingProvider = earlyEmbedding ? Object.assign(async (text, context) => {
    assert.ok(context.sourceMaterial.eventSources.length);
    embeddingCalls.push(text);
    return { model: 'test-embedding', vector: [1, 0, 0] };
  }, { model: 'test-embedding', dimensions: 3 }) : null;
  const generator = async ({ analyzerRole, stateAnalysisRequestId, schemaName, input }) => {
    calls++;
    assert.equal(analyzerRole, 'combined-evidence');
    const request = memory.withRepository(repository => repository.getStateAnalysisRequest(agentId, stateAnalysisRequestId));
    const base = { memoryId: request.memoryIds[0], sourceIds: request.sourceIds, confidence: 0.95, rationale: '有替代选择时主动选择。' };
    const output = { results: {
      objectGrounding: { analyses: [{ ...base, targetMatch: 'exact', matchedLabel: '推理小说' }] },
      explicitExpression: { analyses: [] },
      behaviorConditions: { analyses: [{ ...base, behaviorType: 'choice', agency: 'self_initiated', constraint: 'none',
        alternatives: 'available', instrumentalGoal: 'none', opportunityCost: 'none', canDecline: 'yes' }] },
      sharingAffect: { analyses: [] },
      timeScope: { analyses: [{ ...base, stateTime: 'current', occurrencePattern: 'single', scopeKind: 'exact_object',
        scopeLabel: '推理小说', contextLabel: '', revisionCue: 'none' }] },
    } };
    const snapshot = JSON.parse(input.slice(input.indexOf('快照：\n') + '快照：\n'.length));
    return { output: extractionModelFixture(schemaName === 'memory-state-match-analysis-v1' ? { stateMatch: {
      resolution: 'matched', candidateId: snapshot.stateCandidates[0].id, rationale: '同一主体对推理小说的新选择证据。',
    }, analysis: output } : output), model: 'test', metadata: { provider: 'test' } };
  };
  generator.supportsCombinedStateAnalysis = true;
  for (let index = 1; index <= 3; index++) {
    const occurredAt = `2026-09-${index === 3 ? 11 : 10}T12:00:0${index}.000Z`;
    const text = `第 ${index} 次选书时，虽然也有散文集可选，我还是主动选了推理小说。`;
    memory.appendEventSources({ scope: scope(index), events: [{ occurredAt, content: { text },
      ...(reality === 'fictional' ? { world: { id: 'novel', frame: 'fictional' } } : {}),
      source: { version: 1, owner: 'product-events', recipientAgentId: agentId, eventId: `choice-${index}`,
        commitSequence: index, spaceId: index === 3 ? 'book-club' : 'direct-a', eventType: 'message.created',
        sender: { kind: 'local-user', id: 'human-a', name: '阿宁' }, topology: { kind: 'space' } } }] });
    const archived = await memory.processPendingEvents({ maximumEvents: 1, sourceScope: scope(index), generator: async () => ({ output: {
      entities: [{ ref: 'E1', kind: 'concept', name: '推理小说', aliases: ['mystery novels'] }],
      memories: extractionModelFixture([{
      kind: 'preference', title: '阿宁主动选择推理小说', content: `阿宁${text}`, subjectRole: 'user', subjectName: '阿宁',
      actorRoles: [{ role: 'preference_holder', actorRole: 'user', actorName: '阿宁', confidence: 0.95 }],
      canonicalKey: earlyEmbedding ? `novel-preference-batch-${index}` : 'preference:mystery-novels', stateFamily: 'preference', stateLabel: '推理小说',
      evidenceMode: 'inferred', reality, temporalState: 'current', revisionAction: 'add', eventDate: occurredAt.slice(0, 10), eventStart: '', eventEnd: '', confidence: 0.95, importance: 0.5, sourceRefs: ['M0001'],
    }]).map(candidate => ({ ...candidate, entityRefs: ['E1'] })),
    }, usage: {} }) });
    assert.equal(archived.stateAnalysisRequestsQueued, 1, JSON.stringify(archived));
    const maintenance = await memory.runSemanticMaintenance({ generator, embeddingProvider, structureGenerator: null, processInputEvents: false,
      sourceScope: scope(index) });
    assert.equal(maintenance.failures.length, 0, JSON.stringify(maintenance.failures));
  }
  assert.equal(calls, 3);
  if (earlyEmbedding) assert.equal(embeddingCalls.length, 3);
  const reviews = memory.listHighLevelProposals({ types: ['preference-state'] });
  assert.equal(reviews.items.length, 1, JSON.stringify(memory.withRepository(repository => repository.listStateAnalysisRequests(agentId, { limit: 50 }))));
  assert.equal(reviews.items[0].proposal.proposed_level, 'stable_preference');
  const id = reviews.items[0].id;
  const detail = memory.getReviewConsoleProposal('preference-state', id);
  assert.equal(detail.evidence.length, 3);
  const provisional = memory.withRepository(repository => repository.listPendingProvisionalMemories(agentId));
  assert.equal(provisional.length, 1);
  assert.ok(memory.getMemory(provisional[0].id).entities.some(entity => entity.canonical_name === '推理小说'));
  assert.equal(provisional[0].reality, reality);
  const tasks = memory.withRepository(repository => repository.listMaintenanceTasks(agentId, { limit: 500 }));
  assert.ok(tasks.some(task => task.task_type === 'memory-embedding' && task.payload.memoryIds.includes(provisional[0].id)));
  const result = memory.resolveHighLevelProposal('preference-state', id, { action });
  assert.equal(result.resolution.proposal.review_state, action === 'accept' ? 'accepted' : 'dismissed');
  assert.equal(memory.withRepository(repository => repository.getMemory(provisional[0].id)).status, 'deleted');
  if (action === 'accept') {
    assert.equal(result.resolution.memory.representation_layer, 'inferred');
    assert.equal(result.resolution.memory.reality, reality);
    if (reality === 'fictional') assert.equal(result.resolution.memory.world_id, 'novel');
    assert.ok(memory.getMemory(result.resolution.memory.id).entities.some(entity => entity.canonical_name === '推理小说'));
    const recall = await memory.search('mystery novels', { sourceScope: scope(3), persistTrace: false, now: '2026-09-12T00:00:00Z',
      ...(reality === 'fictional' ? { reality: 'fictional', worldId: 'novel', worldFrame: 'fictional' } : {}) });
    assert.ok(recall.candidates.some(candidate => candidate.memoryId === result.resolution.memory.id
      && candidate.routeMatches.some(route => route.route === 'entity')));
    const cleared = { ...scope(3), clears: [{ spaceId: 'direct-a', throughSequence: 3 }, { spaceId: 'book-club', throughSequence: 3 }] };
    assert.equal(memory.eraseEventSources({ id: 'clear-preference-evidence', scope: cleared }).complete, true);
    memory.withRepository(repository => {
      assert.equal(repository.getMemory(result.resolution.memory.id).status, 'deleted');
      assert.deepEqual(repository.findEntitiesByName({ agentId, name: 'mystery novels' }), []);
    });
  }
  assert.equal(memory.listHighLevelProposals({ types: ['preference-state'] }).items.length, 0);
});
