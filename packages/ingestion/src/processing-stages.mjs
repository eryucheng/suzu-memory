import { repairExtractionCandidates, requestExtractionOutput, selectCurrentRepairCandidates } from './extraction-repair.mjs';
import {
  archiveRepairedLongTermEvidence,
  readArchivedExtractionEvidence,
  archiveValidatedLongTermEvidence,
  buildLongTermExtractionRequest,
  DIRECT_USER_AGENT_DM_TOPOLOGY,
  loadLongTermExtractionSystemPrompt,
  inspectGeneratedLongTermExtraction,
  normalizeGeneratedLongTermExtraction, extractionEntityScope, extractionEntityDeclarationsFor,
} from "@suzu-memory/extraction";
import { ensureCompanionRelationshipStructure, locateCausalExcerpt } from "@suzu-memory/core";
import { currentEventSourceExecution, eventSourceMaterial, assertEventSourceExecutionCurrent, executionEventSourceView } from '@suzu-memory/core';
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

function annotateCausalSources(messages, excerpts) {
  if (!Array.isArray(excerpts) || !excerpts.length) return messages;
  const byRef = new Map();
  for (const item of excerpts) {
    if (!item || typeof item.sourceRef !== 'string') continue;
    byRef.set(item.sourceRef, byRef.has(item.sourceRef) ? null : item);
  }
  return messages.map(message => {
    const hint = byRef.get(message.memoryRef);
    const causalExcerpt = hint && locateCausalExcerpt(message.text, hint);
    return causalExcerpt ? { ...message, causalExcerpt } : message;
  });
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
  outputLanguage,
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
  return buildLongTermExtractionRequest({
    messages: semanticWindows.length ? [] : companionMessagesFromEvents(events, identity),
    previousContextMessages,
    continuationGuidanceMessages,
    archiveWindows: semanticWindows,
    outputLanguage,
    memoryOwner: identity.companionName,
    userName: identity.primaryUserName,
    identity,
    timeZone,
    systemPrompt: clean(systemPrompt) || loadLongTermExtractionSystemPrompt(),
  });
}

export function measureCompanionExtractionRequest(options) {
  // English has the longest language label and fallback speaker labels.
  // Measure the request envelope before classifying the selected window.
  const { request } = buildCompanionExtractionRequest({ ...options, outputLanguage: 'en' });
  return (request.modelInput ?? request.input).length + request.systemPrompt.length
    + JSON.stringify(request.modelSchema ?? request.schema).length + 100;
}

export async function generateCompanionEventBatch({ events, previousContextEvents = [],
  continuationGuidanceEvents = [], archiveWindows = [], identity, generator,
  memoriesOverride = null, systemPrompt = '', timeZone, sourceIsCurrent, contextIsCurrent }) {
  const { built, request: generationRequest } = buildCompanionExtractionRequest({ events,
    previousContextEvents, continuationGuidanceEvents, archiveWindows, identity, systemPrompt, timeZone });
  const timeContext = built;
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
        output: normalizeGeneratedLongTermExtraction({ memories: memoriesOverride }, timeContext),
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
  const scopedMaterial = (messages) => eventSourceMaterial(execution.repository,
    identity.agentId || identity.companionId, [], [], messages.flatMap(messageInputIds));
  if (execution?.sourceScope) {
    // built contains precisely the messages serialized by the existing input
    // builder, including archive-window context and fragmented input IDs.
    const messages = [...built.messages, ...built.previousContextMessages, ...built.continuationGuidanceMessages];
    generationRequest.sourceMaterial = scopedMaterial(messages);
  }
  const { generation, decodeError } = await requestExtractionOutput(generator, generationRequest);
  assertEventSourceExecutionCurrent();
  const inspected = decodeError ? { validationError: decodeError }
    : inspectGeneratedLongTermExtraction(generation.output, timeContext);
  const messages = annotateCausalSources(built.messages, inspected.causalExcerpts);
  const { validationError, failures = [] } = inspected;
  let parsedOutput = inspected.output;
  if (validationError) {
    const initialRequestId = generation.requestId;
    const currentRefs = sourceIsCurrent ? new Set(messages.filter(sourceIsCurrent).map(message => message.memoryRef)) : null;
    const valid = (parsedOutput?.memories || []).filter(memory => !currentRefs || memory.sourceRefs.every(ref => currentRefs.has(ref)));
    const established = new Map(valid.flatMap(memory => memory.entityMentions || []).map(entity => [entity.ref, entity]));
    let repair = { memories: [], recoveredCount: 0, rejected: [], failures: [], returnedCount: 0, generations: [], state: null };
    const candidates = parsedOutput ? failures.map(({ candidate, index, error }) => {
      const entities = extractionEntityDeclarationsFor([candidate], inspected.entities, established);
      return { index, evidenceSourceRefs: candidate?.sourceRefs,
        draft: { memories: [candidate], ...(Array.isArray(entities) && !entities.length ? {} : { entities }) }, reason: clean(error.message).slice(0, 500) };
    }) : [{ index: 0, draft: { rawOutput: generation.output }, reason: clean(validationError.message) }];
    if (candidates.length) {
      repair = await repairExtractionCandidates({
        state: { candidates, entityScope: extractionEntityScope(built.messages), entities: [...established.values()], messages, participants: built.participants, timeZone: built.timeZone,
          contextWindows: built.archiveWindows.filter(window => window.previousContextMessages.length || window.continuationGuidanceMessages.length)
            .map(({ id, label, previousContextMessages, continuationGuidanceMessages }) => ({ id, label, previousContextMessages, continuationGuidanceMessages })) }, generator,
        sourceIsCurrent, contextIsCurrent,
        sourceMaterial: generationRequest.sourceMaterial ? ({ messages: selected, contextWindows }) =>
          scopedMaterial([...selected, ...contextWindows.flatMap(window => [...window.previousContextMessages,
            ...window.continuationGuidanceMessages])]) : undefined,
      });
    }
    parsedOutput = { memories: [...valid, ...repair.memories] };
    const last = repair.generations.at(-1);
    const usage = combinedNumericUsage(generation.usage, ...repair.generations.map(item => item.usage));
    const durationMs = Number(generation.durationMs || 0) + repair.generations.reduce((sum, item) => sum + Number(item.durationMs || 0), 0);
    Object.assign(generation, {
      ...(last || {}), output: parsedOutput, usage, durationMs,
      metadata: {
        ...(last?.metadata || generation.metadata || {}),
        repaired: Boolean((repair.recoveredCount || repair.generations.length) && !repair.state),
        salvaged: Boolean(valid.length),
        salvageSource: valid.length && repair.memories.length ? 'initial+repair' : repair.memories.length ? 'repair' : valid.length ? 'initial' : '',
        initialCandidateCount: inspected.originalCount ?? null,
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
        rejectedCandidates: [...failures.map(({ index, error }) => ({
          index, reason: clean(error.message).slice(0, 500), stage: 'initial',
        })), ...repair.failures],
        initialSchemaName: generationRequest.schemaName,
        initialRequestId,
        initialValidationError: clean(validationError.message),
        repairValidationError: repair.state ? repair.state.candidates.map(item => item.reason).join('; ') : '',
      },
    });
  }
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
  };
  return {
    timeZone: built.timeZone,
    messages,
    participants: built.participants,
    archiveWindows: built.archiveWindows,
    previousContextMessages: built.previousContextMessages,
    continuationGuidanceMessages: built.continuationGuidanceMessages,
    input: built.input,
    modelInput: generationRequest.modelInput,
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
  const archivedById = new Map(archive.utteranceMemoryIds.map((id, index) => [generated.messages[index].id, id]));
  const memoryIds = [...new Set(sourceMessages.map(message => archivedById.get(message.id)
    || readArchivedExtractionEvidence(repository, agentId, message)?.memoryId).filter(Boolean))];
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

const messageInputIds = message => (message.inputEventIds || [message.inputEventId]).filter(Boolean);

export const isExtractionRetryInput = event => Boolean(event.metadata?.suzuMemoryProcessing?.retryRequestedBy);
const hasArchivedInput = event => event.status === 'archived' || isExtractionRetryInput(event);

function currentContextMessage(repository, agentId, message, view, events) {
  const ids = messageInputIds(message);
  if (!ids.length || (view && ids.some(id => !view.inputIds.has(id)))) return false;
  const rows = ids.map(id => events ? events.get(id) : repository.getInputEvent(agentId, id));
  return rows.every(event => event?.lifecycle === 'active' && event.processing_disposition !== 'quarantined')
    && clean(rows.map(event => event.content?.text).join('')) === clean(message.text)
    && (!rows.some(hasArchivedInput) || Boolean(readArchivedExtractionEvidence(repository, agentId, message)));
}

export function readExtractionContext(repository, agentId, identity) {
  const view = executionEventSourceView(repository, agentId);
  const contextIds = new Set();
  const select = rows => {
    const stored = new Map();
    const refreshed = rows.flatMap(row => {
      const event = (row.id && repository.getInputEvent(agentId, row.id))
        || repository.getInputEventByExternalId(agentId, row.external_id || row.eventId || row.id);
      if (view && !view.inputIds.has(event?.id)) return [];
      if (!event) return [row];
      stored.set(event.id, event);
      return [event];
    });
    const unavailable = new Set();
    for (const message of companionMessagesFromEvents(refreshed, identity)) {
      const ids = messageInputIds(message);
      if (ids.some(id => stored.has(id))) {
        if (!currentContextMessage(repository, agentId, message, view, stored)) {
          ids.forEach(id => unavailable.add(id));
        } else ids.forEach(id => contextIds.add(id));
      }
    }
    return refreshed.filter(row => !unavailable.has(row.id || row.eventId));
  };
  const contextIsCurrent = message => {
    const ids = messageInputIds(message);
    return !ids.some(id => contextIds.has(id)) || currentContextMessage(repository, agentId, message, view);
  };
  return { select, contextIsCurrent };
}

export function currentArchivedInputEvents(repository, agentId, events, identity) {
  const archived = events.filter(isExtractionRetryInput);
  if (!archived.length) return events;
  const unavailable = new Set(companionMessagesFromEvents(archived, identity)
    .filter(message => !readArchivedExtractionEvidence(repository, agentId, message)).flatMap(messageInputIds));
  return unavailable.size ? events.filter(event => !unavailable.has(event.id)) : events;
}

function refreshRetryEvidence(repository, agentId, generated, retryInputIds, withdrawn) {
  const archivedEvidence = new Map();
  if (!retryInputIds.size) return { generated, archivedEvidence };
  const messages = generated.messages.filter(message => {
    const ids = messageInputIds(message);
    if (!ids.some(id => retryInputIds.has(id))) return true;
    const stored = readArchivedExtractionEvidence(repository, agentId, message);
    if (stored) archivedEvidence.set(message.id, stored);
    else for (const id of ids) withdrawn.add(id);
    return Boolean(stored);
  });
  if (messages.length === generated.messages.length) return { generated, archivedEvidence };
  const scoped = new Set(messages.map(message => message.memoryRef));
  const generation = generated.generation;
  const metadata = { ...generation.metadata };
  if (metadata.extractionRepair) {
    const state = metadata.extractionRepair;
    const { available, rejected } = selectCurrentRepairCandidates(state, { evidence: scoped, scoped });
    metadata.extractionRepair = available.length ? { ...state, messages, candidates: available } : null;
    metadata.unresolvedCandidateCount = available.length;
    metadata.candidateValidationIncomplete = Boolean(available.length);
    metadata.repairRejectedCandidates = [...(metadata.repairRejectedCandidates || []), ...rejected];
  }
  const memories = generation.output.memories.filter(memory => memory.sourceRefs.every(ref => scoped.has(ref)));
  metadata.finalCandidateCount = memories.length;
  return { archivedEvidence, generated: { ...generated, messages, generation: { ...generation, metadata,
    output: { ...generation.output, memories } } } };
}

function readRepairSources(repository, agentId, state) {
  const view = executionEventSourceView(repository, agentId);
  const evidence = new Map(), scoped = new Set();
  for (const message of state.messages) {
    const item = readArchivedExtractionEvidence(repository, agentId, message);
    if (!item) continue;
    evidence.set(message.memoryRef, item);
    if (!view || view.memoryIds.has(item.memoryId)) scoped.add(message.memoryRef);
  }
  return { evidence, scoped, view };
}

export async function retryCompanionExtractionRepair({ repository, agentId, task, generator, identity,
  completedAt, usageLedgerPath, reviewedBy = 'human', reviewNote = '' }) {
  const execution = currentEventSourceExecution();
  const assertTaskPending = () => {
    const current = repository.getMaintenanceTask(agentId, task.id);
    if (!current && execution?.sourceScope) throw Object.assign(new Error('Extraction review was removed with its source.'),
      { code: 'EVENT_SOURCE_MATERIAL_INELIGIBLE' });
    if (current?.status !== 'failed' || current.review_state !== 'pending'
      || current.updated_at !== task.updated_at) throw new Error('Extraction repair review is no longer pending.');
  };
  assertTaskPending();
  const state = task.payload.extractionRepair;
  const sources = readRepairSources(repository, agentId, state);
  const { available, deferred, rejected } = selectCurrentRepairCandidates(state, sources);
  if (!available.length && deferred.length && !rejected.length) throw Object.assign(
    new Error('Extraction review sources await an eligible scope.'), { code: 'EVENT_SOURCE_TASK_DEFERRED' });
  const eligibleContext = message => currentContextMessage(repository, agentId, message, sources.view);
  const messages = state.messages.filter(message => sources.scoped.has(message.memoryRef));
  const contextWindows = (state.contextWindows || []).map(window => ({ ...window,
    previousContextMessages: window.previousContextMessages.filter(eligibleContext),
    continuationGuidanceMessages: window.continuationGuidanceMessages.filter(eligibleContext),
  }));
  const sourceMaterial = execution?.sourceScope ? ({ messages: selectedMessages, contextWindows: selectedWindows }) =>
    eventSourceMaterial(repository, agentId, [], [], [...selectedMessages, ...selectedWindows.flatMap(window => [
      ...window.previousContextMessages, ...window.continuationGuidanceMessages,
    ])].flatMap(messageInputIds)) : undefined;
  const usageWarnings = [];
  const repair = await repairExtractionCandidates({ state: { ...state, candidates: available, messages, contextWindows }, sourceMaterial,
    resumeSavedDrafts: true,
    sourceIsCurrent: message => Boolean(readArchivedExtractionEvidence(repository, agentId, message)),
    contextIsCurrent: eligibleContext,
    generator: recordingCompanionEventGenerator({ generator, usageLedgerPath,
      agentId, batchId: task.payload.batchId, warnings: usageWarnings }) });
  const result = repository.transaction(() => {
    assertEventSourceExecutionCurrent();
    assertTaskPending();
    const latest = readRepairSources(repository, agentId, state);
    const ready = repair.memories.filter(memory => memory.sourceRefs.every(ref => latest.scoped.has(ref)));
    const pending = selectCurrentRepairCandidates({ ...state, candidates: [...(repair.state?.candidates || []), ...deferred] }, latest);
    const candidates = [...pending.available, ...pending.deferred];
    const extractionRepair = candidates.length ? { ...state, ...repair.state, candidates,
      messages: (pending.deferred.length ? state.messages : repair.state.messages)
        .filter(message => latest.evidence.has(message.memoryRef)),
      contextWindows: pending.deferred.length ? state.contextWindows : repair.state.contextWindows || [],
    } : null;
    const repairRejectedCandidates = [...rejected, ...repair.rejected, ...pending.rejected];
    const generation = { output: { memories: ready }, metadata: { ...repair.generations.at(-1)?.metadata,
      extractionRepair, repairAttempts: repair.generations.length, repairRejectedCandidates,
      repairRejectedCandidateCount: repairRejectedCandidates.length + repair.memories.length - ready.length,
      rejectedCandidates: repair.failures, unresolvedCandidateCount: candidates.length, candidateValidationIncomplete: Boolean(extractionRepair),
    } };
    const failure = extractionRepairFailure(generation);
    const archivedMessages = state.messages.filter(message => latest.scoped.has(message.memoryRef));
    const archive = archiveRepairedLongTermEvidence({ repository, agentId, messages: archivedMessages,
      generatedMemories: generation.output.memories,
      candidateIndexOffset: repository.getNextIngestionCandidateIndex(agentId, task.payload.batchId), batchId: task.payload.batchId,
      recordedAt: completedAt, identity: { ...identity, participants: state.participants } });
    const failureReviewTask = recordExtractionFailure({ repository, agentId, batchId: task.payload.batchId,
      generated: { messages: archivedMessages, generation }, archive, terminalFailure: failure, completedAt, parentTaskId: task.id });
    const sourceInvalidated = !ready.length && !candidates.length
      && (rejected.length || pending.rejected.length || repair.sourceInvalidated || repair.memories.length > ready.length);
    const memoryIds = [...new Set(archive.candidateResults.flatMap(item => [item.memoryId, item.provisionalMemoryId]).filter(Boolean))];
    const postProcessing = runCompanionEventPostProcessing({ repository, agentId,
      batchId: task.payload.batchId, memoryIds,
      requiredFollowUpEnqueue: true });
    const note = [clean(reviewNote) || 'Extraction candidate repair was retried.',
      ...repairRejectedCandidates.map(item => 'Candidate ' + item.index + ' rejected: ' + item.reason),
      ...(repair.memories.length > ready.length ? ['Original sources changed before archiving some repaired memories.'] : [])].join('\n');
    if (!failureReviewTask || failureReviewTask.id !== task.id) repository.reviewMaintenanceTaskFailure({
      agentId, taskId: task.id, action: sourceInvalidated ? 'dismiss' : 'accept', reviewedBy, note, reviewedAt: completedAt,
    });
    return { status: sourceInvalidated ? 'source-invalidated' : 'processed', ...archive, failureReviewTask, postProcessing,
      generationDiagnostics: { ...generation.metadata, degraded: Boolean(failure) } };
  });
  result.warnings = [...(result.postProcessing.warnings || []), ...usageWarnings];
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
  retryInputIds = new Set(),
  retryWithdrawnEventIds = [],
}) {
  let archive;
  let failureReviewTask = null;
  let postProcessing;
  repository.transaction(() => {
    repository.assertInputBatchLease(agentId, batchId, leaseOwner);
    const withdrawn = new Set(retryWithdrawnEventIds);
    const current = refreshRetryEvidence(repository, agentId, generated, retryInputIds, withdrawn);
    generated = current.generated;
    if (!generated.messages.length) terminalFailure = null;
    else if (terminalFailure?.errorCode === 'MEMORY_EXTRACTION_REPAIR_INCOMPLETE') {
      terminalFailure = extractionRepairFailure(generated.generation);
    }
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
    archive = archiveValidatedLongTermEvidence({
      repository,
      agentId,
      sourceLocator: "",
      sourceKind: "input-event",
      messages: generated.messages,
      archivedEvidence: current.archivedEvidence,
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
      ...archive.utteranceMemoryIds.filter((id, index) => !current.archivedEvidence.has(generated.messages[index].id)),
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
        inputCharacters: (generated.modelInput ?? generated.input).length,
        degraded: Boolean(terminalFailure),
        ...(withdrawn.size ? { retryWithdrawnEventIds: [...withdrawn] } : {}),
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
  return { ...archive, failureReviewTask, postProcessing, terminalFailure, generated };
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

export function recordingCompanionEventGenerator({ generator, usageLedgerPath,
  agentId, batchId, warnings }) {
  if (typeof generator !== 'function') return generator;
  // Forward function properties and methods, including non-enumerable provider
  // capabilities, while charging each returned or failed receipt before callers
  // validate sources, repair output, or persist a batch.
  return new Proxy(generator, {
    async apply(target, receiver, args) {
      const requestedAt = new Date().toISOString();
      let generation;
      let failed = false;
      try {
        generation = await Reflect.apply(target, receiver, args);
        return generation;
      } catch (error) {
        generation = error;
        failed = true;
        throw error;
      } finally {
        const warning = await recordCompanionEventGenerationUsage({
          usageLedgerPath, requestedAt, agentId, batchId,
          generation: failed ? { model: generation?.model, requestId: generation?.requestId,
            usage: generation?.usage, durationMs: generation?.durationMs,
            metadata: { ...generation?.metadata, failed: true, errorCode: generation?.code || '' } } : generation,
        });
        if (warning) warnings.push(warning);
      }
    },
  });
}

async function recordCompanionEventGenerationUsage({
  usageLedgerPath,
  requestedAt,
  agentId,
  batchId,
  generation,
}) {
  if (!clean(usageLedgerPath) || !generation?.model || !generation?.usage
    || !Object.keys(generation.usage).length) return "";
  try {
    await appendUsageEvent(usageLedgerPath, {
      timestamp: requestedAt,
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
