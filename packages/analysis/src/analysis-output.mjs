export function analysisCountLimit(value = Infinity, name = 'maximumAnalyses') {
  if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error(`${name} must be a non-negative safe integer or Infinity.`);
  }
  return value;
}

// A specialist emits at most one judgment per supplied memory. Its comparisons
// can reference the other supplied memories, independently of the batch size.
export function analysisSchemaForCount(schema, count, comparisonCount = count) {
  analysisCountLimit(count);
  analysisCountLimit(comparisonCount);
  if (!Number.isFinite(count) || !Number.isFinite(comparisonCount) || comparisonCount < count) {
    throw new Error("An analysis request requires finite input counts including all comparison memories.");
  }
  const analyses = schema.properties.analyses;
  const item = analyses.items;
  const properties = Object.fromEntries(Object.entries(item.properties).map(([key, value]) => [
    key, value === CLAIM_RELATIONS_SCHEMA ? { ...value, maxItems: Math.max(0, comparisonCount - 1) } : value,
  ]));
  return { ...schema, properties: { ...schema.properties,
    analyses: { ...analyses, maxItems: count, items: { ...item, properties } },
  } };
}

// Keep the envelope strict; callers may isolate malformed entries by opting in.
export function parseAnalysisItems(items, parseItem, onRejected) {
  const analyses = [];
  for (const [index, item] of items.entries()) {
    try { analyses.push(parseItem(item, index)); }
    catch (error) {
      if (typeof onRejected !== "function") throw error;
      onRejected({ index, memoryId: String(item?.memoryId ?? "").trim(), error: error.message });
    }
  }
  return analyses;
}

export const CLAIM_RELATIONS_SCHEMA = Object.freeze({ type: "array", items: {
  type: "object", additionalProperties: false, required: ["memoryId", "relation"], properties: {
    memoryId: { type: "string", minLength: 1 },
    relation: { type: "string", enum: ["equivalent", "complementary", "conflicting", "unrelated", "unknown"] },
  },
} });

export function parseClaimRelations(value, memoryId) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Claim relations must be an array.");
  const seen = new Set();
  return value.map(item => {
    const otherId = String(item?.memoryId ?? "").trim();
    const relation = String(item?.relation ?? "").trim();
    if (!otherId || otherId === memoryId || seen.has(otherId)
      || !CLAIM_RELATIONS_SCHEMA.items.properties.relation.enum.includes(relation)) {
      throw new Error("Claim relation references an invalid or repeated peer, or an unknown relation.");
    }
    seen.add(otherId);
    return { memoryId: otherId, relation };
  });
}
