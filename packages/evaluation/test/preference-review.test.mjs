import assert from "node:assert/strict";
import test from "node:test";
import { withUsageRecorder } from '@suzu-memory/usage-ledger';

import {
  MemoryRepository,
  openMemoryDatabase,
  proposePreferenceEstablishedPromotion,
  resolvePreferenceStateProposal,
  resolveStatePromotionProposal,
  revokeStatePromotionProposal,
} from "@suzu-memory/core";

import {
  buildPreferenceCanonicalReviewSnapshot,
  proposePreferenceStateFromCanonicalReview,
  reviewPreferenceCanonicalState,
} from "../src/index.mjs";

const policy = Object.freeze({
  version: "preference-review-test-v1",
  signalWeights: {
    active_choice: 1,
    repeated_behavior: 0.7,
    active_sharing: 0.6,
    counter_behavior: 1,
  },
  opportunityCostMultipliers: {
    none: 1,
    low: 1,
    medium: 1.2,
    high: 1.5,
    unknown: 1,
  },
  minimumConfidence: 0.6,
  minimumStableSupportScore: 2,
  minimumStableIndependentSupport: 2,
  minimumStableDistinctDays: 2,
  minimumStableDistinctContexts: 2,
  minimumChoiceEvidenceForStable: 1,
  minimumSelectionEvidence: 1,
  minimumSelectionContexts: 1,
  minimumToleranceEvidence: 1,
  minimumToleranceContexts: 1,
  maximumContributionPerDay: 2,
  maximumOppositionRatio: 0.5,
});

function setup({ withCurrent = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  let currentEvidence = null;
  if (withCurrent) {
    current = repository.upsertMemory({
      id: "current-puzzle-state",
      agentId: "agent-test",
      kind: "derived_hypothesis",
      layer: "semantic",
      content: "用户对解谜游戏表现出稳定偏好。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: "user:preference:puzzle-games",
      reality: "real",
      evidenceMode: "inferred",
      representationLayer: "inferred",
      stateFamily: "preference",
      statePhase: "active",
      temporalState: "current",
      validFrom: "2026-07-01T00:00:00.000Z",
      knownAt: "2026-07-01T00:00:00.000Z",
      metadata: {
        preferenceStateLevel: "stable_preference",
        preferenceScope: { kind: "category", label: "解谜游戏", context: "" },
        preferenceScopeLabel: "解谜游戏",
      },
    });
    currentEvidence = addObservation(repository, {
      id: "current-state-support",
      signal: "active_choice",
      direction: "support",
      content: "用户此前在可自由选择时主动选择解谜游戏。",
      sourceText: "今晚有空，我还是想玩解谜游戏。",
      occurredAt: "2026-07-01T00:00:00.000Z",
      payload: {
        agency: "self_initiated",
        constraint: "none",
        alternatives: "available",
        instrumentalGoal: "none",
        opportunityCost: "medium",
        canDecline: true,
      },
    });
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: current.id,
      toMemoryId: currentEvidence.memory.id,
      relation: "supported_by",
      direction: "directed",
      weight: 0.85,
      confidence: 0.9,
      provenance: "test",
    });
  }
  return { database, repository, current, currentEvidence };
}

function addObservation(repository, {
  id,
  signal,
  direction,
  sourceText,
  content,
  occurredAt,
  payload = {},
  qualification = "qualified",
  excludedReason = "",
  world = {},
  semanticWorld = null,
} = {}) {
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt,
    knownAt: occurredAt,
    speaker: "User",
    content: sourceText,
  });
  const memory = repository.upsertMemory({
    id: `memory-${id}`,
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    ...world,
    evidenceMode: "explicit",
    temporalState: "historical",
    eventStart: occurredAt,
    knownAt: occurredAt,
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 0.95,
    evidenceStrength: 1,
    provenance: "test",
  });
  let analysisRequest = null;
  if (semanticWorld) {
    analysisRequest = repository.recordStateAnalysisRequest({ agentId: 'agent-test', batchId: `semantic-batch-${id}`, candidateIndex: 0,
      stateFamily: 'preference', subjectRole: 'user', subjectKey: 'user', canonicalKey: 'user:preference:puzzle-games', targetLabel: 'Puzzles',
      representationLayer: 'inferred', evidenceMode: 'inferred', memoryIds: [memory.id], sourceIds: [source.id] });
    const semantic = repository.upsertMemory({ id: `semantic-${id}`, agentId: 'agent-test', kind: 'derived_hypothesis', layer: 'provisional',
      title: 'Puzzles', content: 'A fixed preference draft.', subjectRole: 'user', subjectKey: 'user', ...semanticWorld,
      metadata: { stateAnalysisDraft: true, stateAnalysisRequestId: analysisRequest.id } });
    repository.bindStateAnalysisTarget({ agentId: 'agent-test', requestId: analysisRequest.id, canonicalKey: analysisRequest.canonical_key,
      metadata: { semanticMemoryId: semantic.id } });
  }
  const observation = repository.recordStateEvidenceObservation({
    id,
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryId: memory.id,
    evidenceGroupId: `group:${id}`,
    contextId: `context:${id}`,
    signal,
    claimedDirection: direction,
    effectiveDirection: qualification === "qualified" ? direction : "neutral",
    qualification,
    confidence: 0.9,
    origin: "deterministic",
    scope: { kind: "exact", label: "解谜游戏", context: "" },
    payloadSchemaVersion: "test-evidence-v1",
    payload: { ...payload, ...(analysisRequest ? { analysisRequest: { id: analysisRequest.id } } : {}) },
    excludedReason,
    sourceIds: [source.id],
    observedAt: occurredAt,
  });
  return { observation, memory, source };
}

function reviewArgs(repository, overrides = {}) {
  return {
    repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    subjectLabel: "用户",
    objectLabel: "解谜游戏",
    policy,
    ...overrides,
  };
}

async function approvedSelectionReview(repository, support) {
  return reviewPreferenceCanonicalState(reviewArgs(repository, {
    synthesizer: async () => ({
      output: {
        action: "create",
        proposedLevel: "selection_tendency",
        scopeChange: "none",
        scope: { kind: "category", label: "解谜游戏", context: "空闲时间" },
        evidenceDecisions: [{
          observationId: support.observation.id,
          treatment: "positive_preference_evidence",
          rationale: "主体在有真实替代项时主动选择",
        }],
        confidence: 0.82,
        rationale: "主动选择足以形成待审选择倾向",
      },
      model: "synth-test",
      metadata: { provider: "test" },
    }),
    critic: async () => ({
      output: { verdict: "approve_shadow", issues: [], summary: "未发现越界" },
      model: "critic-test",
      metadata: { provider: "test" },
    }),
  }));
}

for (const [role, failure] of [['synthesizer', 'provider'], ['synthesizer', 'persistence'],
  ['critic', 'provider'], ['critic', 'persistence']]) test(`canonical review records ${role} usage once across ${failure} failure and recovery`, async t => {
  const { database, repository } = setup();
  t.after(() => database.close());
  const support = addObservation(repository, { id: 'usage-choice', signal: 'active_choice', direction: 'support',
    content: '用户有空时主动选择了解谜游戏。', sourceText: '今晚有空，其他娱乐先放下，我想玩解谜游戏。',
    occurredAt: '2026-07-12T12:00:00Z', payload: { agency: 'self_initiated', constraint: 'none',
      alternatives: 'available', instrumentalGoal: 'none', opportunityCost: 'medium', canDecline: true } });
  const charges = [];
  const calls = { synthesizer: 0, critic: 0 };
  const record = repository.recordStateAnalysisRun.bind(repository);
  if (failure === 'persistence') repository.recordStateAnalysisRun = input => {
    if (input.analyzerRole === `preference-state-${role}`) throw new Error('review storage failure');
    return record(input);
  };
  const generator = currentRole => async () => {
    const receipt = { model: 'fixture', requestId: `${currentRole}-${++calls[currentRole]}`, usage: { prompt_tokens: 5 } };
    if (currentRole === role && failure === 'provider' && calls[currentRole] === 1) {
      throw Object.assign(new Error('review provider failure'), receipt);
    }
    return { ...receipt, output: currentRole === 'critic'
      ? { verdict: 'approve_shadow', issues: [], summary: 'The proposal stays within the supplied evidence.' }
      : { action: 'create', proposedLevel: 'selection_tendency', scopeChange: 'none',
        scope: { kind: 'category', label: '解谜游戏', context: '空闲时间' }, evidenceDecisions: [{
          observationId: support.observation.id, treatment: 'positive_preference_evidence', rationale: 'A voluntary choice with alternatives.' }],
        confidence: 0.9, rationale: 'The choice supports a reviewable selection tendency.' } };
  };
  const run = () => withUsageRecorder(charge => charges.push(charge), () => reviewPreferenceCanonicalState(
    reviewArgs(repository, { synthesizer: generator('synthesizer'), critic: generator('critic'), usageLedgerPath: 'review-owner-unused.jsonl' })));
  if (failure === 'persistence') await assert.rejects(run, /review storage failure/);
  else assert.equal((await run()).status, 'incomplete');
  assert.equal(charges.length, role === 'synthesizer' ? 1 : 2);
  repository.recordStateAnalysisRun = record;
  assert.equal((await run()).status, 'approved-shadow');
  assert.equal(charges.length, calls.synthesizer + calls.critic);
  assert.equal(new Set(charges.map(charge => charge.requestId)).size, charges.length);
  assert.equal(charges.reduce((sum, charge) => sum + charge.usage.prompt_tokens, 0), charges.length * 5);
});

async function approvedStableReview(repository, supports, world = null) {
  return reviewPreferenceCanonicalState(reviewArgs(repository, {
    snapshotOptions: { world },
    synthesizer: async () => ({
      output: {
        action: "create",
        proposedLevel: "stable_preference",
        scopeChange: "none",
        scope: { kind: "category", label: "解谜游戏", context: "空闲时间" },
        evidenceDecisions: supports.map((support) => ({
          observationId: support.observation.id,
          treatment: "positive_preference_evidence",
          rationale: "主体在存在真实替代项时主动选择",
        })),
        confidence: 0.82,
        rationale: "跨日、跨情境的主动选择支持形成稳定偏好推断",
      },
      model: "synth-test",
      metadata: { provider: "test" },
    }),
    critic: async () => ({
      output: { verdict: "approve_shadow", issues: [], summary: "证据范围完整且未越层" },
      model: "critic-test",
      metadata: { provider: "test" },
    }),
  }));
}

const establishedPromotionPolicy = Object.freeze({
  version: "preference-established-test-v1",
  minimumConfidence: 0.6,
  minimumStableSupportScore: 2,
  minimumIndependentSupport: 2,
  minimumDistinctDays: 2,
  minimumDistinctContexts: 2,
  minimumChoiceEvidence: 1,
  maximumOppositionRatio: 0.5,
});

async function acceptedStablePreference(repository, prefix = "established", world = null, semanticWorld = null) {
  const supports = [
    addObservation(repository, {
      world, semanticWorld,
      id: `${prefix}-choice-one`,
      signal: "active_choice",
      direction: "support",
      content: "用户在空闲晚上有其他选择时主动玩解谜游戏。",
      sourceText: "今晚可以看电影，不过我还是想玩解谜游戏。",
      occurredAt: "2026-07-14T12:00:00.000Z",
      payload: {
        agency: "self_initiated",
        constraint: "none",
        alternatives: "available",
        instrumentalGoal: "none",
        opportunityCost: "medium",
        canDecline: true,
      },
    }),
    addObservation(repository, {
      world, semanticWorld,
      id: `${prefix}-choice-two`,
      signal: "active_choice",
      direction: "support",
      content: "用户在另一个休息日再次主动选择新的解谜游戏。",
      sourceText: "今天休息，我想试试新出的解谜游戏。",
      occurredAt: "2026-07-20T09:00:00.000Z",
      payload: {
        agency: "self_initiated",
        constraint: "none",
        alternatives: "available",
        instrumentalGoal: "none",
        opportunityCost: "medium",
        canDecline: true,
      },
    }),
  ];
  const review = await approvedStableReview(repository, supports, semanticWorld || world);
  assert.equal(review.status, "approved-shadow", JSON.stringify(review));
  const pending = proposePreferenceStateFromCanonicalReview(repository, {
    agentId: "agent-test",
    review,
  });
  const accepted = resolvePreferenceStateProposal(repository, {
    agentId: "agent-test",
    proposalId: pending.proposal.id,
    action: "accept",
  });
  assert.equal(accepted.memory.metadata.preferenceStateLevel, "stable_preference");
  assert.equal(accepted.memory.representation_layer, "inferred");
  return { supports, review, pending, accepted };
}

test("runs a complete synthesizer and independent critic as audited shadow review", async () => {
  const { database, repository } = setup();
  const support = addObservation(repository, {
    id: "voluntary-choice",
    signal: "active_choice",
    direction: "support",
    content: "用户在空闲时间有其他选项时主动选择解谜游戏。",
    sourceText: "今晚有空，我还是想玩解谜游戏。",
    occurredAt: "2026-07-12T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "medium",
      canDecline: true,
    },
  });
  const before = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  let criticCalled = false;
  const result = await reviewPreferenceCanonicalState(reviewArgs(repository, {
    synthesizer: async () => ({
      output: {
        action: "create",
        proposedLevel: "selection_tendency",
        scopeChange: "none",
        scope: { kind: "category", label: "解谜游戏", context: "" },
        evidenceDecisions: [{
          observationId: support.observation.id,
          treatment: "positive_preference_evidence",
          rationale: "主体在真实替代项中主动选择",
        }],
        confidence: 0.95,
        rationale: "主动选择支持建立推断层待审状态",
      },
      model: "synth-test",
      metadata: { provider: "test" },
    }),
    critic: async ({ input }) => {
      criticCalled = true;
      assert.doesNotMatch(input, /hidden reasoning/iu);
      return {
        output: { verdict: "approve_shadow", issues: [], summary: "没有发现越界" },
        model: "critic-test",
        metadata: { provider: "test" },
      };
    },
  }));
  assert.equal(result.status, "approved-shadow");
  assert.equal(criticCalled, true);
  assert.equal(result.pendingProposal, null);
  assert.equal(result.automaticMemoryWriteAllowed, false);
  assert.equal(result.runs.synthesizer.analyzer_role, "preference-state-synthesizer");
  assert.equal(result.runs.critic.analyzer_role, "preference-state-critic");
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    before,
  );
  database.close();
});

test("bridges an approved behavior review into a pending inferred state and preserves reported state", async () => {
  const { database, repository } = setup();
  const support = addObservation(repository, {
    id: "bridge-choice",
    signal: "active_choice",
    direction: "support",
    content: "用户在空闲时间有其他选择时主动玩解谜游戏。",
    sourceText: "今晚我可以看电影，不过我还是想玩解谜。",
    occurredAt: "2026-07-14T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "medium",
      canDecline: true,
    },
  });
  const review = await approvedSelectionReview(repository, support);
  assert.equal(review.status, "approved-shadow");
  const before = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const pending = proposePreferenceStateFromCanonicalReview(repository, {
    agentId: "agent-test",
    review,
  });
  assert.equal(pending.status, "pending");
  assert.equal(pending.proposal.representation_layer, "inferred");
  assert.equal(pending.proposal.state_scope_key, "root");
  assert.match(pending.proposal.evidence[0].evidenceSnapshotHash, /^[0-9a-f]{64}$/u);
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    before,
  );

  const reported = repository.upsertMemory({
    id: "reported-puzzle-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户明确表示喜欢解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    reality: "real",
    evidenceMode: "explicit",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-15T12:00:00.000Z",
    knownAt: "2026-07-15T12:00:00.000Z",
    metadata: { preferenceStateLevel: "direct_preference" },
  });
  const accepted = resolvePreferenceStateProposal(repository, {
    agentId: "agent-test",
    proposalId: pending.proposal.id,
    action: "accept",
  });
  assert.equal(accepted.memory.representation_layer, "inferred");
  assert.equal(accepted.memory.state_family, "preference");
  assert.equal(accepted.memory.state_scope_key, "root");
  assert.equal(accepted.memory.metadata.preferenceStateLevel, "selection_tendency");
  assert.equal(repository.getMemory(reported.id).status, "active");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: accepted.memory.id,
    toMemoryId: support.memory.id,
    relation: "supported_by",
  }).relation, "supported_by");
  database.close();
});

test("rejects an approved behavior proposal when its evidence changes before acceptance", async () => {
  const { database, repository } = setup();
  const support = addObservation(repository, {
    id: "drift-choice",
    signal: "active_choice",
    direction: "support",
    content: "用户在空闲时间主动选择解谜游戏。",
    sourceText: "今晚我还是选择解谜。",
    occurredAt: "2026-07-16T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "medium",
      canDecline: true,
    },
  });
  const review = await approvedSelectionReview(repository, support);
  const pending = proposePreferenceStateFromCanonicalReview(repository, {
    agentId: "agent-test",
    review,
  });
  repository.editMemoryManually({
    agentId: "agent-test",
    memoryId: support.memory.id,
    patch: { content: "人工修正后，这条记录不再说明存在真实替代项。" },
    reason: "test evidence drift",
  });
  assert.throws(() => resolvePreferenceStateProposal(repository, {
    agentId: "agent-test",
    proposalId: pending.proposal.id,
    action: "accept",
  }), /evidence changed after review/u);
  assert.equal(
    repository.getPreferenceStateProposal("agent-test", pending.proposal.id).review_state,
    "pending",
  );
  database.close();
});

test("rejects an approved behavior proposal when its evidence classification is superseded", async () => {
  const { database, repository } = setup();
  const support = addObservation(repository, {
    id: "classification-choice",
    signal: "active_choice",
    direction: "support",
    content: "用户在空闲时间主动选择解谜游戏。",
    sourceText: "今晚我还是选择解谜。",
    occurredAt: "2026-07-17T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "medium",
      canDecline: true,
    },
  });
  const review = await approvedSelectionReview(repository, support);
  const pending = proposePreferenceStateFromCanonicalReview(repository, {
    agentId: "agent-test",
    review,
  });
  repository.recordStateEvidenceObservation({
    id: "classification-choice-revised",
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryId: support.memory.id,
    evidenceGroupId: support.observation.evidence_group_id,
    contextId: support.observation.context_id,
    signal: "repeated_behavior",
    claimedDirection: "neutral",
    effectiveDirection: "neutral",
    qualification: "excluded",
    confidence: 0.9,
    origin: "deterministic",
    scope: support.observation.scope,
    payloadSchemaVersion: "test-reclassified-v1",
    payload: { reason: "alternatives-were-not-actually-available" },
    excludedReason: "alternatives-unknown",
    sourceIds: [support.source.id],
    observedAt: "2026-07-17T12:00:00.000Z",
  });
  assert.throws(() => resolvePreferenceStateProposal(repository, {
    agentId: "agent-test",
    proposalId: pending.proposal.id,
    action: "accept",
  }), /evidence set changed after canonical review/u);
  assert.equal(
    repository.getPreferenceStateProposal("agent-test", pending.proposal.id).review_state,
    "pending",
  );
  database.close();
});

test("rejects a synthesis that omits one qualified counter observation and never calls the critic", async () => {
  const { database, repository } = setup({ withCurrent: true });
  const support = addObservation(repository, {
    id: "choice-support",
    signal: "active_choice",
    direction: "support",
    content: "用户空闲时主动选择解谜游戏。",
    sourceText: "我今晚想玩解谜游戏。",
    occurredAt: "2026-07-12T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "medium",
      canDecline: true,
    },
  });
  addObservation(repository, {
    id: "counter-opposition",
    signal: "counter_behavior",
    direction: "opposition",
    content: "用户有空时主动回避解谜游戏。",
    sourceText: "今晚有空，但我不想玩解谜。",
    occurredAt: "2026-07-20T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "low",
      canDecline: true,
    },
  });
  let criticCalls = 0;
  const result = await reviewPreferenceCanonicalState(reviewArgs(repository, {
    synthesizer: async () => ({ output: {
      action: "maintain",
      proposedLevel: "stable_preference",
      scopeChange: "none",
      scope: { kind: "category", label: "解谜游戏", context: "" },
      evidenceDecisions: [{
        observationId: support.observation.id,
        treatment: "positive_preference_evidence",
        rationale: "支持",
      }],
      confidence: 0.7,
      rationale: "保持当前",
    } }),
    critic: async () => {
      criticCalls += 1;
      return { output: { verdict: "approve_shadow", issues: [], summary: "不应调用" } };
    },
  }));
  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, "state-synthesis-failed-or-rejected");
  assert.equal(result.runs.synthesizer.status, "rejected");
  assert.match(result.runs.synthesizer.error_message, /omitted qualified/u);
  assert.equal(criticCalls, 0);
  database.close();
});

test("keeps a full-evidence downgrade as human review and never creates a pending proposal", async () => {
  const { database, repository, current, currentEvidence } = setup({ withCurrent: true });
  repository.recordStateEvidenceObservation({
    id: "current-state-support-invalidated",
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    memoryId: currentEvidence.memory.id,
    evidenceGroupId: currentEvidence.observation.evidence_group_id,
    contextId: currentEvidence.observation.context_id,
    signal: "active_choice",
    claimedDirection: "support",
    effectiveDirection: "neutral",
    qualification: "excluded",
    confidence: 0.9,
    origin: "deterministic",
    scope: currentEvidence.observation.scope,
    payloadSchemaVersion: "test-evidence-invalidated-v1",
    payload: { reason: "later-full-review-invalidated-support" },
    excludedReason: "support-no-longer-qualifies",
    sourceIds: [currentEvidence.source.id],
    observedAt: "2026-07-24T12:00:00.000Z",
  });
  const counter = addObservation(repository, {
    id: "qualified-counter",
    signal: "counter_behavior",
    direction: "opposition",
    content: "用户在可自由选择时持续不再选择解谜游戏。",
    sourceText: "最近有空也不想玩解谜了。",
    occurredAt: "2026-07-25T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "low",
      canDecline: true,
    },
  });
  const result = await reviewPreferenceCanonicalState(reviewArgs(repository, {
    synthesizer: async () => ({ output: {
      action: "downgrade",
      proposedLevel: "no_conclusion",
      scopeChange: "none",
      scope: { kind: "category", label: "解谜游戏", context: "" },
      evidenceDecisions: [{
        observationId: counter.observation.id,
        treatment: "negative_preference_evidence",
        rationale: "同范围有效反证",
      }],
      confidence: 0.72,
      rationale: "当前完整证据不足以继续维持稳定偏好",
    } }),
    critic: async () => ({ output: {
      verdict: "human_review",
      issues: [{
        code: "insufficient_evidence",
        severity: "warning",
        observationIds: [counter.observation.id],
        rationale: "只有一个独立反证，降级需人工确认",
      }],
      summary: "保留人工复核",
    } }),
  }));
  assert.equal(result.status, "human-review-required");
  assert.equal(result.pendingProposal, null);
  assert.equal(repository.getMemory(current.id).status, "active");
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_preference_state_proposals").get().count),
    0,
  );
  database.close();
});

test("does not silently truncate a full canonical review", () => {
  const { database, repository } = setup();
  addObservation(repository, {
    id: "support-one",
    signal: "explicit_preference",
    direction: "support",
    content: "用户喜欢解谜游戏。",
    sourceText: "我喜欢解谜。",
    occurredAt: "2026-07-12T12:00:00.000Z",
  });
  addObservation(repository, {
    id: "support-two",
    signal: "active_sharing",
    direction: "support",
    content: "用户主动分享解谜游戏。",
    sourceText: "我给你讲个刚玩的谜题。",
    occurredAt: "2026-07-13T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "low",
      topicInitiation: "self_initiated",
      affectiveExpression: "positive",
      canDecline: true,
    },
  });
  assert.throws(() => buildPreferenceCanonicalReviewSnapshot(reviewArgs(repository, {
    maxObservations: 1,
  })), /exceeds the complete 1-observation budget/u);
  database.close();
});

test("refuses to call a legacy current state fully reviewed when its evidence edges are missing", () => {
  const { database, repository } = setup();
  repository.upsertMemory({
    id: "legacy-current-without-evidence",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "用户喜欢解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-01T00:00:00.000Z",
    knownAt: "2026-07-01T00:00:00.000Z",
    metadata: { preferenceStateLevel: "stable_preference" },
  });
  addObservation(repository, {
    id: "later-counter",
    signal: "counter_behavior",
    direction: "opposition",
    content: "用户后来没有选择解谜游戏。",
    sourceText: "今天不想玩解谜。",
    occurredAt: "2026-07-20T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "low",
      canDecline: true,
    },
  });
  assert.throws(() => buildPreferenceCanonicalReviewSnapshot(reviewArgs(repository)), /no auditable evidence edges/u);
  database.close();
});

test("rejects a critic that approves while declaring a critical issue", async () => {
  const { database, repository } = setup();
  const support = addObservation(repository, {
    id: "critic-support",
    signal: "active_choice",
    direction: "support",
    content: "用户在空闲时间主动选择解谜游戏。",
    sourceText: "今晚我想主动玩解谜游戏。",
    occurredAt: "2026-07-12T12:00:00.000Z",
    payload: {
      agency: "self_initiated",
      constraint: "none",
      alternatives: "available",
      instrumentalGoal: "none",
      opportunityCost: "medium",
      canDecline: true,
    },
  });
  const result = await reviewPreferenceCanonicalState(reviewArgs(repository, {
    synthesizer: async () => ({ output: {
      action: "create",
      proposedLevel: "selection_tendency",
      scopeChange: "none",
      scope: { kind: "category", label: "解谜游戏", context: "" },
      evidenceDecisions: [{
        observationId: support.observation.id,
        treatment: "positive_preference_evidence",
        rationale: "主动选择",
      }],
      confidence: 0.95,
      rationale: "建立选择倾向影子方案",
    } }),
    critic: async () => ({ output: {
      verdict: "approve_shadow",
      issues: [{
        code: "scope_overreach",
        severity: "critical",
        observationIds: [support.observation.id],
        rationale: "范围仍然过宽",
      }],
      summary: "错误地同时批准和报告关键问题",
    } }),
  }));
  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, "state-critic-failed-or-rejected");
  assert.equal(result.runs.critic.status, "rejected");
  assert.match(result.runs.critic.error_message, /cannot approve/u);
  database.close();
});

test("promotes a fully reviewed inferred preference only through a separate pending established review", async () => {
  const { database, repository } = setup();
  const { supports, accepted } = await acceptedStablePreference(repository, "promotion");

  assert.throws(() => proposePreferenceEstablishedPromotion(repository, {
    agentId: "agent-test",
    sourceMemoryId: accepted.memory.id,
    policy: { ...establishedPromotionPolicy, minimumDistinctDays: 3 },
    createdAt: "2026-08-02T08:00:00.000Z",
  }), /distinct days/u);
  assert.equal(repository.listStatePromotionProposals("agent-test").length, 0);

  const proposal = proposePreferenceEstablishedPromotion(repository, {
    agentId: "agent-test",
    sourceMemoryId: accepted.memory.id,
    policy: establishedPromotionPolicy,
    createdAt: "2026-08-02T08:00:00.000Z",
  });
  assert.equal(proposal.review_state, "pending");
  assert.equal(proposal.source_representation_layer, "inferred");
  assert.equal(proposal.target_representation_layer, "established");
  assert.match(proposal.source_snapshot_hash, /^[0-9a-f]{64}$/u);
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    representationLayer: "established",
    stateFamily: "preference",
    stateScopeKey: "root",
  }), null);
  assert.throws(() => resolveStatePromotionProposal(repository, {
    agentId: "another-agent",
    proposalId: proposal.id,
    action: "accept",
  }), /does not exist/u);

  const reported = repository.upsertMemory({
    id: "promotion-reported-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户明确说过自己喜欢解谜游戏。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    reality: "real",
    evidenceMode: "explicit",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-25T08:00:00.000Z",
    knownAt: "2026-07-25T08:00:00.000Z",
    metadata: { preferenceStateLevel: "direct_preference" },
  });
  const resolved = resolveStatePromotionProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
    resolvedBy: "human:test",
  });
  assert.equal(resolved.status, "established");
  assert.equal(resolved.memory.representation_layer, "established");
  assert.equal(resolved.memory.metadata.establishedFromMemoryId, accepted.memory.id);
  assert.equal(repository.getMemory(accepted.memory.id).status, "superseded");
  assert.equal(repository.getMemory(reported.id).status, "active");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: resolved.memory.id,
    toMemoryId: accepted.memory.id,
    relation: "established_from",
  }).relation, "established_from");
  for (const support of supports) {
    assert.equal(repository.findEdge({
      agentId: "agent-test",
      fromMemoryId: resolved.memory.id,
      toMemoryId: support.memory.id,
      relation: "supported_by",
    }).relation, "supported_by");
  }
  assert.equal(repository.getMemoryDetail("agent-test", resolved.memory.id).sources.length, 2);

  const revoked = revokeStatePromotionProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    revokedBy: "human:test",
    note: "test rollback",
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.memory.status, "disputed");
  assert.equal(revoked.restoredSource.status, "active");
  assert.equal(repository.getMemory(reported.id).status, "active");
  assert.equal(repository.getStatePromotionProposal("agent-test", proposal.id).review_state, "revoked");
  database.close();
});

test("keeps an established promotion pending when its audited evidence drifts", async () => {
  const { database, repository } = setup();
  const { supports, accepted } = await acceptedStablePreference(repository, "promotion-drift");
  const proposal = proposePreferenceEstablishedPromotion(repository, {
    agentId: "agent-test",
    sourceMemoryId: accepted.memory.id,
    policy: establishedPromotionPolicy,
    createdAt: "2026-08-02T09:00:00.000Z",
  });
  repository.editMemoryManually({
    agentId: "agent-test",
    memoryId: supports[0].memory.id,
    patch: { content: "人工复核后，这条事件不再证明存在真实替代项。" },
    reason: "test established evidence drift",
  });
  assert.throws(() => resolveStatePromotionProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /source changed after review/u);
  assert.equal(repository.getStatePromotionProposal("agent-test", proposal.id).review_state, "pending");
  assert.equal(repository.getMemory(accepted.memory.id).status, "active");
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    representationLayer: "established",
    stateFamily: "preference",
    stateScopeKey: "root",
  }), null);
  database.close();
});

test("refuses to revoke an established promotion after a later established state exists", async () => {
  const { database, repository } = setup();
  const { accepted } = await acceptedStablePreference(repository, "promotion-later");
  const proposal = proposePreferenceEstablishedPromotion(repository, {
    agentId: "agent-test",
    sourceMemoryId: accepted.memory.id,
    policy: establishedPromotionPolicy,
    createdAt: "2026-08-02T10:00:00.000Z",
  });
  const resolved = resolveStatePromotionProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  });
  repository.closeCurrentMemoryState({
    agentId: "agent-test",
    memoryId: resolved.memory.id,
    validTo: "2026-08-03T10:00:00.000Z",
  });
  repository.upsertMemory({
    id: "later-established-preference",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "后续证据重新界定了用户对解谜游戏的稳定偏好。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "established",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-08-03T10:00:00.000Z",
    knownAt: "2026-08-03T10:00:00.000Z",
    metadata: { preferenceStateLevel: "stable_preference" },
  });
  assert.throws(() => revokeStatePromotionProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    note: "unsafe rollback",
  }), /later changes/u);
  assert.equal(repository.getStatePromotionProposal("agent-test", proposal.id).review_state, "accepted");
  database.close();
});


test("fictional state promotion and revocation preserve its world alongside a real current state", async t => {
  const { database, repository } = setup(); t.after(() => database.close());
  const real = await acceptedStablePreference(repository, 'world-real', { reality: 'real', worldId: 'room', worldFrame: 'physical' });
  const storyWorld = { reality: 'fictional', worldId: 'story-a', worldFrame: 'fictional' };
  const story = await acceptedStablePreference(repository, 'world-story', storyWorld);
  assert.equal(repository.getMemory(real.accepted.memory.id).status, 'active');
  const proposal = proposePreferenceEstablishedPromotion(repository, { agentId: 'agent-test', sourceMemoryId: story.accepted.memory.id,
    policy: establishedPromotionPolicy, createdAt: '2026-08-02T08:00:00Z' });
  const promoted = resolveStatePromotionProposal(repository, { agentId: 'agent-test', proposalId: proposal.id, action: 'accept' });
  assert.deepEqual([promoted.memory.reality, promoted.memory.world_id, promoted.memory.world_frame], ['fictional', 'story-a', 'fictional']);
  const revoked = revokeStatePromotionProposal(repository, { agentId: 'agent-test', proposalId: proposal.id, revokedBy: 'human', note: 'Review withdrawn.' });
  assert.deepEqual([revoked.restoredSource.reality, revoked.restoredSource.world_id, revoked.restoredSource.world_frame], ['fictional', 'story-a', 'fictional']);
  assert.equal(repository.getMemory(real.accepted.memory.id).status, 'active');
});

test("a mixed-world complete preference review blocks before invoking either model", async t => {
  const { database, repository } = setup(); t.after(() => database.close());
  const a = addObservation(repository, { id: 'ambiguous-real', signal: 'active_choice', direction: 'support', content: 'A real choice.', sourceText: 'Real.', occurredAt: '2026-07-20T09:00:00Z' });
  const b = addObservation(repository, { id: 'ambiguous-story', signal: 'active_choice', direction: 'support', content: 'A fictional choice.', sourceText: 'Story.', occurredAt: '2026-07-21T09:00:00Z',
    world: { reality: 'fictional', worldId: 'story', worldFrame: 'fictional' } });
  let calls = 0;
  const review = await reviewPreferenceCanonicalState(reviewArgs(repository, { synthesizer: async () => { calls++; throw Error('unexpected'); }, critic: async () => { calls++; throw Error('unexpected'); } }));
  assert.equal(review.status, 'blocked'); assert.equal(review.reason, 'world-scope-required'); assert.equal(calls, 0);
  assert.deepEqual(review.snapshot.observations.map(item => item.memoryId).sort(), [a.memory.id, b.memory.id].sort());
});

test("canonical freshness and promotion use observation semantic worlds rather than raw real dialogue", async t => {
  const { database, repository } = setup(); t.after(() => database.close());
  const real = await acceptedStablePreference(repository, 'raw-real');
  const world = { reality: 'fictional', worldId: 'story-semantic', worldFrame: 'fictional' };
  const fictional = await acceptedStablePreference(repository, 'raw-story', null, world);
  assert.equal(repository.getMemory(fictional.supports[0].memory.id).reality, 'real');
  assert.deepEqual([fictional.accepted.memory.reality, fictional.accepted.memory.world_id, fictional.accepted.memory.world_frame], ['fictional', 'story-semantic', 'fictional']);
  const promotion = proposePreferenceEstablishedPromotion(repository, { agentId: 'agent-test', sourceMemoryId: fictional.accepted.memory.id,
    policy: establishedPromotionPolicy, createdAt: '2026-08-02T08:00:00Z' });
  const accepted = resolveStatePromotionProposal(repository, { agentId: 'agent-test', proposalId: promotion.id, action: 'accept' });
  assert.equal(accepted.memory.reality, 'fictional');
  assert.equal(repository.getMemory(real.accepted.memory.id).status, 'active');
  const revoked = revokeStatePromotionProposal(repository, { agentId: 'agent-test', proposalId: promotion.id, revokedBy: 'human', note: 'Review withdrawn.' });
  assert.equal(revoked.restoredSource.reality, 'fictional');
});
