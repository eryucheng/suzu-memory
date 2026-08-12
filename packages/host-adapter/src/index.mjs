import { createHash } from "node:crypto";
import {
  createConversationArchiveWindows,
  groupConversationEventsByArchiveWindow,
  packConversationArchiveWindows,
  toProcessingArchiveWindows,
} from "@suzu-memory/ingestion";

export {
  createMemoryInterventionPolicy,
  MEMORY_INTERVENTION_SCHEMA,
} from "./intervention-policy.mjs";

const PROTOCOL_VERSION = 1;

function clean(value) {
  return String(value ?? "").trim();
}

function required(value, label) {
  const normalized = clean(value);
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}

function timestamp(value, label, fallback = new Date()) {
  const selected = value === undefined || value === null || value === "" ? fallback : value;
  const parsed = selected instanceof Date ? selected : new Date(selected);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be a valid time.`);
  return parsed.toISOString();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeIdentity(identity = {}) {
  const value = plainObject(identity);
  return Object.freeze({
    spaceId: required(value.spaceId, "identity.spaceId"),
    primaryUserId: required(value.primaryUserId, "identity.primaryUserId"),
    primaryUserName: clean(value.primaryUserName) || "User",
    companionId: required(value.companionId, "identity.companionId"),
    companionName: clean(value.companionName) || "Companion",
    defaultWorldId: clean(value.defaultWorldId) || "relationship",
    defaultWorldFrame: clean(value.defaultWorldFrame) || "relational",
  });
}

function assertMemoryClient(memory) {
  const requiredMethods = [
    "appendEvents",
    "listInputEvents",
    "recoverProcessingEvents",
    "processPendingEvents",
    "search",
    "setRetrievalSessionHead",
    "bindRetrievalUsageResponse",
    "bindRewardObservation",
    "recordRetrievalFeedback",
    "runMaintenance",
  ];
  if (!memory || requiredMethods.some((name) => typeof memory[name] !== "function")) {
    throw new Error(`memory must implement: ${requiredMethods.join(", ")}.`);
  }
  return memory;
}

function normalizeInterventionPolicy(policy) {
  if (policy === undefined || policy === null) return null;
  if (typeof policy !== "function") {
    throw new Error("interventionPolicy must be a function.");
  }
  return policy;
}

function stableEventId(hostId, sessionId, turnId, role, messageId = "") {
  const digest = createHash("sha256").update([
    hostId,
    sessionId,
    turnId,
    role,
    clean(messageId),
  ].join("\u001f")).digest("hex");
  return `host-turn-${digest}`;
}

function runtimeSessionId(hostId, sessionId) {
  const digest = createHash("sha256").update([
    required(hostId, "hostId"),
    required(sessionId, "sessionId"),
  ].join("\u001f")).digest("hex");
  return `host-session-${digest}`;
}

function archiveMemoryWindowId(hostId, sessionId) {
  const digest = createHash("sha256").update([
    required(hostId, "hostId"),
    required(sessionId, "sessionId"),
  ].join("\u001f")).digest("hex");
  return `host-window-${digest.slice(0, 32)}`;
}

function archiveMemoryWindowUnitId(hostId, sessionId, turnId) {
  const digest = createHash("sha256").update([
    required(hostId, "hostId"),
    required(sessionId, "sessionId"),
    required(turnId, "turnId"),
  ].join("\u001f")).digest("hex");
  return `host-window-unit-${digest.slice(0, 32)}`;
}

function normalizedParticipants(identity, participants = []) {
  const extras = Array.isArray(participants) ? participants : [];
  return [
    { id: identity.primaryUserId, role: "user", name: identity.primaryUserName },
    { id: identity.companionId, role: "companion", name: identity.companionName },
    ...extras.map((item) => ({
      id: required(item?.id, "participant.id"),
      role: required(item?.role, "participant.role"),
      name: clean(item?.name),
    })),
  ];
}

function eventForMessage({
  identity,
  hostId,
  sourceKind,
  sessionId,
  turnId,
  role,
  message,
  participants,
  world,
  turnMetadata,
  memoryWindow,
  recordedAt,
  retrievalTraceId = "",
}) {
  const text = required(message?.text, `${role}Message.text`);
  const actor = role === "user"
    ? { id: identity.primaryUserId, role: "user", name: identity.primaryUserName }
    : { id: identity.companionId, role: "companion", name: identity.companionName };
  const occurredAt = timestamp(message?.occurredAt, `${role}Message.occurredAt`, recordedAt);
  const messageId = clean(message?.id);
  const locator = clean(message?.sourceLocator)
    || clean(message?.source?.locator)
    || `host://${encodeURIComponent(hostId)}/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/${role}`;
  return {
    protocolVersion: PROTOCOL_VERSION,
    eventId: stableEventId(hostId, sessionId, turnId, role, messageId),
    spaceId: identity.spaceId,
    eventType: "conversation.turn",
    occurredAt,
    knownAt: timestamp(message?.knownAt, `${role}Message.knownAt`, occurredAt),
    recordedAt,
    actor,
    participants,
    world,
    content: {
      ...plainObject(message?.content),
      text,
    },
    source: {
      ...plainObject(message?.source),
      kind: clean(message?.source?.kind) || sourceKind,
      locator,
    },
    metadata: {
      ...plainObject(turnMetadata),
      ...plainObject(message?.metadata),
      host: {
        id: hostId,
        sessionId,
        turnId,
        messageId,
        role,
      },
      // User and companion messages from one turn stay together when the
      // formal archive planner decides where a core window may split.
      memoryWindow,
      ...(role === "companion" && clean(retrievalTraceId)
        ? { retrievalTraceId: clean(retrievalTraceId) }
        : {}),
    },
  };
}

export function buildConversationTurnEvents({
  identity,
  hostId,
  sourceKind = "chat-host",
  sessionId,
  turnId,
  userMessage,
  assistantMessage,
  participants = [],
  world = {},
  metadata = {},
  retrievalTraceId = "",
  recordedAt = new Date(),
} = {}) {
  const normalizedIdentity = normalizeIdentity(identity);
  const normalizedHostId = required(hostId, "hostId");
  const normalizedSessionId = required(sessionId, "sessionId");
  const normalizedTurnId = required(turnId, "turnId");
  const normalizedRecordedAt = timestamp(recordedAt, "recordedAt");
  const normalizedWorld = {
    id: clean(world?.id) || normalizedIdentity.defaultWorldId,
    frame: clean(world?.frame) || normalizedIdentity.defaultWorldFrame,
  };
  const normalizedActors = normalizedParticipants(normalizedIdentity, participants);
  const common = {
    identity: normalizedIdentity,
    hostId: normalizedHostId,
    sourceKind: clean(sourceKind) || "chat-host",
    sessionId: normalizedSessionId,
    turnId: normalizedTurnId,
    participants: normalizedActors,
    world: normalizedWorld,
    turnMetadata: metadata,
    memoryWindow: {
      id: clean(metadata?.memoryWindow?.id)
        || archiveMemoryWindowId(normalizedHostId, normalizedSessionId),
      unitId: clean(metadata?.memoryWindow?.unitId)
        || archiveMemoryWindowUnitId(normalizedHostId, normalizedSessionId, normalizedTurnId),
    },
    recordedAt: normalizedRecordedAt,
    retrievalTraceId,
  };
  return Object.freeze([
    Object.freeze(eventForMessage({ ...common, role: "user", message: userMessage })),
    Object.freeze(eventForMessage({ ...common, role: "companion", message: assistantMessage })),
  ]);
}

function inputEventMatchesSession(event, hostId, sessionId) {
  const host = plainObject(event?.metadata?.host);
  return clean(host.id) === clean(hostId) && clean(host.sessionId) === clean(sessionId);
}

function pageItems(page) {
  return Array.isArray(page?.items) ? page.items : [];
}

async function listSessionInputEvents(memory, { hostId, sessionId }) {
  const items = [];
  let offset = 0;
  const limit = 500;
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const page = await memory.listInputEvents({
      statuses: ["pending", "archived"],
      lifecycles: ["active"],
      hostId,
      sessionId,
      limit,
      offset,
    });
    const received = pageItems(page);
    items.push(...received.filter((event) => inputEventMatchesSession(event, hostId, sessionId)));
    const total = Number(page?.total);
    offset += received.length;
    if (!received.length || (Number.isFinite(total) && offset >= total)) break;
  }
  return items;
}

async function listPendingHostSessionIds(memory, { hostId }) {
  const sessionIds = new Set();
  let offset = 0;
  const limit = 500;
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const page = await memory.listInputEvents({
      statuses: ["pending"],
      lifecycles: ["active"],
      hostId,
      limit,
      offset,
    });
    const received = pageItems(page);
    for (const event of received) {
      const host = plainObject(event?.metadata?.host);
      const sessionId = clean(host.sessionId);
      if (clean(host.id) === clean(hostId) && sessionId) sessionIds.add(sessionId);
    }
    const total = Number(page?.total);
    offset += received.length;
    if (!received.length || (Number.isFinite(total) && offset >= total)) break;
  }
  return [...sessionIds].sort();
}

function degradedMemoryContext({ query = "", reason = "memory-unavailable" } = {}) {
  return {
    schemaVersion: 1,
    kind: "long-term-memory-context",
    status: "degraded",
    reason,
    query: clean(query),
    traceId: "",
    content: "",
    fragments: [],
  };
}

function memoryFailureDiagnostic(stage, error) {
  return {
    stage,
    code: clean(error?.code) || "MEMORY_UNAVAILABLE",
    name: clean(error?.name) || "Error",
    message: clean(error?.message) || "Long-term memory is temporarily unavailable.",
  };
}

function inputEventId(event) {
  return clean(event?.id);
}

function eventTextLength(event) {
  return String(event?.content?.text ?? "").length;
}

function pendingCoreEventIds(windows) {
  return [...new Set((windows || []).flatMap((window) => (window.coreEvents || [])
    .filter((event) => clean(event?.status) === "pending")
    .map(inputEventId)
    .filter(Boolean)))];
}

function pendingArchiveWindow(window) {
  const coreEvents = (window?.coreEvents || []).filter((event) => (
    clean(event?.status) === "pending"
  ));
  if (!coreEvents.length) return null;
  return {
    ...window,
    coreEvents,
    coreCharacters: coreEvents.reduce(
      (total, event) => total + eventTextLength(event),
      0,
    ),
  };
}

function packCharacters(windows) {
  return (windows || []).flatMap((window) => window.coreEvents || [])
    .reduce((total, event) => total + eventTextLength(event), 0);
}

export class ChatHostMemoryAdapter {
  constructor({
    memory,
    hostId,
    identity,
    sourceKind = "chat-host",
    interventionPolicy = null,
  } = {}) {
    this.memory = assertMemoryClient(memory);
    this.hostId = required(hostId, "hostId");
    this.identity = normalizeIdentity(identity);
    this.sourceKind = clean(sourceKind) || "chat-host";
    this.interventionPolicy = normalizeInterventionPolicy(interventionPolicy);
    this.pendingSessionIds = new Set();
  }

  async beforeReply({
    sessionId,
    turnId,
    userText,
    userOccurredAt = new Date(),
    recall = {},
    recentMessages = [],
    metadata = {},
    world = {},
  } = {}) {
    const normalizedSessionId = required(sessionId, "sessionId");
    const scopedSessionId = runtimeSessionId(this.hostId, normalizedSessionId);
    const normalizedTurnId = required(turnId, "turnId");
    const normalizedUserText = required(userText, "userText");
    const now = timestamp(userOccurredAt, "userOccurredAt");
    const recallOptions = plainObject(recall);
    let interventionDecision = null;
    const autoIntervention = clean(recallOptions.mode).toLowerCase() === "auto";
    if (autoIntervention && typeof recallOptions.enabled !== "boolean") {
      if (!this.interventionPolicy) {
        throw new Error("recall.mode=auto requires interventionPolicy.");
      }
    }
    let stage = "reward-observation";
    let previousResponseFeedback = null;
    try {
      previousResponseFeedback = await this.memory.bindRewardObservation({
        sessionId: scopedSessionId,
        feedbackText: normalizedUserText,
        metadata: {
          ...plainObject(metadata.feedback),
          source: "next-user-message",
          hostId: this.hostId,
          turnId: normalizedTurnId,
        },
        now,
      });
      if (autoIntervention && typeof recallOptions.enabled !== "boolean") {
        stage = "intervention";
        interventionDecision = await this.interventionPolicy({
          userText: normalizedUserText,
          recentMessages,
          metadata: {
            source: "chat-host-adapter",
            hostId: this.hostId,
            sessionId: normalizedSessionId,
            turnId: normalizedTurnId,
          },
        });
      }
      const recallEnabled = typeof recallOptions.enabled === "boolean"
        ? recallOptions.enabled
        : interventionDecision?.action !== "skip";
      if (!recallEnabled) {
        stage = "session-head";
        await this.memory.setRetrievalSessionHead({
          sessionId: scopedSessionId,
          traceId: "",
          now,
        });
        return {
          status: "skipped",
          sessionId: normalizedSessionId,
          runtimeSessionId: scopedSessionId,
          turnId: normalizedTurnId,
          previousResponseFeedback,
          memoryContext: {
            ...degradedMemoryContext({ reason: clean(recallOptions.reason)
              || clean(interventionDecision?.reasonCode)
              || "host-disabled" }),
            status: "skipped",
          },
          interventionDecision,
          memoryDiagnostics: null,
        };
      }

      const query = clean(recallOptions.query)
        || clean(interventionDecision?.query)
        || normalizedUserText;
      stage = "retrieval";
      const retrieval = await this.memory.search(query, {
        now,
        anchors: recallOptions.anchors,
        anchorSelection: recallOptions.anchorSelection,
        queryPerspective: {
          speakerRole: "user",
          speakerKey: this.identity.primaryUserId,
          speakerNames: [this.identity.primaryUserName],
          addresseeRole: "agent",
          addresseeKey: this.identity.companionId,
          addresseeNames: [this.identity.companionName],
          ...plainObject(recallOptions.queryPerspective),
        },
        world: {
          id: clean(world?.id) || this.identity.defaultWorldId,
          frame: clean(world?.frame) || this.identity.defaultWorldFrame,
        },
        allowCrossWorld: Boolean(world?.allowCrossWorld),
        options: recallOptions.options,
        persistTrace: true,
      });
      const selectedCount = Array.isArray(retrieval?.trace?.selectedIds)
        ? retrieval.trace.selectedIds.length
        : Array.isArray(retrieval?.fragments) ? retrieval.fragments.length : 0;
      const traceId = retrieval?.status === "ready" && selectedCount > 0
        ? clean(retrieval?.trace?.id)
        : "";
      stage = "session-head";
      await this.memory.setRetrievalSessionHead({
        sessionId: scopedSessionId,
        traceId,
        now,
      });
      return {
        status: retrieval?.status || "no-match",
        sessionId: normalizedSessionId,
        runtimeSessionId: scopedSessionId,
        turnId: normalizedTurnId,
        previousResponseFeedback,
        memoryContext: {
          schemaVersion: 1,
          kind: "long-term-memory-context",
          status: retrieval?.status || "no-match",
          reason: clean(retrieval?.reason),
          query,
          traceId,
          content: String(retrieval?.context ?? ""),
          fragments: Array.isArray(retrieval?.fragments) ? retrieval.fragments : [],
        },
        interventionDecision,
        retrieval,
        memoryDiagnostics: null,
      };
    } catch (error) {
      await this.memory.setRetrievalSessionHead({
        sessionId: scopedSessionId,
        traceId: "",
        now,
      }).catch(() => null);
      return {
        status: "degraded",
        sessionId: normalizedSessionId,
        runtimeSessionId: scopedSessionId,
        turnId: normalizedTurnId,
        previousResponseFeedback,
        memoryContext: degradedMemoryContext({ query: recallOptions.query || normalizedUserText }),
        interventionDecision,
        memoryDiagnostics: memoryFailureDiagnostic(stage, error),
      };
    }
  }

  async afterReply({
    sessionId,
    turnId,
    userMessage,
    assistantMessage,
    participants = [],
    world = {},
    metadata = {},
    retrievalTraceId = "",
    recordedAt = new Date(),
  } = {}) {
    const normalizedSessionId = required(sessionId, "sessionId");
    const scopedSessionId = runtimeSessionId(this.hostId, normalizedSessionId);
    const events = buildConversationTurnEvents({
      identity: this.identity,
      hostId: this.hostId,
      sourceKind: this.sourceKind,
      sessionId: normalizedSessionId,
      turnId,
      userMessage,
      assistantMessage,
      participants,
      world,
      metadata,
      retrievalTraceId,
      recordedAt,
    });
    const archive = await this.memory.appendEvents(events);
    this.pendingSessionIds.add(normalizedSessionId);
    const retrievalUsage = await this.memory.bindRetrievalUsageResponse({
      sessionId: scopedSessionId,
      responseText: required(assistantMessage?.text, "assistantMessage.text"),
      metadata: {
        ...plainObject(metadata.retrievalUsage),
        source: "chat-host-adapter",
        hostId: this.hostId,
        turnId: required(turnId, "turnId"),
      },
      now: assistantMessage?.occurredAt || recordedAt,
    });
    return {
      status: "archived",
      sessionId: normalizedSessionId,
      runtimeSessionId: scopedSessionId,
      events,
      archive,
      retrievalUsage,
    };
  }

  async abortReply({ sessionId, now = new Date() } = {}) {
    const normalizedSessionId = required(sessionId, "sessionId");
    await this.memory.setRetrievalSessionHead({
      sessionId: runtimeSessionId(this.hostId, normalizedSessionId),
      traceId: "",
      now,
    });
    return { status: "cleared" };
  }

  recordFeedback({ traceId, signal, targetMemoryIds = [], note = "", metadata = {} } = {}) {
    return this.memory.recordRetrievalFeedback({
      traceId: required(traceId, "traceId"),
      signal: required(signal, "signal"),
      targetMemoryIds,
      note,
      metadata: {
        ...plainObject(metadata),
        source: "chat-host-adapter",
        hostId: this.hostId,
      },
    });
  }

  /**
   * Converts one persisted host session into the shared archive-window plan
   * before semantic maintenance runs. This is intentionally the same planner
   * used by the benchmark importers; the benchmark does not get a stronger
   * splitting or boundary-context algorithm than a real chat host.
   */
  async processSessionArchiveWindows({
    sessionId,
    maximumEvents = 100,
    maximumContentCharacters = 48_000,
    maximumPreviousContextMessages = 10,
    maximumPreviousContextCharacters = 8_000,
    maximumContinuationGuidanceMessages = 20,
    maximumContinuationGuidanceCharacters = 12_000,
    leaseSeconds,
    generator,
    systemPrompt = "",
    now = new Date(),
    memoriesOverride = null,
  } = {}) {
    const normalizedSessionId = required(sessionId, "sessionId");
    const storedEvents = await listSessionInputEvents(this.memory, {
      hostId: this.hostId,
      sessionId: normalizedSessionId,
    });
    const plans = groupConversationEventsByArchiveWindow(storedEvents);
    const processed = [];
    for (const plan of plans) {
      const windows = createConversationArchiveWindows(plan, {
        maximumEvents,
        maximumContentCharacters,
        maximumPreviousContextMessages,
        maximumPreviousContextCharacters,
        maximumContinuationGuidanceMessages,
        maximumContinuationGuidanceCharacters,
      });
      // The archive plan deliberately sees prior archived turns so it can
      // preserve boundary context.  The ingestion claim, however, is only
      // allowed to own pending rows.  Keep archived turns in contextual
      // fields, but never emit them as core event ids for this processing
      // request; otherwise companionArchiveWindows rightfully rejects an
      // archive window that references rows the claim could not acquire.
      const pendingWindows = windows.map(pendingArchiveWindow).filter(Boolean);
      const packs = packConversationArchiveWindows(pendingWindows, {
        maximumEvents,
        maximumContentCharacters,
      });
      for (const pack of packs) {
        const candidateEventIds = pendingCoreEventIds(pack.windows);
        if (!candidateEventIds.length) continue;
        const result = await this.memory.processPendingEvents({
          maximumEvents: Math.max(Number(maximumEvents) || 100, candidateEventIds.length),
          maximumContentCharacters: Math.max(
            Number(maximumContentCharacters) || 48_000,
            packCharacters(pack.windows),
          ),
          candidateEventIds,
          leaseSeconds,
          generator,
          systemPrompt,
          now,
          memoriesOverride,
          archiveWindows: toProcessingArchiveWindows(pack.windows),
        });
        processed.push({
          memoryWindowId: plan.memoryWindowId,
          windowIds: pack.windows.map((window) => window.id),
          candidateEventIds,
          result,
        });
      }
    }
    const remainingEvents = await listSessionInputEvents(this.memory, {
      hostId: this.hostId,
      sessionId: normalizedSessionId,
    });
    const pending = remainingEvents.filter((event) => clean(event?.status) === "pending").length;
    if (!pending) this.pendingSessionIds.delete(normalizedSessionId);
    return {
      status: processed.length ? "processed" : "skipped",
      reason: processed.length ? "" : "no-pending-session-events",
      sessionId: normalizedSessionId,
      events: storedEvents.length,
      batches: processed,
    };
  }

  async onIdle({ sessionId = "", processInputEvents = true, ...options } = {}) {
    const explicitSessionId = clean(sessionId);
    const recovered = processInputEvents
      ? await this.memory.recoverProcessingEvents({ now: options.now || new Date() })
      : { recovered: 0, batches: [] };
    const persistedSessionIds = processInputEvents && !explicitSessionId
      ? await listPendingHostSessionIds(this.memory, { hostId: this.hostId })
      : [];
    const sessionIds = explicitSessionId
      ? [explicitSessionId]
      : [...new Set([...this.pendingSessionIds, ...persistedSessionIds])];
    const input = [];
    const inputFailures = [];
    if (processInputEvents) {
      for (const pendingSessionId of sessionIds) {
        try {
          input.push(await this.processSessionArchiveWindows({
            sessionId: pendingSessionId,
            ...options,
          }));
        } catch (error) {
          const diagnostic = memoryFailureDiagnostic("idle-session-archive", error);
          input.push({
            status: "failed",
            reason: "session-archive-failed",
            sessionId: pendingSessionId,
            batches: [],
            error: diagnostic,
          });
          inputFailures.push({ sessionId: pendingSessionId, ...diagnostic });
        }
      }
    }
    // Never let the lower-level generic maintenance call bypass the formal
    // archive planner above. A host that has no session to offer can still run
    // embedding/semantic maintenance, but it cannot silently use a weaker
    // message splitting path.
    const maintenance = await this.memory.runMaintenance({
      ...options,
      processInputEvents: false,
    });
    const maintenanceFailed = ["failed", "completed-with-failures"].includes(clean(maintenance?.status));
    return {
      status: inputFailures.length || maintenanceFailed ? "completed-with-failures" : "completed",
      input: processInputEvents
        ? input
        : [{ status: "skipped", reason: "host-input-processing-disabled" }],
      recovered,
      failures: inputFailures,
      maintenance,
    };
  }

  onSessionEnd(options = {}) {
    return this.onIdle(options);
  }
}

export function createChatHostMemoryAdapter(options = {}) {
  return new ChatHostMemoryAdapter(options);
}

export async function executeChatTurn({
  adapter,
  sessionId,
  turnId,
  userMessage,
  recall = {},
  recentMessages = [],
  participants = [],
  world = {},
  metadata = {},
  recordedAt = new Date(),
  generateReply,
} = {}) {
  if (!adapter || typeof adapter.beforeReply !== "function"
    || typeof adapter.afterReply !== "function"
    || typeof adapter.abortReply !== "function") {
    throw new Error("executeChatTurn requires a chat host memory adapter.");
  }
  if (typeof generateReply !== "function") {
    throw new Error("executeChatTurn requires generateReply.");
  }
  const prepared = await adapter.beforeReply({
    sessionId,
    turnId,
    userText: userMessage?.text,
    userOccurredAt: userMessage?.occurredAt,
    recall,
    recentMessages,
    metadata,
    world,
  });
  let assistantMessage;
  try {
    const generated = await generateReply({
      userMessage,
      memoryContext: prepared.memoryContext,
    });
    assistantMessage = typeof generated === "string"
      ? { text: generated, occurredAt: new Date().toISOString() }
      : generated;
  } catch (error) {
    await adapter.abortReply({ sessionId }).catch(() => null);
    throw error;
  }
  try {
    const archived = await adapter.afterReply({
      sessionId,
      turnId,
      retrievalTraceId: prepared.memoryContext.traceId,
      userMessage,
      assistantMessage,
      participants,
      world,
      metadata,
      recordedAt,
    });
    return { prepared, assistantMessage, archived };
  } catch (error) {
    await adapter.abortReply({ sessionId }).catch(() => null);
    return {
      prepared,
      assistantMessage,
      archived: {
        status: "degraded",
        reason: "memory-archive-unavailable",
        memoryDiagnostics: memoryFailureDiagnostic("archive", error),
      },
    };
  }
}
