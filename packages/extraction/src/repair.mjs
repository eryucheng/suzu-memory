import { LONG_TERM_EXTRACTION_SCHEMA, normalizeGeneratedLongTermExtraction, parseGeneratedLongTermExtraction } from './prompt.mjs';

const objectSchema = properties => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties) });
const candidateIndex = { type: 'integer', minimum: 0 };
const reason = { type: 'string', minLength: 1 };

export const LONG_TERM_EXTRACTION_REPAIR_SCHEMA = objectSchema({
  results: { type: 'array', items: { type: 'object', anyOf: [
    objectSchema({ candidateIndex, status: { type: 'string', enum: ['repaired'] },
      memories: { type: 'array', minItems: 1, items: LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items } }),
    ...['rejected', 'pending'].map(status => objectSchema({ candidateIndex,
      status: { type: 'string', enum: [status] }, reason })),
  ] } },
});

export function normalizeGeneratedExtractionRepair(output) {
  const parsed = typeof output === 'string' ? JSON.parse(output) : output;
  if (!parsed || !Array.isArray(parsed.results)) return parsed;
  return { ...parsed, results: parsed.results.map(result => result?.status === 'repaired'
    ? { ...result, memories: normalizeGeneratedLongTermExtraction({ memories: result.memories }).memories } : result) };
}

export function parseGeneratedExtractionRepair(output, context) {
  const parsed = normalizeGeneratedExtractionRepair(output);
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).join() !== 'results' || !Array.isArray(parsed.results)) {
    throw new Error('Extraction repair must contain only a results array.');
  }
  return { results: parsed.results.map(result => {
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
      const { memories } = parseGeneratedLongTermExtraction({ memories: result.memories }, context);
      if (!memories.length) throw new Error('A repaired candidate must contain a memory.');
      return { candidateIndex: result.candidateIndex, status: result.status, memories };
    }
    if (typeof result.reason !== 'string' || !result.reason.trim()) throw new Error('Extraction repair requires a reason.');
    return { candidateIndex: result.candidateIndex, status: result.status, reason: result.reason.trim() };
  }) };
}
