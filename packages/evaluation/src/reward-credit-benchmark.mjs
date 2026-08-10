import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";

import {
  evaluateRewardCreditCalibration,
  rewardCalibrationResultFromObservation,
} from "./reward-credit-calibration.mjs";
import { processRewardObservation } from "./reward-credit-service.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function unique(values) {
  return new Set(values).size === values.length;
}

function requireString(value, label) {
  if (!clean(value)) throw new Error(`${label} is required.`);
  return clean(value);
}

function assertSameIds(actual, expected, label) {
  const actualSorted = [...new Set(actual.map(clean).filter(Boolean))].sort();
  const expectedSorted = [...new Set(expected.map(clean).filter(Boolean))].sort();
  if (actualSorted.join("\u001f") !== expectedSorted.join("\u001f")) {
    throw new Error(`${label} must cover the replay boundary exactly.`);
  }
}

export function validateRewardCreditBenchmark(benchmark, { expectedCaseCount = 0 } = {}) {
  if (!benchmark || typeof benchmark !== "object" || !Array.isArray(benchmark.cases)) {
    throw new Error("Reward benchmark requires a cases array.");
  }
  const version = requireString(benchmark.version, "Reward benchmark version");
  if (benchmark.synthetic !== true) throw new Error("Reward benchmark must declare synthetic: true.");
  if (expectedCaseCount && benchmark.cases.length !== expectedCaseCount) {
    throw new Error(`Reward benchmark expected ${expectedCaseCount} cases but found ${benchmark.cases.length}.`);
  }
  const caseIds = benchmark.cases.map((item) => requireString(item?.caseId, "Reward benchmark caseId"));
  if (!unique(caseIds)) throw new Error("Reward benchmark caseId values must be unique.");
  const categories = new Map();
  for (const item of benchmark.cases) {
    const caseId = clean(item.caseId);
    const category = requireString(item.category, `${caseId}.category`);
    categories.set(category, (categories.get(category) || 0) + 1);
    const scenario = item.scenario;
    const expected = item.expected;
    if (!scenario || typeof scenario !== "object" || !expected || typeof expected !== "object") {
      throw new Error(`${caseId} requires scenario and expected objects.`);
    }
    const memories = Array.isArray(scenario.memories) ? scenario.memories : [];
    const edges = Array.isArray(scenario.edges) ? scenario.edges : [];
    const paths = Array.isArray(scenario.paths) ? scenario.paths : [];
    if (!memories.length) throw new Error(`${caseId} requires memories.`);
    const memoryIds = memories.map((memory) => requireString(memory.id, `${caseId}.memory.id`));
    const edgeIds = edges.map((edge) => requireString(edge.id, `${caseId}.edge.id`));
    if (!unique(memoryIds) || !unique(edgeIds)) throw new Error(`${caseId} contains duplicate memory or edge IDs.`);
    const memoryBoundary = new Set(memoryIds);
    const edgeBoundary = new Set(edgeIds);
    for (const edge of edges) {
      if (!memoryBoundary.has(clean(edge.fromMemoryId)) || !memoryBoundary.has(clean(edge.toMemoryId))) {
        throw new Error(`${caseId} edge escapes the memory boundary.`);
      }
    }
    const usedMemoryIds = Array.isArray(scenario.usedMemoryIds) ? scenario.usedMemoryIds.map(clean) : [];
    if (!usedMemoryIds.length || usedMemoryIds.some((id) => !memoryBoundary.has(id))) {
      throw new Error(`${caseId} usedMemoryIds are incomplete or out of bounds.`);
    }
    if (!unique(usedMemoryIds)) throw new Error(`${caseId} usedMemoryIds contain duplicates.`);
    const selected = new Set(Array.isArray(scenario.selectedIds) ? scenario.selectedIds.map(clean) : []);
    if (usedMemoryIds.some((id) => !selected.has(id))) {
      throw new Error(`${caseId} used memories must be selected memories.`);
    }
    const pathEdgeIds = [];
    for (const itemPath of paths) {
      if (!memoryBoundary.has(clean(itemPath.memoryId))) throw new Error(`${caseId} path target is out of bounds.`);
      for (const itemEdge of Array.isArray(itemPath.edges) ? itemPath.edges : []) {
        const edgeId = clean(itemEdge.edgeId);
        if (!edgeBoundary.has(edgeId)) throw new Error(`${caseId} path edge is out of bounds.`);
        pathEdgeIds.push(edgeId);
      }
    }
    assertSameIds(
      Array.isArray(expected.memoryCredits) ? expected.memoryCredits.map((credit) => credit.memoryId) : [],
      usedMemoryIds,
      `${caseId}.expected.memoryCredits`,
    );
    assertSameIds(
      Array.isArray(expected.pathCredits) ? expected.pathCredits.map((credit) => credit.edgeId) : [],
      pathEdgeIds,
      `${caseId}.expected.pathCredits`,
    );
    const targetIds = Array.isArray(expected.targetMemoryIds) ? expected.targetMemoryIds.map(clean) : [];
    if (targetIds.some((id) => !usedMemoryIds.includes(id))) {
      throw new Error(`${caseId} expected target memory is outside used memories.`);
    }
    for (const field of ["query", "assistantResponse", "followUp", "recallIntent"]) {
      requireString(scenario[field], `${caseId}.scenario.${field}`);
    }
    for (const field of ["outcomeClass", "evidenceTier", "feedbackTarget"]) {
      requireString(expected[field], `${caseId}.expected.${field}`);
    }
  }
  return {
    version,
    cases: benchmark.cases.length,
    categories: Object.fromEntries([...categories.entries()].sort(([left], [right]) => left.localeCompare(right))),
  };
}

function replayCase(repository, agentId, item) {
  const scenario = item.scenario;
  for (const value of scenario.memories) {
    repository.upsertMemory({ ...value, agentId });
  }
  for (const value of scenario.edges) {
    repository.upsertEdge({ ...value, agentId });
  }
  const trace = repository.recordRetrievalTrace({
    id: `${item.caseId}-trace`,
    agentId,
    queryText: scenario.query,
    recallIntent: scenario.recallIntent,
    resultStatus: "ready",
    seedIds: scenario.seedIds,
    selectedIds: scenario.selectedIds,
    paths: scenario.paths,
    metadata: { runtimeSessionKey: `${item.caseId}-session`, benchmarkCaseId: item.caseId },
  });
  repository.setRetrievalSessionHead({
    agentId,
    sessionId: `${item.caseId}-session`,
    traceId: trace.id,
  });
  const request = repository.bindRetrievalUsageResponse({
    agentId,
    sessionId: `${item.caseId}-session`,
    responseText: scenario.assistantResponse,
  });
  repository.resolveRetrievalUsageRequest({
    agentId,
    requestId: request.id,
    status: "completed",
    result: {
      usedMemoryIds: scenario.usedMemoryIds,
      notUsedMemoryIds: [],
      uncertainMemoryIds: [],
    },
  });
  const metadata = {
    benchmarkCaseId: item.caseId,
    synthetic: true,
    feedbackBinding: clean(scenario.feedbackBinding) || "immediate-next-user-input",
    delayDays: Math.max(0, Number(scenario.delayDays || 0)),
  };
  if (metadata.feedbackBinding === "explicit-usage-request") {
    return repository.recordRewardObservation({
      agentId,
      usageRequestId: request.id,
      feedbackText: scenario.followUp,
      metadata,
    });
  }
  return repository.bindRewardObservation({
    agentId,
    sessionId: `${item.caseId}-session`,
    feedbackText: scenario.followUp,
    metadata,
  });
}

export async function runRewardCreditBenchmark({
  benchmark,
  analyzersForCase,
  start = 0,
  maxCases,
  usageLedgerPath = "",
  onCaseComplete = null,
} = {}) {
  const validation = validateRewardCreditBenchmark(benchmark);
  if (typeof analyzersForCase !== "function") {
    throw new Error("Reward benchmark requires analyzersForCase.");
  }
  const first = Math.max(0, Math.trunc(Number(start) || 0));
  const requested = Number(maxCases);
  const maximum = Number.isInteger(requested) && requested > 0
    ? requested
    : benchmark.cases.length;
  const selectedCases = benchmark.cases.slice(first, first + maximum);
  if (!selectedCases.length) throw new Error("Reward benchmark selected no cases.");
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const agentId = `reward-benchmark-${validation.version}`;
  const results = [];
  const processing = [];
  try {
    for (const item of selectedCases) {
      let processingResult;
      let result;
      try {
        const observation = replayCase(repository, agentId, item);
        const analyzers = await analyzersForCase(item);
        processingResult = await processRewardObservation({
          repository,
          agentId,
          observationId: observation.id,
          analyzers,
          usageLedgerPath,
        });
        result = rewardCalibrationResultFromObservation({
          repository,
          agentId,
          observationId: observation.id,
          caseId: item.caseId,
        });
      } catch (error) {
        processingResult = {
          status: "failed",
          reason: clean(error?.message) || "benchmark-case-failed",
        };
        result = { caseId: item.caseId, error: processingResult.reason };
      }
      results.push(result);
      processing.push({
        caseId: item.caseId,
        status: clean(processingResult?.status),
        reason: clean(processingResult?.reason),
      });
      if (typeof onCaseComplete === "function") {
        await onCaseComplete({ item, result, processing: processing.at(-1), results: [...results] });
      }
    }
  } finally {
    database.close();
  }
  const metrics = evaluateRewardCreditCalibration({ cases: selectedCases, results });
  return {
    schemaVersion: "reward-credit-benchmark-report-v1",
    benchmarkVersion: validation.version,
    selection: { start: first, count: selectedCases.length, total: benchmark.cases.length },
    processing,
    results,
    metrics,
    automaticStateMutationAllowed: false,
  };
}
