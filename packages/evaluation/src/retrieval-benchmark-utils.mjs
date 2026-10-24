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
      phase: typeof phase === "function" ? phase() : phase,
      failed: !response,
      model: cleanBenchmarkValue(response?.model || provider.model),
      provider: cleanBenchmarkValue(response?.metadata?.provider),
      usage: { ...(response?.usage || {}) },
    });
    return response;
  };
  const invoke = async callback => {
    await requestGate();
    let response;
    try { response = await callback(); return response; }
    finally { capture(response); }
  };
  const wrapped = (text, options) => invoke(() => provider(text, options));
  if (typeof provider.embedMany === "function") {
    wrapped.embedMany = (texts, options) => invoke(() => provider.embedMany(texts, options));
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
    if (priced.amountCny === null || record.failed) hasUnknownPrice = true;
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
