const entries = new Map();
const MAX_BYTES = 256 * 1024 * 1024;
let bytes = 0;

/** Cache canonical rows only. Callers still apply their current source view. */
export function cachedEmbeddingRows(database, key, read, { maximumBytes = MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 1024 * 1024 * 1024) {
    throw new RangeError('embeddingCacheMaxBytes must be an integer between 0 and 1073741824.');
  }
  // A caller may reduce the budget after this thread has already cached data.
  while (entries.size && bytes > maximumBytes) {
    const oldest = entries.keys().next().value;
    bytes -= entries.get(oldest).bytes; entries.delete(oldest);
  }
  const meta = database.prepare(`SELECT key,value FROM memory_meta
    WHERE key IN ('retrieval-database-id','retrieval-revision')`).all();
  const stamp = Object.fromEntries(meta.map(row => [row.key, row.value]));
  if (!stamp['retrieval-database-id'] || !stamp['retrieval-revision']) return read();
  const identity = `${stamp['retrieval-database-id']}:${key}`;
  const revision = stamp['retrieval-revision'];
  let entry = entries.get(identity);
  if (!entry || entry.revision !== revision) {
    if (entry) { bytes -= entry.bytes; entries.delete(identity); }
    const rows = read();
    const size = rows.reduce((sum, row) => sum + row.vector.byteLength + 512, 0);
    if (size > maximumBytes) return rows;
    while (entries.size && (bytes + size > maximumBytes || entries.size >= 16)) {
      const oldest = entries.keys().next().value;
      bytes -= entries.get(oldest).bytes; entries.delete(oldest);
    }
    entry = { revision, rows, bytes: size };
    entries.set(identity, entry); bytes += size;
  } else { entries.delete(identity); entries.set(identity, entry); }
  // Preserve the repository API's independent result values.
  return entry.rows.map(row => ({ ...row, vector: row.vector.slice() }));
}
