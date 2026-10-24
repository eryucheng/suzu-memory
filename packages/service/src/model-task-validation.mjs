import { isDeepStrictEqual } from 'node:util';
import { LONG_TERM_EXTRACTION_SCHEMA, normalizeGeneratedLongTermExtraction, parseGeneratedLongTermExtraction } from '@suzu-memory/extraction';
import * as analysis from '@suzu-memory/analysis';
import { MEMORY_STRUCTURE_OUTPUT_SCHEMA, MEMORY_RELATION_OUTPUT_SCHEMA, MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA,
  parseStructureGeneration, parseRelationGeneration, parseSubjectAttributionGeneration } from '@suzu-memory/structurer';
import { MEMORY_RETRIEVAL_CONTEXT_PROPOSAL_SCHEMA, MEMORY_RETRIEVAL_CONTEXT_CRITIC_SCHEMA,
  parseMemoryRetrievalContextProposal, parseMemoryRetrievalContextCritique } from '@suzu-memory/embedding-indexer';

const tasks = new Map([
  ['memory-event-continuity-v1', [analysis.EVENT_CONTINUITY_SCHEMA, analysis.parseEventContinuity]],
  ['long-term-memory-extraction-v2', [LONG_TERM_EXTRACTION_SCHEMA, parseGeneratedLongTermExtraction]],
  ['long-term-memory-extraction-repair-v2', [LONG_TERM_EXTRACTION_SCHEMA, parseGeneratedLongTermExtraction]],
  ['memory-structure-proposals-v1', [MEMORY_STRUCTURE_OUTPUT_SCHEMA, parseStructureGeneration]],
  ['memory-relation-proposals-v1', [MEMORY_RELATION_OUTPUT_SCHEMA, parseRelationGeneration]],
  ['memory-subject-attribution-v1', [MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA, parseSubjectAttributionGeneration]],
  ['memory_retrieval_context_proposal_v1', [MEMORY_RETRIEVAL_CONTEXT_PROPOSAL_SCHEMA, parseMemoryRetrievalContextProposal]],
  ['memory_retrieval_context_critic_v1', [MEMORY_RETRIEVAL_CONTEXT_CRITIC_SCHEMA, parseMemoryRetrievalContextCritique]],
]);
const definitions = [
  ['PREFERENCE_SPECIALIST_ANALYZERS', 'parsePreferenceSpecialistGeneration'],
  ['GOAL_ANALYZERS', 'parseGoalGeneration'], ['VALUE_ANALYZERS', 'parseValueGeneration'],
  ['CAPABILITY_ANALYZERS', 'parseCapabilityGeneration'], ['SELF_CONCEPT_ANALYZERS', 'parseSelfConceptGeneration'],
  ['BEHAVIOR_STATE_ANALYZERS', 'parseBehaviorStateGeneration'], ['IDENTITY_ANALYZERS', 'parseIdentityGeneration'],
  ['BELIEF_ANALYZERS', 'parseBeliefGeneration'], ['RELATIONSHIP_ANALYZERS', 'parseRelationshipGeneration'],
  ['AFFECTIVE_ASSOCIATION_ANALYZERS', 'parseAffectiveAssociationGeneration'],
].flatMap(([name, parser]) => Object.entries(analysis[name]).map(([key, definition]) => ({ key, definition,
  parse: output => analysis[parser](name === 'BEHAVIOR_STATE_ANALYZERS' ? definition.stateFamily : definition.role, output) })));
for (const { definition, parse } of definitions) tasks.set(definition.schemaName, [definition.schema, parse]);
const invalid = message => Object.assign(new Error(message), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
const objectSchema = properties => ({ type: 'object', additionalProperties: false,
  required: Object.keys(properties), properties });

// Only the keywords used by the registered owner contracts are supported.
// This checks the declared wire shape before the existing domain parser (some
// legacy parsers normalize values); it never accepts an unregistered task.
function validateWireShape(schema, value, path = 'output') {
  const fail = () => { throw invalid(`Memory task output violates its declared schema at ${path}.`); };
  if (schema === false) fail();
  if (schema === true) return;
  if (schema.anyOf && !schema.anyOf.some(branch => {
    try { validateWireShape(branch, value, path); return true; }
    catch (error) { if (error.code === 'MEMORY_TASK_SCHEMA_INVALID') return false; throw error; }
  })) fail();
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (!types.includes(type) && !(types.includes('integer') && Number.isInteger(value))) fail();
  if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(item, value))) fail();
  if (type === 'object') {
    if ((schema.required || []).some(key => !Object.hasOwn(value, key))) fail();
    for (const [key, child] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) { if (schema.additionalProperties === false) fail(); }
      else validateWireShape(schema.properties[key], child, `${path}.${key}`);
    }
  } else if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail();
    if (schema.uniqueItems && value.some((item, index) => value.slice(0, index).some(prior => isDeepStrictEqual(prior, item)))) fail();
    value.forEach((item, index) => validateWireShape(schema.items, item, `${path}[${index}]`));
  } else if (type === 'string') {
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)
      || (schema.pattern && !new RegExp(schema.pattern, 'u').test(value))) fail();
  } else if (type === 'number') {
    if (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) fail();
  }
}

/** Dispatch only registered Memory task schemas to their existing domain parser.
 * Combined calls retain the exact child declarations and validate every child. */
function resolveTaskParser(request) {
  if (request?.schemaName === 'memory-state-match-analysis-v1') {
    const child = request.stateMatchAnalysisTask;
    if (!child || child.schemaName === request.schemaName || !isMemoryStateAnalysisRequest(child)) {
      throw invalid('State matching requires a registered specialist analysis.');
    }
    const parse = resolveTaskParser(child);
    if (!isDeepStrictEqual(request.schema, analysis.stateMatchAnalysisSchema(child.schema))) {
      throw invalid('State matching changed its result contract.');
    }
    return output => ({ stateMatch: output.stateMatch, analysis: parse(output.analysis) });
  }
  const task = tasks.get(request?.schemaName);
  if (task) {
    if (!isDeepStrictEqual(request.schema, task[0])) throw invalid('The Memory task schema changed without a version change.');
    return task[1];
  }
  if (request?.schemaName === 'memory-consolidation-combined-v1') {
    const schemas = { structure: MEMORY_STRUCTURE_OUTPUT_SCHEMA, relations: MEMORY_RELATION_OUTPUT_SCHEMA };
    if (!isDeepStrictEqual(request.schema, objectSchema(schemas))) {
      throw invalid('Combined consolidation requires exactly structure and relations.');
    }
    return output => ({ structure: parseStructureGeneration(output.structure), relations: parseRelationGeneration(output.relations) });
  }
  const combined = /^memory-([a-z_]+)-(evidence|comparison)-combined-v1$/u.exec(request?.schemaName || '');
  if (combined) {
    const keys = request.combinedAnalyzerKeys;
    if (!Array.isArray(keys) || keys.length < 2 || new Set(keys).size !== keys.length) throw invalid('Combined analysis requires distinct declared analyzer keys.');
    const selected = keys.map(key => definitions.find(item => item.key === key
      && (item.definition.stateFamily || 'state') === combined[1]
      && (['current-relation', 'time-current-relation'].includes(item.definition.role) ? 'comparison' : 'evidence') === combined[2]));
    if (selected.some(item => !item)) throw invalid('Combined analysis contains an unknown analyzer or phase.');
    const schemas = Object.fromEntries(selected.map(item => [item.key, item.definition.schema]));
    if (!isDeepStrictEqual(request.schema, objectSchema({ results: objectSchema(schemas) }))) throw invalid('Combined analysis changed its result contract.');
    return output => ({ results: Object.fromEntries(selected.map(item => [item.key, item.parse(output.results[item.key])])) });
  }
  throw invalid(`Unknown Memory task schema: ${request?.schemaName || '<missing>'}.`);
}

export function assertMemoryTaskRequest(request) { resolveTaskParser(request); }

export function isMemoryStateAnalysisRequest(request) {
  if (request?.schemaName === 'memory-state-match-analysis-v1') return true;
  if (definitions.some(({ definition }) => definition.schemaName === request?.schemaName)) return true;
  const combined = /^memory-([a-z_]+)-(evidence|comparison)-combined-v1$/u.exec(request?.schemaName || '');
  return Boolean(combined && definitions.some(({ definition }) => (definition.stateFamily || 'state') === combined[1]));
}

export function validateMemoryTaskOutput(request, output) {
  const parse = resolveTaskParser(request);
  if (parse === parseGeneratedLongTermExtraction) output = normalizeGeneratedLongTermExtraction(output);
  validateWireShape(request.schema, output);
  return parse(output);
}
