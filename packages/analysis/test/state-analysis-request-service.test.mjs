import assert from "node:assert/strict";
import test from "node:test";
import { stateAnalysisBudgetError } from "../src/request-budget.mjs";

import {
  MemoryRepository,
  openMemoryDatabase,
  resolveReportedStateProposal,
  memoryRetrievalContextSourceHash,
} from "@suzu-memory/core";
import { syncMemoryEmbeddings } from '@suzu-memory/embedding-indexer';
import { prepareStateMemoryCandidates } from '../src/state-memory-candidates.mjs';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';

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
      confidence: 0.9,
      importance: 0.5,
      actorRoles: [],
      sourceRefs: [`message-preference-${suffix}`],
      retentionReason: "durable_user_fact",
    },
    sourceRefs: [`message-preference-${suffix}`],
    sourceIds: [source.id],
    knownAt: source.known_at,
  });
  return { database, repository, source, memory, request };
}

for (const family of ['preference', 'goal']) test(`untrusted calendar times never enter ${family} analysis and survive state materialization as unknown`, async t => {
  const f = setupRequest({ stateFamily: family, targetLabel: family === 'goal' ? '周六整理书单' : '解谜游戏',
    content: family === 'goal' ? '我答应周六九点整理小说书单。' : '我一直很喜欢解谜游戏。' });
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
  assert.equal(accepted.memory.metadata.sourceTimeKnown, false);
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
  const generator = Object.assign(async request => {
    assert.equal(embeddingCalls.length, 2, 'new semantic content must be embedded before the specialist');
    calls.push(request);
    assertMemoryTaskRequest(request);
    const common = { memoryId: second.memory.id, sourceIds: [second.source.id], confidence: 0.98, rationale: '原话明确取消同一约定。' };
    let output;
    if (request.schemaName === 'memory-state-match-analysis-v1') {
      const snapshot = JSON.parse(request.input.slice(request.input.indexOf('快照：\n') + '快照：\n'.length));
      assert.ok(snapshot.stateCandidates.some(candidate => candidate.id === old.id));
      output = { stateMatch: { resolution: scenario === 'ambiguous' ? 'ambiguous' : 'matched',
        candidateId: scenario === 'ambiguous' ? '' : scenario === 'invalid' ? 'not-a-candidate' : old.id, rationale: '比较具体约定。' }, analysis: { results: {
        targetIntent: { analyses: [{ ...common, targetMatch: 'exact', goalText: '整理小说书单', intentionLevel: 'plan', specificity: 'actionable' }] },
        holderResponsibility: { analyses: [{ ...common, holderMatch: 'yes', attribution: 'explicit_self_statement', responsibility: 'subject', agency: 'self_chosen', acceptsResponsibility: 'yes' }] },
        lifecycle: { analyses: [{ ...common, lifecycle: 'cancelled', completionBasis: 'direct_cancellation', timeReference: '' }] },
      } } };
    } else {
      assert.equal(request.analyzerRole, 'current-relation');
      const snapshot = JSON.parse(request.input.slice(request.input.indexOf('\n\n{') + 2));
      assert.equal(snapshot.currentState.id, old.id);
      output = { analyses: [{ ...common, currentStatePresent: true, relation: 'cancels' }] };
    }
    validateMemoryTaskOutput(request, output);
    return { output, model: 'test', metadata: { provider: 'test' } };
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
    await syncMemoryEmbeddings({ repository: first.repository, agentId: 'agent-test', embeddingProvider,
      memoryIds: pending.map(memory => memory.id) });
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
        const snapshot = JSON.parse(request.input.slice(request.input.indexOf('\n\n{') + 2));
        assert.equal(snapshot.currentState.id, old.id);
        assert.equal(snapshot.currentState.statePhase, 'cancelled');
        output = { analyses: [{ memoryId: third.memory.id, sourceIds: [third.source.id], confidence: 0.98,
          rationale: '直接恢复同一安排。', currentStatePresent: true, relation: 'resumes' }] };
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
        currentStatePresent: false,
        relation: "no_current_state",
      }] },
    };
    return {
      output: outputs[analyzerRole],
      model: `test-${analyzerRole}`,
      metadata: { provider: "test" },
    };
  };
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

test("an indivisible specialist budget overflow preserves evidence for review without provider retries", async t => {
  const fixture = setupRequest();
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
  assert.equal((await processPendingStateAnalysisRequests({ repository: fixture.repository, agentId: "agent-test",
    generator, maxRequests: 10 })).selected, 0);
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
  setupRequest({
    database: first.database,
    repository: first.repository,
    suffix: "3",
    targetLabel: "散步",
    stateFamily: "goal",
    evidenceMode: "observed",
    representationLayer: "inferred",
    createdAt: "2026-07-11T02:03:00.000Z",
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
  }).length, 1);
  first.database.close();
});

test("output token exhaustion is recorded once and sent to review without automatic retries", async () => {
  const fixture = setupRequest();
  let calls = 0;
  const diagnostics = { maxOutputTokens: 65536, usage: { outputTokens: 65536, reasoningTokens: 64000 } };
  const generator = async () => {
    calls++;
    throw Object.assign(new Error('Output protection reached'), { code: 'MAX_TOKENS', diagnostics });
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

test("leaves inferred families without an implemented processor pending", async () => {
  const fixture = setupRequest({ stateFamily: "goal", evidenceMode: "observed", representationLayer: "inferred" });
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
      generator: async ({ input }) => {
        snapshots.push(JSON.parse(input.slice(input.indexOf("\n\n{") + 2)));
        return { output: { analyses: [] }, model: "test-complete-evidence" };
      },
    });
    // Assert outside the generator: production catches provider failures.
    assert.ok(snapshots.length > 0);
    for (const snapshot of snapshots) {
      assert.equal(snapshot.memories[0].content, content);
      assert.equal(snapshot.sourceRecords[0].content, content);
      assert.equal(snapshot.currentState.content, previous);
      if (untrusted) {
        assert.doesNotMatch(JSON.stringify(snapshot), /2000-01-02/);
        assert.equal(snapshot.currentState.knownAt, null);
        assert.equal(snapshot.sourceRecords[0].occurredAt, null);
        assert.equal(snapshot.memories[0].contextBasis, 'unknown');
      }
    }
  });
}
