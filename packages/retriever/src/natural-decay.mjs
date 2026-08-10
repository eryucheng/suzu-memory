import {
  ACCESS_DECAY_MODEL,
  shiftedPowerLawHalfLifeDays,
  shiftedPowerLawRetention,
} from "@suzu-memory/core";

function clean(value) {
  return String(value ?? "").trim();
}

function finite(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${label} 必须是有限数字。`);
  return number;
}

function unit(value, label) {
  const number = finite(value, label);
  if (number < 0 || number > 1) throw new Error(`${label} 必须在 0 到 1 之间。`);
  return number;
}

function positive(value, label) {
  const number = finite(value, label);
  if (number <= 0) throw new Error(`${label} 必须大于 0。`);
  return number;
}

export function normalizeNaturalDecayOptions(value) {
  if (!value || value.enabled !== true) {
    return Object.freeze({ enabled: false, configurationVersion: "" });
  }
  const configurationVersion = clean(value.configurationVersion);
  if (!configurationVersion) throw new Error("自然衰退需要明确的 configurationVersion。");
  const floor = unit(value.floor, "naturalDecay.floor");
  if (floor >= 1) throw new Error("naturalDecay.floor 必须小于 1。");
  const scaleDays = positive(value.scaleDays, "naturalDecay.scaleDays");
  const decayExponent = positive(value.decayExponent, "naturalDecay.decayExponent");
  return Object.freeze({
    enabled: true,
    configurationVersion,
    model: ACCESS_DECAY_MODEL,
    floor,
    scaleDays,
    decayExponent,
    equivalentHalfLifeDays: shiftedPowerLawHalfLifeDays({ scaleDays, decayExponent }),
    maximumScoreReduction: unit(
      value.maximumScoreReduction,
      "naturalDecay.maximumScoreReduction",
    ),
  });
}

function ageFromNode(node, now) {
  const candidates = [
    ["known_at", node?.known_at],
    ["recorded_at", node?.recorded_at],
  ];
  for (const [timeBasis, value] of candidates) {
    const timestamp = new Date(value || "");
    if (!Number.isFinite(timestamp.getTime())) continue;
    return Object.freeze({
      ageDays: Math.max(0, (now.getTime() - timestamp.getTime()) / 86_400_000),
      referenceTime: timestamp.toISOString(),
      timeBasis,
    });
  }
  return null;
}

export function buildNaturalDecayAdjustments(nodes, now, policy) {
  if (!policy?.enabled) return new Map();
  const executionTime = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(executionTime.getTime())) throw new Error("自然衰退的 now 不是有效时间。");
  const adjustments = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const memoryId = clean(node?.id);
    const age = ageFromNode(node, executionTime);
    if (!memoryId || !age) continue;
    const retention = shiftedPowerLawRetention(age.ageDays, policy);
    const value = policy.floor + (1 - policy.floor) * retention;
    const reductionRatio = (1 - value) / (1 - policy.floor);
    const scoreReduction = Math.min(
      policy.maximumScoreReduction,
      Math.max(0, reductionRatio * policy.maximumScoreReduction),
    );
    adjustments.set(memoryId, Object.freeze({
      value,
      retention,
      ageDays: age.ageDays,
      referenceTime: age.referenceTime,
      timeBasis: age.timeBasis,
      floor: policy.floor,
      model: policy.model,
      scaleDays: policy.scaleDays,
      decayExponent: policy.decayExponent,
      equivalentHalfLifeDays: policy.equivalentHalfLifeDays,
      configurationVersion: policy.configurationVersion,
      scoreAdjustment: scoreReduction === 0 ? 0 : -scoreReduction,
    }));
  }
  return adjustments;
}

export function naturalDecayAudit(policy, {
  adjustedCandidateCount = 0,
  bypassedCandidateCount = 0,
} = {}) {
  if (!policy?.enabled) return Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: true,
    configurationVersion: policy.configurationVersion,
    model: policy.model,
    floor: policy.floor,
    scaleDays: policy.scaleDays,
    decayExponent: policy.decayExponent,
    equivalentHalfLifeDays: policy.equivalentHalfLifeDays,
    maximumScoreReduction: policy.maximumScoreReduction,
    adjustedCandidateCount: Math.max(0, Math.trunc(Number(adjustedCandidateCount) || 0)),
    bypassedCandidateCount: Math.max(0, Math.trunc(Number(bypassedCandidateCount) || 0)),
  });
}
