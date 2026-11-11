import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-memory/usage-ledger";
import { proposeMemoryRelation } from "@suzu-memory/core";

import { enforceRelationCandidatePolicy } from "./relation-candidate-policy.mjs";
import {
  buildRelationGenerationInput,
  relationOutputSchema,
  parseRelationGeneration,
} from "./relation-prompt.mjs";
import { buildRelationSnapshot } from "./relation-snapshot.mjs";
import { DEFAULT_MAXIMUM_PROPOSALS, proposalCountLimit } from './prompt.mjs';
import { withGenerationReferences, assertGenerationRequestBudget, RELATION_REQUEST_CHARACTERS } from './generation-input.mjs';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "resources", "relation-system-prompt.md");
const EXCERPT_INSTRUCTIONS = '标有 excerpt 的 sourceRecords 保留了原话中的因果片段。结合 memories 判断因果时，先检查片段是否足以核实两端事件、因果方向及必要条件。涉及未给出的上下文、跨轮指代或条件时，返回 needsFullEvidence: true 和空 proposals，获取完整原话后再判断；证据充足时返回 needsFullEvidence: false 并给出提案。';

function clean(value) {
  return String(value ?? "").trim();
}

function stableBatchId(agentId, memoryIds) {
  const hash = createHash("sha256")
    .update(`${clean(agentId)}\u001f${[...new Set(memoryIds.map(clean).filter(Boolean))].sort().join("\u001f")}`)
    .digest("hex")
    .slice(0, 24);
  return `relation-batch-${hash}`;
}

async function recordUsage({ generation, usageLedgerPath, agentId, batchId, warnings }) {
  if (!clean(usageLedgerPath) || !generation?.model) return false;
  const usage = generation.usage && typeof generation.usage === "object" ? generation.usage : {};
  if (!Object.keys(usage).length) return false;
  try {
    await appendUsageEvent(path.resolve(usageLedgerPath), {
      agentId,
      provider: generation.metadata?.provider || "",
      model: generation.model,
      source: "memory-structurer",
      feature: "memory-relation-proposal",
      requestId: generation.requestId || "",
      usage,
      metadata: {
        batchId,
        durationMs: Number(generation.durationMs || 0),
        ...generation.metadata,
      },
    });
    return true;
  } catch (error) {
    warnings.push(`费用流水写入失败：${error.message}`);
    return false;
  }
}

export function prepareRelationGeneration({
  repository, agentId, batchId, memoryIds,
  snapshotOptions = {}, systemPromptPath = DEFAULT_PROMPT_PATH, generator, maximumProposals = DEFAULT_MAXIMUM_PROPOSALS,
  maximumRequestCharacters = RELATION_REQUEST_CHARACTERS,
}) {
  const limit = proposalCountLimit(maximumProposals);
  if (limit === 0) return { snapshot: null, request: null, reason: 'proposal-budget-zero' };
  const snapshot = buildRelationSnapshot({
    repository,
    agentId: agentId,
    batchId: batchId,
    memoryIds: memoryIds,
    maxSnapshotChars: Infinity, ...snapshotOptions,
  });
  if (snapshot.memories.length < 2 || !snapshot.sourceRecords.length) return { snapshot, request: null, reason: snapshot.memories.length < 2 ? "fewer-than-two-eligible-memories" : "no-source-evidence" };
  const systemPrompt = fs.readFileSync(path.resolve(systemPromptPath), "utf8").trim();
  const buildRequest = excerpted => withGenerationReferences({
    input: buildRelationGenerationInput(snapshot, { excerpted }),
    systemPrompt: excerpted ? `${systemPrompt}\n\n${EXCERPT_INSTRUCTIONS}` : systemPrompt,
    schema: relationOutputSchema(limit, { excerpted }),
    schemaName: "memory-relation-proposals-v1",
    ...(snapshot.sourceMaterial ? { sourceMaterial: snapshot.sourceMaterial } : {}),
  });
  const fullRequest = buildRequest(false);
  assertGenerationRequestBudget(fullRequest, maximumRequestCharacters, generator);
  if (snapshot.sourceExcerpts?.size) {
    const request = buildRequest(true);
    const requestSize = value => generator?.measureRequest ? generator.measureRequest(value)
      : value.modelInput.length + value.systemPrompt.length + JSON.stringify(value.schema).length;
    if (requestSize(request) < requestSize(fullRequest)) {
      assertGenerationRequestBudget(request, maximumRequestCharacters, generator);
      return { snapshot, request, fullRequest };
    }
  }
  return { snapshot, request: fullRequest };
}

export async function proposeRelationsForBatch({
  repository,
  agentId,
  batchId = "",
  memoryIds = [],
  generator,
  fullEvidenceGenerator = generator,
  usageLedgerPath = "",
  systemPromptPath = DEFAULT_PROMPT_PATH,
  snapshotOptions = {},
  candidatePolicy = {},
  maximumProposals = DEFAULT_MAXIMUM_PROPOSALS,
  maximumRequestCharacters = RELATION_REQUEST_CHARACTERS,
  preparedGeneration = null,
} = {}) {
  if (!repository) throw new Error("Memory relation structurer requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Memory relation structurer requires agentId.");
  if (typeof generator !== "function") {
    throw new Error("Memory relation structurer requires a generator function.");
  }
  const normalizedMemoryIds = [...new Set(
    (Array.isArray(memoryIds) ? memoryIds : []).map(clean).filter(Boolean),
  )];
  const normalizedBatchId = clean(batchId) || stableBatchId(normalizedAgentId, normalizedMemoryIds);
  const limit = proposalCountLimit(maximumProposals);
  const prepared = (limit > 0 ? preparedGeneration : null) || prepareRelationGeneration({
    repository, agentId: normalizedAgentId, batchId: normalizedBatchId, memoryIds: normalizedMemoryIds,
    snapshotOptions, systemPromptPath, generator, maximumProposals: limit, maximumRequestCharacters,
  });
  const { snapshot, request, fullRequest } = prepared;
  if (!request) return { status: "skipped", reason: prepared.reason, batchId: normalizedBatchId,
    snapshot, proposed: [], duplicates: [], rejected: [], usageRecorded: false, warnings: [] };
  if (request.schema.properties.proposals.maxItems !== limit) throw new Error('Prepared relation request does not match maximumProposals.');
  const warnings = [];
  let usageRecorded = false;
  const generate = async (provider, input) => {
    provider.assertRequestBudget?.(input);
    let result;
    try { result = await provider(input); }
    catch (error) {
      await recordUsage({ generation: error, usageLedgerPath, agentId: normalizedAgentId, batchId: normalizedBatchId, warnings });
      throw error;
    }
    const recorded = await recordUsage({ generation: result, usageLedgerPath,
      agentId: normalizedAgentId, batchId: normalizedBatchId, warnings });
    usageRecorded ||= recorded;
    return result;
  };
  let generation = await generate(generator, request);
  let parsed = parseRelationGeneration(generation?.output, { maximumProposals });
  if (fullRequest && parsed.needsFullEvidence !== false) {
    generation = await generate(fullEvidenceGenerator, fullRequest);
    parsed = parseRelationGeneration(generation?.output, { maximumProposals });
  }
  const proposed = [];
  const duplicates = [];
  const rejected = [];
  for (const [index, candidate] of parsed.proposals.entries()) {
    try {
      const guardedCandidate = enforceRelationCandidatePolicy(candidate, snapshot, candidatePolicy);
      const proposal = proposeMemoryRelation(repository, {
        ...guardedCandidate,
        agentId: normalizedAgentId,
        batchId: normalizedBatchId,
        provenance: "memory-relation-structurer-v1",
        metadata: {
          generatorModel: clean(generation?.model),
          generatorRequestId: clean(generation?.requestId),
          candidateIndex: index,
        },
      });
      (proposal.wasInserted ? proposed : duplicates).push(proposal);
    } catch (error) {
      rejected.push({ index, error: error.message });
    }
  }
  return {
    status: parsed.proposals.length === limit ? 'capacity-reached'
      : proposed.length ? "proposed" : duplicates.length ? "duplicates-only" : "no-valid-proposals",
    batchId: normalizedBatchId,
    snapshot,
    proposed,
    duplicates,
    rejected,
    usageRecorded,
    warnings,
  };
}
