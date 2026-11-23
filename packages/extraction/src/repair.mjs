import { LONG_TERM_EXTRACTION_SCHEMA, LONG_TERM_EXTRACTION_MODEL_SCHEMA, parseGeneratedLongTermExtraction, parseExtractionEntities } from './prompt.mjs';

const objectSchema = properties => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties) });
const candidateIndex = { type: 'integer', minimum: 0 };
const reason = { type: 'string', minLength: 1 };

function extractionRepairSchema(extractionSchema, { acceptSavedTimeEvidence = false } = {}) {
  const { entities, memories } = extractionSchema.properties;
  const timeEvidence = { ...objectSchema({
    sourceRef: { type: 'string', pattern: '^M[0-9]{4}$' },
    quote: { type: 'string', minLength: 1, description: '从该条原话逐字引用，同时保留本事件和对应的时间说法。' },
  }), type: ['object', 'null'], description: '修复事件日期归属时填写，引用须在本条 sourceRefs 中。其他情况为 null。' };
  const repairedMemory = acceptSavedTimeEvidence
    ? { ...memories.items, properties: { ...memories.items.properties, timeEvidence } }
    : memories.items;
  return { ...objectSchema({
    entities,
    results: { type: 'array', items: { type: 'object', anyOf: [
      objectSchema({ candidateIndex, status: { type: 'string', enum: ['repaired'] },
        memories: { type: 'array', minItems: 1, items: repairedMemory } }),
      ...['rejected', 'pending'].map(status => objectSchema({ candidateIndex,
        status: { type: 'string', enum: [status] }, reason })),
    ] } },
  }), required: ['results'] };
}

export const LONG_TERM_EXTRACTION_REPAIR_SCHEMA = extractionRepairSchema(LONG_TERM_EXTRACTION_SCHEMA, { acceptSavedTimeEvidence: true });
export const LONG_TERM_EXTRACTION_REPAIR_MODEL_SCHEMA = extractionRepairSchema(LONG_TERM_EXTRACTION_MODEL_SCHEMA);

// Validate ownership and the response envelope before replacing a repair draft.
// Memory fields and entity references are validated against their own context.
export function parseExtractionRepairResultEnvelope(result) {
  if (!result || Array.isArray(result) || !Number.isInteger(result.candidateIndex) || result.candidateIndex < 0) {
    throw new Error('Extraction repair requires a non-negative candidateIndex.');
  }
  const repaired = result.status === 'repaired';
  const keys = repaired ? ['candidateIndex', 'memories', 'status'] : ['candidateIndex', 'reason', 'status'];
  if (Object.keys(result).sort().join() !== keys.join()
    || !['repaired', 'rejected', 'pending'].includes(result.status)) {
    throw new Error('Extraction repair result fields do not match its status.');
  }
  if (repaired) {
    if (!Array.isArray(result.memories) || !result.memories.length
      || result.memories.some(memory => !memory || typeof memory !== 'object' || Array.isArray(memory))) {
      throw new Error('A repaired candidate must contain a non-empty array of memory objects.');
    }
    return result;
  }
  if (typeof result.reason !== 'string' || !result.reason.trim()) throw new Error('Extraction repair requires a reason.');
  return { ...result, reason: result.reason.trim() };
}

export function parseGeneratedExtractionRepair(output, context) {
  const parsed = typeof output === 'string' ? JSON.parse(output) : output;
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).some(key => !['results', 'entities'].includes(key)) || !Array.isArray(parsed.results)) {
    throw new Error('Extraction repair requires a results array and optional entities.');
  }
  const entities = parseExtractionEntities(parsed.entities);
  return { ...(Object.hasOwn(parsed, 'entities') ? { entities } : {}), results: parsed.results.map(result => {
    const envelope = parseExtractionRepairResultEnvelope(result);
    if (envelope.status !== 'repaired') return envelope;
    const { memories } = parseGeneratedLongTermExtraction({ entities, memories: envelope.memories }, { ...context, allowTimeEvidence: true });
    return { ...envelope, memories };
  }) };
}
