import { DEFAULT_RETRIEVAL_OPTIONS, fitRecallRecords } from '@suzu-memory/retriever';

/** Each answer owns its searches, delivery positions and optional call limit. */
export const MEMORY_SEARCH_TOOL = Object.freeze({
  name: 'suzu_memory_search',
  description: '检索此前交流中的人物、事情或原话。结合当前对话，用姓名明确查询对象；证据不足时可改写查询，或用返回的记忆编号查关联。正文未完时，用相同查询继续读取。',
  parameters: {
    type: 'object', additionalProperties: false,
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 2000 },
      limit: { type: 'integer', minimum: 1, maximum: 10,
        description: '本次返回条数；省略时沿用当前检索配置。' },
      anchors: { type: 'array', maxItems: 3, items: { type: 'string' },
        description: '此前返回的记忆编号，如 m1。' },
    }, required: ['query'],
  },
});

const positive = (value, fallback, label) => {
  const number = Number(value ?? fallback);
  if (!Number.isSafeInteger(number) || number < 1) throw new RangeError(`${label} must be a positive integer.`);
  return number;
};

export function createMemorySearchSession({ memory, searchOptions = {}, maximumSearches = 6,
  signal: ownerSignal = searchOptions.signal,
  maximumContextMemories = searchOptions.options?.maximumContextMemories
    ?? memory?.defaults?.retrieval?.maximumContextMemories ?? DEFAULT_RETRIEVAL_OPTIONS.maximumContextMemories,
  maximumContextChars = searchOptions.options?.maximumContextChars
    ?? memory?.defaults?.retrieval?.maximumContextChars ?? DEFAULT_RETRIEVAL_OPTIONS.maximumContextChars,
} = {}) {
  if (typeof memory?.search !== 'function') throw new TypeError('memory.search is required.');
  const maximumCalls = maximumSearches === Infinity ? Infinity : positive(maximumSearches, 6, 'maximumSearches');
  const maximumRecords = positive(maximumContextMemories, DEFAULT_RETRIEVAL_OPTIONS.maximumContextMemories, 'maximumContextMemories');
  const maximumChars = positive(maximumContextChars, DEFAULT_RETRIEVAL_OPTIONS.maximumContextChars, 'maximumContextChars');
  const requests = new Map(), seen = new Set(), positions = new Map();
  const memoryIdsByReference = new Map(), referencesByMemoryId = new Map();
  let closedReason;
  const stats = { calls: 0, searches: 0, duplicateQueries: 0, duplicateRecords: 0,
    emittedRecords: 0, emittedChars: 0 };
  const remaining = () => ({ searches: Math.max(0, maximumCalls - stats.calls) });
  const notice = (status, value) => {
    const text = value.slice(0, maximumChars);
    stats.emittedChars += text.length;
    return { status, text, memoryIds: [], records: [], remaining: remaining() };
  };
  const invalid = message => Object.assign(new RangeError(message), { code: 'INVALID_MEMORY_QUERY' });
  const close = (reason = new DOMException('Memory search session closed.', 'AbortError')) => {
    if (closedReason) return;
    closedReason = reason;
    for (const request of requests.values()) request.controller.abort(reason);
    requests.clear(); seen.clear(); positions.clear(); memoryIdsByReference.clear(); referencesByMemoryId.clear();
    ownerSignal?.removeEventListener('abort', onOwnerAbort);
  };
  const onOwnerAbort = () => close(ownerSignal.reason);
  if (ownerSignal?.aborted) close(ownerSignal.reason);
  else ownerSignal?.addEventListener('abort', onOwnerAbort, { once: true });
  async function waitFor(request, signal) {
    request.users++;
    let onAbort;
    try {
      signal?.throwIfAborted();
      return await (signal ? Promise.race([request.promise, new Promise((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      })]) : request.promise);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
      if (--request.users === 0 && !request.settled) request.controller.abort(
        new DOMException('No callers remain for this search.', 'AbortError'));
    }
  }
  return {
    tool: MEMORY_SEARCH_TOOL,
    close,
    stats,
    limits: Object.freeze({ maximumSearches: maximumCalls, maximumContextMemories: maximumRecords, maximumContextChars: maximumChars }),
    remaining,
    async execute(args, { signal } = {}) {
      signal?.throwIfAborted();
      if (closedReason) throw closedReason;
      if (!args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some(key => !['query', 'limit', 'anchors'].includes(key))) {
        throw invalid('工具参数只接受 query、limit 和 anchors。');
      }
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 2000) throw invalid('query 应为 1—2000 字符。');
      if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10)) {
        throw invalid('limit 应为 1—10 的整数。');
      }
      const anchors = args.anchors ?? [];
      if (!Array.isArray(anchors) || anchors.length > 3 || anchors.some(id => typeof id !== 'string' || !id.trim())) {
        throw invalid('anchors 应为最多三个记忆编号。');
      }
      if (anchors.some(reference => !memoryIdsByReference.has(reference.trim()))) {
        throw invalid('anchors 只能使用本次回答已返回的记忆编号，例如 m1。');
      }
      if (stats.calls >= maximumCalls) {
        return notice('budget-exhausted', '本次检索次数已用完。');
      }
      stats.calls++;
      const limit = Math.min(args.limit ?? maximumRecords, maximumRecords);
      const normalizedAnchors = [...new Set(anchors.map(reference => memoryIdsByReference.get(reference.trim())))].sort();
      const excludedMemoryIds = [...new Set([
        ...(Array.isArray(searchOptions.options?.excludedMemoryIds) ? searchOptions.options.excludedMemoryIds : []), ...seen,
      ])].sort();
      const recordOffsets = Object.fromEntries(positions);
      const key = JSON.stringify([query.normalize('NFKC').replace(/\s+/gu, ' '), args.limit ?? null,
        normalizedAnchors, excludedMemoryIds, recordOffsets]);
      let pending = requests.get(key);
      if (pending?.controller.signal.aborted) { requests.delete(key); pending = null; }
      if (pending) stats.duplicateQueries++;
      else {
        stats.searches++;
        pending = { controller: new AbortController(), users: 0, settled: false };
        const request = pending;
        request.promise = Promise.resolve().then(() => memory.search(query, { ...searchOptions, anchors: normalizedAnchors,
          persistTrace: false, reactivate: false, signal: request.controller.signal,
          options: { ...searchOptions.options, maximumReturnedCandidates: limit,
            maximumContextMemories: limit, maximumContextChars: maximumChars, excludedMemoryIds, recordOffsets },
        })).then(result => { request.settled = true; return result; }, error => {
          request.settled = true;
          if (requests.get(key) === request) requests.delete(key);
          throw error;
        });
        requests.set(key, pending);
      }
      const result = await waitFor(pending, signal);
      signal?.throwIfAborted();
      if (closedReason) throw closedReason;
      const eligible = [], numbered = [], selectedIds = new Set();
      let newReferences = 0;
      for (const record of result.records || []) {
        if (seen.has(record.memoryId) || selectedIds.has(record.memoryId)) { stats.duplicateRecords++; continue; }
        if (eligible.length >= limit) break;
        const existingReference = referencesByMemoryId.get(record.memoryId);
        const reference = existingReference || `m${memoryIdsByReference.size + newReferences + 1}`;
        const label = `记忆编号：${record.memoryId}\n`;
        const body = record.text.startsWith(label) ? record.text.slice(label.length) : record.text;
        const offset = record.textOffset || 0;
        const position = positions.get(record.memoryId);
        const consumed = record.textVersion && record.textVersion !== position?.textVersion ? 0 : position?.offset || 0;
        const end = record.nextOffset ?? offset + body.length;
        if (consumed >= end && body.length) { stats.duplicateRecords++; continue; }
        const start = Math.max(offset, consumed);
        const available = body.slice(start - offset, end - offset);
        eligible.push(record); selectedIds.add(record.memoryId);
        if (!existingReference) newReferences++;
        numbered.push({ memoryId: reference, textVersion: record.textVersion, textOffset: start,
          sourceTextLength: record.sourceTextLength ?? end,
          text: `记忆编号：${reference}\n${available}` });
      }
      const guidance = !stats.emittedRecords && result.guidance ? result.guidance + '\n\n' : '';
      const prefix = guidance;
      const footer = Number.isFinite(maximumCalls) ? `\n剩余检索次数：${maximumCalls - stats.calls}。` : '';
      const fitted = fitRecallRecords(numbered, maximumChars - prefix.length - footer.length);
      const records = eligible.slice(0, fitted.records.length), memoryIds = records.map(record => record.memoryId);
      const text = prefix + fitted.text + footer;
      if (!records.length) {
        if ((result.records || []).some(record => !seen.has(record.memoryId))) {
          return notice(result.status, '匹配记录超出本次返回长度。');
        }
        return notice(result.status === 'ready' ? 'already-seen' : result.status,
          result.status === 'ready' ? '本次检索没有新增记录。' : '未找到匹配记录。');
      }
      for (const [index, id] of memoryIds.entries()) {
        const delivered = fitted.records[index];
        if (delivered.nextOffset == null) { seen.add(id); positions.delete(id); }
        else positions.set(id, { offset: delivered.nextOffset, textVersion: delivered.textVersion });
        memoryIdsByReference.set(delivered.memoryId, id);
        referencesByMemoryId.set(id, delivered.memoryId);
      }
      stats.emittedRecords += records.length;
      stats.emittedChars += text.length;
      return { status: result.status, text, memoryIds, records, result, remaining: remaining() };
    },
  };
}
