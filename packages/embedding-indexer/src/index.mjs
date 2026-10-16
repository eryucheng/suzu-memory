import crypto from "node:crypto";

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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

function listActiveMemories(repository, agentId) {
  const result = [];
  let offset = 0;
  while (true) {
    const page = repository.listMemories(agentId, {
      statuses: ["active"],
      limit: 200,
      offset,
    });
    result.push(...page.items);
    offset += page.items.length;
    if (!page.items.length || result.length >= page.total) break;
  }
  return result;
}

function listIndexableMemories(repository, agentId) {
  const active = listActiveMemories(repository, agentId);
  const provisional = typeof repository.listPendingProvisionalMemories === "function"
    ? repository.listPendingProvisionalMemories(agentId, { limit: 5_000 })
    : [];
  return {
    active,
    provisional,
    all: [...new Map(
      [...active, ...provisional].map((memory) => [memory.id, memory]),
    ).values()],
  };
}

function isRetryable(error) {
  if (error?.retryable || error?.name === "AbortError") return true;
  return /HTTP\s+(?:429|5\d\d)\b/u.test(String(error?.message || ""));
}

async function requestVectors(provider, texts, context) {
  if (typeof provider?.embedMany === "function") {
    const response = await provider.embedMany(texts, context);
    return {
      vectors: response.vectors,
      model: response.model,
      requests: [{
        usage: response.usage || {},
        requestId: response.requestId || "",
        metadata: response.metadata || {},
      }],
    };
  }
  const response = await provider(texts[0], context);
  return {
    vectors: [response.vector],
    model: response.model,
    requests: [{
      usage: response.usage || {},
      requestId: response.requestId || "",
      metadata: response.metadata || {},
    }],
  };
}

async function requestVectorsWithRetry(provider, texts, maxRetries, retryDelayMs, context) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      assertEventSourceExecutionCurrent();
      const result = await requestVectors(provider, texts, context);
      assertEventSourceExecutionCurrent();
      return result;
    } catch (error) {
      lastError = error;
      assertEventSourceExecutionCurrent();
      if (!isRetryable(error) || attempt >= maxRetries) break;
      await sleep(Math.min(4_000, retryDelayMs * (2 ** attempt)));
    }
  }
  throw lastError;
}

async function recordUsage({
  ledgerPath,
  requests,
  agentId,
  model,
  batchSize,
  dimensions,
}) {
  if (!clean(ledgerPath)) return [];
  const errors = [];
  for (const request of requests) {
    if (!request.usage || !Object.keys(request.usage).length) continue;
    try {
      await appendUsageEvent(ledgerPath, {
        agentId,
        provider: request.metadata?.provider || "",
        model,
        source: "memory-embedding-indexer",
        feature: "memory-index-embedding",
        requestId: request.requestId,
        usage: request.usage,
        metadata: {
          ...request.metadata,
          batchSize,
          dimensions,
        },
      });
    } catch (error) {
      errors.push(error.message);
    }
  }
  return errors;
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
  const indexable = listIndexableMemories(repository, normalizedAgentId);
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
  const existing = new Map(
    repository.listEmbeddings(normalizedAgentId, normalizedModel, { includeArchived: true })
      .map((embedding) => [embedding.memory_id, embedding]),
  );
  const prepared = eligible.map((memory) => {
    return {
      memory,
      ...prepareMemoryEmbeddingDocument(repository, memory, { sourceView }),
      current: existing.get(memory.id) || null,
    };
  });
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
    if (!dryRun) repository.upsertEmbedding({ memoryId: item.memory.id, model: normalizedModel,
      vector: cached.vector, contentHash: item.contentHash,
      sourceMemoryIds: item.retrievalContext?.sourceMemoryIds || [item.memory.id] });
    copied.push(item);
    return false;
  });
  const pending = allPending.slice(
    0,
    Math.max(0, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : prepared.length),
  );
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
    reused: reusable.length + copied.length,
    copied: copied.length,
    pending: pending.length,
    deferred: allPending.length - pending.length,
    added: 0,
    failed: 0,
    failures: [],
    usageLoggingErrors: [],
  };
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
      repository.transaction(() => {
        for (let index = 0; index < batch.length; index += 1) {
          repository.upsertEmbedding({
            memoryId: batch[index].memory.id,
            model: normalizedModel,
            vector: vectors[index],
            contentHash: batch[index].contentHash,
            sourceMemoryIds: batch[index].retrievalContext?.sourceMemoryIds || [batch[index].memory.id],
          });
        }
      });
      report.added += batch.length;
      report.usageLoggingErrors.push(...await recordUsage({
        ledgerPath,
        requests: response.requests,
        agentId: normalizedAgentId,
        model: normalizedModel,
        batchSize: batch.length,
        dimensions: expectedDimensions,
      }));
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
  report.status = report.failed ? (report.added ? "partial" : "error") : "ready";
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
