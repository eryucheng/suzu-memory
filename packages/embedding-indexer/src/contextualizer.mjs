import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-memory/usage-ledger";
import {
  buildMemoryRetrievalContextSource,
  memoryRetrievalContextSourceHash,
  executionEventSourceView,
  eventSourceMaterial,
  assertEventSourceExecutionCurrent,
} from "@suzu-memory/core";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");
const DEFAULT_POLICY_VERSION = "retrieval-context-v1";
const DEFAULT_PROMPT_VERSION = "retrieval-context-v1";
const DEFAULT_CONTEXT_EXCLUDED_KINDS = Object.freeze(["utterance", "topic_or_episode"]);
const DEFAULT_SHORT_CONTENT_THRESHOLD_CHARS = 32;

const LEADING_REFERENCE_PATTERN = /^(?:(?:对|嗯|啊|哦)[，,。\s]*)?(?:(?:这|那)(?:个|件|次|段|些|种|里|边|时候|句话|回事)|(?:他|她|它)(?:当时|后来|之前|之后|又|也|就|才|说|做|觉得))/u;

const PROPOSAL_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["context", "queryTerms"],
  properties: {
    context: { type: "string", minLength: 8, maxLength: 600 },
    queryTerms: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 40 },
    },
  },
});

const CRITIC_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["approved", "issues"],
  properties: {
    approved: { type: "boolean" },
    issues: {
      type: "array",
      maxItems: 12,
      items: { type: "string", minLength: 1, maxLength: 240 },
    },
  },
});

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function meaningful(value) {
  const normalized = clean(value);
  return normalized && !["unknown", "unspecified", "not_applicable"].includes(normalized);
}

function contentCharacters(value) {
  return [...clean(value).replace(/\s+/gu, "")].length;
}

const NEGATION_PATTERN = /(?:不|没|无|未|并非|不是|从不|不再|没有)/u;

export function assessMemoryRetrievalContextCriticNeed(memory = {}, selection = {}) {
  const source = buildMemoryRetrievalContextSource(memory);
  const reasons = [];
  if ((Array.isArray(selection.reasons) ? selection.reasons : []).includes("leading-reference")) {
    reasons.push("unresolved-reference");
  }
  if (!source.subjectRole || source.subjectRole === "shared") reasons.push("subject-boundary");
  if (source.reality && source.reality !== "real") reasons.push("world-boundary");
  if (meaningful(source.stateFamily) || meaningful(source.statePhase)
    || source.representationLayer === "inferred") {
    reasons.push("state-boundary");
  }
  if (source.eventDate || source.eventStart || source.eventEnd
    || source.validFrom || source.validTo) {
    reasons.push("time-boundary");
  }
  if (NEGATION_PATTERN.test(source.content)) reasons.push("negation-boundary");
  return {
    needed: reasons.length > 0,
    reasons: uniqueStrings(reasons),
  };
}

export function assessMemoryRetrievalContextNeed(memory = {}, {
  shortContentThresholdChars = DEFAULT_SHORT_CONTENT_THRESHOLD_CHARS,
} = {}) {
  const content = clean(memory.content);
  const title = clean(memory.title);
  const contentChars = contentCharacters(content);
  const reasons = [];
  const maximumChars = Math.max(
    8,
    Math.min(120, Math.trunc(Number(shortContentThresholdChars)
      || DEFAULT_SHORT_CONTENT_THRESHOLD_CHARS)),
  );
  if (contentChars <= maximumChars) reasons.push("short-content");
  if (LEADING_REFERENCE_PATTERN.test(content)) reasons.push("leading-reference");
  return {
    needed: reasons.length > 0,
    reasons,
    metrics: {
      contentChars,
      titleChars: contentCharacters(title),
      shortContentThresholdChars: maximumChars,
    },
  };
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  return keys.length === required.length && keys.every((key, index) => key === required[index]);
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

function readPrompt(promptDirectory, filename) {
  return fs.readFileSync(path.join(path.resolve(promptDirectory), filename), "utf8")
    .replace(/^\uFEFF/u, "")
    .trim();
}

export function normalizeProposal(output) {
  if (!hasExactKeys(output, ["context", "queryTerms"]) || !Array.isArray(output.queryTerms)) {
    throw new Error("检索上下文提案不符合固定 Schema。");
  }
  const context = clean(output.context).replace(/\s+/gu, " ");
  const queryTerms = uniqueStrings(output.queryTerms).slice(0, 12);
  if (context.length < 8 || context.length > 600) {
    throw new Error("检索上下文必须为 8 到 600 个字符。");
  }
  if (queryTerms.some((term) => term.length > 40)) {
    throw new Error("检索查询表达不能超过 40 个字符。");
  }
  return { context, queryTerms };
}

export function normalizeCritique(output) {
  if (!hasExactKeys(output, ["approved", "issues"]) || !Array.isArray(output.issues)) {
    throw new Error("检索上下文审查结果不符合固定 Schema。");
  }
  if (typeof output.approved !== "boolean") {
    throw new Error("检索上下文审查结果缺少 approved 布尔值。");
  }
  const issues = uniqueStrings(output.issues).slice(0, 12);
  if (issues.some((issue) => issue.length > 240)) {
    throw new Error("检索上下文审查问题不能超过 240 个字符。");
  }
  if (output.approved && issues.length) {
    throw new Error("检索上下文不能在存在审查问题时被批准。");
  }
  if (!output.approved && !issues.length) {
    throw new Error("被拒绝的检索上下文必须说明问题。");
  }
  return { approved: output.approved, issues };
}

async function recordGenerationUsage({
  ledgerPath,
  generation,
  agentId,
  memoryId,
  feature,
  policyVersion,
}) {
  if (!clean(ledgerPath) || !generation?.model || !generation?.usage) return "";
  try {
    await appendUsageEvent(path.resolve(ledgerPath), {
      agentId,
      provider: generation.metadata?.provider || "",
      model: generation.model,
      source: "memory-embedding-indexer",
      feature,
      requestId: generation.requestId || "",
      usage: generation.usage,
      metadata: {
        memoryId,
        policyVersion,
        durationMs: Number(generation.durationMs || 0),
        ...generation.metadata,
      },
    });
    return "";
  } catch (error) {
    return `费用流水写入失败：${error.message}`;
  }
}

export async function generateMemoryRetrievalContexts({
  repository,
  agentId,
  proposer,
  critic,
  policyVersion = DEFAULT_POLICY_VERSION,
  promptVersion = DEFAULT_PROMPT_VERSION,
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
  ledgerPath = "",
  excludedKinds = DEFAULT_CONTEXT_EXCLUDED_KINDS,
  memoryIds = [],
  limit = Number.POSITIVE_INFINITY,
  shortContentThresholdChars = DEFAULT_SHORT_CONTENT_THRESHOLD_CHARS,
  continueOnError = true,
  onProgress = null,
} = {}) {
  if (!repository?.listMemories || !repository?.upsertMemoryRetrievalContext) {
    throw new Error("generateMemoryRetrievalContexts 需要 MemoryRepository。");
  }
  const normalizedAgentId = clean(agentId);
  const normalizedPolicyVersion = clean(policyVersion);
  const normalizedPromptVersion = clean(promptVersion);
  if (!normalizedAgentId) throw new Error("generateMemoryRetrievalContexts 需要 agentId。");
  if (typeof proposer !== "function" || typeof critic !== "function") {
    throw new Error("检索上下文生成需要相互独立的 proposer 与 critic。");
  }
  if (!normalizedPolicyVersion || !normalizedPromptVersion) {
    throw new Error("检索上下文生成需要 policyVersion 与 promptVersion。");
  }

  const proposalPrompt = readPrompt(promptDirectory, "retrieval-context-system-prompt.md");
  const criticPrompt = readPrompt(promptDirectory, "retrieval-context-critic-system-prompt.md");
  const excluded = new Set((Array.isArray(excludedKinds) ? excludedKinds : []).map(clean));
  const selectedIds = new Set((Array.isArray(memoryIds) ? memoryIds : []).map(clean).filter(Boolean));
  const all = listActiveMemories(repository, normalizedAgentId);
  const sourceView = executionEventSourceView(repository, normalizedAgentId);
  const eligible = all
    .filter((memory) => !sourceView || sourceView.allows(memory))
    .filter((memory) => !excluded.has(memory.kind))
    .filter((memory) => !selectedIds.size || selectedIds.has(memory.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  const assessed = eligible.map((memory) => ({
    memory,
    current: repository.getCurrentMemoryRetrievalContext(memory.id, {
      policyVersion: normalizedPolicyVersion,
    }),
    selection: assessMemoryRetrievalContextNeed(memory, {
      shortContentThresholdChars,
    }),
  }));
  const reusable = assessed.filter((item) => item.current);
  const missing = assessed.filter((item) => !item.current);
  const selected = missing.filter((item) => item.selection.needed);
  const skipped = missing.filter((item) => !item.selection.needed);
  const allPending = selected.map((item) => item.memory);
  const pending = allPending
    .slice(0, Math.max(0, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : eligible.length));
  const selectionReasons = {};
  for (const item of selected) {
    for (const reason of item.selection.reasons) {
      selectionReasons[reason] = (selectionReasons[reason] || 0) + 1;
    }
  }
  const report = {
    status: "ready",
    agentId: normalizedAgentId,
    policyVersion: normalizedPolicyVersion,
    totalActive: all.length,
    totalEligible: eligible.length,
    reused: reusable.length,
    selected: selected.length,
    skipped: skipped.length,
    selectionReasons,
    pending: pending.length,
    deferred: allPending.length - pending.length,
    added: 0,
    rejected: 0,
    failed: 0,
    criticCalls: 0,
    locallyApproved: 0,
    results: [],
    usageLoggingErrors: [],
  };

  for (let index = 0; index < pending.length; index += 1) {
    const memory = pending[index];
    const selection = assessed.find((item) => item.memory.id === memory.id)?.selection || {};
    const criticNeed = assessMemoryRetrievalContextCriticNeed(memory, selection);
    const source = buildMemoryRetrievalContextSource(memory);
    const sourceHash = memoryRetrievalContextSourceHash(memory);
    const sourceMaterial = eventSourceMaterial(repository, normalizedAgentId, [memory.id]);
    let proposalGeneration = null;
    let criticGeneration = null;
    let proposal = null;
    let failureStage = "proposal";
    try {
      const proposalInput = JSON.stringify({
        task: "为单条长期记忆生成仅用于检索的上下文，不改写记忆事实。",
        source,
      });
      proposalGeneration = await proposer({
        input: proposalInput,
        systemPrompt: proposalPrompt,
        schema: PROPOSAL_SCHEMA,
        schemaName: "memory_retrieval_context_proposal_v1",
        ...(sourceMaterial ? { sourceMaterial } : {}),
        analyzerRole: "memory-retrieval-context-proposer",
      });
      proposal = normalizeProposal(proposalGeneration?.output);
      let critique;
      if (criticNeed.needed) {
        failureStage = "critic";
        const criticInput = JSON.stringify({
          task: "审查检索上下文是否完全受源记忆约束。",
          source,
          proposal,
          riskReasons: criticNeed.reasons,
        });
        criticGeneration = await critic({
          input: criticInput,
          systemPrompt: criticPrompt,
          schema: CRITIC_SCHEMA,
          schemaName: "memory_retrieval_context_critic_v1",
          ...(sourceMaterial ? { sourceMaterial } : {}),
          analyzerRole: "memory-retrieval-context-critic",
        });
        report.criticCalls += 1;
        critique = normalizeCritique(criticGeneration?.output);
      } else {
        report.locallyApproved += 1;
        critique = { approved: true, issues: [] };
      }
      if (!critique.approved) {
        report.rejected += 1;
        report.results.push({ memoryId: memory.id, status: "rejected", issues: critique.issues });
      } else {
        failureStage = "persistence";
        const stored = repository.upsertMemoryRetrievalContext({
          agentId: normalizedAgentId,
          memoryId: memory.id,
          policyVersion: normalizedPolicyVersion,
          sourceHash,
          contextText: proposal.context,
          queryTerms: proposal.queryTerms,
          provider: clean(proposalGeneration?.metadata?.provider),
          model: clean(proposalGeneration?.model),
          promptVersion: normalizedPromptVersion,
          proposalRequestId: clean(proposalGeneration?.requestId),
          criticRequestId: clean(criticGeneration?.requestId),
          usage: {
            proposal: proposalGeneration?.usage || {},
            critic: criticGeneration?.usage || {},
          },
          metadata: {
            criticProvider: clean(criticGeneration?.metadata?.provider),
            criticModel: clean(criticGeneration?.model),
            proposalDurationMs: Number(proposalGeneration?.durationMs || 0),
            criticDurationMs: Number(criticGeneration?.durationMs || 0),
            approvedByCritic: Boolean(criticGeneration),
            approvalMode: criticGeneration ? "independent-critic" : "local-low-risk-gate",
            criticRiskReasons: criticNeed.reasons,
          },
        });
        report.added += stored.wasInserted ? 1 : 0;
        report.results.push({ memoryId: memory.id, status: "added", contextId: stored.id });
      }
    } catch (error) {
      assertEventSourceExecutionCurrent();
      report.failed += 1;
      report.results.push({
        memoryId: memory.id,
        status: "failed",
        stage: failureStage,
        error: error.message,
        errorCode: clean(error.code),
        errorName: clean(error.name),
        sourceHash,
        candidate: proposal ? {
          context: proposal.context,
          queryTerms: proposal.queryTerms,
          provider: clean(proposalGeneration?.metadata?.provider),
          model: clean(proposalGeneration?.model),
          requestId: clean(proposalGeneration?.requestId),
        } : null,
      });
      if (!continueOnError) throw error;
    }
    for (const [generation, feature] of [
      [proposalGeneration, "memory-retrieval-context-proposal"],
      [criticGeneration, "memory-retrieval-context-critic"],
    ]) {
      const warning = await recordGenerationUsage({
        ledgerPath,
        generation,
        agentId: normalizedAgentId,
        memoryId: memory.id,
        feature,
        policyVersion: normalizedPolicyVersion,
      });
      if (warning) report.usageLoggingErrors.push(warning);
    }
    if (typeof onProgress === "function") {
      onProgress({
        completed: index + 1,
        total: pending.length,
        added: report.added,
        rejected: report.rejected,
        failed: report.failed,
      });
    }
  }
  report.status = report.failed
    ? (report.added || report.rejected ? "partial" : "error")
    : "ready";
  return report;
}

export {
  CRITIC_SCHEMA,
  DEFAULT_CONTEXT_EXCLUDED_KINDS,
  DEFAULT_POLICY_VERSION,
  DEFAULT_PROMPT_DIRECTORY,
  DEFAULT_PROMPT_VERSION,
  DEFAULT_SHORT_CONTENT_THRESHOLD_CHARS,
  PROPOSAL_SCHEMA,
};
