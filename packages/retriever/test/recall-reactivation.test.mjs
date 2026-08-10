import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecallReactivationAdjustments,
  normalizeRecallReactivationOptions,
} from "../src/recall-reactivation.mjs";

test("recall reactivation produces a small bounded score boost that fades independently", () => {
  const policy = normalizeRecallReactivationOptions({
    enabled: true,
    configurationVersion: "test-recall-reactivation-v2",
    activationGain: 0.025,
    maximumActivation: 0.35,
    scaleDays: 10,
    decayExponent: 0.5,
    maximumScoreAdjustment: 0.03,
  });
  const states = [{
    memory_id: "memory-1",
    value: 0.025,
    activation_count: 1,
    policy_version: "test-recall-reactivation-v2",
    last_activated_at: "2026-08-01T00:00:00.000Z",
  }];
  const immediate = buildRecallReactivationAdjustments(
    states,
    new Date("2026-08-01T00:00:00.000Z"),
    policy,
  ).get("memory-1");
  assert.equal(immediate.value, 0.025);
  assert.ok(Math.abs(immediate.scoreAdjustment - (0.025 / 0.35) * 0.03) < 1e-12);
  assert.equal(immediate.model, "shifted-power-law");
  assert.ok(Math.abs(immediate.equivalentHalfLifeDays - 30) < 1e-12);

  const afterHalfLife = buildRecallReactivationAdjustments(
    states,
    new Date("2026-08-31T00:00:00.000Z"),
    policy,
  ).get("memory-1");
  assert.equal(afterHalfLife.value, 0.0125);
  assert.ok(
    Math.abs(afterHalfLife.scoreAdjustment - (0.0125 / 0.35) * 0.03) < 1e-12,
  );
});
