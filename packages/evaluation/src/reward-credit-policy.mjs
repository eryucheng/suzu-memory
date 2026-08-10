export const REWARD_CREDIT_POLICY_VERSION = "reward-credit-shadow-v2";
export const REWARD_PATH_CREDIT_POLICY_VERSION = "reward-path-eligibility-v1";
export const REWARD_PATH_ELIGIBILITY_DECAY = 0.72;

const POSITIVE_BASE = Object.freeze({
  explicit_help: 1,
  successful_outcome: 0.85,
});

function clean(value) {
  return String(value ?? "").trim();
}

function rounded(value) {
  return Math.round(Number(value || 0) * 1_000_000) / 1_000_000;
}

function bounded(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, Number(value) || 0));
}

function combinedConfidence(outcome, target, credit) {
  return Math.min(
    bounded(outcome?.confidence, 0, 1),
    bounded(target?.confidence, 0, 1),
    bounded(credit?.confidence, 0, 1),
  );
}

function baseStatus({ outcome, target, credit, explicitlyTargeted }) {
  if (outcome.outcomeClass === "correction") {
    return { status: "blocked", direction: "hold", reason: "content-correction-requires-state-review" };
  }
  if (["social_affect", "no_result"].includes(outcome.outcomeClass)) {
    return { status: "blocked", direction: "hold", reason: "positive-affect-or-continuation-is-not-memory-reward" };
  }
  if (outcome.outcomeClass === "uncertain" || target.targetType === "uncertain"
    || credit.contributionClass === "uncertain") {
    return { status: "pending", direction: "hold", reason: "reward-attribution-is-uncertain" };
  }
  if (outcome.outcomeClass === "adoption_pending") {
    return { status: "pending", direction: "hold", reason: "adoption-has-no-verified-outcome-yet" };
  }
  if (!explicitlyTargeted || !["retrieved_memory", "mixed"].includes(target.targetType)) {
    return { status: "blocked", direction: "hold", reason: "feedback-does-not-target-this-retrieved-memory" };
  }
  if (!["direct", "partial"].includes(credit.contributionClass) || credit.contributionShare <= 0) {
    return { status: "blocked", direction: "hold", reason: "memory-has-no-demonstrated-contribution" };
  }
  const confidence = combinedConfidence(outcome, target, credit);
  if (confidence < 0.75) {
    return { status: "pending", direction: "hold", reason: "reward-evidence-below-high-precision-threshold" };
  }
  if (Object.hasOwn(POSITIVE_BASE, outcome.outcomeClass)
    && ["explicit_attribution", "reported_outcome", "externally_verified"].includes(outcome.evidenceTier)) {
    return { status: "eligible", direction: "increase", reason: "bounded-positive-credit" };
  }
  if (outcome.outcomeClass === "failed_outcome"
    && ["explicit_attribution", "reported_outcome", "externally_verified"].includes(outcome.evidenceTier)) {
    return { status: "eligible", direction: "decrease", reason: "bounded-negative-context-utility-credit" };
  }
  return { status: "pending", direction: "hold", reason: "outcome-evidence-is-not-strong-enough" };
}

export function createRewardCreditProposals({ observation, trace, outcome, target, credits } = {}) {
  if (!observation?.id || !trace?.id || !outcome || !target || !Array.isArray(credits?.analyses)) {
    throw new Error("Reward credit proposal policy requires a complete analyzed observation.");
  }
  const targeted = new Set(Array.isArray(target.targetMemoryIds) ? target.targetMemoryIds : []);
  // The current policy only auto-binds the immediate next real user message. Delayed-life
  // outcomes need an explicit usage-request link before a versioned discount
  // policy can be introduced, so this auditable first policy uses 1 exactly.
  const delayDiscount = 1;
  const feedbackBinding = clean(observation?.metadata?.feedbackBinding) || "immediate-next-user-input";
  return credits.analyses.map((credit) => {
    const status = baseStatus({
      outcome,
      target,
      credit,
      explicitlyTargeted: targeted.has(credit.memoryId),
    });
    const confidence = combinedConfidence(outcome, target, credit);
    const positiveBase = POSITIVE_BASE[outcome.outcomeClass] || 0;
    const signedBase = status.direction === "increase"
      ? positiveBase
      : status.direction === "decrease" ? -0.8 : 0;
    const rewardValue = status.status === "eligible"
      ? rounded(signedBase * credit.contributionShare * confidence * delayDiscount)
      : 0;
    return {
      observationId: observation.id,
      memoryId: credit.memoryId,
      contextKey: clean(credit.contextKey) || clean(trace.recall_intent) || "general",
      outcomeClass: outcome.outcomeClass,
      feedbackTarget: target.targetType,
      contributionClass: credit.contributionClass,
      contributionShare: credit.contributionShare,
      evidenceTier: outcome.evidenceTier,
      rewardDirection: status.direction,
      rewardValue,
      proposedConsolidationDelta: rewardValue > 0 ? rounded(Math.min(0.04, rewardValue * 0.04)) : 0,
      proposedUtilityDelta: rewardValue === 0 ? 0 : rounded(bounded(rewardValue * 0.08, -0.08, 0.08)),
      status: status.status,
      policyVersion: REWARD_CREDIT_POLICY_VERSION,
      rationale: `${status.reason}; ${credit.rationale}`,
      evidence: {
        reasonCode: status.reason,
        outcome,
        target,
        credit,
        combinedConfidence: confidence,
        delayDiscount,
        feedbackBinding,
        automaticStateMutationAllowed: false,
      },
    };
  });
}

export function createRewardPathCreditProposals({ trace, memoryProposals } = {}) {
  if (!trace?.id || !Array.isArray(trace.paths) || !Array.isArray(memoryProposals)) {
    throw new Error("Reward path credit requires an audited retrieval trace and memory proposals.");
  }
  const pathByMemory = new Map(trace.paths.map((item) => [clean(item?.memoryId), item]));
  const values = [];
  for (const proposal of memoryProposals) {
    const path = pathByMemory.get(clean(proposal?.memoryId));
    const edges = Array.isArray(path?.edges) ? path.edges.filter((edge) => clean(edge?.edgeId)) : [];
    if (!edges.length) continue;
    const uniqueEdges = [];
    const seen = new Set();
    for (const edge of edges) {
      const edgeId = clean(edge.edgeId);
      if (seen.has(edgeId)) continue;
      seen.add(edgeId);
      uniqueEdges.push(edge);
    }
    const rawWeights = uniqueEdges.map((_, index) => (
      REWARD_PATH_ELIGIBILITY_DECAY ** (uniqueEdges.length - index - 1)
    ));
    const totalWeight = rawWeights.reduce((sum, value) => sum + value, 0);
    uniqueEdges.forEach((edge, index) => {
      const eligibilityWeight = rounded(rawWeights[index] / totalWeight);
      const status = clean(proposal.status);
      const rewardDirection = status === "eligible" ? clean(proposal.rewardDirection) : "hold";
      const rewardValue = status === "eligible"
        ? rounded(Number(proposal.rewardValue || 0) * eligibilityWeight)
        : 0;
      const proposedUtilityDelta = status === "eligible"
        ? rounded(Number(proposal.proposedUtilityDelta || 0) * eligibilityWeight)
        : 0;
      values.push({
        observationId: clean(proposal.observationId),
        memoryCreditProposalId: clean(proposal.id),
        memoryId: clean(proposal.memoryId),
        edgeId: clean(edge.edgeId),
        contextKey: clean(proposal.contextKey) || clean(trace.recall_intent) || "general",
        pathPosition: index,
        distanceFromTarget: uniqueEdges.length - index - 1,
        eligibilityWeight,
        rewardDirection,
        rewardValue,
        proposedUtilityDelta,
        status: ["eligible", "pending", "blocked"].includes(status) ? status : "blocked",
        policyVersion: REWARD_PATH_CREDIT_POLICY_VERSION,
        evidence: {
          traceId: trace.id,
          targetMemoryId: clean(proposal.memoryId),
          pathScore: Number(path?.score || 0),
          seedContributions: Array.isArray(path?.seedContributions) ? path.seedContributions : [],
          edge: {
            edgeId: clean(edge.edgeId),
            relation: clean(edge.relation),
            traversalFromMemoryId: clean(edge.traversalFromMemoryId),
            traversalToMemoryId: clean(edge.traversalToMemoryId),
            relationView: clean(edge.relationView),
          },
          distanceDecay: REWARD_PATH_ELIGIBILITY_DECAY,
          normalization: "sum-to-one-per-target-memory",
          baseEdgeWeightEffect: "none",
          automaticStateMutationAllowed: false,
        },
      });
    });
  }
  return values;
}
