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

function retainValidExtractionCandidates(output) {
  const parsed = looseExtractionObject(output);
  if (!parsed || !Array.isArray(parsed.memories)) return null;
  const memories = [];
  const rejected = [];
  const invalidCandidates = [];
  parsed.memories.forEach((candidate, index) => {
    try {
      memories.push(parseGeneratedLongTermExtraction({ memories: [candidate] }).memories[0]);
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

function mergeExtractionCandidates(...groups) {
  const merged = [];
  const seen = new Set();
  for (const candidate of groups.flat()) {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(candidate);
  }
  return merged;
}

function extractionRepairLanguageInstruction(messages = []) {
  const references = messages
    .map((message) => ({
      ref: clean(message?.memoryRef),
      language: clean(message?.sourceLanguage).toLowerCase(),
    }))
    .filter((item) => item.ref && ["zh", "en", "mixed"].includes(item.language));
  if (!references.length) return [];
  return [
    "Preserve each candidate's source language while repairing it.",
    "Use sourceRefs and this source-language map; do not translate a candidate merely to make the batch uniform.",
    "If every sourceRef is zh, write title, content, and stateLabel in Chinese. If every sourceRef is en, write them in English. Use mixed wording only when the candidate's own direct sources are mixed.",
    `Source-language map: ${references.map((item) => `${item.ref}=${item.language}`).join(", ")}.`,
  ];
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
  memoriesOverride = null, systemPrompt = '' }) {
  const { built, request: generationRequest } = buildCompanionExtractionRequest({ events,
    previousContextEvents, continuationGuidanceEvents, archiveWindows, identity, systemPrompt });
  if (Array.isArray(memoriesOverride)) {
    return {
      participants: built.participants,
      messages: built.messages,
      archiveWindows: built.archiveWindows,
      previousContextMessages: built.previousContextMessages,
      continuationGuidanceMessages: built.continuationGuidanceMessages,
      input: built.input,
      generation: {
        output: parseGeneratedLongTermExtraction({ memories: memoriesOverride }),
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
    const messages = [...(built.messages || []), ...(built.previousContextMessages || []), ...(built.continuationGuidanceMessages || []),
      ...(built.archiveWindows || []).flatMap(window => [...(window.messages || []),
        ...(window.previousContextMessages || []), ...(window.continuationGuidanceMessages || [])])];
    const ids = messages.flatMap(message => message.inputEventIds || [message.inputEventId]).filter(Boolean);
    generationRequest.sourceMaterial = eventSourceMaterial(execution.repository, identity.agentId || identity.companionId, [], [], ids);
  }
  const generation = await generator(generationRequest);
  assertEventSourceExecutionCurrent();
  let parsedOutput;
  try {
    parsedOutput = parseGeneratedLongTermExtraction(generation.output);
  } catch (validationError) {
    const initialSalvage = retainValidExtractionCandidates(generation.output);
    let repair = null;
    let repairError = null;
    const initialFullyRecoverable = initialSalvage
      && initialSalvage.rejected.length === 0
      && initialSalvage.originalCount === initialSalvage.output.memories.length;
    if (initialFullyRecoverable) {
      parsedOutput = initialSalvage.output;
    } else {
      try {
        const invalidOutput = initialSalvage
          ? { memories: initialSalvage.invalidCandidates }
          : generation.output;
        repair = await generator({
          input: JSON.stringify({
            validationError: clean(validationError?.message),
            invalidOutput,
            preservedValidCandidates: initialSalvage?.output.memories.length || 0,
          }),
          systemPrompt: [
            "Repair only the supplied invalid long-term-memory extraction candidates.",
            "Return valid json only and follow the supplied schema exactly.",
            "Valid candidates from the initial response are preserved by code and are not included here.",
            "Preserve supported facts and sourceRefs; do not add memories, facts, people, dates, or evidence.",
            "Change only fields required to satisfy the validation error and schema.",
            "If a candidate cannot be repaired without inferring a missing target or fact, omit that candidate.",
            ...extractionRepairLanguageInstruction(built.messages),
          ].join("\n"),
          schema: LONG_TERM_EXTRACTION_SCHEMA,
          schemaName: "long-term-memory-extraction-repair-v2",
          ...(generationRequest.sourceMaterial ? { sourceMaterial: generationRequest.sourceMaterial } : {}),
        });
        assertEventSourceExecutionCurrent();
        const repairedOnly = parseGeneratedLongTermExtraction(repair.output);
        parsedOutput = {
          memories: mergeExtractionCandidates(
            initialSalvage?.output.memories || [],
            repairedOnly.memories,
          ),
        };
      } catch (error) {
        assertEventSourceExecutionCurrent();
        repairError = error;
      }
    }

    const repairSalvage = repair ? retainValidExtractionCandidates(repair.output) : null;
    if (repairError) {
      const salvagedMemories = mergeExtractionCandidates(
        initialSalvage?.output.memories || [],
        repairSalvage?.output.memories || [],
      );
      if (!salvagedMemories.length) throw repairError;
      parsedOutput = { memories: salvagedMemories };
    }

    const numericUsage = combinedNumericUsage(generation.usage, repair?.usage);
    const rejectedCandidates = [
      ...(initialSalvage?.rejected || []).map((item) => ({ ...item, stage: "initial" })),
      ...(repairSalvage?.rejected || []).map((item) => ({ ...item, stage: "repair" })),
    ];
    Object.assign(generation, {
      ...(repair || {}),
      output: parsedOutput,
      usage: numericUsage,
      durationMs: Number(generation.durationMs || 0) + Number(repair?.durationMs || 0),
      metadata: {
        ...(repair?.metadata || generation.metadata || {}),
        repaired: Boolean(repair && !repairError),
        salvaged: Boolean(initialSalvage?.output.memories.length || repairError),
        salvageSource: initialSalvage?.output.memories.length && repairSalvage?.output.memories.length
          ? "initial+repair"
          : repairSalvage?.output.memories.length ? "repair"
            : initialSalvage?.output.memories.length ? "initial" : "",
        initialCandidateCount: initialSalvage?.originalCount ?? null,
        initialValidCandidateCount: initialSalvage?.output.memories.length || 0,
        initialInvalidCandidateCount: initialSalvage?.rejected.length || 0,
        repairCandidateCount: repairSalvage?.originalCount ?? null,
        repairValidCandidateCount: repairSalvage?.output.memories.length || 0,
        finalCandidateCount: parsedOutput.memories.length,
        rejectedCandidates,
        initialSchemaName: clean(generation.metadata?.schemaName) || generationRequest.schemaName,
        initialRequestId: clean(generation.requestId),
        initialValidationError: clean(validationError?.message),
        repairValidationError: clean(repairError?.message),
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
    knownParticipantRoleCorrectionCount: participantNormalization.corrections.length,
    knownParticipantRoleCorrections: participantNormalization.corrections,
  };
  return {
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
      generatedMemories: generated.generation.output.memories,
      batchId,
      recordedAt: completedAt,
      conversationTopology: generated.messages.some(message => message.eventSource) ? '' : DIRECT_USER_AGENT_DM_TOPOLOGY,
      identity: { ...identity, participants: generated.participants },
    });
    if (terminalFailure) {
      const eventIds = [...new Set(generated.messages
        .flatMap((message) => message.inputEventIds || [message.inputEventId])
        .map(clean)
        .filter(Boolean))];
      const attempts = Math.max(1, Math.trunc(Number(terminalFailure.attempts) || 1));
      const errorMessage = clean(terminalFailure.errorMessage) || "Long-term extraction failed.";
      failureReviewTask = repository.recordExhaustedMaintenanceFailure({
        agentId,
        lane: "semantic",
        taskType: "long-term-extraction",
        payload: {
          batchId,
          memoryIds: archive.utteranceMemoryIds,
          eventIds,
          stage: "long-term-extraction",
        },
        result: {
          status: "manual-review-required",
          failures: [{
            stage: "long-term-extraction",
            memoryIds: archive.utteranceMemoryIds,
            eventIds,
            errorCode: clean(terminalFailure.errorCode),
            error: errorMessage,
            details: terminalFailure.details || {},
          }],
        },
        errorMessage,
        errorDetails: {
          code: clean(terminalFailure.errorCode),
          stage: "long-term-extraction",
          ...(terminalFailure.details || {}),
        },
        attempts,
        failedAt: completedAt,
      });
    }
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
