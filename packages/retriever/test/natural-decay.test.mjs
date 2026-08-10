import assert from "node:assert/strict";
import test from "node:test";

import {
  buildNaturalDecayAdjustments,
  normalizeNaturalDecayOptions,
} from "../src/natural-decay.mjs";
import { DEFAULT_RETRIEVAL_OPTIONS } from "../src/retriever.mjs";
import { buildOrdinarySeedCandidates } from "../src/seed-routes.mjs";

const policy = normalizeNaturalDecayOptions({
  enabled: true,
  configurationVersion: "test-natural-decay-v2",
  floor: 0.25,
  scaleDays: 30,
  decayExponent: 0.5,
  maximumScoreReduction: 0.12,
});

test("natural decay follows a bounded power-law curve with a long tail", () => {
  const now = new Date("2027-01-01T00:00:00.000Z");
  const adjustments = buildNaturalDecayAdjustments([
    { id: "new", recorded_at: "2027-01-01T00:00:00.000Z" },
    { id: "half-life", recorded_at: "2026-10-03T00:00:00.000Z" },
    { id: "old", recorded_at: "2020-01-01T00:00:00.000Z" },
  ], now, policy);

  assert.equal(adjustments.get("new").value, 1);
  assert.equal(adjustments.get("new").scoreAdjustment, 0);
  assert.ok(Math.abs(adjustments.get("half-life").value - 0.625) < 1e-12);
  assert.ok(Math.abs(adjustments.get("half-life").scoreAdjustment + 0.06) < 1e-12);
  assert.equal(adjustments.get("half-life").model, "shifted-power-law");
  assert.ok(Math.abs(adjustments.get("half-life").equivalentHalfLifeDays - 90) < 1e-12);
  assert.ok(adjustments.get("old").value >= 0.25);
  assert.ok(adjustments.get("old").scoreAdjustment >= -0.12);
});

test("natural decay starts when the Agent learned the memory, not when it was stored", () => {
  const adjustment = buildNaturalDecayAdjustments([{
    id: "learned-yesterday",
    known_at: "2026-12-31T00:00:00.000Z",
    recorded_at: "2020-01-01T00:00:00.000Z",
  }], new Date("2027-01-01T00:00:00.000Z"), policy).get("learned-yesterday");

  assert.equal(adjustment.ageDays, 1);
  assert.equal(adjustment.timeBasis, "known_at");
  assert.equal(adjustment.referenceTime, "2026-12-31T00:00:00.000Z");
  assert.ok(adjustment.value > 0.98);
});

test("power-law calibration drops faster early and preserves more long-term access than exponential decay", () => {
  const now = new Date("2027-01-01T00:00:00.000Z");
  const adjustments = buildNaturalDecayAdjustments([
    { id: "day-30", recorded_at: "2026-12-02T00:00:00.000Z" },
    { id: "day-365", recorded_at: "2026-01-01T00:00:00.000Z" },
  ], now, policy);

  const normalizedDay30 = (adjustments.get("day-30").value - policy.floor)
    / (1 - policy.floor);
  const normalizedDay365 = (adjustments.get("day-365").value - policy.floor)
    / (1 - policy.floor);
  assert.ok(normalizedDay30 < 0.5 ** (30 / 90));
  assert.ok(normalizedDay365 > 0.5 ** (365 / 90));
});

test("natural decay ignores invalid timestamps and can be disabled independently", () => {
  assert.equal(buildNaturalDecayAdjustments([
    { id: "invalid", recorded_at: "not-a-time" },
  ], new Date(), policy).size, 0);
  assert.equal(normalizeNaturalDecayOptions({ enabled: false }).enabled, false);
});

test("natural decay reranks only after both memories pass the ordinary recall gate", () => {
  const now = new Date("2027-01-01T00:00:00.000Z");
  const nodes = [
    {
      id: "old",
      kind: "event",
      status: "active",
      title: "参观科技馆",
      content: "参观科技馆并看了机器人展。",
      recorded_at: "2026-01-01T00:00:00.000Z",
      confidence: 1,
      importance: 0.5,
    },
    {
      id: "new",
      kind: "event",
      status: "active",
      title: "参观科技馆",
      content: "参观科技馆并看了机器人展。",
      recorded_at: "2027-01-01T00:00:00.000Z",
      confidence: 1,
      importance: 0.5,
    },
  ];
  const candidates = buildOrdinarySeedCandidates({
    nodes,
    query: "参观科技馆",
    intent: "event",
    options: DEFAULT_RETRIEVAL_OPTIONS,
    naturalDecayAdjustments: buildNaturalDecayAdjustments(nodes, now, policy),
  });

  assert.deepEqual(candidates.map((candidate) => candidate.node.id), ["new", "old"]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].routeContributions["natural-decay"], 0);
  assert.ok(candidates[1].routeContributions["natural-decay"] < 0);
});
