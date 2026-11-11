import crypto from "node:crypto";
import { setTimeout as wait } from 'node:timers/promises';

import { appendUsageEvent } from "@suzu-memory/usage-ledger";
import { executionEventSourceView, eventSourceMaterial, currentEventSourceExecution,
  assertEventSourceExecutionCurrent } from '@suzu-memory/core';

const DEFAULT_EXCLUDED_KINDS = Object.freeze(["topic_or_episode"]);
const DEFAULT_BATCH_SIZE = 10;

function clean(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeVector(input) {
  const values = input instanceof Float32Array
    ? input
    : Float32Array.from(Array.isArray(input) ? input.map(Number) : []);
  if (!values.length || values.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding provider 返回了无效向量。");
  }
  let norm = 0;
  for (const value of values) norm += value * value;
  norm = Math.sqrt(norm);
  if (!norm) throw new Error("Embedding provider 返回了零向量。");
  const normalized = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    normalized[index] = values[index] / norm;
  }
  return normalized;
}

function displayValue(value) {
  const result = clean(value);
  return result && result !== "unknown" && result !== "unspecified" && result !== "not_applicable"
    ? result
    : "";
}

export function buildMemoryEmbeddingDocument(memory = {}, { retrievalContext = null } = {}) {
  // Only semantic text contributes to the vector. Identity, lifecycle and
  // temporal fields remain structured data for filtering and state updates.
  const lines = [
    ["标题", displayValue(memory.title)],
    ["内容", displayValue(memory.content)],
    ["检索上下文", displayValue(retrievalContext?.context_text ?? retrievalContext?.contextText)],
    ["常见查询表达", Array.isArray(retrievalContext?.queryTerms)
      ? retrievalContext.queryTerms.map(displayValue).filter(Boolean).join("；")
      : ""],
  ].filter(([, value]) => value);
  if (!lines.some(([label]) => label === "内容")) {
    throw new Error(`记忆 ${clean(memory.id) || "<unknown>"} 没有可索引正文。`);
  }
  return lines.map(([label, value]) => `${label}：${value}`).join("\n");
}

export function memoryEmbeddingContentHash(memory, options = {}) {
  return sha256(buildMemoryEmbeddingDocument(memory, options));
}

export function prepareMemoryEmbeddingDocument(repository, memory, {
  sourceView = executionEventSourceView(repository, memory.agent_id),
} = {}) {
  let retrievalContext = memory.kind === "utterance"
    ? utteranceRetrievalContext(repository, memory.agent_id, memory, sourceView)
    : repository.getCurrentMemoryRetrievalContext?.(memory.id) || null;
  if (sourceView && retrievalContext?.sourceMemoryIds?.some(id => !sourceView.memoryIds.has(id))) retrievalContext = null;
  const text = buildMemoryEmbeddingDocument(memory, { retrievalContext });
  return { text, contentHash: sha256(text), retrievalContext };
}

function utteranceRetrievalContext(repository, agentId, memory, sourceView) {
  if (memory.kind !== "utterance" || typeof repository.expand !== "function") return null;
  const expanded = repository.expand(agentId, [memory.id], {
    maxDepth: 1,
    maxNodes: 5,
    minimumWeight: 0.65,
    relations: ["followed_by"],
    traversal: "both",
    allowedMemoryIds: sourceView?.memoryIds,
  });
  const utterances = expanded.nodes
    .filter((node) => node.kind === "utterance")
    .sort((left, right) => (
      Date.parse(left.event_start || left.recorded_at || "")
      - Date.parse(right.event_start || right.recorded_at || "")
      || left.id.localeCompare(right.id)
    ));
  if (!utterances.length) return null;
  return {
    contextText: utterances.map((node) => {
      const speaker = clean(node.metadata?.speaker)
        || (node.subject_role === "agent" ? "Agent" : "User");
      return `${speaker}：${clean(node.content)}`;
    }).join("\n").slice(0, 2_000),
    queryTerms: [],
    sourceMemoryIds: utterances.map(node => node.id),
  };
}

function listSearchableMemories(repository, agentId, memoryIds) {
  const result = [];
  let offset = 0;
  while (true) {
    const page = repository.listMemories(agentId, {
      statuses: ["active", "superseded", "disputed"],
      memoryIds,
      limit: 200,
      offset,
    });
    result.push(...page.items);
    offset += page.items.length;
    if (!page.items.length || result.length >= page.total) break;
  }
  return result;
}

function listIndexableMemories(repository, agentId, memoryIds) {
  const searchable = listSearchableMemories(repository, agentId, memoryIds);
  const active = searchable.filter(memory => memory.status === 'active');
  const provisional = typeof repository.listPendingProvisionalMemories === "function"
    ? repository.listPendingProvisionalMemories(agentId, { limit: 5_000, memoryIds })
    : [];
  return {
    active,
    provisional,
    all: [...new Map(
      [...searchable, ...provisional].map((memory) => [memory.id, memory]),
    ).values()],
  };
}

function isRetryable(error) {
  if (error?.retryable || error?.name === "AbortError") return true;
  return /HTTP\s+(?:429|5\d\d)\b/u.test(String(error?.message || ""));
}

async function requestVectors(provider, texts, context) {
  const batched = typeof provider?.embedMany === 'function';
  const response = await (batched ? provider.embedMany(texts, context) : provider(texts[0], context));
  return { ...response, vectors: batched ? response.vectors : [response.vector] };
}

async function requestVectorsWithRetry(provider, texts, maxRetries, retryDelayMs, context, recordResponse) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    assertEventSourceExecutionCurrent();
    let response;
    try {
      response = await requestVectors(provider, texts, context);
    } catch (error) {
      await recordResponse(error);
      assertEventSourceExecutionCurrent();
      if (!isRetryable(error) || attempt >= maxRetries) throw error;
      await wait(Math.min(4_000, retryDelayMs * (2 ** attempt)), undefined, { signal: context.signal });
      continue;
    }
    await recordResponse(response);
    assertEventSourceExecutionCurrent();
    return response;
  }
}

async function recordUsage({
  ledgerPath,
  response,
  agentId,
  model,
  batchSize,
  dimensions,
}) {
  if (!clean(ledgerPath) || !response?.usage || !Object.keys(response.usage).length) return [];
  const errors = [];
  try {
    await appendUsageEvent(ledgerPath, {
      agentId,
      provider: response.metadata?.provider || "",
      model: clean(response.model) || model,
      source: "memory-embedding-indexer",
      feature: "memory-index-embedding",
      requestId: response.requestId,
      usage: response.usage,
      metadata: { ...response.metadata, batchSize, dimensions },
    });
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

function storePreparedEmbeddings({ repository, agentId, model, items, vectors, sourceView }) {
  if (!items.length) return { stored: [], skipped: [], failures: [] };
  return repository.transaction(() => {
    const stored = [], skipped = [], failures = [];
    for (let index = 0; index < items.length; index++) {
      assertEventSourceExecutionCurrent();
      const item = items[index], current = repository.getMemory(item.memory.id);
      if (!current || current.status === 'deleted') { skipped.push(item.memory.id); continue; }
      const document = prepareMemoryEmbeddingDocument(repository, current, { sourceView });
      if (current.agent_id !== agentId || (sourceView && !sourceView.allows(current))
        || document.contentHash !== item.contentHash) {
        failures.push({ memoryIds: [item.memory.id], error: 'Embedding source changed before persistence.',
          errorCode: 'MEMORY_EMBEDDING_SOURCE_CHANGED' });
        continue;
      }
      repository.upsertEmbedding({ memoryId: current.id, model, vector: vectors[index], contentHash: document.contentHash,
        sourceMemoryIds: document.retrievalContext?.sourceMemoryIds || [current.id] });
      stored.push(current.id);
    }
    return { stored, skipped, failures };
  });
}

export async function syncMemoryEmbeddings({
  repository,
  agentId,
  embeddingProvider,
  model = embeddingProvider?.model,
  dimensions = embeddingProvider?.dimensions || 0,
  ledgerPath = "",
  batchSize = DEFAULT_BATCH_SIZE,
  maxRetries = 2,
  retryDelayMs = 500,
  excludedKinds = DEFAULT_EXCLUDED_KINDS,
  memoryIds = [],
  limit = Number.POSITIVE_INFINITY,
  force = false,
  dryRun = false,
  continueOnError = true,
  onProgress = null,
} = {}) {
  if (!repository?.listMemories || !repository?.upsertEmbedding) {
    throw new Error("syncMemoryEmbeddings 需要 MemoryRepository。");
  }
  const normalizedAgentId = clean(agentId);
  const normalizedModel = clean(model);
  if (!normalizedAgentId) throw new Error("syncMemoryEmbeddings 需要 agentId。");
  if (typeof embeddingProvider !== "function") throw new Error("syncMemoryEmbeddings 需要 embeddingProvider。");
  if (!normalizedModel) throw new Error("syncMemoryEmbeddings 需要明确的 model。");

  const excluded = new Set((Array.isArray(excludedKinds) ? excludedKinds : []).map(clean));
  const selectedIds = new Set((Array.isArray(memoryIds) ? memoryIds : []).map(clean).filter(Boolean));
  const indexable = listIndexableMemories(repository, normalizedAgentId, selectedIds.size ? [...selectedIds] : null);
  const sourceView = executionEventSourceView(repository, normalizedAgentId);
  // Analysis drafts use the same node and vector stores, but are only indexed
  // when explicitly requested; they are not recalled as established memories.
  for (const id of selectedIds) {
    if (indexable.all.some(memory => memory.id === id)) continue;
    const memory = repository.getMemory(id);
    if (memory?.agent_id === normalizedAgentId && memory.status !== 'deleted'
      && memory.metadata?.stateAnalysisDraft === true) indexable.all.push(memory);
  }
  const all = indexable.all;
  const longTerm = all.filter((memory) => !excluded.has(memory.kind));
  const eligible = longTerm
    .filter((memory) => !sourceView || sourceView.allows(memory))
    .filter((memory) => !selectedIds.size || selectedIds.has(memory.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const prepared = eligible.map((memory) => {
    return {
      memory,
      ...prepareMemoryEmbeddingDocument(repository, memory, { sourceView }),
    };
  });
  const existing = new Map(repository.listEmbeddings(normalizedAgentId, normalizedModel, {
    includeArchived: true,
    memoryIds: eligible.map(memory => memory.id),
    contentHashes: force ? [] : prepared.map(item => item.contentHash),
  }).map(embedding => [embedding.memory_id, embedding]));
  for (const item of prepared) item.current = existing.get(item.memory.id) || null;
  const byContent = new Map([...existing.values()].filter(embedding => (
    (!dimensions || embedding.dimensions === dimensions)
    && (!sourceView || sourceView.allows(repository.getMemory(embedding.memory_id)))
  )).map(embedding => [embedding.content_hash, embedding]));
  const canReuse = item => !force && item.current?.content_hash === item.contentHash
    && (!dimensions || item.current.dimensions === dimensions);
  const reusable = prepared.filter(canReuse);
  const copied = [];
  const allPending = prepared.filter((item) => {
    if (canReuse(item)) return false;
    const cached = !force && byContent.get(item.contentHash);
    if (!cached) return true;
    copied.push(item);
    return false;
  });
  const pending = allPending.slice(
    0,
    Math.max(0, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : prepared.length),
  );
  const copies = dryRun ? { stored: copied.map(item => item.memory.id), skipped: [], failures: [] }
    : storePreparedEmbeddings({ repository, agentId: normalizedAgentId, model: normalizedModel, sourceView,
      items: copied, vectors: copied.map(item => byContent.get(item.contentHash).vector) });
  const report = {
    status: dryRun ? "planned" : "ready",
    agentId: normalizedAgentId,
    model: normalizedModel,
    dimensions: Math.max(0, Math.trunc(Number(dimensions) || 0)),
    totalActive: indexable.active.length,
    totalIndexable: all.length,
    totalFormalActive: indexable.active.length,
    totalProvisional: indexable.provisional.length,
    totalEligible: eligible.length,
    excludedByKind: all.length - longTerm.length,
    notSelected: selectedIds.size ? longTerm.length - eligible.length : 0,
    reused: reusable.length + copies.stored.length,
    copied: copies.stored.length,
    pending: pending.length,
    deferred: allPending.length - pending.length,
    added: 0,
    skipped: copies.skipped.length,
    failed: copies.failures.length,
    failures: copies.failures,
    usageLoggingErrors: [],
  };
  if (!dryRun && report.failed) report.status = report.copied ? 'partial' : 'error';
  if (dryRun || !pending.length) return report;

  const effectiveBatchSize = typeof embeddingProvider.embedMany === "function"
    ? Math.max(1, Math.min(10, Math.trunc(Number(batchSize) || DEFAULT_BATCH_SIZE)))
    : 1;
  let expectedDimensions = report.dimensions;
  for (let offset = 0; offset < pending.length; offset += effectiveBatchSize) {
    const batch = pending.slice(offset, offset + effectiveBatchSize);
    try {
      const response = await requestVectorsWithRetry(
        embeddingProvider,
        batch.map((item) => item.text),
        Math.max(0, Math.trunc(Number(maxRetries) || 0)),
        Math.max(1, Math.trunc(Number(retryDelayMs) || 500)),
        { sourceMaterial: eventSourceMaterial(repository, normalizedAgentId,
          batch.flatMap(item => [item.memory.id, ...(item.retrievalContext?.sourceMemoryIds || [])])),
          signal: currentEventSourceExecution()?.signal,
          model: normalizedModel, dimensions: expectedDimensions },
        async response => report.usageLoggingErrors.push(...await recordUsage({
          ledgerPath, response, agentId: normalizedAgentId, model: normalizedModel,
          batchSize: batch.length, dimensions: expectedDimensions,
        })),
      );
      if (clean(response.model) && clean(response.model) !== normalizedModel) {
        throw new Error(`Embedding 模型发生变化：预期 ${normalizedModel}，实际 ${response.model}。`);
      }
      if (!Array.isArray(response.vectors) || response.vectors.length !== batch.length) {
        throw new Error(`Embedding provider 应返回 ${batch.length} 个向量。`);
      }
      const vectors = response.vectors.map(normalizeVector);
      for (const vector of vectors) {
        if (!expectedDimensions) expectedDimensions = vector.length;
        if (vector.length !== expectedDimensions) {
          throw new Error(`Embedding 维度发生变化：预期 ${expectedDimensions}，实际 ${vector.length}。`);
        }
      }
      const written = storePreparedEmbeddings({ repository, agentId: normalizedAgentId,
        model: normalizedModel, items: batch, vectors, sourceView });
      report.added += written.stored.length;
      report.skipped += written.skipped.length;
      report.failed += written.failures.length;
      report.failures.push(...written.failures);
    } catch (error) {
      assertEventSourceExecutionCurrent();
      report.failed += batch.length;
      report.failures.push({
        memoryIds: batch.map((item) => item.memory.id),
        error: error.message,
      });
      if (!continueOnError) throw error;
    }
    report.dimensions = expectedDimensions;
    if (typeof onProgress === "function") {
      onProgress({
        completed: Math.min(pending.length, offset + batch.length),
        total: pending.length,
        added: report.added,
        failed: report.failed,
      });
    }
  }
  report.status = report.failed ? (report.added || report.copied ? "partial" : "error") : "ready";
  return report;
}

export {
  DEFAULT_BATCH_SIZE,
  DEFAULT_EXCLUDED_KINDS,
};

export {
  assessMemoryRetrievalContextCriticNeed,
  normalizeProposal as parseMemoryRetrievalContextProposal,
  normalizeCritique as parseMemoryRetrievalContextCritique,
  assessMemoryRetrievalContextNeed,
  generateMemoryRetrievalContexts,
  CRITIC_SCHEMA as MEMORY_RETRIEVAL_CONTEXT_CRITIC_SCHEMA,
  DEFAULT_CONTEXT_EXCLUDED_KINDS,
  DEFAULT_POLICY_VERSION as DEFAULT_RETRIEVAL_CONTEXT_POLICY_VERSION,
  DEFAULT_PROMPT_VERSION as DEFAULT_RETRIEVAL_CONTEXT_PROMPT_VERSION,
  DEFAULT_SHORT_CONTENT_THRESHOLD_CHARS,
  PROPOSAL_SCHEMA as MEMORY_RETRIEVAL_CONTEXT_PROPOSAL_SCHEMA,
} from "./contextualizer.mjs";
