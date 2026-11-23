import { isDeepStrictEqual } from 'node:util';
import { LONG_TERM_EXTRACTION_SCHEMA, LONG_TERM_EXTRACTION_REPAIR_SCHEMA, parseGeneratedExtractionRepair,
  parseGeneratedLongTermExtraction } from '@suzu-memory/extraction';
import * as analysis from '@suzu-memory/analysis';
import { MEMORY_STRUCTURE_OUTPUT_SCHEMA, MEMORY_RELATION_OUTPUT_SCHEMA, MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA,
  MEMORY_STRUCTURE_SUMMARY_SCHEMA, MEMORY_STRUCTURE_MEMBERSHIP_SCHEMA, parseStructureSummary,
  parseStructureGeneration, parseRelationGeneration, parseSubjectAttributionGeneration, proposalSchemaForLimit,
  relationOutputSchema } from '@suzu-memory/structurer';
import { MEMORY_RETRIEVAL_CONTEXT_PROPOSAL_SCHEMA, MEMORY_RETRIEVAL_CONTEXT_CRITIC_SCHEMA,
  parseMemoryRetrievalContextProposal, parseMemoryRetrievalContextCritique } from '@suzu-memory/embedding-indexer';

const tasks = new Map([
  ['memory-event-continuity-v2', [analysis.EVENT_CONTINUITY_SCHEMA, analysis.parseEventContinuity]],
  ['long-term-memory-extraction-v4', [LONG_TERM_EXTRACTION_SCHEMA, parseGeneratedLongTermExtraction]],
  ['long-term-memory-extraction-repair-v5', [LONG_TERM_EXTRACTION_REPAIR_SCHEMA, parseGeneratedExtractionRepair]],
  ['memory-structure-proposals-v2', [MEMORY_STRUCTURE_OUTPUT_SCHEMA, parseStructureGeneration]],
  ['memory-structure-memberships-v1', [MEMORY_STRUCTURE_MEMBERSHIP_SCHEMA, parseStructureGeneration]],
  ['memory-structure-summary-v1', [MEMORY_STRUCTURE_SUMMARY_SCHEMA, parseStructureSummary]],
  ['memory-relation-proposals-v1', [relationOutputSchema(undefined, { version: 1 }), parseRelationGeneration]],
  ['memory-relation-proposals-v2', [MEMORY_RELATION_OUTPUT_SCHEMA, parseRelationGeneration]],
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

function declaredAnalysisSchema(definition, declared) {
  const count = declared?.properties?.analyses?.maxItems;
  let expected = definition.schema;
  if (count !== undefined) {
    const properties = definition.schema.properties.analyses.items.properties;
    const relationField = ['peerRelations', 'valueRelations'].find(key => Object.hasOwn(properties, key));
    const comparisonCount = relationField
      ? declared?.properties?.analyses?.items?.properties?.[relationField]?.maxItems + 1 : count;
    try { expected = analysis.analysisSchemaForCount(definition.schema, count, comparisonCount); }
    catch { throw invalid('A specialist request requires a finite non-negative input count.'); }
  }
  if (!isDeepStrictEqual(declared, expected)) throw invalid('Specialist analysis changed its result contract.');
  return expected;
}

function declaredProposalSchema(template, declared) {
  let expected;
  try { expected = proposalSchemaForLimit(template, declared?.properties?.proposals?.maxItems); }
  catch { throw invalid('A proposal request requires a finite non-negative budget.'); }
  if (!isDeepStrictEqual(declared, expected)) throw invalid('Proposal generation changed its result contract.');
  return expected;
}

function declaredRelationSchema(declared, version = 2) {
  const template = relationOutputSchema(MEMORY_RELATION_OUTPUT_SCHEMA.properties.proposals.maxItems,
    { excerpted: Object.hasOwn(declared?.properties || {}, 'needsFullEvidence'), version });
  return declaredProposalSchema(template, declared);
}

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
  if (schema.type !== undefined && !types.includes(type) && !(types.includes('integer') && Number.isInteger(value))) fail();
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
  if (request?.schemaName === 'memory-structure-summary-batch-v1') {
    const keys = Object.keys(request.schema?.properties || {});
    if (keys.length < 2 || keys.some(key => !/^group[1-9][0-9]*$/u.test(key))
      || !isDeepStrictEqual(request.schema, objectSchema(Object.fromEntries(keys.map(key => [key, MEMORY_STRUCTURE_SUMMARY_SCHEMA]))))) {
      throw invalid('A summary batch requires distinct groups with the registered summary contract.');
    }
    return output => Object.fromEntries(keys.map(key => [key, parseStructureSummary(output[key])]));
  }
  if (request?.schemaName === 'memory-state-first-stage-batch-v1') {
    const children = request.stateAnalysisTasks;
    const family = child => {
      if (child?.schemaName === 'memory-state-match-analysis-v1') return family(child.stateMatchAnalysisTask);
      const combined = /^memory-([a-z_]+)-evidence-combined-v1$/u.exec(child?.schemaName || '');
      if (combined) return combined[1] === 'state' ? 'preference' : combined[1];
      const entry = definitions.find(item => item.definition.schemaName === child?.schemaName);
      return entry && !['current-relation', 'time-current-relation'].includes(entry.definition.role)
        ? entry.definition.stateFamily || 'preference' : null;
    };
    if (!Array.isArray(children) || children.length < 2
      || children.some(child => !/^task[1-9][0-9]*$/u.test(child.key) || !child.stateAnalysisRequestId
        || !family(child) || child.stateFamily !== family(child))
      || ['key', 'stateAnalysisRequestId', 'stateFamily'].some(key => new Set(children.map(child => child[key])).size !== children.length)) {
      throw invalid('A first-stage batch requires distinct requests and families with registered evidence tasks.');
    }
    const parsers = children.map(child => resolveTaskParser(child));
    const schema = objectSchema({ results: objectSchema(Object.fromEntries(children.map(child => [child.key, child.schema]))) });
    if (!isDeepStrictEqual(request.schema, schema)) throw invalid('First-stage batching changed a child result contract.');
    return output => ({ results: Object.fromEntries(children.map((child, index) => [child.key, parsers[index](output.results[child.key])])) });
  }
  if (request?.schemaName === 'memory-state-match-analysis-v1') {
    const child = request.stateMatchAnalysisTask;
    if (!child || child.schemaName === request.schemaName || child.schemaName === 'memory-state-first-stage-batch-v1'
      || !isMemoryStateAnalysisRequest(child)) {
      throw invalid('State matching requires a registered specialist analysis.');
    }
    const parse = resolveTaskParser(child);
    if (!isDeepStrictEqual(request.schema, analysis.stateMatchAnalysisSchema(child.schema, {
      includePreferenceSupport: child.includePreferenceSupport === true,
    }))) {
      throw invalid('State matching changed its result contract.');
    }
    return output => ({ stateMatch: output.stateMatch, analysis: parse(output.analysis) });
  }
  const task = tasks.get(request?.schemaName);
  if (task) {
    if (task[1] === parseStructureGeneration || task[1] === parseRelationGeneration) {
      const schema = task[1] === parseRelationGeneration ? declaredRelationSchema(request.schema, request.schemaName.endsWith('-v1') ? 1 : 2)
        : declaredProposalSchema(task[0], request.schema);
      return output => task[1](output, { maximumProposals: schema.properties.proposals.maxItems });
    }
    const specialist = definitions.find(item => item.definition.schemaName === request.schemaName);
    if (specialist) declaredAnalysisSchema(specialist.definition, request.schema);
    else if (!isDeepStrictEqual(request.schema, task[0])) throw invalid('The Memory task schema changed without a version change.');
    return task[1];
  }
  if (['memory-consolidation-combined-v1', 'memory-organization-decisions-v1',
    'memory-consolidation-combined-v2', 'memory-organization-decisions-v2'].includes(request?.schemaName)) {
    const schemas = {
      structure: declaredProposalSchema(request.schemaName.startsWith('memory-organization-decisions-')
        ? MEMORY_STRUCTURE_MEMBERSHIP_SCHEMA : MEMORY_STRUCTURE_OUTPUT_SCHEMA, request.schema?.properties?.structure),
      relations: declaredRelationSchema(request.schema?.properties?.relations, request.schemaName.endsWith('-v1') ? 1 : 2),
    };
    if (!isDeepStrictEqual(request.schema, objectSchema(schemas))) {
      throw invalid('Combined consolidation requires exactly structure and relations.');
    }
    return output => ({
      structure: parseStructureGeneration(output.structure, { maximumProposals: schemas.structure.properties.proposals.maxItems }),
      relations: parseRelationGeneration(output.relations, { maximumProposals: schemas.relations.properties.proposals.maxItems }),
    });
  }
  const combined = /^memory-([a-z_]+)-(evidence|comparison)-combined-v1$/u.exec(request?.schemaName || '');
  if (combined) {
    const keys = request.combinedAnalyzerKeys;
    if (!Array.isArray(keys) || keys.length < 2 || new Set(keys).size !== keys.length) throw invalid('Combined analysis requires distinct declared analyzer keys.');
    const selected = keys.map(key => definitions.find(item => item.key === key
      && (item.definition.stateFamily || 'state') === combined[1]
      && (['current-relation', 'time-current-relation'].includes(item.definition.role) ? 'comparison' : 'evidence') === combined[2]));
    if (selected.some(item => !item)) throw invalid('Combined analysis contains an unknown analyzer or phase.');
    const schemas = Object.fromEntries(selected.map(item => [item.key,
      declaredAnalysisSchema(item.definition, request.schema?.properties?.results?.properties?.[item.key]),
    ]));
    if (!isDeepStrictEqual(request.schema, objectSchema({ results: objectSchema(schemas) }))) throw invalid('Combined analysis changed its result contract.');
    return output => ({ results: Object.fromEntries(selected.map(item => [item.key, item.parse(output.results[item.key])])) });
  }
  throw invalid(`Unknown Memory task schema: ${request?.schemaName || '<missing>'}.`);
}

export function assertMemoryTaskRequest(request) { resolveTaskParser(request); }

export function isMemoryStateAnalysisRequest(request) {
  if (request?.schemaName === 'memory-state-first-stage-batch-v1') return true;
  if (request?.schemaName === 'memory-state-match-analysis-v1') return true;
  if (definitions.some(({ definition }) => definition.schemaName === request?.schemaName)) return true;
  const combined = /^memory-([a-z_]+)-(evidence|comparison)-combined-v1$/u.exec(request?.schemaName || '');
  return Boolean(combined && definitions.some(({ definition }) => (definition.stateFamily || 'state') === combined[1]));
}

export function validateMemoryTaskOutput(request, output) {
  const parse = resolveTaskParser(request);
  validateWireShape(request.schema, output);
  return parse(output);
}
