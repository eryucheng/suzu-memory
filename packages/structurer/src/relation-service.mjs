import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-memory/usage-ledger";
import { proposeMemoryRelation } from "@suzu-memory/core";

import { enforceRelationCandidatePolicy } from "./relation-candidate-policy.mjs";
import {
  buildRelationGenerationInput,
  MEMORY_RELATION_OUTPUT_SCHEMA,
  parseRelationGeneration,
} from "./relation-prompt.mjs";
import { buildRelationSnapshot } from "./relation-snapshot.mjs";
import { DEFAULT_MAXIMUM_PROPOSALS, proposalCountLimit, proposalSchemaForLimit } from './prompt.mjs';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "resources", "relation-system-prompt.md");

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
}) {
  const limit = proposalCountLimit(maximumProposals);
  if (limit === 0) return { snapshot: null, request: null, reason: 'proposal-budget-zero' };
  const snapshot = buildRelationSnapshot({
    repository,
    agentId: agentId,
    batchId: batchId,
    memoryIds: memoryIds,
    ...snapshotOptions,
  });
  if (snapshot.memories.length < 2 || !snapshot.sourceRecords.length) return { snapshot, request: null, reason: snapshot.memories.length < 2 ? "fewer-than-two-eligible-memories" : "no-source-evidence" };
  const systemPrompt = fs.readFileSync(path.resolve(systemPromptPath), "utf8").trim();
  const request = {
    input: buildRelationGenerationInput(snapshot),
    systemPrompt,
    schema: proposalSchemaForLimit(MEMORY_RELATION_OUTPUT_SCHEMA, limit),
    schemaName: "memory-relation-proposals-v1",
    ...(snapshot.sourceMaterial ? { sourceMaterial: snapshot.sourceMaterial } : {}),
  };
  generator?.assertRequestBudget?.(request);
  return { snapshot, request };
}

export async function proposeRelationsForBatch({
  repository,
  agentId,
  batchId = "",
  memoryIds = [],
  generator,
  usageLedgerPath = "",
  systemPromptPath = DEFAULT_PROMPT_PATH,
  snapshotOptions = {},
  candidatePolicy = {},
  maximumProposals = DEFAULT_MAXIMUM_PROPOSALS,
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
    snapshotOptions, systemPromptPath, generator, maximumProposals: limit,
  });
  const { snapshot, request } = prepared;
  if (!request) return { status: "skipped", reason: prepared.reason, batchId: normalizedBatchId,
    snapshot, proposed: [], duplicates: [], rejected: [], usageRecorded: false, warnings: [] };
  if (request.schema.properties.proposals.maxItems !== limit) throw new Error('Prepared relation request does not match maximumProposals.');
  generator.assertRequestBudget?.(request);
  const generation = await generator(request);
  const warnings = [];
  const usageRecorded = await recordUsage({
    generation,
    usageLedgerPath,
    agentId: normalizedAgentId,
    batchId: normalizedBatchId,
    warnings,
  });
  const parsed = parseRelationGeneration(generation?.output, { maximumProposals });
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
    status: proposed.length ? "proposed" : duplicates.length ? "duplicates-only" : "no-valid-proposals",
    batchId: normalizedBatchId,
    snapshot,
    proposed,
    duplicates,
    rejected,
    usageRecorded,
    warnings,
  };
}
