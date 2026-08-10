import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { calculateCost } from "@suzu-memory/usage-ledger";

function clean(value) {
  return String(value ?? "").trim();
}

function stringArray(value, field, { allowEmpty = true } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${field} 必须是字符串数组。`);
  const values = value.map((item) => clean(item));
  if (values.some((item) => !item)) throw new Error(`${field} 不能包含空字符串。`);
  if (!allowEmpty && !values.length) throw new Error(`${field} 不能为空。`);
  return values;
}

function oneOrMany(value, field) {
  if (value === undefined) return [];
  if (Array.isArray(value)) return stringArray(value, field, { allowEmpty: false });
  const normalized = clean(value);
  if (!normalized) throw new Error(`${field} 不能为空。`);
  return [normalized];
}

function optionalNonNegativeInteger(value, field) {
  if (value === undefined) return undefined;
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`${field} 必须是非负整数。`);
  }
  return normalized;
}

function uniqueStrings(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(clean).filter(Boolean))];
}

function normalizeSubjectExpectation(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expect.expectedSubjects[${index}] 必须是对象。`);
  }
  const memoryId = clean(value.memoryId);
  const role = clean(value.role);
  const key = clean(value.key);
  if (!memoryId) throw new Error(`expect.expectedSubjects[${index}].memoryId 不能为空。`);
  if (!role && !key) {
    throw new Error(`expect.expectedSubjects[${index}] 至少需要 role 或 key。`);
  }
  return { memoryId, role, key };
}

function normalizePrimarySubject(value, field) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象。`);
  }
  const role = clean(value.role);
  const key = clean(value.key);
  if (!role && !key) throw new Error(`${field} 至少需要 role 或 key。`);
  return { role, key };
}

export function normalizeEvaluationCase(value, index = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`cases[${index}] 必须是对象。`);
  }
  const id = clean(value.id);
  const query = clean(value.query);
  const category = clean(value.category) || "uncategorized";
  if (!id) throw new Error(`cases[${index}].id 不能为空。`);
  if (!query) throw new Error(`cases[${index}].query 不能为空。`);
  const expectation = value.expect;
  if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) {
    throw new Error(`cases[${index}].expect 必须是对象。`);
  }
  const expectedSubjects = expectation.expectedSubjects === undefined
    ? []
    : expectation.expectedSubjects.map(normalizeSubjectExpectation);
  return {
    id,
    title: clean(value.title) || id,
    category,
    query,
    anchorMemoryIds: stringArray(value.anchorMemoryIds, `cases[${index}].anchorMemoryIds`),
    now: clean(value.now),
    tags: stringArray(value.tags, `cases[${index}].tags`),
    expect: {
      statuses: oneOrMany(expectation.status, `cases[${index}].expect.status`),
      recallIntents: oneOrMany(
        expectation.recallIntent,
        `cases[${index}].expect.recallIntent`,
      ),
      chainModes: oneOrMany(expectation.chainMode, `cases[${index}].expect.chainMode`),
      chainDirections: oneOrMany(
        expectation.chainDirection,
        `cases[${index}].expect.chainDirection`,
      ),
      retrievalModes: oneOrMany(
        expectation.retrievalMode,
        `cases[${index}].expect.retrievalMode`,
      ),
      disclosureLevels: oneOrMany(
        expectation.disclosureLevel,
        `cases[${index}].expect.disclosureLevel`,
      ),
      primaryMemoryIds: stringArray(
        expectation.primaryMemoryIds,
        `cases[${index}].expect.primaryMemoryIds`,
      ),
      rankingMemoryIds: expectation.rankingMemoryIds === undefined
        ? []
        : stringArray(
          expectation.rankingMemoryIds,
          `cases[${index}].expect.rankingMemoryIds`,
          { allowEmpty: false },
        ),
      rankingMemoryIdsExplicit: expectation.rankingMemoryIds !== undefined,
      requiredMemoryIds: stringArray(
        expectation.requiredMemoryIds,
        `cases[${index}].expect.requiredMemoryIds`,
      ),
      forbiddenMemoryIds: stringArray(
        expectation.forbiddenMemoryIds,
        `cases[${index}].expect.forbiddenMemoryIds`,
      ),
      requiredEvidenceIds: stringArray(
        expectation.requiredEvidenceIds,
        `cases[${index}].expect.requiredEvidenceIds`,
      ),
      requiredSupportEvidenceIds: stringArray(
        expectation.requiredSupportEvidenceIds,
        `cases[${index}].expect.requiredSupportEvidenceIds`,
      ),
      requiredCounterevidenceIds: stringArray(
        expectation.requiredCounterevidenceIds,
        `cases[${index}].expect.requiredCounterevidenceIds`,
      ),
      forbiddenEvidenceIds: stringArray(
        expectation.forbiddenEvidenceIds,
        `cases[${index}].expect.forbiddenEvidenceIds`,
      ),
      requiredSubjectRejectedIds: stringArray(
        expectation.requiredSubjectRejectedIds,
        `cases[${index}].expect.requiredSubjectRejectedIds`,
      ),
      requiredGraphSubjectRejectedIds: stringArray(
        expectation.requiredGraphSubjectRejectedIds,
        `cases[${index}].expect.requiredGraphSubjectRejectedIds`,
      ),
      requiredStateSuppressedIds: stringArray(
        expectation.requiredStateSuppressedIds,
        `cases[${index}].expect.requiredStateSuppressedIds`,
      ),
      requiredPathMemoryIds: stringArray(
        expectation.requiredPathMemoryIds,
        `cases[${index}].expect.requiredPathMemoryIds`,
      ),
      forbiddenPathMemoryIds: stringArray(
        expectation.forbiddenPathMemoryIds,
        `cases[${index}].expect.forbiddenPathMemoryIds`,
      ),
      requiredPathRelations: stringArray(
        expectation.requiredPathRelations,
        `cases[${index}].expect.requiredPathRelations`,
      ),
      forbiddenPathRelations: stringArray(
        expectation.forbiddenPathRelations,
        `cases[${index}].expect.forbiddenPathRelations`,
      ),
      requireUntruncatedActivation: expectation.requireUntruncatedActivation === undefined
        ? undefined
        : Boolean(expectation.requireUntruncatedActivation),
      contextIncludes: stringArray(
        expectation.contextIncludes,
        `cases[${index}].expect.contextIncludes`,
      ),
      contextExcludes: stringArray(
        expectation.contextExcludes,
        `cases[${index}].expect.contextExcludes`,
      ),
      expectedSubjects,
      primarySubject: normalizePrimarySubject(
        expectation.primarySubject,
        `cases[${index}].expect.primarySubject`,
      ),
      emptyContext: expectation.emptyContext === undefined
        ? undefined
        : Boolean(expectation.emptyContext),
      maximumContextChars: optionalNonNegativeInteger(
        expectation.maximumContextChars,
        `cases[${index}].expect.maximumContextChars`,
      ),
      minimumSelectedMemories: optionalNonNegativeInteger(
        expectation.minimumSelectedMemories,
        `cases[${index}].expect.minimumSelectedMemories`,
      ),
      maximumSelectedMemories: optionalNonNegativeInteger(
        expectation.maximumSelectedMemories,
        `cases[${index}].expect.maximumSelectedMemories`,
      ),
      maximumCandidates: optionalNonNegativeInteger(
        expectation.maximumCandidates,
        `cases[${index}].expect.maximumCandidates`,
      ),
    },
  };
}

function isNormalizedEvaluationCase(value) {
  return Boolean(
    value
    && typeof value === "object"
    && Array.isArray(value.expect?.statuses)
    && Array.isArray(value.expect?.requiredMemoryIds),
  );
}

function loadJson(filePath) {
  const text = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  return JSON.parse(text);
}

export function loadEvaluationCases(filePath) {
  const resolved = path.resolve(filePath);
  const document = loadJson(resolved);
  const rawCases = Array.isArray(document) ? document : document?.cases;
  if (!Array.isArray(rawCases)) {
    throw new Error(`${resolved} 必须是案例数组，或包含 cases 数组的对象。`);
  }
  const cases = rawCases.map(normalizeEvaluationCase);
  const ids = new Set();
  for (const item of cases) {
    if (ids.has(item.id)) throw new Error(`评测案例ID重复：${item.id}`);
    ids.add(item.id);
  }
  return {
    sourcePath: resolved,
    version: Number(Array.isArray(document) ? 1 : document.version || 1),
    description: clean(Array.isArray(document) ? "" : document.description),
    cases,
  };
}

function selectedMemoryIds(result) {
  const values = result?.graph?.selectedMemoryIds
    || result?.fragments?.flatMap((fragment) => fragment.memoryIds || [fragment.memoryId])
    || [];
  return [...new Set(values.map(clean).filter(Boolean))];
}

function disclosedEvidenceIds(result) {
  const values = result?.graph?.evidenceMemoryIds
    || result?.fragments?.flatMap((fragment) => fragment.evidenceIds || [])
    || [];
  return [...new Set(values.map(clean).filter(Boolean))];
}

function observedMemories(result) {
  const values = Array.isArray(result?.observedMemories) ? result.observedMemories : [];
  return new Map(values.map((memory) => [clean(memory.id), memory]));
}

function comparison(rule, passed, expected, actual) {
  return { rule, passed: Boolean(passed), expected, actual };
}

function includesEvery(actual, expected) {
  return expected.every((value) => actual.includes(value));
}

function excludesEvery(actual, forbidden) {
  return forbidden.every((value) => !actual.includes(value));
}

function addOneOfAssertion(assertions, rule, expected, actual) {
  if (!expected.length) return;
  assertions.push(comparison(rule, expected.includes(clean(actual)), expected, clean(actual)));
}

function contextHash(context) {
  return context
    ? createHash("sha256").update(context, "utf8").digest("hex")
    : "";
}

function finiteMetric(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function discountedCumulativeGain(rankedIds, relevantIds, cutoff) {
  const relevant = new Set(relevantIds);
  return rankedIds.slice(0, cutoff).reduce((sum, memoryId, index) => (
    relevant.has(memoryId) ? sum + (1 / Math.log2(index + 2)) : sum
  ), 0);
}

function candidateRankingMetrics(expectations, candidateIds) {
  const explicitTargets = uniqueStrings(expectations.rankingMemoryIds || []);
  const primaryTargets = uniqueStrings(expectations.primaryMemoryIds || []);
  const targetMemoryIds = explicitTargets.length ? explicitTargets : primaryTargets;
  if (!targetMemoryIds.length) {
    return {
      eligible: false,
      judgment: "none",
      targetMemoryIds: [],
      completeRelevanceJudgment: false,
    };
  }
  const completeRelevanceJudgment = Boolean(expectations.rankingMemoryIdsExplicit)
    || (!explicitTargets.length && primaryTargets.length === 1);
  const relevant = new Set(targetMemoryIds);
  const firstRelevantIndex = candidateIds.findIndex((memoryId) => relevant.has(memoryId));
  const firstRelevantRank = firstRelevantIndex >= 0 ? firstRelevantIndex + 1 : null;
  const hitsAt = (cutoff) => candidateIds
    .slice(0, cutoff)
    .filter((memoryId) => relevant.has(memoryId)).length;
  const recallAt = (cutoff) => completeRelevanceJudgment
    ? finiteMetric(hitsAt(cutoff) / targetMemoryIds.length)
    : null;
  const idealCountAt5 = Math.min(5, targetMemoryIds.length);
  const idealDcgAt5 = completeRelevanceJudgment
    ? discountedCumulativeGain(targetMemoryIds.slice(0, idealCountAt5), targetMemoryIds, 5)
    : 0;
  return {
    eligible: true,
    judgment: explicitTargets.length
      ? "explicit-ranking-set"
      : primaryTargets.length === 1 ? "single-primary" : "accepted-primary-alternatives",
    targetMemoryIds,
    completeRelevanceJudgment,
    candidateCount: candidateIds.length,
    firstRelevantRank,
    reciprocalRank: firstRelevantRank ? finiteMetric(1 / firstRelevantRank) : 0,
    hitAt1: hitsAt(1) > 0,
    hitAt3: hitsAt(3) > 0,
    hitAt5: hitsAt(5) > 0,
    recallAt1: recallAt(1),
    recallAt3: recallAt(3),
    recallAt5: recallAt(5),
    ndcgAt5: completeRelevanceJudgment && idealDcgAt5 > 0
      ? finiteMetric(discountedCumulativeGain(candidateIds, targetMemoryIds, 5) / idealDcgAt5)
      : null,
  };
}

function primarySelectionMetrics(expectations, primaryMemoryId) {
  const acceptedMemoryIds = uniqueStrings(expectations.primaryMemoryIds || []);
  if (!acceptedMemoryIds.length) {
    return {
      eligible: false,
      acceptedMemoryIds: [],
      actualMemoryId: primaryMemoryId || "",
      correct: null,
    };
  }
  return {
    eligible: true,
    acceptedMemoryIds,
    actualMemoryId: primaryMemoryId || "",
    correct: Boolean(primaryMemoryId && acceptedMemoryIds.includes(primaryMemoryId)),
  };
}

function graphExpansionMetrics(result) {
  const paths = Array.isArray(result?.graph?.paths) ? result.graph.paths : [];
  const activation = result?.graph?.activationField;
  const pathMemoryIds = uniqueStrings(paths.map((item) => item?.memoryId));
  const edges = paths.flatMap((item) => (Array.isArray(item?.edges) ? item.edges : []));
  const fanouts = edges.map((edge) => Number(edge?.fanout)).filter(Number.isFinite);
  const fanoutFactors = edges
    .map((edge) => Number(edge?.fanoutFactor))
    .filter(Number.isFinite);
  return {
    eligible: Boolean(activation && typeof activation === "object"),
    relationView: clean(activation?.relationView),
    pathCount: paths.length,
    pathMemoryIds,
    traversedEdgeIds: uniqueStrings(edges.map((edge) => edge?.edgeId)),
    traversedRelations: uniqueStrings(edges.map((edge) => edge?.relation)),
    maximumDepth: paths.reduce((maximum, item) => (
      Math.max(maximum, Array.isArray(item?.edges) ? item.edges.length : 0)
    ), 0),
    processedStates: Math.max(0, Number(activation?.processedStates) || 0),
    workBudgetTruncated: Boolean(activation?.truncated),
    seedCount: Array.isArray(activation?.seedMemoryIds) ? activation.seedMemoryIds.length : 0,
    selectedActivationCount: Array.isArray(activation?.selected)
      ? activation.selected.length
      : 0,
    maximumFanout: fanouts.length ? Math.max(...fanouts) : 0,
    minimumFanoutFactor: fanoutFactors.length
      ? finiteMetric(Math.min(...fanoutFactors))
      : null,
    mandatoryTraversalCount: edges.filter((edge) => (
      clean(edge?.propagationPolicy) === "mandatory"
    )).length,
    convergedSeedCount: Array.isArray(result?.graph?.convergedSeeds?.memoryIds)
      ? result.graph.convergedSeeds.memoryIds.length
      : 0,
  };
}

function outputBudgetMetrics(result) {
  const budget = result?.outputBudget;
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) {
    return { eligible: false };
  }
  const availableTextChars = Math.max(0, Number(budget.availableTextChars) || 0);
  const finalTextChars = Math.max(0, Number(budget.finalTextChars) || 0);
  const budgetedTextChars = Math.max(
    0,
    Number(budget.budgetedTextChars ?? budget.finalTextChars) || 0,
  );
  return {
    eligible: true,
    maximumContextChars: Math.max(0, Number(budget.maximumContextChars) || 0),
    availableTextChars,
    requiredTextChars: Math.max(0, Number(budget.requiredTextChars) || 0),
    budgetedTextChars,
    finalTextChars,
    utilization: availableTextChars > 0
      ? finiteMetric(finalTextChars / availableTextChars)
      : null,
    sectionTruncationApplied: Boolean(budget.sectionTruncationApplied),
    safetyTruncationApplied: Boolean(budget.safetyTruncationApplied),
  };
}

function externalUsageMetrics(result, customPriceRevisions = []) {
  const records = Array.isArray(result?.evaluationUsage) ? result.evaluationUsage : [];
  const requests = records.map((record) => {
    const cost = calculateCost({
      customRevisions: customPriceRevisions,
      model: clean(record?.model),
      timestamp: clean(record?.timestamp),
      usage: record?.usage || {},
    });
    return {
      provider: clean(record?.provider),
      model: clean(record?.model),
      requestId: clean(record?.requestId),
      usage: record?.usage || {},
      units: cost.units,
      costStatus: cost.status,
      amountCny: Number.isFinite(cost.amountCny) ? finiteMetric(cost.amountCny) : null,
    };
  });
  const priced = requests.filter((request) => request.amountCny !== null);
  return {
    requestCount: requests.length,
    pricedRequestCount: priced.length,
    unknownPriceRequestCount: requests.length - priced.length,
    amountCny: finiteMetric(priced.reduce((sum, request) => sum + request.amountCny, 0)),
    requests,
  };
}

function normalizedRouteStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([route, status]) => [clean(route), clean(status)])
    .filter(([route, status]) => route && status));
}

function primaryCandidateRoutes(result, primaryMemoryId) {
  if (!primaryMemoryId) return [];
  const candidates = [
    ...(Array.isArray(result?.candidates) ? result.candidates : []),
    ...(Array.isArray(result?.seedRouting?.candidates) ? result.seedRouting.candidates : []),
  ];
  const candidate = candidates.find((entry) => clean(entry?.memoryId) === primaryMemoryId);
  return uniqueStrings((candidate?.routeMatches || candidate?.routes || [])
    .map((route) => route?.route));
}

export function evaluateRetrievalResult(testCase, result, {
  includeContext = false,
  customPriceRevisions = [],
} = {}) {
  const item = isNormalizedEvaluationCase(testCase)
    ? testCase
    : normalizeEvaluationCase(testCase);
  const expectations = item.expect;
  const context = String(result?.context || "");
  const selected = selectedMemoryIds(result);
  const evidenceIds = disclosedEvidenceIds(result);
  const supportEvidenceIds = stringArray(
    result?.graph?.supportEvidenceMemoryIds,
    "result.graph.supportEvidenceMemoryIds",
  );
  const counterevidenceIds = stringArray(
    result?.graph?.counterevidenceMemoryIds,
    "result.graph.counterevidenceMemoryIds",
  );
  const subjectRejectedIds = stringArray(
    result?.seedRouting?.subjectRouting?.hardRejectedCandidateIds,
    "result.seedRouting.subjectRouting.hardRejectedCandidateIds",
  );
  const graphSubjectRejectedIds = stringArray(
    result?.seedRouting?.subjectRouting?.hardRejectedGraphMemoryIds,
    "result.seedRouting.subjectRouting.hardRejectedGraphMemoryIds",
  );
  const stateSuppressedIds = stringArray(
    result?.seedRouting?.stateRouting?.suppressedMemoryIds,
    "result.seedRouting.stateRouting.suppressedMemoryIds",
  );
  const candidateIds = uniqueStrings((result?.candidates || [])
    .map((candidate) => candidate?.memoryId));
  const primaryMemoryId = clean(result?.graph?.seedId || result?.fragments?.[0]?.memoryId);
  const graphExpansion = graphExpansionMetrics(result);
  const memories = observedMemories(result);
  const primaryMemory = memories.get(primaryMemoryId);
  const assertions = [];

  addOneOfAssertion(assertions, "status", expectations.statuses, result?.status);
  addOneOfAssertion(assertions, "recall-intent", expectations.recallIntents, result?.recallIntent);
  addOneOfAssertion(assertions, "chain-mode", expectations.chainModes, result?.chainIntent?.mode);
  addOneOfAssertion(
    assertions,
    "chain-direction",
    expectations.chainDirections,
    result?.chainIntent?.direction,
  );
  addOneOfAssertion(
    assertions,
    "retrieval-mode",
    expectations.retrievalModes,
    result?.retrievalMode,
  );
  addOneOfAssertion(
    assertions,
    "disclosure-level",
    expectations.disclosureLevels,
    result?.disclosureLevel,
  );
  if (expectations.primaryMemoryIds.length) {
    assertions.push(comparison(
      "primary-memory",
      expectations.primaryMemoryIds.includes(primaryMemoryId),
      expectations.primaryMemoryIds,
      primaryMemoryId,
    ));
  }
  if (expectations.requiredMemoryIds.length) {
    assertions.push(comparison(
      "required-memories",
      includesEvery(selected, expectations.requiredMemoryIds),
      expectations.requiredMemoryIds,
      selected,
    ));
  }
  if (expectations.forbiddenMemoryIds.length) {
    assertions.push(comparison(
      "forbidden-memories",
      excludesEvery(selected, expectations.forbiddenMemoryIds),
      expectations.forbiddenMemoryIds,
      selected,
    ));
  }
  if (expectations.requiredEvidenceIds.length) {
    assertions.push(comparison(
      "required-evidence",
      includesEvery(evidenceIds, expectations.requiredEvidenceIds),
      expectations.requiredEvidenceIds,
      evidenceIds,
    ));
  }
  if (expectations.requiredSupportEvidenceIds.length) {
    assertions.push(comparison(
      "required-support-evidence",
      includesEvery(supportEvidenceIds, expectations.requiredSupportEvidenceIds),
      expectations.requiredSupportEvidenceIds,
      supportEvidenceIds,
    ));
  }
  if (expectations.requiredCounterevidenceIds.length) {
    assertions.push(comparison(
      "required-counterevidence",
      includesEvery(counterevidenceIds, expectations.requiredCounterevidenceIds),
      expectations.requiredCounterevidenceIds,
      counterevidenceIds,
    ));
  }
  if (expectations.forbiddenEvidenceIds.length) {
    assertions.push(comparison(
      "forbidden-evidence",
      excludesEvery(evidenceIds, expectations.forbiddenEvidenceIds),
      expectations.forbiddenEvidenceIds,
      evidenceIds,
    ));
  }
  if (expectations.requiredSubjectRejectedIds.length) {
    assertions.push(comparison(
      "required-subject-rejections",
      includesEvery(subjectRejectedIds, expectations.requiredSubjectRejectedIds),
      expectations.requiredSubjectRejectedIds,
      subjectRejectedIds,
    ));
  }
  if (expectations.requiredGraphSubjectRejectedIds.length) {
    assertions.push(comparison(
      "required-graph-subject-rejections",
      includesEvery(graphSubjectRejectedIds, expectations.requiredGraphSubjectRejectedIds),
      expectations.requiredGraphSubjectRejectedIds,
      graphSubjectRejectedIds,
    ));
  }
  if (expectations.requiredStateSuppressedIds.length) {
    assertions.push(comparison(
      "required-state-suppressions",
      includesEvery(stateSuppressedIds, expectations.requiredStateSuppressedIds),
      expectations.requiredStateSuppressedIds,
      stateSuppressedIds,
    ));
  }
  if (expectations.requiredPathMemoryIds.length) {
    assertions.push(comparison(
      "required-path-memories",
      includesEvery(graphExpansion.pathMemoryIds, expectations.requiredPathMemoryIds),
      expectations.requiredPathMemoryIds,
      graphExpansion.pathMemoryIds,
    ));
  }
  if (expectations.forbiddenPathMemoryIds.length) {
    assertions.push(comparison(
      "forbidden-path-memories",
      excludesEvery(graphExpansion.pathMemoryIds, expectations.forbiddenPathMemoryIds),
      expectations.forbiddenPathMemoryIds,
      graphExpansion.pathMemoryIds,
    ));
  }
  if (expectations.requiredPathRelations.length) {
    assertions.push(comparison(
      "required-path-relations",
      includesEvery(graphExpansion.traversedRelations, expectations.requiredPathRelations),
      expectations.requiredPathRelations,
      graphExpansion.traversedRelations,
    ));
  }
  if (expectations.forbiddenPathRelations.length) {
    assertions.push(comparison(
      "forbidden-path-relations",
      excludesEvery(graphExpansion.traversedRelations, expectations.forbiddenPathRelations),
      expectations.forbiddenPathRelations,
      graphExpansion.traversedRelations,
    ));
  }
  if (expectations.requireUntruncatedActivation !== undefined) {
    assertions.push(comparison(
      "untruncated-activation",
      expectations.requireUntruncatedActivation === !graphExpansion.workBudgetTruncated,
      expectations.requireUntruncatedActivation,
      !graphExpansion.workBudgetTruncated,
    ));
  }
  if (expectations.contextIncludes.length) {
    assertions.push(comparison(
      "context-includes",
      includesEvery(context, expectations.contextIncludes),
      expectations.contextIncludes,
      expectations.contextIncludes.filter((value) => context.includes(value)),
    ));
  }
  if (expectations.contextExcludes.length) {
    assertions.push(comparison(
      "context-excludes",
      excludesEvery(context, expectations.contextExcludes),
      expectations.contextExcludes,
      expectations.contextExcludes.filter((value) => context.includes(value)),
    ));
  }
  if (expectations.emptyContext !== undefined) {
    assertions.push(comparison(
      "empty-context",
      expectations.emptyContext === (context.length === 0),
      expectations.emptyContext,
      context.length === 0,
    ));
  }
  if (expectations.maximumContextChars !== undefined) {
    assertions.push(comparison(
      "maximum-context-chars",
      context.length <= expectations.maximumContextChars,
      expectations.maximumContextChars,
      context.length,
    ));
  }
  if (expectations.minimumSelectedMemories !== undefined) {
    assertions.push(comparison(
      "minimum-selected-memories",
      selected.length >= expectations.minimumSelectedMemories,
      expectations.minimumSelectedMemories,
      selected.length,
    ));
  }
  if (expectations.maximumSelectedMemories !== undefined) {
    assertions.push(comparison(
      "maximum-selected-memories",
      selected.length <= expectations.maximumSelectedMemories,
      expectations.maximumSelectedMemories,
      selected.length,
    ));
  }
  if (expectations.maximumCandidates !== undefined) {
    assertions.push(comparison(
      "maximum-candidates",
      candidateIds.length <= expectations.maximumCandidates,
      expectations.maximumCandidates,
      candidateIds.length,
    ));
  }
  for (const expectation of expectations.expectedSubjects) {
    const memory = memories.get(expectation.memoryId);
    const passed = Boolean(memory)
      && (!expectation.role || clean(memory.subjectRole) === expectation.role)
      && (!expectation.key || clean(memory.subjectKey) === expectation.key);
    assertions.push(comparison(
      `subject:${expectation.memoryId}`,
      passed,
      { role: expectation.role, key: expectation.key },
      memory
        ? { role: clean(memory.subjectRole), key: clean(memory.subjectKey) }
        : null,
    ));
  }
  if (expectations.primarySubject) {
    const expectation = expectations.primarySubject;
    const passed = Boolean(primaryMemory)
      && (!expectation.role || clean(primaryMemory.subjectRole) === expectation.role)
      && (!expectation.key || clean(primaryMemory.subjectKey) === expectation.key);
    assertions.push(comparison(
      "primary-subject",
      passed,
      expectation,
      primaryMemory
        ? { role: clean(primaryMemory.subjectRole), key: clean(primaryMemory.subjectKey) }
        : null,
    ));
  }

  const actual = {
    status: clean(result?.status),
    recallIntent: clean(result?.recallIntent),
    chainMode: clean(result?.chainIntent?.mode),
    chainDirection: clean(result?.chainIntent?.direction),
    retrievalMode: clean(result?.retrievalMode),
    primaryMemoryId,
    selectedMemoryIds: selected,
    candidateMemoryIds: candidateIds,
    candidateRanking: candidateRankingMetrics(expectations, candidateIds),
    primarySelection: primarySelectionMetrics(expectations, primaryMemoryId),
    graphExpansion,
    outputBudget: outputBudgetMetrics(result),
    externalUsage: externalUsageMetrics(result, customPriceRevisions),
    plannedRoutes: uniqueStrings(result?.seedRouting?.plannedRoutes || []),
    executedRoutes: uniqueStrings(result?.seedRouting?.executedRoutes || []),
    routeStatus: normalizedRouteStatus(result?.seedRouting?.routeStatus),
    primaryCandidateRoutes: primaryCandidateRoutes(result, primaryMemoryId),
    subjectRejectedMemoryIds: subjectRejectedIds,
    graphSubjectRejectedMemoryIds: graphSubjectRejectedIds,
    stateSuppressedMemoryIds: stateSuppressedIds,
    supportEvidenceMemoryIds: supportEvidenceIds,
    counterevidenceMemoryIds: counterevidenceIds,
    contextChars: context.length,
    contextSha256: contextHash(context),
    vectorStatus: clean(result?.vector?.status),
    searchedMemories: Number(result?.searchedMemories || 0),
    observedMemories: [...memories.values()],
  };
  if (includeContext) actual.context = context;
  return {
    id: item.id,
    title: item.title,
    category: item.category,
    query: item.query,
    passed: assertions.every((assertion) => assertion.passed),
    assertions,
    actual,
  };
}

function categorySummary(results) {
  const categories = {};
  for (const result of results) {
    const current = categories[result.category] || { total: 0, passed: 0, failed: 0 };
    current.total += 1;
    if (result.passed) current.passed += 1;
    else current.failed += 1;
    categories[result.category] = current;
  }
  return categories;
}

function mean(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  return finite.length ? finiteMetric(finite.reduce((sum, value) => sum + value, 0) / finite.length) : null;
}

function rate(numerator, denominator) {
  return denominator ? finiteMetric(numerator / denominator) : null;
}

function percentile(values, quantile) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!finite.length) return null;
  const index = Math.max(0, Math.ceil(quantile * finite.length) - 1);
  return finiteMetric(finite[index]);
}

function candidateRankingSummary(results) {
  const eligible = results.filter((result) => result.actual?.candidateRanking?.eligible);
  const complete = eligible.filter((result) => (
    result.actual.candidateRanking.completeRelevanceJudgment
  ));
  const hitCount = (field) => (
    eligible.filter((result) => result.actual.candidateRanking[field]).length
  );
  return {
    targetCaseCount: eligible.length,
    completeJudgmentCaseCount: complete.length,
    meanReciprocalRank: mean(eligible.map((result) => (
      result.actual.candidateRanking.reciprocalRank
    ))),
    hitRateAt1: rate(hitCount("hitAt1"), eligible.length),
    hitRateAt3: rate(hitCount("hitAt3"), eligible.length),
    hitRateAt5: rate(hitCount("hitAt5"), eligible.length),
    meanRecallAt1: mean(complete.map((result) => (
      result.actual.candidateRanking.recallAt1
    ))),
    meanRecallAt3: mean(complete.map((result) => (
      result.actual.candidateRanking.recallAt3
    ))),
    meanRecallAt5: mean(complete.map((result) => (
      result.actual.candidateRanking.recallAt5
    ))),
    meanNdcgAt5: mean(complete.map((result) => (
      result.actual.candidateRanking.ndcgAt5
    ))),
    missedCaseIds: eligible
      .filter((result) => !result.actual.candidateRanking.hitAt5)
      .map((result) => result.id),
  };
}

function primarySelectionSummary(results) {
  const eligible = results.filter((result) => result.actual?.primarySelection?.eligible);
  const correct = eligible.filter((result) => result.actual.primarySelection.correct === true);
  const incorrect = eligible.filter((result) => result.actual.primarySelection.correct === false);
  return {
    targetCaseCount: eligible.length,
    correctCount: correct.length,
    accuracy: rate(correct.length, eligible.length),
    incorrectCaseIds: incorrect.map((result) => result.id),
    missingSelectionCaseIds: incorrect
      .filter((result) => !result.actual.primarySelection.actualMemoryId)
      .map((result) => result.id),
  };
}

function graphExpansionSummary(results) {
  const eligible = results.filter((result) => result.actual?.graphExpansion?.eligible);
  const expanded = eligible.filter((result) => result.actual.graphExpansion.pathCount > 0);
  const truncated = eligible.filter((result) => (
    result.actual.graphExpansion.workBudgetTruncated
  ));
  return {
    eligibleCaseCount: eligible.length,
    expandedCaseCount: expanded.length,
    truncatedCaseCount: truncated.length,
    truncationRate: rate(truncated.length, eligible.length),
    averagePathCount: mean(eligible.map((result) => result.actual.graphExpansion.pathCount)),
    averageProcessedStates: mean(eligible.map((result) => (
      result.actual.graphExpansion.processedStates
    ))),
    averageSelectedActivationCount: mean(eligible.map((result) => (
      result.actual.graphExpansion.selectedActivationCount
    ))),
    maximumObservedDepth: eligible.length
      ? Math.max(...eligible.map((result) => result.actual.graphExpansion.maximumDepth))
      : null,
    maximumObservedFanout: eligible.length
      ? Math.max(...eligible.map((result) => result.actual.graphExpansion.maximumFanout))
      : null,
    truncatedCaseIds: truncated.map((result) => result.id),
  };
}

function outputBudgetSummary(results) {
  const eligible = results.filter((result) => result.actual?.outputBudget?.eligible);
  const sectionTruncated = eligible.filter((result) => (
    result.actual.outputBudget.sectionTruncationApplied
  ));
  const truncated = eligible.filter((result) => (
    result.actual.outputBudget.safetyTruncationApplied
  ));
  return {
    eligibleCaseCount: eligible.length,
    sectionTruncationCaseCount: sectionTruncated.length,
    sectionTruncationRate: rate(sectionTruncated.length, eligible.length),
    safetyTruncationCaseCount: truncated.length,
    safetyTruncationRate: rate(truncated.length, eligible.length),
    averageUtilization: mean(eligible.map((result) => result.actual.outputBudget.utilization)),
    maximumUtilization: eligible.length
      ? Math.max(...eligible.map((result) => result.actual.outputBudget.utilization || 0))
      : null,
    sectionTruncatedCaseIds: sectionTruncated.map((result) => result.id),
    truncatedCaseIds: truncated.map((result) => result.id),
  };
}

function rejectionSummary(results, normalizedCases) {
  const byId = new Map(normalizedCases.map((item) => [item.id, item]));
  const noMatchCases = results.filter((result) => byId.get(result.id)?.expect?.emptyContext === true);
  const suppressedNoMatchCases = noMatchCases.filter((result) => (
    ["no-match", "skipped"].includes(clean(result.actual?.status))
    && Number(result.actual?.contextChars || 0) === 0
    && (result.actual?.selectedMemoryIds || []).length === 0
    && (result.actual?.candidateMemoryIds || []).length === 0
  ));
  const forbiddenCases = results.filter((result) => (
    (byId.get(result.id)?.expect?.forbiddenMemoryIds || []).length > 0
  ));
  const contaminated = forbiddenCases.filter((result) => {
    const forbidden = new Set(byId.get(result.id).expect.forbiddenMemoryIds);
    return (result.actual?.candidateMemoryIds || []).some((memoryId) => forbidden.has(memoryId));
  });
  return {
    noMatchCaseCount: noMatchCases.length,
    suppressedNoMatchCaseCount: suppressedNoMatchCases.length,
    noMatchSuppressionRate: rate(suppressedNoMatchCases.length, noMatchCases.length),
    falsePositiveNoMatchCaseIds: noMatchCases
      .filter((result) => !suppressedNoMatchCases.includes(result))
      .map((result) => result.id),
    forbiddenCandidateCaseCount: forbiddenCases.length,
    forbiddenCandidateContaminatedCaseCount: contaminated.length,
    forbiddenCandidateEntryRate: rate(contaminated.length, forbiddenCases.length),
    forbiddenCandidateCaseIds: contaminated.map((result) => result.id),
  };
}

function routeSummary(results) {
  const routes = {};
  const ensure = (route) => {
    routes[route] ||= {
      plannedCases: 0,
      executedCases: 0,
      matchedCases: 0,
      supportingOnlyCases: 0,
      noMatchCases: 0,
      primaryCandidateCases: 0,
    };
    return routes[route];
  };
  for (const result of results) {
    const actual = result.actual || {};
    for (const route of actual.plannedRoutes || []) ensure(route).plannedCases += 1;
    for (const route of actual.executedRoutes || []) ensure(route).executedCases += 1;
    for (const [route, status] of Object.entries(actual.routeStatus || {})) {
      const target = ensure(route);
      if (status === "matched") target.matchedCases += 1;
      else if (status === "supporting-only") target.supportingOnlyCases += 1;
      else if (status === "no-match") target.noMatchCases += 1;
    }
    for (const route of actual.primaryCandidateRoutes || []) {
      if (routes[route]) routes[route].primaryCandidateCases += 1;
    }
  }
  return routes;
}

function efficiencySummary(results) {
  return {
    averageDurationMs: mean(results.map((result) => result.durationMs)),
    p95DurationMs: percentile(results.map((result) => result.durationMs), 0.95),
    averageCandidateCount: mean(results.map((result) => (
      result.actual?.candidateMemoryIds?.length
    ))),
    averageSelectedMemoryCount: mean(results.map((result) => (
      result.actual?.selectedMemoryIds?.length
    ))),
    averageContextChars: mean(results.map((result) => result.actual?.contextChars)),
  };
}

function externalUsageSummary(results) {
  const requests = results.flatMap((result) => result.actual?.externalUsage?.requests || []);
  const priced = requests.filter((request) => request.amountCny !== null);
  const byModel = {};
  for (const request of requests) {
    const model = clean(request.model) || "unknown";
    byModel[model] ||= {
      requestCount: 0,
      pricedRequestCount: 0,
      unknownPriceRequestCount: 0,
      amountCny: 0,
    };
    byModel[model].requestCount += 1;
    if (request.amountCny === null) byModel[model].unknownPriceRequestCount += 1;
    else {
      byModel[model].pricedRequestCount += 1;
      byModel[model].amountCny += request.amountCny;
    }
  }
  for (const value of Object.values(byModel)) value.amountCny = finiteMetric(value.amountCny);
  return {
    requestCount: requests.length,
    pricedRequestCount: priced.length,
    unknownPriceRequestCount: requests.length - priced.length,
    amountCny: finiteMetric(priced.reduce((sum, request) => sum + request.amountCny, 0)),
    currency: "CNY",
    byModel,
  };
}

export async function runMemoryEvaluation({
  cases,
  execute,
  includeContext = false,
  customPriceRevisions = [],
  now = () => new Date(),
} = {}) {
  if (!Array.isArray(cases)) throw new Error("runMemoryEvaluation 需要 cases 数组。");
  if (typeof execute !== "function") throw new Error("runMemoryEvaluation 需要 execute 函数。");
  const normalizedCases = cases.map((item, index) => (
    isNormalizedEvaluationCase(item) ? item : normalizeEvaluationCase(item, index)
  ));
  const startedAt = now().toISOString();
  const results = [];
  for (const item of normalizedCases) {
    const start = Date.now();
    try {
      const retrieval = await execute(item);
      const result = evaluateRetrievalResult(item, retrieval, {
        includeContext,
        customPriceRevisions,
      });
      result.durationMs = Date.now() - start;
      results.push(result);
    } catch (error) {
      results.push({
        id: item.id,
        title: item.title,
        category: item.category,
        query: item.query,
        passed: false,
        durationMs: Date.now() - start,
        assertions: [comparison("execution", false, "successful execution", error.message)],
        actual: { error: error.message },
      });
    }
  }
  const passed = results.filter((result) => result.passed).length;
  const completedAt = now().toISOString();
  return {
    schemaVersion: 3,
    startedAt,
    completedAt,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      passRate: results.length ? passed / results.length : 1,
      categories: categorySummary(results),
      candidateRanking: candidateRankingSummary(results),
      primarySelection: primarySelectionSummary(results),
      graphExpansion: graphExpansionSummary(results),
      outputBudget: outputBudgetSummary(results),
      rejection: rejectionSummary(results, normalizedCases),
      routes: routeSummary(results),
      efficiency: efficiencySummary(results),
      externalUsage: externalUsageSummary(results),
    },
    results,
  };
}

export function writeEvaluationReport(filePath, report) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, resolved);
  return resolved;
}
