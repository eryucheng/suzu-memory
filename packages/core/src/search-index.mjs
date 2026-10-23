export function normalizedSearchDocument(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

export function backfillSearchRows(database) {
  const table = database.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_fts'").get();
  if (!table) return;
  const insert = database.prepare(`INSERT OR REPLACE INTO memory_fts_rows(fts_rowid,memory_id,agent_id,lexical_text)
    VALUES(?,?,?,?)`);
  for (const row of database.prepare(`SELECT fts.rowid,fts.memory_id,node.agent_id,node.title,node.content
    FROM memory_fts fts JOIN memory_nodes node ON node.id=fts.memory_id`).all()) {
    insert.run(row.rowid, row.memory_id, row.agent_id, normalizedSearchDocument(`${row.title}\n${row.content}`));
  }
}

export function removeSearchRows(database, memoryId) {
  // Old caller-created databases without migrations keep the established path.
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_fts_rows'").get()) {
    database.prepare('DELETE FROM memory_fts WHERE memory_id=?').run(memoryId);
    return;
  }
  const rows = database.prepare('SELECT fts_rowid FROM memory_fts_rows WHERE memory_id=?').all(memoryId);
  const remove = database.prepare('DELETE FROM memory_fts WHERE rowid=?');
  for (const row of rows) remove.run(row.fts_rowid);
  database.prepare('DELETE FROM memory_fts_rows WHERE memory_id=?').run(memoryId);
}
