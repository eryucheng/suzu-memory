import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-memory/usage-ledger";
import { proposeMemoryStructure } from "@suzu-memory/core";

import {
  buildStructureGenerationInput,
  MEMORY_STRUCTURE_OUTPUT_SCHEMA,
  parseStructureGeneration,
  DEFAULT_MAXIMUM_PROPOSALS, proposalCountLimit, proposalSchemaForLimit,
  STRUCTURE_SUMMARY_INSTRUCTIONS,
  withStructureModelOutput,
} from "./prompt.mjs";
import { buildStructureSnapshot } from "./snapshot.mjs";
import { canProposeStructure, enforceStructureCandidatePolicy } from "./policy.mjs";
import { generateStructureSummary, structureSummaryNeedsRefresh, refreshStructureSummary as refreshSummary } from './summary-service.mjs';
import { withGenerationReferences, assertGenerationRequestBudget, STRUCTURE_REQUEST_CHARACTERS } from './generation-input.mjs';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "resources", "system-prompt.md");

function clean(value) {
  return String(value ?? "").trim();
}

function stableBatchId(agentId, memoryIds) {
  const hash = createHash("sha256")
    .update(`${clean(agentId)}\u001f${[...new Set(memoryIds.map(clean).filter(Boolean))].sort().join("\u001f")}`)
    .digest("hex")
    .slice(0, 24);
  return `structure-batch-${hash}`;
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
      feature: "memory-structure-proposal",
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

export function prepareStructureGeneration({
  repository, agentId, batchId, memoryIds, nearbyContainerIds = [],
  snapshotOptions = {}, systemPromptPath = DEFAULT_PROMPT_PATH, generator, maximumProposals = DEFAULT_MAXIMUM_PROPOSALS,
  maximumRequestCharacters = STRUCTURE_REQUEST_CHARACTERS,
}) {
  const limit = proposalCountLimit(maximumProposals);
  if (limit === 0) return { snapshot: null, request: null, reason: 'proposal-budget-zero' };
  const snapshot = buildStructureSnapshot({
    repository,
    agentId: agentId,
    batchId: batchId,
    memoryIds: memoryIds,
    nearbyContainerIds,
    maxSnapshotChars: Infinity, ...snapshotOptions,
  });
  if (!snapshot.currentMemories.length || !canProposeStructure(snapshot)) return { snapshot, request: null, reason: snapshot.currentMemories.length ? "no-possible-structure-operation" : "no-eligible-current-memories" };
  const systemPrompt = [fs.readFileSync(path.resolve(systemPromptPath), 'utf8').trim(), STRUCTURE_SUMMARY_INSTRUCTIONS].join('\n\n');
  const input = buildStructureGenerationInput(snapshot);
  const request = withGenerationReferences(withStructureModelOutput({
    input,
    systemPrompt,
    schema: proposalSchemaForLimit(MEMORY_STRUCTURE_OUTPUT_SCHEMA, limit),
    schemaName: "memory-structure-proposals-v2",
    ...(snapshot.sourceMaterial ? { sourceMaterial: snapshot.sourceMaterial } : {}),
  }));
  assertGenerationRequestBudget(request, maximumRequestCharacters, generator);
  return { snapshot, request };
}

export async function proposeStructuresForBatch({
  repository,
  agentId,
  batchId = "",
  memoryIds = [],
  nearbyContainerIds = [],
  generator,
  usageLedgerPath = "",
  systemPromptPath = DEFAULT_PROMPT_PATH,
  snapshotOptions = {},
  candidatePolicy = {},
  maximumProposals = DEFAULT_MAXIMUM_PROPOSALS,
  maximumRequestCharacters = STRUCTURE_REQUEST_CHARACTERS,
  preparedGeneration = null,
} = {}) {
  if (!repository) throw new Error("Memory structurer requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Memory structurer requires agentId.");
  if (typeof generator !== "function") throw new Error("Memory structurer requires a generator function.");
  const normalizedMemoryIds = [...new Set(
    (Array.isArray(memoryIds) ? memoryIds : []).map(clean).filter(Boolean),
  )];
  const normalizedBatchId = clean(batchId) || stableBatchId(normalizedAgentId, normalizedMemoryIds);
  const limit = proposalCountLimit(maximumProposals);
  const prepared = (limit > 0 ? preparedGeneration : null) || prepareStructureGeneration({
    repository, agentId: normalizedAgentId, batchId: normalizedBatchId, memoryIds: normalizedMemoryIds,
    nearbyContainerIds, snapshotOptions, systemPromptPath, generator, maximumProposals: limit, maximumRequestCharacters,
  });
  const { snapshot, request } = prepared;
  if (!request) return { status: "skipped", reason: prepared.reason, batchId: normalizedBatchId,
    snapshot, proposed: [], duplicates: [], rejected: [], usageRecorded: false, warnings: [] };
  if (request.schema.properties.proposals.maxItems !== limit) throw new Error('Prepared structure request does not match maximumProposals.');
  generator.assertRequestBudget?.(request);
  const warnings = [];
  let generation;
  try { generation = await generator(request); }
  catch (error) {
    await recordUsage({ generation: error, usageLedgerPath, agentId: normalizedAgentId, batchId: normalizedBatchId, warnings });
    throw error;
  }
  const usageRecorded = await recordUsage({
    generation,
    usageLedgerPath,
    agentId: normalizedAgentId,
    batchId: normalizedBatchId,
    warnings,
  });
  const parsed = parseStructureGeneration(generation?.output, { maximumProposals });
  const proposed = [];
  const duplicates = [];
  const rejected = [];
  const operations = [], attachments = new Map();
  for (const [index, candidate] of parsed.proposals.entries()) {
    try {
      const guardedCandidate = enforceStructureCandidatePolicy(candidate, snapshot, { timeZone: repository.timeZone, ...candidatePolicy });
      if (guardedCandidate.operation === 'attach') {
        let group = attachments.get(guardedCandidate.targetMemoryId);
        if (!group) { group = []; attachments.set(guardedCandidate.targetMemoryId, group); operations.push(group); }
        group.push({ index, candidate: guardedCandidate });
      } else operations.push([{ index, candidate: guardedCandidate }]);
    } catch (error) { rejected.push({ index, error: error.message }); }
  }
  for (const group of operations) {
    const { index, candidate } = group[0];
    try {
      const guardedCandidate = { ...candidate,
        memberIds: [...new Set(group.flatMap(item => item.candidate.memberIds))] };
      if (candidate.operation === 'attach' && (group.length > 1
        || structureSummaryNeedsRefresh(repository, normalizedAgentId, candidate.targetMemoryId))) {
        const summary = await generateStructureSummary({ repository, agentId: normalizedAgentId,
          memoryId: candidate.targetMemoryId, extraMemberIds: guardedCandidate.memberIds, generator,
          onGeneration: generation => recordUsage({ generation, usageLedgerPath, agentId: normalizedAgentId,
            batchId: normalizedBatchId, warnings }) });
        summary.assertCurrent();
        guardedCandidate.title = summary.title;
        guardedCandidate.content = summary.content;
      }
      const proposal = proposeMemoryStructure(repository, {
        ...guardedCandidate,
        agentId: normalizedAgentId,
        batchId: normalizedBatchId,
        provenance: "memory-structurer-v1",
        metadata: {
          generatorModel: clean(generation?.model),
          generatorRequestId: clean(generation?.requestId),
          candidateIndex: index,
        },
      });
      (proposal.wasInserted ? proposed : duplicates).push(proposal);
    } catch (error) {
      rejected.push({ index, indices: group.map(item => item.index), error: error.message,
        retryable: error.code !== 'MEMORY_STRUCTURE_NO_NEW_MEMBERS' });
    }
  }
  return {
    status: rejected.some(item => item.retryable) ? 'partial-failure'
      : parsed.proposals.length === limit ? 'capacity-reached'
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

export async function refreshStructureSummary({ usageLedgerPath = '', batchId = '', ...options }) {
  const warnings = [];
  const result = await refreshSummary({ ...options, recordUsage: generation => recordUsage({ generation,
    usageLedgerPath, agentId: options.agentId, batchId, warnings }) });
  return { ...result, warnings };
}
