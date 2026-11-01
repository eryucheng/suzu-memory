import { memoryWorldsCompatible } from "@suzu-memory/core";

function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeReportedClaim(value) {
  return clean(value).toLocaleLowerCase("zh-CN").replace(/\s+/gu, " ");
}

// Candidates have already passed their family's subject, target and evidence checks.
// Free-text labels and intensity are descriptions, not single-valued state axes.
export function compatibleReportedClaims(family, left, right) {
  if (family === "goal") {
    const relations = [
      ...(left.target.peerRelations || []).filter(item => item.memoryId === right.observation.memoryId),
      ...(right.target.peerRelations || []).filter(item => item.memoryId === left.observation.memoryId),
    ].map(item => item.relation);
    if (relations.some(relation => ["conflicting", "unrelated"].includes(relation))) return false;
    if (left.claimKey === right.claimKey) return true;
    return left.holder.responsibility === right.holder.responsibility
      && relations.some(relation => ["equivalent", "complementary"].includes(relation));
  }
  if (left.claimKey === right.claimKey) return true;
  if (family === "preference") return left.polarity === right.polarity;
  if (family === "value") return left.target.stance === right.target.stance;
  if (family === "affective_association") {
    return left.triggerClaim.role === right.triggerClaim.role
      && left.triggerClaim.key === right.triggerClaim.key
      && left.triggerClaim.type === right.triggerClaim.type
      && left.emotion.valence === right.emotion.valence;
  }
  if (family === "capability") {
    const level = value => ["none", "unknown"].includes(value) ? "unknown" : value;
    const leftLevel = level(left.performance.proficiencyClaim), rightLevel = level(right.performance.proficiencyClaim);
    const independence = value => !value || ["unknown", "not_applicable"].includes(value) ? null : value;
    const leftIndependent = independence(left.conditions?.independence), rightIndependent = independence(right.conditions?.independence);
    return (leftLevel === "unknown" || rightLevel === "unknown" || leftLevel === rightLevel)
      && (!leftIndependent || !rightIndependent || leftIndependent === rightIndependent);
  }
  return false;
}

export function withReportedEvidence(state, selection) {
  if (!state) return state;
  const observations = selection.contributions.map(candidate => candidate.observation);
  const unique = values => [...new Set(values)];
  return { ...state,
    evidenceObservationIds: unique(observations.map(item => item.id)),
    evidenceMemoryIds: unique(observations.map(item => item.memoryId)),
    evidenceSourceIds: unique(observations.flatMap(item => item.sourceIds)),
  };
}

export function selectLatestReportedCandidate(candidates, {
  hasCurrentState = false,
  isExplicitChange = () => false,
  compatible = (left, right) => left.claimKey === right.claimKey,
  compareTie = (left, right) => left.observation.id.localeCompare(right.observation.id),
} = {}) {
  const canCoexist = (left, right) => memoryWorldsCompatible(left.observation.memory, right.observation.memory, { allowRealSpaces: true })
    && compatible(left, right);
  const pairwise = items => items.every((left, index) => items.slice(index + 1).every(right => canCoexist(left, right)));
  const ordered = [...candidates].sort((left, right) => (
    right.observedAt.localeCompare(left.observedAt)
    || compareTie(left, right)
  ));
  if (!ordered.length) {
    return { status: "skipped", reason: "no-qualified-direct-current-state", selected: null, ordered };
  }
  const latestAt = ordered[0].observedAt;
  const latest = ordered.filter((candidate) => candidate.observedAt === latestAt);
  if (!pairwise(latest)) {
    return { status: "review_required", reason: "simultaneous-direct-state-conflict", selected: null, ordered };
  }
  const selected = latest[0];
  if (!hasCurrentState
    && !pairwise(ordered)
    && !isExplicitChange(selected)) {
    return {
      status: "review_required",
      reason: "multiple-unresolved-direct-states-without-change-cue",
      selected,
      ordered,
    };
  }
  const contributions = [selected];
  for (const candidate of ordered) {
    if (candidate !== selected && contributions.every(item => canCoexist(item, candidate))) contributions.push(candidate);
  }
  return { status: "ready", reason: "", selected, ordered, contributions };
}
