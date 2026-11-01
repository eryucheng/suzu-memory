import { invokeEvidenceAnalyzer, recordAnalyzerInvocations, priorAnalyzerRuns } from "./related-analyzer-batch.mjs";
import { modelCalendarFields } from '@suzu-memory/core';
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";


import {
  CAPABILITY_ANALYZERS,
  buildCapabilityGenerationInput,
  parseCapabilityGeneration,
} from "./capability-contracts.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");
const CAPABILITY_MEMORY_KINDS = new Set(["fact", "derived_hypothesis"]);

function clean(value) { return String(value ?? "").trim(); }
function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function stableBatchId({ agentId, subjectRole, subjectKey, canonicalKey, currentRepresentationLayer, memoryIds }) {
  const signature = [clean(agentId), clean(subjectRole), clean(subjectKey),
    clean(canonicalKey).toLocaleLowerCase("en-US"), clean(currentRepresentationLayer),
    uniqueStrings(memoryIds).sort().join("\u001f")]
    .join("\u001e");
  return `capability-analysis-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function currentStateView(repository, agentId, subjectRole, subjectKey, canonicalKey, representationLayer) {
  const current = repository.getCurrentCanonicalMemory({ agentId, subjectRole, subjectKey, canonicalKey,
    representationLayer, stateFamily: "capability" });
  if (!current) return null;
  if (!CAPABILITY_MEMORY_KINDS.has(current.kind)) {
    throw new Error("Capability canonicalKey currently resolves to a non-capability-compatible memory kind.");
  }
  return {
    id: current.id, kind: current.kind, content: String(current.content ?? ""),
    subjectRole: current.subject_role, subjectKey: current.subject_key,
    canonicalKey: current.canonical_key, representationLayer: current.representation_layer,
    temporalState: current.temporal_state,
    ...modelCalendarFields(current, ['knownAt', 'validFrom', 'validTo'], repository.listMemorySources(current.id)),
  };
}

function targetHasRole(memory, target, allowedRoles, { allowPrimary = true } = {}) {
  if (allowPrimary && memory.subjectRole === target.subjectRole && memory.subjectKey === target.subjectKey) return true;
  return memory.actorRoles.some((role) => allowedRoles.has(role.role)
    && role.actorRole === target.subjectRole && role.actorKey === target.subjectKey);
}

function assertSubjectBoundary(role, analysis, memory, target) {
  if (role === "holder-attribution" && analysis.attribution === "explicit_self_statement") {
    if (!targetHasRole(memory, target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("Explicit capability self statement requires the fixed subject as speaker.");
    }
    return;
  }
  if (role === "holder-attribution" && analysis.attribution === "direct_observation") {
    if (memory.evidenceMode !== "observed") {
      throw new Error("Direct capability observation requires an observed bounded memory.");
    }
    if (!targetHasRole(memory, target, new Set(["subject", "experiencer", "participant"]))) {
      throw new Error("Direct capability observation does not identify the fixed performer.");
    }
    return;
  }
  if (!targetHasRole(memory, target, new Set(["subject", "speaker", "participant", "experiencer"]))) {
    throw new Error("Capability analysis does not identify the fixed holder.");
  }
}

function enforceAnalysisBoundary(role, analysis, snapshot) {
  const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
  if (!memory) throw new Error("Capability analysis memory must come from the bounded snapshot.");
  const availableSourceIds = new Set(memory.sourceIds);
  if (analysis.sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Capability analysis source must directly support its selected memory.");
  }
  assertSubjectBoundary(role, analysis, memory, snapshot.target);
  if (role === "time-current-relation") {
    const hasCurrent = Boolean(snapshot.currentState);
    if (analysis.currentStatePresent !== hasCurrent) {
      throw new Error("Capability current-state presence does not match the read-only snapshot.");
    }
    if (hasCurrent && analysis.relation === "no_current_state") {
      throw new Error("Capability relation cannot omit an available current state.");
    }
    if (!hasCurrent && analysis.relation !== "no_current_state") {
      throw new Error("Capability relation invented a current state.");
    }
  }
  return analysis;
}



async function invokeAnalyzer(options) {
  return invokeEvidenceAnalyzer({ ...options, buildInput: buildCapabilityGenerationInput,
    parseGeneration: parseCapabilityGeneration, enforceBoundary: enforceAnalysisBoundary });
}

function byMemory(items) {
  return new Map((Array.isArray(items) ? items : []).map((item) => [item.memoryId, item]));
}

function capabilityGate({ skill, holder, performance, conditions, timeRelation, currentState }) {
  if (!skill) return { qualification: "unresolved", reason: "missing-capability-skill-analysis" };
  if (["none", "contextual"].includes(skill.targetMatch)) return { qualification: "excluded", reason: "memory-does-not-express-the-fixed-capability" };
  if (["unknown", "broader_category"].includes(skill.targetMatch) || !skill.skillLabel || !skill.scopeLabel) {
    return { qualification: "unresolved", reason: "capability-scope-is-not-exact-enough" };
  }
  if (!holder) return { qualification: "unresolved", reason: "missing-capability-holder-analysis" };
  if (holder.holderMatch === "no") return { qualification: "excluded", reason: "capability-belongs-to-another-holder" };
  if (holder.holderMatch === "unknown") return { qualification: "unresolved", reason: "capability-holder-unknown" };
  if (holder.attribution === "quoted_or_roleplay") return { qualification: "excluded", reason: "capability-is-quoted-or-roleplay" };
  if (!["explicit_self_statement", "direct_observation"].includes(holder.attribution)) {
    return { qualification: "unresolved", reason: "capability-is-not-direct-self-report-or-observation" };
  }

  if (!performance) return { qualification: "unresolved", reason: "missing-capability-performance-analysis" };
  if (["tool_availability", "interest_only", "no_capability"].includes(performance.evidenceType)) {
    return { qualification: "excluded", reason: "tool-interest-or-context-is-not-capability-evidence" };
  }
  if (performance.evidenceType === "training_or_instruction") {
    return { qualification: "unresolved", reason: "training-does-not-yet-prove-capability" };
  }
  if (performance.evidenceType === "unknown") return { qualification: "unresolved", reason: "capability-evidence-type-unknown" };
  if (performance.evidenceType === "demonstrated_result") {
    if (!["success", "partial"].includes(performance.outcome)) {
      return { qualification: "unresolved", reason: "demonstrated-result-has-no-successful-outcome" };
    }
  }
  if (performance.evidenceType === "failed_attempt") {
    if (performance.outcome !== "failure") return { qualification: "unresolved", reason: "failed-attempt-outcome-is-inconsistent" };
    if (["environment", "tool_failure", "external_constraint"].includes(performance.failureCause)) {
      return { qualification: "excluded", reason: "failure-does-not-demonstrate-a-skill-gap" };
    }
    if (performance.failureCause === "unknown") return { qualification: "unresolved", reason: "failure-cause-unknown" };
    if (performance.failureCause !== "skill_gap") return { qualification: "unresolved", reason: "failed-attempt-has-no-skill-gap" };
  }

  if (performance.evidenceType === "demonstrated_result") {
    if (!conditions) return { qualification: "unresolved", reason: "missing-capability-condition-analysis" };
    if (conditions.independence === "unknown") return { qualification: "unresolved", reason: "capability-independence-unknown" };
    if (["assisted", "tool_dependent"].includes(conditions.independence) && !conditions.dependencyLabel) {
      return { qualification: "unresolved", reason: "capability-dependency-is-missing" };
    }
    if (conditions.repeatability === "unknown") return { qualification: "unresolved", reason: "capability-repeatability-unknown" };
  }

  if (!timeRelation) return { qualification: "unresolved", reason: "missing-capability-time-relation-analysis" };
  if (timeRelation.stateTime === "future") return { qualification: "excluded", reason: "future-learning-is-not-current-capability" };
  if (timeRelation.stateTime === "unknown" || timeRelation.changeCue === "unknown") {
    return { qualification: "unresolved", reason: "capability-time-or-change-unknown" };
  }
  if (Boolean(currentState) !== timeRelation.currentStatePresent) {
    return { qualification: "unresolved", reason: "capability-current-state-presence-conflict" };
  }
  if (timeRelation.relation === "unknown") return { qualification: "unresolved", reason: "capability-current-relation-unknown" };
  if (currentState && timeRelation.relation === "unrelated") {
    return { qualification: "excluded", reason: "capability-is-unrelated-to-current-canonical-state" };
  }
  if (currentState
    && ["narrows", "broadens", "proficiency_up", "proficiency_down", "same_scope_conflict", "retires"].includes(timeRelation.relation)
    && ["none", "unknown"].includes(timeRelation.scopeOverlap)) {
    return { qualification: "unresolved", reason: "capability-scope-overlap-is-not-proven" };
  }
  if (timeRelation.relation === "proficiency_up" && timeRelation.changeCue !== "improved") {
    return { qualification: "unresolved", reason: "capability-upgrade-needs-improvement-evidence" };
  }
  if (timeRelation.relation === "retires" && timeRelation.changeCue !== "lost") {
    return { qualification: "unresolved", reason: "capability-retirement-needs-explicit-loss" };
  }
  return null;
}

function directionFor(performance, timeRelation, currentState) {
  if (performance?.evidenceType === "failed_attempt" && performance.failureCause === "skill_gap") return "opposition";
  if (!currentState || timeRelation?.relation === "no_current_state") return "support";
  if (["narrows", "proficiency_down", "same_scope_conflict", "retires"].includes(timeRelation?.relation)) return "opposition";
  if (["unrelated", "unknown"].includes(timeRelation?.relation)) return "neutral";
  return "support";
}

function signalFor(performance, conditions) {
  if (performance?.evidenceType === "failed_attempt" && performance.failureCause === "skill_gap") return "capability_skill_gap_counter";
  if (performance?.evidenceType === "self_report") return "capability_claim";
  if (performance?.evidenceType === "demonstrated_result") {
    return conditions?.independence === "independent" ? "capability_demonstrated_result" : "capability_assisted_result";
  }
  return `capability_${performance?.evidenceType || "unknown"}`;
}

function actionPreview({ qualification, performance, timeRelation, currentState }) {
  const base = { action: "no_conclusion", proposedKind: "derived_hypothesis",
    reason: qualification === "qualified" ? "no-safe-capability-action" : "evidence-not-qualified",
    automaticStateWriteAllowed: false };
  if (qualification !== "qualified" || !performance || !timeRelation) return base;
  if (["historical", "future"].includes(timeRelation.stateTime)) {
    return { ...base, reason: "non-current-capability-evidence-does-not-change-current-state" };
  }
  if (!currentState) return { ...base, action: "accumulate_evidence", reason: "single-capability-evidence-needs-later-canonical-aggregation" };
  return {
    no_current_state: base,
    equivalent: { ...base, action: "reinforce", reason: "same-capability-evidence-supports-current-state" },
    supports: { ...base, action: "reinforce", reason: "new-evidence-supports-current-capability" },
    narrows: { ...base, action: "narrow_scope", reason: "evidence-narrows-current-capability-scope" },
    broadens: { ...base, action: "review_required", reason: "broader-capability-scope-needs-review" },
    proficiency_up: { ...base, action: "review_required", reason: "higher-proficiency-claim-needs-aggregate-review" },
    proficiency_down: { ...base, action: "review_required", reason: "one-counterexample-cannot-directly-downgrade-capability" },
    same_scope_conflict: { ...base, action: "contradict", reason: "same-scope-capability-conflict" },
    retires: { ...base, action: "retire", reason: "subject-directly-reports-capability-loss" },
    unrelated: base,
    unknown: base,
  }[timeRelation.relation] || base;
}

function mergeCapabilityAnalyses({ evaluation, persistEvidenceLedger }) {
  const maps = Object.fromEntries(Object.entries(evaluation.analyses).map(([key, items]) => [key, byMemory(items)]));
  const memoryIds = uniqueStrings(Object.values(evaluation.analyses).flat().map((item) => item.memoryId));
  const observations = [];
  const previews = [];
  for (const memoryId of memoryIds) {
    if (Object.entries(maps).some(([key, map]) => !map.has(memoryId)
      && !(key === "independenceConditions" && maps.performanceEvidence?.get(memoryId)?.evidenceType === "self_report"))) continue;
    const memory = evaluation.snapshot.memories.find((item) => item.id === memoryId);
    const skill = maps.skillGrounding?.get(memoryId) || null;
    const holder = maps.holderAttribution?.get(memoryId) || null;
    const performance = maps.performanceEvidence?.get(memoryId) || null;
    const conditions = maps.independenceConditions?.get(memoryId) || null;
    const timeRelation = maps.timeCurrentRelation?.get(memoryId) || null;
    const gate = capabilityGate({ skill, holder, performance, conditions, timeRelation,
      currentState: evaluation.snapshot.currentState });
    const qualification = gate?.qualification || "qualified";
    const claimedDirection = directionFor(performance, timeRelation, evaluation.snapshot.currentState);
    const analyses = [skill, holder, performance,
      ...(performance?.evidenceType === "demonstrated_result" ? [conditions] : []), timeRelation].filter(Boolean);
    const sourceIds = uniqueStrings(analyses.flatMap((item) => item.sourceIds)).sort();
    const analysisRunIds = Object.entries(maps).filter(([, map]) => map.has(memoryId))
      .map(([key]) => evaluation.runs[key]).filter((run) => run?.status === "completed")
      .map((run) => run.id).sort();
    let observation = null;
    if (persistEvidenceLedger && sourceIds.length && analysisRunIds.length) {
      observation = evaluation.repository.recordStateEvidenceObservation({
        agentId: evaluation.snapshot.agentId, batchId: evaluation.batchId, stateFamily: "capability",
        subjectRole: evaluation.snapshot.target.subjectRole, subjectKey: evaluation.snapshot.target.subjectKey,
        canonicalKey: evaluation.snapshot.target.canonicalKey, memoryId,
        evidenceGroupId: memory.evidenceGroupId, contextId: memory.contextId,
        signal: signalFor(performance, conditions), claimedDirection,
        effectiveDirection: qualification === "qualified" ? claimedDirection : "neutral",
        qualification, confidence: Math.min(...analyses.map((item) => item.confidence)), origin: "llm",
        scope: {
          capabilityLabel: evaluation.snapshot.target.capabilityLabel,
          targetMatch: skill?.targetMatch || "unknown", scopeLabel: skill?.scopeLabel || "",
          taskDifficulty: skill?.taskDifficulty || "unknown", evidenceType: performance?.evidenceType || "unknown",
          outcome: performance?.outcome || "unknown", proficiencyClaim: performance?.proficiencyClaim || "unknown",
          independence: conditions?.independence || "unknown", dependencyLabel: conditions?.dependencyLabel || "",
          repeatability: conditions?.repeatability || "unknown", conditionLabel: conditions?.conditionLabel || "",
          stateTime: timeRelation?.stateTime || "unknown", currentRelation: timeRelation?.relation || "unknown",
          scopeOverlap: timeRelation?.scopeOverlap || "unknown",
          currentRepresentationLayer: evaluation.snapshot.target.currentRepresentationLayer,
        },
        payloadSchemaVersion: "capability-merged-evidence-v1",
        payload: { skill, holder, performance, conditions, timeRelation }, excludedReason: gate?.reason || "",
        sourceIds, analysisRunIds, observedAt: memory.eventStart || memory.eventDate || memory.knownAt,
      });
      observations.push(observation);
    }
    previews.push({ memoryId, observationId: observation?.id || "", qualification,
      gateReason: gate?.reason || "", ...actionPreview({ qualification, performance, timeRelation,
        currentState: evaluation.snapshot.currentState }) });
  }
  return { observations, previews };
}

export async function evaluateCapabilityEvidence({
  repository, agentId, subjectRole, subjectKey, canonicalKey, capabilityLabel,
  memoryIds = [], analyzers = {}, usageLedgerPath = "", promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {}, maximumAnalyses = Infinity, persistEvidenceLedger = true,
  currentRepresentationLayer = "",
} = {}) {
  if (!repository) throw new Error("Capability evaluation requires a repository.");
  if (clean(subjectRole) === "shared") throw new Error("Capability evaluation currently requires an individual fixed subject.");
  if (!clean(capabilityLabel)) throw new Error("Capability evaluation requires a readable capabilityLabel.");
  for (const key of Object.keys(CAPABILITY_ANALYZERS)) {
    if (typeof analyzers[key] !== "function") throw new Error(`Capability evaluation requires analyzers.${key}.`);
  }
  const normalizedMemoryIds = uniqueStrings(memoryIds);
  const batchId = stableBatchId({ agentId, subjectRole, subjectKey, canonicalKey,
    currentRepresentationLayer, memoryIds: normalizedMemoryIds });
  const baseSnapshot = buildPreferenceEvidenceSnapshot({ repository, agentId, subjectRole, subjectKey,
    canonicalKey, memoryIds: normalizedMemoryIds, ...snapshotOptions });
  const snapshot = {
    ...baseSnapshot, agentId: clean(agentId),
    target: { ...baseSnapshot.target, stateFamily: "capability", capabilityLabel: clean(capabilityLabel),
      currentRepresentationLayer: clean(currentRepresentationLayer) },
    currentState: currentStateView(repository, clean(agentId), baseSnapshot.target.subjectRole,
      baseSnapshot.target.subjectKey, baseSnapshot.target.canonicalKey, clean(currentRepresentationLayer)),
    inputPolicy: { ...baseSnapshot.inputPolicy, currentStateIsReadOnly: true,
      currentStateLayerIsFixedByCaller: Boolean(clean(currentRepresentationLayer)),
      modelCanChooseStateAction: false, oneResultCannotCreateStableCapability: true,
      dependenciesMustBePreserved: true },
  };
  snapshotOptions.prepareStateSnapshot?.(snapshot);
  const snapshotLimit = Math.min(250_000, Math.max(4_000,
    Math.trunc(Number(snapshotOptions.maxSnapshotChars) || 64_000)));
  if (JSON.stringify(snapshot).length > snapshotLimit) {
    throw new Error(`Capability evidence snapshot exceeds the ${snapshotLimit}-character privacy budget.`);
  }
  if (!snapshot.memories.length) return {
    status: "skipped", reason: "no-eligible-memories-with-direct-sources", batchId, snapshot,
    runs: {}, analyses: {}, rejected: {}, observations: [], actionPreviews: [], failedRoles: [],
    warnings: [], automaticStateWriteAllowed: false,
  };

  const definitions = Object.entries(CAPABILITY_ANALYZERS);
  const previousRuns = priorAnalyzerRuns(repository, snapshot, batchId, definitions, snapshotOptions);
  const invocations = await Promise.all(definitions.map(async ([key, definition]) => [key,
    await invokeAnalyzer({ definition, generator: analyzers[key], snapshot, promptDirectory, maximumAnalyses, previousRuns })]));
  const { runs, analyses, rejected, warnings, failedRoles } = await recordAnalyzerInvocations({
    repository, agentId, batchId, stateFamily: 'capability', snapshot, invocations, usageLedgerPath,
    metadata: { capabilityLabel: clean(capabilityLabel), currentRepresentationLayer: clean(currentRepresentationLayer), automaticStateWriteAllowed: false },
  });
  const evaluation = { repository, batchId, snapshot, runs, analyses };
  const merged = repository.transaction(() => mergeCapabilityAnalyses({ evaluation, persistEvidenceLedger }));
  const requiredFailedRoles = failedRoles.filter(key => key !== "independenceConditions"
    || snapshot.memories.some(memory => analyses.performanceEvidence.find(item => item.memoryId === memory.id)?.evidenceType !== "self_report"));
  const hasAnyAnalysis = Object.values(analyses).some((items) => items.length);
  return {
    status: requiredFailedRoles.length ? "incomplete" : hasAnyAnalysis ? "analyzed" : "abstained",
    reason: requiredFailedRoles.length ? "required-capability-analyzer-failed-or-rejected" : "",
    batchId, snapshot, runs, analyses, rejected, observations: merged.observations,
    actionPreviews: merged.previews, failedRoles, warnings, automaticStateWriteAllowed: false,
  };
}
