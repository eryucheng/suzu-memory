function mapReferences(value, fields, map, key = '') {
  if (Array.isArray(value)) return value.map(item => mapReferences(item, fields, map, key));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([name, item]) => [name, mapReferences(item, fields, map, name)]));
  return typeof value === 'string' && value && fields.has(key) ? map(value) : value;
}

/** Model requests can use local references while callers keep canonical IDs. */
export function withModelReferences(request, { material, fields, ids, renderInput = JSON.stringify }) {
  const literals = new Set(), visibleIds = new Set(ids);
  const collect = (value, key = '') => {
    if (typeof value === 'string') {
      literals.add(value);
      if (!ids && value && fields.has(key)) visibleIds.add(value);
    } else if (Array.isArray(value)) {
      value.forEach(item => collect(item, key));
    } else if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) collect(item, name);
    }
  };
  collect(material);
  const references = new Map(), originals = new Map();
  let sequence = 0;
  for (const id of visibleIds) {
    if (!id) continue;
    let reference;
    do { reference = `r${++sequence}`; } while (literals.has(reference));
    references.set(id, reference);
    originals.set(reference, id);
  }
  const encoded = mapReferences(material, fields, id => references.get(id) || id);
  return { ...request, modelInput: renderInput(encoded), decodeOutput: output => {
    // Let the owning task reject unknown IDs without losing valid siblings.
    const decoded = mapReferences(output, fields, id => originals.get(id) || id);
    return request.decodeModelOutput ? request.decodeModelOutput(decoded) : decoded;
  } };
}
