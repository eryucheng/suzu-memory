import { LONG_TERM_EXTRACTION_SCHEMA, parseGeneratedLongTermExtraction, parseExtractionEntities } from './prompt.mjs';

const objectSchema = properties => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties) });
const candidateIndex = { type: 'integer', minimum: 0 };
const reason = { type: 'string', minLength: 1 };

export const LONG_TERM_EXTRACTION_REPAIR_SCHEMA = { ...objectSchema({
  entities: LONG_TERM_EXTRACTION_SCHEMA.properties.entities,
  results: { type: 'array', items: { type: 'object', anyOf: [
    objectSchema({ candidateIndex, status: { type: 'string', enum: ['repaired'] },
      memories: { type: 'array', minItems: 1, items: LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items } }),
    ...['rejected', 'pending'].map(status => objectSchema({ candidateIndex,
      status: { type: 'string', enum: [status] }, reason })),
  ] } },
}), required: ['results'] };

export function parseGeneratedExtractionRepair(output, context) {
  const parsed = typeof output === 'string' ? JSON.parse(output) : output;
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).some(key => !['results', 'entities'].includes(key)) || !Array.isArray(parsed.results)) {
    throw new Error('Extraction repair requires a results array and optional entities.');
  }
  const entities = parseExtractionEntities(parsed.entities);
  return { ...(Object.hasOwn(parsed, 'entities') ? { entities } : {}), results: parsed.results.map(result => {
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
      const { memories } = parseGeneratedLongTermExtraction({ entities, memories: result.memories }, context);
      if (!memories.length) throw new Error('A repaired candidate must contain a memory.');
      return { candidateIndex: result.candidateIndex, status: result.status, memories };
    }
    if (typeof result.reason !== 'string' || !result.reason.trim()) throw new Error('Extraction repair requires a reason.');
    return { candidateIndex: result.candidateIndex, status: result.status, reason: result.reason.trim() };
  }) };
}
