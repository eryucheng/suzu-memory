function text(value) {
  return String(value ?? '').trim();
}

export function questionFailure(error) {
  const message = text(error?.message) || 'Unknown question failure.';
  const code = text(error?.code || error?.cause?.code);
  if (error?.name === 'AssertionError' || code === 'ERR_ASSERTION' || code.startsWith('ZH4O_')) {
    return { message, code, kind: 'application', status: null, retryable: false, infrastructure: false, fatal: false };
  }
  const status = Number(error?.status || error?.diagnostics?.status
    || message.match(/(?:HTTP\s*|API\s*请求失败[（(]\s*)(\d{3})/iu)?.[1]) || null;
  const quota = /insufficient[_\s-]*(?:quota|balance|credit)|余额不足|额度不足|credit balance/iu.test(message);
  const timeout = error?.name === 'AbortError' || error?.diagnostics?.kind === 'timeout'
    || /TIMEOUT|TIMEDOUT/iu.test(code) || /timed?\s*out|timeout|超时|请求超过\s*\d+ms/iu.test(message);
  const network = error?.diagnostics?.kind === 'network'
    || /^(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_SOCKET)$/u.test(code)
    || /fetch failed|network (?:error|unavailable)|无法连接记忆处理 API/iu.test(message);
  const kind = quota ? 'quota' : status ? `http-${status}` : timeout ? 'timeout' : network ? 'network' : 'application';
  const fatal = quota || [401, 402, 403].includes(status);
  const retryable = !fatal && (timeout || network || [408, 425, 429].includes(status) || (status >= 500 && status < 600));
  return { message, code, kind, status, retryable, infrastructure: fatal || retryable, fatal };
}

/** Classify preparation diagnostics without treating memory quality failures as outages. */
export function memoryPreparationDiagnostics({ passes = [], inputEvents = [], finalProgress, expectedEvents = 0, mappedEvents = 0 } = {}) {
  const infrastructureFailures = new Map();
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const message = value.message || value.errorMessage || (typeof value.error === 'string' ? value.error : '') || value.last_error;
    if (message) {
      const failure = questionFailure({ ...value, message,
        code: value.code || value.errorCode, name: value.name || value.errorName,
        diagnostics: value.diagnostics || value.providerDiagnostics });
      if (failure.infrastructure) infrastructureFailures.set(JSON.stringify(failure), failure);
    }
    for (const key of ['error', 'failures', 'maintenance', 'semantic', 'embedding', 'tasks', 'results', 'result', 'input', 'batches',
      'semanticTasks', 'stateAnalysis', 'automaticStateAcceptance', 'pendingStateMaterialization', 'eventContinuity',
      'consolidation', 'structures', 'retrievalContexts', 'reports', 'failed']) visit(value[key]);
  };
  visit(passes);
  for (const event of inputEvents) visit(event.metadata?.suzuMemoryProcessing?.failureHistory);
  const batches = passes.flatMap(pass => pass.input || []).flatMap(input => input.batches || []);
  return {
    quarantinedMessages: new Set(inputEvents.filter(event => event.processing_disposition === 'quarantined')
      .map(event => event.metadata?.suzuMemoryFragment?.parentEventId || event.external_id || event.id)).size,
    archiveOnlyBatches: batches.filter(batch => batch.generationDiagnostics?.degraded).length,
    unresolvedExtractionCandidates: batches.reduce((sum, batch) => sum + Number(batch.generationDiagnostics?.unresolvedCandidateCount || 0), 0),
    incompleteExtractionBatches: batches.filter(batch => batch.generationDiagnostics?.candidateValidationIncomplete).length,
    failedMaintenancePasses: passes.filter(pass => pass.failures?.length || ['failed', 'partial-failure', 'completed-with-failures', 'degraded'].includes(pass.status)).length,
    pendingWork: Number(finalProgress?.total || 0), failedWork: Number(finalProgress?.failures || 0),
    missingInputEvents: Math.max(0, expectedEvents - mappedEvents),
    infrastructureFailures: [...infrastructureFailures.values()],
  };
}

export function summarizeMemoryPreparation(samples) {
  const keys = ['quarantinedMessages', 'archiveOnlyBatches', 'unresolvedExtractionCandidates', 'incompleteExtractionBatches', 'failedMaintenancePasses', 'pendingWork', 'failedWork', 'missingInputEvents'];
  return Object.fromEntries(keys.map(key => [key, samples.reduce((sum, sample) => sum + Number(sample.memoryDiagnostics?.[key] || 0), 0)]));
}

/** Count provider transport attempts in the same budget as evaluator retries. */
export async function runQuestionOperation(operation, { delayMs = 500, onAttempts = () => {} } = {}) {
  let attempts = 0;
  while (true) {
    try {
      const result = await operation();
      attempts += Math.max(1, Number(result?.metadata?.transportAttempts) || 1);
      onAttempts(attempts);
      return result;
    } catch (error) {
      attempts += Math.max(1, Number(error?.transportAttempts) || 1);
      onAttempts(attempts);
      const nextInvocationAttempts = Math.max(1, Number(error?.maximumTransportAttempts || error?.transportAttempts) || 1);
      if (!questionFailure(error).retryable || attempts + nextInvocationAttempts > 3) throw error;
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs * attempts));
    }
  }
}

export function mergeUsageSummaries(previous, current) {
  if (!previous) return current;
  const merged = { ...current };
  for (const key of ['requests', 'failedRequests', 'inputTokens']) {
    if (key in previous || key in current) merged[key] = Number(previous[key] || 0) + Number(current[key] || 0);
  }
  for (const key of ['byPhase', 'bySchema', 'usage']) {
    if (!(key in previous) && !(key in current)) continue;
    merged[key] = { ...(previous[key] || {}) };
    for (const [name, value] of Object.entries(current[key] || {})) merged[key][name] = Number(merged[key][name] || 0) + Number(value || 0);
  }
  for (const key of ['models', 'providers']) merged[key] = [...new Set([...(previous[key] || []), ...(current[key] || [])])];
  merged.estimatedCostCny = previous.estimatedCostCny === null || current.estimatedCostCny === null
    ? null : Number(previous.estimatedCostCny || 0) + Number(current.estimatedCostCny || 0);
  merged.pricingStatus = merged.estimatedCostCny === null ? 'partly-or-fully-unknown' : merged.requests ? 'estimated' : 'not-used';
  return merged;
}
