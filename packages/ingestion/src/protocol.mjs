export const COMPANION_EVENT_PROTOCOL_VERSION = 1;
export const DEFAULT_MAXIMUM_INPUT_EVENT_CHARACTERS = 12_000;
export const COMPANION_EVENT_TYPES = Object.freeze([
  "conversation.turn",
  "activity.observation",
  "agent.action",
  "tool.observation",
  "user.feedback",
  "relationship.milestone",
]);
export const COMPANION_WORLD_FRAMES = Object.freeze([
  "physical",
  "relational",
  "fictional",
  "dream",
  "hypothetical",
  "unknown",
]);

const PRIMARY_ROLES = new Set(["user", "companion"]);
const PARTICIPANT_ROLES = new Set(["user", "companion", "other"]);

function clean(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, fallback, label) {
  const selected = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return selected;
}

function splitTextAtBoundaries(text, maximumCharacters) {
  if (text.length <= maximumCharacters) return [text];
  const chunks = [];
  let offset = 0;
  const minimumBoundary = Math.max(1, Math.floor(maximumCharacters * 0.6));
  while (offset < text.length) {
    const remaining = text.length - offset;
    if (remaining <= maximumCharacters) {
      chunks.push(text.slice(offset));
      break;
    }
    const window = text.slice(offset, offset + maximumCharacters);
    let boundary = -1;
    for (const pattern of [/\n\s*\n/gu, /[。！？!?；;]\s*/gu, /\s+/gu]) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(window); match; match = pattern.exec(window)) {
        const candidate = match.index + match[0].length;
        if (candidate >= minimumBoundary) boundary = candidate;
        if (!match[0].length) pattern.lastIndex += 1;
      }
      if (boundary >= minimumBoundary) break;
    }
    const length = boundary >= minimumBoundary ? boundary : maximumCharacters;
    chunks.push(text.slice(offset, offset + length));
    offset += length;
  }
  return chunks;
}

export function fragmentCompanionEvent(event, {
  maximumEventCharacters = DEFAULT_MAXIMUM_INPUT_EVENT_CHARACTERS,
} = {}) {
  const maximum = positiveInteger(
    maximumEventCharacters,
    DEFAULT_MAXIMUM_INPUT_EVENT_CHARACTERS,
    "maximumEventCharacters",
  );
  const text = event.content.text;
  const chunks = splitTextAtBoundaries(text, maximum);
  if (chunks.length === 1) return [event];
  let cursor = 0;
  return chunks.map((chunk, index) => {
    const startCharacter = cursor;
    cursor += chunk.length;
    const fragmentNumber = String(index + 1).padStart(6, "0");
    const fragmentCount = String(chunks.length).padStart(6, "0");
    return {
      ...event,
      eventId: index === 0
        ? event.eventId
        : `${event.eventId}#suzu-memory-fragment=${fragmentNumber}of${fragmentCount}`,
      content: Object.freeze({ ...event.content, text: chunk }),
      metadata: Object.freeze({
        ...event.metadata,
        suzuMemoryFragment: Object.freeze({
          parentEventId: event.eventId,
          index: index + 1,
          count: chunks.length,
          originalCharacters: text.length,
          startCharacter,
          endCharacter: cursor,
        }),
      }),
    };
  });
}

function plainObject(value, label, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`${label} is required.`);
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return { ...value };
}

function isoTimestamp(value, label, fallback = "") {
  const selected = clean(value) || clean(fallback);
  const parsed = new Date(selected);
  if (!selected || !Number.isFinite(parsed.getTime())) {
    throw new Error(`${label} must be a valid timestamp.`);
  }
  return parsed.toISOString();
}

function normalizeParticipant(value, index, identity) {
  const participant = plainObject(value, `participants[${index}]`, { required: true });
  const role = clean(participant.role);
  const id = clean(participant.id);
  if (!PARTICIPANT_ROLES.has(role) || !id) {
    throw new Error(`participants[${index}] requires a supported role and id.`);
  }
  if (role === "user" && id !== identity.primaryUserId) {
    throw new Error("A memory space cannot contain a second primary user.");
  }
  if (role === "companion" && id !== identity.companionId) {
    throw new Error("A memory space cannot contain a second companion.");
  }
  return { id, role, name: clean(participant.name) };
}

export function normalizeCompanionIdentity(options = {}) {
  const spaceId = clean(options.spaceId || options.agentId);
  const companionId = clean(options.companionId || options.agentId);
  const primaryUserId = clean(options.primaryUserId) || "user";
  if (!spaceId || !companionId) {
    throw new Error("Companion event identity requires spaceId and companionId.");
  }
  return Object.freeze({
    spaceId,
    companionId,
    primaryUserId,
    companionName: clean(options.companionName) || "Companion",
    primaryUserName: clean(options.primaryUserName) || "User",
    defaultWorldId: clean(options.defaultWorldId) || "relationship",
    defaultWorldFrame: clean(options.defaultWorldFrame) || "relational",
  });
}

export function normalizeCompanionEvent(value, options = {}) {
  const identity = normalizeCompanionIdentity(options);
  const input = plainObject(value, "event", { required: true });
  const protocolVersion = Number(input.protocolVersion ?? COMPANION_EVENT_PROTOCOL_VERSION);
  if (protocolVersion !== COMPANION_EVENT_PROTOCOL_VERSION) {
    throw new Error(`Unsupported companion event protocolVersion: ${protocolVersion}.`);
  }
  const eventId = clean(input.eventId);
  const spaceId = clean(input.spaceId) || identity.spaceId;
  const eventType = clean(input.eventType);
  if (!eventId) throw new Error("eventId is required.");
  if (spaceId !== identity.spaceId) throw new Error("Event belongs to another memory space.");
  if (!COMPANION_EVENT_TYPES.includes(eventType)) {
    throw new Error(`Unsupported companion eventType: ${eventType}.`);
  }
  const actor = plainObject(input.actor, "actor", { required: true });
  const actorRole = clean(actor.role);
  const actorId = clean(actor.id);
  if (!PRIMARY_ROLES.has(actorRole) || !actorId) {
    throw new Error("actor must identify the primary user or companion.");
  }
  if (actorRole === "user" && actorId !== identity.primaryUserId) {
    throw new Error("User actor does not match this memory space.");
  }
  if (actorRole === "companion" && actorId !== identity.companionId) {
    throw new Error("Companion actor does not match this memory space.");
  }
  const participants = Array.isArray(input.participants)
    ? input.participants.map((participant, index) => normalizeParticipant(participant, index, identity))
    : [];
  const byRole = new Map(participants.map((participant) => [participant.role, participant]));
  if (!byRole.has("user")) participants.push({
    id: identity.primaryUserId,
    role: "user",
    name: identity.primaryUserName,
  });
  if (!byRole.has("companion")) participants.push({
    id: identity.companionId,
    role: "companion",
    name: identity.companionName,
  });
  const seenParticipants = new Set();
  const uniqueParticipants = participants.filter((participant) => {
    const key = `${participant.role}\u001f${participant.id}`;
    if (seenParticipants.has(key)) return false;
    seenParticipants.add(key);
    return true;
  });
  const world = plainObject(input.world, "world");
  const worldId = clean(world.id) || identity.defaultWorldId;
  const worldFrame = clean(world.frame) || identity.defaultWorldFrame;
  if (!COMPANION_WORLD_FRAMES.includes(worldFrame)) {
    throw new Error(`Unsupported companion world frame: ${worldFrame}.`);
  }
  const content = plainObject(input.content, "content", { required: true });
  const text = clean(content.text);
  if (!text) throw new Error("content.text is required.");
  const occurredAt = isoTimestamp(input.occurredAt, "occurredAt");
  const knownAt = isoTimestamp(input.knownAt, "knownAt", occurredAt);
  const recordedAt = isoTimestamp(input.recordedAt, "recordedAt", new Date().toISOString());
  return Object.freeze({
    protocolVersion,
    eventId,
    spaceId,
    eventType,
    occurredAt,
    knownAt,
    recordedAt,
    actor: Object.freeze({ id: actorId, role: actorRole, name: clean(actor.name) }),
    participants: Object.freeze(uniqueParticipants.map(Object.freeze)),
    world: Object.freeze({ id: worldId, frame: worldFrame }),
    content: Object.freeze({ ...content, text }),
    source: Object.freeze(plainObject(input.source, "source")),
    metadata: Object.freeze(plainObject(input.metadata, "metadata")),
  });
}

export function appendCompanionEvents({
  repository,
  agentId,
  events,
  identity = {},
  maximumEventCharacters = DEFAULT_MAXIMUM_INPUT_EVENT_CHARACTERS,
} = {}) {
  if (!repository) throw new Error("appendCompanionEvents requires repository.");
  const values = Array.isArray(events) ? events : [events];
  if (!values.length) throw new Error("appendCompanionEvents requires at least one event.");
  const normalizedIdentity = normalizeCompanionIdentity({
    ...identity,
    agentId,
    spaceId: identity.spaceId || agentId,
  });
  return repository.transaction(() => {
    const results = values.flatMap((event) => {
      const normalized = normalizeCompanionEvent(event, normalizedIdentity);
      return fragmentCompanionEvent(normalized, { maximumEventCharacters }).map((fragment) => (
        repository.appendInputEvent({
          agentId,
          externalId: fragment.eventId,
          protocolVersion: fragment.protocolVersion,
          eventType: fragment.eventType,
          actorRole: fragment.actor.role,
          actorKey: fragment.actor.id,
          participants: fragment.participants,
          worldId: fragment.world.id,
          worldFrame: fragment.world.frame,
          occurredAt: fragment.occurredAt,
          knownAt: fragment.knownAt,
          recordedAt: fragment.recordedAt,
          content: fragment.content,
          source: fragment.source,
          metadata: fragment.metadata,
        })
      ));
    });
    return {
      accepted: values.length,
      inserted: results.filter((result) => result.wasInserted).length,
      reused: results.filter((result) => !result.wasInserted).length,
      eventRecords: results.length,
      fragmented: results.length - values.length,
      events: results.map((result) => result.event),
    };
  });
}

export function reviseCompanionEvent({
  repository,
  agentId,
  targetEventId,
  action,
  replacementEvent = null,
  revisionId = "",
  reason = "",
  metadata = {},
  identity = {},
  maximumEventCharacters = DEFAULT_MAXIMUM_INPUT_EVENT_CHARACTERS,
  createdAt = new Date(),
} = {}) {
  if (!repository) throw new Error("reviseCompanionEvent requires repository.");
  const normalizedAction = clean(action).toLowerCase();
  if (!["amend", "supersede", "retract"].includes(normalizedAction)) {
    throw new Error("reviseCompanionEvent action must be amend, supersede, or retract.");
  }
  if (normalizedAction === "retract" && replacementEvent) {
    throw new Error("A retraction cannot include replacementEvent.");
  }
  if (normalizedAction !== "retract" && !replacementEvent) {
    throw new Error("An amendment or supersession requires replacementEvent.");
  }
  return repository.transaction(() => {
    const replacement = replacementEvent
      ? appendCompanionEvents({
        repository,
        agentId,
        events: [replacementEvent],
        identity,
        maximumEventCharacters,
      })
      : null;
    const revised = repository.reviseInputEvent({
      id: revisionId,
      agentId,
      targetExternalId: clean(targetEventId),
      action: normalizedAction,
      replacementExternalId: replacement?.events[0]?.external_id || "",
      reason,
      metadata,
      createdAt,
    });
    return {
      ...revised,
      replacement,
    };
  });
}
