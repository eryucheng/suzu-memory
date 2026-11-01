import { repairExtractionCandidates } from './extraction-repair.mjs';
import {
  archiveLongTermEvidence,
  buildLongTermExtractionInput,
  DIRECT_USER_AGENT_DM_TOPOLOGY,
  loadLongTermExtractionSystemPrompt,
  LONG_TERM_EXTRACTION_SCHEMA,
  parseGeneratedLongTermExtraction,
  normalizeExtractionParticipantRoles,
} from "@suzu-memory/extraction";
import { ensureCompanionRelationshipStructure } from "@suzu-memory/core";
import { currentEventSourceExecution, eventSourceMaterial, assertEventSourceExecutionCurrent } from '@suzu-memory/core';
import { runImmediateMemoryMaintenance } from "@suzu-memory/maintenance";
import { appendUsageEvent } from "@suzu-memory/usage-ledger";

function clean(value) {
  return String(value ?? "").trim();
}

function combinedNumericUsage(...records) {
  const usage = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record || {})) {
      if (Number.isFinite(Number(value))) usage[key] = (usage[key] || 0) + Number(value);
    }
  }
  return usage;
}

function looseExtractionObject(output) {
  if (output && typeof output === "object" && !Array.isArray(output)) return output;
  if (typeof output !== "string") return null;
  const text = output.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function retainValidExtractionCandidates(output, context) {
  const parsed = looseExtractionObject(output);
  if (!parsed || !Array.isArray(parsed.memories)) return null;
  const memories = [];
  const rejected = [];
  const invalidCandidates = [];
  parsed.memories.forEach((candidate, index) => {
    try {
      memories.push(parseGeneratedLongTermExtraction({ memories: [candidate] }, context).memories[0]);
    } catch (error) {
      rejected.push({ index, reason: clean(error?.message).slice(0, 500) });
      invalidCandidates.push(candidate);
    }
  });
  return {
    output: { memories },
    rejected,
    invalidCandidates,
    originalCount: parsed.memories.length,
  };
}

function companionEventFragment(event) {
  const fragment = event?.metadata?.suzuMemoryFragment;
  if (!fragment || typeof fragment !== "object" || Array.isArray(fragment)) return null;
  return {
    parentEventId: clean(fragment.parentEventId),
    index: Number(fragment.index),
    count: Number(fragment.count),
    originalCharacters: Number(fragment.originalCharacters),
    startCharacter: Number(fragment.startCharacter),
    endCharacter: Number(fragment.endCharacter),
  };
}

export function companionMessageFromEvent(event, identity, index) {
  const actorRole = clean(event.actor_role || event.actor?.role);
  const actorKey = clean(event.actor_key || event.actor?.id || event.actor?.key);
  const companion = actorRole === "companion";
  const source = event.source && typeof event.source === "object" ? event.source : {};
  const eventMetadata = event.metadata && typeof event.metadata === "object"
    ? event.metadata
    : {};
  const eventId = clean(event.id || event.eventId);
  const externalId = clean(event.external_id || event.eventId || event.id);
  const occurredAt = clean(event.occurred_at || event.occurredAt);
  const knownAt = clean(event.known_at || event.knownAt || occurredAt);
  const eventType = clean(event.event_type || event.eventType);
  const worldId = clean(event.world_id || event.world?.id);
  const worldFrame = clean(event.world_frame || event.world?.frame);
  // Some imported corpora have a stable internal order but no truthful source
  // timestamp. Keep occurredAt for storage/order while never presenting that
  // synthetic value to the extraction model as an asserted real-world date.
  const sourceTimeKnown = eventMetadata.sourceTimeKnown !== false
    && eventMetadata.timelineOrder !== "synthetic-only";
  const productSource = eventMetadata.eventSource;
  return {
    id: eventId,
    externalId,
    inputEventId: eventId,
    inputEventIds: [eventId],
    sourceUuid: externalId,
    sourceIndex: index,
    timestamp: sourceTimeKnown ? occurredAt : "unknown",
    occurredAt,
    knownAt,
    role: companion ? "assistant" : productSource && actorRole !== 'user' ? actorRole : "user",
    speaker: productSource ? productSource.sender.name || productSource.sender.id : actorKey === identity.companionId
      ? identity.companionName
      : identity.primaryUserName,
    text: clean(event.content?.text),
    sourceKind: eventType,
    sourceRecordKind: `input-event:${eventType}`,
    sourceLocator: clean(source.locator),
    sourceMetadata: {
      protocolVersion: Number(event.protocol_version || event.protocolVersion || 1),
      eventType,
      hostSourceKind: clean(source.kind),
      sourceMetadata: source.metadata && typeof source.metadata === "object" ? source.metadata : {},
      eventMetadata,
      sourceTimeKnown,
    },
    worldId,
    worldFrame,
    participants: Array.isArray(event.participants) ? event.participants : [],
    ...(productSource ? { eventSource: productSource, conversationTopology: productSource.topology.kind,
      speakerIdentity: { actorRole: companion ? 'agent' : actorRole === 'system' ? 'unknown' : actorRole, actorKey } } : {}),
  };
}

export function companionMessagesFromEvents(events, identity) {
  const messages = [];
  for (let index = 0; index < events.length;) {
    const event = events[index];
    const fragment = companionEventFragment(event);
    if (!fragment) {
      messages.push(companionMessageFromEvent(event, identity, index));
      index += 1;
      continue;
    }
    const group = [];
    let cursor = index;
    while (cursor < events.length) {
      const candidateFragment = companionEventFragment(events[cursor]);
      if (candidateFragment?.parentEventId !== fragment.parentEventId) break;
      group.push({ event: events[cursor], fragment: candidateFragment });
      cursor += 1;
    }
    const complete = fragment.index === 1
      && group.length === fragment.count
      && group.every(({ event: item, fragment: itemFragment }, groupIndex) => (
        itemFragment.index === groupIndex + 1
        && itemFragment.count === fragment.count
        && itemFragment.originalCharacters === fragment.originalCharacters
        && itemFragment.endCharacter - itemFragment.startCharacter
          === String(item.content?.text ?? "").length
        && (groupIndex === 0
          ? itemFragment.startCharacter === 0
          : itemFragment.startCharacter === group[groupIndex - 1].fragment.endCharacter)
      ))
      && group.at(-1)?.fragment.endCharacter === fragment.originalCharacters;
    if (!complete) {
      const error = new Error(
        `Logical input event ${fragment.parentEventId || event.external_id} is not a complete fragment group.`,
      );
      error.code = "INPUT_EVENT_FRAGMENT_GROUP_INCOMPLETE";
      throw error;
    }
    const first = companionMessageFromEvent(group[0].event, identity, index);
    const inputEventIds = group.map(({ event: item }) => item.id);
    const logicalEvent = Object.freeze({
      parentEventId: fragment.parentEventId,
      fragmentCount: fragment.count,
      originalCharacters: fragment.originalCharacters,
      complete: true,
    });
    messages.push({
      ...first,
      externalId: fragment.parentEventId,
      sourceUuid: fragment.parentEventId,
      inputEventIds,
      // Fragment ranges are measured against the normalized original text.
      // Do not trim individual fragments here: doing so would delete whitespace
      // that happened to fall on a split boundary.
      text: group.map(({ event: item }) => String(item.content?.text ?? "")).join(""),
      logicalEvent,
      sourceMetadata: {
        ...first.sourceMetadata,
        logicalEvent: {
          ...logicalEvent,
          inputEventIds,
        },
      },
    });
    index = cursor;
  }
  return messages;
}

function logicalEventId(event) {
  return clean(companionEventFragment(event)?.parentEventId)
    || clean(event?.external_id)
    || clean(event?.eventId)
    || clean(event?.id);
}

function companionArchiveWindows(events, archiveWindows, identity) {
  if (!Array.isArray(archiveWindows) || !archiveWindows.length) return [];
  const assignedWindowByEventId = new Map();
  const observedWindowIds = new Set();
  const windows = archiveWindows.map((window, index) => {
    const id = clean(window?.id) || `window-${index + 1}`;
    if (observedWindowIds.has(id)) throw new Error(`Duplicate archive window id: ${id}.`);
    observedWindowIds.add(id);
    const coreEventIds = [...new Set((window?.coreEventIds || []).map(clean).filter(Boolean))];
    if (!coreEventIds.length) {
      throw new Error(`Archive window ${id} does not contain coreEventIds.`);
    }
    for (const eventId of coreEventIds) {
      if (assignedWindowByEventId.has(eventId)) {
        throw new Error(`Logical input event ${eventId} belongs to more than one archive window.`);
      }
      assignedWindowByEventId.set(eventId, index);
    }
    return {
      id,
      continuityId: clean(window?.continuityId) || id,
      events: [],
      coreEventIds,
      previousContextEvents: Array.isArray(window?.previousContextEvents)
        ? window.previousContextEvents
        : [],
      continuationGuidanceEvents: Array.isArray(window?.continuationGuidanceEvents)
        ? window.continuationGuidanceEvents
        : [],
    };
  });
  const observedEventIds = new Set();
  for (const event of events) {
    const eventId = logicalEventId(event);
    const windowIndex = assignedWindowByEventId.get(eventId);
    if (windowIndex === undefined) {
      throw new Error(`Claimed logical input event ${eventId || "(missing id)"} has no archive window.`);
    }
    windows[windowIndex].events.push(event);
    observedEventIds.add(eventId);
  }
  const missingEventIds = [...assignedWindowByEventId.keys()].filter(
    (eventId) => !observedEventIds.has(eventId),
  );
  if (missingEventIds.length) {
    throw new Error(`Archive windows reference unclaimed logical input events: ${missingEventIds.join(", ")}.`);
  }
  return windows.map((window) => ({
    id: window.id,
    continuityId: window.continuityId,
    messages: companionMessagesFromEvents(window.events, identity),
    previousContextMessages: companionMessagesFromEvents(
      window.previousContextEvents,
      identity,
    ),
    continuationGuidanceMessages: companionMessagesFromEvents(
      window.continuationGuidanceEvents,
      identity,
    ),
  }));
}

export function buildCompanionExtractionRequest({
  events,
  previousContextEvents = [],
  continuationGuidanceEvents = [],
  archiveWindows = [],
  identity,
  systemPrompt = "",
  timeZone,
}) {
  const semanticWindows = companionArchiveWindows(events, archiveWindows, identity);
  const previousContextMessages = semanticWindows.length
    ? []
    : companionMessagesFromEvents(previousContextEvents, identity);
  const continuationGuidanceMessages = semanticWindows.length
    ? []
    : companionMessagesFromEvents(continuationGuidanceEvents, identity);
  const built = buildLongTermExtractionInput({
    messages: semanticWindows.length ? [] : companionMessagesFromEvents(events, identity),
    previousContextMessages,
    continuationGuidanceMessages,
    archiveWindows: semanticWindows,
    memoryOwner: identity.companionName,
    userName: identity.primaryUserName,
    identity,
    timeZone,
  });
  return { built, request: {
    input: built.input,
    systemPrompt: clean(systemPrompt) || loadLongTermExtractionSystemPrompt(),
    schema: LONG_TERM_EXTRACTION_SCHEMA,
    schemaName: "long-term-memory-extraction-v2",
  } };
}

export async function generateCompanionEventBatch({ events, previousContextEvents = [],
  continuationGuidanceEvents = [], archiveWindows = [], identity, generator,
  memoriesOverride = null, systemPrompt = '', timeZone }) {
  const { built, request: generationRequest } = buildCompanionExtractionRequest({ events,
    previousContextEvents, continuationGuidanceEvents, archiveWindows, identity, systemPrompt, timeZone });
  const timeContext = { messages: built.messages, timeZone: built.timeZone };
  if (Array.isArray(memoriesOverride)) {
    return {
      timeZone: built.timeZone,
      participants: built.participants,
      messages: built.messages,
      archiveWindows: built.archiveWindows,
      previousContextMessages: built.previousContextMessages,
      continuationGuidanceMessages: built.continuationGuidanceMessages,
      input: built.input,
      generation: {
        output: parseGeneratedLongTermExtraction({ memories: memoriesOverride }, timeContext),
        usage: {},
        model: "",
        requestId: "",
        durationMs: 0,
        metadata: { source: "override" },
      },
    };
  }
  if (typeof generator !== "function") {
    throw new Error("Processing pending events requires a generation provider.");
  }
  const execution = currentEventSourceExecution();
  if (execution?.sourceScope) {
    // built contains precisely the messages serialized by the existing input
    // builder, including archive-window context and fragmented input IDs.
    const messages = [...built.messages, ...built.previousContextMessages, ...built.continuationGuidanceMessages];
    const ids = messages.flatMap(message => message.inputEventIds || [message.inputEventId]).filter(Boolean);
    generationRequest.sourceMaterial = eventSourceMaterial(execution.repository, identity.agentId || identity.companionId, [], [], ids);
  }
  const generation = await generator(generationRequest);
  assertEventSourceExecutionCurrent();
  let parsedOutput;
  try {
    parsedOutput = parseGeneratedLongTermExtraction(generation.output, timeContext);
  } catch (validationError) {
    const salvage = retainValidExtractionCandidates(generation.output, timeContext);
    const initialRequestId = generation.requestId;
    const valid = salvage?.output.memories || [];
    let repair = { memories: [], recoveredCount: 0, rejected: [], failures: [], returnedCount: 0, generations: [], state: null };
    const candidates = salvage ? salvage.invalidCandidates.map((candidate, index) => ({
      index: salvage.rejected[index].index, candidate, reason: salvage.rejected[index].reason,
    })) : [{ index: 0, candidate: null, rawOutput: generation.output, reason: clean(validationError.message) }];
    if (candidates.length) {
      try {
        repair = await repairExtractionCandidates({
          state: { candidates, messages: built.messages, participants: built.participants, timeZone: built.timeZone }, generator,
          sourceMaterial: generationRequest.sourceMaterial,
        });
      } catch (error) {
        error.usage = combinedNumericUsage(generation.usage, ...(error.repairGenerations || []).map(item => item.usage));
        error.metadata = { ...generation.metadata, ...error.metadata, initialRequestId };
        throw error;
      }
    }
    parsedOutput = { memories: [...valid, ...repair.memories] };
    const last = repair.generations.at(-1);
    const usage = combinedNumericUsage(generation.usage, ...repair.generations.map(item => item.usage));
    const durationMs = Number(generation.durationMs || 0) + repair.generations.reduce((sum, item) => sum + Number(item.durationMs || 0), 0);
    Object.assign(generation, {
      ...(last || {}), output: parsedOutput, usage, durationMs,
      metadata: {
        ...(last?.metadata || generation.metadata || {}),
        repaired: Boolean(repair.generations.length && !repair.state),
        salvaged: Boolean(valid.length),
        salvageSource: valid.length && repair.memories.length ? 'initial+repair' : repair.memories.length ? 'repair' : valid.length ? 'initial' : '',
        initialCandidateCount: salvage?.originalCount ?? null,
        initialValidCandidateCount: valid.length,
        initialInvalidCandidateCount: candidates.length,
        repairCandidateCount: repair.returnedCount,
        repairValidCandidateCount: repair.recoveredCount,
        repairRejectedCandidateCount: repair.rejected.length,
        repairRejectedCandidates: repair.rejected,
        repairAttempts: repair.generations.length,
        finalCandidateCount: parsedOutput.memories.length,
        unresolvedCandidateCount: repair.state?.candidates.length || 0,
        candidateValidationIncomplete: Boolean(repair.state),
        extractionRepair: repair.state,
        rejectedCandidates: [...(salvage?.rejected || []).map(item => ({ ...item, stage: 'initial' })), ...repair.failures],
        initialSchemaName: generationRequest.schemaName,
        initialRequestId,
        initialValidationError: clean(validationError.message),
        repairValidationError: repair.state ? repair.state.candidates.map(item => item.reason).join('; ') : '',
      },
    });
  }
  const participantNormalization = normalizeExtractionParticipantRoles(parsedOutput, built.participants);
  parsedOutput = participantNormalization.output;
  generation.output = parsedOutput;
  generation.metadata = {
    ...(generation.metadata || {}),
    initialCandidateCount: generation.metadata?.initialCandidateCount ?? parsedOutput.memories.length,
    initialValidCandidateCount: generation.metadata?.initialValidCandidateCount
      ?? parsedOutput.memories.length,
    initialInvalidCandidateCount: generation.metadata?.initialInvalidCandidateCount ?? 0,
    finalCandidateCount: generation.metadata?.finalCandidateCount ?? parsedOutput.memories.length,
    unresolvedCandidateCount: generation.metadata?.unresolvedCandidateCount ?? (generation.metadata?.candidateValidationIncomplete ? null : 0),
    candidateValidationIncomplete: generation.metadata?.candidateValidationIncomplete ?? false,
    knownParticipantRoleCorrectionCount: participantNormalization.corrections.length,
    knownParticipantRoleCorrections: participantNormalization.corrections,
  };
  return {
    timeZone: built.timeZone,
    messages: built.messages,
    participants: built.participants,
    archiveWindows: built.archiveWindows,
    previousContextMessages: built.previousContextMessages,
    continuationGuidanceMessages: built.continuationGuidanceMessages,
    input: built.input,
    generation: {
      ...generation,
      output: parsedOutput,
    },
  };
}

export function extractionRepairFailure(generation) {
  const metadata = generation.metadata || {};
  if (!metadata.extractionRepair?.candidates.length) return null;
  return { errorCode: 'MEMORY_EXTRACTION_REPAIR_INCOMPLETE',
    errorMessage: 'Extraction repair left ' + metadata.extractionRepair.candidates.length + ' candidates unresolved.',
    attempts: Math.max(1, metadata.repairAttempts || 0),
    details: { candidateIndices: metadata.extractionRepair.candidates.map(item => item.index),
      rejectedCandidates: metadata.repairRejectedCandidates || [] } };
}

function recordExtractionFailure({ repository, agentId, batchId, generated, archive, terminalFailure, completedAt, parentTaskId }) {
  if (!terminalFailure) return null;
  const sourceMessages = generated.generation.metadata?.extractionRepair?.messages || generated.messages;
  const sourceMessageIds = new Set(sourceMessages.map(message => message.id));
  const memoryIds = archive.utteranceMemoryIds.filter((_, index) => sourceMessageIds.has(generated.messages[index].id));
  const eventIds = [...new Set(sourceMessages
    .flatMap(message => message.inputEventIds || [message.inputEventId]).map(clean).filter(Boolean))];
  const attempts = Math.max(1, Math.trunc(Number(terminalFailure.attempts) || 1));
  const errorMessage = clean(terminalFailure.errorMessage) || 'Long-term extraction failed.';
  return repository.recordExhaustedMaintenanceFailure({
    agentId, lane: 'semantic', taskType: 'long-term-extraction',
    payload: { batchId, memoryIds, eventIds, stage: 'long-term-extraction',
      ...(parentTaskId ? { parentTaskId } : {}),
      ...(generated.generation.metadata?.extractionRepair ? { extractionRepair: generated.generation.metadata.extractionRepair } : {}) },
    result: { status: 'manual-review-required', failures: [{ stage: 'long-term-extraction',
      memoryIds, eventIds, errorCode: clean(terminalFailure.errorCode),
      error: errorMessage, details: terminalFailure.details || {} }] },
    errorMessage, errorDetails: { code: clean(terminalFailure.errorCode), stage: 'long-term-extraction', ...(terminalFailure.details || {}) },
    attempts, failedAt: completedAt,
  });
}

export async function retryCompanionExtractionRepair({ repository, agentId, task, generator, identity,
  completedAt, usageLedgerPath, executionTime, reviewedBy = 'human', reviewNote = '' }) {
  const state = task.payload.extractionRepair;
  const assertSourcesAvailable = () => {
    if (task.payload.eventIds.some(id => {
      const event = repository.getInputEvent(agentId, id);
      return !event || event.status !== 'archived' || event.lifecycle !== 'active';
    })) {
      throw new Error('Only active archived input events can be retried from human review.');
    }
  };
  assertSourcesAvailable();
  const execution = currentEventSourceExecution();
  const sourceMaterial = execution?.sourceScope ? eventSourceMaterial(repository, agentId, [], [], task.payload.eventIds) : undefined;
  const repair = await repairExtractionCandidates({ state, generator, sourceMaterial });
  const normalized = normalizeExtractionParticipantRoles({ memories: repair.memories }, state.participants);
  const generation = { output: normalized.output,
    usage: combinedNumericUsage(...repair.generations.map(item => item.usage)),
    durationMs: repair.generations.reduce((sum, item) => sum + Number(item.durationMs || 0), 0),
    model: repair.generations.at(-1)?.model, requestId: repair.generations.at(-1)?.requestId,
    metadata: { extractionRepair: repair.state, repairAttempts: repair.generations.length,
      repairRejectedCandidates: repair.rejected, repairRejectedCandidateCount: repair.rejected.length,
      unresolvedCandidateCount: repair.state?.candidates.length || 0, candidateValidationIncomplete: Boolean(repair.state) } };
  const failure = extractionRepairFailure(generation);
  const result = repository.transaction(() => {
    assertSourcesAvailable();
    const current = repository.getMaintenanceTask(agentId, task.id);
    if (current?.status !== 'failed' || current.review_state !== 'pending') throw new Error('Extraction repair review is no longer pending.');
    const archive = archiveLongTermEvidence({ repository, agentId, messages: state.messages,
      timeZone: state.timeZone,
      generatedMemories: generation.output.memories,
      candidateIndexOffset: repository.getNextIngestionCandidateIndex(agentId, task.payload.batchId), batchId: task.payload.batchId,
      conversationTopology: state.messages.some(message => message.eventSource) ? '' : DIRECT_USER_AGENT_DM_TOPOLOGY,
      recordedAt: completedAt, identity: { ...identity, participants: state.participants } });
    const failureReviewTask = recordExtractionFailure({ repository, agentId, batchId: task.payload.batchId,
      generated: { messages: state.messages, generation }, archive, terminalFailure: failure, completedAt, parentTaskId: task.id });
    const memoryIds = [...new Set(archive.candidateResults.flatMap(item => [item.memoryId, item.provisionalMemoryId]).filter(Boolean))];
    const postProcessing = runCompanionEventPostProcessing({ repository, agentId,
      batchId: task.payload.batchId, memoryIds, embeddingMemoryIds: [...new Set([...memoryIds, ...archive.utteranceMemoryIds])],
      requiredFollowUpEnqueue: true });
    const note = [clean(reviewNote) || 'Extraction candidate repair was retried.',
      ...repair.rejected.map(item => 'Candidate ' + item.index + ' rejected: ' + item.reason)].join('\n');
    if (!failureReviewTask || failureReviewTask.id !== task.id) repository.reviewMaintenanceTaskFailure({
      agentId, taskId: task.id, action: 'accept', reviewedBy, note, reviewedAt: completedAt,
    });
    return { status: 'processed', ...archive, failureReviewTask, postProcessing,
      generationDiagnostics: { ...generation.metadata, degraded: Boolean(failure) } };
  });
  const warning = await recordCompanionEventGenerationUsage({ usageLedgerPath, executionTime,
    agentId, batchId: task.payload.batchId, generation });
  result.warnings = [...(result.postProcessing.warnings || []), ...(warning ? [warning] : [])];
  return result;
}

export function archiveCompanionEventBatch({
  repository,
  agentId,
  batchId,
  leaseOwner,
  generated,
  completedAt,
  terminalFailure = null,
  identity = {},
}) {
  let archive;
  let failureReviewTask = null;
  let postProcessing;
  repository.transaction(() => {
    repository.assertInputBatchLease(agentId, batchId, leaseOwner);
    ensureCompanionRelationshipStructure({
      createPrimaryRelationship: Boolean(identity.primaryUserId) && !generated.messages.some(message => message.eventSource),
      repository,
      agentId,
      primaryUserId: identity.primaryUserId,
      primaryUserName: identity.primaryUserName,
      companionId: identity.companionId,
      companionName: identity.companionName,
      relationshipLabel: identity.relationshipLabel,
      worldId: identity.defaultWorldId,
      worldFrame: identity.defaultWorldFrame,
      provenance: "suzu-memory-ingestion-identity",
    });
    archive = archiveLongTermEvidence({
      repository,
      agentId,
      sourceLocator: "",
      sourceKind: "input-event",
      messages: generated.messages,
      timeZone: generated.timeZone,
      generatedMemories: generated.generation.output.memories,
      batchId,
      recordedAt: completedAt,
      conversationTopology: generated.messages.some(message => message.eventSource) ? '' : DIRECT_USER_AGENT_DM_TOPOLOGY,
      identity: { ...identity, participants: generated.participants },
    });
    failureReviewTask = recordExtractionFailure({ repository, agentId, batchId, generated, archive, terminalFailure, completedAt });
    const memoryIds = [...new Set(archive.candidateResults
      .flatMap((result) => [result.memoryId, result.provisionalMemoryId])
      .filter(Boolean))];
    const embeddingMemoryIds = [...new Set([
      ...memoryIds,
      ...(archive.utteranceMemoryIds || []),
    ])];
    postProcessing = runCompanionEventPostProcessing({
      repository,
      agentId,
      batchId,
      memoryIds,
      embeddingMemoryIds,
      requiredFollowUpEnqueue: true,
    });
    repository.completeInputBatch(agentId, batchId, {
      success: true,
      leaseOwner,
      output: {
        messagesArchived: archive.messagesArchived,
        inputCharacters: generated.input.length,
        degraded: Boolean(terminalFailure),
        candidateValidationIncomplete: Boolean(generated.generation.metadata?.candidateValidationIncomplete),
        unresolvedCandidateCount: generated.generation.metadata?.unresolvedCandidateCount || 0,
        repairRejectedCandidates: generated.generation.metadata?.repairRejectedCandidates || [],
        failureReviewTaskId: clean(failureReviewTask?.id),
        generationErrorCode: clean(terminalFailure?.errorCode),
        generationError: clean(terminalFailure?.errorMessage),
        candidateResults: archive.candidateResults.map((result) => ({
          candidateIndex: result.candidateIndex,
          status: result.status,
          memoryId: result.memoryId || "",
          provisionalMemoryId: result.provisionalMemoryId || "",
          stateAnalysisRequestId: result.stateAnalysisRequestId || "",
        })),
      },
      completedAt,
    });
  });
  return { ...archive, failureReviewTask, postProcessing };
}

export function runCompanionEventPostProcessing({
  repository,
  agentId,
  batchId,
  memoryIds,
  embeddingMemoryIds = memoryIds,
  requiredFollowUpEnqueue = false,
}) {
  const immediate = runImmediateMemoryMaintenance({
    repository,
    agentId,
    batchId,
    memoryIds,
    embeddingMemoryIds,
    requiredFollowUpEnqueue,
  });
  const taskStatus = (taskType) => {
    const task = immediate.queued.find((item) => item.taskType === taskType);
    return task
      ? { status: "queued", taskId: task.id, reused: !task.wasInserted }
      : { status: "skipped", reason: "no-new-memories" };
  };
  return {
    relationshipMemberships: immediate.relationshipMemberships,
    associations: immediate.associations,
    embeddingIndex: taskStatus("memory-embedding"),
    retrievalContexts: taskStatus("retrieval-context"),
    consolidationPlan: immediate.consolidationPlan,
    structureProposals: taskStatus("structure-proposal"),
    maintenanceTasks: immediate.queued,
    warnings: immediate.warnings,
  };
}

export async function recordCompanionEventGenerationUsage({
  usageLedgerPath,
  executionTime,
  agentId,
  batchId,
  generation,
}) {
  if (!clean(usageLedgerPath) || !generation.model || !generation.usage
    || !Object.keys(generation.usage).length) return "";
  try {
    await appendUsageEvent(usageLedgerPath, {
      timestamp: executionTime.toISOString(),
      agentId,
      provider: generation.metadata?.provider || "",
      model: generation.model,
      source: "memory-ingestion",
      feature: "companion-event-memory",
      requestId: generation.requestId || "",
      usage: generation.usage,
      metadata: {
        durationMs: Number(generation.durationMs || 0),
        inputBatchId: batchId,
        ...generation.metadata,
      },
    });
    return "";
  } catch (error) {
    return `Usage ledger write failed: ${error.message}`;
  }
}
