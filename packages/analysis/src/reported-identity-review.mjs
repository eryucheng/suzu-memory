import { readReportedStateDraft, memoryWorldsCompatible } from "@suzu-memory/core";
import { buildCanonicalStateEvidenceSnapshot } from "./canonical-state-snapshot.mjs";
import {
  normalizeReportedClaim,
  selectLatestReportedCandidate,
} from "./reported-state-review-core.mjs";

const SUBJECT_ROLES = new Set(["user", "agent", "other"]);
const CARDINALITIES = new Set(["single", "multi_item", "sequence"]);
const CHANGE_CUES = new Set(["started", "changed", "ended", "clarified", "denies_prior_state"]);

function clean(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return normalizeReportedClaim(value);
}

function candidateFromObservation(observation, retainedReport = false) {
  const field = observation.analysis?.field;
  const subject = observation.analysis?.subject;
  const boundary = observation.analysis?.boundary;
  const time = observation.analysis?.time;
  const relation = observation.analysis?.relation;
  const cardinality = clean(observation.scope?.fieldCardinality);
  if (observation.qualification !== "qualified"
    || (observation.memory?.evidenceMode !== "explicit" && !retainedReport)
    || observation.scope?.currentRepresentationLayer !== "reported"
    || !["exact", "subcategory"].includes(field?.targetMatch)
    || !clean(field?.identityField)
    || !clean(field?.valueText)
    || !["asserts", "denies"].includes(field?.statementPolarity)
    || subject?.subjectMatch !== "yes"
    || subject?.attribution !== "explicit_self_report"
    || boundary?.classification !== "identity_fact"
    || boundary?.sensitivity === "credential"
    || !["current", "timeless"].includes(time?.factTime)
    || !relation
    || !CARDINALITIES.has(cardinality)) {
    return null;
  }
  const scope = {
    valueScope: clean(field.valueScope),
  };
  return {
    observation,
    field,
    subject,
    boundary,
    time,
    relation,
    cardinality,
    scope,
    claimKey: normalized([
      field.identityField,
      field.statementPolarity,
      field.valueText,
      scope.valueScope,
    ].join("\u001f")),
    observedAt: observation.observedAt,
  };
}

function identityValueRelations(left, right) {
  return [
    ...(left.field.valueRelations || []).filter(peer => peer.memoryId === right.observation.memoryId),
    ...(right.field.valueRelations || []).filter(peer => peer.memoryId === left.observation.memoryId),
  ].map(peer => peer.relation);
}

function identityCompatible(left, right) {
  if (left === right) return true;
  if (!memoryWorldsCompatible(left.observation.memory, right.observation.memory, { allowRealSpaces: true })) return false;
  const relations = identityValueRelations(left, right);
  if (relations.includes("conflicting") || relations.includes("unrelated")) return false;
  if (left.claimKey === right.claimKey) return true;
  if (left.field.identityField !== right.field.identityField
    || left.field.statementPolarity !== right.field.statementPolarity || left.cardinality !== right.cardinality) return false;
  return relations.includes("equivalent") || (left.cardinality === "multi_item"
    && left.field.statementPolarity === "asserts" && relations.includes("complementary"));
}

function currentClaim(repository, snapshot) {
  if (!snapshot.currentState) return null;
  const memory = repository.getMemory(snapshot.currentState.id);
  const draft = readReportedStateDraft(memory);
  const stored = draft.identityClaim;
  if (!stored || !clean(stored.identityField) || !clean(stored.valueText)
    || !CARDINALITIES.has(clean(stored.fieldCardinality))) {
    return null;
  }
  return {
    ...stored,
    evidenceObservationIds: draft.evidenceObservationIds || [],
    identityField: clean(stored.identityField),
    valueText: clean(stored.valueText),
    fieldCardinality: clean(stored.fieldCardinality),
    scope: {
      valueScope: clean(stored.scope?.valueScope ?? stored.valueScope),
    },
  };
}

function actionAgainstCurrent(candidate, current) {
  const relation = candidate.relation.relation;
  const cue = candidate.time.revisionCue;
  if (["equivalent", "supports"].includes(relation)
    && candidate.field.identityField === current.identityField && candidate.cardinality === current.fieldCardinality) {
    return "reinforce";
  }
  if (relation === "additional_value" && candidate.cardinality === "multi_item"
    && current.fieldCardinality === "multi_item" && candidate.field.identityField === current.identityField
    && candidate.field.statementPolarity === "asserts") return "supersede";
  if (relation === "narrows" && cue === "clarified") return "narrow_scope";
  if (relation === "value_changed" && cue === "changed"
    && ["single", "sequence"].includes(candidate.cardinality)) return "supersede";
  if (relation === "retires" && cue === "ended") return "retire";
  if (relation === "same_scope_conflict" && cue === "denies_prior_state") {
    return "correct_attribution";
  }
  return "review_required";
}

function proposedState(candidate, snapshot, contributions, existing = null, extendsCurrent = false) {
  const unique = values => [...new Set(values.filter(Boolean))];
  const retained = existing && extendsCurrent
    ? (existing.values || [{ valueText: existing.valueText, valueScope: existing.scope.valueScope }]) : [];
  const values = [...new Map([...retained, ...contributions.map(item => ({
    valueText: item.field.valueText, valueScope: item.scope.valueScope,
  }))].map(item => [normalized(item.valueText) + "\u001f" + normalized(item.valueScope), item])).values()];
  const severities = ["ordinary", "personal", "sensitive", "restricted", "credential"];
  const sensitivity = contributions.map(item => item.boundary.sensitivity).concat(existing?.sensitivity || [])
    .sort((a,b) => severities.indexOf(b) - severities.indexOf(a))[0];
  return {
    kind: "fact",
    stateFamily: "identity",
    representationLayer: "reported",
    subjectRole: snapshot.target.subjectRole,
    subjectKey: snapshot.target.subjectKey,
    canonicalKey: snapshot.target.canonicalKey,
    evidenceMode: "explicit",
    temporalState: candidate.time.factTime === "timeless" ? "timeless" : "current",
    statePhase: "active",
    validFrom: candidate.observedAt,
    identityClaim: {
      identityField: candidate.field.identityField,
      identityLabel: clean(candidate.observation.scope?.identityLabel),
      valueText: values.map(item => item.valueText).join("; "),
      ...(values.length > 1 ? { values } : {}),
      fieldCardinality: candidate.cardinality,
      scope: { valueScope: unique(values.map(item => item.valueScope)).join("; ") },
      sensitivity,
      holderStatementStatus: "directly-reported",
      externalVerificationStatus: "unverified",
    },
    scope: candidate.observation.scope,
    evidenceObservationIds: unique(contributions.map(item => item.observation.id)),
    evidenceMemoryIds: unique(contributions.map(item => item.observation.memoryId)),
    evidenceSourceIds: unique(contributions.flatMap(item => item.observation.sourceIds)),
  };
}

function flags() {
  return {
    automaticStateWriteAllowed: false,
    automaticEstablishedIdentityWriteAllowed: false,
    automaticExternalAccountSyncAllowed: false,
    automaticCredentialWriteAllowed: false,
    automaticSelfConceptWriteAllowed: false,
    automaticRelationshipWriteAllowed: false,
    automaticConditionWriteAllowed: false,
  };
}

function reviewRequired(snapshot, reason, selection) {
  return {
    status: "review_required",
    reason,
    representationLayer: "reported",
    action: "review_required",
    proposedState: null,
    selectedObservationId: selection?.selected?.observation.id || "",
    consideredObservationIds: selection?.ordered?.map((candidate) => candidate.observation.id) || [],
    snapshot,
    ...flags(),
  };
}

export function reviewReportedIdentityState({
  repository,
  agentId,
  subjectRole,
  subjectKey,
  canonicalKey,
  subjectLabel,
  identityLabel,
  snapshotOptions = {},
} = {}) {
  if (!SUBJECT_ROLES.has(clean(subjectRole))) {
    throw new Error("Reported identity review requires one fixed personal subject.");
  }
  const baseResult = buildCanonicalStateEvidenceSnapshot({
    repository,
    agentId,
    stateFamily: "identity",
    subjectRole,
    subjectKey,
    canonicalKey,
    subjectLabel,
    stateLabel: identityLabel,
    ...snapshotOptions,
    currentRepresentationLayer: "reported",
  });
  if (baseResult.status === "skipped") {
    return { ...baseResult, representationLayer: "reported", ...flags() };
  }
  const snapshot = baseResult.snapshot;
  const existing = currentClaim(repository, snapshot);
  const retainedIds = new Set(existing?.evidenceObservationIds || []);
  const candidates = snapshot.observations.map(observation => candidateFromObservation(
    observation, retainedIds.has(observation.id),
  )).filter(Boolean);
  if (!candidates.length) {
    return {
      status: "skipped",
      reason: "no-qualified-direct-current-identity-report",
      snapshot,
      representationLayer: "reported",
      ...flags(),
    };
  }
  const selection = selectLatestReportedCandidate(candidates, {
    hasCurrentState: Boolean(snapshot.currentState),
    compatible: identityCompatible,
    isExplicitChange: (candidate) => CHANGE_CUES.has(candidate.time.revisionCue),
  });
  if (selection.status === "review_required") {
    return reviewRequired(snapshot, selection.reason, selection);
  }
  const selected = selection.selected;
  const currentEvidence = new Set(snapshot.completeness.currentStateEvidenceMemoryIds);
  const selectedAction = existing
    ? retainedIds.has(selected.observation.id) ? "reinforce" : actionAgainstCurrent(selected, existing)
    : "create";
  // Decide set expansion from the compatible batch, so a later confirmation of
  // an existing item cannot hide an earlier addition from the same batch.
  const extendsCurrent = Boolean(existing && selected.cardinality === "multi_item"
    && ["reinforce", "supersede"].includes(selectedAction)
    && selection.ordered.some(item => !currentEvidence.has(item.observation.memoryId)
      && item.relation.relation === "additional_value" && identityCompatible(selected, item)));
  const contributions = selection.ordered.filter(item => identityCompatible(selected, item)
    || (extendsCurrent && currentEvidence.has(item.observation.memoryId)
      && item.field.statementPolarity === "asserts" && item.cardinality === "multi_item"));
  if (contributions.some((left, i) => contributions.slice(i + 1).some(right =>
    !identityCompatible(left, right) && !(extendsCurrent
      && memoryWorldsCompatible(left.observation.memory, right.observation.memory, { allowRealSpaces: true })
      && !identityValueRelations(left, right).some(relation => ["conflicting", "unrelated"].includes(relation))
      && left.field.identityField === right.field.identityField
      && (currentEvidence.has(left.observation.memoryId) || currentEvidence.has(right.observation.memoryId)))))) {
    return reviewRequired(snapshot, "identity-evidence-values-are-not-compatible", selection);
  }
  if (snapshot.currentState && !existing) {
    return reviewRequired(snapshot, "current-reported-identity-lacks-structured-claim-metadata", selection);
  }
  if (!existing && (selected.field.statementPolarity === "denies"
    || ["ended", "denies_prior_state"].includes(selected.time.revisionCue))) {
    return reviewRequired(snapshot, "closed-or-corrective-identity-report-cannot-create-current-state", selection);
  }
  const action = extendsCurrent ? "supersede" : selectedAction;
  if (action === "review_required") {
    const reason = selected.relation.relation === "additional_value"
      ? "identity-field-cardinality-does-not-match-current-state"
      : "latest-identity-report-does-not-prove-a-safe-transition";
    return reviewRequired(snapshot, reason, selection);
  }
  return {
    status: "ready",
    reason: "",
    representationLayer: "reported",
    action,
    currentStateId: snapshot.currentState?.id || "",
    proposedState: ["retire", "correct_attribution"].includes(action)
      ? null
      : proposedState(selected, snapshot, contributions, existing, extendsCurrent),
    selectedObservationId: selected.observation.id,
    consideredObservationIds: selection.ordered.map((candidate) => candidate.observation.id),
    snapshot,
    truthBoundary: {
      holderIdentityReportIsRecorded: true,
      externalVerificationStatus: "unverified",
      establishedIdentityIsUnaffected: true,
      selfConceptStatus: "not-inferred",
      relationshipStatus: "not-inferred",
      conditionStatus: "not-inferred",
      credentialStorageStatus: "forbidden",
    },
    ...flags(),
  };
}
