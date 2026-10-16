// Rebuild only the two widened input constraints. All existing columns,
// records, indices and foreign-key identities survive the v41 -> v42 upgrade.
export const EVENT_SOURCE_MIGRATION = Object.freeze({
  version: 42, name: 'event-source-contract-and-cleanup', foreignKeysOff: true,
  apply(database) {
    const original = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_input_events'").get().sql;
    const widened = original.replace(/protocol_version\s*=\s*1/u, 'protocol_version IN (1, 2)')
      .replace("actor_role IN ('user', 'companion')", "actor_role IN ('user', 'companion', 'other', 'system', 'world', 'unknown')")
      .replace('CHECK (event_type IN (', 'CHECK (protocol_version = 2 OR event_type IN (');
    if (widened === original || !widened.includes('protocol_version IN (1, 2)')) throw new Error('Unexpected input schema for Event source upgrade.');
    const indices = database.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='memory_input_events' AND sql IS NOT NULL").all();
    const replacement = widened.replace(/CREATE TABLE (?:IF NOT EXISTS )?["`]?memory_input_events["`]?/u, 'CREATE TABLE memory_input_events_v42');
    if (replacement === widened) throw new Error('Unable to create Event input replacement table.');
    database.exec(replacement);
    database.exec('INSERT INTO memory_input_events_v42 SELECT * FROM memory_input_events');
    database.exec('DROP TABLE memory_input_events');
    database.exec('ALTER TABLE memory_input_events_v42 RENAME TO memory_input_events');
    for (const index of indices) database.exec(index.sql);
    database.exec(`
      ALTER TABLE memory_embeddings ADD COLUMN source_memory_ids_json TEXT NOT NULL DEFAULT '[]';
      CREATE INDEX memory_input_events_product_source ON memory_input_events
        (agent_id, json_extract(metadata_json, '$.eventSource.owner'),
         json_extract(metadata_json, '$.eventSource.spaceId'), json_extract(metadata_json, '$.eventSource.commitSequence'));
      CREATE TABLE memory_event_source_scopes (
        agent_id TEXT NOT NULL, owner TEXT NOT NULL, clears_json TEXT NOT NULL DEFAULT '[]',
        consumed_through_sequence INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (agent_id, owner)
      ) STRICT;
      CREATE TABLE memory_event_source_cleanups (
        id TEXT NOT NULL, agent_id TEXT NOT NULL, owner TEXT NOT NULL, request_hash TEXT NOT NULL,
        scope_json TEXT NOT NULL, phase TEXT NOT NULL CHECK (phase IN ('fenced', 'database-cleaned', 'complete')),
        result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (id, agent_id)
      ) STRICT;
    `);
    for (const table of ['memory_input_events', 'source_records', 'memory_nodes']) {
      database.exec(`CREATE TRIGGER ${table}_erased_immutable BEFORE UPDATE ON ${table}
        WHEN json_extract(OLD.metadata_json,'$.eventSourceErased')=1
        BEGIN SELECT RAISE(ABORT,'EVENT_SOURCE_ERASED'); END;`);
    }
    for (const table of ['memory_embeddings', 'memory_retrieval_contexts', 'memory_sources']) {
      for (const operation of ['INSERT', 'UPDATE']) database.exec(`
        CREATE TRIGGER ${table}_erased_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
        WHEN EXISTS (SELECT 1 FROM memory_nodes WHERE id=NEW.memory_id AND json_extract(metadata_json,'$.eventSourceErased')=1)
        ${table === 'memory_sources' ? "OR EXISTS (SELECT 1 FROM source_records WHERE id=NEW.source_id AND json_extract(metadata_json,'$.eventSourceErased')=1)" : ''}
        BEGIN SELECT RAISE(ABORT,'EVENT_SOURCE_ERASED'); END;`);
    }
    for (const operation of ['INSERT', 'UPDATE']) database.exec(`
      CREATE TRIGGER memory_input_events_cleared_${operation.toLowerCase()} BEFORE ${operation} ON memory_input_events
      WHEN json_extract(NEW.metadata_json,'$.eventSourceErased') IS NOT 1 AND EXISTS (
        SELECT 1 FROM memory_event_source_scopes scope, json_each(scope.clears_json) cutoff
        WHERE scope.agent_id=NEW.agent_id AND scope.owner=json_extract(NEW.metadata_json,'$.eventSource.owner')
        AND json_extract(cutoff.value,'$.spaceId')=json_extract(NEW.metadata_json,'$.eventSource.spaceId')
        AND json_extract(NEW.metadata_json,'$.eventSource.commitSequence')<=json_extract(cutoff.value,'$.throughSequence'))
      BEGIN SELECT RAISE(ABORT,'EVENT_SOURCE_CLEARED'); END;`);
  },
});
