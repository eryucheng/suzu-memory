import assert from "node:assert/strict";
import test from "node:test";
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withUsageRecorder } from '@suzu-memory/usage-ledger';
import { createRelatedAnalyzerBatch } from '../src/related-analyzer-batch.mjs';
import { GOAL_ANALYZERS } from '../src/goal-contracts.mjs';
import { PREFERENCE_SPECIALIST_ANALYZERS } from '../src/preference-specialist-contracts.mjs';
import { BEHAVIOR_STATE_ANALYZERS } from '../src/behavior-state-contracts.mjs';
import { stateAnalysisBudgetError } from "../src/request-budget.mjs";

import {
  MemoryRepository,
  openMemoryDatabase,
  resolveReportedStateProposal,
  memoryRetrievalContextSourceHash,
  normalizeStateAnalysisTargetSpec,
  modelCalendarFields,
  withEventSourceExecution,
} from "@suzu-memory/core";
import { syncMemoryEmbeddings } from '@suzu-memory/embedding-indexer';
import { createOpenAiCompatibleStructuredGenerator } from '@suzu-memory/providers';
import { fallbackStateAnalysisToProvisionalReview } from '@suzu-memory/extraction';
import { runEmbeddingMaintenance } from '@suzu-memory/maintenance';
import { prepareStateMemoryCandidates } from '../src/state-memory-candidates.mjs';
import { MemoryService, assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';

import {
  processPendingStateAnalysisRequests,
  processStateAnalysisRequest,
} from "../src/index.mjs";

function setupRequest({
  evidenceMode = "explicit",
  representationLayer = "reported",
  database: existingDatabase = null,
  repository: existingRepository = null,
  suffix = "1",
  targetLabel = "解谜游戏",
  createdAt = "2026-07-11T02:01:00.000Z",
  sourceAt = "2026-07-10T12:00:00.000Z",
  stateFamily = "preference",
  targetSpec = {},
  eventFields = {},
  content = `我一直很喜欢${targetLabel}，这个可以记住。`,
  sharedEvidence = null,
  batchId,
} = {}) {
  const database = existingDatabase || openMemoryDatabase(":memory:");
  const repository = existingRepository || new MemoryRepository(database);
  const source = sharedEvidence?.source || repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "transcript-message",
    externalId: `message-preference-${suffix}`,
    occurredAt: sourceAt,
    knownAt: sourceAt,
    recordedAt: "2026-07-11T02:00:00.000Z",
    speaker: "用户",
    content,
  });
  const memory = sharedEvidence?.memory || repository.upsertMemory({
    id: `utterance-preference-${suffix}`,
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "imported",
    temporalState: "historical",
    eventStart: sourceAt,
    knownAt: sourceAt,
    recordedAt: "2026-07-11T02:00:00.000Z",
    actorRoles: [{
      role: "speaker",
      actorRole: "user",
      actorKey: "user",
      isPrimary: true,
      confidence: 1,
    }],
  });
  repository.linkSource(memory.id, source.id, "verbatim", {
    authority: "verbatim_record",
    sourceTrust: 1,
    evidenceStrength: 1,
  });
  const request = repository.recordStateAnalysisRequest({
    agentId: "agent-test",
    batchId: batchId || `compaction-boundary-${suffix}`,
    candidateIndex: Number(suffix) || 0,
    stateFamily,
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: `user:preference:target-${suffix}`,
    targetLabel,
    targetSpec,
    representationLayer,
    evidenceMode,
    memoryIds: [memory.id],
    sourceIds: [source.id],
    metadata: { subjectName: "用户" },
    createdAt,
  });
  const kindByFamily = {
    identity: "fact",
    belief: "belief_state",
    preference: "preference",
    habit: "belief_state",
    disposition: "belief_state",
    value: "belief_state",
    goal: "plan",
    capability: "fact",
    relationship: "relationship",
    affective_association: "belief_state",
    self_concept: "belief_state",
    condition: "fact",
  };
  repository.recordIngestionDecision({
    agentId: "agent-test",
    batchId: request.batch_id,
    candidateIndex: request.candidate_index,
    decision: "store",
    resultStatus: "analysis_pending",
    candidate: {
      kind: kindByFamily[stateFamily],
      title: targetLabel,
      content: source.content,
      subjectRole: "user",
      subjectName: "用户",
      canonicalKey: request.canonical_key,
      reality: "real",
      evidenceMode,
      stateFamily,
      temporalState: "current",
      ...eventFields,
      confidence: 0.9,
      importance: 0.5,
      actorRoles: [],
      sourceRefs: [`message-preference-${suffix}`],
    },
    sourceRefs: [`message-preference-${suffix}`],
    sourceIds: [source.id],
    knownAt: source.known_at,
  });
  return { database, repository, source, memory, request };
}

for (const [family, explicitInterval] of [['preference', false], ['goal', false], ['goal', true]]) test(`untrusted calendar times never enter ${family} analysis while retaining explicit intervals: ${explicitInterval}`, async t => {
  const f = setupRequest({ stateFamily: family, targetLabel: family === 'goal' ? '整理书单' : '解谜游戏',
    eventFields: explicitInterval ? { eventDate: '2026-12-25', eventStart: '2026-12-25T01:00:00Z', eventEnd: '2026-12-26T01:00:00Z' } : {},
    content: explicitInterval ? '我计划2026年12月25日至26日整理小说书单。'
      : family === 'goal' ? '我答应周六九点整理小说书单。' : '我一直很喜欢解谜游戏。' });
  t.after(() => f.database.close());
  f.database.prepare("UPDATE source_records SET occurred_at=?, known_at=?, metadata_json=? WHERE id=?")
    .run('2000-01-02T12:00:00Z', '2000-01-02T12:00:00Z', JSON.stringify({ sourceTimeKnown: false }), f.source.id);
  f.database.prepare("UPDATE memory_nodes SET event_start=?, known_at=?, metadata_json=? WHERE id=?")
    .run('2000-01-02T12:00:00Z', '2000-01-02T12:00:00Z', JSON.stringify({ sourceTimeKnown: false }), f.memory.id);
  const calls = [];
  const base = family === 'goal' ? combinedGoalGenerator(f, []) : directPreferenceGenerator(f);
  const generator = Object.assign(async request => {
    calls.push(request);
    assert.doesNotMatch(request.input, /2000-01-02/);
    return base(request);
  }, { supportsCombinedStateAnalysis: family === 'goal' });
  const result = await processStateAnalysisRequest({ repository: f.repository, agentId: 'agent-test', requestId: f.request.id, generator });
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.ok(calls.length > 0);
  const accepted = resolveReportedStateProposal(f.repository, { agentId: 'agent-test', proposalId: result.proposal.id, action: 'accept' });
  const detail = f.repository.getMemoryDetail('agent-test', accepted.memory.id);
  const calendar = modelCalendarFields(accepted.memory, ['knownAt', 'eventDate', 'eventStart', 'eventEnd'], detail.sources);
  assert.equal(calendar.knownAt, null);
  if (explicitInterval) {
    assert.equal(calendar.eventDate, '2026-12-25');
    assert.equal(calendar.eventStart, '2026-12-25T01:00:00Z');
    assert.equal(calendar.eventEnd, '2026-12-26T01:00:00Z');
  } else assert.equal(accepted.memory.metadata.sourceTimeKnown, false);
});

for (const scenario of ['active', 'pending', 'ambiguous', 'invalid']) test(`early state embedding and candidate matching: ${scenario}`, async t => {
  const first = setupRequest({ stateFamily: 'goal', targetLabel: '周六整理书单', content: '我答应周六九点整理小说书单。' });
  t.after(() => first.database.close());
  const embeddingCalls = [];
  const embeddingProvider = Object.assign(async text => {
    embeddingCalls.push(text);
    return { model: 'test-embedding', vector: [1, 0, 0] };
  }, { model: 'test-embedding', dimensions: 3 });
  const firstCalls = [];
  const firstResult = await processStateAnalysisRequest({ repository: first.repository, agentId: 'agent-test',
    requestId: first.request.id, generator: combinedGoalGenerator(first, firstCalls), embeddingProvider });
  assert.equal(firstResult.status, 'proposal-pending', JSON.stringify(firstResult));
  assert.equal(firstCalls.length, 1);
  assert.equal(embeddingCalls.length, 1);
  assert.equal(firstResult.proposal.review_state, 'pending');
  let old = first.repository.getMemory(firstResult.proposal.resultMemoryId);
  assert.equal(old.content, first.source.content);
  if (scenario !== 'pending') old = resolveReportedStateProposal(first.repository, {
    agentId: 'agent-test', proposalId: firstResult.proposal.id, action: 'accept',
  }).memory;
  const indexed = await syncMemoryEmbeddings({ repository: first.repository, agentId: 'agent-test',
    embeddingProvider, memoryIds: [old.id] });
  assert.equal(indexed.copied, 1);
  assert.equal(embeddingCalls.length, 1, 'materialization must reuse the pre-analysis vector');

  const second = setupRequest({ database: first.database, repository: first.repository, suffix: '2', stateFamily: 'goal',
    targetLabel: '取消书单安排', content: '我取消周六九点整理小说书单的安排，不是完成了。' });
  const calls = [];
  const native = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://provider.test', apiKey: 'test-key', model: 'fixture', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, { body }) => {
      const { messages, tools } = JSON.parse(body);
      const input = messages[1].content;
      const snapshot = JSON.parse(input.slice(input.indexOf('{')));
      const source = snapshot.sourceRecords.find(row => row.content === second.source.content);
      assert.ok(source && source.id !== second.source.id, 'The provider must receive a local source reference.');
      const evidence = snapshot.memories.find(memory => memory.contentSourceId === source.id);
      assert.ok(evidence && evidence.id !== second.memory.id, 'The provider must receive a local memory reference.');
      assert.equal(Object.hasOwn(evidence, 'content'), false, 'Verbatim content is shared through its own source.');
      assert.ok(evidence.sourceIds.includes(source.id));
      const common = { memoryId: evidence.id, sourceIds: [source.id], confidence: 0.98, rationale: '原话明确取消同一约定。' };
      let output;
      if (snapshot.currentState) {
        assert.equal(Object.hasOwn(snapshot, 'stateCandidates'), false, 'Comparison reads the selected state without the matching pool.');
        assert.equal(snapshot.currentState.content, old.content);
        assert.notEqual(snapshot.currentState.id, old.id);
        output = { analyses: [{ ...common, relation: 'cancels' }] };
      } else {
        const candidate = snapshot.stateCandidates.find(item => item.content === old.content);
        assert.ok(candidate && candidate.id !== old.id);
        const branches = tools[0].function.parameters.properties.stateMatch.anyOf;
        assert.ok(Array.isArray(branches), 'Matching must declare candidate-bound resolution branches.');
        const matched = branches.find(branch => branch.properties.resolution.enum.includes('matched'));
        const unmatched = branches.find(branch => branch.properties.resolution.enum.includes('new'));
        assert.deepEqual(new Set(matched.properties.candidateId.enum), new Set(snapshot.stateCandidates.map(item => item.id)));
        assert.ok(!matched.properties.candidateId.enum.includes('not-a-candidate'));
        assert.deepEqual(unmatched.properties.resolution.enum, ['new', 'ambiguous']);
        assert.deepEqual(unmatched.properties.candidateId.enum, ['']);
        output = { stateMatch: { resolution: scenario === 'ambiguous' ? 'ambiguous' : 'matched',
          candidateId: scenario === 'ambiguous' ? '' : scenario === 'invalid' ? 'not-a-candidate' : candidate.id,
          rationale: '比较具体约定。' }, analysis: { results: {
          targetIntent: { analyses: [{ ...common, targetMatch: 'exact', goalText: '整理小说书单', intentionLevel: 'plan', specificity: 'actionable', peerRelations: [] }] },
          holderResponsibility: { analyses: [{ ...common, holderMatch: 'yes', attribution: 'explicit_self_statement', responsibility: 'subject', agency: 'self_chosen', acceptsResponsibility: 'yes' }] },
          lifecycle: { analyses: [{ ...common, lifecycle: 'cancelled', completionBasis: 'direct_cancellation', timeReference: '' }] },
        } } };
      }
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ type: 'function',
        function: { name: tools[0].function.name, arguments: JSON.stringify(output) } }] } }] });
    },
  });
  const generator = Object.assign(async request => {
    assert.equal(embeddingCalls.length, 2, 'new semantic content must be embedded before the specialist');
    calls.push(request);
    const canonical = JSON.parse(request.input.slice(request.input.indexOf('{')));
    assert.equal(canonical.memories[0].content, second.memory.content);
    assert.ok(canonical.stateCandidates.length, 'Canonical evidence retains the matching material for validation.');
    assertMemoryTaskRequest(request);
    const generation = await native(request);
    validateMemoryTaskOutput(request, generation.output);
    return generation;
  }, { supportsCombinedStateAnalysis: true });
  const result = await processStateAnalysisRequest({ repository: second.repository, agentId: 'agent-test',
    requestId: second.request.id, generator, embeddingProvider });
  assert.equal(calls.length, ['ambiguous', 'invalid'].includes(scenario) ? 1 : 2, JSON.stringify(result));
  if (scenario === 'invalid') {
    assert.equal(result.status, 'retry-pending');
    assert.equal(first.repository.getMemory(old.id).state_phase, 'active');
    return;
  }
  if (['active', 'pending'].includes(scenario)) {
    assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
    assert.equal(result.proposal.action, 'cancel');
    assert.equal(result.proposal.previousMemoryId, old.id);
    assert.equal(result.request.canonical_key, old.canonical_key);
    assert.equal(first.repository.getMemory(old.id).state_phase, 'cancelled');
    assert.equal(first.repository.getMemory(old.id).status, 'superseded');
    assert.equal(result.proposal.review_state, 'pending');
    const cancelled = resolveReportedStateProposal(first.repository, { agentId: 'agent-test',
      proposalId: result.proposal.id, action: 'accept' });
    assert.equal(cancelled.memory.state_phase, 'cancelled');
  } else {
    assert.equal(result.status, 'provisional-review', JSON.stringify(result));
    assert.equal(result.provisional.content, second.source.content);
  }
  const pending = first.repository.listPendingProvisionalMemories('agent-test').filter(memory => memory.id !== old.id);
  if (pending.length) {
    const queuedIds = new Set(first.repository.listMaintenanceTasks('agent-test', {
      taskTypes: ['memory-embedding'], statuses: ['pending'], limit: 100,
    }).flatMap(task => task.payload.memoryIds));
    for (const memory of pending) assert.ok(queuedIds.has(memory.id), 'pending evidence must enter the embedding queue');
    await runEmbeddingMaintenance({ repository: first.repository, agentId: 'agent-test', embeddingProvider,
      maximumTasks: 100 });
    for (const memory of pending) assert.ok(first.repository.listEmbeddings('agent-test', 'test-embedding', {
      includeArchived: true,
    }).some(row => row.memory_id === memory.id));
    assert.equal(embeddingCalls.length, 2);
  }
  if (scenario === 'active') {
    const closed = first.repository.getMemory(old.id);
    const third = setupRequest({ database: first.database, repository: first.repository, suffix: '3', stateFamily: 'goal',
      targetLabel: '恢复书单安排', content: '我恢复之前取消的周六九点整理小说书单安排，按原计划进行。' });
    const resumeCalls = [];
    const activeEvidence = combinedGoalGenerator(third, []);
    const resumeGenerator = Object.assign(async request => {
      resumeCalls.push(request);
      let output;
      if (request.schemaName === 'memory-state-match-analysis-v1') {
        const snapshot = JSON.parse(request.input.slice(request.input.indexOf('快照：\n') + '快照：\n'.length));
        assert.ok(snapshot.stateCandidates.some(candidate => candidate.id === old.id && candidate.statePhase === 'cancelled'));
        output = { stateMatch: { resolution: 'matched', candidateId: old.id, rationale: '明确恢复原来取消的安排。' },
          analysis: (await activeEvidence(request)).output };
      } else {
        const snapshot = JSON.parse(request.input.slice(request.input.indexOf('{')));
        assert.equal(snapshot.currentState.id, old.id);
        assert.equal(snapshot.currentState.statePhase, 'cancelled');
        output = { analyses: [{ memoryId: third.memory.id, sourceIds: [third.source.id], confidence: 0.98,
          rationale: '直接恢复同一安排。', relation: 'resumes' }] };
      }
      validateMemoryTaskOutput(request, output);
      return { output, model: 'test' };
    }, { supportsCombinedStateAnalysis: true });
    const resumed = await processStateAnalysisRequest({ repository: first.repository, agentId: 'agent-test',
      requestId: third.request.id, generator: resumeGenerator, embeddingProvider });
    assert.equal(resumed.status, 'proposal-pending', JSON.stringify(resumed));
    assert.equal(resumed.proposal.action, 'resume');
    assert.equal(resumed.proposal.previousMemoryId, old.id);
    const accepted = resolveReportedStateProposal(first.repository, { agentId: 'agent-test', proposalId: resumed.proposal.id, action: 'accept' });
    assert.equal(accepted.memory.state_phase, 'active');
    assert.equal(accepted.memory.canonical_key, closed.canonical_key);
    assert.equal(first.repository.getMemory(old.id).state_phase, 'cancelled');
    assert.equal(first.repository.getMemory(old.id).valid_to, closed.valid_to);
    // Matching an earlier version must compare against the latest accepted version.
    const fourth = setupRequest({ database: first.database, repository: first.repository, suffix: '4', stateFamily: 'goal',
      targetLabel: '书单安排进展', content: '整理书单正在进行中。' });
    const context = await prepareStateMemoryCandidates({ repository: first.repository, request: fourth.request, embeddingProvider });
    context.resolve({ resolution: 'matched', candidateId: old.id, rationale: '原计划的后续进展。' });
    assert.equal(context.selected.id, accepted.memory.id);
    assert.equal(context.selected.statePhase, 'active');
  }
});

test('hiding a synthetic validity date preserves storage concurrency checks for historical state candidates', async t => {
  for (const changed of [false, true]) {
    const f = setupRequest({ stateFamily: 'goal', targetLabel: '周六整理书单', content: '我答应周六九点整理小说书单。' });
    t.after(() => f.database.close());
    const old = f.repository.upsertMemory({ id: 'old-plan', agentId: 'agent-test', kind: 'plan', layer: 'semantic',
      status: 'superseded', content: '我答应周六九点整理小说书单。', subjectRole: 'user', subjectKey: 'user',
      stateFamily: 'goal', representationLayer: 'reported', canonicalKey: 'old-target', reality: 'real',
      evidenceMode: 'explicit', statePhase: 'completed', temporalState: 'historical',
      validTo: '2000-01-02T12:00:00Z', metadata: { sourceTimeKnown: false } });
    f.repository.linkSource(old.id, f.source.id, 'evidence');
    const embeddingProvider = Object.assign(async () => ({ model: 'test-embedding', vector: [1, 0] }), { model: 'test-embedding', dimensions: 2 });
    const context = await prepareStateMemoryCandidates({ repository: f.repository, request: f.request, embeddingProvider });
    assert.equal(context.candidates.find(candidate => candidate.id === old.id).validTo, null);
    if (changed) f.database.prepare('UPDATE memory_nodes SET valid_to=? WHERE id=?').run('2000-01-03T12:00:00Z', old.id);
    const resolve = () => context.resolve({ resolution: 'matched', candidateId: old.id, rationale: '同一目标的历史记录。' });
    if (changed) assert.throws(resolve, /candidate changed during analysis/);
    else assert.doesNotThrow(resolve);
  }
});

for (const newerState of [false, true]) test(`a changed comparison state invalidates the waiting analysis before it can record observations; newer state ${newerState}`, async t => {
  const first = setupRequest({ stateFamily: 'goal', targetLabel: '整理书单', content: '我准备整理书单。' });
  t.after(() => first.database.close());
  const established = await processStateAnalysisRequest({ repository: first.repository, agentId: 'agent-test',
    requestId: first.request.id, generator: combinedGoalGenerator(first, []) });
  const old = resolveReportedStateProposal(first.repository, { agentId: 'agent-test', proposalId: established.proposal.id, action: 'accept' }).memory;
  const second = setupRequest({ database: first.database, repository: first.repository, suffix: '2',
    stateFamily: 'goal', targetLabel: '整理书单', content: '我继续准备整理书单。' });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let comparison = old;
  const base = combinedGoalGenerator(second, []);
  const generator = Object.assign(async request => {
    if (request.schemaName === 'memory-state-match-analysis-v1') {
      if (newerState) {
        // A newer state can become visible after candidate selection. Identity
        // resolution follows the canonical history to this comparison target.
        comparison = first.repository.upsertMemory({ id: 'newer-current-plan', agentId: 'agent-test', kind: 'plan',
          layer: 'semantic', status: 'active', content: '书单已列好分类，继续整理。', subjectRole: 'user', subjectKey: 'user',
          stateFamily: 'goal', representationLayer: 'reported', canonicalKey: old.canonical_key, reality: 'real',
          evidenceMode: 'explicit', statePhase: 'active', temporalState: 'current', recordedAt: '2026-07-12T00:00:00Z' });
        first.repository.linkSource(comparison.id, first.source.id, 'evidence');
        const evidence = first.repository.expand('agent-test', [old.id], {
          maxDepth: 1, relations: ['supported_by', 'challenged_by'], traversal: 'outgoing' });
        for (const edge of evidence.edges) first.repository.upsertEdge({ agentId: 'agent-test',
          fromMemoryId: comparison.id, toMemoryId: edge.to_memory_id, relation: edge.relation });
      }
      const evidence = await base(request);
      return { ...evidence, output: { stateMatch: { resolution: 'matched', candidateId: old.id, rationale: '同一个整理书单的计划。' },
        analysis: evidence.output } };
    }
    assert.equal(request.analyzerRole, 'current-relation');
    const snapshot = JSON.parse(request.input.slice(request.input.indexOf('{')));
    assert.equal(snapshot.currentState.id, comparison.id);
    entered.resolve(); await release.promise;
    return { output: { analyses: [{ memoryId: second.memory.id, sourceIds: [second.source.id],
      confidence: 0.98, rationale: '同一个计划。', relation: 'same_goal' }] } };
  }, { supportsCombinedStateAnalysis: true });
  const before = first.database.prepare('SELECT COUNT(*) AS n FROM memory_state_evidence_observations').get().n;
  const pending = processStateAnalysisRequest({ repository: first.repository, agentId: 'agent-test', requestId: second.request.id, generator });
  await Promise.race([entered.promise, pending.then(result => assert.fail('Comparison was not reached: ' + result.reason))]);
  first.repository.editMemoryManually({ agentId: 'agent-test', memoryId: comparison.id, patch: { content: '原计划的对象已由人工修正。' } });
  release.resolve();
  assert.equal((await pending).reason, 'STATE_ANALYSIS_INPUT_CHANGED');
  assert.equal(first.database.prepare('SELECT COUNT(*) AS n FROM memory_state_evidence_observations').get().n, before);
  assert.equal(first.repository.getStateAnalysisRequest('agent-test', second.request.id).status, 'pending');
});

test('a specialist retry reuses its persisted semantic vector', async t => {
  const fixture = setupRequest({ stateFamily: 'goal', targetLabel: '整理书单' });
  t.after(() => fixture.database.close());
  let embeddings = 0;
  const embeddingProvider = Object.assign(async () => {
    embeddings++;
    return { model: 'test-embedding', vector: [1, 0] };
  }, { model: 'test-embedding', dimensions: 2 });
  const options = { repository: fixture.repository, agentId: 'agent-test', requestId: fixture.request.id, embeddingProvider };
  const failed = await processStateAnalysisRequest({ ...options,
    generator: Object.assign(async () => { throw new Error('temporary provider failure'); }, { supportsCombinedStateAnalysis: true }) });
  assert.equal(failed.status, 'retry-pending');
  const calls = [];
  const result = await processStateAnalysisRequest({ ...options, generator: combinedGoalGenerator(fixture, calls) });
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.equal(embeddings, 1);
});

for (const contextChanged of [false, true]) {
  test(`semantic candidates use the indexed retrieval context; changed context ${contextChanged}`, async t => {
    const fixture = setupRequest({ stateFamily: 'goal', targetLabel: '取消安排', content: '那件事取消吧。' });
    t.after(() => fixture.database.close());
    const { repository } = fixture;
    for (let index = 0; index < 12; index++) repository.upsertMemory({
      id: `old-${index}`, agentId: 'agent-test', kind: 'plan', layer: 'prospective',
      title: `事项${index}`, content: `准备参加活动${index}`, subjectRole: 'user', subjectKey: 'user',
      canonicalKey: `old-${index}`, stateFamily: 'goal', representationLayer: 'reported',
      evidenceMode: 'explicit', reality: 'real',
      recordedAt: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    });
    const old = repository.getMemory('old-0');
    const saveContext = (contextText, policyVersion = 'test-v1') => repository.upsertMemoryRetrievalContext({
      agentId: 'agent-test', memoryId: old.id, policyVersion, promptVersion: 'test',
      sourceHash: memoryRetrievalContextSourceHash(old), contextText, queryTerms: ['旧约定'],
    });
    saveContext('这件旧约定的详细语义上下文。');
    let embeddingCalls = 0;
    const provider = Object.assign(async text => {
      embeddingCalls++;
      return { model: 'test-context', vector: text.includes('事项0') || text.includes('那件事') ? [1, 0] : [0, 1] };
    }, { model: 'test-context', dimensions: 2 });
    await syncMemoryEmbeddings({ repository, agentId: 'agent-test', embeddingProvider: provider,
      memoryIds: Array.from({ length: 12 }, (_, index) => `old-${index}`) });
    if (contextChanged) {
      saveContext('这条记忆的检索上下文已经变化。', 'test-v2');
      assert.equal(repository.getCurrentMemoryRetrievalContext(old.id).context_text, '这条记忆的检索上下文已经变化。');
    }
    const previousCalls = embeddingCalls;
    const result = await prepareStateMemoryCandidates({ repository, request: fixture.request, embeddingProvider: provider });
    assert.equal(embeddingCalls, previousCalls + 1, 'candidate checks must not re-embed stored memories');
    assert.equal(result.candidates.some(candidate => candidate.id === old.id), !contextChanged,
      'only a vector matching its current semantic document may supply the old semantic match');
    if (contextChanged) {
      await syncMemoryEmbeddings({ repository, agentId: 'agent-test', embeddingProvider: provider, memoryIds: [old.id] });
      const refreshed = await prepareStateMemoryCandidates({ repository, request: fixture.request, embeddingProvider: provider });
      assert.ok(refreshed.candidates.some(candidate => candidate.id === old.id));
    }
  });
}

function directGoalGenerator(fixture) {
  return async ({ analyzerRole }) => {
    const common = {
      memoryId: fixture.memory.id,
      sourceIds: [fixture.source.id],
      confidence: 0.98,
      rationale: "原话直接支持该字段。",
    };
    const outputs = {
      "target-intent": { analyses: [{
        ...common,
        targetMatch: "exact",
        goalText: fixture.request.target_label,
        intentionLevel: "plan",
        specificity: "actionable",
        peerRelations: [],
      }] },
      "holder-responsibility": { analyses: [{
        ...common,
        holderMatch: "yes",
        attribution: "explicit_self_statement",
        responsibility: "subject",
        agency: "self_chosen",
        acceptsResponsibility: "yes",
      }] },
      "lifecycle": { analyses: [{
        ...common,
        lifecycle: "active",
        completionBasis: "none",
        timeReference: "",
      }] },
      "current-relation": { analyses: [{
        ...common,
        relation: "unknown",
      }] },
    };
    return {
      output: outputs[analyzerRole],
      model: `test-${analyzerRole}`,
      metadata: { provider: "test" },
    };
  };
}

for (const stateFamily of ['identity', 'relationship']) {
  test(`semantic state candidates respect ${stateFamily} target dimensions even with identical vectors`, async t => {
    const targetSpec = stateFamily === 'identity' ? { identityField: 'relationship_status', fieldCardinality: 'single' }
      : { counterpartRole: 'agent', counterpartKey: 'agent-test', counterpartLabel: 'Agent',
        direction: 'holder_to_counterpart', relationshipDimension: 'trust' };
    const f = setupRequest({ stateFamily, targetSpec, targetLabel: 'Current state' });
    t.after(() => f.database.close());
    const records = stateFamily === 'identity'
      ? [['matching', { identityClaim: { identityField: 'relationship_status' } }],
        ['different-field', { identityClaim: { identityField: 'occupation' } }]]
      : [['matching', { counterpart: { role: 'agent', key: 'agent-test' }, relationshipView: { relationType: 'trust' } }],
        ['different-dimension', { counterpart: { role: 'agent', key: 'agent-test' }, relationshipView: { relationType: 'support' } }],
        ['different-counterpart', { counterpart: { role: 'agent', key: 'another-agent' }, relationshipView: { relationType: 'trust' } }]];
    for (const [id, draft] of records) f.repository.upsertMemory({ id, agentId: 'agent-test',
      kind: stateFamily === 'identity' ? 'fact' : 'relationship', layer: 'semantic',
      content: 'Current personal state', subjectRole: 'user', subjectKey: 'user', canonicalKey: id,
      stateFamily, representationLayer: 'reported', evidenceMode: 'explicit', reality: 'real',
      temporalState: 'current', metadata: { reportedStateDraft: draft } });
    let calls = 0;
    const embeddingProvider = Object.assign(async () => {
      calls++;
      return { model: 'target-isolation', vector: [1, 0] };
    }, { model: 'target-isolation', dimensions: 2 });
    await syncMemoryEmbeddings({ repository: f.repository, agentId: 'agent-test', embeddingProvider,
      memoryIds: records.map(([id]) => id) });
    const before = calls;
    const prepared = await prepareStateMemoryCandidates({ repository: f.repository, request: f.request, embeddingProvider });
    assert.deepEqual(prepared.candidates.map(candidate => candidate.id), ['matching']);
    assert.equal(calls, before + 1, 'only the new draft needs an embedding');
    assert.ok(prepared.candidates[0].targetSpec);
  });
}

function directConditionGenerator(fixture) {
  return async ({ analyzerRole }) => {
    assert.equal(analyzerRole, "condition-evidence");
    return {
      output: { analyses: [{
        memoryId: fixture.memory.id,
        sourceIds: [fixture.source.id],
        confidence: 0.98,
        rationale: "原话直接报告当前现实条件。",
        targetMatch: "exact",
        matchedLabel: fixture.request.target_label,
        conditionPresence: "present",
        conditionKind: "work",
        effect: "constrains",
        temporality: "current",
        evidenceBasis: "explicit_self_report",
        scopeLabel: fixture.request.target_label,
        revisionCue: "none",
      }] },
      model: "test-condition-evidence",
      metadata: { provider: "test" },
    };
  };
}

function directPreferenceGenerator(fixture, { failRole = "" } = {}) {
  return async ({ analyzerRole }) => {
    if (analyzerRole === failRole) throw new Error("temporary-provider-failure");
    const common = {
      memoryId: fixture.memory.id,
      sourceIds: [fixture.source.id],
      confidence: 0.98,
      rationale: "原话直接支持该字段。",
    };
    const outputs = {
      "object-grounding": {
        analyses: [{ ...common, targetMatch: "exact", matchedLabel: fixture.request.target_label }],
      },
      "explicit-expression": {
        analyses: [{
          ...common,
          expressionType: "likes",
          directness: "explicit_self_statement",
        }],
      },
      "behavior-conditions": { analyses: [] },
      "sharing-affect": { analyses: [] },
      "time-scope": {
        analyses: [{
          ...common,
          stateTime: "current",
          occurrencePattern: "repeated",
          scopeKind: "category",
          scopeLabel: fixture.request.target_label,
          contextLabel: "",
          revisionCue: "none",
        }],
      },
    };
    return {
      output: outputs[analyzerRole],
      model: `test-${analyzerRole}`,
      metadata: { provider: "test" },
    };
  };
}

function combinedGoalGenerator(fixture, calls) {
  const common = {
    memoryId: fixture.memory.id,
    sourceIds: [fixture.source.id],
    confidence: 0.98,
    rationale: "原话直接支持该字段。",
  };
  const generator = async ({ analyzerRole, combinedAnalyzerKeys }) => {
    calls.push({ analyzerRole, combinedAnalyzerKeys });
    assert.equal(analyzerRole, "combined-evidence");
    assert.deepEqual(combinedAnalyzerKeys, [
      "targetIntent",
      "holderResponsibility",
      "lifecycle",
    ]);
    return {
      output: {
        results: {
          targetIntent: { analyses: [{
            ...common,
            targetMatch: "exact",
            goalText: fixture.request.target_label,
            intentionLevel: "plan",
            specificity: "actionable",
        peerRelations: [],
          }] },
          holderResponsibility: { analyses: [{
            ...common,
            holderMatch: "yes",
            attribution: "explicit_self_statement",
            responsibility: "subject",
            agency: "self_chosen",
            acceptsResponsibility: "yes",
          }] },
          lifecycle: { analyses: [{
            ...common,
            lifecycle: "active",
            completionBasis: "none",
            timeReference: "",
          }] },
        },
      },
      usage: { prompt_tokens: 100, completion_tokens: 30 },
      model: "test-combined-goal",
      metadata: { provider: "test" },
    };
  };
  generator.supportsCombinedStateAnalysis = true;
  return generator;
}

function sharedStateRequests(options = {}) {
  const goal = setupRequest({ ...options, stateFamily: 'goal', targetLabel: '整理书单', batchId: 'shared-state-evidence',
    content: '我喜欢解谜游戏。最近工作很忙，但计划整理书单。', eventFields: { content: '用户计划整理书单。' } });
  const condition = setupRequest({ database: goal.database, repository: goal.repository, sharedEvidence: goal,
    suffix: '2', stateFamily: 'condition', targetLabel: '工作繁忙', batchId: goal.request.batch_id,
    eventFields: { content: '用户最近工作繁忙。' } });
  return [goal, condition];
}

async function stateFixtureOutput(request, fixtures, supplied = JSON.parse(request.input.slice(request.input.indexOf('{')))) {
  if (request.stateAnalysisTasks) {
    return { results: Object.fromEntries(await Promise.all(request.stateAnalysisTasks.map(async child => [child.key,
      await stateFixtureOutput(child, fixtures, { ...supplied.shared, ...supplied.tasks[child.key] }),
    ]))) };
  }
  const fixture = fixtures.find(item => item.request.id === request.stateAnalysisRequestId);
  assert.ok(fixture, 'Each returned task must belong to its original request.');
  if (request.stateMatchAnalysisTask) return {
    stateMatch: { resolution: 'matched', candidateId: supplied.stateCandidates[0].id, rationale: '同一主体同一事项的后续证据。' },
    analysis: await stateFixtureOutput({ ...request.stateMatchAnalysisTask, stateAnalysisRequestId: fixture.request.id }, fixtures, supplied),
  };
  const local = { ...fixture, memory: { ...fixture.memory, id: supplied.memories[0].id },
    source: { ...fixture.source, id: supplied.memories[0].sourceIds[0] } };
  const definitions = fixture.request.state_family === 'goal' ? GOAL_ANALYZERS
    : fixture.request.state_family === 'preference' ? PREFERENCE_SPECIALIST_ANALYZERS : BEHAVIOR_STATE_ANALYZERS;
  const generator = fixture.request.state_family === 'goal' ? directGoalGenerator(local)
    : fixture.request.state_family === 'preference' ? directPreferenceGenerator(local) : directConditionGenerator(local);
  if (request.combinedAnalyzerKeys) return { results: Object.fromEntries(await Promise.all(request.combinedAnalyzerKeys.map(async key =>
    [key, (await generator({ analyzerRole: definitions[key].role })).output]))) };
  const definition = Object.values(definitions).find(item => item.schemaName === request.schemaName);
  return (await generator({ analyzerRole: definition.role })).output;
}

// Produce the provider's compact representation from the fixture's independent
// semantic judgments; assertions below verify the engine restores their contract.
function packedStateFixture(schema, output) {
  if (schema.properties?.analysis) return { ...output, analysis: packedStateFixture(schema.properties.analysis, output.analysis) };
  const roles = schema.properties?.analyses?.items?.properties?.judgments?.properties;
  if (!roles) return schema.properties?.results ? { results: Object.fromEntries(Object.entries(output.results).map(([key, value]) =>
    [key, packedStateFixture(schema.properties.results.properties[key], value)])) } : output;
  const rows = new Map();
  for (const [key, result] of Object.entries(output.results)) for (const item of result.analyses) {
    const { memoryId, sourceIds, rationale, ...fields } = item;
    if (!rows.has(memoryId)) rows.set(memoryId, { memoryId, sourceIds, rationale,
      judgments: Object.fromEntries(Object.keys(roles).map(role => [role, null])) });
    rows.get(memoryId).judgments[key] = { ...fields, sourceIds: null, note: '' };
  }
  return { analyses: [...rows.values()] };
}

for (const confirmsScope of [true, false]) test(`reported preference adds evidence only when it supports the prior scope: ${confirmsScope}`, async t => {
  const old = setupRequest({ targetLabel: '无糖热茶', content: '半夜写稿我只喜欢喝无糖热茶。', sourceAt: '2026-07-09T12:00:00.000Z' });
  const { repository } = old;
  t.after(() => old.database.close());
  const earlierScope = { scopeKind: 'exact_object', scopeLabel: '无糖热茶', contextLabel: '半夜写稿' };
  const first = await processStateAnalysisRequest({ repository, agentId: 'agent-test', requestId: old.request.id,
    generator: Object.assign(async request => {
      const output = await stateFixtureOutput(request, [old]);
      Object.assign(output.results.timeScope.analyses[0], earlierScope);
      return { output, model: 'fixture' };
    }, { supportsCombinedStateAnalysis: true }) });
  const stored = resolveReportedStateProposal(repository, {
    agentId: 'agent-test', proposalId: first.proposal.id, action: 'accept',
  }).memory;
  const fresh = setupRequest({ database: old.database, repository, suffix: '2', targetLabel: '无糖热茶',
    content: confirmsScope ? '深夜动笔我还是爱喝不放糖的热茶。' : '我写稿时喜欢喝无糖热茶。' });
  let request;
  const native = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://provider.test', apiKey: 'fixture', model: 'fixture', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, { body }) => {
      const { messages, tools } = JSON.parse(body);
      const supplied = JSON.parse(messages[1].content);
      const candidate = supplied.stateCandidates.find(item => item.content === old.source.content);
      assert.equal(candidate.preferenceClaim.scope.context, earlierScope.contextLabel);
      assert.ok(!Object.hasOwn(supplied, 'omitted'));
      assert.ok(!Object.hasOwn(supplied.memories[0], 'sourcesTruncated'));
      assert.ok(!Object.hasOwn(candidate, 'reviewState'));
      assert.ok(!Object.hasOwn(supplied.target, 'canonicalKey'));
      assert.ok(supplied.stateCandidates.every(item => !Object.hasOwn(item, 'canonicalKey')));
      assert.doesNotMatch(messages[0].content, /身份字段|婚恋状态/u);
      const output = await stateFixtureOutput(request, [fresh], supplied);
      output.stateMatch.supportingMemoryIds = confirmsScope ? [supplied.memories[0].id] : [];
      Object.assign(output.analysis.results.timeScope.analyses[0], {
        scopeKind: 'exact_object', scopeLabel: confirmsScope ? '不放糖的热茶' : '无糖热茶',
        contextLabel: confirmsScope ? '深夜动笔' : '写稿时',
      });
      const tool = tools[0].function;
      const packed = packedStateFixture(tool.parameters, output);
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{
        type: 'function', function: { name: tool.name, arguments: JSON.stringify(packed) },
      }] } }] });
    },
  });
  const generator = Object.assign(async call => {
    request = call;
    const generation = await native(call);
    validateMemoryTaskOutput(call, generation.output);
    return generation;
  }, native);
  const result = await processStateAnalysisRequest({ repository, agentId: 'agent-test', requestId: fresh.request.id, generator });
  if (confirmsScope) {
    assert.equal(result.proposal?.action, 'reinforce', result.reason);
    assert.equal(result.proposal.review_state, 'pending');
    assert.equal(result.proposal.resultMemoryId, stored.id);
    assert.deepEqual(repository.listPendingProvisionalMemories('agent-test'), []);
    const memory = repository.getMemory(stored.id);
    assert.equal(memory.content, old.source.content);
    assert.deepEqual(memory.metadata.reportedStateDraft.preferenceClaim, stored.metadata.reportedStateDraft.preferenceClaim);
  } else {
    assert.equal(result.status, 'provisional-review');
    assert.equal(result.reason, 'latest-direct-preference-does-not-prove-a-safe-transition');
  }
  assert.deepEqual(new Set(repository.listMemorySources(stored.id).map(source => source.id)),
    new Set(confirmsScope ? [old.source.id, fresh.source.id] : [old.source.id]));
});

test('cross-family first stages share evidence on the provider wire and retain independent contracts and billing', async t => {
  const fixtures = sharedStateRequests();
  const f = fixtures[0]; t.after(() => f.database.close());
  fixtures.push(setupRequest({ database: f.database, repository: f.repository, sharedEvidence: f,
    suffix: '3', stateFamily: 'preference', targetLabel: '解谜游戏', batchId: f.request.batch_id,
    eventFields: { content: '用户喜欢解谜游戏。' } }));
  const calls = [], charges = [];
  let current;
  const native = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://provider.test', apiKey: 'fixture', model: 'fixture', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, { body }) => {
      const payload = JSON.parse(body), material = JSON.parse(payload.messages[1].content), tool = payload.tools[0].function;
      assert.equal(current.schemaName, 'memory-state-first-stage-batch-v1');
      assert.equal(material.shared.sourceRecords.length, 1);
      assert.equal(payload.messages[1].content.split(f.source.content).length - 1, 1, 'The shared source body is purchased once.');
      assert.equal(Object.keys(material.tasks).length, 3);
      assert.deepEqual(current.decodeOutput(material), JSON.parse(current.input), 'Shared fields and per-task references must round-trip exactly.');
      assert.deepEqual(current.stateAnalysisTasks.map(task => task.stateFamily), ['goal', 'condition', 'preference']);
      assertMemoryTaskRequest(current);
      assert.throws(() => assertMemoryTaskRequest({ ...current, stateAnalysisTasks: current.stateAnalysisTasks.map((child, index) =>
        index === 0 ? { ...child, stateFamily: 'condition' } : child) }), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
      const canonical = await stateFixtureOutput(current, fixtures, material);
      const output = packedStateFixture(tool.parameters, canonical);
      assert.ok(output.results.task1.analyses[0].judgments.targetIntent);
      assert.equal(output.results.task3.analyses[0].judgments.behaviorConditions, null, 'No evidence remains an abstention.');
      validateMemoryTaskOutput(current, current.decodeOutput(output));
      return { ok: true, json: async () => ({ id: 'cross-family-receipt', model: 'fixture', usage: { prompt_tokens: 100, completion_tokens: 30 },
        choices: [{ message: { tool_calls: [{ function: { name: tool.name, arguments: JSON.stringify(output) } }] } }] }) };
    },
  });
  const generator = Object.assign(async request => { current = request; calls.push(request); return native(request); },
    { supportsCombinedStateAnalysis: true, measureRequest: native.measureRequest });
  const report = await withUsageRecorder(charge => charges.push(charge), () => processPendingStateAnalysisRequests({
    repository: f.repository, agentId: 'agent-test', maxRequests: 3, generator, usageLedgerPath: path.join(os.tmpdir(), 'unused-state-ledger.jsonl'),
  }));
  assert.equal(calls.length, 1, JSON.stringify(report.results.map(result => ({ status: result.status, reason: result.reason }))));
  assert.equal(report.selected, 3);
  assert.ok(report.results.every(result => result.status === 'proposal-pending'), JSON.stringify(report.results.map(result => ({ status: result.status, reason: result.reason }))));
  assert.equal(charges.length, 1);
  assert.deepEqual(charges[0].metadata.stateAnalysisRequestIds, fixtures.map(item => item.request.id));
  const runs = f.repository.listStateAnalysisRuns('agent-test', { limit: 100 });
  assert.equal(runs.reduce((sum, run) => sum + Number(run.usage.prompt_tokens || 0), 0), 100);
  for (const fixture of fixtures) {
    const saved = f.repository.getStateAnalysisRequest('agent-test', fixture.request.id);
    assert.equal(saved.status, 'completed');
    assert.equal(saved.lease_owner, '');
    assert.equal(saved.metadata.firstStage, undefined, 'Completed work releases its temporary recovery checkpoint.');
  }
});

for (const failure of ['missing-task', 'invalid-source']) test(`cross-family partial success retries only the failed task: ${failure}`, async t => {
  const fixtures = sharedStateRequests(), f = fixtures[0]; t.after(() => f.database.close());
  const calls = [], charges = [];
  const generator = Object.assign(async request => {
    calls.push(request);
    const output = await stateFixtureOutput(request, fixtures);
    if (calls.length === 1) {
      const failed = request.stateAnalysisTasks.find(task => task.stateFamily === 'condition').key;
      if (failure === 'missing-task') delete output.results[failed];
      else output.results[failed].analyses[0].sourceIds = ['unrelated-source'];
    } else assert.equal(request.stateAnalysisRequestId, fixtures[1].request.id, 'A successful sibling cannot be regenerated.');
    return { output, model: 'fixture', requestId: `partial-${calls.length}`, usage: { prompt_tokens: 100, completion_tokens: 30 } };
  }, { supportsCombinedStateAnalysis: true });
  const report = await withUsageRecorder(charge => charges.push(charge), () => processPendingStateAnalysisRequests({
    repository: f.repository, agentId: 'agent-test', maxRequests: 2, generator, usageLedgerPath: path.join(os.tmpdir(), 'unused-state-ledger.jsonl'),
  }));
  assert.equal(calls.length, 2);
  assert.deepEqual(report.results.map(result => result.automaticRetries), [0, 1]);
  assert.ok(report.results.every(result => result.status === 'proposal-pending'));
  assert.deepEqual(charges.map(charge => charge.requestId), ['partial-1', 'partial-2']);
  assert.equal(f.repository.listStateAnalysisRuns('agent-test', { limit: 100 })
    .reduce((sum, run) => sum + Number(run.usage.prompt_tokens || 0), 0), 200);
  const goalRuns = f.repository.listStateAnalysisRuns('agent-test', { stateFamily: 'goal', limit: 100 });
  assert.equal(goalRuns.filter(run => run.analyzer_role === 'target-intent').length, 1);
});

async function establishStateCandidates(fixtures) {
  const memories = [];
  for (const [index, fixture] of fixtures.entries()) {
    const previous = setupRequest({ database: fixture.database, repository: fixture.repository, suffix: String(20 + index),
      stateFamily: fixture.request.state_family, targetLabel: fixture.request.target_label,
      content: fixture.request.state_family === 'goal' ? '我计划整理书单。' : '我最近工作很忙。', createdAt: '2026-07-09T02:00:00.000Z' });
    const result = await processStateAnalysisRequest({ repository: fixture.repository, agentId: 'agent-test', requestId: previous.request.id,
      generator: Object.assign(async request => ({ output: await stateFixtureOutput(request, [previous]), model: 'fixture' }), { supportsCombinedStateAnalysis: true }) });
    assert.equal(result.status, 'proposal-pending', result.reason);
    memories.push(resolveReportedStateProposal(fixture.repository, { agentId: 'agent-test', proposalId: result.proposal.id, action: 'accept' }).memory);
  }
  return memories;
}

test('cross-family matching binds each schema to its own candidates and keeps comparison calls separate', async t => {
  const fixtures = sharedStateRequests(), f = fixtures[0]; t.after(() => f.database.close());
  const candidates = await establishStateCandidates(fixtures);
  const calls = [];
  const generator = Object.assign(async request => {
    calls.push(request);
    if (request.stateAnalysisTasks) {
      const input = JSON.parse(request.modelInput);
      const candidateSets = request.stateAnalysisTasks.map(task => {
        const schema = request.modelSchema.properties.results.properties[task.key].properties.stateMatch;
        const matched = schema.anyOf.find(branch => branch.properties.resolution.enum.includes('matched'));
        const expected = input.tasks[task.key].stateCandidates.map(item => item.id);
        assert.deepEqual(matched.properties.candidateId.enum, expected);
        return new Set(expected);
      });
      assert.ok([...candidateSets[0]].every(id => !candidateSets[1].has(id)), 'The two tasks cannot select each other\'s candidates.');
      assertMemoryTaskRequest(request);
    } else {
      assert.equal(request.analyzerRole, 'current-relation');
      const input = JSON.parse(request.modelInput);
      assert.equal(Object.hasOwn(input, 'stateCandidates'), false);
      assert.equal(input.currentState.title, f.request.target_label);
    }
    const output = await stateFixtureOutput(request, fixtures);
    validateMemoryTaskOutput(request, output);
    return { output, model: 'fixture' };
  }, { supportsCombinedStateAnalysis: true });
  const report = await processPendingStateAnalysisRequests({ repository: f.repository, agentId: 'agent-test', maxRequests: 2, generator });
  assert.equal(calls.length, 2, JSON.stringify({ calls: calls.map(call => call.schemaName),
    results: report.results.map(result => ({ status: result.status, reason: result.reason })),
    runs: f.repository.listStateAnalysisRuns('agent-test', { limit: 100 }).map(run => ({ role: run.analyzer_role, error: run.error_message, rejected: run.rejected })) }));
  assert.equal(report.results.length, 2);
  for (const [index, fixture] of fixtures.entries()) {
    const saved = f.repository.getStateAnalysisRequest('agent-test', fixture.request.id);
    assert.equal(saved.metadata.stateIdentityResolution.candidateId, candidates[index].id);
    assert.equal(saved.status, 'completed');
  }
});

for (const changed of ['none', 'evidence', 'candidate']) test(`cross-family first-stage checkpoints resume after closing the database; changed ${changed}`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'state-first-stage-restart-'));
  let database = openMemoryDatabase(path.join(directory, 'memory.db'));
  t.after(() => { database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const fixtures = sharedStateRequests({ database }), f = fixtures[0];
  const candidates = await establishStateCandidates(fixtures);
  const comparisonEntered = Promise.withResolvers(), release = Promise.withResolvers(), controller = new AbortController();
  const charges = [];
  const generator = Object.assign(async request => {
    if (!request.stateAnalysisTasks) {
      comparisonEntered.resolve(); await release.promise;
      controller.signal.throwIfAborted();
    }
    return { output: await stateFixtureOutput(request, fixtures), model: 'fixture', requestId: 'before-restart', usage: { prompt_tokens: 100, completion_tokens: 30 } };
  }, { supportsCombinedStateAnalysis: true });
  const pending = withUsageRecorder(charge => charges.push(charge), () => withEventSourceExecution(f.repository,
    () => processPendingStateAnalysisRequests({ repository: f.repository, agentId: 'agent-test', maxRequests: 2, generator,
      usageLedgerPath: path.join(directory, 'usage.jsonl') }), { signal: controller.signal }));
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await comparisonEntered.promise;
  await new Promise(resolve => setImmediate(resolve));
  const beforeStop = fixtures.map(fixture => f.repository.getStateAnalysisRequest('agent-test', fixture.request.id));
  controller.abort(); release.resolve(); await rejected;
  assert.ok(beforeStop[0].metadata.firstStage);
  assert.equal(beforeStop[1].status, 'completed', JSON.stringify({ checkpoint: beforeStop[1].metadata.firstStage,
    failures: beforeStop[1].metadata.failureHistory }));
  database.close(); database = openMemoryDatabase(path.join(directory, 'memory.db'));
  const repository = new MemoryRepository(database);
  repository.recoverStateAnalysisRequests('agent-test', { force: true });
  if (changed !== 'none') {
    const memory = changed === 'evidence' ? f.memory : candidates[0];
    repository.editMemoryManually({ agentId: 'agent-test', memoryId: memory.id,
      patch: { content: memory.content + ' 这条记录已补充说明。' } });
  }
  const resumed = [];
  const report = await withUsageRecorder(charge => charges.push(charge), () => processPendingStateAnalysisRequests({
    repository, agentId: 'agent-test', maxRequests: 2, usageLedgerPath: path.join(directory, 'usage.jsonl'),
    generator: Object.assign(async request => {
      resumed.push(request);
      return { output: await stateFixtureOutput(request, fixtures), model: 'fixture', requestId: 'after-restart', usage: { prompt_tokens: 40, completion_tokens: 10 } };
    }, { supportsCombinedStateAnalysis: true }),
  }));
  assert.equal(report.selected, 1);
  assert.deepEqual(resumed.map(request => request.analyzerRole), changed === 'none'
    ? ['current-relation'] : ['combined-evidence', 'current-relation'], 'Only a checkpoint with unchanged evidence and candidates may be reused.');
  assert.deepEqual(charges.map(charge => charge.requestId), changed === 'none'
    ? ['before-restart', 'after-restart'] : ['before-restart', 'after-restart', 'after-restart']);
  assert.equal(repository.getStateAnalysisRequest('agent-test', f.request.id).status, 'completed');
  assert.equal(repository.getStateAnalysisRequest('agent-test', f.request.id).metadata.firstStage, undefined);
  assert.equal(repository.listStateAnalysisRuns('agent-test', { stateFamily: 'condition', limit: 100 })
    .filter(run => run.metadata.stateAnalysisRequestId === fixtures[1].request.id).length, 1);
});

for (const change of ['evidence', 'edit-and-restore', 'source-record', 'candidate']) test(`cross-family source checks isolate obsolete work and preserve one paid receipt: ${change}`, async t => {
  const fixtures = sharedStateRequests(), f = fixtures[0]; t.after(() => f.database.close());
  const candidates = await establishStateCandidates(fixtures);
  const entered = Promise.withResolvers(), release = Promise.withResolvers(), charges = [];
  let calls = 0;
  const generator = Object.assign(async request => {
    calls++; entered.resolve(); await release.promise;
    return { output: await stateFixtureOutput(request, fixtures), model: 'fixture', requestId: 'obsolete-group', usage: { prompt_tokens: 100, completion_tokens: 30 } };
  }, { supportsCombinedStateAnalysis: true });
  const pending = withUsageRecorder(charge => charges.push(charge), () => processPendingStateAnalysisRequests({
    repository: f.repository, agentId: 'agent-test', maxRequests: 2, generator, usageLedgerPath: path.join(os.tmpdir(), 'unused-state-ledger.jsonl'),
  }));
  await entered.promise;
  const memory = change === 'candidate' ? candidates[0] : f.memory;
  if (change === 'source-record') f.repository.upsertSource({ agentId: 'agent-test', sourceKind: f.source.source_kind,
    externalId: f.source.external_id, content: '原始来源已更正。', speaker: f.source.speaker });
  else f.repository.editMemoryManually({ agentId: 'agent-test', memoryId: memory.id, patch: { content: '记录有误，已更正。' } });
  if (change === 'edit-and-restore') f.repository.editMemoryManually({ agentId: 'agent-test', memoryId: memory.id, patch: { content: memory.content } });
  release.resolve();
  const report = await pending;
  assert.equal(calls, 1);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].requestId, 'obsolete-group');
  for (const [index, result] of report.results.entries()) {
    if (change === 'candidate' && index === 1) {
      assert.equal(result.request.status, 'completed');
      assert.equal(f.repository.listStateAnalysisRuns('agent-test', { stateFamily: 'condition', limit: 100 })
        .filter(run => run.metadata.stateAnalysisRequestId === fixtures[index].request.id).length, 1);
    }
    else {
      assert.equal(result.status, 'deferred');
      assert.equal(result.reason, 'STATE_ANALYSIS_INPUT_CHANGED');
      const saved = f.repository.getStateAnalysisRequest('agent-test', fixtures[index].request.id);
      assert.equal(saved.metadata.firstStage, undefined);
      assert.equal(saved.metadata.attemptCount || 0, 0);
    }
  }
  assert.equal(f.repository.listStateAnalysisRuns('agent-test', { stateFamily: 'goal', limit: 100 })
    .filter(run => run.metadata.stateAnalysisRequestId === f.request.id).length, 0);
});

for (const limit of ['request', 'judgments', 'truncation']) test(`cross-family batching splits complete tasks at the ${limit} boundary and records every receipt`, async t => {
  const fixtures = sharedStateRequests(), f = fixtures[0]; t.after(() => f.database.close());
  const calls = [], charges = [];
  const generator = Object.assign(async request => {
    calls.push(request);
    const receipt = { model: 'fixture', requestId: `budget-${calls.length}`, usage: { prompt_tokens: 100, completion_tokens: 30 } };
    if (request.stateAnalysisTasks && limit === 'truncation') throw Object.assign(new Error('Output truncated.'), receipt, { code: 'MAX_TOKENS' });
    assert.equal(request.stateAnalysisTasks, undefined, 'A split must retain the original complete child task.');
    return { ...receipt, output: await stateFixtureOutput(request, fixtures) };
  }, { supportsCombinedStateAnalysis: true,
    measureRequest: request => (request.modelInput || request.input).length + request.systemPrompt.length + JSON.stringify(request.modelSchema || request.schema).length });
  const report = await withUsageRecorder(charge => charges.push(charge), () => processPendingStateAnalysisRequests({
    repository: f.repository, agentId: 'agent-test', maxRequests: 2, generator, usageLedgerPath: path.join(os.tmpdir(), 'unused-state-ledger.jsonl'),
    firstStageBatchOptions: limit === 'request' ? { maximumRequestCharacters: 1000 } : limit === 'judgments' ? { maximumJudgments: 3 } : {},
  }));
  assert.equal(calls.length, limit === 'truncation' ? 3 : 2);
  assert.equal(charges.length, calls.length);
  assert.equal(new Set(charges.map(charge => charge.requestId)).size, calls.length);
  assert.deepEqual(calls.slice(-2).map(call => call.stateAnalysisRequestId), fixtures.map(fixture => fixture.request.id));
  assert.ok(report.results.every(result => result.status === 'proposal-pending'));
  assert.equal(report.automaticRetries, 0, 'Shrinking the transport batch is not a failed domain judgment.');
});

for (const replace of [false, true]) test(`cross-family groups own one Agent lane across connections; replacement ${replace}`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'state-group-lease-'));
  const database = openMemoryDatabase(path.join(directory, 'memory.db'));
  const fixtures = sharedStateRequests({ database }), f = fixtures[0];
  const peerDatabase = openMemoryDatabase(path.join(directory, 'memory.db')), peer = new MemoryRepository(peerDatabase);
  t.after(() => { peerDatabase.close(); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const gates = [0, 1].map(() => ({ entered: Promise.withResolvers(), release: Promise.withResolvers() }));
  const charges = [], calls = [];
  const run = (repository, index) => withUsageRecorder(charge => charges.push(charge), () => processPendingStateAnalysisRequests({
    repository, agentId: 'agent-test', maxRequests: 2, usageLedgerPath: path.join(directory, 'usage.jsonl'),
    generator: Object.assign(async request => {
      calls.push(index); gates[index].entered.resolve(); await gates[index].release.promise;
      return { output: await stateFixtureOutput(request, fixtures), model: 'fixture', requestId: `owner-${index}`, usage: { prompt_tokens: 100, completion_tokens: 30 } };
    }, { supportsCombinedStateAnalysis: true }),
  }));
  const first = run(f.repository, 0); await gates[0].entered.promise;
  const owners = fixtures.map(fixture => peer.getStateAnalysisRequest('agent-test', fixture.request.id).lease_owner);
  assert.ok(owners[0]); assert.equal(owners[0], owners[1]);
  if (replace) peerDatabase.prepare("UPDATE memory_state_analysis_requests SET lease_expires_at='2000-01-01T00:00:00Z'").run();
  const second = run(peer, 1);
  if (replace) await gates[1].entered.promise;
  else assert.deepEqual((await second).results.map(result => result.status), ['deferred', 'deferred']);
  const activeOwner = peer.getStateAnalysisRequest('agent-test', fixtures[0].request.id).lease_owner;
  gates[0].release.resolve(); const original = await first;
  if (replace) {
    assert.ok(original.results.every(result => result.reason === 'STATE_ANALYSIS_LEASE_LOST'));
    assert.equal(peer.getStateAnalysisRequest('agent-test', fixtures[0].request.id).lease_owner, activeOwner);
    assert.equal(f.repository.listStateAnalysisRuns('agent-test', { limit: 100 }).length, 0);
    gates[1].release.resolve();
    assert.ok((await second).results.every(result => result.status === 'proposal-pending'));
  } else assert.ok(original.results.every(result => result.status === 'proposal-pending'));
  assert.equal(calls.length, replace ? 2 : 1);
  assert.equal(charges.length, calls.length);
  assert.ok(fixtures.every(fixture => !peer.getStateAnalysisRequest('agent-test', fixture.request.id).lease_owner));
});

test('cross-family scheduling respects earlier same-family tasks and distinct extraction boundaries', async t => {
  const fixtures = sharedStateRequests(), f = fixtures[0]; t.after(() => f.database.close());
  const nextGoal = setupRequest({ database: f.database, repository: f.repository, sharedEvidence: f,
    suffix: '3', stateFamily: 'goal', targetLabel: '完成书单', batchId: f.request.batch_id,
    eventFields: { content: '用户计划完成书单。' } });
  const nextCondition = setupRequest({ database: f.database, repository: f.repository, sharedEvidence: f,
    suffix: '4', stateFamily: 'condition', targetLabel: '工作繁忙', batchId: 'another-extraction-boundary' });
  fixtures.push(nextGoal, nextCondition);
  const calls = [];
  const report = await processPendingStateAnalysisRequests({ repository: f.repository, agentId: 'agent-test', maxRequests: 4,
    generator: Object.assign(async request => {
      calls.push(request);
      if (request.stateAnalysisRequestId === nextGoal.request.id) {
        assert.equal(f.repository.getStateAnalysisRequest('agent-test', f.request.id).status, 'completed');
      }
      return { output: await stateFixtureOutput(request, fixtures), model: 'fixture' };
    }, { supportsCombinedStateAnalysis: true }),
  });
  assert.equal(report.selected, 4);
  assert.equal(calls.filter(call => call.stateAnalysisTasks).length, 1);
  assert.deepEqual(calls[0].stateAnalysisTasks.map(task => task.stateAnalysisRequestId), fixtures.slice(0, 2).map(fixture => fixture.request.id));
  assert.ok(calls.some(call => call.stateAnalysisRequestId === nextGoal.request.id && call.schemaName === 'memory-state-match-analysis-v1'),
    'A later goal must see the completed earlier goal before matching.');
  assert.ok(calls.some(call => call.stateAnalysisRequestId === nextCondition.request.id));
});

test('cross-family preparation failure releases the ready sibling and does not regenerate it', async t => {
  const fixtures = sharedStateRequests(), f = fixtures[0]; t.after(() => f.database.close());
  const calls = [];
  const report = await processPendingStateAnalysisRequests({ repository: f.repository, agentId: 'agent-test', maxRequests: 2,
    embeddingProvider: Object.assign(async text => {
      if (text.includes('用户最近工作繁忙')) throw new Error('The condition embedding is temporarily unavailable.');
      return { model: 'fixture-embedding', vector: [1, 0] };
    }, { model: 'fixture-embedding', dimensions: 2 }),
    generator: Object.assign(async request => {
      calls.push(request.stateAnalysisRequestId);
      return { output: await stateFixtureOutput(request, fixtures), model: 'fixture' };
    }, { supportsCombinedStateAnalysis: true }),
  });
  assert.deepEqual(calls, [f.request.id]);
  assert.deepEqual(report.results.map(result => result.status), ['proposal-pending', 'provisional-review']);
  assert.deepEqual(report.results.map(result => result.automaticRetries), [0, 2]);
  assert.ok(fixtures.every(fixture => !f.repository.getStateAnalysisRequest('agent-test', fixture.request.id).lease_owner));
});

test('state requests are claimed across connections and preserve the Agent analysis order', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'state-request-lease-'));
  const database = openMemoryDatabase(path.join(directory, 'memory.db'));
  const f = setupRequest({ database, stateFamily: 'goal' });
  const peerDatabase = openMemoryDatabase(path.join(directory, 'memory.db'));
  const peer = new MemoryRepository(peerDatabase);
  t.after(() => { peerDatabase.close(); database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const next = setupRequest({ database, repository: f.repository, suffix: '2', stateFamily: 'goal' });
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  let calls = 0;
  const base = combinedGoalGenerator(f, []);
  const generator = Object.assign(async request => { calls++; entered.resolve(); await release.promise; return base(request); },
    { supportsCombinedStateAnalysis: true });
  const pending = processStateAnalysisRequest({ repository: f.repository, agentId: 'agent-test', requestId: f.request.id, generator });
  await entered.promise;
  const competing = [f.request.id, next.request.id].map(requestId =>
    processStateAnalysisRequest({ repository: peer, agentId: 'agent-test', requestId, generator }));
  const settled = Promise.allSettled([pending, ...competing]);
  await new Promise(resolve => setImmediate(resolve));
  release.resolve();
  const results = await settled;
  assert.equal(calls, 1, 'a concurrent maintenance pass must not purchase another analysis');
  assert.equal(results[0].value.status, 'proposal-pending');
  for (const result of results.slice(1)) assert.equal(result.value.status, 'deferred');
  assert.equal(peer.getStateAnalysisRequest('agent-test', f.request.id).lease_owner, '');
  assert.equal(peer.getStateAnalysisRequest('agent-test', next.request.id).status, 'pending');
});

test('expired state leases reject late results and keep the replacement worker claim', async t => {
  const f = setupRequest({ stateFamily: 'goal' });
  t.after(() => f.database.close());
  const gates = [0, 1].map(() => ({ entered: Promise.withResolvers(), release: Promise.withResolvers() }));
  const base = combinedGoalGenerator(f, []);
  const run = index => processStateAnalysisRequest({ repository: f.repository, agentId: 'agent-test', requestId: f.request.id,
    generator: Object.assign(async request => { gates[index].entered.resolve(); await gates[index].release.promise; return base(request); },
      { supportsCombinedStateAnalysis: true }) });
  const original = run(0);
  await gates[0].entered.promise;
  f.database.prepare("UPDATE memory_state_analysis_requests SET lease_expires_at='2000-01-01T00:00:00.000Z'").run();
  const replacement = run(1);
  await gates[1].entered.promise;
  const owner = f.repository.getStateAnalysisRequest('agent-test', f.request.id).lease_owner;
  gates[0].release.resolve();
  const obsolete = await original;
  assert.equal(obsolete.status, 'deferred');
  assert.equal(obsolete.reason, 'STATE_ANALYSIS_LEASE_LOST');
  assert.equal(f.repository.getStateAnalysisRequest('agent-test', f.request.id).lease_owner, owner);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM memory_state_evidence_observations').get().n, 0);
  gates[1].release.resolve();
  assert.equal((await replacement).status, 'proposal-pending');
});

for (const change of ['edit', 'edit-and-restore', 'cancel']) test(`in-flight state analysis fences ${change} while retaining its paid receipt`, async t => {
  const f = setupRequest({ stateFamily: 'goal', targetLabel: '整理书单', content: '我准备整理书单。' });
  t.after(() => f.database.close());
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const controller = new AbortController(), charges = [];
  const base = combinedGoalGenerator(f, []);
  const generator = Object.assign(async request => { entered.resolve(); await release.promise;
    return { ...await base(request), requestId: 'state-late-receipt' }; }, { supportsCombinedStateAnalysis: true });
  const pending = withUsageRecorder(charge => charges.push(charge), () => withEventSourceExecution(f.repository,
    () => processStateAnalysisRequest({ repository: f.repository, agentId: 'agent-test', requestId: f.request.id,
      generator, usageLedgerPath: path.join(os.tmpdir(), 'unused-state-ledger.jsonl') }), { signal: controller.signal }));
  const rejected = change === 'cancel' ? assert.rejects(pending, { name: 'AbortError' }) : null;
  await entered.promise;
  if (change === 'cancel') controller.abort();
  else {
    f.repository.editMemoryManually({ agentId: 'agent-test', memoryId: f.memory.id, patch: { content: '这条记录写错了。' } });
    if (change === 'edit-and-restore') f.repository.editMemoryManually({ agentId: 'agent-test', memoryId: f.memory.id,
      patch: { content: f.memory.content } });
  }
  release.resolve();
  if (rejected) await rejected;
  else assert.equal((await pending).reason, 'STATE_ANALYSIS_INPUT_CHANGED');
  assert.equal(charges.length, 1);
  assert.equal(charges[0].requestId, 'state-late-receipt');
  assert.equal(charges[0].usage.prompt_tokens, 100);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM memory_state_evidence_observations').get().n, 0);
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM memory_reported_state_proposals').get().n, 0);
  const current = f.repository.getStateAnalysisRequest('agent-test', f.request.id);
  assert.equal(current.status, 'pending');
  assert.equal(current.metadata.attemptCount || 0, 0, 'obsolete material is not a model failure or an automatic retry');
  if (change === 'cancel') {
    assert.ok(current.lease_owner, 'cancelled executions preserve the lease until recovery');
    assert.equal(f.repository.recoverStateAnalysisRequests('agent-test', { force: true }).recovered, 1);
  }
  assert.equal((await processStateAnalysisRequest({ repository: f.repository, agentId: 'agent-test',
    requestId: f.request.id, generator: combinedGoalGenerator(f, []) })).status, 'proposal-pending');
});

for (const language of ['zh', 'en']) test(`specialist fallback queues searchable evidence without provider retries: ${language}`, async t => {
  const fixture = setupRequest({ content: language === 'en' ? 'I have always enjoyed puzzle games.' : '我一直很喜欢解谜游戏。' });
  t.after(() => fixture.database.close());
  let calls = 0;
  const generator = async () => { calls += 1; throw new Error("Provider must not be called"); };
  generator.supportsCombinedStateAnalysis = true;
  generator.assertRequestBudget = () => { throw stateAnalysisBudgetError("Complete specialist material exceeds the token budget."); };
  const report = await processPendingStateAnalysisRequests({ repository: fixture.repository, agentId: "agent-test",
    generator, maxRequests: 10 });
  assert.equal(calls, 0);
  assert.equal(report.results[0].status, "provisional-review");
  assert.equal(report.results[0].automaticRetries, 0);
  assert.equal(report.results[0].attempts.length, 1);
  assert.equal(fixture.repository.getMemory(fixture.memory.id).content, fixture.source.content);
  const pending = fixture.repository.listPendingProvisionalMemories("agent-test");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].content, fixture.source.content);
  const tasks = fixture.repository.listMaintenanceTasks('agent-test', { taskTypes: ['memory-embedding'] });
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0].payload.memoryIds, [pending[0].id]);
  let embeddingCalls = 0;
  const embeddingProvider = Object.assign(async () => {
    embeddingCalls++;
    return { model: 'fallback-test', vector: [1, 0] };
  }, { model: 'fallback-test', dimensions: 2 });
  const indexed = await runEmbeddingMaintenance({ repository: fixture.repository, agentId: 'agent-test', embeddingProvider });
  assert.equal(indexed.status, 'completed');
  assert.equal(embeddingCalls, 1);
  assert.ok(fixture.repository.listEmbeddings('agent-test', 'fallback-test', { includeArchived: true })
    .some(row => row.memory_id === pending[0].id));
  assert.equal(fixture.repository.getMemory(pending[0].id).layer, 'provisional');
  assert.equal(fixture.repository.listPendingProvisionalMemories('agent-test').length, 1);
  assert.equal((await processPendingStateAnalysisRequests({ repository: fixture.repository, agentId: "agent-test",
    generator, maxRequests: 10 })).selected, 0);
  assert.equal((await runEmbeddingMaintenance({ repository: fixture.repository, agentId: 'agent-test', embeddingProvider })).selected, 0);
  assert.equal(embeddingCalls, 1);
});

test('fallback evidence and its embedding task commit together', t => {
  const fixture = setupRequest();
  t.after(() => fixture.database.close());
  const enqueue = fixture.repository.enqueueMaintenanceTask;
  fixture.repository.enqueueMaintenanceTask = () => { throw new Error('Queue unavailable'); };
  assert.throws(() => fallbackStateAnalysisToProvisionalReview({ repository: fixture.repository, request: fixture.request }),
    /Queue unavailable/);
  assert.equal(fixture.repository.getStateAnalysisRequest('agent-test', fixture.request.id).status, 'pending');
  assert.equal(fixture.repository.listPendingProvisionalMemories('agent-test').length, 0);
  assert.equal(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes WHERE layer='provisional'").get().count, 0);
  fixture.repository.enqueueMaintenanceTask = enqueue;
  const result = fallbackStateAnalysisToProvisionalReview({ repository: fixture.repository, request: fixture.request });
  assert.equal(result.request.status, 'completed');
  assert.equal(fixture.repository.listMaintenanceTasks('agent-test', { taskTypes: ['memory-embedding'] }).length, 1);
});

test("oversized complete evidence snapshots enter review without repeated preparation", async t => {
  const content = "完整原始材料".repeat(6000) + "尾部保留";
  const fixture = setupRequest({ content });
  t.after(() => fixture.database.close());
  let calls = 0;
  const result = await processStateAnalysisRequest({ repository: fixture.repository, agentId: "agent-test",
    requestId: fixture.request.id, generator: async () => { calls += 1; } });
  assert.equal(result.status, "provisional-review");
  assert.match(result.reason, /budget/u);
  assert.equal(calls, 0);
  assert.equal(fixture.repository.getMemory(fixture.memory.id).content, content);
  assert.equal(fixture.repository.listPendingProvisionalMemories("agent-test")[0].content, content);
});

test("processes a request-bound utterance into a pending reported preference proposal", async () => {
  const fixture = setupRequest();
  const beforeNodes = Number(
    fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count,
  );
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: directPreferenceGenerator(fixture),
  });
  assert.equal(result.status, "proposal-pending");
  assert.equal(result.request.status, "completed");
  assert.equal(result.review.status, "ready");
  assert.equal(result.review.representationLayer, "reported");
  assert.equal(result.proposal.review_state, "pending");
  assert.equal(result.proposal.state_family, "preference");
  assert.equal(result.proposal.representation_layer, "reported");
  assert.equal(result.proposal.metadata.stateAnalysisRequestId, fixture.request.id);
  const draft = fixture.repository.getMemory(result.proposal.metadata.semanticMemoryId);
  assert.equal(draft.metadata.stateAnalysisDraft, true);
  assert.equal(draft.status, 'archived', 'The source narrative draft is not an additional active memory.');
  assert.equal(draft.content, fixture.source.content);
  assert.deepEqual(result.proposal.metadata.semanticMemorySnapshot, { title: draft.title, content: draft.content });
  assert.equal(fixture.repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
  }).length, 0);
  assert.equal(fixture.repository.listReportedStateProposals("agent-test", {
    reviewStates: ["pending"],
    stateFamily: "preference",
  }).length, 1);
  assert.equal(
    Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    beforeNodes + 2,
  );
  fixture.database.close();
});

test('reprocessing a withdrawn preference leaves its source and creates no replacement memory', async t => {
  const first = setupRequest();
  t.after(() => first.database.close());
  const { repository } = first;
  const analyze = fixture => processStateAnalysisRequest({ repository, agentId: 'agent-test', requestId: fixture.request.id,
    generator: directPreferenceGenerator(fixture) });
  const created = await analyze(first);
  const memoryId = created.proposal.resultMemoryId;
  assert.equal(repository.getMemory(memoryId).status, 'active');
  resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: created.proposal.id, action: 'dismiss' });

  const replay = setupRequest({ database: first.database, repository, sharedEvidence: first, suffix: '2' });
  const analyzedAgain = await analyze(replay);
  assert.equal(analyzedAgain.status, 'completed-without-proposal');
  assert.equal(repository.getMemory(memoryId).status, 'deleted');
  assert.equal(repository.getMemory(first.memory.id).content, first.source.content);
  assert.equal(repository.listMemories('agent-test', { kinds: ['preference'] }).total, 0);
  assert.deepEqual(repository.listPendingProvisionalMemories('agent-test'), []);
});

test("processes a request-bound explicit goal without rewriting the utterance provenance", async () => {
  const fixture = setupRequest({
    stateFamily: "goal",
    targetLabel: "整理并发布记忆系统",
  });
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: directGoalGenerator(fixture),
  });
  assert.equal(result.status, "proposal-pending");
  assert.equal(result.request.status, "completed");
  assert.equal(result.review.status, "ready");
  assert.equal(result.proposal.state_family, "goal");
  assert.equal(result.proposal.representation_layer, "reported");
  assert.equal(result.proposal.review_state, "pending");
  assert.equal(fixture.repository.getMemory(fixture.memory.id).evidence_mode, "imported");
  fixture.database.close();
});

test("combines related goal evidence and skips the external relation call when no current state exists", async () => {
  const fixture = setupRequest({
    stateFamily: "goal",
    targetLabel: "整理并发布记忆系统",
  });
  const calls = [];
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: combinedGoalGenerator(fixture, calls),
  });
  assert.equal(result.status, "proposal-pending");
  assert.equal(calls.length, 1);
  assert.equal(result.evaluation.runs.targetIntent.model, "test-combined-goal");
  assert.equal(result.evaluation.runs.currentRelation.model, "local-deterministic-rule");
  assert.equal(result.evaluation.analyses.currentRelation[0].relation, "no_current_state");
  const totalPromptTokens = Object.values(result.evaluation.runs)
    .reduce((sum, run) => sum + Number(run.usage?.prompt_tokens || 0), 0);
  assert.equal(totalPromptTokens, 100);
  fixture.database.close();
});

test("processes a request-bound explicit condition through the family-specific review", async () => {
  const fixture = setupRequest({
    stateFamily: "condition",
    targetLabel: "最近需要持续加班",
  });
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: directConditionGenerator(fixture),
  });
  assert.equal(result.status, "proposal-pending");
  assert.equal(result.review.status, "ready");
  assert.equal(result.proposal.state_family, "condition");
  assert.equal(result.proposal.representation_layer, "reported");
  assert.equal(fixture.repository.getMemory(fixture.memory.id).evidence_mode, "imported");
  fixture.database.close();
});

test("leaves a request pending when its family still lacks required structured target fields", async () => {
  const fixture = setupRequest({
    stateFamily: "identity",
    targetLabel: "当前职业",
  });
  let calls = 0;
  const result = await processStateAnalysisRequest({
    repository: fixture.repository,
    agentId: "agent-test",
    requestId: fixture.request.id,
    generator: async () => {
      calls += 1;
      return { output: { analyses: [] } };
    },
  });
  assert.equal(result.status, "unsupported");
  assert.equal(result.request.status, "pending");
  assert.equal(calls, 0);
  fixture.database.close();
});

test("dispatches every label-complete reported family without inventing missing evidence", async () => {
  for (const stateFamily of [
    "goal",
    "value",
    "capability",
    "self_concept",
    "condition",
    "habit",
    "disposition",
  ]) {
    const fixture = setupRequest({
      stateFamily,
      targetLabel: `测试目标-${stateFamily}`,
    });
    let calls = 0;
    const result = await processStateAnalysisRequest({
      repository: fixture.repository,
      agentId: "agent-test",
      requestId: fixture.request.id,
      generator: async ({ analyzerRole }) => {
        calls += 1;
        return {
          output: { analyses: [] },
          model: `test-${analyzerRole}`,
          metadata: { provider: "test" },
        };
      },
    });
    assert.equal(result.status, "provisional-review", stateFamily);
    assert.equal(result.request.status, "completed", stateFamily);
    assert.equal(result.review.status, "skipped", stateFamily);
    assert.ok(calls > 0, stateFamily);
    assert.equal(fixture.repository.listReportedStateProposals("agent-test").length, 0);
    fixture.database.close();
  }
});

test("dispatches structured-target reported families without inventing missing evidence", async () => {
  for (const [stateFamily, targetSpec] of Object.entries({
    identity: {
      identityField: "occupation",
      fieldCardinality: "multi_item",
    },
    belief: {
      objectRole: "world",
      objectKey: "",
      objectLabel: "鱼是否好吃",
    },
    relationship: {
      counterpartRole: "agent",
      counterpartKey: "agent-test",
      counterpartLabel: "Agent",
      direction: "holder_to_counterpart",
    },
    affective_association: {
      triggerRole: "other",
      triggerKey: "place:science-museum",
      triggerLabel: "科技馆",
    },
  })) {
    const fixture = setupRequest({
      stateFamily,
      targetLabel: `测试目标-${stateFamily}`,
      targetSpec,
    });
    let calls = 0;
    const result = await processStateAnalysisRequest({
      repository: fixture.repository,
      agentId: "agent-test",
      requestId: fixture.request.id,
      generator: async ({ analyzerRole }) => {
        calls += 1;
        return {
          output: { analyses: [] },
          model: `test-${analyzerRole}`,
          metadata: { provider: "test" },
        };
      },
    });
    assert.equal(result.status, "provisional-review", stateFamily);
    assert.equal(result.request.status, "completed", stateFamily);
    assert.equal(result.review.status, "skipped", stateFamily);
    assert.ok(calls > 0, stateFamily);
    assert.equal(fixture.repository.listReportedStateProposals("agent-test").length, 0);
    fixture.database.close();
  }
});

for (const [label, content] of [
  ['flowers', 'Flowers always remind me of my wedding and bring me joy.'],
  ['花朵', '看到花朵总让我想起婚礼，心里很开心。'],
]) test(`world affective triggers retain object identity through reported-state acceptance: ${label}`, async t => {
  const f = setupRequest({ stateFamily: 'affective_association', targetLabel: label, content,
    targetSpec: { triggerRole: 'world', triggerKey: '', triggerLabel: label } });
  t.after(() => f.database.close());
  let calls = 0;
  const generator = Object.assign(async request => {
    calls++;
    assertMemoryTaskRequest(request);
    const common = { memoryId: f.memory.id, sourceIds: [f.source.id], confidence: 0.95, rationale: 'Direct self report.' };
    const output = { results: {
      triggerEmotion: { analyses: [{ ...common, targetMatch: 'exact', triggerType: 'object',
        triggerLabel: label, emotionLabel: 'joy', valence: 'positive', intensity: 'medium' }] },
      experiencerAttribution: { analyses: [{ ...common, experiencerMatch: 'yes', attribution: 'explicit_self_report' }] },
      associationBasis: { analyses: [{ ...common, associationType: 'explicit_trigger_link', causality: 'explicit', recurrence: 'repeated_claim' }] },
      timeRevision: { analyses: [{ ...common, stateTime: 'current', changeCue: 'none' }] },
    } };
    validateMemoryTaskOutput(request, output);
    return { output, model: 'test-world-trigger' };
  }, { supportsCombinedStateAnalysis: true });
  const result = await processStateAnalysisRequest({ repository: f.repository, agentId: 'agent-test',
    requestId: f.request.id, generator });
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.equal(calls, 1);
  assert.equal(result.proposal.draft.affectiveClaim.trigger.role, 'world');
  assert.equal(result.proposal.draft.affectiveClaim.trigger.key, '');
  const accepted = resolveReportedStateProposal(f.repository, { agentId: 'agent-test',
    proposalId: result.proposal.id, action: 'accept' });
  assert.equal(accepted.memory.metadata.reportedStateDraft.affectiveClaim.trigger.label, label);
  assert.equal(accepted.memory.metadata.reportedStateDraft.affectiveClaim.activationBiasStatus, 'disabled');
  const second = setupRequest({ database: f.database, repository: f.repository, suffix: 'world-music',
    stateFamily: 'affective_association', targetLabel: 'music', content: 'Music makes me feel peaceful.',
    targetSpec: { triggerRole: 'world', triggerKey: '', triggerLabel: 'music' } });
  const embeddingProvider = Object.assign(async () => ({ model: 'test-world-embedding', vector: [1, 0] }),
    { model: 'test-world-embedding', dimensions: 2 });
  const context = await prepareStateMemoryCandidates({ repository: f.repository, request: second.request, embeddingProvider });
  assert.equal(context.candidates.some(candidate => candidate.canonicalKey === result.proposal.canonical_key), false);
  assert.throws(() => normalizeStateAnalysisTargetSpec('affective_association', {
    triggerRole: 'world', triggerKey: 'person-id', triggerLabel: label,
  }), /targetSpec/);
  assert.throws(() => normalizeStateAnalysisTargetSpec('affective_association', {
    triggerRole: 'user', triggerKey: '', triggerLabel: 'User',
  }), /targetSpec/);
});

test("processes only the explicitly bounded number of supported pending requests", async () => {
  const first = setupRequest({
    suffix: "1",
    createdAt: "2026-07-11T02:01:00.000Z",
  });
  const second = setupRequest({
    database: first.database,
    repository: first.repository,
    suffix: "2",
    targetLabel: "科幻小说",
    createdAt: "2026-07-11T02:02:00.000Z",
  });
  const fixtures = new Map([
    [first.request.id, first],
    [second.request.id, second],
  ]);
  const result = await processPendingStateAnalysisRequests({
    repository: first.repository,
    agentId: "agent-test",
    maxRequests: 1,
    generator: (input) => directPreferenceGenerator(fixtures.get(input.stateAnalysisRequestId))(input),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.selected, 1);
  assert.equal(result.counts["proposal-pending"], 1);
  assert.equal(first.repository.getStateAnalysisRequest("agent-test", first.request.id).status, "completed");
  assert.equal(first.repository.getStateAnalysisRequest("agent-test", second.request.id).status, "pending");
  first.database.close();
});

test("retries a failed specialist three times, then routes it to review without blocking peers", async () => {
  const first = setupRequest({
    suffix: "1",
    createdAt: "2026-07-11T02:01:00.000Z",
  });
  const second = setupRequest({
    database: first.database,
    repository: first.repository,
    suffix: "2",
    targetLabel: "科幻小说",
    createdAt: "2026-07-11T02:02:00.000Z",
  });
  const fixtures = new Map([
    [first.request.id, first],
    [second.request.id, second],
  ]);
  const attemptIdentities = new Set();
  const run = () => processPendingStateAnalysisRequests({
      repository: first.repository,
      agentId: "agent-test",
      maxRequests: 10,
      generator: (input) => {
        attemptIdentities.add(`${input.stateAnalysisRequestId}:${input.stateAnalysisAttempt}`);
        return directPreferenceGenerator(
        fixtures.get(input.stateAnalysisRequestId),
        { failRole: input.stateAnalysisRequestId === first.request.id ? "time-scope" : "" },
      )(input);
      },
    });
  const result = await run();
  assert.equal(result.status, "completed");
  assert.equal(result.selected, 2);
  assert.equal(result.counts["provisional-review"], 1);
  assert.equal(result.counts["proposal-pending"], 1);
  assert.equal(result.automaticRetries, 2);
  assert.deepEqual([...attemptIdentities].filter(id => id.startsWith(`${first.request.id}:`)),
    [1, 2, 3].map(attempt => `${first.request.id}:${attempt}`));
  assert.equal(first.repository.getStateAnalysisRequest("agent-test", second.request.id).status, "completed");
  const failedRequest = first.repository.getStateAnalysisRequest("agent-test", first.request.id);
  assert.equal(failedRequest.status, "completed");
  assert.equal(failedRequest.metadata.attemptCount, 3);
  assert.equal(failedRequest.metadata.failureHistory.length, 3);
  assert.deepEqual(
    failedRequest.metadata.failureHistory.map((failure) => failure.details.stage),
    ["specialist-analysis", "specialist-analysis", "specialist-analysis"],
  );
  assert.equal(first.repository.listStateAnalysisRequests("agent-test", {
    statuses: ["pending"],
    representationLayer: "inferred",
  }).length, 0);
  first.database.close();
});

test("output token exhaustion is recorded once and sent to review without automatic retries", async () => {
  const fixture = setupRequest();
  let calls = 0;
  const diagnostics = { maxOutputTokens: 65536, usage: { outputTokens: 65536, reasoningTokens: 64000 } };
  const generator = async () => {
    calls++;
    throw Object.assign(new Error('Output protection reached'), { code: 'MAX_TOKENS', diagnostics,
      usage: { prompt_tokens: 100, completion_tokens: 65536 }, model: 'fixture', requestId: 'truncated-state-request' });
  };
  generator.supportsCombinedStateAnalysis = true;
  const run = () => processPendingStateAnalysisRequests({ repository: fixture.repository,
    agentId: 'agent-test', maxRequests: 10, generator });
  const result = await run();
  assert.equal(calls, 1);
  assert.equal(result.automaticRetries, 0);
  assert.equal(result.sentToReview, 1);
  const request = fixture.repository.getStateAnalysisRequest('agent-test', fixture.request.id);
  assert.equal(request.metadata.attemptCount, 1);
  assert.equal(request.metadata.failureHistory[0].details.errorCode, 'MAX_TOKENS');
  assert.deepEqual(request.metadata.failureHistory[0].details.providerDiagnostics, diagnostics);
  assert.equal(fixture.repository.listPendingProvisionalMemories('agent-test')[0].content, fixture.source.content);
  const runs = fixture.repository.listStateAnalysisRuns('agent-test', { limit: 100 });
  assert.equal(runs.reduce((sum, row) => sum + Number(row.usage?.prompt_tokens || 0), 0), 100);
  assert.equal(runs.reduce((sum, row) => sum + Number(row.usage?.completion_tokens || 0), 0), 65536);
  assert.ok(runs.some(row => row.model === 'fixture' && row.request_id === 'truncated-state-request'));
  await run();
  assert.equal(calls, 1);
  fixture.database.close();
});

test("keeps base evidence and routes a required specialist failure to review after three attempts", async () => {
  const fixture = setupRequest();
  const run = () => processStateAnalysisRequest({
      repository: fixture.repository,
      agentId: "agent-test",
      requestId: fixture.request.id,
      generator: directPreferenceGenerator(fixture, { failRole: "time-scope" }),
    });
  const first = await run();
  const second = await run();
  const result = await run();
  assert.equal(first.status, "retry-pending");
  assert.equal(second.status, "retry-pending");
  assert.equal(result.status, "provisional-review");
  assert.equal(result.request.status, "completed");
  assert.equal(result.attemptCount, 3);
  assert.deepEqual(result.evaluation.failedRoles, ["timeScope"]);
  assert.equal(fixture.repository.listReportedStateProposals("agent-test").length, 0);
  const pending = fixture.repository.listPendingProvisionalMemories("agent-test");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].content, fixture.source.content);
  const decision = fixture.repository.getIngestionDecisionByBatchCandidate(
    "agent-test",
    fixture.request.batch_id,
    fixture.request.candidate_index,
  );
  assert.equal(decision.decision, "review");
  assert.equal(decision.review_state, "pending");
  assert.equal(decision.provisional_memory_id, pending[0].id);
  fixture.database.close();
});

for (const evidenceMode of ["observed", "inferred"]) test(`analyzes ${evidenceMode} condition evidence without turning it into a self-report`, async t => {
  const f = setupRequest({ stateFamily: "condition", evidenceMode, representationLayer: "inferred",
    content: evidenceMode === "observed" ? "Her hands were visibly shaking." : "She may be feeling anxious." });
  t.after(() => f.database.close());
  f.database.prepare("UPDATE memory_nodes SET subject_role=?, subject_key=? WHERE id=?").run("agent", "agent-test", f.memory.id);
  f.database.prepare("UPDATE memory_actor_roles SET actor_role=?, actor_key=? WHERE memory_id=? AND role='speaker'").run("agent", "agent-test", f.memory.id);
  let calls = 0;
  const result = await processStateAnalysisRequest({ repository: f.repository, agentId: "agent-test", requestId: f.request.id,
    generator: async request => {
      calls++;
      const output = { analyses: [{ memoryId: f.memory.id, sourceIds: [f.source.id], confidence: 0.8, rationale: "Source-limited observation.",
        targetMatch: "exact", matchedLabel: "Shaking hands", conditionPresence: "present", conditionKind: "health", effect: "none",
        temporality: "current", evidenceBasis: evidenceMode === "observed" ? "direct_observation" : "inferred",
        scopeLabel: "This conversation", revisionCue: "none" }] };
      validateMemoryTaskOutput(request, output); return { output };
    } });
  assert.equal(result.status, "provisional-review", JSON.stringify(result));
  assert.equal(result.request.status, "completed");
  assert.equal(calls, 1);
  const memory = f.repository.getMemory(result.provisional.id);
  assert.equal(memory.evidence_mode, evidenceMode);
  assert.equal(memory.representation_layer, evidenceMode === "inferred" ? "inferred" : "unspecified");
  assert.ok(f.repository.listPendingProvisionalMemories("agent-test").some(item => item.id === memory.id));
  assert.equal(memory.metadata.evidenceAnalysis.stateFormation, "not-established");
  assert.equal(result.merged.observations.length, 1);
  assert.equal(result.merged.observations[0].qualification, evidenceMode === "observed" ? "qualified" : "unresolved");
  assert.equal(f.repository.listReportedStateProposals("agent-test").length, 0);
});

for (const [stateFamily, kind, targetSpec] of [
  ["goal", "plan", {}],
  ["value", "belief_state", {}],
  ["capability", "fact", {}],
  ["self_concept", "belief_state", {}],
  ["identity", "fact", { identityField: "occupation", fieldCardinality: "multi_item" }],
  ["belief", "belief_state", { objectRole: "world", objectKey: "", objectLabel: "鱼是否好吃" }],
  ["relationship", "relationship", { counterpartRole: "agent", counterpartKey: "agent-test",
    counterpartLabel: "Suzu", direction: "holder_to_counterpart" }],
  ["affective_association", "belief_state", { triggerRole: "other", triggerKey: "place:museum", triggerLabel: "博物馆" }],
]) {
  for (const untrusted of [false, true]) test(`${stateFamily} receives complete evidence and current state (untrusted time=${untrusted})`, async (t) => {
    const content = "讨论中的背景。".repeat(1600) + "最后更正：我已经取消了，前面的打算不再有效。";
    const previous = "旧状态的适用背景。".repeat(600) + "但仅适用于休假期间。";
    const fixture = setupRequest({ stateFamily, targetSpec, content });
    t.after(() => fixture.database.close());
    fixture.repository.upsertMemory({
      id: `current-${stateFamily}`, agentId: "agent-test", kind, layer: "semantic",
      content: previous, subjectRole: "user", subjectKey: "user",
      canonicalKey: fixture.request.canonical_key, stateFamily, statePhase: "active",
      representationLayer: "reported", reality: "real", evidenceMode: "explicit",
      temporalState: "current", knownAt: "2026-07-01T08:00:00.000Z",
    });
    if (untrusted) {
      fixture.database.prepare("UPDATE source_records SET occurred_at=?, known_at=?, metadata_json=? WHERE id=?")
        .run('2000-01-02T12:00:00Z', '2000-01-02T12:00:00Z', JSON.stringify({ sourceTimeKnown: false }), fixture.source.id);
      fixture.database.prepare("UPDATE memory_nodes SET event_start=?, known_at=?, metadata_json=? WHERE id IN (?, ?)")
        .run('2000-01-02T12:00:00Z', '2000-01-02T12:00:00Z', JSON.stringify({ sourceTimeKnown: false }), fixture.memory.id, `current-${stateFamily}`);
    }
    const snapshots = [];
    await processStateAnalysisRequest({
      repository: fixture.repository, agentId: "agent-test", requestId: fixture.request.id,
      generator: async request => {
        const snapshot = JSON.parse(request.input.slice(request.input.indexOf("{")));
        snapshots.push(snapshot);
        return { output: request.stateMatchAnalysisTask ? {
          stateMatch: { resolution: 'matched', candidateId: 'current-' + stateFamily,
            rationale: 'The fixture supplies this same state for the fixed target.' }, analysis: { analyses: [] },
        } : { analyses: [] }, model: "test-complete-evidence" };
      },
    });
    // Assert outside the generator: production catches provider failures.
    assert.ok(snapshots.length > 1);
    assert.ok(snapshots.slice(1).every(snapshot => snapshot.currentState?.id === "current-" + stateFamily));
    for (const snapshot of snapshots) {
      assert.equal(snapshot.memories[0].content, content);
      assert.equal(snapshot.sourceRecords[0].content, content);
      const current = snapshot.currentState || snapshot.stateCandidates.find(candidate => candidate.id === 'current-' + stateFamily);
      assert.equal(current.content, previous);
      if (untrusted) {
        assert.doesNotMatch(JSON.stringify(snapshot), /2000-01-02/);
        assert.equal(current.knownAt, null);
        assert.equal(snapshot.sourceRecords[0].occurredAt, null);
        assert.equal(snapshot.memories[0].contextBasis, 'unknown');
      }
    }
  });
}

for (const content of ['我以前喜欢解谜游戏。', 'I used to like puzzle games.']) {
  test('preserves the source of a historical statement when no current state is established: ' + content, async t => {
    const f = setupRequest({ content });
    t.after(() => f.database.close());
    const base = directPreferenceGenerator(f);
    const generator = async request => {
      const result = await base(request);
      if (request.analyzerRole === 'time-scope') result.output.analyses[0].stateTime = 'historical';
      return result;
    };
    const result = await processStateAnalysisRequest({ repository: f.repository,
      agentId: 'agent-test', requestId: f.request.id, generator });
    assert.equal(result.status, 'provisional-review');
    assert.equal(result.provisional.evidence_mode, 'explicit');
    assert.equal(result.provisional.metadata.epistemicStatus, 'source_record');
    assert.equal(result.provisional.representation_layer, 'unspecified');
    const sources = f.repository.listMemorySources(result.provisional.id);
    assert.deepEqual(sources.map(source => source.authority), ['subject_firsthand']);
    assert.equal(f.repository.listReportedStateProposals('agent-test').length, 0);
  });
}

for (const failRole of ['behavior-conditions', 'sharing-affect']) test(`direct expression stays usable when the unrelated ${failRole} role fails`, async t => {
  const f = setupRequest();
  t.after(() => f.database.close());
  const result = await processStateAnalysisRequest({ repository: f.repository, agentId: 'agent-test',
    requestId: f.request.id, generator: directPreferenceGenerator(f, { failRole }) });
  assert.equal(result.status, 'proposal-pending');
  assert.equal(result.evaluation.status, 'partial');
  assert.equal(result.proposal.draft.preferenceClaim.polarity, 'positive');
});

test('a newer preference with a rejected essential judgment stays pending and retries only that judgment', async t => {
  const first = setupRequest({ targetLabel: 'puzzle games', content: 'I like puzzle games.' });
  t.after(() => first.database.close());
  const later = setupRequest({ database: first.database, repository: first.repository, suffix: '2',
    targetLabel: 'puzzle games', content: 'I now dislike puzzle games.' });
  const laterAt = '2026-07-11T12:00:00.000Z';
  first.database.prepare('UPDATE memory_nodes SET event_start=?,known_at=? WHERE id=?')
    .run(laterAt, laterAt, later.memory.id);
  first.database.prepare('UPDATE source_records SET occurred_at=?,known_at=? WHERE id=?')
    .run(laterAt, laterAt, later.source.id);
  const fixtures = [first, later];
  const request = first.repository.recordStateAnalysisRequest({ agentId: 'agent-test',
    batchId: 'combined-preference-evidence', candidateIndex: 0, stateFamily: 'preference',
    subjectRole: 'user', subjectKey: 'user', canonicalKey: 'puzzle-games', targetLabel: 'puzzle games',
    representationLayer: 'reported', evidenceMode: 'explicit',
    memoryIds: fixtures.map(fixture => fixture.memory.id), sourceIds: fixtures.map(fixture => fixture.source.id),
    metadata: { subjectName: 'User' } });
  const original = first.repository.getIngestionDecisionByBatchCandidate('agent-test', first.request.batch_id,
    first.request.candidate_index);
  first.repository.recordIngestionDecision({ agentId: 'agent-test', batchId: request.batch_id, candidateIndex: 0,
    decision: 'store', resultStatus: 'analysis_pending', candidate: { ...original.candidate,
      content: later.source.content, canonicalKey: request.canonical_key, sourceRefs: ['M0001', 'M0002'] },
    sourceRefs: ['M0001', 'M0002'], sourceIds: fixtures.map(fixture => fixture.source.id) });
  const calls = [];
  let rejectLaterTime = true;
  const generator = async input => {
    const snapshot = JSON.parse(input.input);
    calls.push({ role: input.analyzerRole, memoryIds: snapshot.memories.map(memory => memory.id) });
    const analyses = [];
    for (const memory of snapshot.memories) {
      const fixture = fixtures.find(fixture => fixture.memory.id === memory.id);
      const generated = await directPreferenceGenerator({ ...fixture, request })(input);
      for (const analysis of generated.output.analyses) {
        if (fixture === later && input.analyzerRole === 'explicit-expression') analysis.expressionType = 'dislikes';
        if (fixture === later && input.analyzerRole === 'time-scope') {
          analysis.revisionCue = 'changed';
          if (rejectLaterTime) analysis.sourceIds = [first.source.id];
        }
        analyses.push(analysis);
      }
    }
    if (input.analyzerRole === 'time-scope') rejectLaterTime = false;
    const output = { analyses };
    validateMemoryTaskOutput(input, output);
    return { output, model: 'fixture' };
  };
  const options = { repository: first.repository, agentId: 'agent-test', requestId: request.id, generator };
  const pending = await processStateAnalysisRequest(options);
  assert.equal(pending.status, 'retry-pending');
  assert.equal(first.repository.getStateAnalysisRequest('agent-test', request.id).status, 'pending');
  assert.equal(first.repository.listReportedStateProposals('agent-test').length, 0);
  assert.deepEqual(pending.evaluation.runs.timeScope.metadata.retryMemoryIds, [later.memory.id]);
  const savedRunIds = Object.values(pending.evaluation.runs).map(run => run.id);

  const completed = await processStateAnalysisRequest(options);
  assert.equal(completed.status, 'proposal-pending', JSON.stringify(completed));
  assert.equal(completed.proposal.draft.preferenceClaim.polarity, 'negative');
  assert.equal(first.repository.getStateAnalysisRequest('agent-test', request.id).status, 'completed');
  assert.deepEqual(calls.filter(call => call.role === 'time-scope').map(call => call.memoryIds),
    [[first.memory.id, later.memory.id], [later.memory.id]]);
  assert.deepEqual(calls.filter(call => call.role !== 'time-scope').map(call => call.role).sort(),
    ['behavior-conditions', 'explicit-expression', 'object-grounding', 'sharing-affect']);
  for (const runId of savedRunIds) assert.ok(first.repository.getStateAnalysisRun('agent-test', runId));
  const observations = first.repository.listStateEvidenceObservations('agent-test', {
    stateFamily: 'preference', canonicalKey: completed.request.canonical_key });
  assert.deepEqual(observations.map(observation => observation.memory_id).sort(),
    [first.memory.id, later.memory.id].sort());
  assert.equal(completed.proposal.review_state, 'pending');
  assert.equal(first.repository.getMemory(completed.proposal.resultMemoryId).status, 'active');
});

test('retries only a failed essential role and reuses the identical successful analyses', async t => {
  const f = setupRequest();
  t.after(() => f.database.close());
  const calls = [];
  const base = directPreferenceGenerator(f);
  let failed = false;
  const generator = async request => {
    calls.push(request.analyzerRole);
    if (!failed && request.analyzerRole === 'object-grounding') {
      failed = true;
      throw new Error('temporary-provider-failure');
    }
    return base(request);
  };
  const options = { repository: f.repository, agentId: 'agent-test', requestId: f.request.id, generator };
  assert.equal((await processStateAnalysisRequest(options)).status, 'retry-pending');
  const result = await processStateAnalysisRequest(options);
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.deepEqual(calls.reduce((counts, role) => ({ ...counts, [role]: (counts[role] || 0) + 1 }), {}), {
    'object-grounding': 2, 'explicit-expression': 1, 'behavior-conditions': 1, 'sharing-affect': 1, 'time-scope': 1,
  });
});

test('does not reuse an analysis after its evidence text changes', async t => {
  const f = setupRequest();
  t.after(() => f.database.close());
  const counts = {};
  const base = directPreferenceGenerator(f);
  let first = true;
  const generator = async request => {
    counts[request.analyzerRole] = (counts[request.analyzerRole] || 0) + 1;
    if (request.analyzerRole === 'object-grounding' && first) {
      first = false;
      throw new Error('temporary-provider-failure');
    }
    const result = await base(request);
    if (!f.memory.content.includes('喜欢')) {
      if (request.analyzerRole === 'explicit-expression') result.output.analyses[0].expressionType = 'dislikes';
    }
    return result;
  };
  const options = { repository: f.repository, agentId: 'agent-test', requestId: f.request.id, generator };
  assert.equal((await processStateAnalysisRequest(options)).status, 'retry-pending');
  const content = 'I dislike puzzle games.';
  f.database.prepare('UPDATE memory_nodes SET content=? WHERE id=?').run(content, f.memory.id);
  f.database.prepare('UPDATE source_records SET content=? WHERE id=?').run(content, f.source.id);
  f.memory.content = content;
  const result = await processStateAnalysisRequest(options);
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.equal(result.proposal.draft.preferenceClaim.polarity, 'negative');
  assert.deepEqual(Object.values(counts), [2, 2, 2, 2, 2]);
});

for (const accept of [false, true]) test(`fictional reported states retain scope through materialization and later matching; accepted=${accept}`, async t => {
  const f = setupRequest({ content: "I like stargazing in our story." });
  t.after(() => f.database.close());
  const scope = fixture => {
    fixture.database.prepare("UPDATE memory_nodes SET world_id=?, world_frame=? WHERE id=?").run("story-a", "fictional", fixture.memory.id);
    fixture.database.prepare("UPDATE source_records SET world_id=?, world_frame=? WHERE id=?").run("story-a", "fictional", fixture.source.id);
    fixture.database.prepare("UPDATE memory_ingestion_decisions SET candidate_json=json_set(candidate_json, '$.reality', 'fictional') WHERE batch_id=?")
      .run(fixture.request.batch_id);
  };
  scope(f);
  const result = await processStateAnalysisRequest({ repository: f.repository, agentId: "agent-test", requestId: f.request.id, generator: directPreferenceGenerator(f) });
  assert.equal(result.status, "proposal-pending", JSON.stringify(result));
  let memory = f.repository.getMemory(result.proposal.resultMemoryId);
  assert.equal(memory.reality, "fictional");
  assert.equal(memory.status, 'active');
  if (accept) {
    const confirmed = resolveReportedStateProposal(f.repository, { agentId: "agent-test", proposalId: result.proposal.id, action: "accept" });
    assert.deepEqual(confirmed.memory, memory);
  }
  assert.equal(memory.reality, "fictional");
  assert.equal(memory.world_id, "story-a");
  assert.equal(memory.world_frame, "fictional");
  const provider = Object.assign(async () => ({ model: "test", vector: [1, 0] }), { model: "test", dimensions: 2 });
  await syncMemoryEmbeddings({ repository: f.repository, agentId: "agent-test", embeddingProvider: provider, memoryIds: [memory.id] });
  f.repository.upsertMemory({ ...memory, id: "other-world", agentId: "agent-test", subjectRole: "user", subjectKey: "user",
    stateFamily: "preference", representationLayer: "reported", canonicalKey: "other-world", reality: "fictional", worldId: "story-b", worldFrame: "fictional" });
  const next = setupRequest({ database: f.database, repository: f.repository, suffix: "2", content: "Stargazing is still my favorite." });
  scope(next);
  const context = await prepareStateMemoryCandidates({ repository: f.repository, request: next.request, embeddingProvider: provider });
  assert.ok(context.candidates.some(candidate => candidate.id === memory.id));
  assert.equal(context.candidates.some(candidate => candidate.id === "other-world"), false);
});

for (const override of [false, true]) test(`public state analysis uses the configured embedding provider; override=${override}`, async t => {
  const f = setupRequest({ stateFamily: "goal", targetLabel: "整理书单" }); t.after(() => f.database.close());
  let configuredCalls = 0, overrideCalls = 0;
  const configured = Object.assign(async () => { configuredCalls++; return { model: "configured", vector: [1, 0] }; }, { model: "configured", dimensions: 2 });
  const custom = Object.assign(async () => { overrideCalls++; return { model: "override", vector: [1, 0] }; }, { model: "override", dimensions: 2 });
  const result = await MemoryService.prototype.analyzePendingState.call({ agentId: "agent-test", providers: { embedding: configured, generator: combinedGoalGenerator(f, []) },
    paths: { usageLedgerPath: "" }, withRepository: callback => callback(f.repository) }, override ? { embeddingProvider: custom } : {});
  assert.equal(result.counts["proposal-pending"], 1, JSON.stringify(result));
  assert.equal(configuredCalls, override ? 0 : 1);
  assert.equal(overrideCalls, override ? 1 : 0);
});


test('all state analyzer requests satisfy strict provider object contracts', async () => {
  const { readdir } = await import('node:fs/promises');
  function assertStrictObjects(schema, location) {
    if (!schema || typeof schema !== 'object') return;
    if (schema.properties) {
      assert.equal(schema.additionalProperties, false, location);
      assert.deepEqual(new Set(schema.required), new Set(Object.keys(schema.properties)), location);
    }
    for (const [key, value] of Object.entries(schema)) {
      if (value && typeof value === 'object') assertStrictObjects(value, location + '.' + key);
    }
  }
  let requests = 0;
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://provider.test', apiKey: 'test-key', model: 'fixture', structuredOutputMode: 'strict-tool', maximumTransportAttempts: 1 },
    fetchImpl: async (_url, options) => {
      const tool = JSON.parse(options.body).tools[0].function;
      assertStrictObjects(tool.parameters, tool.name);
      requests++;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
        tool_calls: [{ type: 'function', function: { name: tool.name, arguments: '{"analyses":[]}' } }],
      } }] }), { status: 200 });
    },
  });
  for (const file of await readdir(new URL('../src/', import.meta.url))) {
    if (!file.endsWith('-contracts.mjs')) continue;
    const module = await import(new URL('../src/' + file, import.meta.url));
    for (const [name, definitions] of Object.entries(module)) {
      if (!name.endsWith('_ANALYZERS')) continue;
      for (const definition of Object.values(definitions)) {
        await generate({ input: 'evidence', schema: definition.schema, schemaName: definition.schemaName });
      }
    }
  }
  assert.ok(requests > 0);
});

test('related analysis groups structured snapshots independently of prompt whitespace and keeps provider requests clean', async () => {
  const definitions = { holder: { stateFamily: 'goal', role: 'holder' }, target: { stateFamily: 'goal', role: 'target' } };
  const snapshot = { target: { stateFamily: 'goal' }, memories: [{ id: 'evidence-1', content: 'Prepare an exhibition.' }] };
  const checked = [];
  for (const separator of ['\n', '\n\n']) {
    const calls = [];
    const assertClean = request => {
      assert.equal(Object.hasOwn(request, 'analysisSnapshot'), false);
      assert.equal(Object.hasOwn(request, 'renderAnalysisInput'), false);
      assert.equal(typeof request.input, 'string');
      checked.push(request.schemaName);
    };
    const generator = Object.assign(async request => {
      assertClean(request); calls.push(request);
      return { output: request.combinedAnalyzerKeys
        ? { results: Object.fromEntries(request.combinedAnalyzerKeys.map(key => [key, { analyses: [] }])) }
        : { analyses: [] } };
    }, { supportsCombinedStateAnalysis: true, assertRequestBudget: assertClean });
    const batch = createRelatedAnalyzerBatch({ definitions, generator, request: { id: 'format-check' } });
    const request = value => ({ analysisSnapshot: value, renderAnalysisInput: data => 'Snapshot:'+separator+JSON.stringify(data),
      systemPrompt: 'Inspect the supplied evidence.', schema: { type: 'object' }, schemaName: 'format-check' });
    await Promise.all([batch.holder(request(snapshot)), batch.target(request(structuredClone(snapshot)))]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].combinedAnalyzerKeys, ['holder', 'target']);
    const changed = { ...snapshot, memories: [{ id: 'evidence-2', content: 'Finish the exhibition.' }] };
    await Promise.all([batch.holder(request(snapshot)), batch.target(request(changed))]);
    assert.equal(calls.length, 3, 'Distinct source material remains separate.');
  }
  assert.ok(checked.length > 0);
});


test('state matching uses a fixed entity ID across aliases and separates same-name objects', async t => {
  const targetSpec = { triggerRole: 'world', triggerKey: '', triggerLabel: '巴黎', triggerEntityId: 'city-france', triggerKind: 'place' };
  const f = setupRequest({ stateFamily: 'affective_association', targetSpec, targetLabel: '想到巴黎会安心', content: '想到巴黎这座城市，我就安心。' });
  t.after(() => f.database.close());
  for (const [id, entityId, label] of [['same-city', 'city-france', 'Paris'], ['another-city', 'city-texas', '巴黎']]) {
    f.repository.upsertMemory({ id, agentId: 'agent-test', kind: 'belief_state', layer: 'semantic',
      content: `${label} brings calm.`, title: label, subjectRole: 'user', subjectKey: 'user', stateFamily: 'affective_association',
      representationLayer: 'reported', evidenceMode: 'explicit', reality: 'real', canonicalKey: id,
      metadata: { stateTarget: { ...targetSpec, triggerEntityId: entityId, triggerLabel: label } } });
  }
  const context = await prepareStateMemoryCandidates({ repository: f.repository, request: f.request });
  assert.ok(context.candidates.some(item => item.id === 'same-city'), 'The same ID remains eligible under a different label.');
  assert.ok(!context.candidates.some(item => item.id === 'another-city'), 'A different ID remains separate despite an identical label.');
});
