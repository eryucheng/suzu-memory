import { randomUUID } from "node:crypto";
import { assertEventSourceExecutionCurrent, organizationInputIsCurrent, assertOrganizationInputCurrent,
  DIRECT_INGESTION_MEMORY_KINDS } from '@suzu-memory/core';

import { proposeRelationsForBatch, prepareRelationGeneration } from "./relation-service.mjs";
import { proposeStructuresForBatch, prepareStructureGeneration } from "./service.mjs";
import { createConsolidationGenerationBatch, prepareConsolidationGeneration } from "./consolidation-generation-batch.mjs";

import { runBudgetedMemoryParts, blockedMemoryPartsError } from "./budgeted-parts.mjs";
import { STRUCTURE_REQUEST_CHARACTERS, RELATION_REQUEST_CHARACTERS } from './generation-input.mjs';
import { consolidationProgress, structureContextForPart, partitionConsolidationPart, sharesAnchorPrefix } from './consolidation-parts.mjs';
import { planMemoryConsolidation } from './consolidation-planner.mjs';
import { prepareStructureMemberships, stageStructureMemberships, finalizeStructurePlans } from './structure-plans.mjs';

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
  const inputsCurrent = () => organizationInputIsCurrent(repository, normalizedAgentId, run.metadata.organizationInput);
  const replan = () => repository.transaction(() => {
    const triggerMemoryIds = run.triggerIds.filter(id => {
      const memory = repository.getMemory(id);
      return memory?.agent_id === normalizedAgentId && memory.status === 'active'
        && DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind);
    });
    const replacement = triggerMemoryIds.length ? planMemoryConsolidation({ repository, agentId: normalizedAgentId,
      triggerMemoryIds, ...run.metadata.selectionPolicy,
      metadata: { replannedFrom: run.id, ...(run.metadata.accumulatedStructureBatchId
        ? { accumulatedStructureBatchId: run.metadata.accumulatedStructureBatchId } : {}) } }) : null;
    if (replacement?.id === run.id) throw new Error('Changed organization input must create a distinct plan.');
    const previous = run.status === 'running' ? repository.finishConsolidationRun({ agentId: normalizedAgentId,
      runId: run.id, status: 'cancelled', workerId }) : run;
    return { status: replacement ? 'replanned' : 'cancelled', run: previous, replacementRun: replacement,
      structure: null, relations: null };
  });
  if (["completed", "no_proposals", "failed", "cancelled"].includes(run.status)) {
    if (run.status !== 'cancelled' && !inputsCurrent()) return replan();
    return { status: "already-finished", run, structure: null, relations: null };
  }
  run = repository.claimConsolidationRun({
    agentId: normalizedAgentId,
    runId: normalizedRunId,
    workerId,
    leaseSeconds,
  });
  // An immutable run and its checkpoints belong to one semantic input. A new
  // input gets a new bounded plan, while unrelated runs retain their results.
  if (!inputsCurrent()) return replan();
  if (!run.candidateIds.length && run.triggerIds.length < 2 && !run.metadata.nearbyContainerIds?.length) {
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

  const progress = consolidationProgress(run);
  const unified = run.metadata.organizationMode === 'unified-v1';
  if (unified) progress.structurePlans ||= [];
  let structure = null;
  let relations = null;
  let structureIds = [...run.structureProposalIds];
  let relationIds = [...run.relationProposalIds];
  const checkpoint = () => {
    const nextStructureIds = [...new Set([...structureIds, ...progress.parts.flatMap(part => proposalIds(part.structure)),
      ...(progress.structurePlans || []).map(group => group.proposalId).filter(Boolean)])];
    const nextRelationIds = [...new Set([...relationIds, ...progress.parts.flatMap(part => proposalIds(part.relations))])];
    repository.checkpointConsolidationRun({ agentId: normalizedAgentId, runId: run.id, workerId,
      progress, structureProposalIds: nextStructureIds, relationProposalIds: nextRelationIds });
    structureIds = nextStructureIds;
    relationIds = nextRelationIds;
  };
  const optionsFor = (part, type) => {
    const options = type === "structure" ? structureOptions : relationOptions;
    const retrospective = structureContextForPart(part, run);
    const { anchorMemoryIds, candidateMemoryIds } = part.relationContext;
    return { ...options, ...(type === 'relations' ? { selectionInBody: unified,
      ...(part.requiresFullRelationEvidence ? { useSourceExcerpts: false } : {}) } : {}),
      repository, agentId: normalizedAgentId, batchId: `${part.id}:${type}`,
      memoryIds: [...anchorMemoryIds, ...candidateMemoryIds],
      snapshotOptions: { ...options.snapshotOptions, retrospective,
        ...(type === 'relations' ? { relationContext: part.relationContext } : {}) },
      ...(unified && type === 'structure' ? { structurePlans: progress.structurePlans, checkpoint,
        nearbyContainerIds: run.metadata.nearbyContainerIds || [] } : {}),
      candidatePolicy: { ...options.candidatePolicy, requiredTriggerMemoryIds: anchorMemoryIds,
        requiredHistoricalMemoryIds: candidateMemoryIds, requireRetrospectiveParticipation: type === 'structure',
        ...(unified && type === 'structure' ? { includeTriggerPairs: part.relationContext.includeAnchorPairs } : {}) },
    };
  };
  const combined = structureGenerator === relationGenerator && structureGenerator?.supportsCombinedConsolidation;
  const taskBudgets = {
    structure: structureOptions.maximumRequestCharacters ?? STRUCTURE_REQUEST_CHARACTERS,
    relations: relationOptions.maximumRequestCharacters ?? RELATION_REQUEST_CHARACTERS,
  };
  const aggregate = key => {
    const reports = progress.parts.map(part => part[key]).filter(Boolean);
    if (!reports.length) return null;
    return { ...reports[0], ...Object.fromEntries(["proposed", "duplicates", "rejected", "warnings"]
      .map(field => [field, reports.flatMap(report => report[field] || [])])) };
  };
  try {
    checkpoint();
    await runBudgetedMemoryParts({ parts: progress.parts, checkpoint, partition: partitionConsolidationPart,
      prepare: part => {
        assertOrganizationInputCurrent(repository, normalizedAgentId, run.metadata.organizationInput);
        const prepared = {};
        if (structureContextForPart(part, run) && !part.coveredOutputs?.includes('structure')
          && (!part.structure || part.structure.status === 'partial-failure') && typeof structureGenerator === "function") {
          prepared.structure = (unified ? prepareStructureMemberships : prepareStructureGeneration)({ ...optionsFor(part, "structure"),
            ...(combined ? { maximumRequestCharacters: Infinity } : {}), generator: combined ? null : structureGenerator });
        }
        if (!part.coveredOutputs?.includes('relations') && (!part.relations || part.relations.status === 'partial-failure') && typeof relationGenerator === "function") {
          prepared.relations = prepareRelationGeneration({ ...optionsFor(part, "relations"),
            deferEvidenceChoice: Boolean(unified && combined && prepared.structure?.request),
            ...(combined ? { maximumRequestCharacters: Infinity } : {}), generator: combined ? null : relationGenerator });
        }
        const calls = Object.entries(prepared).filter(([, value]) => value.request)
          .map(([key, value]) => ({ key, request: value.request }));
        if (!combined || !calls.length) return { prepared };
        const { request, fullRelationSelected } = prepareConsolidationGeneration(calls, {
          generator: structureGenerator, taskBudgets, sharedNewFirst: unified && sharesAnchorPrefix(part, progress.parts),
          fullRelationRequest: unified ? prepared.relations?.fullRequest : undefined,
        });
        if (fullRelationSelected) {
          const { fullRequest, ...relations } = prepared.relations;
          prepared.relations = { ...relations, request: fullRequest };
        }
        return { prepared, request };
      },
      execute: async (part, { prepared, request }) => {
        const batch = request ? createConsolidationGenerationBatch(structureGenerator, request, taskBudgets) : null;
        const jobs = Object.entries(prepared).map(([key, preparedGeneration]) => {
          const operation = key === "structure" ? (unified ? stageStructureMemberships : proposeStructuresForBatch) : proposeRelationsForBatch;
          const generator = batch ? batch[key] : key === "structure" ? structureGenerator : relationGenerator;
          return [key, operation({ ...optionsFor(part, key), generator, preparedGeneration,
            ...(key === 'relations' ? { fullEvidenceGenerator: relationGenerator } : {}) })];
        });
        const results = await Promise.allSettled(jobs.map(([, promise]) => promise));
        for (const [index, result] of results.entries()) {
          if (result.status === "fulfilled") {
            const { snapshot, ...report } = result.value;
            part[jobs[index][0]] = report;
          } else if (jobs[index][0] === 'relations' && result.reason.requiresFullEvidence) {
            // Persist the model's evidence request across retries and child parts.
            part.requiresFullRelationEvidence = true;
          }
        }
        checkpoint();
        const failure = results.find(result => result.status === "rejected");
        if (failure) throw failure.reason;
        return { status: [part.structure, part.relations].some(report => report?.status === 'partial-failure') ? 'partial-failure'
          : [part.structure, part.relations].some(report => report?.status === 'capacity-reached') ? 'capacity-reached' : 'completed' };
      },
    });
    structure = aggregate("structure");
    relations = aggregate("relations");
    assertOrganizationInputCurrent(repository, normalizedAgentId, run.metadata.organizationInput);
    const blocked = blockedMemoryPartsError(progress.parts, 'A complete selected memory pair exceeds the organization budget; original material is retained for review.');
    if (blocked) throw blocked;
    if (unified) {
      const final = await finalizeStructurePlans({ repository, agentId: normalizedAgentId, runId: run.id,
        structurePlans: progress.structurePlans, generator: structureGenerator, checkpoint,
        usageLedgerPath: structureOptions.usageLedgerPath,
        maximumRequestCharacters: structureOptions.maximumRequestCharacters });
      structure = { ...structure, ...final, rejected: [...(structure?.rejected || []), ...final.rejected],
        warnings: [...(structure?.warnings || []), ...final.warnings] };
      checkpoint();
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
    assertEventSourceExecutionCurrent();
    if (!inputsCurrent() || (unified && error.category === 'stale-input')) return replan();
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
        category: error.category || 'execution-failure',
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
