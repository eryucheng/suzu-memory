import { appendMemoryEventSources } from './event-source-ingestion.mjs';
import { normalizeEventSource, normalizeEventSourceScope, observeEventSourceScope, recordEventSourceConsumption, sourceHash } from '@suzu-memory/core';

/** Offline provenance upgrade. Body, graph identities, extraction status and
 * historical model materials remain fixed; only Host source coordinates change. */
export function adoptExperienceSourceEvidence(memory, { scope: value, resolveSource, consumedThroughExperienceSequence }) {
  const scope = normalizeEventSourceScope(value, memory.agentId);
  if (scope.version !== 2 || typeof resolveSource !== 'function' || !Number.isSafeInteger(consumedThroughExperienceSequence)
    || consumedThroughExperienceSequence < 0 || consumedThroughExperienceSequence > scope.experienceUpperBound) throw new TypeError('A fixed experience scope and consumption position are required.');
  return memory.withRepository(repository => repository.transaction(() => {
    let updated = 0;
    for (const row of repository.database.prepare('SELECT * FROM memory_input_events WHERE agent_id=?').all(memory.agentId)) {
      const metadata = JSON.parse(row.metadata_json), old = metadata.eventSource;
      if (!old || old.owner !== scope.owner || old.version === 2 || metadata.eventSourceErased || row.lifecycle !== 'active') continue;
      const source = normalizeEventSource(resolveSource(normalizeEventSource(old, memory.agentId)), memory.agentId);
      const identity = source => ({ owner: source.owner, recipientAgentId: source.recipientAgentId, eventId: source.eventId, spaceId: source.spaceId,
        eventType: source.eventType, commitSequence: source.commitSequence, sender: source.sender, topology: source.topology, observation: source.observation || null });
      if (source.version !== 2 || source.agentGeneration !== scope.agentGeneration || sourceHash(identity(source)) !== sourceHash(identity(old))) {
        throw Object.assign(new Error('Experience evidence changed the original source identity.'), { code: 'MEMORY_IMPORT_SOURCE_MISMATCH' });
      }
      metadata.eventSource = source;
      metadata.eventSourceMigration = { version: 1, originalInputHash: row.input_hash };
      const hash = sourceHash({ protocolVersion: row.protocol_version, eventType: row.event_type, actor: { role: row.actor_role, key: row.actor_key },
        participants: JSON.parse(row.participants_json), world: { id: row.world_id, frame: row.world_frame }, occurredAt: row.occurred_at,
        knownAt: row.known_at, content: JSON.parse(row.content_json), source: JSON.parse(row.source_json), metadata });
      repository.database.prepare('UPDATE memory_input_events SET metadata_json=?,input_hash=? WHERE id=? AND agent_id=?')
        .run(JSON.stringify(metadata), hash, row.id, memory.agentId); updated++;
    }
    observeEventSourceScope(repository, scope, memory.agentId);
    const progress = recordEventSourceConsumption(repository, { ...scope, experienceUpperBound: consumedThroughExperienceSequence });
    return { updated, progress };
  }));
}

/** Offline format conversion after importDatabaseAsAgent. The caller supplies
 * committed Host evidence; existing graph/source identities stay intact. */
export function adoptLegacySourceEvidence(memory, { scope, records }) {
  if (!Array.isArray(records)) throw new TypeError('Legacy source records are required.');
  const originals = memory.withRepository(repository => {
    const select = repository.database.prepare('SELECT * FROM source_records WHERE agent_id=? AND id=?');
    return records.map(record => {
      const row = select.get(memory.agentId, record.sourceId);
      if (!row || row.lifecycle !== 'active' || row.content !== record.event?.content?.text
        || record.event?.source?.eventType !== 'suzu-memory.source.imported') {
        throw Object.assign(new Error('Imported evidence does not match its original Memory source.'), { code: 'MEMORY_IMPORT_SOURCE_MISMATCH' });
      }
      return row;
    });
  }, { readOnly: true });
  const appended = appendMemoryEventSources(memory, { scope, events: records.map(record => record.event) });
  const inputsByEvent = new Map(), seen = new Set();
  // Ingestion returns persisted inputs in fragment order, including replays.
  for (const input of appended.events) {
    if (seen.has(input.id)) continue;
    seen.add(input.id);
    const eventId = input.metadata.eventSource.eventId;
    if (!inputsByEvent.has(eventId)) inputsByEvent.set(eventId, []);
    inputsByEvent.get(eventId).push(input);
  }
  return memory.withRepository(repository => repository.transaction(() => {
    const database = repository.database;
    const updateSource = database.prepare('UPDATE source_records SET metadata_json=? WHERE id=? AND agent_id=?');
    const archiveInput = database.prepare("UPDATE memory_input_events SET status='archived' WHERE id=? AND agent_id=?");
    for (let index = 0; index < records.length; index++) {
      const record = records[index], original = originals[index];
      const inputs = inputsByEvent.get(record.event.source.eventId) || [];
      if (!inputs.length || inputs.map(input => input.content.text || '').join('') !== original.content) {
        throw Object.assign(new Error('Imported Memory evidence is incomplete.'), { code: 'MEMORY_IMPORT_SOURCE_INCOMPLETE' });
      }
      const metadata = { ...JSON.parse(original.metadata_json), inputEventIds: inputs.map(input => input.id) };
      updateSource.run(JSON.stringify(metadata), original.id, memory.agentId);
      for (const input of inputs) archiveInput.run(input.id, memory.agentId);
    }
    return { sources: records.length };
  }));
}
