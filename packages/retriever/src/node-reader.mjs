const parse = value => { try { return JSON.parse(value); } catch { return {}; } };
const ELIGIBILITY_FIELDS = new Set(['id', 'agent_id', 'status', 'kind', 'layer', 'subject_role', 'subject_key',
  'state_family', 'canonical_key', 'state_phase', 'temporal_state', 'world_id', 'world_frame',
  'known_at', 'recorded_at', 'event_date', 'event_start', 'valid_from', 'valid_to', 'importance', 'confidence', 'metadata_json']);

/** Keep eligibility fields available for every node. Read bodies only when a
 * route admits them, or a later completion actually needs their text. */
export function createNodeReader(database, agentId, options = {}) {
  const threshold = Math.max(1, Math.trunc(options.sqlPrefilterThreshold ?? 1000));
  const deferred = options.deferNodeBodies !== false && options.sqlPrefilter !== false
    && Boolean(database.prepare(`SELECT 1 FROM memory_nodes WHERE agent_id=?
      AND status IN ('active','superseded','disputed') LIMIT 1 OFFSET ?`).get(agentId, threshold - 1));
  const allColumns = deferred ? database.prepare('PRAGMA table_info(memory_nodes)').all().map(row => row.name) : null;
  const columns = allColumns?.filter(name => ELIGIBILITY_FIELDS.has(name));
  const nodes = new Map();
  const bodies = new Map();
  const stats = { deferred, metadataRows: 0, bodyRows: 0, bodyQueries: 0 };
  const bodyQuery = deferred ? database.prepare('SELECT * FROM memory_nodes WHERE agent_id=? AND id=?') : null;
  function store(row) {
    bodies.set(row.id, row);
    const node = nodes.get(row.id);
    if (node) for (const [key, value] of Object.entries(row)) Object.defineProperty(node, key, {
      value, enumerable: true, writable: true, configurable: true,
    });
  }
  function body(id) {
    if (!bodies.has(id)) {
      const row = bodyQuery.get(agentId, id);
      stats.bodyQueries++; stats.bodyRows += row ? 1 : 0;
      if (row) store(row);
      else bodies.set(id, { title: '', content: '' });
    }
    return bodies.get(id);
  }
  const lazyPrototype = Object.create(null);
  for (const field of allColumns || []) if (!ELIGIBILITY_FIELDS.has(field)) Object.defineProperty(lazyPrototype, field, {
    get() { return body(this.id)[field]; },
  });
  return { stats,
    load(statuses) {
      if (!statuses.length) return [];
      const fields = columns ? columns.map(name => `"${name.replaceAll('"', '""')}"`).join(',') : '*';
      return database.prepare(`SELECT ${fields} FROM memory_nodes
        WHERE agent_id=? AND status IN (${statuses.map(() => '?').join(',')}) ORDER BY recorded_at DESC`)
        .all(agentId, ...statuses).map(row => {
          stats.metadataRows++;
          if (!deferred) stats.bodyRows++;
          const node = row;
          node.confidence = Number(row.confidence); node.importance = Number(row.importance);
          node.metadata = parse(row.metadata_json);
          if (deferred) Object.setPrototypeOf(node, lazyPrototype);
          nodes.set(row.id, node);
          return node;
        });
    },
    hydrate(candidates) {
      if (!deferred) return;
      const ids = [...new Set(candidates.map(node => node.id))].filter(id => nodes.has(id) && !bodies.has(id));
      if (!ids.length) return;
      const rows = database.prepare(`SELECT * FROM memory_nodes WHERE agent_id=?
        AND id IN (SELECT value FROM json_each(?))`).all(agentId, JSON.stringify(ids));
      stats.bodyQueries++; stats.bodyRows += rows.length;
      for (const row of rows) store(row);
    },
  };
}
