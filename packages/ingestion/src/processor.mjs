import { assertEventSourceExecutionCurrent } from '@suzu-memory/core';
import { readArchivedExtractionEvidence } from '@suzu-memory/extraction';
import { normalizeCompanionIdentity } from "./protocol.mjs";
import { DEFAULT_LENGTH_ARCHIVE_POLICY, planReplyChunk, selectReplyChunk } from './reply-chunks.mjs';
import { logicalArchiveEventId } from './archive-windows.mjs';
import {
  archiveCompanionEventBatch,
  measureCompanionExtractionRequest,
  companionMessagesFromEvents,
  currentArchivedInputEvents,
  isExtractionRetryInput,
  readExtractionContext,
  generateCompanionEventBatch,
  extractionRepairFailure,
  recordingCompanionEventGenerator,
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
  events,
  previousContextEvents,
  continuationGuidanceEvents,
  archiveWindows,
  identity,
  systemPrompt,
  timeZone,
}) {
  return generateCompanionEventBatch({
    events,
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
          details: { reason: chunk.reason,  maximumRequestCharacters: chunk.maximumRequestCharacters,
            estimatedRequestCharacters: chunk.estimatedRequestCharacters } }),
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

  const retryInputIds = new Set(claimed.events.filter(isExtractionRetryInput).map(event => event.id));
  const events = currentArchivedInputEvents(repository, agentId, claimed.events, normalizedIdentity);
  const eligibleIds = events === claimed.events ? null : new Set(events.map(event => event.id));
  const retryWithdrawnEventIds = eligibleIds ? claimed.events.filter(event => !eligibleIds.has(event.id)).map(event => event.id) : [];
  if (!events.length) {
    repository.completeInputBatch(agentId, claimed.batch.id, { success: true, leaseOwner: claimed.batch.lease_owner, completedAt,
      output: { reason: 'source-invalidated', messagesArchived: 0, retryWithdrawnEventIds } });
    return { status: 'processed', reason: 'source-invalidated', batchId: claimed.batch.id, eventsProcessed: claimed.events.length,
      quarantined: claimed.quarantined || [], messagesArchived: 0, generationDiagnostics: { degraded: false } };
  }
  if (retryWithdrawnEventIds.length) {
    const logicalIds = new Set(events.map(logicalArchiveEventId));
    archiveWindows = archiveWindows.flatMap(window => {
      const coreEventIds = window.coreEventIds.filter(id => logicalIds.has(id));
      return coreEventIds.length ? [{ ...window, coreEventIds }] : [];
    });
  }
  let generated;
  const processSmallerBatch = async (maximumCoreMessages, errorMessage, recordLimit = true) => {
    const selection = await planReplyChunk({
      ...DEFAULT_LENGTH_ARCHIVE_POLICY, ...chunkPolicy, maximumCoreMessages, flush: true,
      pending: events, previous: previousContextEvents,
      resolveReply: chunkPolicy?.resolveReply,
      measure: selection => measureCompanionExtractionRequest({ ...selection, identity: normalizedIdentity, systemPrompt, timeZone }),
    });
    if (selection.status !== 'ready' || selection.events.length >= events.length) return null;
    const ids = new Set(selection.events.map(logicalArchiveEventId));
    const smallerWindows = archiveWindows.flatMap(window => {
      const coreEventIds = window.coreEventIds.filter(id => ids.has(id));
      if (!coreEventIds.length) return [];
      const following = selection.continuationGuidanceEvents.filter(row => window.coreEventIds.includes(logicalArchiveEventId(row)));
      return [{ ...window, coreEventIds,
        continuationGuidanceEvents: following.length ? following : window.continuationGuidanceEvents }];
    });
    repository.releaseInputBatchForSplit(agentId, claimed.batch.id, {
      leaseOwner: claimed.batch.lease_owner, maximumCoreMessages, recordLimit, errorMessage, completedAt,
    });
    const selected = new Set([...selection.events.map(row => row.id), ...retryWithdrawnEventIds]);
    const result = await processPendingCompanionEvents({ repository, agentId, identity: normalizedIdentity,
      maximumEvents: selected.size, maximumContentCharacters: 10_000_000,
      candidateEventIds: [...selected], leaseSeconds, generator,
      previousContextEvents: selection.previousContextEvents,
      continuationGuidanceEvents: selection.continuationGuidanceEvents, archiveWindows: smallerWindows,
      usageLedgerPath, systemPrompt, timeZone, memoriesOverride, now: executionTime });
    return { ...result, quarantined: [...(claimed.quarantined || []), ...(result.quarantined || [])],
      chunk: { reason: 'output-limit-split',
      coreCharacters: selection.coreCharacters, maximumCoreCharacters: selection.maximumCoreCharacters,
      coreMessages: selection.coreMessages, maximumCoreMessages,
      estimatedRequestCharacters: selection.estimatedRequestCharacters,
      maximumRequestCharacters: selection.maximumRequestCharacters } };
  };
  const priorLimit = events[0]?.metadata?.suzuMemoryProcessing?.extractionMaximumMessages;
  if (Number.isSafeInteger(priorLimit) && priorLimit > 0
    && companionMessagesFromEvents(events, normalizedIdentity).length > priorLimit) {
    const smaller = await processSmallerBatch(priorLimit, undefined, false);
    if (smaller) return smaller;
  }
  let terminalGenerationFailure = null;
  const usageWarnings = [];
  const sourceIsCurrent = retryInputIds.size ? message => !(message.inputEventIds || [message.inputEventId])
    .some(id => retryInputIds.has(id)) || Boolean(readArchivedExtractionEvidence(repository, agentId, message)) : undefined;
  try {
    const { select, contextIsCurrent } = readExtractionContext(repository, agentId, normalizedIdentity);
    previousContextEvents = select(previousContextEvents);
    continuationGuidanceEvents = select(continuationGuidanceEvents);
    archiveWindows = archiveWindows.map(window => ({ ...window,
      previousContextEvents: select(window.previousContextEvents || []),
      continuationGuidanceEvents: select(window.continuationGuidanceEvents || []),
    }));
    generated = await generateCompanionEventBatch({
      events,
      previousContextEvents,
      continuationGuidanceEvents,
      archiveWindows,
      identity: normalizedIdentity,
      generator: recordingCompanionEventGenerator({ generator, usageLedgerPath,
        agentId, batchId: claimed.batch.id, warnings: usageWarnings }),
      memoriesOverride,
      systemPrompt,
      timeZone,
      sourceIsCurrent,
      contextIsCurrent,
    });
    terminalGenerationFailure = extractionRepairFailure(generated.generation);
  } catch (error) {
    assertEventSourceExecutionCurrent();
    if (error?.code === "INPUT_BATCH_LEASE_LOST") throw error;
    if (error?.code === 'MAX_TOKENS') {
      const count = companionMessagesFromEvents(events, normalizedIdentity).length;
      if (count > 1) {
        const smaller = await processSmallerBatch(Math.max(1, Math.floor(count / 2)), error.message);
        if (smaller) return { ...smaller, warnings: [...(smaller.warnings || []), ...usageWarnings] };
      }
    }
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
      events,
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
      retryInputIds,
      retryWithdrawnEventIds,
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
      events,
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
        retryInputIds,
        retryWithdrawnEventIds,
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

  generated = archive.generated;
  terminalGenerationFailure = archive.terminalFailure;
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
  const warnings = [...postProcessing.warnings, ...usageWarnings];
  if (terminalGenerationFailure) {
    warnings.push(
      `Long-term extraction was deferred to human review after ${terminalGenerationFailure.attempts} failed attempts: ${terminalGenerationFailure.errorMessage}`,
    );
  }

  return {
    status: "processed",
    ...(chunk ? { chunk: { reason: chunk.reason,
      coreCharacters: chunk.coreCharacters,
      maximumCoreCharacters: chunk.maximumCoreCharacters, estimatedRequestCharacters: chunk.estimatedRequestCharacters,
      coreMessages: chunk.coreMessages, maximumCoreMessages: chunk.maximumCoreMessages,
      maximumRequestCharacters: chunk.maximumRequestCharacters } } : {}),
    batchId: claimed.batch.id,
    eventsProcessed: claimed.events.length,
    quarantined: claimed.quarantined || [],
    inputCharacters: claimed.batch.input_character_count,
    promptCharacters: (generated.modelInput ?? generated.input).length,
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
      repairAttempts: Number(generated.generation.metadata?.repairAttempts || 0),
      repairRejectedCandidateCount: Number(generated.generation.metadata?.repairRejectedCandidateCount || 0),
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
      unresolvedCandidateCount: generated.generation.metadata?.unresolvedCandidateCount ?? null,
      candidateValidationIncomplete: Boolean(generated.generation.metadata?.candidateValidationIncomplete),
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
