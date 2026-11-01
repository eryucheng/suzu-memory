import { normalizeStateAnalysisTargetSpec } from '@suzu-memory/core';
import { invokeEvidenceAnalyzer, recordAnalyzerInvocations, priorAnalyzerRuns } from "./related-analyzer-batch.mjs";
import { modelCalendarFields } from '@suzu-memory/core';
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AFFECTIVE_ASSOCIATION_ANALYZERS, buildAffectiveAssociationGenerationInput,
  parseAffectiveAssociationGeneration } from "./affective-association-contracts.mjs";
import { buildPreferenceEvidenceSnapshot } from "./preference-snapshot.mjs";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(ROOT, "resources");
function clean(v) { return String(v ?? "").trim(); }
function unique(v) { return [...new Set((Array.isArray(v) ? v : []).map(clean).filter(Boolean))]; }
function batchId(args) { const raw = [args.agentId, args.subjectRole, args.subjectKey, args.triggerRole,
  args.triggerKey, args.triggerLabel, clean(args.canonicalKey).toLocaleLowerCase("en-US"), args.currentRepresentationLayer,
  unique(args.memoryIds).sort().join("\u001f")]
  .map(clean).join("\u001e"); return `affective-analysis-${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`; }
function currentView(repository, agentId, subjectRole, subjectKey, canonicalKey, representationLayer) {
  const current = repository.getCurrentCanonicalMemory({
    agentId,
    subjectRole,
    subjectKey,
    canonicalKey,
    representationLayer,
    stateFamily: "affective_association",
  });
  if (!current) return null;
  if (!new Set(["belief_state", "derived_hypothesis"]).has(current.kind)) throw new Error("Affective canonicalKey resolves to a non-affective-compatible memory kind.");
  return { id: current.id, kind: current.kind, content: String(current.content ?? ""), subjectRole: current.subject_role,
    subjectKey: current.subject_key, canonicalKey: current.canonical_key, temporalState: current.temporal_state,
    representationLayer: current.representation_layer, ...modelCalendarFields(current, ['knownAt', 'validFrom', 'validTo'], repository.listMemorySources(current.id)) };
}
function hasRole(memory, target, roles, primary = true) { return (primary && memory.subjectRole === target.subjectRole
  && memory.subjectKey === target.subjectKey) || memory.actorRoles.some((r) => roles.has(r.role)
    && r.actorRole === target.subjectRole && r.actorKey === target.subjectKey); }
function enforce(role, item, snapshot) {
  const memory = snapshot.memories.find((m) => m.id === item.memoryId);
  if (!memory) throw new Error("Affective analysis memory must come from the bounded snapshot.");
  const sources = new Set(memory.sourceIds);
  if (item.sourceIds.some((id) => !sources.has(id))) throw new Error("Affective analysis source must directly support its memory.");
  if (role === "experiencer-attribution" && item.attribution === "explicit_self_report") {
    if (!hasRole(memory, snapshot.target, new Set(["speaker"]), false)) throw new Error("Explicit affective self report requires the fixed subject as speaker.");
  } else if (!hasRole(memory, snapshot.target, new Set(["subject", "speaker", "participant", "experiencer"]))) {
    throw new Error("Affective analysis does not identify the fixed experiencer.");
  }
  if (role === "current-relation") {
    const exists = Boolean(snapshot.currentState);
    if (item.currentStatePresent !== exists) throw new Error("Affective current-state presence does not match the read-only snapshot.");
    if (exists && item.relation === "no_current_state") throw new Error("Affective relation omitted current state.");
    if (!exists && item.relation !== "no_current_state") throw new Error("Affective relation invented current state.");
  }
  return item;
}

async function invoke(options) {
  return invokeEvidenceAnalyzer({ ...options, buildInput: buildAffectiveAssociationGenerationInput,
    parseGeneration: parseAffectiveAssociationGeneration, enforceBoundary: enforce });
}
function mapBy(items) { return new Map((items || []).map((x) => [x.memoryId, x])); }
function gate({ trigger, experiencer, basis, time, relation, current }) {
  if (!trigger) return { qualification: "unresolved", reason: "missing-affective-trigger-analysis" };
  if (["none", "contextual"].includes(trigger.targetMatch)) return { qualification: "excluded", reason: "memory-does-not-express-the-fixed-affective-trigger" };
  if (["unknown", "broader_category"].includes(trigger.targetMatch) || trigger.triggerType === "unknown"
    || !trigger.triggerLabel || !trigger.emotionLabel || trigger.valence === "unknown" || trigger.intensity === "unknown") {
    return { qualification: "unresolved", reason: "affective-trigger-or-emotion-is-not-exact-enough" };
  }
  if (!experiencer) return { qualification: "unresolved", reason: "missing-affective-experiencer-analysis" };
  if (experiencer.experiencerMatch === "no") return { qualification: "excluded", reason: "affect-belongs-to-another-experiencer" };
  if (experiencer.experiencerMatch === "unknown") return { qualification: "unresolved", reason: "affective-experiencer-unknown" };
  if (experiencer.attribution === "quoted_or_roleplay") return { qualification: "excluded", reason: "affect-is-quoted-or-roleplay" };
  if (experiencer.attribution !== "explicit_self_report") return { qualification: "unresolved", reason: "affective-link-is-not-the-experiencer-direct-report" };
  if (!basis) return { qualification: "unresolved", reason: "missing-affective-basis-analysis" };
  if (["current_mood", "general_preference", "no_affective_link"].includes(basis.associationType)) {
    return { qualification: "excluded", reason: `affective-${basis.associationType.replaceAll("_", "-")}` };
  }
  if (basis.associationType === "single_cooccurrence") return { qualification: "unresolved", reason: "single-cooccurrence-does-not-prove-trigger-link" };
  if (basis.associationType === "unknown" || basis.causality === "unknown" || basis.recurrence === "unknown") {
    return { qualification: "unresolved", reason: "affective-link-basis-is-unknown" };
  }
  if (!["explicit_trigger_link", "repeated_pattern"].includes(basis.associationType) || basis.causality !== "explicit") {
    return { qualification: "unresolved", reason: "affective-trigger-link-is-not-explicit" };
  }
  if (basis.associationType === "repeated_pattern" && !["repeated_claim", "stable_claim"].includes(basis.recurrence)) {
    return { qualification: "unresolved", reason: "repeated-affective-pattern-lacks-recurrence" };
  }
  if (!time) return { qualification: "unresolved", reason: "missing-affective-time-analysis" };
  if (["future", "temporary"].includes(time.stateTime)) return { qualification: "excluded", reason: "future-or-temporary-mood-is-not-current-affective-link" };
  if (time.stateTime === "unknown" || time.changeCue === "unknown") return { qualification: "unresolved", reason: "affective-time-or-change-unknown" };
  if (!relation) return { qualification: "unresolved", reason: "missing-affective-current-relation-analysis" };
  if (Boolean(current) !== relation.currentStatePresent) return { qualification: "unresolved", reason: "affective-current-state-presence-conflict" };
  if (relation.relation === "unknown") return { qualification: "unresolved", reason: "affective-current-relation-unknown" };
  if (current && relation.relation === "unrelated") return { qualification: "excluded", reason: "affective-link-is-unrelated-to-current-state" };
  if (current && !["equivalent", "supports"].includes(relation.relation)
    && ["none", "unknown"].includes(relation.scopeOverlap)) return { qualification: "unresolved", reason: "affective-scope-overlap-is-not-proven" };
  const cueByRelation = { intensity_up: "strengthened", intensity_down: "weakened",
    emotion_changed: "emotion_changed", retires: "extinguished" };
  if (cueByRelation[relation.relation] && time.changeCue !== cueByRelation[relation.relation]) {
    return { qualification: "unresolved", reason: "affective-state-relation-lacks-matching-change-cue" };
  }
  return null;
}
function action({ qualification, time, relation, current }) {
  const base = { action: "no_conclusion", proposedKind: "derived_hypothesis",
    reason: qualification === "qualified" ? "no-safe-affective-action" : "evidence-not-qualified",
    automaticStateWriteAllowed: false, activationBiasAllowed: false };
  if (qualification !== "qualified" || !time || !relation) return base;
  if (time.stateTime === "historical") return { ...base, reason: "historical-affective-link-does-not-change-current-state" };
  if (!current) return { ...base, action: "accumulate_evidence", reason: "single-affective-link-needs-later-canonical-aggregation" };
  return ({ equivalent: { ...base, action: "reinforce", reason: "same-affective-link-supports-current-state" },
    supports: { ...base, action: "reinforce", reason: "new-evidence-supports-current-affective-link" },
    narrows: { ...base, action: "narrow_scope", reason: "affective-trigger-scope-is-narrower" },
    broadens: { ...base, action: "review_required", reason: "broader-affective-trigger-needs-review" },
    emotion_changed: { ...base, action: "supersede", reason: "subject-reports-a-different-current-emotion" },
    intensity_up: { ...base, action: "review_required", reason: "affective-intensity-increase-needs-review" },
    intensity_down: { ...base, action: "review_required", reason: "affective-intensity-decrease-needs-review" },
    same_scope_conflict: { ...base, action: "contradict", reason: "same-scope-affective-conflict" },
    retires: { ...base, action: "retire", reason: "subject-explicitly-reports-affective-link-extinguished" } }[relation.relation] || base);
}
function merge({ evaluation, persistEvidenceLedger }) {
  const maps = Object.fromEntries(Object.entries(evaluation.analyses).map(([k, v]) => [k, mapBy(v)]));
  const ids = unique(Object.values(evaluation.analyses).flat().map((x) => x.memoryId)); const observations = []; const previews = [];
  for (const memoryId of ids) {
    if (Object.values(maps).some(map => !map.has(memoryId))) continue; const memory = evaluation.snapshot.memories.find((m) => m.id === memoryId);
    const trigger = maps.triggerEmotion?.get(memoryId) || null; const experiencer = maps.experiencerAttribution?.get(memoryId) || null;
    const basis = maps.associationBasis?.get(memoryId) || null; const time = maps.timeRevision?.get(memoryId) || null;
    const relation = maps.currentRelation?.get(memoryId) || null; const blocked = gate({ trigger, experiencer, basis, time, relation, current: evaluation.snapshot.currentState });
    const qualification = blocked?.qualification || "qualified"; const analyses = [trigger, experiencer, basis, time, relation].filter(Boolean);
    const sourceIds = unique(analyses.flatMap((x) => x.sourceIds)).sort(); const runIds = Object.entries(maps).filter(([, m]) => m.has(memoryId))
      .map(([k]) => evaluation.runs[k]).filter((r) => r?.status === "completed").map((r) => r.id).sort();
    let observation = null; if (persistEvidenceLedger && sourceIds.length && runIds.length) {
      const opposition = ["same_scope_conflict", "retires", "emotion_changed"].includes(relation?.relation);
      observation = evaluation.repository.recordStateEvidenceObservation({ agentId: evaluation.snapshot.agentId,
        batchId: evaluation.batchId, stateFamily: "affective_association", subjectRole: evaluation.snapshot.target.subjectRole,
        subjectKey: evaluation.snapshot.target.subjectKey, canonicalKey: evaluation.snapshot.target.canonicalKey,
        memoryId, evidenceGroupId: memory.evidenceGroupId, contextId: memory.contextId,
        signal: basis?.associationType === "repeated_pattern" ? "repeated_affective_pattern" : "explicit_trigger_link",
        claimedDirection: opposition ? "opposition" : "support",
        effectiveDirection: qualification === "qualified" ? (opposition ? "opposition" : "support") : "neutral",
        qualification, confidence: Math.min(...analyses.map((x) => x.confidence)), origin: "llm",
        scope: { associationLabel: evaluation.snapshot.target.associationLabel, triggerRole: evaluation.snapshot.trigger.subjectRole,
          triggerKey: evaluation.snapshot.trigger.subjectKey, triggerType: trigger?.triggerType || "unknown",
          emotionLabel: trigger?.emotionLabel || "", valence: trigger?.valence || "unknown", intensity: trigger?.intensity || "unknown",
          recurrence: basis?.recurrence || "unknown", stateTime: time?.stateTime || "unknown",
          currentRelation: relation?.relation || "unknown", scopeOverlap: relation?.scopeOverlap || "unknown",
          currentRepresentationLayer: evaluation.snapshot.target.currentRepresentationLayer },
        payloadSchemaVersion: "affective-association-merged-evidence-v1", payload: { trigger, experiencer, basis, time, relation },
        excludedReason: blocked?.reason || "", sourceIds, analysisRunIds: runIds,
        observedAt: memory.eventStart || memory.eventDate || memory.knownAt }); observations.push(observation); }
    previews.push({ memoryId, observationId: observation?.id || "", qualification, gateReason: blocked?.reason || "",
      ...action({ qualification, time, relation, current: evaluation.snapshot.currentState }) }); }
  return { observations, previews };
}
export async function evaluateAffectiveAssociationEvidence({ repository, agentId, subjectRole, subjectKey,
  triggerRole, triggerKey, triggerLabel, canonicalKey, associationLabel, memoryIds = [], analyzers = {},
  usageLedgerPath = "", promptDirectory = DEFAULT_PROMPT_DIRECTORY, snapshotOptions = {}, maximumAnalyses = Infinity,
  persistEvidenceLedger = true, currentRepresentationLayer = "" } = {}) {
  if (!repository) throw new Error("Affective evaluation requires a repository.");
  if (clean(subjectRole) === "shared") throw new Error("Affective evaluation requires an individual fixed subject.");
  const trigger = normalizeStateAnalysisTargetSpec("affective_association", {
    triggerRole, triggerKey, triggerLabel,
  }, { allowEmpty: false });
  if (!clean(associationLabel)) throw new Error("Affective evaluation requires a readable associationLabel.");
  for (const key of Object.keys(AFFECTIVE_ASSOCIATION_ANALYZERS)) if (typeof analyzers[key] !== "function") throw new Error(`Affective evaluation requires analyzers.${key}.`);
  const normalizedIds = unique(memoryIds); const batch = batchId({ agentId, subjectRole, subjectKey, triggerRole,
    triggerKey, triggerLabel, canonicalKey, currentRepresentationLayer, memoryIds: normalizedIds });
  const base = buildPreferenceEvidenceSnapshot({ repository, agentId, subjectRole, subjectKey, canonicalKey,
    memoryIds: normalizedIds, ...snapshotOptions });
  const snapshot = { ...base, agentId: clean(agentId), target: { ...base.target, stateFamily: "affective_association",
    associationLabel: clean(associationLabel), currentRepresentationLayer: clean(currentRepresentationLayer) },
    trigger: { subjectRole: trigger.triggerRole, subjectKey: trigger.triggerKey,
    label: trigger.triggerLabel }, currentState: currentView(repository, clean(agentId), base.target.subjectRole,
    base.target.subjectKey, base.target.canonicalKey, clean(currentRepresentationLayer)),
    inputPolicy: { ...base.inputPolicy, currentStateIsReadOnly: true,
      currentStateLayerIsFixedByCaller: Boolean(clean(currentRepresentationLayer)),
      modelCanChooseStateAction: false, currentMoodCannotRewriteMemory: true, activationBiasAllowed: false } };
  snapshotOptions.prepareStateSnapshot?.(snapshot);
  const limit = Math.min(250000, Math.max(4000, Math.trunc(Number(snapshotOptions.maxSnapshotChars) || 64000)));
  if (JSON.stringify(snapshot).length > limit) throw new Error(`Affective evidence snapshot exceeds the ${limit}-character privacy budget.`);
  if (!snapshot.memories.length) return { status: "skipped", reason: "no-eligible-memories-with-direct-sources", batchId: batch,
    snapshot, runs: {}, analyses: {}, rejected: {}, observations: [], actionPreviews: [], failedRoles: [], warnings: [],
    automaticStateWriteAllowed: false, activationBiasAllowed: false };
  const definitions = Object.entries(AFFECTIVE_ASSOCIATION_ANALYZERS);
  const previousRuns = priorAnalyzerRuns(repository, snapshot, batch, definitions, snapshotOptions);
  const invocations = await Promise.all(definitions.map(async ([key, definition]) => [key,
    await invoke({ definition, generator: analyzers[key], snapshot, promptDirectory, maximumAnalyses, previousRuns })]));
  const { runs, analyses, rejected, warnings, failedRoles } = await recordAnalyzerInvocations({
    repository, agentId, batchId: batch, stateFamily: 'affective_association', snapshot, invocations, usageLedgerPath,
    metadata: { associationLabel: clean(associationLabel), triggerRole: clean(triggerRole), triggerKey: clean(triggerKey), currentRepresentationLayer: clean(currentRepresentationLayer), automaticStateWriteAllowed: false, activationBiasAllowed: false },
    usageFeature: (_key, definition) => 'memory-affective-' + definition.role,
  });
  const evaluation = { repository, batchId: batch, snapshot, runs, analyses }; const merged = repository.transaction(() => merge({ evaluation, persistEvidenceLedger }));
  const any = Object.values(analyses).some((items) => items.length);
  return { status: failedRoles.length ? "incomplete" : any ? "analyzed" : "abstained",
    reason: failedRoles.length ? "required-affective-analyzer-failed-or-rejected" : "", batchId: batch, snapshot,
    runs, analyses, rejected, observations: merged.observations, actionPreviews: merged.previews, failedRoles, warnings,
    automaticStateWriteAllowed: false, activationBiasAllowed: false };
}
