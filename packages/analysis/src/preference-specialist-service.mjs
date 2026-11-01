import { preferenceEvidenceMemoryIds } from './preference-specialist-merge.mjs';
import { invokeEvidenceAnalyzer, recordAnalyzerInvocations } from './related-analyzer-batch.mjs';
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";


import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";
import {
  buildPreferenceSpecialistGenerationInput,
  parsePreferenceSpecialistGeneration,
  PREFERENCE_SPECIALIST_ANALYZERS,
} from "./preference-specialist-contracts.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");

function clean(value) {
  return String(value ?? "").trim();
}

function stableBatchId({ agentId, subjectRole, subjectKey, canonicalKey, memoryIds }) {
  const signature = [
    clean(agentId),
    clean(subjectRole),
    clean(subjectKey),
    clean(canonicalKey).toLocaleLowerCase("en-US"),
    [...new Set(memoryIds.map(clean).filter(Boolean))].sort().join("\u001f"),
  ].join("\u001e");
  return `preference-specialists-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function targetHasRole(memory, target, allowedRoles, { allowPrimary = true } = {}) {
  if (allowPrimary
    && memory.subjectRole === target.subjectRole
    && memory.subjectKey === target.subjectKey) return true;
  return memory.actorRoles.some((role) => (
    allowedRoles.has(role.role)
    && role.actorRole === target.subjectRole
    && role.actorKey === target.subjectKey
  ));
}

function assertRoleBoundary(role, analysis, memory, target) {
  if (role === "explicit-expression") {
    if (analysis.directness === "explicit_self_statement"
      && !targetHasRole(memory, target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("An explicit self statement requires the fixed subject as speaker.");
    }
    if (analysis.directness === "explicit_reported_statement"
      && !targetHasRole(memory, target, new Set(["preference_holder", "subject"]))) {
      throw new Error("A reported expression does not identify the fixed subject as its holder.");
    }
    return;
  }
  if (role === "behavior-conditions") {
    if (!targetHasRole(memory, target, new Set(["subject", "experiencer"]))) {
      throw new Error("Behavior analysis does not identify the fixed subject as experiencer.");
    }
    return;
  }
  if (role === "sharing-affect") {
    if (!targetHasRole(memory, target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("Sharing analysis requires the fixed subject as speaker.");
    }
    return;
  }
  if (!targetHasRole(memory, target, new Set([
    "subject", "experiencer", "speaker", "observer", "participant",
    "belief_holder", "preference_holder",
  ]))) {
    throw new Error("Time and scope analysis does not identify the fixed subject.");
  }
}

function enforceSpecialistBoundary(role, analysis, snapshot) {
  const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
  if (!memory) throw new Error("Specialist analysis memory must come from the bounded snapshot.");
  const availableSourceIds = new Set(memory.sourceIds);
  if (analysis.sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Specialist analysis source must directly support its selected memory.");
  }
  assertRoleBoundary(role, analysis, memory, snapshot.target);
  return analysis;
}



async function invokeAnalyzer(options) {
  return invokeEvidenceAnalyzer({ ...options,
    buildInput: (snapshot, definition) => buildPreferenceSpecialistGenerationInput(snapshot, definition.role),
    parseGeneration: parsePreferenceSpecialistGeneration, enforceBoundary: enforceSpecialistBoundary });
}

export async function evaluatePreferenceEvidenceSpecialists({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  objectLabel,
  memoryIds = [],
  analyzers = {},
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {},
  maximumAnalyses = Infinity,
} = {}) {
  if (!repository) throw new Error("Preference specialist evaluation requires a repository.");
  if (!clean(objectLabel)) {
    throw new Error("Preference specialist evaluation requires a readable objectLabel.");
  }
  const definitions = Object.entries(PREFERENCE_SPECIALIST_ANALYZERS);
  for (const [key] of definitions) {
    if (typeof analyzers[key] !== "function") {
      throw new Error(`Preference specialist evaluation requires analyzers.${key}.`);
    }
  }
  const normalizedMemoryIds = [...new Set(
    (Array.isArray(memoryIds) ? memoryIds : []).map(clean).filter(Boolean),
  )];
  const batchId = stableBatchId({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    memoryIds: normalizedMemoryIds,
  });
  const baseSnapshot = buildPreferenceEvidenceSnapshot({
    repository,
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    memoryIds: normalizedMemoryIds,
    ...snapshotOptions,
  });
  const snapshot = {
    ...baseSnapshot,
    agentId: clean(agentId),
    target: { ...baseSnapshot.target, objectLabel: clean(objectLabel) },
  };
  snapshotOptions.prepareStateSnapshot?.(snapshot);
  if (!snapshot.memories.length) {
    return {
      status: "skipped",
      reason: "no-eligible-memories-with-direct-sources",
      batchId,
      snapshot,
      runs: {},
      analyses: {},
      rejected: {},
      warnings: [],
      automaticMemoryWriteAllowed: false,
    };
  }
  const previousRuns = snapshotOptions.reuseAnalysisRuns
    ? repository.listStateAnalysisRuns(snapshot.agentId, { stateFamily: 'preference', batchId,
      limit: definitions.length * 3 }) : [];
  const invocations = await Promise.all(definitions.map(([key, definition]) => invokeAnalyzer({
    definition,
    generator: analyzers[key],
    snapshot,
    promptDirectory,
    maximumAnalyses, previousRuns,
  }).then((result) => [key, result])));
  const { runs, analyses, rejected, warnings, failedRoles } = await recordAnalyzerInvocations({
    repository, agentId, batchId, stateFamily: 'preference', snapshot, invocations, usageLedgerPath,
    metadata: key => ({ specialistKey: key, automaticMemoryWriteAllowed: false }),
  });
  const completeMemoryIds = preferenceEvidenceMemoryIds({ snapshot, analyses, runs });
  const hasAnyAnalysis = Object.values(analyses).some((items) => items.length);
  const status = failedRoles.length ? (completeMemoryIds.length ? "partial" : "incomplete")
    : hasAnyAnalysis ? "analyzed" : "abstained";
  return {
    status,
    reason: status === "incomplete" ? "required-specialist-failed-or-rejected"
      : status === "partial" ? "partial-specialist-results-unavailable" : "",
    batchId,
    snapshot,
    runs,
    analyses,
    rejected,
    failedRoles,
    warnings,
    automaticMemoryWriteAllowed: false,
  };
}
