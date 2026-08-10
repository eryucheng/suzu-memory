import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-memory/usage-ledger";

import {
  buildRewardAnalyzerInput,
  parseRewardCreditGeneration,
  parseRewardOutcomeGeneration,
  parseRewardTargetGeneration,
  REWARD_CREDIT_ANALYZERS,
} from "./reward-credit-contracts.mjs";
import {
  createRewardCreditProposals,
  createRewardPathCreditProposals,
  REWARD_CREDIT_POLICY_VERSION,
} from "./reward-credit-policy.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_DIRECTORY = path.join(PACKAGE_ROOT, "resources");
export const REWARD_CREDIT_PROCESSOR_VERSION = "reward-credit-processor-v1";

function clean(value) {
  return String(value ?? "").trim();
}

function auditableOutput(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  return { rawText: String(value ?? "") };
}

function preparation(repository, agentId, observation) {
  const request = repository.getRetrievalUsageRequest(agentId, observation.usage_request_id);
  if (!request) return { blocked: "reward-usage-request-is-missing" };
  if (request.status === "pending") return { waiting: "retrieval-usage-analysis-is-pending" };
  if (request.status !== "completed") return { blocked: "retrieval-usage-analysis-did-not-complete" };
  const trace = repository.getRetrievalTrace(agentId, request.trace_id);
  if (!trace || trace.result_status !== "ready") return { blocked: "reward-trace-is-no-longer-eligible" };
  const usedMemoryIds = [...new Set(
    (Array.isArray(request.result?.usedMemoryIds) ? request.result.usedMemoryIds : [])
      .map(clean)
      .filter(Boolean),
  )];
  if (!usedMemoryIds.length) return { blocked: "no-response-grounded-used-memories" };
  const selected = new Set(trace.selectedIds);
  if (usedMemoryIds.some((memoryId) => !selected.has(memoryId))) {
    return { blocked: "used-memory-exceeded-retrieval-trace-boundary" };
  }
  const memories = usedMemoryIds.map((memoryId) => repository.getMemory(memoryId));
  if (memories.some((memory) => !memory || memory.agent_id !== agentId)) {
    return { blocked: "reward-memory-is-missing-or-cross-agent" };
  }
  return { request, trace, memories, usedMemoryIds };
}

function parser(role, output, usedMemoryIds) {
  if (role === "outcome") return parseRewardOutcomeGeneration(output);
  if (role === "target") return parseRewardTargetGeneration(output, { allowedMemoryIds: usedMemoryIds });
  if (role === "credit") return parseRewardCreditGeneration(output, { expectedMemoryIds: usedMemoryIds });
  throw new Error(`Unknown reward analyzer role: ${role}.`);
}

async function invokeAnalyzer({
  role,
  generator,
  snapshot,
  prior,
  promptDirectory,
  usedMemoryIds,
}) {
  const definition = REWARD_CREDIT_ANALYZERS[role];
  const input = buildRewardAnalyzerInput({
    role,
    snapshot,
    outcome: prior.outcome || null,
    target: prior.target || null,
  });
  const systemPrompt = fs.readFileSync(
    path.join(path.resolve(promptDirectory), definition.promptFile),
    "utf8",
  ).replace(/^\uFEFF/u, "").trim();
  let generation = null;
  try {
    generation = await generator({
      input,
      systemPrompt,
      schema: definition.schema,
      schemaName: definition.schemaName,
      analyzerRole: `reward-${role}`,
    });
    return {
      definition,
      input,
      generation,
      parsed: parser(role, generation?.output, usedMemoryIds),
      status: "completed",
      error: "",
    };
  } catch (error) {
    return {
      definition,
      input,
      generation,
      parsed: null,
      status: generation ? "rejected" : "failed",
      error: clean(error?.message) || `reward-${role}-analysis-failed`,
    };
  }
}

async function appendAnalyzerUsage({ usageLedgerPath, invocation, agentId, observationId }) {
  const generation = invocation.generation;
  if (!clean(usageLedgerPath) || !generation?.model || !generation?.usage) return "";
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), {
      agentId,
      provider: clean(generation.metadata?.provider),
      model: generation.model,
      source: "memory-evaluation",
      feature: `memory-reward-${invocation.definition.role}`,
      requestId: clean(generation.requestId),
      usage: generation.usage,
      metadata: {
        rewardObservationId: observationId,
        durationMs: Math.max(0, Number(generation.durationMs || 0)),
        ...generation.metadata,
      },
    });
    return "";
  } catch (error) {
    return `费用流水写入失败：${error.message}`;
  }
}

function persistRun(repository, agentId, observationId, invocation) {
  const generation = invocation.generation;
  return repository.recordRewardAnalysisRun({
    observationId,
    agentId,
    analyzerRole: invocation.definition.role,
    provider: clean(generation?.metadata?.provider) || "unreported",
    model: clean(generation?.model) || "unreported",
    promptVersion: invocation.definition.promptVersion,
    schemaVersion: invocation.definition.schemaName,
    inputHash: createHash("sha256").update(invocation.input).digest("hex"),
    status: invocation.status,
    output: auditableOutput(generation?.output),
    usage: generation?.usage || {},
    requestExternalId: clean(generation?.requestId),
    durationMs: generation?.durationMs,
    errorMessage: invocation.error,
    metadata: {
      processorVersion: REWARD_CREDIT_PROCESSOR_VERSION,
      policyVersion: REWARD_CREDIT_POLICY_VERSION,
      automaticStateMutationAllowed: false,
    },
  });
}

export async function processRewardObservation({
  repository,
  agentId,
  observationId,
  analyzers = {},
  usageLedgerPath = "",
  promptDirectory = DEFAULT_PROMPT_DIRECTORY,
} = {}) {
  if (!repository) throw new Error("Reward processing requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedObservationId = clean(observationId);
  if (!normalizedAgentId || !normalizedObservationId) {
    throw new Error("Reward processing requires agentId and observationId.");
  }
  const observation = repository.getRewardObservation(normalizedAgentId, normalizedObservationId);
  if (!observation) throw new Error("Reward observation was not found.");
  if (observation.status !== "pending") {
    return {
      status: "already-resolved",
      observation,
      runs: {},
      proposals: [],
      pathProposals: [],
      warnings: [],
    };
  }
  const prepared = preparation(repository, normalizedAgentId, observation);
  if (prepared.waiting) {
    return {
      status: "waiting-for-usage-analysis",
      reason: prepared.waiting,
      observation,
      runs: {},
      proposals: [],
      pathProposals: [],
      warnings: [],
    };
  }
  if (prepared.blocked) {
    const resolved = repository.resolveRewardObservation({
      agentId: normalizedAgentId,
      observationId: observation.id,
      status: "blocked",
      errorMessage: prepared.blocked,
      result: { reason: prepared.blocked },
    });
    return {
      status: "blocked",
      reason: prepared.blocked,
      observation: resolved,
      runs: {},
      proposals: [],
      pathProposals: [],
      warnings: [],
    };
  }
  for (const role of Object.keys(REWARD_CREDIT_ANALYZERS)) {
    if (typeof analyzers[role] !== "function") {
      throw new Error(`Reward processing requires analyzers.${role}.`);
    }
  }
  const snapshot = {
    observation,
    request: prepared.request,
    trace: prepared.trace,
    memories: prepared.memories,
  };
  const prior = {};
  const runs = {};
  const warnings = [];
  for (const role of ["outcome", "target", "credit"]) {
    const invocation = await invokeAnalyzer({
      role,
      generator: analyzers[role],
      snapshot,
      prior,
      promptDirectory,
      usedMemoryIds: prepared.usedMemoryIds,
    });
    const warning = await appendAnalyzerUsage({
      usageLedgerPath,
      invocation,
      agentId: normalizedAgentId,
      observationId: observation.id,
    });
    if (warning) warnings.push(warning);
    runs[role] = persistRun(repository, normalizedAgentId, observation.id, invocation);
    if (invocation.status !== "completed") {
      return {
        status: "retryable-failure",
        reason: invocation.error,
        failedRole: role,
        observation: repository.getRewardObservation(normalizedAgentId, observation.id),
        runs,
        proposals: [],
        pathProposals: [],
        warnings,
      };
    }
    prior[role] = invocation.parsed;
  }
  const candidates = createRewardCreditProposals({
    observation,
    trace: prepared.trace,
    outcome: prior.outcome,
    target: prior.target,
    credits: prior.credit,
  });
  const completed = repository.transaction(() => {
    const proposals = candidates.map((candidate) => repository.recordRewardCreditProposal({
      ...candidate,
      agentId: normalizedAgentId,
    }));
    const pathCandidates = createRewardPathCreditProposals({
      trace: prepared.trace,
      memoryProposals: proposals.map((proposal) => ({
        id: proposal.id,
        observationId: proposal.observation_id,
        memoryId: proposal.memory_id,
        contextKey: proposal.context_key,
        rewardDirection: proposal.reward_direction,
        rewardValue: proposal.reward_value,
        proposedUtilityDelta: proposal.proposed_utility_delta,
        status: proposal.status,
      })),
    });
    const pathProposals = pathCandidates.map((candidate) => (
      repository.recordRewardPathCreditProposal({
        ...candidate,
        agentId: normalizedAgentId,
      })
    ));
    const result = {
      analyzerRunIds: Object.fromEntries(Object.entries(runs).map(([role, run]) => [role, run.id])),
      proposalIds: proposals.map((proposal) => proposal.id),
      pathProposalIds: pathProposals.map((proposal) => proposal.id),
      eligibleProposalIds: proposals.filter((proposal) => proposal.status === "eligible").map((proposal) => proposal.id),
      eligiblePathProposalIds: pathProposals
        .filter((proposal) => proposal.status === "eligible")
        .map((proposal) => proposal.id),
      pendingProposalIds: proposals.filter((proposal) => proposal.status === "pending").map((proposal) => proposal.id),
      blockedProposalIds: proposals.filter((proposal) => proposal.status === "blocked").map((proposal) => proposal.id),
      automaticStateMutationAllowed: false,
    };
    return {
      proposals,
      pathProposals,
      observation: repository.resolveRewardObservation({
        agentId: normalizedAgentId,
        observationId: observation.id,
        status: "analyzed",
        result,
      }),
    };
  });
  return {
    status: "analyzed",
    reason: "",
    ...completed,
    runs,
    warnings,
    automaticStateMutationAllowed: false,
  };
}

export async function processPendingRewardObservations({
  repository,
  agentId,
  analyzers = {},
  maxObservations,
  usageLedgerPath = "",
} = {}) {
  if (!repository) throw new Error("Reward batch processing requires a repository.");
  const normalizedAgentId = clean(agentId);
  const maximum = Number(maxObservations);
  if (!normalizedAgentId || !Number.isInteger(maximum) || maximum < 1 || maximum > 500) {
    throw new Error("Reward batch processing requires agentId and maxObservations between 1 and 500.");
  }
  const observations = repository.listRewardObservations(normalizedAgentId, {
    statuses: ["pending"],
    limit: maximum,
  });
  const results = [];
  for (const observation of observations) {
    try {
      results.push(await processRewardObservation({
        repository,
        agentId: normalizedAgentId,
        observationId: observation.id,
        analyzers,
        usageLedgerPath,
      }));
    } catch (error) {
      results.push({
        status: "retryable-failure",
        reason: clean(error?.message) || "reward-observation-processing-failed",
        observation: repository.getRewardObservation(normalizedAgentId, observation.id),
        runs: {},
        proposals: [],
        pathProposals: [],
        warnings: [],
      });
    }
  }
  const statuses = [
    "analyzed", "waiting-for-usage-analysis", "blocked", "retryable-failure", "already-resolved",
  ];
  const counts = Object.fromEntries(statuses.map((status) => [
    status,
    results.filter((item) => item.status === status).length,
  ]));
  return {
    status: results.length === 0
      ? "empty"
      : counts["retryable-failure"] ? "partial-failure"
        : counts["waiting-for-usage-analysis"] ? "waiting"
          : "completed",
    processorVersion: REWARD_CREDIT_PROCESSOR_VERSION,
    policyVersion: REWARD_CREDIT_POLICY_VERSION,
    selected: observations.length,
    counts,
    results,
    automaticStateMutationAllowed: false,
  };
}
