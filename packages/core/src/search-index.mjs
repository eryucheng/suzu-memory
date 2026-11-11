export function normalizedSearchDocument(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
}

export function withSearchTransaction(database, operation) {
  database.exec('SAVEPOINT memory_search_sync');
  try {
    const result = operation();
    database.exec('RELEASE memory_search_sync');
    return result;
  } catch (error) {
    database.exec('ROLLBACK TO memory_search_sync');
    database.exec('RELEASE memory_search_sync');
    throw error;
  }
}

export function memoryConceptLabels(database, agentId, memoryIds) {
  const labels = new Map();
  if (!memoryIds.length) return labels;
  const rows = database.prepare(`SELECT DISTINCT link.memory_id, entity.canonical_name, entity.aliases_json
    FROM memory_entities link JOIN entities entity ON entity.id = link.entity_id
    WHERE link.memory_id IN (SELECT value FROM json_each(?)) AND entity.agent_id = ? AND entity.kind = 'concept'
    ORDER BY link.memory_id, entity.canonical_name, entity.id`).all(JSON.stringify(memoryIds), agentId);
  for (const row of rows) {
    const names = labels.get(row.memory_id) || new Set();
    for (const name of [row.canonical_name, ...JSON.parse(row.aliases_json)]) names.add(name);
    labels.set(row.memory_id, names);
  }
  return labels;
}

// Names already present in the record are the same textual evidence, not
// another occurrence to reward. Keep missing names/aliases searchable.
export function conceptSearchText(text, labels = []) {
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase()
    .replace(/’/gu, "'").replace(/\s+/gu, ' ').trim();
  let document = normalize(text);
  const additions = [];
  for (const label of [...labels].sort((left, right) => right.length - left.length)) {
    const value = normalize(label);
    if (!value) continue;
    let index = document.indexOf(value), present = false;
    while (index >= 0) {
      const before = document[index - 1] || '', after = document[index + value.length] || '';
      if ((!/^[\p{Script=Latin}\p{N}_]/u.test(value) || !/[\p{Script=Latin}\p{N}_]/u.test(before))
        && (!/[\p{Script=Latin}\p{N}_]$/u.test(value) || !/[\p{Script=Latin}\p{N}_]/u.test(after))) {
        present = true; break;
      }
      index = document.indexOf(value, index + 1);
    }
    if (!present) { additions.push(label); document += `\n${value}`; }
  }
  return additions.join('\n');
}

export function backfillConceptSearchRows(database) {
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_fts'").get()) return;
  const memories = database.prepare(`SELECT DISTINCT node.id, node.agent_id FROM memory_entities link
    JOIN entities entity ON entity.id = link.entity_id AND entity.kind = 'concept'
    JOIN memory_nodes node ON node.id = link.memory_id`).all();
  const read = database.prepare(`SELECT fts.rowid, fts.title, fts.content, node.content AS original_content
    FROM memory_fts_rows search JOIN memory_fts fts ON fts.rowid=search.fts_rowid
    JOIN memory_nodes node ON node.id=search.memory_id WHERE search.memory_id=?`);
  const update = database.prepare('UPDATE memory_fts SET content=? WHERE rowid=?');
  const lexical = database.prepare('UPDATE memory_fts_rows SET lexical_text=? WHERE fts_rowid=?');
  const byAgent = new Map();
  for (const memory of memories) {
    const ids = byAgent.get(memory.agent_id) || [];
    ids.push(memory.id); byAgent.set(memory.agent_id, ids);
  }
  for (const [agentId, ids] of byAgent) for (let offset = 0; offset < ids.length; offset += 256) {
    const batch = ids.slice(offset, offset + 256), labelsById = memoryConceptLabels(database, agentId, batch);
    for (const id of batch) for (const row of read.all(id)) {
      const labels = labelsById.get(id);
      const extra = conceptSearchText(`${row.title}\n${row.content}`, labels);
      if (extra) update.run(`${row.content}\n${extra}`, row.rowid);
      const original = `${row.title}\n${row.original_content}`;
      lexical.run(normalizedSearchDocument(`${original}\n${conceptSearchText(original, labels)}`), row.rowid);
    }
  }
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
