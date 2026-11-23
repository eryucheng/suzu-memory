// Keep enough references to diagnose a rejected candidate without copying its
// prose or the source corpus into every checkpoint.
export function organizationRejection(error, { index, indices, candidate, inputVersion, generation }) {
  const fields = ['operation', 'kind', 'targetMemoryId', 'memberIds', 'relation', 'fromMemoryId', 'toMemoryId', 'evidenceSourceIds'];
  let truncated = false;
  const bounded = value => {
    if (Array.isArray(value)) { truncated ||= value.length > 100; return value.slice(0, 100).map(bounded); }
    const text = String(value ?? ''); truncated ||= text.length > 256; return text.slice(0, 256);
  };
  const references = Object.fromEntries(fields.filter(field => candidate?.[field] !== undefined)
    .map(field => [field, bounded(candidate[field])]));
  const category = error.category || 'execution-failure';
  return { index, ...(indices ? { indices } : {}), error: error.message, code: error.code || '', category,
    retryable: category !== 'invalid-candidate', candidate: references, ...(truncated ? { referencesTruncated: true } : {}),
    inputHash: inputVersion?.hash || '', requestId: generation?.requestId || '' };
}
