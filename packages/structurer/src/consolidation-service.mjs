import { randomUUID } from "node:crypto";
import { assertEventSourceExecutionCurrent } from '@suzu-memory/core';

import { proposeRelationsForBatch, prepareRelationGeneration } from "./relation-service.mjs";
import { proposeStructuresForBatch, prepareStructureGeneration } from "./service.mjs";
import { createConsolidationGenerationBatch, buildConsolidationRequest } from "./consolidation-generation-batch.mjs";

import { runBudgetedMemoryParts, blockedMemoryPartsError } from "./budgeted-parts.mjs";
import { assertGenerationRequestBudget, STRUCTURE_REQUEST_CHARACTERS, RELATION_REQUEST_CHARACTERS } from './generation-input.mjs';

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

  const progress = run.metadata.organizationProgress || { parts: [{
    id: run.id, memoryIds: run.triggerIds, historicalIds: run.candidateIds, status: "pending",
  }] };
  let structure = null;
  let relations = null;
  let structureIds = [...run.structureProposalIds];
  let relationIds = [...run.relationProposalIds];
  const checkpoint = () => {
    structureIds = [...new Set([...structureIds, ...progress.parts.flatMap(part => proposalIds(part.structure))])];
    relationIds = [...new Set([...relationIds, ...progress.parts.flatMap(part => proposalIds(part.relations))])];
    repository.checkpointConsolidationRun({ agentId: normalizedAgentId, runId: run.id, workerId,
      progress, structureProposalIds: structureIds, relationProposalIds: relationIds });
  };
  const optionsFor = (part, type) => {
    const options = type === "structure" ? structureOptions : relationOptions;
    return { ...options, repository, agentId: normalizedAgentId, batchId: `${part.id}:${type}`,
      memoryIds: [...part.memoryIds, ...part.historicalIds],
      snapshotOptions: { ...options.snapshotOptions, retrospective: {
        triggerMemoryIds: part.memoryIds, historicalMemoryIds: part.historicalIds,
      } },
      candidatePolicy: { ...options.candidatePolicy, requiredTriggerMemoryIds: part.memoryIds,
        requiredHistoricalMemoryIds: part.historicalIds, requireRetrospectiveParticipation: true },
    };
  };
  const aggregate = key => {
    const reports = progress.parts.map(part => part[key]).filter(Boolean);
    if (!reports.length) return null;
    return { ...reports[0], ...Object.fromEntries(["proposed", "duplicates", "rejected", "warnings"]
      .map(field => [field, reports.flatMap(report => report[field] || [])])) };
  };
  try {
    checkpoint();
    await runBudgetedMemoryParts({ parts: progress.parts, checkpoint,
      prepare: part => {
        const prepared = {};
        const combined = structureGenerator === relationGenerator && structureGenerator?.supportsCombinedConsolidation;
        if (!part.coveredOutputs?.includes('structure') && (!part.structure || part.structure.status === 'partial-failure') && typeof structureGenerator === "function") {
          prepared.structure = prepareStructureGeneration({ ...optionsFor(part, "structure"),
            ...(combined ? { maximumRequestCharacters: Infinity } : {}), generator: combined ? null : structureGenerator });
        }
        if (!part.coveredOutputs?.includes('relations') && !part.relations && typeof relationGenerator === "function") {
          prepared.relations = prepareRelationGeneration({ ...optionsFor(part, "relations"),
            ...(combined ? { maximumRequestCharacters: Infinity } : {}), generator: combined ? null : relationGenerator });
        }
        const calls = Object.entries(prepared).filter(([, value]) => value.request)
          .map(([key, value]) => ({ key, request: value.request }));
        if (calls.length && combined) {
          const budget = calls.reduce((sum, call) => sum + (call.key === 'structure'
            ? structureOptions.maximumRequestCharacters ?? STRUCTURE_REQUEST_CHARACTERS
            : relationOptions.maximumRequestCharacters ?? RELATION_REQUEST_CHARACTERS), 0);
          const fullCalls = calls.map(call => ({ ...call,
            request: prepared[call.key].fullRequest || call.request }));
          assertGenerationRequestBudget(buildConsolidationRequest(fullCalls), budget, structureGenerator);
          if (prepared.relations?.fullRequest) {
            assertGenerationRequestBudget(buildConsolidationRequest(calls), budget, structureGenerator);
          }
        }
        return prepared;
      },
      execute: async (part, prepared) => {
        const combined = structureGenerator === relationGenerator && structureGenerator?.supportsCombinedConsolidation
          ? createConsolidationGenerationBatch(structureGenerator) : null;
        const jobs = Object.entries(prepared).map(([key, preparedGeneration]) => {
          const operation = key === "structure" ? proposeStructuresForBatch : proposeRelationsForBatch;
          const generator = combined ? combined[key] : key === "structure" ? structureGenerator : relationGenerator;
          return [key, operation({ ...optionsFor(part, key), generator, preparedGeneration,
            ...(key === 'relations' ? { fullEvidenceGenerator: relationGenerator } : {}) })];
        });
        const results = await Promise.allSettled(jobs.map(([, promise]) => promise));
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") {
            const { snapshot, ...report } = result.value;
            part[jobs[index][0]] = report;
          }
        }
        checkpoint();
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
        return { status: part.structure?.status === 'partial-failure' ? 'partial-failure'
          : [part.structure, part.relations].some(report => report?.status === 'capacity-reached') ? 'capacity-reached' : 'completed' };
      },
      onSplit: (part, children) => {
        for (const child of children) {
          child.coveredOutputs = [...new Set([...(part.coveredOutputs || []),
            ...['structure', 'relations'].filter(key => part[key]
              && !['capacity-reached', 'partial-failure'].includes(part[key].status))])];
          delete child.structure; delete child.relations;
        }
      },
    });
    structure = aggregate("structure");
    relations = aggregate("relations");
    const blocked = blockedMemoryPartsError(progress.parts, 'A complete new/old memory pair exceeds the organization budget; original material is retained for review.');
    if (blocked) throw blocked;
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
    assertEventSourceExecutionCurrent();
    structure = aggregate("structure");
    relations = aggregate("relations");
    const failed = repository.failConsolidationRun({
      agentId: normalizedAgentId,
      runId: run.id,
      structureProposalIds: structureIds,
      relationProposalIds: relationIds,
      errorMessage: error.message,
      retry: !["MEMORY_STRUCTURE_INPUT_TOO_LARGE", "MEMORY_STRUCTURE_OUTPUT_FULL", "MEMORY_OUTPUT_LIMIT", "MAX_TOKENS"].includes(error.code),
      errorDetails: {
        stage: "retrospective-consolidation",
        errorCode: clean(error.code),
        errorName: clean(error.name),
        providerDiagnostics: error.diagnostics || {},
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
