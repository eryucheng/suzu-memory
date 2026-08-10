function clean(value) {
  return String(value ?? "").trim();
}

function division(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : 0;
}

function eligibleKey(item, idKey) {
  if (clean(item?.status) !== "eligible") return "";
  const id = clean(item?.[idKey]);
  const direction = clean(item?.direction || item?.rewardDirection);
  return id && direction ? `${id}\u001f${direction}` : "";
}

function setOfEligible(values, idKey) {
  return new Set((Array.isArray(values) ? values : []).map((item) => (
    eligibleKey(item, idKey)
  )).filter(Boolean));
}

function decisionKey(item, idKey) {
  const id = clean(item?.[idKey]);
  const status = clean(item?.status);
  const direction = clean(item?.direction || item?.rewardDirection);
  return id && status && direction ? `${id}\u001f${status}\u001f${direction}` : "";
}

function contributionKey(item) {
  const id = clean(item?.memoryId);
  const contributionClass = clean(item?.contributionClass);
  return id && contributionClass ? `${id}\u001f${contributionClass}` : "";
}

function keyedSet(values, keyFunction) {
  return new Set((Array.isArray(values) ? values : []).map(keyFunction).filter(Boolean));
}

function sameSet(left, right) {
  return left.size === right.size && [...left].every((value) => right.has(value));
}

function confusion(expected, actual) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const key of actual) {
    if (expected.has(key)) truePositive += 1;
    else falsePositive += 1;
  }
  for (const key of expected) {
    if (!actual.has(key)) falseNegative += 1;
  }
  const precision = division(truePositive, truePositive + falsePositive);
  const recall = division(truePositive, truePositive + falseNegative);
  return {
    truePositive,
    falsePositive,
    falseNegative,
    precision,
    recall,
    f1: division(2 * precision * recall, precision + recall),
  };
}

function macroF1(expectedLabels, actualLabels) {
  const labels = [...new Set([...expectedLabels, ...actualLabels])].filter(Boolean);
  if (!labels.length) return 0;
  return labels.reduce((sum, label) => {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    expectedLabels.forEach((expected, index) => {
      const actual = actualLabels[index];
      if (expected === label && actual === label) truePositive += 1;
      else if (expected !== label && actual === label) falsePositive += 1;
      else if (expected === label && actual !== label) falseNegative += 1;
    });
    const precision = division(truePositive, truePositive + falsePositive);
    const recall = division(truePositive, truePositive + falseNegative);
    return sum + division(2 * precision * recall, precision + recall);
  }, 0) / labels.length;
}

function boundedViolation(item, limits = {}) {
  const consolidation = Math.abs(Number(
    item?.consolidationDelta ?? item?.proposedConsolidationDelta ?? 0,
  ));
  const utility = Math.abs(Number(item?.utilityDelta ?? item?.proposedUtilityDelta ?? 0));
  return consolidation > Number(limits.maximumConsolidationDelta ?? 1)
    || utility > Number(limits.maximumUtilityDelta ?? 1);
}

export function evaluateRewardCreditCalibration({ cases = [], results = [] } = {}) {
  if (!Array.isArray(cases) || !Array.isArray(results)) {
    throw new Error("Reward calibration requires cases and results arrays.");
  }
  const resultById = new Map(results.map((item) => [clean(item?.caseId), item]));
  const expectedOutcome = [];
  const actualOutcome = [];
  const expectedTarget = [];
  const actualTarget = [];
  const expectedNodeCredit = new Set();
  const actualNodeCredit = new Set();
  const expectedEdgeCredit = new Set();
  const actualEdgeCredit = new Set();
  const expectedMemoryDecisions = new Set();
  const actualMemoryDecisions = new Set();
  const expectedPathDecisions = new Set();
  const actualPathDecisions = new Set();
  const expectedContributionClasses = new Set();
  const actualContributionClasses = new Set();
  const caseReports = [];
  let affectCases = 0;
  let affectFalsePositiveCases = 0;
  let correctionCases = 0;
  let correctionForgettingCases = 0;
  let invariantMutationCases = 0;
  let boundedViolationCount = 0;
  let actualProposalCount = 0;
  let targetMemoryExactCases = 0;
  let evidenceTierCorrectCases = 0;
  let contributionShareAbsoluteError = 0;
  let contributionShareComparisons = 0;
  let expectedEligibleDecisionCount = 0;
  let conservativeDeferralCount = 0;
  for (const item of cases) {
    const caseId = clean(item?.caseId);
    if (!caseId) throw new Error("Reward calibration case requires caseId.");
    const actual = resultById.get(caseId) || {};
    const expected = item.expected || {};
    expectedOutcome.push(clean(expected.outcomeClass));
    actualOutcome.push(clean(actual.outcomeClass));
    expectedTarget.push(clean(expected.feedbackTarget));
    actualTarget.push(clean(actual.feedbackTarget));
    const expectedNodes = setOfEligible(expected.memoryCredits, "memoryId");
    const actualNodes = setOfEligible(actual.memoryCredits, "memoryId");
    const expectedEdges = setOfEligible(expected.pathCredits, "edgeId");
    const actualEdges = setOfEligible(actual.pathCredits, "edgeId");
    const expectedMemoryDecisionSet = keyedSet(expected.memoryCredits, (credit) => decisionKey(credit, "memoryId"));
    const actualMemoryDecisionSet = keyedSet(actual.memoryCredits, (credit) => decisionKey(credit, "memoryId"));
    const expectedPathDecisionSet = keyedSet(expected.pathCredits, (credit) => decisionKey(credit, "edgeId"));
    const actualPathDecisionSet = keyedSet(actual.pathCredits, (credit) => decisionKey(credit, "edgeId"));
    const expectedContributionSet = keyedSet(expected.memoryCredits, contributionKey);
    const actualContributionSet = keyedSet(actual.memoryCredits, contributionKey);
    for (const key of expectedNodes) expectedNodeCredit.add(`${caseId}\u001f${key}`);
    for (const key of actualNodes) actualNodeCredit.add(`${caseId}\u001f${key}`);
    for (const key of expectedEdges) expectedEdgeCredit.add(`${caseId}\u001f${key}`);
    for (const key of actualEdges) actualEdgeCredit.add(`${caseId}\u001f${key}`);
    for (const key of expectedMemoryDecisionSet) expectedMemoryDecisions.add(`${caseId}\u001f${key}`);
    for (const key of actualMemoryDecisionSet) actualMemoryDecisions.add(`${caseId}\u001f${key}`);
    for (const key of expectedPathDecisionSet) expectedPathDecisions.add(`${caseId}\u001f${key}`);
    for (const key of actualPathDecisionSet) actualPathDecisions.add(`${caseId}\u001f${key}`);
    for (const key of expectedContributionSet) expectedContributionClasses.add(`${caseId}\u001f${key}`);
    for (const key of actualContributionSet) actualContributionClasses.add(`${caseId}\u001f${key}`);
    const expectedTargets = new Set(Array.isArray(expected.targetMemoryIds) ? expected.targetMemoryIds.map(clean) : []);
    const actualTargets = new Set(Array.isArray(actual.targetMemoryIds) ? actual.targetMemoryIds.map(clean) : []);
    if (sameSet(expectedTargets, actualTargets)) targetMemoryExactCases += 1;
    if (clean(expected.evidenceTier) === clean(actual.evidenceTier)) evidenceTierCorrectCases += 1;
    const actualCreditByMemory = new Map((Array.isArray(actual.memoryCredits) ? actual.memoryCredits : []).map((credit) => [
      clean(credit.memoryId),
      credit,
    ]));
    for (const expectedCredit of Array.isArray(expected.memoryCredits) ? expected.memoryCredits : []) {
      const actualCredit = actualCreditByMemory.get(clean(expectedCredit.memoryId));
      if (!actualCredit) continue;
      if (clean(expectedCredit.status) === "eligible") {
        expectedEligibleDecisionCount += 1;
        if (clean(actualCredit.status) === "pending") conservativeDeferralCount += 1;
      }
      contributionShareAbsoluteError += Math.abs(
        Number(expectedCredit.contributionShare || 0) - Number(actualCredit.contributionShare || 0),
      );
      contributionShareComparisons += 1;
    }
    const actualEligible = [...actualNodes, ...actualEdges];
    const actualPathByEdge = new Map((Array.isArray(actual.pathCredits) ? actual.pathCredits : []).map((credit) => [
      clean(credit.edgeId),
      credit,
    ]));
    for (const expectedCredit of Array.isArray(expected.pathCredits) ? expected.pathCredits : []) {
      const actualCredit = actualPathByEdge.get(clean(expectedCredit.edgeId));
      if (clean(expectedCredit.status) === "eligible") {
        expectedEligibleDecisionCount += 1;
        if (clean(actualCredit?.status) === "pending") conservativeDeferralCount += 1;
      }
    }
    const category = clean(item.category);
    if (category === "social_affect") {
      affectCases += 1;
      if (actualEligible.length) affectFalsePositiveCases += 1;
    }
    if (category === "correction") {
      correctionCases += 1;
      const negativeCredit = [
        ...(Array.isArray(actual.memoryCredits) ? actual.memoryCredits : []),
        ...(Array.isArray(actual.pathCredits) ? actual.pathCredits : []),
      ].some((credit) => (
        clean(credit?.status) === "eligible"
        && clean(credit?.direction || credit?.rewardDirection) === "decrease"
      ));
      if (negativeCredit) correctionForgettingCases += 1;
    }
    const forbidden = new Set(Array.isArray(expected.mustNotChange) ? expected.mustNotChange : []);
    const mutations = Array.isArray(actual.mutations) ? actual.mutations : [];
    const invariantMutation = mutations.some((mutation) => forbidden.has(clean(mutation?.field)));
    if (invariantMutation) invariantMutationCases += 1;
    const proposals = [
      ...(Array.isArray(actual.memoryCredits) ? actual.memoryCredits : []),
      ...(Array.isArray(actual.pathCredits) ? actual.pathCredits : []),
    ];
    actualProposalCount += proposals.length;
    const caseBoundedViolations = proposals.filter((proposal) => (
      boundedViolation(proposal, expected.limits)
    )).length;
    boundedViolationCount += caseBoundedViolations;
    caseReports.push({
      caseId,
      missingResult: !resultById.has(caseId),
      outcomeCorrect: expectedOutcome.at(-1) === actualOutcome.at(-1),
      targetCorrect: expectedTarget.at(-1) === actualTarget.at(-1),
      evidenceTierCorrect: clean(expected.evidenceTier) === clean(actual.evidenceTier),
      targetMemoryIdsCorrect: sameSet(expectedTargets, actualTargets),
      nodeCredit: confusion(expectedNodes, actualNodes),
      pathCredit: confusion(expectedEdges, actualEdges),
      memoryDecision: confusion(expectedMemoryDecisionSet, actualMemoryDecisionSet),
      pathDecision: confusion(expectedPathDecisionSet, actualPathDecisionSet),
      contributionClass: confusion(expectedContributionSet, actualContributionSet),
      memoryDecisionExact: sameSet(expectedMemoryDecisionSet, actualMemoryDecisionSet),
      pathDecisionExact: sameSet(expectedPathDecisionSet, actualPathDecisionSet),
      conservativeDeferralCount: [
        ...(Array.isArray(expected.memoryCredits) ? expected.memoryCredits : []).map((credit) => ({
          expected: credit,
          actual: actualCreditByMemory.get(clean(credit.memoryId)),
        })),
        ...(Array.isArray(expected.pathCredits) ? expected.pathCredits : []).map((credit) => ({
          expected: credit,
          actual: actualPathByEdge.get(clean(credit.edgeId)),
        })),
      ].filter(({ expected: expectedCredit, actual: actualCredit }) => (
        clean(expectedCredit?.status) === "eligible" && clean(actualCredit?.status) === "pending"
      )).length,
      invariantMutation,
      boundedViolationCount: caseBoundedViolations,
    });
  }
  const nodeCredit = confusion(expectedNodeCredit, actualNodeCredit);
  const pathCredit = confusion(expectedEdgeCredit, actualEdgeCredit);
  const memoryDecision = confusion(expectedMemoryDecisions, actualMemoryDecisions);
  const pathDecision = confusion(expectedPathDecisions, actualPathDecisions);
  const contributionClass = confusion(expectedContributionClasses, actualContributionClasses);
  const overCreditCount = nodeCredit.falsePositive + pathCredit.falsePositive;
  const actualEligibleCount = actualNodeCredit.size + actualEdgeCredit.size;
  return {
    cases: cases.length,
    results: resultById.size,
    outcomeAccuracy: division(
      caseReports.filter((item) => item.outcomeCorrect).length,
      cases.length,
    ),
    outcomeMacroF1: macroF1(expectedOutcome, actualOutcome),
    feedbackTargetAccuracy: division(
      caseReports.filter((item) => item.targetCorrect).length,
      cases.length,
    ),
    evidenceTierAccuracy: division(evidenceTierCorrectCases, cases.length),
    targetMemoryIdsExactRate: division(targetMemoryExactCases, cases.length),
    nodeCredit,
    pathCredit,
    memoryDecision,
    pathDecision,
    contributionClass,
    memoryDecisionExactRate: division(
      caseReports.filter((item) => item.memoryDecisionExact).length,
      cases.length,
    ),
    pathDecisionExactRate: division(
      caseReports.filter((item) => item.pathDecisionExact).length,
      cases.length,
    ),
    contributionShareMae: division(contributionShareAbsoluteError, contributionShareComparisons),
    conservativeDeferralRate: division(conservativeDeferralCount, expectedEligibleDecisionCount),
    overCreditRate: division(overCreditCount, actualEligibleCount),
    affectAsRewardFalsePositiveRate: division(affectFalsePositiveCases, affectCases),
    correctionForgettingRate: division(correctionForgettingCases, correctionCases),
    invariantMutationRate: division(invariantMutationCases, cases.length),
    boundedDeltaViolationRate: division(boundedViolationCount, actualProposalCount),
    caseReports,
  };
}

export function rewardCalibrationResultFromObservation({
  repository,
  agentId,
  observationId,
  caseId = "",
} = {}) {
  if (!repository) throw new Error("Reward calibration result requires repository.");
  const observation = repository.getRewardObservation(agentId, observationId);
  if (!observation) throw new Error("Reward calibration observation was not found.");
  const runs = repository.listRewardAnalysisRuns(agentId, observationId);
  const latest = new Map();
  for (const run of runs) {
    if (run.status === "completed") latest.set(run.analyzer_role, run);
  }
  const outcome = latest.get("outcome")?.output || {};
  const target = latest.get("target")?.output || {};
  const credit = latest.get("credit")?.output || {};
  const creditConfidenceByMemory = Object.fromEntries(
    (Array.isArray(credit.analyses) ? credit.analyses : [])
      .map((item) => [clean(item?.memoryId), Number(item?.confidence)])
      .filter(([memoryId, value]) => memoryId && Number.isFinite(value)),
  );
  return {
    caseId: clean(caseId) || clean(observationId),
    observationId: clean(observationId),
    outcomeClass: clean(outcome.outcomeClass),
    evidenceTier: clean(outcome.evidenceTier),
    feedbackTarget: clean(target.targetType),
    targetMemoryIds: Array.isArray(target.targetMemoryIds) ? target.targetMemoryIds.map(clean) : [],
    analyzerConfidence: {
      outcome: Number.isFinite(Number(outcome.confidence)) ? Number(outcome.confidence) : null,
      target: Number.isFinite(Number(target.confidence)) ? Number(target.confidence) : null,
      creditByMemory: creditConfidenceByMemory,
    },
    memoryCredits: repository.listRewardCreditProposals(agentId, {
      observationId,
      limit: 500,
    }).map((proposal) => ({
      memoryId: proposal.memory_id,
      status: proposal.status,
      direction: proposal.reward_direction,
      contributionClass: proposal.contribution_class,
      contributionShare: proposal.contribution_share,
      consolidationDelta: proposal.proposed_consolidation_delta,
      utilityDelta: proposal.proposed_utility_delta,
      reasonCode: clean(proposal.evidence?.reasonCode),
      combinedConfidence: Number.isFinite(Number(proposal.evidence?.combinedConfidence))
        ? Number(proposal.evidence.combinedConfidence)
        : null,
    })),
    pathCredits: repository.listRewardPathCreditProposals(agentId, {
      observationId,
      limit: 5000,
    }).map((proposal) => ({
      edgeId: proposal.edge_id,
      memoryId: proposal.memory_id,
      status: proposal.status,
      direction: proposal.reward_direction,
      utilityDelta: proposal.proposed_utility_delta,
      distanceFromTarget: proposal.distance_from_target,
      eligibilityWeight: proposal.eligibility_weight,
    })),
    mutations: [],
  };
}
