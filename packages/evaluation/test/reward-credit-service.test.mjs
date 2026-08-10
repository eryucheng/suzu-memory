import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";

import {
  createRewardPathCreditProposals,
  processRewardObservation,
} from "../src/index.mjs";

function fixture({
  feedbackText = "真的做出来了，就是因为想起以前那道题。",
  memoryCount = 1,
  withPath = false,
} = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const memoryIds = Array.from({ length: memoryCount }, (_, index) => `reward-memory-${index + 1}`);
  memoryIds.forEach((memoryId, index) => repository.upsertMemory({
    id: memoryId,
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: `旧题${index + 1}`,
    content: `用户高考前做过相似题${index + 1}。`,
    subjectRole: "user",
    subjectKey: "user",
  }));
  let edge = null;
  if (withPath) {
    repository.upsertMemory({
      id: "reward-seed",
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      title: "当前题",
      content: "用户正在处理当前题。",
      subjectRole: "user",
      subjectKey: "user",
    });
    edge = repository.upsertEdge({
      id: "reward-path-edge",
      agentId: "agent-test",
      fromMemoryId: "reward-seed",
      toMemoryId: memoryIds[0],
      relation: "associated_with",
      direction: "directed",
      weight: 0.8,
    });
  }
  const trace = repository.recordRetrievalTrace({
    id: "reward-trace",
    agentId: "agent-test",
    queryText: "这道题怎么做",
    recallIntent: "problem-solving",
    resultStatus: "ready",
    seedIds: withPath ? ["reward-seed"] : memoryIds,
    selectedIds: memoryIds,
    paths: withPath ? [{
      memoryId: memoryIds[0],
      score: 0.8,
      sourceCount: 1,
      seedContributions: [{ seedMemoryId: "reward-seed", score: 0.8 }],
      edges: [{
        edgeId: edge.id,
        relation: edge.relation,
        traversalFromMemoryId: "reward-seed",
        traversalToMemoryId: memoryIds[0],
        relationView: "associative",
      }],
    }] : [],
    metadata: { runtimeSessionKey: "reward-session" },
  });
  repository.setRetrievalSessionHead({
    agentId: "agent-test",
    sessionId: "reward-session",
    traceId: trace.id,
  });
  const request = repository.bindRetrievalUsageResponse({
    agentId: "agent-test",
    sessionId: "reward-session",
    responseText: "你以前做过相似题，可以沿用当时的方法。",
  });
  const observation = repository.bindRewardObservation({
    agentId: "agent-test",
    sessionId: "reward-session",
    feedbackText,
  });
  return { database, repository, memoryIds, trace, request, observation, edge };
}

function completeUsage(value, usedMemoryIds = value.memoryIds) {
  value.repository.resolveRetrievalUsageRequest({
    agentId: "agent-test",
    requestId: value.request.id,
    status: "completed",
    result: { usedMemoryIds, notUsedMemoryIds: [], uncertainMemoryIds: [] },
  });
}

test("waits for response-grounded usage before analyzing delayed reward", async () => {
  const value = fixture();
  const result = await processRewardObservation({
    repository: value.repository,
    agentId: "agent-test",
    observationId: value.observation.id,
  });
  assert.equal(result.status, "waiting-for-usage-analysis");
  assert.equal(value.repository.getRewardObservation("agent-test", value.observation.id).status, "pending");
  value.database.close();
});

test("creates an eligible bounded shadow credit for explicit successful help", async () => {
  const value = fixture();
  completeUsage(value);
  const analyzers = {
    outcome: async () => ({
      output: {
        outcomeClass: "successful_outcome",
        valence: "positive",
        evidenceTier: "explicit_attribution",
        confidence: 0.96,
        rationale: "用户明确说旧题帮助自己做出了当前题。",
      },
      model: "test-model",
      metadata: { provider: "test" },
    }),
    target: async () => ({
      output: {
        targetType: "retrieved_memory",
        targetMemoryIds: value.memoryIds,
        explicitAttribution: true,
        confidence: 0.95,
        rationale: "反馈明确指向被想起的旧题。",
      },
      model: "test-model",
      metadata: { provider: "test" },
    }),
    credit: async () => ({
      output: { analyses: [{
        memoryId: value.memoryIds[0],
        contributionClass: "direct",
        contributionShare: 1,
        contextKey: "problem-solving",
        confidence: 0.94,
        rationale: "旧题方法直接帮助解题。",
      }] },
      model: "test-model",
      metadata: { provider: "test" },
    }),
  };
  const before = value.repository.getMemory(value.memoryIds[0]);
  const result = await processRewardObservation({
    repository: value.repository,
    agentId: "agent-test",
    observationId: value.observation.id,
    analyzers,
  });
  assert.equal(result.status, "analyzed");
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].status, "eligible");
  assert.equal(result.proposals[0].reward_direction, "increase");
  assert.ok(result.proposals[0].reward_value > 0);
  assert.ok(result.proposals[0].proposed_consolidation_delta > 0);
  assert.ok(result.proposals[0].proposed_utility_delta > 0);
  assert.equal(result.proposals[0].evidence.delayDiscount, 1);
  assert.equal(result.proposals[0].evidence.feedbackBinding, "immediate-next-user-input");
  assert.equal(result.automaticStateMutationAllowed, false);
  assert.deepEqual(value.repository.getMemory(value.memoryIds[0]), before);
  assert.equal(value.repository.listRewardAnalysisRuns("agent-test", value.observation.id).length, 3);
  value.database.close();
});

test("keeps ordinary positive affect out of reward credit", async () => {
  const value = fixture({ feedbackText: "哈哈哈，你真可爱。" });
  completeUsage(value);
  const analyzers = {
    outcome: async () => ({ output: {
      outcomeClass: "social_affect",
      valence: "positive",
      evidenceTier: "implicit",
      confidence: 0.99,
      rationale: "只有亲昵和积极情绪。",
    } }),
    target: async () => ({ output: {
      targetType: "relationship_affect",
      targetMemoryIds: [],
      explicitAttribution: false,
      confidence: 0.98,
      rationale: "评价的是关系感受。",
    } }),
    credit: async () => ({ output: { analyses: [{
      memoryId: value.memoryIds[0],
      contributionClass: "none",
      contributionShare: 0,
      contextKey: "relationship",
      confidence: 0.98,
      rationale: "没有证据表明旧题促成反馈。",
    }] } }),
  };
  const result = await processRewardObservation({
    repository: value.repository,
    agentId: "agent-test",
    observationId: value.observation.id,
    analyzers,
  });
  assert.equal(result.proposals[0].status, "blocked");
  assert.equal(result.proposals[0].reward_value, 0);
  assert.equal(result.proposals[0].proposed_consolidation_delta, 0);
  assert.equal(result.proposals[0].proposed_utility_delta, 0);
  value.database.close();
});

test("keeps malformed analyzer output retryable and auditable", async () => {
  const value = fixture();
  completeUsage(value);
  const result = await processRewardObservation({
    repository: value.repository,
    agentId: "agent-test",
    observationId: value.observation.id,
    analyzers: {
      outcome: async () => ({ output: "not-json", model: "test-model" }),
      target: async () => ({ output: {} }),
      credit: async () => ({ output: {} }),
    },
  });
  assert.equal(result.status, "retryable-failure");
  assert.equal(result.failedRole, "outcome");
  assert.equal(value.repository.getRewardObservation("agent-test", value.observation.id).status, "pending");
  const runs = value.repository.listRewardAnalysisRuns("agent-test", value.observation.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "rejected");
  assert.equal(runs[0].output.rawText, "not-json");
  value.database.close();
});

test("routes an explicit memory correction to content review instead of negative forgetting", async () => {
  const value = fixture({ feedbackText: "不是我做过这道题，你记到别人身上了。" });
  completeUsage(value);
  const analyzers = {
    outcome: async () => ({ output: {
      outcomeClass: "correction",
      valence: "negative",
      evidenceTier: "explicit_attribution",
      confidence: 0.99,
      rationale: "用户明确纠正主体归属。",
    } }),
    target: async () => ({ output: {
      targetType: "retrieved_memory",
      targetMemoryIds: value.memoryIds,
      explicitAttribution: true,
      confidence: 0.99,
      rationale: "纠正具体指向被召回旧题。",
    } }),
    credit: async () => ({ output: { analyses: [{
      memoryId: value.memoryIds[0],
      contributionClass: "direct",
      contributionShare: 1,
      contextKey: "problem-solving",
      confidence: 0.99,
      rationale: "该记忆直接造成了错误归属。",
    }] } }),
  };
  const result = await processRewardObservation({
    repository: value.repository,
    agentId: "agent-test",
    observationId: value.observation.id,
    analyzers,
  });
  assert.equal(result.proposals[0].status, "blocked");
  assert.equal(result.proposals[0].reward_direction, "hold");
  assert.equal(result.proposals[0].reward_value, 0);
  assert.match(result.proposals[0].rationale, /content-correction-requires-state-review/u);
  value.database.close();
});

test("splits bounded credit only across memories explicitly linked to the result", async () => {
  const value = fixture({ memoryCount: 2 });
  completeUsage(value);
  const analyzers = {
    outcome: async () => ({ output: {
      outcomeClass: "explicit_help",
      valence: "positive",
      evidenceTier: "explicit_attribution",
      confidence: 0.9,
      rationale: "用户明确表示旧方法有帮助。",
    } }),
    target: async () => ({ output: {
      targetType: "retrieved_memory",
      targetMemoryIds: [value.memoryIds[0]],
      explicitAttribution: true,
      confidence: 0.9,
      rationale: "只指向第一道旧题。",
    } }),
    credit: async () => ({ output: { analyses: [
      {
        memoryId: value.memoryIds[0],
        contributionClass: "direct",
        contributionShare: 0.8,
        contextKey: "problem-solving",
        confidence: 0.9,
        rationale: "第一道题的方法被实际采用。",
      },
      {
        memoryId: value.memoryIds[1],
        contributionClass: "none",
        contributionShare: 0,
        contextKey: "problem-solving",
        confidence: 0.95,
        rationale: "第二道题虽被提到但没有帮助结果。",
      },
    ] } }),
  };
  const result = await processRewardObservation({
    repository: value.repository,
    agentId: "agent-test",
    observationId: value.observation.id,
    analyzers,
  });
  const byMemory = new Map(result.proposals.map((proposal) => [proposal.memory_id, proposal]));
  assert.equal(byMemory.get(value.memoryIds[0]).status, "eligible");
  assert.equal(byMemory.get(value.memoryIds[1]).status, "blocked");
  assert.equal(byMemory.get(value.memoryIds[1]).reward_value, 0);
  value.database.close();
});

test("creates auditable edge eligibility credit only for the actual selected path", async () => {
  const value = fixture({ withPath: true });
  completeUsage(value);
  const result = await processRewardObservation({
    repository: value.repository,
    agentId: "agent-test",
    observationId: value.observation.id,
    analyzers: {
      outcome: async () => ({ output: {
        outcomeClass: "successful_outcome",
        valence: "positive",
        evidenceTier: "explicit_attribution",
        confidence: 0.96,
        rationale: "虚构反馈明确报告成功。",
      } }),
      target: async () => ({ output: {
        targetType: "retrieved_memory",
        targetMemoryIds: value.memoryIds,
        explicitAttribution: true,
        confidence: 0.95,
        rationale: "反馈明确指向旧题。",
      } }),
      credit: async () => ({ output: { analyses: [{
        memoryId: value.memoryIds[0],
        contributionClass: "direct",
        contributionShare: 1,
        contextKey: "problem-solving",
        confidence: 0.94,
        rationale: "旧题方法实际被采用。",
      }] } }),
    },
  });
  assert.equal(result.pathProposals.length, 1);
  assert.equal(result.pathProposals[0].edge_id, value.edge.id);
  assert.equal(result.pathProposals[0].distance_from_target, 0);
  assert.equal(result.pathProposals[0].eligibility_weight, 1);
  assert.equal(result.pathProposals[0].status, "eligible");
  assert.ok(result.pathProposals[0].proposed_utility_delta > 0);
  value.database.close();
});

test("normalizes distance-decayed eligibility across a multi-edge path", () => {
  const values = createRewardPathCreditProposals({
    trace: {
      id: "trace-distance",
      recall_intent: "timeline",
      paths: [{
        memoryId: "target",
        edges: [
          { edgeId: "far", relationView: "timeline" },
          { edgeId: "near", relationView: "timeline" },
        ],
      }],
    },
    memoryProposals: [{
      id: "memory-proposal",
      observationId: "observation",
      memoryId: "target",
      contextKey: "timeline",
      rewardDirection: "increase",
      rewardValue: 1,
      proposedUtilityDelta: 0.08,
      status: "eligible",
    }],
  });
  assert.equal(values.length, 2);
  const byEdge = new Map(values.map((value) => [value.edgeId, value]));
  assert.ok(byEdge.get("near").eligibilityWeight > byEdge.get("far").eligibilityWeight);
  assert.ok(Math.abs(
    values.reduce((sum, value) => sum + value.eligibilityWeight, 0) - 1,
  ) < 1e-6);
  assert.ok(Math.abs(
    values.reduce((sum, value) => sum + value.proposedUtilityDelta, 0) - 0.08,
  ) < 1e-6);
});
