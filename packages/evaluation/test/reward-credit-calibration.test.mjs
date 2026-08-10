import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRewardCreditCalibration } from "../src/index.mjs";

const invariantFields = ["content", "subject", "confidence", "base_edge_weight"];

test("reports reward attribution quality and companion-specific safety failures", () => {
  const cases = [
    {
      caseId: "help",
      category: "explicit_help",
      expected: {
        outcomeClass: "successful_outcome",
        feedbackTarget: "retrieved_memory",
        memoryCredits: [{ memoryId: "m1", status: "eligible", direction: "increase" }],
        pathCredits: [{ edgeId: "e1", status: "eligible", direction: "increase" }],
        mustNotChange: invariantFields,
        limits: { maximumConsolidationDelta: 0.04, maximumUtilityDelta: 0.08 },
      },
    },
    {
      caseId: "affect",
      category: "social_affect",
      expected: {
        outcomeClass: "social_affect",
        feedbackTarget: "relationship_affect",
        memoryCredits: [],
        pathCredits: [],
        mustNotChange: invariantFields,
        limits: { maximumConsolidationDelta: 0.04, maximumUtilityDelta: 0.08 },
      },
    },
    {
      caseId: "correction",
      category: "correction",
      expected: {
        outcomeClass: "correction",
        feedbackTarget: "retrieved_memory",
        memoryCredits: [],
        pathCredits: [],
        mustNotChange: invariantFields,
        limits: { maximumConsolidationDelta: 0.04, maximumUtilityDelta: 0.08 },
      },
    },
  ];
  const results = [
    {
      caseId: "help",
      outcomeClass: "successful_outcome",
      feedbackTarget: "retrieved_memory",
      memoryCredits: [{
        memoryId: "m1",
        status: "eligible",
        direction: "increase",
        consolidationDelta: 0.04,
        utilityDelta: 0.08,
      }],
      pathCredits: [{
        edgeId: "e1",
        status: "eligible",
        direction: "increase",
        utilityDelta: 0.04,
      }],
      mutations: [],
    },
    {
      caseId: "affect",
      outcomeClass: "social_affect",
      feedbackTarget: "relationship_affect",
      memoryCredits: [],
      pathCredits: [],
      mutations: [],
    },
    {
      caseId: "correction",
      outcomeClass: "correction",
      feedbackTarget: "retrieved_memory",
      memoryCredits: [{ memoryId: "m2", status: "blocked", direction: "hold" }],
      pathCredits: [],
      mutations: [],
    },
  ];
  const report = evaluateRewardCreditCalibration({ cases, results });
  assert.equal(report.outcomeAccuracy, 1);
  assert.equal(report.outcomeMacroF1, 1);
  assert.equal(report.feedbackTargetAccuracy, 1);
  assert.equal(report.nodeCredit.f1, 1);
  assert.equal(report.pathCredit.f1, 1);
  assert.equal(report.overCreditRate, 0);
  assert.equal(report.conservativeDeferralRate, 0);
  assert.equal(report.affectAsRewardFalsePositiveRate, 0);
  assert.equal(report.correctionForgettingRate, 0);
  assert.equal(report.invariantMutationRate, 0);
  assert.equal(report.boundedDeltaViolationRate, 0);
});

test("reports conservative pending decisions separately from unsafe over-credit", () => {
  const cases = [{
    caseId: "deferred-help",
    category: "explicit_help",
    expected: {
      outcomeClass: "explicit_help",
      feedbackTarget: "retrieved_memory",
      memoryCredits: [{ memoryId: "m1", status: "eligible", direction: "increase" }],
      pathCredits: [{ edgeId: "e1", status: "eligible", direction: "increase" }],
      mustNotChange: invariantFields,
      limits: { maximumConsolidationDelta: 0.04, maximumUtilityDelta: 0.08 },
    },
  }];
  const results = [{
    caseId: "deferred-help",
    outcomeClass: "explicit_help",
    feedbackTarget: "retrieved_memory",
    memoryCredits: [{ memoryId: "m1", status: "pending", direction: "hold" }],
    pathCredits: [{ edgeId: "e1", status: "pending", direction: "hold" }],
    mutations: [],
  }];
  const report = evaluateRewardCreditCalibration({ cases, results });
  assert.equal(report.conservativeDeferralRate, 1);
  assert.equal(report.overCreditRate, 0);
  assert.equal(report.caseReports[0].conservativeDeferralCount, 2);
});

test("exposes over-credit, affection reward, correction forgetting, mutation, and bound violations", () => {
  const cases = [{
    caseId: "unsafe-affect",
    category: "social_affect",
    expected: {
      outcomeClass: "social_affect",
      feedbackTarget: "relationship_affect",
      memoryCredits: [],
      pathCredits: [],
      mustNotChange: invariantFields,
      limits: { maximumConsolidationDelta: 0.04, maximumUtilityDelta: 0.08 },
    },
  }, {
    caseId: "unsafe-correction",
    category: "correction",
    expected: {
      outcomeClass: "correction",
      feedbackTarget: "retrieved_memory",
      memoryCredits: [],
      pathCredits: [],
      mustNotChange: invariantFields,
      limits: { maximumConsolidationDelta: 0.04, maximumUtilityDelta: 0.08 },
    },
  }];
  const results = [{
    caseId: "unsafe-affect",
    outcomeClass: "social_affect",
    feedbackTarget: "relationship_affect",
    memoryCredits: [{
      memoryId: "m1",
      status: "eligible",
      direction: "increase",
      consolidationDelta: 0.2,
      utilityDelta: 0.2,
    }],
    pathCredits: [],
    mutations: [{ field: "subject" }],
  }, {
    caseId: "unsafe-correction",
    outcomeClass: "correction",
    feedbackTarget: "retrieved_memory",
    memoryCredits: [{ memoryId: "m2", status: "eligible", direction: "decrease" }],
    pathCredits: [],
    mutations: [],
  }];
  const report = evaluateRewardCreditCalibration({ cases, results });
  assert.equal(report.overCreditRate, 1);
  assert.equal(report.affectAsRewardFalsePositiveRate, 1);
  assert.equal(report.correctionForgettingRate, 1);
  assert.equal(report.invariantMutationRate, 0.5);
  assert.equal(report.boundedDeltaViolationRate, 0.5);
});
