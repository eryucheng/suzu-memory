function clean(value) {
  return String(value ?? "").trim();
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, fallback, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(numeric)));
}

function eventCharacters(event) {
  return String(event?.content?.text ?? "").length;
}

function eventMetadata(event) {
  return plainObject(event?.metadata);
}

function fragmentMetadata(event) {
  return plainObject(eventMetadata(event).suzuMemoryFragment);
}

function hostMetadata(event) {
  return plainObject(eventMetadata(event).host);
}

function windowMetadata(event) {
  return plainObject(eventMetadata(event).memoryWindow);
}

/**
 * Returns the durable logical event id. A fragmented long message remains one
 * logical event even though it is stored as several input rows.
 */
export function logicalArchiveEventId(event) {
  return clean(fragmentMetadata(event).parentEventId)
    || clean(event?.external_id)
    || clean(event?.eventId)
    || clean(event?.id);
}

/**
 * Returns the conversation / archive-window identity supplied by a host.
 * Older host records did not have memoryWindow metadata, so their stable
 * host+session pair is retained as a backwards-compatible fallback.
 */
export function archiveMemoryWindowId(event) {
  const explicit = clean(windowMetadata(event).id);
  if (explicit) return explicit;
  const host = hostMetadata(event);
  if (clean(host.id) && clean(host.sessionId)) {
    return `host:${clean(host.id)}:session:${clean(host.sessionId)}`;
  }
  return "conversation";
}

export function archiveMemoryWindowUnitId(event) {
  return clean(windowMetadata(event).unitId) || logicalArchiveEventId(event);
}

function chronologicalEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftTime = clean(left.event?.occurred_at || left.event?.occurredAt)
        || clean(left.event?.known_at || left.event?.knownAt)
        || clean(left.event?.recorded_at || left.event?.recordedAt);
      const rightTime = clean(right.event?.occurred_at || right.event?.occurredAt)
        || clean(right.event?.known_at || right.event?.knownAt)
        || clean(right.event?.recorded_at || right.event?.recordedAt);
      const compared = leftTime.localeCompare(rightTime);
      if (compared) return compared;
      return left.index - right.index;
    })
    .map(({ event }) => event);
}

/**
 * Groups an arbitrary chronological event list into independent conversation
 * plans. The function is deliberately host-neutral: benchmark importers and
 * real chat hosts both provide the same event shape.
 */
export function groupConversationEventsByArchiveWindow(events = []) {
  const groups = new Map();
  for (const event of chronologicalEvents(events)) {
    const memoryWindowId = archiveMemoryWindowId(event);
    if (!groups.has(memoryWindowId)) {
      groups.set(memoryWindowId, { memoryWindowId, events: [] });
    }
    groups.get(memoryWindowId).events.push(event);
  }
  return [...groups.values()];
}

function memoryWindowUnits(events = []) {
  const units = [];
  for (const event of chronologicalEvents(events)) {
    const id = archiveMemoryWindowUnitId(event) || logicalArchiveEventId(event);
    const previous = units.at(-1);
    if (!previous || previous.id !== id) {
      units.push({ id, events: [event], characters: eventCharacters(event) });
      continue;
    }
    previous.events.push(event);
    previous.characters += eventCharacters(event);
  }
  return units;
}

function boundaryEvents(units, {
  fromEnd = false,
  maximumMessages,
  maximumCharacters,
}) {
  const ordered = fromEnd ? [...units].reverse() : units;
  const selected = [];
  let messages = 0;
  let characters = 0;
  for (const unit of ordered) {
    if (
      messages + unit.events.length > maximumMessages
      || characters + unit.characters > maximumCharacters
    ) break;
    selected.push(unit);
    messages += unit.events.length;
    characters += unit.characters;
  }
  const chronological = fromEnd ? selected.reverse() : selected;
  return chronological.flatMap((unit) => unit.events);
}

/**
 * Plans non-overlapping core windows with read-only context at their two
 * boundaries. Context events deliberately never join coreEventIds, so a
 * message cannot become duplicate evidence merely because it helped resolve a
 * pronoun or an unfinished activity at a split point.
 */
export function createConversationArchiveWindows(sessionPlan, {
  maximumEvents = 100,
  maximumContentCharacters = 48_000,
  maximumPreviousContextMessages = 10,
  maximumPreviousContextCharacters = 8_000,
  maximumContinuationGuidanceMessages = 20,
  maximumContinuationGuidanceCharacters = 12_000,
} = {}) {
  const events = chronologicalEvents(sessionPlan?.events || []);
  const units = memoryWindowUnits(events);
  if (!units.length) return [];
  const memoryWindowId = clean(sessionPlan?.memoryWindowId)
    || archiveMemoryWindowId(events[0]);
  const eventBudget = boundedInteger(maximumEvents, 100, { minimum: 1, maximum: 500 });
  const characterBudget = boundedInteger(maximumContentCharacters, 48_000, {
    minimum: 1,
    maximum: 10_000_000,
  });
  const previousMessageBudget = boundedInteger(maximumPreviousContextMessages, 10, {
    minimum: 0,
    maximum: 100,
  });
  const previousCharacterBudget = boundedInteger(maximumPreviousContextCharacters, 8_000, {
    minimum: 0,
    maximum: 1_000_000,
  });
  const guidanceMessageBudget = boundedInteger(maximumContinuationGuidanceMessages, 20, {
    minimum: 0,
    maximum: 100,
  });
  const guidanceCharacterBudget = boundedInteger(maximumContinuationGuidanceCharacters, 12_000, {
    minimum: 0,
    maximum: 1_000_000,
  });

  const cores = [];
  let startUnit = 0;
  let selected = [];
  let selectedEvents = 0;
  let selectedCharacters = 0;
  const flush = () => {
    if (!selected.length) return;
    cores.push({
      startUnit,
      endUnit: startUnit + selected.length,
      units: selected,
      eventCount: selectedEvents,
      characters: selectedCharacters,
      exceedsTargetBudget: selectedEvents > eventBudget || selectedCharacters > characterBudget,
    });
    startUnit += selected.length;
    selected = [];
    selectedEvents = 0;
    selectedCharacters = 0;
  };
  for (const unit of units) {
    const wouldOverflow = selected.length && (
      selectedEvents + unit.events.length > eventBudget
      || selectedCharacters + unit.characters > characterBudget
    );
    if (wouldOverflow) flush();
    selected.push(unit);
    selectedEvents += unit.events.length;
    selectedCharacters += unit.characters;
    if (selectedEvents >= eventBudget || selectedCharacters >= characterBudget) flush();
  }
  flush();

  return cores.map((core, index) => ({
    id: `${memoryWindowId}:archive:${String(index + 1).padStart(4, "0")}`,
    memoryWindowId,
    coreEvents: core.units.flatMap((unit) => unit.events),
    previousContextEvents: boundaryEvents(units.slice(0, core.startUnit), {
      fromEnd: true,
      maximumMessages: previousMessageBudget,
      maximumCharacters: previousCharacterBudget,
    }),
    continuationGuidanceEvents: boundaryEvents(units.slice(core.endUnit), {
      maximumMessages: guidanceMessageBudget,
      maximumCharacters: guidanceCharacterBudget,
    }),
    coreCharacters: core.characters,
    exceedsTargetBudget: core.exceedsTargetBudget,
  }));
}

export function packConversationArchiveWindows(windows = [], {
  maximumEvents = 100,
  maximumContentCharacters = 48_000,
} = {}) {
  const eventBudget = boundedInteger(maximumEvents, 100, { minimum: 1, maximum: 500 });
  const characterBudget = boundedInteger(maximumContentCharacters, 48_000, {
    minimum: 1,
    maximum: 10_000_000,
  });
  const packs = [];
  let selected = [];
  let eventCount = 0;
  let characters = 0;
  const flush = () => {
    if (!selected.length) return;
    packs.push({
      windows: selected,
      eventCount,
      characters,
      exceedsTargetBudget: eventCount > eventBudget || characters > characterBudget,
    });
    selected = [];
    eventCount = 0;
    characters = 0;
  };
  for (const window of Array.isArray(windows) ? windows : []) {
    const windowEvents = Array.isArray(window?.coreEvents) ? window.coreEvents.length : 0;
    const windowCharacters = Number.isFinite(Number(window?.coreCharacters))
      ? Number(window.coreCharacters)
      : (window?.coreEvents || []).reduce((sum, event) => sum + eventCharacters(event), 0);
    const wouldOverflow = selected.length && (
      eventCount + windowEvents > eventBudget
      || characters + windowCharacters > characterBudget
    );
    if (wouldOverflow) flush();
    selected.push(window);
    eventCount += windowEvents;
    characters += windowCharacters;
    if (eventCount >= eventBudget || characters >= characterBudget) flush();
  }
  flush();
  return packs;
}

/** Converts the public plan into the exact ingestion request contract. */
export function toProcessingArchiveWindows(windows = []) {
  return (Array.isArray(windows) ? windows : []).map((window) => ({
    id: clean(window?.id),
    continuityId: clean(window?.memoryWindowId) || clean(window?.id),
    coreEventIds: [...new Set((window?.coreEvents || [])
      .map(logicalArchiveEventId)
      .filter(Boolean))],
    previousContextEvents: Array.isArray(window?.previousContextEvents)
      ? window.previousContextEvents
      : [],
    continuationGuidanceEvents: Array.isArray(window?.continuationGuidanceEvents)
      ? window.continuationGuidanceEvents
      : [],
  }));
}
