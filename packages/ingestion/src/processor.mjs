import { assertEventSourceExecutionCurrent } from '@suzu-memory/core';
import { executionEventSourceView } from '@suzu-memory/core';
import { normalizeCompanionIdentity } from "./protocol.mjs";
import { selectReplyChunk } from './reply-chunks.mjs';
import {
  archiveCompanionEventBatch,
  generateCompanionEventBatch,
  recordCompanionEventGenerationUsage,
} from "./processing-stages.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function failBatch(repository, agentId, batchId, leaseOwner, error, completedAt) {
  try {
    repository.completeInputBatch(agentId, batchId, {
      success: false,
      leaseOwner,
      errorMessage: error.message,
      completedAt,
    });
  } catch (completionError) {
    if (completionError.code !== "INPUT_BATCH_LEASE_LOST") throw completionError;
  }
}

const MAXIMUM_EXTRACTION_ATTEMPTS = 3;

function processingFailure(error, stage, transportAttempts = 1) {
  return {
    stage,
    errorCode: clean(error?.code),
    errorName: clean(error?.name) || "Error",
    errorMessage: clean(error?.message) || "Unknown long-term memory processing failure.",
    attemptIncrement: Math.max(1, Math.trunc(Number(transportAttempts) || 1)),
    providerDiagnostics: error?.diagnostics && typeof error.diagnostics === "object"
      ? error.diagnostics
      : {},
  };
}

function recordProcessingFailure({
  repository,
  agentId,
  claimed,
  error,
  stage,
  completedAt,
  transportAttempts = 1,
}) {
  const failure = processingFailure(error, stage, transportAttempts);
  const recorded = repository.recordInputBatchProcessingFailure(agentId, claimed.batch.id, {
    leaseOwner: claimed.batch.lease_owner,
    maximumAttempts: error?.code === 'MAX_TOKENS' ? 1 : MAXIMUM_EXTRACTION_ATTEMPTS,
    attemptIncrement: failure.attemptIncrement,
    failedAt: completedAt,
    failure,
  });
  return { failure, recorded };
}

function terminalFailureFrom({ failure, recorded }) {
  return {
    errorCode: failure.errorCode,
    errorMessage: failure.errorMessage,
    attempts: recorded.attempts,
    details: {
      stage: failure.stage,
      errorName: failure.errorName,
      providerDiagnostics: failure.providerDiagnostics,
      events: recorded.events.map((event) => ({
        eventId: event.id,
        externalId: event.external_id,
        processing: event.metadata?.suzuMemoryProcessing || {},
      })),
    },
  };
}

async function rawEvidenceFallback({
  claimed,
  previousContextEvents,
  continuationGuidanceEvents,
  archiveWindows,
  identity,
  systemPrompt,
  timeZone,
}) {
  return generateCompanionEventBatch({
    events: claimed.events,
    previousContextEvents,
    continuationGuidanceEvents,
    archiveWindows,
    identity,
    memoriesOverride: [],
    systemPrompt,
    timeZone,
  });
}

export async function processPendingCompanionEvents({
  repository,
  agentId,
  identity = {},
  maximumEvents = 100,
  maximumContentCharacters = 48_000,
  candidateEventIds = [],
  leaseSeconds = 1800,
  generator = null,
  previousContextEvents = [],
  continuationGuidanceEvents = [],
  archiveWindows = [],
  usageLedgerPath = "",
  systemPrompt = "",
  timeZone,
  memoriesOverride = null,
  chunkPolicy = null,
  now = new Date(),
} = {}) {
  if (!repository || !clean(agentId)) {
    throw new Error("processPendingCompanionEvents requires repository and agentId.");
  }
  const executionTime = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(executionTime.getTime())) throw new Error("Event processing now is invalid.");
  const completedAt = executionTime.toISOString();
  const normalizedIdentity = normalizeCompanionIdentity({
    ...identity,
    agentId,
    spaceId: identity.spaceId || agentId,
  });
  let chunk = null;
  if (chunkPolicy) {
    chunk = await selectReplyChunk({ repository, agentId, identity: normalizedIdentity, systemPrompt, timeZone, policy: chunkPolicy });
    if (chunk.status === 'blocked') {
      const review = repository.claimPendingInputEvents(agentId, { candidateEventIds: chunk.inputEventIds,
        maximumEvents: 500, maximumContentCharacters: 10_000_000, createdAt: completedAt,
        validateLogicalEvent: () => ({ code: 'INPUT_EVENT_CHUNK_LIMIT',
          message: 'The complete input event cannot fit the extraction chunk; original content is retained for review.',
          details: { reason: chunk.reason, maximumRequestTokens: chunkPolicy.maximumRequestTokens,
            estimatedRequestTokens: chunk.estimatedRequestTokens } }),
      });
      return { status: 'quarantined', reason: chunk.reason, eventsProcessed: 0, quarantined: review.quarantined };
    }
    if (chunk.status !== 'ready') return chunk;
    candidateEventIds = chunk.events.map(row => row.id);
    previousContextEvents = chunk.previousContextEvents;
    continuationGuidanceEvents = chunk.continuationGuidanceEvents;
    maximumEvents = candidateEventIds.length;
    maximumContentCharacters = 10_000_000;
  }
  const claimed = repository.claimPendingInputEvents(agentId, {
    maximumEvents,
    maximumContentCharacters,
    candidateEventIds,
    leaseSeconds,
    createdAt: completedAt,
  });
  if (chunk && claimed.batch) {
    const order = new Map(candidateEventIds.map((id, index) => [id, index]));
    claimed.events.sort((a, b) => order.get(a.id) - order.get(b.id));
  }
  if (!claimed.batch) {
    if (claimed.quarantined?.length) {
      return {
        status: "quarantined",
        reason: "input-event-requires-review",
        eventsProcessed: 0,
        quarantined: claimed.quarantined,
      };
    }
    return { status: "skipped", reason: "no-pending-events", eventsProcessed: 0 };
  }

  let generated;
  const sourceView = executionEventSourceView(repository, agentId);
  if (sourceView) {
    const eligibleContext = rows => rows.filter(row => sourceView.inputIds.has(row.id))
      .map(row => repository.getInputEvent(agentId, row.id));
    previousContextEvents = eligibleContext(previousContextEvents);
    continuationGuidanceEvents = eligibleContext(continuationGuidanceEvents);
    archiveWindows = archiveWindows.map(window => ({ ...window,
      previousContextEvents: eligibleContext(window.previousContextEvents || []),
      continuationGuidanceEvents: eligibleContext(window.continuationGuidanceEvents || []),
    }));
  }
  let terminalGenerationFailure = null;
  try {
    generated = await generateCompanionEventBatch({
      events: claimed.events,
      previousContextEvents,
      continuationGuidanceEvents,
      archiveWindows,
      identity: normalizedIdentity,
      generator,
      memoriesOverride,
      systemPrompt,
      timeZone,
    });
  } catch (error) {
    assertEventSourceExecutionCurrent();
    if (error?.code === "INPUT_BATCH_LEASE_LOST") throw error;
    const transportAttempts = error?.code === "MEMORY_PROVIDER_TRANSPORT_EXHAUSTED"
      ? Number(error.transportAttempts || error.maximumTransportAttempts || MAXIMUM_EXTRACTION_ATTEMPTS)
      : 1;
    const { failure, recorded } = recordProcessingFailure({
      repository,
      agentId,
      claimed,
      error,
      stage: "generation",
      completedAt,
      transportAttempts,
    });
    if (!recorded.exhausted) {
      failBatch(
        repository,
        agentId,
        claimed.batch.id,
        claimed.batch.lease_owner,
        error,
        completedAt,
      );
      throw error;
    }
    terminalGenerationFailure = terminalFailureFrom({ failure, recorded });
    generated = await rawEvidenceFallback({
      claimed,
      previousContextEvents,
      continuationGuidanceEvents,
      archiveWindows,
      identity: normalizedIdentity,
      systemPrompt,
      timeZone,
    });
  }

  let archive;
  try {
    archive = archiveCompanionEventBatch({
      repository,
      agentId,
      batchId: claimed.batch.id,
      leaseOwner: claimed.batch.lease_owner,
      generated,
      completedAt,
      terminalFailure: terminalGenerationFailure,
      identity: normalizedIdentity,
    });
  } catch (error) {
    assertEventSourceExecutionCurrent();
    if (error?.code === "INPUT_BATCH_LEASE_LOST") throw error;
    const { failure, recorded } = recordProcessingFailure({
      repository,
      agentId,
      claimed,
      error,
      stage: "archive",
      completedAt,
    });
    if (!recorded.exhausted) {
      failBatch(
        repository,
        agentId,
        claimed.batch.id,
        claimed.batch.lease_owner,
        error,
        completedAt,
      );
      throw error;
    }
    terminalGenerationFailure = terminalFailureFrom({ failure, recorded });
    generated = await rawEvidenceFallback({
      claimed,
      previousContextEvents,
      continuationGuidanceEvents,
      archiveWindows,
      identity: normalizedIdentity,
      systemPrompt,
    });
    try {
      archive = archiveCompanionEventBatch({
        repository,
        agentId,
        batchId: claimed.batch.id,
        leaseOwner: claimed.batch.lease_owner,
        generated,
        completedAt,
        terminalFailure: terminalGenerationFailure,
        identity: normalizedIdentity,
      });
    } catch (fallbackError) {
      failBatch(
        repository,
        agentId,
        claimed.batch.id,
        claimed.batch.lease_owner,
        fallbackError,
        completedAt,
      );
      throw fallbackError;
    }
  }

  const postProcessing = archive.postProcessing || {
    relationshipMemberships: { status: "skipped", linked: 0 },
    associations: { status: "skipped", memories: 0 },
    embeddingIndex: { status: "skipped", reason: "post-processing-not-recorded" },
    retrievalContexts: { status: "skipped", reason: "post-processing-not-recorded" },
    consolidationPlan: null,
    structureProposals: { status: "skipped", reason: "post-processing-not-recorded" },
    maintenanceTasks: [],
    warnings: [],
  };
  const usageWarning = await recordCompanionEventGenerationUsage({
    usageLedgerPath,
    executionTime,
    agentId,
    batchId: claimed.batch.id,
    generation: generated.generation,
  });
  const warnings = usageWarning
    ? [...postProcessing.warnings, usageWarning]
    : postProcessing.warnings;
  if (terminalGenerationFailure) {
    warnings.push(
      `Long-term extraction was deferred to human review after ${terminalGenerationFailure.attempts} failed attempts: ${terminalGenerationFailure.errorMessage}`,
    );
  }

  return {
    status: "processed",
    ...(chunk ? { chunk: { reason: chunk.reason, estimatedRequestTokens: chunk.estimatedRequestTokens,
      maximumRequestTokens: chunk.maximumRequestTokens } } : {}),
    batchId: claimed.batch.id,
    eventsProcessed: claimed.events.length,
    quarantined: claimed.quarantined || [],
    inputCharacters: claimed.batch.input_character_count,
    promptCharacters: generated.input.length,
    previousContextMessages: generated.previousContextMessages.length,
    continuationGuidanceMessages: generated.continuationGuidanceMessages.length,
    archiveWindows: generated.archiveWindows.length,
    messagesArchived: archive.messagesArchived,
    generatedCandidates: generated.generation.output.memories.length,
    generationDiagnostics: {
      degraded: Boolean(terminalGenerationFailure),
      failureReviewTaskId: clean(archive.failureReviewTask?.id),
      errorCode: clean(terminalGenerationFailure?.errorCode),
      transportAttempts: terminalGenerationFailure?.attempts || Number(
        generated.generation.metadata?.transportAttempts || 0,
      ),
      repaired: Boolean(generated.generation.metadata?.repaired),
      salvaged: Boolean(generated.generation.metadata?.salvaged),
      initialCandidateCount: generated.generation.metadata?.initialCandidateCount ?? null,
      initialValidCandidateCount: Number(
        generated.generation.metadata?.initialValidCandidateCount || 0,
      ),
      initialInvalidCandidateCount: Number(
        generated.generation.metadata?.initialInvalidCandidateCount || 0,
      ),
      repairCandidateCount: generated.generation.metadata?.repairCandidateCount ?? null,
      repairValidCandidateCount: Number(
        generated.generation.metadata?.repairValidCandidateCount || 0,
      ),
      finalCandidateCount: Number(
        generated.generation.metadata?.finalCandidateCount
        ?? generated.generation.output.memories.length,
      ),
      knownParticipantRoleCorrectionCount: Number(
        generated.generation.metadata?.knownParticipantRoleCorrectionCount || 0,
      ),
    },
    memoriesStored: archive.memoriesStored,
    memoriesForReview: archive.memoriesForReview,
    memoriesRejected: archive.memoriesRejected,
    stateAnalysisRequestsQueued: archive.stateAnalysisRequestsQueued,
    candidateResults: archive.candidateResults,
    relationshipMemberships: postProcessing.relationshipMemberships,
    associations: postProcessing.associations,
    embeddingIndex: postProcessing.embeddingIndex,
    retrievalContexts: postProcessing.retrievalContexts,
    consolidationPlan: postProcessing.consolidationPlan,
    structureProposals: postProcessing.structureProposals,
    maintenanceTasks: postProcessing.maintenanceTasks,
    warnings,
  };
}
