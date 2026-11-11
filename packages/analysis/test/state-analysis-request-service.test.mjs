import assert from "node:assert/strict";
import test from "node:test";
import { createRelatedAnalyzerBatch } from '../src/related-analyzer-batch.mjs';
import { stateAnalysisBudgetError } from "../src/request-budget.mjs";

import {
  MemoryRepository,
  openMemoryDatabase,
  resolveReportedStateProposal,
  memoryRetrievalContextSourceHash,
  normalizeStateAnalysisTargetSpec,
  modelCalendarFields,
} from "@suzu-memory/core";
import { syncMemoryEmbeddings } from '@suzu-memory/embedding-indexer';
import { createOpenAiCompatibleStructuredGenerator } from '@suzu-memory/providers';
import { fallbackStateAnalysisToProvisionalReview } from '@suzu-memory/extraction';
import { autoAcceptReportedStateProposals, runEmbeddingMaintenance } from '@suzu-memory/maintenance';
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
  stateFamily = "preference",
  targetSpec = {},
  eventFields = {},
  content = `我一直很喜欢${targetLabel}，这个可以记住。`,
} = {}) {
  const database = existingDatabase || openMemoryDatabase(":memory:");
  const repository = existingRepository || new MemoryRepository(database);
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "transcript-message",
    externalId: `message-preference-${suffix}`,
    occurredAt: "2026-07-10T12:00:00.000Z",
    knownAt: "2026-07-10T12:00:00.000Z",
    recordedAt: "2026-07-11T02:00:00.000Z",
    speaker: "用户",
    content,
  });
  const memory = repository.upsertMemory({
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
    eventStart: "2026-07-10T12:00:00.000Z",
    knownAt: "2026-07-10T12:00:00.000Z",
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
    batchId: `compaction-boundary-${suffix}`,
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
  let old = first.repository.listPendingProvisionalMemories('agent-test')[0];
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
    connection: { baseUrl: 'https://provider.test', apiKey: 'test-key', model: 'fixture' },
    fetchImpl: async (_url, { body }) => {
      const { messages } = JSON.parse(body);
      const input = messages[1].content;
      const snapshot = JSON.parse(input.slice(input.indexOf('{')));
      const evidence = snapshot.memories.find(memory => memory.content === second.memory.content);
      assert.ok(evidence && evidence.id !== second.memory.id, 'The provider must receive a local memory reference.');
      const source = snapshot.sourceRecords.find(row => row.content === second.source.content);
      assert.ok(source && source.id !== second.source.id, 'The provider must receive a local source reference.');
      assert.ok(evidence.sourceIds.includes(source.id));
      const common = { memoryId: evidence.id, sourceIds: [source.id], confidence: 0.98, rationale: '原话明确取消同一约定。' };
      let output;
      if (snapshot.currentState) {
        assert.equal(snapshot.currentState.content, old.content);
        assert.notEqual(snapshot.currentState.id, old.id);
        output = { analyses: [{ ...common, relation: 'cancels' }] };
      } else {
        const candidate = snapshot.stateCandidates.find(item => item.content === old.content);
        assert.ok(candidate && candidate.id !== old.id);
        output = { stateMatch: { resolution: scenario === 'ambiguous' ? 'ambiguous' : 'matched',
          candidateId: scenario === 'ambiguous' ? '' : scenario === 'invalid' ? 'not-a-candidate' : candidate.id,
          rationale: '比较具体约定。' }, analysis: { results: {
          targetIntent: { analyses: [{ ...common, targetMatch: 'exact', goalText: '整理小说书单', intentionLevel: 'plan', specificity: 'actionable', peerRelations: [] }] },
          holderResponsibility: { analyses: [{ ...common, holderMatch: 'yes', attribution: 'explicit_self_statement', responsibility: 'subject', agency: 'self_chosen', acceptsResponsibility: 'yes' }] },
          lifecycle: { analyses: [{ ...common, lifecycle: 'cancelled', completionBasis: 'direct_cancellation', timeReference: '' }] },
        } } };
      }
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] });
    },
  });
  const generator = Object.assign(async request => {
    assert.equal(embeddingCalls.length, 2, 'new semantic content must be embedded before the specialist');
    calls.push(request);
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
  assert.equal(autoAcceptReportedStateProposals({ repository: first.repository, agentId: 'agent-test',
    proposalIds: [completed.proposal.id] }).accepted.length, 1);
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
  let memory = f.repository.listPendingProvisionalMemories("agent-test")[0];
  assert.equal(memory.reality, "fictional");
  if (accept) memory = resolveReportedStateProposal(f.repository, { agentId: "agent-test", proposalId: result.proposal.id, action: "accept" }).memory;
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
