import { DEFAULT_MEMORY_TIME_ZONE, dateKeyInTimeZone, memoryWorldsCompatible } from '@suzu-memory/core';

function clean(value) {
  return String(value ?? "").trim();
}

function datePart(value, timeZone) {
  const text = clean(value);
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) return text;
  return dateKeyInTimeZone(text, timeZone);
}

function deriveEpisodeBoundary(members, timeZone) {
  const dates = members.flatMap((memory) => [
    datePart(memory.eventDate, timeZone),
    datePart(memory.eventStart, timeZone),
    datePart(memory.eventEnd, timeZone),
  ]).filter(Boolean).sort();
  const starts = members.map((memory) => clean(memory.eventStart))
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  const endpoints = members.flatMap((memory) => [memory.eventEnd, memory.eventStart])
    .map(clean)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort();
  const eventStart = starts[0] || null;
  const latest = endpoints.at(-1) || null;
  return {
    eventDate: dates[0] || null,
    eventStart,
    eventEnd: eventStart && latest && Date.parse(latest) > Date.parse(eventStart) ? latest : null,
  };
}

export function canProposeStructure(snapshot) {
  const memories = snapshot.currentMemories;
  return memories.length >= 2 || snapshot.candidateContainers.some(container =>
    memories.some(memory => !container.memberIds.includes(memory.id)));
}

export function enforceStructureCandidatePolicy(candidate, snapshot, {
  timeZone = DEFAULT_MEMORY_TIME_ZONE,
  requiredTriggerMemoryIds = [],
  requiredHistoricalMemoryIds = [],
  requireRetrospectiveParticipation = false,
} = {}) {
  const currentById = new Map(snapshot.currentMemories.map((memory) => [memory.id, memory]));
  const containerById = new Map(snapshot.candidateContainers.map((memory) => [memory.id, memory]));
  const memberIds = [...new Set(
    (Array.isArray(candidate.memberIds) ? candidate.memberIds : []).map(clean).filter(Boolean),
  )];
  if (!memberIds.length || memberIds.some((id) => !currentById.has(id))) {
    throw new Error("Every structure member must come from currentMemories in this bounded snapshot.");
  }
  const scopedMembers = memberIds.map(id => currentById.get(id));
  if (scopedMembers.some(memory => !memoryWorldsCompatible(scopedMembers[0], memory))) {
    throw new Error("Structure members must share their reality and world scope.");
  }
  const operation = clean(candidate.operation);
  const kind = clean(candidate.kind);
  const enforceRetrospectiveParticipation = (value) => {
    if (!requireRetrospectiveParticipation) return value;
    const members = new Set([...value.memberIds, ...(value.expectedTarget?.memberIds || [])]);
    const triggerIds = new Set(
      (Array.isArray(requiredTriggerMemoryIds) ? requiredTriggerMemoryIds : []).map(clean).filter(Boolean),
    );
    const historicalIds = new Set(
      (Array.isArray(requiredHistoricalMemoryIds) ? requiredHistoricalMemoryIds : []).map(clean).filter(Boolean),
    );
    if (!triggerIds.size || !historicalIds.size) {
      throw new Error("Retrospective structure policy requires trigger and historical partitions.");
    }
    if (![...triggerIds].some((id) => members.has(id))) {
      throw new Error("Retrospective structure proposal must include a trigger memory.");
    }
    if (value.operation === "create" && ![...historicalIds].some((id) => members.has(id))) {
      throw new Error("Retrospective structure creation must include a historical memory.");
    }
    return value;
  };
  if (operation === "attach") {
    const target = containerById.get(clean(candidate.targetMemoryId));
    if (!target || (kind && target.kind !== kind)) {
      throw new Error("Attach target must be a matching candidateContainer in this bounded snapshot.");
    }
    if (!memoryWorldsCompatible(target, scopedMembers[0])) throw new Error("Structure target is outside its members' world scope.");
    const additions = memberIds.filter(id => !target.memberIds.includes(id));
    if (!additions.length) throw Object.assign(new Error('Attach proposal must add at least one new member.'),
      { code: 'MEMORY_STRUCTURE_NO_NEW_MEMBERS' });
    if (!clean(candidate.content)) throw new Error('Structure attachment requires an updated overall summary.');
    return enforceRetrospectiveParticipation({ ...candidate, kind: target.kind, memberIds: additions,
      expectedTarget: { title: target.title, content: target.content, memberIds: target.memberIds } });
  }
  if (operation !== "create") {
    throw new Error("Structure operation must be create or attach.");
  }
  if (clean(candidate.targetMemoryId)) {
    throw new Error("Create proposal cannot name a targetMemoryId.");
  }
  if (memberIds.length < 2) {
    throw new Error("Create proposal requires at least two current memories.");
  }
  const members = memberIds.map((id) => currentById.get(id));
  if (kind === "episode") {
    return enforceRetrospectiveParticipation({
      ...candidate,
      memberIds,
      ...deriveEpisodeBoundary(members, timeZone),
    });
  }
  if (kind === "topic") {
    return enforceRetrospectiveParticipation({
      ...candidate,
      memberIds,
      eventDate: null,
      eventStart: null,
      eventEnd: null,
    });
  }
  throw new Error("Structure kind must be episode or topic.");
}
