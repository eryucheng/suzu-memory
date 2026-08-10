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

export function normalizeRecallReactivationOptions(value) {
  if (!value || value.enabled !== true) {
    return Object.freeze({ enabled: false, configurationVersion: "" });
  }
  const configurationVersion = clean(value.configurationVersion);
  if (!configurationVersion) throw new Error("回忆再激活需要明确的 configurationVersion。");
  const activationGain = unit(value.activationGain, "recallReactivation.activationGain");
  if (!(activationGain > 0)) {
    throw new Error("recallReactivation.activationGain 必须大于 0。");
  }
  const maximumActivation = unit(
    value.maximumActivation,
    "recallReactivation.maximumActivation",
  );
  if (!(maximumActivation > 0)) {
    throw new Error("recallReactivation.maximumActivation 必须大于 0。");
  }
  if (activationGain > maximumActivation) {
    throw new Error("recallReactivation.activationGain 不能大于 maximumActivation。");
  }
  const scaleDays = positive(value.scaleDays, "recallReactivation.scaleDays");
  const decayExponent = positive(
    value.decayExponent,
    "recallReactivation.decayExponent",
  );
  return Object.freeze({
    enabled: true,
    configurationVersion,
    model: ACCESS_DECAY_MODEL,
    activationGain,
    maximumActivation,
    scaleDays,
    decayExponent,
    equivalentHalfLifeDays: shiftedPowerLawHalfLifeDays({ scaleDays, decayExponent }),
    maximumScoreAdjustment: unit(
      value.maximumScoreAdjustment,
      "recallReactivation.maximumScoreAdjustment",
    ),
  });
}

export function buildRecallReactivationAdjustments(states, now, policy) {
  if (!policy?.enabled) return new Map();
  const executionTime = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(executionTime.getTime())) {
    throw new Error("回忆再激活的 now 不是有效时间。");
  }
  const adjustments = new Map();
  for (const state of Array.isArray(states) ? states : []) {
    const memoryId = clean(state?.memory_id);
    if (!memoryId || clean(state?.policy_version) !== policy.configurationVersion) continue;
    const lastActivatedAt = new Date(state?.last_activated_at || "");
    if (!Number.isFinite(lastActivatedAt.getTime())) continue;
    const ageDays = Math.max(
      0,
      (executionTime.getTime() - lastActivatedAt.getTime()) / 86_400_000,
    );
    const storedValue = Math.min(
      policy.maximumActivation,
      unit(state.value, "recall reactivation value"),
    );
    const retention = shiftedPowerLawRetention(ageDays, policy);
    const value = storedValue * retention;
    adjustments.set(memoryId, Object.freeze({
      value,
      storedValue,
      retention,
      ageDays,
      activationCount: Math.max(0, Math.trunc(Number(state.activation_count) || 0)),
      lastActivatedAt: lastActivatedAt.toISOString(),
      policyVersion: clean(state.policy_version),
      configurationVersion: policy.configurationVersion,
      model: policy.model,
      scaleDays: policy.scaleDays,
      decayExponent: policy.decayExponent,
      equivalentHalfLifeDays: policy.equivalentHalfLifeDays,
      maximumActivation: policy.maximumActivation,
      scoreAdjustment: (value / policy.maximumActivation)
        * policy.maximumScoreAdjustment,
    }));
  }
  return adjustments;
}

export function recallReactivationAudit(policy, {
  loadedStateCount = 0,
  adjustedCandidateCount = 0,
} = {}) {
  if (!policy?.enabled) return Object.freeze({ enabled: false });
  return Object.freeze({
    enabled: true,
    configurationVersion: policy.configurationVersion,
    model: policy.model,
    activationGain: policy.activationGain,
    maximumActivation: policy.maximumActivation,
    scaleDays: policy.scaleDays,
    decayExponent: policy.decayExponent,
    equivalentHalfLifeDays: policy.equivalentHalfLifeDays,
    maximumScoreAdjustment: policy.maximumScoreAdjustment,
    loadedStateCount: Math.max(0, Math.trunc(Number(loadedStateCount) || 0)),
    adjustedCandidateCount: Math.max(0, Math.trunc(Number(adjustedCandidateCount) || 0)),
  });
}
