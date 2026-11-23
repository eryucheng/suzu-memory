import { assertEventSourceScope } from './event-source-state.mjs';
import { eventSourceEligible, eventSourceInputEligible } from './event-source-contract.mjs';
import { readStructureDependencies } from './structure-provenance.mjs';
import { reportedStateEvidenceAvailable } from './memory-input.mjs';

const parse = value => { try { return JSON.parse(value); } catch { return {}; } };

/** Resolve provenance from stored input -> source -> memory links. No text or
 * guessed session identifiers can establish eligibility. Mixed material needs
 * every source; independently supported memories keep their normal RAG routes. */
export function createEventSourceView(repository, value, agentId) {
  const scope = assertEventSourceScope(repository, value, agentId);
  const database = repository.database;
  const selectInputs = `SELECT id, event_type, actor_key, content_json, metadata_json
    FROM memory_input_events WHERE agent_id=? AND protocol_version=2 AND lifecycle='active'`;
  // Apply the indexed experience range before checking Event and observation eligibility.
  const inputRows = scope.version === 2
    ? database.prepare(`${selectInputs}
      AND json_extract(metadata_json,'$.eventSource.owner')=?
      AND json_extract(metadata_json,'$.eventSource.experienceRef.experienceSequence')>?
      AND json_extract(metadata_json,'$.eventSource.experienceRef.experienceSequence')<=?`)
      .all(agentId, scope.owner, scope.clearedThroughExperienceSequence, scope.experienceUpperBound)
    : database.prepare(selectInputs).all(agentId);
  const inputEvents = new Map();
  for (const row of inputRows) {
    const metadata = parse(row.metadata_json), { eventSource } = metadata;
    if (!eventSourceInputEligible({ ...row, protocol_version: 2, lifecycle: 'active', metadata }, scope)) continue;
    inputEvents.set(row.id, { source: eventSource, contentJson: row.content_json });
  }
  const sourceEvents = new Map();
  for (const row of database.prepare('SELECT * FROM source_records WHERE agent_id=?').all(agentId)) {
    const metadata = parse(row.metadata_json);
    const ids = metadata.inputEventIds;
    if (row.lifecycle !== 'active' || metadata.eventSourceErased || !Array.isArray(ids) || !ids.length) continue;
    const records = ids.map(id => inputEvents.get(id));
    if (records.some(input => !input)) continue;
    if (records.map(input => parse(input.contentJson).text || '').join('') !== row.content) continue;
    sourceEvents.set(row.id, records.map(input => input.source));
  }
  const memorySources = new Map();
  for (const row of database.prepare(`SELECT link.* FROM memory_sources link JOIN memory_nodes node
    ON node.id=link.memory_id WHERE node.agent_id=? AND ${reportedStateEvidenceAvailable('link')}`).all(agentId)) {
    if (!memorySources.has(row.memory_id)) memorySources.set(row.memory_id, []);
    memorySources.get(row.memory_id).push(row.source_id);
  }
  const provenance = new Map();
  const structures = readStructureDependencies(repository, agentId);
  const unavailable = new Set(database.prepare("SELECT id FROM memory_nodes WHERE agent_id=? AND status='deleted'").all(agentId).map(row => row.id));
  for (const [id, sources] of memorySources) {
    if (unavailable.has(id) || structures.get(id)?.material) continue;
    if (!sources.every(source => sourceEvents.has(source))) continue;
    const events = sources.flatMap(source => sourceEvents.get(source));
    provenance.set(id, [...new Map(events.map(event => [`${event.owner}:${event.eventId}`, event])).values()]);
  }
  // A summary is eligible only when its complete recorded material and current
  // typed membership are eligible. Unknown members, mixed scopes and cycles fail closed.
  for (let changed = true; changed;) {
    changed = false;
    for (const [id, structure] of structures) {
      if (provenance.has(id) || unavailable.has(id) || !structure.material?.memoryIds.length
        || !structure.dependencyIds.every(member => provenance.has(member))
        || !(memorySources.get(id) || []).every(source => sourceEvents.has(source))) continue;
      const events = [...structure.dependencyIds.flatMap(member => provenance.get(member)),
        ...(memorySources.get(id) || []).flatMap(source => sourceEvents.get(source))];
      provenance.set(id, [...new Map(events.map(event => [`${event.owner}:${event.eventId}`, event])).values()]);
      changed = true;
    }
  }
  // Regeneration reads current members, never the stale summary. It must remain
  // possible even when the old summary itself is no longer eligible for retrieval.
  const summaryMemoryIds = new Set([...structures].filter(([, item]) => item.memory.status === 'active'
    && item.memberIds.length && item.memberIds.every(id => provenance.has(id))).map(([id]) => id));
  const analysisMemories = new Map(), analysisSources = new Map();
  for (const { analysis_run_id: id, memory_id: memoryId } of database.prepare(
    'SELECT analysis_run_id,memory_id FROM memory_state_analysis_run_memories WHERE agent_id=?').all(agentId)) {
    if (!analysisMemories.has(id)) analysisMemories.set(id, []);
    analysisMemories.get(id).push(memoryId);
  }
  for (const { analysis_run_id: id, source_id: sourceId } of database.prepare(
    'SELECT analysis_run_id,source_id FROM memory_state_analysis_run_sources WHERE agent_id=?').all(agentId)) {
    if (!analysisSources.has(id)) analysisSources.set(id, []);
    analysisSources.get(id).push(sourceId);
  }
  const analysisRuns = new Set(database.prepare('SELECT id, state_family, analyzer_role, metadata_json FROM memory_state_analysis_runs WHERE agent_id=?').all(agentId)
    .filter(row => {
      const material = parse(row.metadata_json).eventSourceMaterial;
      if (material?.version === 1 && material.sourceScope?.agentId === agentId && row.state_family === 'preference'
        && ['object-grounding','explicit-expression','behavior-conditions','sharing-affect','time-scope'].includes(row.analyzer_role)) {
        const memories = analysisMemories.get(row.id) || [], sources = analysisSources.get(row.id) || [];
        return memories.length > 0 && sources.length > 0
          && memories.every(id => provenance.has(id)) && sources.every(id => sourceEvents.has(id));
      }
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
    observationIds, summaryMemoryIds,
    allows: node => Boolean(node && provenance.has(node.id) && !node.metadata?.eventSourceErased),
    sourcesFor: ids => [...new Map(ids.flatMap(id => provenance.get(id) || [])
      .map(source => [`${source.owner}:${source.eventId}`, source])).values()],
    sourcesForSourceIds: ids => [...new Map(ids.flatMap(id => sourceEvents.get(id) || [])
      .map(source => [`${source.owner}:${source.eventId}`, source])).values()],
    sourcesForInputIds: ids => [...new Map(ids.filter(id => inputEvents.has(id)).map(id => inputEvents.get(id).source)
      .map(source => [`${source.owner}:${source.eventId}`, source])).values()],
    assertCurrent: () => { repository.sourceEpoch.assert(); assertEventSourceScope(repository, scope, agentId); },
  };
}
