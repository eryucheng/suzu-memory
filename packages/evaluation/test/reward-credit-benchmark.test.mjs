import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { REWARD_CREDIT_HOLDOUT_V1 } from "../fixtures/reward-credit-holdout-v1.mjs";
import { REWARD_CREDIT_MINI_V1 } from "../fixtures/reward-credit-mini-v1.mjs";
import {
  runRewardCreditBenchmark,
  validateRewardCreditBenchmark,
} from "../src/reward-credit-benchmark.mjs";

function valence(outcomeClass) {
  if (["explicit_help", "successful_outcome", "social_affect"].includes(outcomeClass)) return "positive";
  if (["correction", "failed_outcome"].includes(outcomeClass)) return "negative";
  if (outcomeClass === "uncertain") return "uncertain";
  return "neutral";
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(relativePath) {
  const normalizedSource = fs.readFileSync(path.join(PACKAGE_ROOT, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
  return crypto.createHash("sha256")
    .update(normalizedSource, "utf8")
    .digest("hex");
}

function oracleAnalyzers(item) {
  const expected = item.expected;
  return {
    outcome: async () => ({ output: {
      outcomeClass: expected.outcomeClass,
      valence: valence(expected.outcomeClass),
      evidenceTier: expected.evidenceTier,
      confidence: 0.98,
      rationale: "完全虚构基线的确定性结果标签。",
    } }),
    target: async () => ({ output: {
      targetType: expected.feedbackTarget,
      targetMemoryIds: expected.targetMemoryIds,
      explicitAttribution: expected.targetMemoryIds.length > 0,
      confidence: 0.98,
      rationale: "完全虚构基线的确定性目标标签。",
    } }),
    credit: async () => ({ output: {
      analyses: expected.memoryCredits.map((credit) => ({
        memoryId: credit.memoryId,
        contributionClass: credit.contributionClass,
        contributionShare: credit.contributionShare,
        contextKey: "problem-solving",
        confidence: 0.98,
        rationale: "完全虚构基线的确定性贡献信用。",
      })),
    } }),
  };
}

test("Suzu Reward Credit Mini v1 candidate contains 140 bounded synthetic replay cases", () => {
  const validation = validateRewardCreditBenchmark(REWARD_CREDIT_MINI_V1, { expectedCaseCount: 140 });
  assert.equal(validation.version, "suzu-reward-credit-mini-v1-rc1");
  assert.equal(Object.keys(validation.categories).length, 14);
  assert.deepEqual([...new Set(Object.values(validation.categories))], [10]);
});

test("the deterministic oracle replays every v1 case through the real shadow pipeline", async () => {
  const report = await runRewardCreditBenchmark({
    benchmark: REWARD_CREDIT_MINI_V1,
    analyzersForCase: oracleAnalyzers,
  });
  assert.equal(report.selection.count, 140);
  assert.equal(report.processing.every((item) => item.status === "analyzed"), true);
  assert.equal(report.metrics.outcomeAccuracy, 1);
  assert.equal(report.metrics.evidenceTierAccuracy, 1);
  assert.equal(report.metrics.feedbackTargetAccuracy, 1);
  assert.equal(report.metrics.targetMemoryIdsExactRate, 1);
  assert.equal(report.metrics.memoryDecisionExactRate, 1);
  assert.equal(report.metrics.pathDecisionExactRate, 1);
  assert.equal(report.metrics.contributionClass.f1, 1);
  assert.equal(report.metrics.contributionShareMae, 0);
  assert.equal(report.metrics.conservativeDeferralRate, 0);
  assert.deepEqual(report.results[0].analyzerConfidence, {
    outcome: 0.98,
    target: 0.98,
    creditByMemory: { "explicit-help-puzzle-target": 0.98 },
  });
  assert.equal(report.results[0].memoryCredits[0].reasonCode, "bounded-positive-credit");
  assert.equal(report.results[0].memoryCredits[0].combinedConfidence, 0.98);
  assert.equal(report.metrics.overCreditRate, 0);
  assert.equal(report.metrics.affectAsRewardFalsePositiveRate, 0);
  assert.equal(report.metrics.correctionForgettingRate, 0);
  assert.equal(report.metrics.invariantMutationRate, 0);
  assert.equal(report.metrics.boundedDeltaViolationRate, 0);
  assert.equal(report.automaticStateMutationAllowed, false);
});

test("Suzu Reward Credit Holdout v1 contains 84 frozen synthetic cases", () => {
  const validation = validateRewardCreditBenchmark(REWARD_CREDIT_HOLDOUT_V1, {
    expectedCaseCount: 84,
  });
  assert.equal(validation.version, "suzu-reward-credit-holdout-v1-rc1");
  assert.equal(Object.keys(validation.categories).length, 14);
  assert.deepEqual([...new Set(Object.values(validation.categories))], [6]);
});

test("the holdout fixture and prompts still match their pre-run frozen hashes", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(
    PACKAGE_ROOT,
    "resources/baselines/reward-credit-holdout-v1-rc1-manifest.json",
  ), "utf8"));
  assert.equal(manifest.purpose, "frozen-synthetic-fixture-integrity");
  assert.deepEqual(manifest.inputHashes, {
    fixtureSha256: sha256("fixtures/reward-credit-holdout-v1.mjs"),
    outcomePromptSha256: sha256("resources/reward-outcome-system-prompt.md"),
    targetPromptSha256: sha256("resources/reward-target-system-prompt.md"),
    creditPromptSha256: sha256("resources/reward-credit-system-prompt.md"),
  });
});

test("the deterministic oracle replays every holdout case through the real shadow pipeline", async () => {
  const report = await runRewardCreditBenchmark({
    benchmark: REWARD_CREDIT_HOLDOUT_V1,
    analyzersForCase: oracleAnalyzers,
  });
  assert.equal(report.selection.count, 84);
  assert.equal(report.processing.every((item) => item.status === "analyzed"), true);
  assert.equal(report.metrics.outcomeAccuracy, 1);
  assert.equal(report.metrics.evidenceTierAccuracy, 1);
  assert.equal(report.metrics.feedbackTargetAccuracy, 1);
  assert.equal(report.metrics.targetMemoryIdsExactRate, 1);
  assert.equal(report.metrics.memoryDecisionExactRate, 1);
  assert.equal(report.metrics.pathDecisionExactRate, 1);
  assert.equal(report.metrics.contributionClass.f1, 1);
  assert.equal(report.metrics.contributionShareMae, 0);
  assert.equal(report.metrics.conservativeDeferralRate, 0);
  assert.equal(report.metrics.overCreditRate, 0);
  assert.equal(report.metrics.affectAsRewardFalsePositiveRate, 0);
  assert.equal(report.metrics.correctionForgettingRate, 0);
  assert.equal(report.metrics.invariantMutationRate, 0);
  assert.equal(report.metrics.boundedDeltaViolationRate, 0);
  assert.equal(report.automaticStateMutationAllowed, false);
});
