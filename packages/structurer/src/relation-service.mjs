import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appendUsageEvent } from "@suzu-memory/usage-ledger";
import { proposeMemoryRelation, readOrganizationInput, selectOrganizationInput, assertOrganizationInputCurrent,
  organizationInputIsCurrent, OrganizationInputChangedError, OrganizationCandidateError } from "@suzu-memory/core";
import { organizationRejection } from './rejection.mjs';

import { enforceRelationCandidatePolicy } from "./relation-candidate-policy.mjs";
import {
  buildRelationGenerationInput,
  relationOutputSchema,
  parseRelationGeneration,
  withRelationModelOutput,
} from "./relation-prompt.mjs";
import { buildRelationSnapshot } from "./relation-snapshot.mjs";
import { DEFAULT_MAXIMUM_PROPOSALS, proposalCountLimit } from './prompt.mjs';
import { withGenerationReferences, assertGenerationRequestBudget, RELATION_REQUEST_CHARACTERS } from './generation-input.mjs';

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULT_PROMPT_PATH = path.join(PACKAGE_ROOT, "resources", "relation-system-prompt.md");
const EXCERPT_INSTRUCTIONS = 'excerpt 标记的来源是原话摘录。需要完整原话时填写 needsFullEvidence。';
const SELECTION_INSTRUCTIONS = '关系的 anchorMemoryId 和 relatedMemoryId 只选 selectionScope.relations 对应列表中的 ID。';

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
  useSourceExcerpts = true, selectionInBody = false, deferEvidenceChoice = false,
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
  const scope = snapshot.relationContext;
  if (scope && !scope.candidateMemoryIds.length && (!scope.includeAnchorPairs || scope.anchorMemoryIds.length < 2)) {
    return { snapshot, request: null, reason: 'no-selected-relation-pairs' };
  }
  const systemPrompt = fs.readFileSync(path.resolve(systemPromptPath), "utf8").trim();
  const buildRequest = excerpted => withGenerationReferences(withRelationModelOutput({
    input: buildRelationGenerationInput(snapshot, { excerpted }),
    systemPrompt: [systemPrompt, ...(excerpted ? [EXCERPT_INSTRUCTIONS] : []),
      ...(selectionInBody ? [SELECTION_INSTRUCTIONS] : [])].join('\n\n'),
    schema: relationOutputSchema(limit, { excerpted }),
    schemaName: "memory-relation-proposals-v2",
    ...(snapshot.sourceMaterial ? { sourceMaterial: snapshot.sourceMaterial } : {}),
  }), { selectionInBody });
  const fullRequest = buildRequest(false);
  const inputVersion = readOrganizationInput(repository, agentId, snapshot.memories.map(memory => memory.id));
  if (useSourceExcerpts && snapshot.sourceExcerpts?.size) {
    const request = buildRequest(true);
    const requestSize = value => generator?.measureRequest ? generator.measureRequest(value)
      : value.modelInput.length + value.systemPrompt.length + JSON.stringify(value.schema).length;
    if (deferEvidenceChoice || requestSize(request) < requestSize(fullRequest)) {
      assertGenerationRequestBudget(request, maximumRequestCharacters, generator);
      return { snapshot, request, fullRequest, inputVersion };
    }
  }
  assertGenerationRequestBudget(fullRequest, maximumRequestCharacters, generator);
  return { snapshot, request: fullRequest, inputVersion };
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
  useSourceExcerpts = true,
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
    snapshotOptions, systemPromptPath, generator, maximumProposals: limit, maximumRequestCharacters, useSourceExcerpts,
  });
  const { snapshot, request, fullRequest, inputVersion } = prepared;
  if (!request) return { status: "skipped", reason: prepared.reason, batchId: normalizedBatchId,
    snapshot, proposed: [], duplicates: [], rejected: [], usageRecorded: false, warnings: [] };
  if (request.schema.properties.proposals.maxItems !== limit) throw new Error('Prepared relation request does not match maximumProposals.');
  const warnings = [];
  let usageRecorded = false;
  const generate = async (provider, input) => {
    assertOrganizationInputCurrent(repository, normalizedAgentId, inputVersion);
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
    try {
      // Budget the evidence actually requested. A larger fallback can be split by
      // the consolidation owner without repeating its completed structure work.
      assertGenerationRequestBudget(fullRequest, maximumRequestCharacters, fullEvidenceGenerator);
      generation = await generate(fullEvidenceGenerator, fullRequest);
      parsed = parseRelationGeneration(generation?.output, { maximumProposals });
    } catch (error) {
      error.requiresFullEvidence = true;
      throw error;
    }
  }
  const proposed = [];
  const duplicates = [];
  const rejected = [];
  for (const [index, candidate] of parsed.proposals.entries()) {
    let guardedCandidate;
    try {
      if (candidate instanceof OrganizationCandidateError) throw candidate;
      guardedCandidate = enforceRelationCandidatePolicy(candidate, snapshot, candidatePolicy);
    }
    catch (error) { rejected.push(organizationRejection(error, { index, candidate, inputVersion, generation })); continue; }
    try {
      const proposal = proposeMemoryRelation(repository, {
        ...guardedCandidate,
        expectedInput: selectOrganizationInput(inputVersion, [guardedCandidate.fromMemoryId, guardedCandidate.toMemoryId]),
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
      rejected.push(organizationRejection(error, { index, candidate, inputVersion, generation }));
    }
  }
  if (!organizationInputIsCurrent(repository, normalizedAgentId, inputVersion)
    && !rejected.some(item => item.category === 'stale-input')) {
    rejected.push(organizationRejection(new OrganizationInputChangedError(), { index: null, inputVersion, generation }));
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
