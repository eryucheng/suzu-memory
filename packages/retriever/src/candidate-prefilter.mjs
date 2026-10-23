/** Exhaustive superset: never truncate by rank or assume an FTS tokenizer. */
export function prefilterCandidateIds(database, agentId, prepared, routes, options, count) {
  if (options.sqlPrefilter === false || count < (options.sqlPrefilterThreshold ?? 1000)) return null;
  if (!database.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_fts_rows'").get()) return null;
  const terms = [...new Set([...prepared.queryTerms, prepared.normalizedQuery].filter(Boolean))];
  if (terms.length > 512) return null;
  const rows = database.prepare(`SELECT node.id FROM memory_nodes node
    LEFT JOIN memory_fts_rows search ON search.memory_id=node.id
    WHERE node.agent_id=? AND node.status IN ('active','superseded','disputed') AND (
      search.memory_id IS NULL OR search.lexical_text IS NULL OR EXISTS (
        SELECT 1 FROM json_each(?) term WHERE instr(COALESCE(node.event_date,'')||search.lexical_text,term.value)>0
      )
    )`).all(agentId, JSON.stringify(terms));
  const ids = new Set(rows.map(row => row.id));
  for (const [id] of routes.bm25Scores || []) ids.add(id);
  for (const [id, score] of routes.entityScores || []) if (score > 0) ids.add(id);
  const minimum = Math.min(Number(options.minimumVectorSimilarity), Number(options.strongVectorSimilarity));
  for (const [id, score] of routes.vectorScores || []) if (!Number.isFinite(minimum) || score >= minimum) ids.add(id);
  return ids;
}
