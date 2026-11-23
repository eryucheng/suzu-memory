import { withModelReferences } from '@suzu-memory/core';

export const stateReferenceFields = new Set(['id', 'memoryId', 'sourceIds', 'episodeIds', 'candidateId',
  'contentSourceId', 'supportingMemoryIds']);

function modelStateTarget(value) {
  if (!value) return value;
  const { canonicalKey, ...material } = value;
  return material;
}

// Canonical snapshots remain complete for provenance, replay and validation.
// The model receives evidence and references. The full snapshot retains
// bookkeeping and provenance.
export function projectStateModelInput(snapshot, { matchState = false } = {}) {
  const { stateCandidates, omitted, ...material } = snapshot;
  const sources = new Map((snapshot.sourceRecords || []).map(source => [source.id, source]));
  const memories = (snapshot.memories || []).map(({ sourcesTruncated, ...memory }) => {
    const sourceId = (memory.sourceIds || []).find(id => typeof memory.content === 'string'
      && sources.get(id)?.content === memory.content);
    if (!sourceId) return memory;
    const { content, ...view } = memory;
    return { ...view, contentSourceId: sourceId };
  });
  return {
    ...material,
    target: modelStateTarget(snapshot.target),
    currentState: modelStateTarget(snapshot.currentState),
    memories,
    ...(matchState ? { stateCandidates: (stateCandidates || []).map(modelStateTarget) } : {}),
  };
}

function matchingSchema(schema, { stateCandidates, memories }) {
  const candidateIds = [...new Set(stateCandidates.map(candidate => candidate.id))];
  const support = schema.properties.supportingMemoryIds;
  const memoryIds = support ? [...new Set(memories.map(memory => memory.id))] : [];
  const branch = (resolutions, ids, allowedSupport = []) => {
    const properties = {
      ...schema.properties,
      resolution: { ...schema.properties.resolution, enum: resolutions },
      candidateId: { type: 'string', enum: ids },
    };
    if (support) properties.supportingMemoryIds = allowedSupport.length
      ? { ...support, maxItems: allowedSupport.length, items: { ...support.items, enum: allowedSupport } }
      : { ...support, maxItems: 0 };
    return { ...schema, properties, required: Object.keys(properties) };
  };
  return { anyOf: [
    ...(candidateIds.length ? [branch(['matched'], candidateIds, memoryIds)] : []),
    branch(['new', 'ambiguous'], ['']),
  ] };
}

export function stateModelSchema(request, encoded) {
  const schema = request.schemaName !== 'memory-state-match-analysis-v1' ? request.schema
    : { ...request.schema, properties: { ...request.schema.properties,
    stateMatch: matchingSchema(request.schema.properties.stateMatch, encoded),
  } };
  return compactContract(schema).schema;
}

const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const PACKING_INSTRUCTIONS = '同一 memoryId 的专科判断集中写入一项 analyses：公共 sourceIds 和 rationale 只写一次，各专科的字段与独立 confidence 写入 judgments 对应项。某专科仅引用公共证据的一部分或其他允许的证据时，填写该项 sourceIds；否则填 null 继承公共证据。note 只补充该专科特有的依据，没有补充时为空字符串。仅在该专科确无相关证据时将其判断写为 null，不用其他专科的结论补齐证据。';

function compactContract(schema) {
  if (schema.properties?.analysis) {
    const child = compactContract(schema.properties.analysis);
    return { schema: { ...schema, properties: { ...schema.properties, analysis: child.schema } }, compact: child.compact,
      decode: output => output && Object.hasOwn(output, 'analysis') ? { ...output, analysis: child.decode(output.analysis) } : output };
  }
  const roles = Object.entries(schema.properties?.results?.properties || {});
  if (roles.length < 2 || roles.some(([, result]) => !result.properties?.analyses?.items)) {
    return { schema, compact: false, decode: output => output };
  }
  const common = roles[0][1].properties.analyses.items.properties;
  const judgments = Object.fromEntries(roles.map(([key, result]) => {
    const properties = result.properties.analyses.items.properties;
    const fields = Object.fromEntries(Object.entries(properties).filter(([field]) => !['memoryId','sourceIds','rationale'].includes(field)));
    return [key, { anyOf: [{ type: 'null' }, object({ ...fields,
      sourceIds: { anyOf: [{ type: 'null' }, properties.sourceIds] }, note: { type: 'string' } })] }];
  }));
  const count = Math.max(...roles.map(([, result]) => result.properties.analyses.maxItems ?? Infinity));
  return { compact: true, schema: object({ analyses: { type: 'array',
    ...(Number.isFinite(count) ? { maxItems: count } : {}),
    items: object({ memoryId: common.memoryId, sourceIds: common.sourceIds, rationale: common.rationale,
      judgments: object(judgments) }) } }),
  decode(output) {
    // Canonical outputs from an injected application generator are already in
    // the public contract. Only the provider-facing representation is packed.
    if (output?.results && !Object.hasOwn(output, 'analyses')) return output;
    if (!output || !Array.isArray(output.analyses)) return output;
    return { results: Object.fromEntries(roles.map(([key]) => [key, { analyses: output.analyses.flatMap(row => {
      const judgment = row?.judgments?.[key];
      if (judgment === null) return [];
      const { note, sourceIds, ...fields } = judgment && typeof judgment === 'object' && !Array.isArray(judgment) ? judgment : {};
      return [{ ...fields, memoryId: row?.memoryId, sourceIds: sourceIds === null ? row?.sourceIds : sourceIds,
        rationale: note ? `${row?.rationale || ''}\n${note}`.trim() : row?.rationale }];
    }) }])) };
  } };
}

export function decodeStateModelOutput(request, output) { return compactContract(request.schema).decode(output); }

export function stateModelRequest(request, snapshot) {
  const material = projectStateModelInput(snapshot, { matchState: request.schemaName === 'memory-state-match-analysis-v1' });
  const contract = compactContract(request.schema);
  const referenced = withModelReferences({ ...request,
    systemPrompt: contract.compact ? `${request.systemPrompt}\n\n${PACKING_INSTRUCTIONS}` : request.systemPrompt,
    decodeModelOutput: contract.decode }, { material, fields: stateReferenceFields });
  return { ...referenced, modelSchema: stateModelSchema(request, JSON.parse(referenced.modelInput)) };
}
