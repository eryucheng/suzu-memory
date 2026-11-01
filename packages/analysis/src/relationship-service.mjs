import { invokeEvidenceAnalyzer, recordAnalyzerInvocations } from './related-analyzer-batch.mjs';
import { modelCalendarFields } from '@suzu-memory/core';
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";


import {
  RELATIONSHIP_ANALYZERS,
  buildRelationshipGenerationInput,
  isCounterpartRelationshipStatement,
  parseRelationshipGeneration,
} from "./relationship-contracts.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");
const RELATIONSHIP_SCOPED_TYPES = new Set(["boundary", "permission"]);

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function sameActor(leftRole, leftKey, rightRole, rightKey) {
  return clean(leftRole) === clean(rightRole) && clean(leftKey) === clean(rightKey);
}

function stableBatchId({
  agentId,
  subjectRole,
  subjectKey,
  counterpartRole,
  counterpartKey,
  canonicalKey,
  currentRepresentationLayer,
  relationshipDimension,
  memoryIds,
}) {
  const signature = [
    clean(agentId),
    clean(subjectRole),
    clean(subjectKey),
    clean(counterpartRole),
    clean(counterpartKey),
    clean(canonicalKey).toLocaleLowerCase("en-US"),
    clean(currentRepresentationLayer),
    clean(relationshipDimension),
    uniqueStrings(memoryIds).sort().join("\u001f"),
  ].join("\u001e");
  return `relationship-analysis-${createHash("sha256").update(signature).digest("hex").slice(0, 24)}`;
}

function currentStateView(
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  representationLayer = "",
) {
  const current = repository.getCurrentCanonicalMemory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer,
    stateFamily: "relationship",
  });
  if (!current) return null;
  if (current.kind !== "relationship") {
    throw new Error("Relationship canonicalKey currently resolves to a non-relationship memory kind.");
  }
  return {
    id: current.id,
    kind: current.kind,
    content: String(current.content ?? ""),
    subjectRole: current.subject_role,
    subjectKey: current.subject_key,
    canonicalKey: current.canonical_key,
    representationLayer: current.representation_layer,
    temporalState: current.temporal_state,
    ...modelCalendarFields(current, ['knownAt', 'validFrom', 'validTo'], repository.listMemorySources(current.id)),
  };
}

function memoryHasActor(memory, actor, allowedRoles, { allowPrimary = true } = {}) {
  if (allowPrimary
    && memory.subjectRole === actor.subjectRole
    && memory.subjectKey === actor.subjectKey) return true;
  return memory.actorRoles.some((role) => (
    allowedRoles.has(role.role)
    && role.actorRole === actor.subjectRole
    && role.actorKey === actor.subjectKey
  ));
}

function assertRelationshipActors(role, analysis, memory, target, counterpart) {
  if (role === "perspective-direction" && analysis.attribution === "explicit_self_statement") {
    if (!memoryHasActor(memory, target, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("Explicit relationship self statement requires the fixed holder as speaker.");
    }
  } else if (role === "perspective-direction" && analysis.attribution === "explicit_counterpart_statement") {
    if ((analysis.direction !== "unknown" && !isCounterpartRelationshipStatement(analysis))
      || !memoryHasActor(memory, counterpart, new Set(["speaker"]), { allowPrimary: false })) {
      throw new Error("Explicit counterpart statement requires the counterpart as speaker and a reverse or pair-directed claim.");
    }
  } else if (!memoryHasActor(
    memory,
    target,
    new Set(["subject", "speaker", "participant", "experiencer"]),
  ) && !(memory.kind === "utterance" && role !== "perspective-direction"
    && memoryHasActor(memory, counterpart, new Set(["speaker"]), { allowPrimary: false }))) {
    throw new Error("Relationship analysis does not identify the fixed holder or a counterpart context statement.");
  }

  // Raw utterances record speakers and observed participants, not every person
  // mentioned. The fixed counterpart must be grounded in the bounded source by
  // the perspective analyzer, including when it is the memory owner.
  if (role === "perspective-direction" && analysis.counterpartMatch === "yes"
    && memory.kind !== "utterance"
    && counterpart.subjectRole !== "other"
    && !memoryHasActor(
      memory,
      counterpart,
      new Set(["subject", "speaker", "participant", "experiencer", "observer"]),
    )) {
    throw new Error("Relationship analysis claims a counterpart absent from the bounded memory roles.");
  }
}

function enforceAnalysisBoundary(role, analysis, snapshot) {
  const memory = snapshot.memories.find((item) => item.id === analysis.memoryId);
  if (!memory) throw new Error("Relationship analysis memory must come from the bounded snapshot.");
  const availableSourceIds = new Set(memory.sourceIds);
  if (analysis.sourceIds.some((sourceId) => !availableSourceIds.has(sourceId))) {
    throw new Error("Relationship analysis source must directly support its selected memory.");
  }
  assertRelationshipActors(
    role,
    analysis,
    memory,
    snapshot.target,
    snapshot.counterpart,
  );
  if (role === "current-relation") {
    const hasCurrent = Boolean(snapshot.currentState);
    if (analysis.currentStatePresent !== hasCurrent) {
      throw new Error("Relationship current-state presence does not match the read-only snapshot.");
    }
    const comparison = snapshot.relationshipComparison;
    const hasComparison = comparison && comparison.memoryId !== memory.id;
    if (hasComparison
      ? analysis.comparisonMemoryId !== comparison.memoryId || analysis.comparisonRelation === "no_comparison"
      : analysis.comparisonMemoryId || analysis.comparisonRelation !== "no_comparison") {
      throw new Error("Relationship peer comparison does not match the fixed evidence reference.");
    }
    if (hasCurrent && analysis.relation === "no_current_state") {
      throw new Error("Relationship relation cannot omit an available current state.");
    }
    if (!hasCurrent && analysis.relation !== "no_current_state") {
      throw new Error("Relationship relation invented a current state.");
    }
  }
  return analysis;
}



async function invokeAnalyzer(options) {
  return invokeEvidenceAnalyzer({ ...options, buildInput: buildRelationshipGenerationInput,
    parseGeneration: parseRelationshipGeneration, enforceBoundary: (role, item, snapshot) => {
      const bounded = enforceAnalysisBoundary(role, item, snapshot);
      if (role === 'relation-grounding' && snapshot.target.relationshipDimension
        && bounded.relationType !== snapshot.target.relationshipDimension) return null;
      return bounded;
    } });
}

function byMemory(items) {
  return new Map((Array.isArray(items) ? items : []).map((item) => [item.memoryId, item]));
}

function relationshipGate({ grounding, perspective, scopeTime, relation, currentState }) {
  if (!grounding) return { qualification: "unresolved", reason: "missing-relationship-grounding-analysis" };
  if (["none", "contextual"].includes(grounding.targetMatch)) {
    return { qualification: "excluded", reason: "memory-does-not-express-the-fixed-relationship" };
  }
  if (["unknown", "broader_category"].includes(grounding.targetMatch)) {
    return { qualification: "unresolved", reason: "relationship-target-is-not-exact-enough" };
  }
  if (grounding.polarity === "no_relation") {
    return { qualification: "excluded", reason: "memory-does-not-express-a-relationship" };
  }
  if (grounding.relationType === "unknown"
    || grounding.polarity === "unknown"
    || !grounding.relationLabel) {
    return { qualification: "unresolved", reason: "relationship-proposition-is-unknown" };
  }
  if (RELATIONSHIP_SCOPED_TYPES.has(grounding.relationType) && !grounding.scopeLabel) {
    return { qualification: "unresolved", reason: "relationship-scope-is-required" };
  }
  if (grounding.polarity === "conditional" && !grounding.conditionLabel) {
    return { qualification: "unresolved", reason: "conditional-relationship-needs-a-condition" };
  }

  if (!perspective) return { qualification: "unresolved", reason: "missing-relationship-perspective-analysis" };
  if (perspective.holderMatch === "no") {
    return { qualification: "excluded", reason: "relationship-belongs-to-another-holder" };
  }
  if (perspective.counterpartMatch === "no") {
    return { qualification: "excluded", reason: "relationship-points-to-another-counterpart" };
  }
  if (perspective.holderMatch === "unknown" || perspective.counterpartMatch === "unknown") {
    return { qualification: "unresolved", reason: "relationship-holder-or-counterpart-unknown" };
  }
  if (perspective.attribution === "quoted_or_roleplay") {
    return { qualification: "excluded", reason: "relationship-is-quoted-or-roleplay" };
  }
  if (perspective.direction === "counterpart_to_holder") {
    return { qualification: "excluded", reason: "relationship-direction-is-reversed" };
  }
  if (perspective.attribution !== "explicit_self_statement") {
    return { qualification: "unresolved", reason: "relationship-is-not-the-holder-direct-expression" };
  }
  if (!["holder_to_counterpart", "mutual_claim", "about_pair"].includes(perspective.direction)) {
    return { qualification: "unresolved", reason: "relationship-direction-is-unknown" };
  }

  if (!scopeTime) return { qualification: "unresolved", reason: "missing-relationship-time-analysis" };
  if (scopeTime.stateTime === "future") {
    return { qualification: "excluded", reason: "future-relationship-does-not-establish-current-state" };
  }
  if (scopeTime.stateTime === "unknown" || scopeTime.duration === "unknown") {
    return { qualification: "unresolved", reason: "relationship-time-or-duration-unknown" };
  }

  if (!relation) return { qualification: "unresolved", reason: "missing-relationship-current-relation-analysis" };
  if (Boolean(currentState) !== relation.currentStatePresent) {
    return { qualification: "unresolved", reason: "relationship-current-state-presence-conflict" };
  }
  if (relation.relation === "unknown") {
    return { qualification: "unresolved", reason: "relationship-current-relation-unknown" };
  }
  if (currentState && relation.relation === "unrelated") {
    return { qualification: "excluded", reason: "relationship-is-unrelated-to-current-canonical-state" };
  }
  if (relation.relation === "revokes") {
    if (!currentState
      || grounding.polarity !== "withdraws"
      || scopeTime.revocationCue !== "explicit"
      || relation.scopeOverlap !== "exact") {
      return { qualification: "unresolved", reason: "relationship-revocation-is-not-explicit-and-exact" };
    }
  }
  if (currentState
    && RELATIONSHIP_SCOPED_TYPES.has(grounding.relationType)
    && ["narrows", "broadens", "same_scope_conflict", "replaces"].includes(relation.relation)
    && ["none", "unknown"].includes(relation.scopeOverlap)) {
    return { qualification: "unresolved", reason: "relationship-scope-overlap-is-not-proven" };
  }
  return null;
}

function directionFor(relation, currentState) {
  if (!currentState || relation?.relation === "no_current_state") return "support";
  if (["narrows", "same_scope_conflict", "revokes", "replaces"].includes(relation?.relation)) {
    return "opposition";
  }
  if (["unrelated", "unknown"].includes(relation?.relation)) return "neutral";
  return "support";
}

function signalFor(grounding, relation) {
  if (relation?.relation === "revokes" || grounding?.polarity === "withdraws") {
    return "relationship_revoked";
  }
  const relationType = grounding?.relationType || "unknown";
  if (grounding?.polarity === "denies") return `relationship_${relationType}_denied`;
  return `relationship_${relationType}`;
}

function actionPreview({ qualification, scopeTime, relation, currentState }) {
  const base = {
    action: "no_conclusion",
    proposedKind: "relationship",
    reason: qualification === "qualified" ? "no-safe-relationship-action" : "evidence-not-qualified",
    automaticStateWriteAllowed: false,
  };
  if (qualification !== "qualified" || !scopeTime || !relation) return base;
  if (scopeTime.stateTime === "historical") {
    return { ...base, reason: "historical-relationship-does-not-change-current-state" };
  }
  if (scopeTime.duration === "ended"
    && !["revokes", "replaces"].includes(relation.relation)) {
    return { ...base, reason: "ended-relationship-without-revocation-does-not-change-current-state" };
  }
  if (!currentState) {
    if (["current", "temporary"].includes(scopeTime.stateTime)) {
      return { ...base, action: "create", reason: "direct-current-relationship-without-existing-state" };
    }
    return base;
  }
  return {
    no_current_state: base,
    equivalent: { ...base, action: "reinforce", reason: "same-relationship-without-state-change" },
    supports: { ...base, action: "reinforce", reason: "new-evidence-supports-current-relationship" },
    narrows: { ...base, action: "narrow_scope", reason: "direct-evidence-narrows-current-relationship-scope" },
    broadens: { ...base, action: "review_required", reason: "broader-relationship-scope-needs-review" },
    same_scope_conflict: { ...base, action: "contradict", reason: "same-scope-relationship-conflict" },
    revokes: { ...base, action: "revoke", reason: "explicit-exact-scope-revocation" },
    replaces: { ...base, action: "supersede", reason: "direct-evidence-replaces-current-relationship-state" },
    unrelated: base,
    unknown: base,
  }[relation.relation] || base;
}

function mergeRelationshipAnalyses({ evaluation, persistEvidenceLedger, completeMemoryIds }) {
  const maps = Object.fromEntries(
    Object.entries(evaluation.analyses).map(([key, items]) => [key, byMemory(items)]),
  );
  const memoryIds = uniqueStrings(Object.values(evaluation.analyses).flat().map((item) => item.memoryId));
  const observations = [];
  const previews = [];
  for (const memoryId of memoryIds.filter(id => completeMemoryIds.includes(id))) {
    const memory = evaluation.snapshot.memories.find((item) => item.id === memoryId);
    const grounding = maps.relationGrounding?.get(memoryId) || null;
    const perspective = maps.perspectiveDirection?.get(memoryId) || null;
    if (perspective?.attribution === "explicit_counterpart_statement") continue;
    const scopeTime = maps.scopeTime?.get(memoryId) || null;
    const relation = maps.currentRelation?.get(memoryId) || null;
    const gate = relationshipGate({
      grounding,
      perspective,
      scopeTime,
      relation,
      currentState: evaluation.snapshot.currentState,
    });
    const qualification = gate?.qualification || "qualified";
    const claimedDirection = directionFor(relation, evaluation.snapshot.currentState);
    const analyses = [grounding, perspective, scopeTime, relation].filter(Boolean);
    const sourceIds = uniqueStrings(analyses.flatMap((item) => item.sourceIds)).sort();
    const analysisRunIds = Object.entries(maps)
      .filter(([, map]) => map.has(memoryId))
      .map(([key]) => evaluation.runs[key])
      .filter((run) => run?.status === "completed")
      .map((run) => run.id)
      .sort();
    let observation = null;
    if (persistEvidenceLedger && sourceIds.length && analysisRunIds.length) {
      observation = evaluation.repository.recordStateEvidenceObservation({
        agentId: evaluation.snapshot.agentId,
        batchId: evaluation.batchId,
        stateFamily: "relationship",
        subjectRole: evaluation.snapshot.target.subjectRole,
        subjectKey: evaluation.snapshot.target.subjectKey,
        canonicalKey: evaluation.snapshot.target.canonicalKey,
        memoryId,
        evidenceGroupId: memory.evidenceGroupId,
        contextId: memory.contextId,
        signal: signalFor(grounding, relation),
        claimedDirection,
        effectiveDirection: qualification === "qualified" ? claimedDirection : "neutral",
        qualification,
        confidence: Math.min(...analyses.map((item) => item.confidence)),
        origin: "llm",
        scope: {
          relationshipLabel: evaluation.snapshot.target.relationshipLabel,
          counterpartRole: evaluation.snapshot.counterpart.subjectRole,
          counterpartKey: evaluation.snapshot.counterpart.subjectKey,
          relationshipDimension: evaluation.snapshot.target.relationshipDimension,
          relationType: grounding?.relationType || "unknown",
          scopeLabel: grounding?.scopeLabel || "",
          conditionLabel: grounding?.conditionLabel || "",
          stateTime: scopeTime?.stateTime || "unknown",
          duration: scopeTime?.duration || "unknown",
          currentRelation: relation?.relation || "unknown",
          scopeOverlap: relation?.scopeOverlap || "unknown",
          currentRepresentationLayer: evaluation.snapshot.target.currentRepresentationLayer,
        },
        payloadSchemaVersion: "relationship-merged-evidence-v1",
        payload: { grounding, perspective, scopeTime, relation },
        excludedReason: gate?.reason || "",
        sourceIds,
        analysisRunIds,
        observedAt: memory.eventStart || memory.eventDate || memory.knownAt,
      });
      observations.push(observation);
    }
    previews.push({
      memoryId,
      observationId: observation?.id || "",
      qualification,
      gateReason: gate?.reason || "",
      ...actionPreview({
        qualification,
        scopeTime,
        relation,
        currentState: evaluation.snapshot.currentState,
      }),
    });
  }
  return { observations, previews };
}

export async function evaluateRelationshipEvidence({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  counterpartRole,
  counterpartKey,
  counterpartLabel,
  canonicalKey,
  relationshipLabel,
  relationshipDimension = "",
  currentRepresentationLayer = "",
  memoryIds = [],
  analyzers = {},
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  snapshotOptions = {},
  maximumAnalyses = Infinity,
  persistEvidenceLedger = true,
} = {}) {
  if (!repository) throw new Error("Relationship evaluation requires a repository.");
  if (clean(subjectRole) === "shared") {
    throw new Error("Relationship evaluation currently requires an individual fixed holder; shared relationships need bilateral review.");
  }
  if (!clean(counterpartRole) || !clean(counterpartKey) || !clean(counterpartLabel)) {
    throw new Error("Relationship evaluation requires an identified counterpart.");
  }
  if (sameActor(subjectRole, subjectKey, counterpartRole, counterpartKey)) {
    throw new Error("Relationship holder and counterpart must be different actors.");
  }
  if (!clean(relationshipLabel)) {
    throw new Error("Relationship evaluation requires a readable relationshipLabel.");
  }
  for (const key of Object.keys(RELATIONSHIP_ANALYZERS)) {
    if (typeof analyzers[key] !== "function") {
      throw new Error(`Relationship evaluation requires analyzers.${key}.`);
    }
  }
  const normalizedMemoryIds = uniqueStrings(memoryIds);
  const batchId = stableBatchId({
    agentId,
    subjectRole,
    subjectKey,
    counterpartRole,
    counterpartKey,
    canonicalKey,
    currentRepresentationLayer,
    relationshipDimension,
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
    target: {
      ...baseSnapshot.target,
      stateFamily: "relationship",
      relationshipLabel: clean(relationshipLabel),
      relationshipDimension: clean(relationshipDimension),
      currentRepresentationLayer: clean(currentRepresentationLayer),
    },
    counterpart: {
      subjectRole: clean(counterpartRole),
      subjectKey: clean(counterpartKey),
      label: clean(counterpartLabel),
    },
    currentState: currentStateView(
      repository,
      clean(agentId),
      baseSnapshot.target.subjectRole,
      baseSnapshot.target.subjectKey,
      baseSnapshot.target.canonicalKey,
      clean(currentRepresentationLayer),
    ),
    inputPolicy: {
      ...baseSnapshot.inputPolicy,
      relationshipDirectionIsFixedByCaller: true,
      counterpartIsFixedByCaller: true,
      currentStateIsReadOnly: true,
      currentStateLayerIsFixedByCaller: Boolean(clean(currentRepresentationLayer)),
      modelCanChooseStateAction: false,
      modelCannotGrantRuntimePermission: true,
      sharedRelationshipRequiresBilateralReview: true,
    },
  };
  snapshotOptions.prepareStateSnapshot?.(snapshot);
  const snapshotLimit = Math.min(250_000, Math.max(
    4_000,
    Math.trunc(Number(snapshotOptions.maxSnapshotChars) || 64_000),
  ));
  if (JSON.stringify(snapshot).length > snapshotLimit) {
    throw new Error(`Relationship evidence snapshot exceeds the ${snapshotLimit}-character privacy budget.`);
  }
  if (!snapshot.memories.length) {
    return {
      status: "skipped",
      reason: "no-eligible-memories-with-direct-sources",
      batchId,
      snapshot,
      runs: {},
      analyses: {},
      rejected: {},
      observations: [],
      actionPreviews: [],
      failedRoles: [],
      warnings: [],
      automaticStateWriteAllowed: false,
    };
  }

  const definitions = Object.entries(RELATIONSHIP_ANALYZERS);
  const previousRuns = snapshotOptions.reuseAnalysisRuns
    ? repository.listStateAnalysisRuns(snapshot.agentId, { stateFamily: 'relationship', batchId,
      limit: definitions.length * 3 }) : [];
  const invoke = async ([key, definition]) => [key, await invokeAnalyzer({
    definition, generator: analyzers[key], snapshot, promptDirectory, maximumAnalyses, previousRuns,
  })];
  const invocations = await Promise.all(definitions.filter(([key]) => key !== "currentRelation").map(invoke));
  const evidenceMaps = Object.fromEntries(invocations.map(([key, result]) => [key, byMemory(result.analyses)]));
  snapshot.relationshipEvidence = snapshot.memories.flatMap(memory => {
    const grounding = evidenceMaps.relationGrounding.get(memory.id);
    const perspective = evidenceMaps.perspectiveDirection.get(memory.id);
    const scopeTime = evidenceMaps.scopeTime.get(memory.id);
    if (!grounding || !perspective || !scopeTime) return [];
    const gate = relationshipGate({ grounding, perspective, scopeTime,
      currentState: snapshot.currentState,
      relation: { currentStatePresent: Boolean(snapshot.currentState),
        relation: snapshot.currentState ? "supports" : "no_current_state", scopeOverlap: "exact" } });
    return gate ? [] : [{ memoryId: memory.id, grounding, perspective, scopeTime,
      observedAt: memory.eventStart || memory.eventDate || memory.knownAt || "" }];
  }).sort((a, b) => b.observedAt.localeCompare(a.observedAt) || a.memoryId.localeCompare(b.memoryId));
  snapshot.relationshipComparison = snapshot.relationshipEvidence.length > 1
    ? { memoryId: snapshot.relationshipEvidence[0].memoryId } : null;
  if (JSON.stringify(snapshot).length > snapshotLimit) {
    throw new Error(`Relationship comparison snapshot exceeds the ${snapshotLimit}-character privacy budget.`);
  }
  invocations.push(await invoke(definitions.find(([key]) => key === "currentRelation")));
  const { runs, analyses, rejected, warnings, failedRoles } = await recordAnalyzerInvocations({
    repository, agentId, batchId, stateFamily: 'relationship', snapshot, invocations, usageLedgerPath,
    metadata: { relationshipLabel: clean(relationshipLabel), counterpartRole: snapshot.counterpart.subjectRole, counterpartKey: snapshot.counterpart.subjectKey, currentRepresentationLayer: snapshot.target.currentRepresentationLayer, automaticStateWriteAllowed: false },
  });

  const evaluation = { repository, batchId, snapshot, runs, analyses };
  const completeMemoryIds = snapshot.memories.filter(memory =>
    definitions.every(([key]) => analyses[key].some(item => item.memoryId === memory.id))).map(memory => memory.id);
  const pendingComparisonMemoryIds = snapshot.relationshipEvidence
    .filter(item => !analyses.currentRelation.some(relation => relation.memoryId === item.memoryId))
    .map(item => item.memoryId);
  const merged = repository.transaction(() => mergeRelationshipAnalyses({
    evaluation, persistEvidenceLedger, completeMemoryIds,
  }));
  const hasAnyAnalysis = Object.values(analyses).some((items) => items.length);
  const status = failedRoles.length
    ? (completeMemoryIds.length && !pendingComparisonMemoryIds.length ? "partial" : "incomplete")
    : hasAnyAnalysis ? "analyzed" : "abstained";
  return {
    status,
    reason: status === "incomplete" ? "required-relationship-analyzer-failed-or-rejected"
      : status === "partial" ? "partial-relationship-results-unavailable" : "",
    batchId,
    snapshot,
    runs,
    analyses,
    rejected,
    observations: merged.observations,
    actionPreviews: merged.previews,
    failedRoles,
    pendingComparisonMemoryIds,
    warnings,
    automaticStateWriteAllowed: false,
  };
}
