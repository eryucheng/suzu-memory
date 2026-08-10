import assert from "node:assert/strict";
import test from "node:test";

import { parseRewardCreditGeneration } from "../src/reward-credit-contracts.mjs";

function row(overrides = {}) {
  return {
    memoryId: "memory-1",
    contributionClass: "uncertain",
    contributionShare: 0,
    contextKey: "problem-solving",
    confidence: 0.9,
    rationale: "虚构测试。",
    ...overrides,
  };
}

test("reward credit keeps uncertainty separate from nonzero contribution", () => {
  assert.throws(() => parseRewardCreditGeneration({
    analyses: [row({ contributionShare: 0.3 })],
  }, { expectedMemoryIds: ["memory-1"] }), /zero share/u);
  assert.throws(() => parseRewardCreditGeneration({
    analyses: [row({ contributionClass: "direct", contributionShare: 0 })],
  }, { expectedMemoryIds: ["memory-1"] }), /positive share/u);
  const parsed = parseRewardCreditGeneration({
    analyses: [row()],
  }, { expectedMemoryIds: ["memory-1"] });
  assert.equal(parsed.analyses[0].contributionShare, 0);
});
