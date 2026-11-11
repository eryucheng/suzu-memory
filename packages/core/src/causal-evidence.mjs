import { createHash } from 'node:crypto';

function uniqueOffset(content, anchor) {
  if (typeof anchor !== 'string' || !anchor.trim()) return -1;
  const start = content.indexOf(anchor);
  return start >= 0 && content.indexOf(anchor, start + 1) < 0 ? start : -1;
}

export function locateCausalExcerpt(content, { start, end } = {}) {
  if (typeof content !== 'string') return null;
  const first = uniqueOffset(content, start);
  const last = uniqueOffset(content, end);
  if (first < 0 || last < first + start.length) return null;
  const limit = last + end.length;
  if (limit - first >= content.length) return null;
  return { start: first, end: limit, contentHash: createHash('sha256').update(content).digest('hex') };
}

export function readCausalExcerpt(source) {
  const excerpt = source.metadata?.causalExcerpt;
  if (!excerpt || excerpt.contentHash !== source.content_hash || source.lifecycle !== 'active') return null;
  const { start, end } = excerpt;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end <= start || end > source.content.length || end - start >= source.content.length) return null;
  return { start, end };
}
