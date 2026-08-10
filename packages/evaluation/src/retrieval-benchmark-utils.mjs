import { calculateCost } from "@suzu-memory/usage-ledger";

export function cleanBenchmarkValue(value) {
  return String(value ?? "").trim();
}

export function boundedBenchmarkInteger(
  value,
  fallback,
  { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {},
) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
}

export function meanBenchmarkValues(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + Number(value || 0), 0) / values.length;
}

export function benchmarkPercentile(values, quantile) {
  if (!values.length) return null;
  const ordered = [...values].map(Number).sort((left, right) => left - right);
  const boundedQuantile = Math.min(1, Math.max(0, Number(quantile) || 0));
  const index = (ordered.length - 1) * boundedQuantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return ordered[lower];
  const fraction = index - lower;
  return ordered[lower] + ((ordered[upper] - ordered[lower]) * fraction);
}

export function createEmbeddingRequestGate(intervalMs) {
  const interval = Math.max(0, Math.trunc(Number(intervalMs) || 0));
  let lastStartedAt = 0;
  return async () => {
    const waitMs = Math.max(0, interval - (Date.now() - lastStartedAt));
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    lastStartedAt = Date.now();
  };
}

export function captureBenchmarkEmbeddingUsage(provider, phase, records, requestGate) {
  if (typeof provider !== "function") return null;
  const capture = (response) => {
    records.push({
      phase,
      model: cleanBenchmarkValue(response?.model || provider.model),
      provider: cleanBenchmarkValue(response?.metadata?.provider),
      usage: { ...(response?.usage || {}) },
    });
    return response;
  };
  const wrapped = async (text) => {
    await requestGate();
    return capture(await provider(text));
  };
  if (typeof provider.embedMany === "function") {
    wrapped.embedMany = async (texts) => {
      await requestGate();
      return capture(await provider.embedMany(texts));
    };
  }
  wrapped.model = cleanBenchmarkValue(provider.model);
  wrapped.dimensions = Math.max(0, Math.trunc(Number(provider.dimensions) || 0));
  return wrapped;
}

export function summarizeBenchmarkEmbeddingUsage(records, timestamp) {
  if (!records.length) return {
    requests: 0,
    byPhase: {},
    models: [],
    providers: [],
    inputTokens: 0,
    estimatedCostCny: 0,
    pricingStatus: "not-used",
  };
  let inputTokens = 0;
  let amountCny = 0;
  let hasUnknownPrice = false;
  for (const record of records) {
    const priced = calculateCost({
      model: record.model,
      timestamp,
      usage: record.usage,
    });
    inputTokens += Number(priced.units?.inputTokens || 0);
    if (priced.amountCny === null) hasUnknownPrice = true;
    else amountCny += priced.amountCny;
  }
  return {
    requests: records.length,
    byPhase: Object.fromEntries([...new Set(records.map((record) => record.phase))]
      .map((phase) => [phase, records.filter((record) => record.phase === phase).length])),
    models: [...new Set(records.map((record) => record.model).filter(Boolean))],
    providers: [...new Set(records.map((record) => record.provider).filter(Boolean))],
    inputTokens,
    estimatedCostCny: hasUnknownPrice ? null : amountCny,
    pricingStatus: hasUnknownPrice ? "partly-or-fully-unknown" : "estimated",
  };
}

function semanticCapabilities(options = {}) {
  return {
    retrievalContext: typeof options.retrievalContextGenerator === "function",
    structure: typeof options.structureGenerator === "function",
    stateAnalysis: typeof options.generator === "function",
    consolidation: typeof options.structureGenerator === "function",
  };
}

function supportedSemanticTask(task, capabilities) {
  if (task.task_type === "retrieval-context") return capabilities.retrievalContext;
  if (task.task_type === "structure-proposal") return capabilities.structure;
  return false;
}

function pendingSemanticWork(status, capabilities) {
  const semanticTasks = (status.tasks || []).filter((task) => (
    task.status === "pending"
    && task.lane === "semantic"
    && supportedSemanticTask(task, capabilities)
  )).length;
  return semanticTasks
    + (capabilities.stateAnalysis ? Number(status.pendingStateAnalysisRequests || 0) : 0)
    + (capabilities.consolidation ? Number(status.consolidationRuns?.planned || 0) : 0);
}

function semanticWorkFingerprint(status, capabilities) {
  const taskIds = (status.tasks || [])
    .filter((task) => (
      task.status === "pending"
      && task.lane === "semantic"
      && supportedSemanticTask(task, capabilities)
    ))
    .map((task) => `task:${task.id}`);
  const stateRequestIds = capabilities.stateAnalysis
    ? (status.stateAnalysisRequests?.items || [])
      .filter((request) => request.status === "pending")
      .map((request) => `state:${request.id}`)
    : [];
  const plannedConsolidation = capabilities.consolidation
    ? Number(status.consolidationRuns?.planned || 0)
    : 0;
  return JSON.stringify({
    taskIds: taskIds.sort(),
    stateRequestIds: stateRequestIds.sort(),
    plannedConsolidation,
  });
}

function selectedSemanticWork(result) {
  return Number(result?.semanticTasks?.selected || 0)
    + Number(result?.stateAnalysis?.selected || 0)
    + Number(result?.consolidation?.selected || 0);
}

function terminalSemanticFailures(status, capabilities) {
  const failedTasks = (status.tasks || []).filter((task) => (
    task.status === "failed"
    && task.lane === "semantic"
    && supportedSemanticTask(task, capabilities)
  )).length;
  const blockedStateRequests = capabilities.stateAnalysis
    ? Number(status.stateAnalysisRequests?.blocked || 0)
    : 0;
  const failedStateRequests = capabilities.stateAnalysis
    ? Number(status.stateAnalysisRequests?.failed || 0)
    : 0;
  const failedConsolidationRuns = capabilities.consolidation
    ? Number(status.consolidationRuns?.failed || 0)
    : 0;
  return {
    failedTasks,
    blockedStateRequests,
    failedStateRequests,
    failedConsolidationRuns,
    total: failedTasks + blockedStateRequests + failedStateRequests + failedConsolidationRuns,
  };
}

export async function drainBenchmarkSemanticMaintenance({
  service,
  options = {},
  maximumPasses = 100,
  maximumStagnantPasses = 3,
} = {}) {
  const passes = [];
  const capabilities = semanticCapabilities(options);
  const beforeAll = service.maintenanceStatus({ limit: 500 });
  const passLimit = boundedBenchmarkInteger(maximumPasses, 100, { minimum: 0, maximum: 100_000 });
  const stagnantLimit = boundedBenchmarkInteger(maximumStagnantPasses, 3, {
    minimum: 1,
    maximum: 20,
  });
  let stagnantPasses = 0;
  for (let index = 0; index < passLimit; index += 1) {
    const before = service.maintenanceStatus({ limit: 500 });
    if (pendingSemanticWork(before, capabilities) === 0) break;
    const beforeFingerprint = semanticWorkFingerprint(before, capabilities);
    const result = await service.runSemanticMaintenance({
      processInputEvents: false,
      maximumTasks: 100,
      maximumStateRequests: 500,
      maximumConsolidationRuns: 100,
      ...options,
    });
    passes.push(result);
    const after = service.maintenanceStatus({ limit: 500 });
    if (pendingSemanticWork(after, capabilities) === 0) break;
    const selected = selectedSemanticWork(result);
    const unchanged = semanticWorkFingerprint(after, capabilities) === beforeFingerprint;
    if (selected === 0) {
      stagnantPasses = stagnantLimit;
      break;
    }
    stagnantPasses = unchanged ? stagnantPasses + 1 : 0;
    if (stagnantPasses >= stagnantLimit) break;
  }
  const afterAll = service.maintenanceStatus({ limit: 500 });
  const pendingAfter = pendingSemanticWork(afterAll, capabilities);
  return {
    passes,
    pendingBefore: pendingSemanticWork(beforeAll, capabilities),
    pendingAfter,
    complete: pendingAfter === 0,
    hitPassLimit: passes.length >= passLimit && pendingAfter > 0,
    hitStagnantLimit: stagnantPasses >= stagnantLimit && pendingAfter > 0,
    stagnantPasses,
    failures: terminalSemanticFailures(afterAll, capabilities),
    finalStatus: afterAll,
  };
}
