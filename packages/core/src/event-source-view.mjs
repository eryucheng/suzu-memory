import { assertEventSourceScope } from './event-source-state.mjs';
import { eventSourceEligible } from './event-source-contract.mjs';

const parse = value => { try { return JSON.parse(value); } catch { return {}; } };

/** Resolve provenance from stored input -> source -> memory links. No text or
 * guessed session identifiers can establish eligibility. Mixed material needs
 * every source; independently supported memories keep their normal RAG routes. */
export function createEventSourceView(repository, value, agentId) {
  const scope = assertEventSourceScope(repository, value, agentId);
  const database = repository.database;
  const inputs = new Map(database.prepare('SELECT * FROM memory_input_events WHERE agent_id=?').all(agentId)
    .map(row => [row.id, { ...row, metadata: parse(row.metadata_json) }]));
  const inputEvents = new Map([...inputs].filter(([, input]) => input.protocol_version === 2
    && input.lifecycle === 'active' && !input.metadata.eventSourceErased
    && input.metadata.eventSource?.eventType === input.event_type
    && input.metadata.eventSource?.sender?.id === input.actor_key
    && eventSourceEligible(input.metadata.eventSource, scope)).map(([id, input]) => [id, input.metadata.eventSource]));
  const sourceEvents = new Map();
  for (const row of database.prepare('SELECT * FROM source_records WHERE agent_id=?').all(agentId)) {
    const metadata = parse(row.metadata_json);
    const ids = metadata.inputEventIds;
    if (row.lifecycle !== 'active' || metadata.eventSourceErased || !Array.isArray(ids) || !ids.length) continue;
    const records = ids.map(id => inputs.get(id));
    if (records.some(input => !input || input.protocol_version !== 2 || input.lifecycle !== 'active' || input.metadata.eventSourceErased
      || input.metadata.eventSource?.eventType !== input.event_type || input.metadata.eventSource?.sender?.id !== input.actor_key
      || !eventSourceEligible(input.metadata.eventSource, scope))) continue;
    if (records.map(input => parse(input.content_json).text || '').join('') !== row.content) continue;
    sourceEvents.set(row.id, records.map(input => input.metadata.eventSource));
  }
  const memorySources = new Map();
  for (const row of database.prepare(`SELECT link.* FROM memory_sources link JOIN memory_nodes node
    ON node.id=link.memory_id WHERE node.agent_id=?`).all(agentId)) {
    if (!memorySources.has(row.memory_id)) memorySources.set(row.memory_id, []);
    memorySources.get(row.memory_id).push(row.source_id);
  }
  const provenance = new Map();
  for (const [id, sources] of memorySources) {
    if (!sources.every(source => sourceEvents.has(source))) continue;
    const events = sources.flatMap(source => sourceEvents.get(source));
    provenance.set(id, [...new Map(events.map(event => [`${event.owner}:${event.eventId}`, event])).values()]);
  }
  const analysisRuns = new Set(database.prepare('SELECT id, metadata_json FROM memory_state_analysis_runs WHERE agent_id=?').all(agentId)
    .filter(row => {
      const material = parse(row.metadata_json).eventSourceMaterial;
      return material?.version === 1 && material.sourceScope?.agentId === agentId
        && Array.isArray(material.memoryIds) && material.memoryIds.every(id => provenance.has(id))
        && Array.isArray(material.sourceIds) && material.sourceIds.every(id => sourceEvents.has(id))
        && Array.isArray(material.eventSources) && material.eventSources.every(source => eventSourceEligible(source, scope));
    }).map(row => row.id));
  const observationIds = new Set(database.prepare(`SELECT observation.id FROM memory_state_evidence_observations observation
    WHERE observation.agent_id=? AND observation.memory_id IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM memory_state_observation_sources link WHERE link.observation_id=observation.id
        AND link.source_id NOT IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (SELECT 1 FROM memory_state_observation_runs link WHERE link.observation_id=observation.id
        AND link.analysis_run_id NOT IN (SELECT value FROM json_each(?)))`).all(agentId,
    JSON.stringify([...provenance.keys()]), JSON.stringify([...sourceEvents.keys()]), JSON.stringify([...analysisRuns])).map(row => row.id));
  return { scope, memoryIds: new Set(provenance.keys()), sourceIds: new Set(sourceEvents.keys()), inputIds: new Set(inputEvents.keys()),
    observationIds,
    allows: node => Boolean(node && provenance.has(node.id) && !node.metadata?.eventSourceErased),
    sourcesFor: ids => [...new Map(ids.flatMap(id => provenance.get(id) || [])
      .map(source => [`${source.owner}:${source.eventId}`, source])).values()],
    sourcesForSourceIds: ids => [...new Map(ids.flatMap(id => sourceEvents.get(id) || [])
      .map(source => [`${source.owner}:${source.eventId}`, source])).values()],
    sourcesForInputIds: ids => [...new Map(ids.filter(id => inputEvents.has(id)).map(id => inputEvents.get(id))
      .map(source => [`${source.owner}:${source.eventId}`, source])).values()],
    assertCurrent: () => { repository.sourceEpoch.assert(); assertEventSourceScope(repository, scope, agentId); },
  };
}
