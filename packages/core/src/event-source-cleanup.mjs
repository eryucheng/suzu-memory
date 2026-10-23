import { eventSourceError } from './event-source-contract.mjs';
import { removeSearchRows } from './search-index.mjs';
import { getEventSourceCleanup, advanceEventSourceCleanup, advanceEventSourceEpoch } from './event-source-state.mjs';

const quote = value => `"${value.replaceAll('"', '""')}"`;
const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
// Compatibility with the already shipped Suzu Lives v1 receipt. It is useful
// only for erasure; retrieval requires the complete v2 source contract.
const inputSource = row => {
  const metadata = parse(row.metadata_json);
  if (metadata.eventSource) return metadata.eventSource;
  const legacy = metadata.suzuLives;
  if (metadata.host?.id !== 'suzu-lives-events' || legacy?.agentId !== row.agent_id) return null;
  return { version: 1, owner: metadata.host.id, recipientAgentId: row.agent_id, eventId: legacy.eventId,
    spaceId: legacy.spaceId, commitSequence: legacy.commitSequence };
};
const references = (value, ids) => typeof value === 'string' ? ids.has(value)
  : Array.isArray(value) ? value.some(item => references(item, ids))
  : value && typeof value === 'object' ? Object.values(value).some(item => references(item, ids)) : false;
const allRows = (database, table, agentId, columns) => database.prepare(`SELECT rowid AS _cleanup_rowid_, * FROM ${quote(table)}${
  columns.some(column => column.name === 'agent_id') ? ' WHERE agent_id=?' : ''}`)
  .all(...(columns.some(column => column.name === 'agent_id') ? [agentId] : []));

// SQL references use their declared FK target. JSON snapshots use the named
// references already written by repository/ingestion/retrieval contracts;
// arbitrary prose, provider request IDs and bare object IDs are not links.
function referenceTable(name, table, row) {
  const column = name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
    .replace(/_json$/, '').replace(/_ids$/, '_id');
  const foreignKey = table.foreignKeys.find(key => key.from === column);
  if (foreignKey) return foreignKey.table;
  if (column === 'batch_id' || column === 'extraction_batch_id') return 'memory_input_batches';
  if (column === 'input_event_id' || table.table === 'memory_input_batches' && column === 'event_id') return 'memory_input_events';
  if (/(^|_)memory_id$/.test(column) || ['member_id', 'seed_id', 'selected_id', 'candidate_id', 'trigger_id', 'node_id'].includes(column)) return 'memory_nodes';
  if (/(^|_)source_id$/.test(column)) return 'source_records';
  if (/(^|_)edge_id$/.test(column)) return 'memory_edges';
  if (/(^|_)trace_id$/.test(column)) return 'memory_retrieval_traces';
  if (column === 'feedback_id') return 'memory_retrieval_feedback';
  if (column === 'analysis_run_id') return 'memory_state_analysis_runs';
  if (column === 'structure_proposal_id') return 'memory_structure_proposals';
  if (column === 'relation_proposal_id') return 'memory_relation_proposals';
  if (column === 'state_evidence_observation_id') return 'memory_state_evidence_observations';
  if (table.table === 'memory_preference_state_proposals') {
    if (column === 'observation_id') return 'memory_state_evidence_observations';
    if (column === 'synthesis_run_id' || column === 'critic_run_id') return 'memory_state_analysis_runs';
  }
  if (column === 'target_id') {
    if (['memory', 'consolidation', 'context-utility'].includes(row.target_type)) return 'memory_nodes';
    if (['edge', 'relation-utility'].includes(row.target_type)) return 'memory_edges';
  }
  if (table.table === 'memory_reward_application_changes' && column === 'source_proposal_id') {
    return row.source_proposal_type === 'memory' ? 'memory_reward_credit_proposals' : 'memory_reward_path_credit_proposals';
  }
  if (['memory_consolidation_state', 'memory_context_utility_state', 'memory_reward_application_changes'].includes(table.table)
    && ['last_application_id', 'previous_application_id'].includes(column)) return 'memory_reward_applications';
  return '';
}

function structuredReference(value, name, table, row, dependentIds) {
  if (Array.isArray(value)) return value.some(item => structuredReference(item, name, table, row, dependentIds));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => structuredReference(item, key, table, row, dependentIds));
  }
  return typeof value === 'string' && Boolean(dependentIds.get(referenceTable(name, table, row))?.has(value));
}

/** Source dependencies are read from the existing input/source/memory links,
 * auxiliary FK records and their structured snapshots. Primary evidence never
 * inherits another source's deletion merely because they shared a batch. */
export function cleanEventSourceDatabase(repository, { agentId, id }) {
  const job = getEventSourceCleanup(repository, agentId, id);
  if (!job) throw eventSourceError('EVENT_SOURCE_CLEANUP_NOT_FOUND', 'Cleanup must first establish a durable source fence.');
  if (job.phase !== 'fenced') return job;
  const database = repository.database;
  return repository.transaction(() => {
    advanceEventSourceEpoch(repository);
    const inputRows = database.prepare('SELECT * FROM memory_input_events WHERE agent_id=?').all(agentId);
    const erasedInputs = inputRows.filter(row => {
      const source = inputSource(row);
      return !parse(row.metadata_json).eventSourceErased && source?.owner === job.owner && source.recipientAgentId === agentId
        && (job.scope.version===2 ? source.version===2 && source.agentGeneration===job.scope.agentGeneration
          && source.experienceRef?.experienceSequence<=job.scope.clearedThroughExperienceSequence
          : job.scope.clears.some(clear => clear.spaceId===source.spaceId && source.commitSequence<=clear.throughSequence));
    });
    const inputIds = new Set(erasedInputs.map(row => row.id));
    const sourceRows = database.prepare('SELECT * FROM source_records WHERE agent_id=?').all(agentId);
    const erasedSources = sourceRows.filter(row => references(parse(row.metadata_json).inputEventIds, inputIds));
    const sourceIds = new Set(erasedSources.map(row => row.id));
    const nodes = database.prepare('SELECT * FROM memory_nodes WHERE agent_id=?').all(agentId);
    const links = database.prepare('SELECT link.* FROM memory_sources link JOIN memory_nodes node ON node.id=link.memory_id WHERE node.agent_id=?').all(agentId);
    const memoryIds = new Set(links.filter(link => sourceIds.has(link.source_id)).map(link => link.memory_id));
    for (const node of nodes) if (references(parse(node.metadata_json).inputEventIds, inputIds)) memoryIds.add(node.id);
    // Source-less topic/episode material is derived from its members. A mixed
    // container cannot retain an unverifiable old summary; its clean members
    // keep their own source records and remain eligible to the same RAG.
    const edges = database.prepare('SELECT * FROM memory_edges WHERE agent_id=?').all(agentId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes) {
        if (memoryIds.has(node.id) || !['topic', 'episode'].includes(node.kind) || links.some(link => link.memory_id === node.id)) continue;
        if (edges.some(edge => edge.from_memory_id === node.id && memoryIds.has(edge.to_memory_id)
          || edge.to_memory_id === node.id && memoryIds.has(edge.from_memory_id))) { memoryIds.add(node.id); changed = true; }
      }
    }
    const dependentIds = new Map([
      ['memory_input_events', inputIds], ['source_records', sourceIds], ['memory_nodes', memoryIds],
      ['memory_input_batches', new Set(erasedInputs.map(row => row.batch_id).filter(Boolean))],
    ]);
    const dependants = table => {
      if (!dependentIds.has(table)) dependentIds.set(table, new Set());
      return dependentIds.get(table);
    };
    const primary = new Set(['memory_input_events', 'source_records', 'memory_nodes', 'entities', 'relationships', 'memory_meta',
      'memory_event_source_scopes', 'memory_event_source_cleanups', 'schema_migrations']);
    const auxiliary = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_fts%'")
      .all().map(row => row.name).filter(name => !primary.has(name)).map(table => {
        const columns = database.prepare(`PRAGMA table_info(${quote(table)})`).all();
        const foreignKeys = database.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all()
          .filter(key => key.from !== 'agent_id' && key.to === 'id');
        return { table, columns, foreignKeys, rows: allRows(database, table, agentId, columns), affected: new Set() };
      });
    // These identity links point at primary material without making it inherit
    // the entire batch/run. Auxiliary snapshots still lose their old bodies.
    const auxiliaryNames = new Set(auxiliary.map(item => item.table));
    for (const item of auxiliary) item.parents = item.foreignKeys.filter(key => auxiliaryNames.has(key.table));
    for (;;) {
      changed = false;
      for (const table of auxiliary) for (const row of table.rows) {
        if (table.affected.has(row._cleanup_rowid_)) continue;
        // A join row can discover this parent through its real FK even when
        // the parent body contains only prose and has no outgoing source IDs.
        const affected = dependants(table.table).has(row.id) || table.columns.some(column => {
          if (column.name === 'id' || column.name === 'agent_id') return false;
          const value = row[column.name];
          return column.name.endsWith('_json') ? structuredReference(parse(value, null), column.name, table, row, dependentIds)
            : column.name.endsWith('_id') && dependentIds.get(referenceTable(column.name, table, row))?.has(value);
        }) || table.table === 'memory_embeddings' && !parse(row.source_memory_ids_json, []).length
          && edges.some(edge => edge.relation === 'followed_by' && edge.weight >= 0.65
            && (edge.from_memory_id === row.memory_id && memoryIds.has(edge.to_memory_id)
              || edge.to_memory_id === row.memory_id && memoryIds.has(edge.from_memory_id)));
        if (affected) {
          table.affected.add(row._cleanup_rowid_);
          if (typeof row.id === 'string') dependants(table.table).add(row.id);
          // A run/proposal can hold the full source snapshot while only its join
          // rows reference evidence. Invalidate that snapshot and its dependants.
          for (const key of table.parents) if (typeof row[key.from] === 'string' && row[key.from]) dependants(key.table).add(row[key.from]);
          changed = true;
        }
      }
      if (!changed) break;
    }
    database.exec('PRAGMA defer_foreign_keys = ON');
    const counts = { inputs: erasedInputs.length, sources: erasedSources.length, memories: memoryIds.size, auxiliary: {} };
    const entities = new Set(database.prepare(`SELECT link.* FROM memory_entities link JOIN memory_nodes node
      ON node.id=link.memory_id WHERE node.agent_id=?`).all(agentId).filter(row => memoryIds.has(row.memory_id)).map(row => row.entity_id));
    // An unaffected input in the same interrupted batch must be claimable again.
    const batches = auxiliary.find(item => item.table === 'memory_input_batches');
    for (const row of batches?.rows || []) if (batches.affected.has(row._cleanup_rowid_)) {
      database.prepare(`UPDATE memory_input_events SET status='pending',batch_id='',last_error='',processing_disposition='pending'
        WHERE agent_id=? AND batch_id=? AND status='processing' AND lifecycle='active'
          AND id NOT IN (SELECT value FROM json_each(?))`).run(agentId, row.id, JSON.stringify([...inputIds]));
    }
    for (const table of auxiliary) {
      const remove = database.prepare(`DELETE FROM ${quote(table.table)} WHERE rowid=?`);
      for (const rowid of table.affected) remove.run(rowid);
      if (table.affected.size) counts.auxiliary[table.table] = table.affected.size;
    }
    for (const node of nodes.filter(node => memoryIds.has(node.id))) {
      database.prepare(`UPDATE memory_nodes SET title='',content='',canonical_key='',perspective='',subject_key='',
        status='deleted',metadata_json='{"eventSourceErased":true}',updated_at=? WHERE id=? AND agent_id=?`).run(new Date().toISOString(), node.id, agentId);
      removeSearchRows(database, node.id);
    }
    for (const row of erasedSources) {
      database.prepare(`UPDATE source_records SET source_locator='',speaker='',content='',lifecycle='retracted',
        metadata_json=?,invalidated_at=? WHERE id=? AND agent_id=?`).run(
        JSON.stringify({ eventSourceErased: true, inputEventIds: parse(row.metadata_json).inputEventIds }), new Date().toISOString(), row.id, agentId);
    }
    for (const row of erasedInputs) {
      const metadata = parse(row.metadata_json);
      const original = inputSource(row);
      const retained = { version: original.version, owner: original.owner, eventId: original.eventId,
        spaceId: original.spaceId, commitSequence: original.commitSequence, recipientAgentId: agentId };
      database.prepare(`UPDATE memory_input_events SET content_json='{}',source_json='{}',participants_json='[]',metadata_json=?,
        lifecycle='retracted',status='archived',processing_disposition='processed',last_error='',invalidated_at=? WHERE id=? AND agent_id=?`)
        .run(JSON.stringify({ eventSource: retained, eventSourceErased: true,
          ...(metadata.suzuMemoryFragment ? { suzuMemoryFragment: metadata.suzuMemoryFragment } : {}) }), new Date().toISOString(), row.id, agentId);
    }
    // Orphan entity aliases/metadata can contain source-derived names. Shared
    // entities retain their content while any untouched memory still uses them.
    for (const entityId of entities) {
      if (database.prepare('SELECT 1 FROM actor_entity_bindings WHERE entity_id=? LIMIT 1').get(entityId)) continue;
      const entity = database.prepare('SELECT * FROM entities WHERE id=? AND agent_id=?').get(entityId, agentId);
      const remaining = database.prepare(`SELECT source.content FROM memory_entities link JOIN memory_sources evidence
        ON evidence.memory_id=link.memory_id JOIN source_records source ON source.id=evidence.source_id
        WHERE link.entity_id=? AND source.lifecycle='active'`).all(entityId).map(row => row.content);
      const supported = name => remaining.some(content => content.includes(name));
      database.prepare("UPDATE entities SET canonical_name=?,aliases_json=?,metadata_json='{}' WHERE id=? AND agent_id=?")
        .run(supported(entity.canonical_name) ? entity.canonical_name : entity.id,
          JSON.stringify(parse(entity.aliases_json, []).filter(supported)), entityId, agentId);
    }
    if (database.prepare('PRAGMA foreign_key_check').all().length) throw eventSourceError('EVENT_SOURCE_CLEANUP_REFERENCES', 'Cleanup would leave dangling source dependencies.');
    return advanceEventSourceCleanup(repository, agentId, id, 'database-cleaned', counts);
  });
}
