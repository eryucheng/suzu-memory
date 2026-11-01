import { appendCompanionEvents } from '@suzu-memory/ingestion';
import { normalizeEventSource, normalizeEventSourceScope, observeEventSourceScope, recordEventSourceConsumption,
  eventSourceEligible, eventSourceError, sourceSnapshot } from '@suzu-memory/core';
import { parseGeneratedLongTermExtraction, parseGeneratedExtractionRepair } from '@suzu-memory/extraction';

export function validateMemoryExtractionOutput(request, output) {
  if (request?.schemaName === 'long-term-memory-extraction-repair-v3') return parseGeneratedExtractionRepair(output);
  if (request?.schemaName !== 'long-term-memory-extraction-v2') {
    throw eventSourceError('MEMORY_EXTRACTION_SCHEMA_UNKNOWN', 'The extraction validator does not own this task schema.');
  }
  return parseGeneratedLongTermExtraction(output);
}

export function appendMemoryEventSources(memory, { scope: value, events = [] } = {}) {
  const scope = normalizeEventSourceScope(value, memory.agentId);
  const identity = memory.companionIdentity();
  const records = sourceSnapshot(events).map(event => {
    const source = normalizeEventSource(event.source, memory.agentId);
    if (source.owner !== scope.owner) throw eventSourceError('EVENT_SOURCE_INVALID', 'Event owner differs from its consumption scope.');
    const roleFor = sender => sender.kind === 'local-user' && sender.id === identity.primaryUserId ? 'user'
      : sender.kind === 'agent' && sender.id === memory.agentId ? 'companion'
      : ['system', 'world', 'unknown'].includes(sender.kind) ? sender.kind : 'other';
    const role = roleFor(source.sender);
    const participants = (source.topology.participants || []).map(sender => ({ id: sender.id, role: roleFor(sender), name: sender.name || sender.id }));
    return { source, input: {
      protocolVersion: 2, eventId: `${encodeURIComponent(scope.owner)}:${encodeURIComponent(source.eventId)}`, spaceId: source.spaceId, eventType: source.eventType,
      occurredAt: event.occurredAt, knownAt: event.knownAt || event.occurredAt, recordedAt: event.recordedAt || event.occurredAt,
      actor: { id: source.sender.id, role, name: source.sender.name || source.sender.id }, participants,
      world: event.world || { id: source.spaceId, frame: 'unknown' }, content: event.content,
      source: { kind: 'product-event', locator: `event://${encodeURIComponent(scope.owner)}/${encodeURIComponent(source.eventId)}` },
      metadata: { eventSource: source,
        host: { id: scope.owner, sessionId: memory.agentId, turnId: source.eventId, messageId: source.eventId, role },
        memoryWindow: { id: `events:${memory.agentId}:${source.spaceId}`, unitId: source.eventId } },
    } };
  });
  return memory.withRepository(repository => repository.transaction(() => {
    observeEventSourceScope(repository, scope, memory.agentId);
    const cleared = records.filter(record => !eventSourceEligible(record.source, scope));
    if (cleared.some(record => scope.version===2 ? record.source.commitSequence>scope.globalEventUpperBound
      || record.source.experienceRef?.experienceSequence>scope.experienceUpperBound : record.source.commitSequence>scope.eventUpperBound)) {
      throw eventSourceError('EVENT_SOURCE_FUTURE','Cannot consume beyond the fixed source upper bound.');
    }
    const selected = records.filter(record => eventSourceEligible(record.source, scope));
    const appended = selected.length ? appendCompanionEvents({ repository, agentId: memory.agentId,
      identity, events: selected.map(record => record.input), maximumEventCharacters: memory.defaults.ingestion.maximumEventCharacters })
      : { accepted: 0, inserted: 0, reused: 0, events: [] };
    const progress = recordEventSourceConsumption(repository, scope);
    return { ...appended, progress, cleared: cleared.map(record => ({ eventId: record.source.eventId, cleared: true })) };
  }));
}
