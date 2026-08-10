import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "../src/index.mjs";

const applicationPolicy = Object.freeze({
  version: "reward-application-test-v1",
  allowedCreditPolicyVersions: ["reward-credit-shadow-v2"],
  allowedPathPolicyVersions: ["reward-path-eligibility-v1"],
  consolidation: {
    initialValue: 0.2,
    floor: 0.1,
    ceiling: 0.95,
    maximumPositiveStep: 0.05,
  },
  contextUtility: {
    initialValue: 0.5,
    floor: 0.1,
    ceiling: 0.9,
    maximumPositiveStep: 0.08,
    maximumNegativeStep: 0.08,
  },
  relationUtility: {
    initialValue: 0.5,
    floor: 0.1,
    ceiling: 0.9,
    maximumPositiveStep: 0.05,
    maximumNegativeStep: 0.05,
  },
});

function fixture() {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  for (const [id, title] of [["seed", "当前题"], ["old-method", "旧题方法"]]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      title,
      content: `${title}的虚构测试内容。`,
      subjectRole: "user",
      subjectKey: "user",
    });
  }
  const edge = repository.upsertEdge({
    id: "edge-old-method",
    agentId: "agent-test",
    fromMemoryId: "seed",
    toMemoryId: "old-method",
    relation: "associated_with",
    direction: "directed",
    weight: 0.8,
  });
  const trace = repository.recordRetrievalTrace({
    id: "reward-application-trace",
    agentId: "agent-test",
    queryText: "这道题怎么做",
    recallIntent: "problem-solving",
    resultStatus: "ready",
    seedIds: ["seed"],
    selectedIds: ["seed", "old-method"],
    paths: [{
      memoryId: "old-method",
      score: 0.8,
      sourceCount: 1,
      edges: [{
        edgeId: edge.id,
        relation: edge.relation,
        traversalFromMemoryId: "seed",
        traversalToMemoryId: "old-method",
        relationView: "associative",
      }],
    }],
    metadata: { runtimeSessionKey: "reward-application-session" },
  });
  repository.setRetrievalSessionHead({
    agentId: "agent-test",
    sessionId: "reward-application-session",
    traceId: trace.id,
  });
  repository.bindRetrievalUsageResponse({
    agentId: "agent-test",
    sessionId: "reward-application-session",
    responseText: "可以使用之前那道题的方法。",
  });
  const observation = repository.bindRewardObservation({
    agentId: "agent-test",
    sessionId: "reward-application-session",
    feedbackText: "这个旧方法确实帮我做出来了。",
  });
  const memoryProposal = repository.recordRewardCreditProposal({
    id: "memory-credit",
    observationId: observation.id,
    agentId: "agent-test",
    memoryId: "old-method",
    contextKey: "problem-solving",
    outcomeClass: "successful_outcome",
    feedbackTarget: "retrieved_memory",
    contributionClass: "direct",
    contributionShare: 1,
    evidenceTier: "explicit_attribution",
    rewardDirection: "increase",
    rewardValue: 0.9,
    proposedConsolidationDelta: 0.04,
    proposedUtilityDelta: 0.07,
    status: "eligible",
    policyVersion: "reward-credit-shadow-v2",
    rationale: "显式虚构测试反馈。",
  });
  repository.recordRewardPathCreditProposal({
    id: "path-credit",
    observationId: observation.id,
    memoryCreditProposalId: memoryProposal.id,
    agentId: "agent-test",
    memoryId: "old-method",
    edgeId: edge.id,
    contextKey: "problem-solving",
    pathPosition: 0,
    distanceFromTarget: 0,
    eligibilityWeight: 1,
    rewardDirection: "increase",
    rewardValue: 0.9,
    proposedUtilityDelta: 0.05,
    status: "eligible",
    policyVersion: "reward-path-eligibility-v1",
  });
  repository.resolveRewardObservation({
    agentId: "agent-test",
    observationId: observation.id,
    status: "analyzed",
    result: { proposalIds: [memoryProposal.id], pathProposalIds: ["path-credit"] },
  });
  return { database, repository, observation, edge };
}

test("previews, applies, audits, and rolls back bounded reward credit", () => {
  const value = fixture();
  const preview = value.repository.previewRewardCreditApplication({
    agentId: "agent-test",
    observationId: value.observation.id,
    policy: applicationPolicy,
  });
  assert.match(preview.inputHash, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    preview.changes.map((change) => change.targetType).sort(),
    ["consolidation", "context-utility", "relation-utility"],
  );
  assert.throws(() => value.repository.applyRewardCreditApplication({
    agentId: "agent-test",
    observationId: value.observation.id,
    policy: applicationPolicy,
    expectedInputHash: "0".repeat(64),
    actor: "human-test",
  }), /hash/u);
  const applied = value.repository.applyRewardCreditApplication({
    agentId: "agent-test",
    observationId: value.observation.id,
    policy: applicationPolicy,
    expectedInputHash: preview.inputHash,
    actor: "human-test",
    reason: "approved synthetic benchmark case",
  });
  assert.equal(applied.wasApplied, true);
  assert.equal(applied.appliedCount, 3);
  assert.ok(Math.abs(
    value.repository.getMemoryConsolidationState("agent-test", "old-method").value - 0.24,
  ) < 1e-12);
  assert.ok(Math.abs(
    value.repository.getMemoryContextUtilityState(
      "agent-test",
      "old-method",
      "problem-solving",
    ).value - 0.57,
  ) < 1e-12);
  assert.ok(Math.abs(
    value.repository.getEdgeRelationUtilityState(
      "agent-test",
      value.edge.id,
      "problem-solving",
    ).value - 0.55,
  ) < 1e-12);
  const replay = value.repository.applyRewardCreditApplication({
    agentId: "agent-test",
    observationId: value.observation.id,
    policy: applicationPolicy,
    expectedInputHash: preview.inputHash,
    actor: "human-test",
  });
  assert.equal(replay.wasApplied, false);
  const rolledBack = value.repository.rollbackRewardCreditApplication({
    agentId: "agent-test",
    applicationId: applied.id,
    actor: "human-test",
    reason: "synthetic rollback verification",
  });
  assert.equal(rolledBack.wasRolledBack, true);
  assert.equal(value.repository.getMemoryConsolidationState("agent-test", "old-method"), null);
  assert.equal(
    value.repository.getMemoryContextUtilityState(
      "agent-test",
      "old-method",
      "problem-solving",
    ),
    null,
  );
  assert.equal(
    value.repository.getEdgeRelationUtilityState(
      "agent-test",
      value.edge.id,
      "problem-solving",
    ),
    null,
  );
  assert.throws(() => value.repository.applyRewardCreditApplication({
    agentId: "agent-test",
    observationId: value.observation.id,
    policy: applicationPolicy,
    expectedInputHash: preview.inputHash,
    actor: "human-test",
  }), /rolled-back/u);
  value.database.close();
});
