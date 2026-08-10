import { randomUUID } from "node:crypto";

import { proposeRelationsForBatch } from "./relation-service.mjs";
import { proposeStructuresForBatch } from "./service.mjs";
import { createConsolidationGenerationBatch } from "./consolidation-generation-batch.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function proposalIds(result) {
  return [...new Set([
    ...(result?.proposed || []).map((proposal) => proposal.id),
    ...(result?.duplicates || []).map((proposal) => proposal.id),
  ].filter(Boolean))];
}

export async function runMemoryConsolidation({
  repository,
  agentId,
  runId,
  structureGenerator = null,
  relationGenerator = null,
  structureOptions = {},
  relationOptions = {},
  workerId = randomUUID(),
  leaseSeconds = 900,
} = {}) {
  if (!repository) throw new Error("Memory consolidation requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedRunId = clean(runId);
  if (!normalizedAgentId || !normalizedRunId) {
    throw new Error("Memory consolidation requires agentId and runId.");
  }
  let run = repository.getConsolidationRun(normalizedAgentId, normalizedRunId);
  if (!run) throw new Error("Consolidation run does not exist for this Agent.");
  if (["completed", "no_proposals", "failed", "cancelled"].includes(run.status)) {
    return { status: "already-finished", run, structure: null, relations: null };
  }
  run = repository.claimConsolidationRun({
    agentId: normalizedAgentId,
    runId: normalizedRunId,
    workerId,
    leaseSeconds,
  });
  if (!run.candidateIds.length) {
    return {
      status: "no-proposals",
      run: repository.finishConsolidationRun({
        agentId: normalizedAgentId,
        runId: run.id,
        status: "no_proposals",
        workerId,
      }),
      structure: null,
      relations: null,
    };
  }
  if (typeof structureGenerator !== "function" && typeof relationGenerator !== "function") {
    const failed = repository.failConsolidationRun({
      agentId: normalizedAgentId,
      runId: run.id,
      workerId,
      errorMessage: "No consolidation generator was configured.",
      errorDetails: { stage: "provider-selection" },
    });
    return {
      status: failed.status === "planned" ? "retry-pending" : "failed",
      run: failed,
      structure: null,
      relations: null,
    };
  }

  const memoryIds = [...run.triggerIds, ...run.candidateIds];
  const retrospective = {
    triggerMemoryIds: run.triggerIds,
    historicalMemoryIds: run.candidateIds,
  };
  const retrospectivePolicy = {
    requiredTriggerMemoryIds: run.triggerIds,
    requiredHistoricalMemoryIds: run.candidateIds,
    requireRetrospectiveParticipation: true,
  };
  let structure = null;
  let relations = null;
  let structureIds = [...run.structureProposalIds];
  let relationIds = [...run.relationProposalIds];
  const proposeStructure = (generator) => proposeStructuresForBatch({
    ...structureOptions,
    repository,
    agentId: normalizedAgentId,
    batchId: `${run.id}:structure`,
    memoryIds,
    generator,
    snapshotOptions: {
      ...(structureOptions.snapshotOptions || {}),
      retrospective,
    },
    candidatePolicy: {
      ...(structureOptions.candidatePolicy || {}),
      ...retrospectivePolicy,
    },
  });
  const proposeRelations = (generator) => proposeRelationsForBatch({
    ...relationOptions,
    repository,
    agentId: normalizedAgentId,
    batchId: `${run.id}:relations`,
    memoryIds,
    generator,
    snapshotOptions: {
      ...(relationOptions.snapshotOptions || {}),
      retrospective,
    },
    candidatePolicy: {
      ...(relationOptions.candidatePolicy || {}),
      ...retrospectivePolicy,
    },
  });
  try {
    const canCombine = typeof structureGenerator === "function"
      && structureGenerator === relationGenerator
      && structureGenerator.supportsCombinedConsolidation === true;
    if (canCombine) {
      const combined = createConsolidationGenerationBatch(structureGenerator);
      const [structureResult, relationResult] = await Promise.allSettled([
        proposeStructure(combined.structure),
        proposeRelations(combined.relations),
      ]);
      if (structureResult.status === "fulfilled") {
        structure = structureResult.value;
        structureIds = [...new Set([...structureIds, ...proposalIds(structure)])];
      }
      if (relationResult.status === "fulfilled") {
        relations = relationResult.value;
        relationIds = [...new Set([...relationIds, ...proposalIds(relations)])];
      }
      const failure = [structureResult, relationResult]
        .find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    } else {
      if (typeof structureGenerator === "function") {
        structure = await proposeStructure(structureGenerator);
        structureIds = [...new Set([...structureIds, ...proposalIds(structure)])];
      }
      if (typeof relationGenerator === "function") {
        relations = await proposeRelations(relationGenerator);
        relationIds = [...new Set([...relationIds, ...proposalIds(relations)])];
      }
    }
    const hasProposals = structureIds.length > 0 || relationIds.length > 0;
    const finished = repository.finishConsolidationRun({
      agentId: normalizedAgentId,
      runId: run.id,
      status: hasProposals ? "completed" : "no_proposals",
      structureProposalIds: structureIds,
      relationProposalIds: relationIds,
      workerId,
    });
    return {
      status: hasProposals ? "completed" : "no-proposals",
      run: finished,
      structure,
      relations,
    };
  } catch (error) {
    const failed = repository.failConsolidationRun({
      agentId: normalizedAgentId,
      runId: run.id,
      structureProposalIds: structureIds,
      relationProposalIds: relationIds,
      errorMessage: error.message,
      errorDetails: {
        stage: "retrospective-consolidation",
        errorCode: clean(error.code),
        errorName: clean(error.name),
      },
      workerId,
    });
    return {
      status: failed.status === "planned" ? "retry-pending" : "failed",
      error: error.message,
      run: failed,
      structure,
      relations,
    };
  }
}
