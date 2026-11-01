import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as analysis from '../src/index.mjs';
import { createRelatedAnalyzerBatch, invokeEvidenceAnalyzer, analyzerRunMetadata } from '../src/related-analyzer-batch.mjs';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';

const cases = [
  ['PREFERENCE_SPECIALIST_ANALYZERS', 'parsePreferenceSpecialistGeneration', {
    targetMatch: 'exact', matchedLabel: 'swimming',
  }],
  ['GOAL_ANALYZERS', 'parseGoalGeneration', {
    targetMatch: 'exact', goalText: 'finish the reading list', intentionLevel: 'plan', specificity: 'actionable', peerRelations: [],
  }],
  ['VALUE_ANALYZERS', 'parseValueGeneration', {
    targetMatch: 'exact', stance: 'protects', valueLabel: 'fairness', scopeLabel: '',
  }],
  ['CAPABILITY_ANALYZERS', 'parseCapabilityGeneration', {
    targetMatch: 'exact', skillLabel: 'swimming', scopeLabel: '', taskDifficulty: 'basic',
  }],
  ['SELF_CONCEPT_ANALYZERS', 'parseSelfConceptGeneration', {
    targetMatch: 'exact', conceptType: 'self_description', conceptLabel: 'curious', scopeLabel: '',
  }],
  ['IDENTITY_ANALYZERS', 'parseIdentityGeneration', {
    targetMatch: 'exact', identityField: 'occupation', valueText: 'teacher', statementPolarity: 'asserts', valueScope: '', valueRelations: [],
  }],
  ['BELIEF_ANALYZERS', 'parseBeliefGeneration', {
    targetMatch: 'exact', claimText: 'reading is useful', stance: 'asserts', claimKind: 'opinion', quantifier: 'general',
  }],
  ['RELATIONSHIP_ANALYZERS', 'parseRelationshipGeneration', {
    targetMatch: 'exact', relationType: 'support', polarity: 'affirms', relationLabel: 'mutual support', scopeLabel: '', conditionLabel: '',
  }],
  ['AFFECTIVE_ASSOCIATION_ANALYZERS', 'parseAffectiveAssociationGeneration', {
    targetMatch: 'exact', triggerType: 'place', triggerLabel: 'library', emotionLabel: 'calm', valence: 'positive', intensity: 'medium',
  }],
  ['BEHAVIOR_STATE_ANALYZERS', 'parseBehaviorStateGeneration', {
    targetMatch: 'exact', matchedLabel: 'available time', conditionPresence: 'present', conditionKind: 'time',
    effect: 'enables', temporality: 'current', evidenceBasis: 'explicit_self_report', scopeLabel: '', revisionCue: 'none',
  }],
].map(([name, parser, fields]) => ({ name, parse: analysis[parser], fields,
  definition: Object.values(analysis[name])[0] }));

const memories = count => Array.from({ length: count }, (_, index) => ({
  id: `memory-${index}`, sourceIds: [`source-${index}`], content: index % 2 ? 'I like swimming.' : '我喜欢游泳。',
}));
const item = (memory, fields) => ({ memoryId: memory.id, sourceIds: memory.sourceIds,
  confidence: 0.9, rationale: 'The supplied statement supports this judgment.', ...fields });
const promptDirectory = fileURLToPath(new URL('../resources/', import.meta.url));

for (const entry of cases) test(`${entry.name}: schema and parser accept complete batches above sixty and eighty`, () => {
  const { definition, parse, fields } = entry;
  const key = definition.stateFamily === 'condition' ? 'condition' : definition.role;
  for (const count of [61, 81]) {
    const output = { analyses: memories(count).map(memory => item(memory, fields)) };
    const relationField = Object.hasOwn(fields, 'peerRelations') ? 'peerRelations'
      : Object.hasOwn(fields, 'valueRelations') ? 'valueRelations' : '';
    if (relationField) output.analyses[0][relationField] = output.analyses.slice(1)
      .map(peer => ({ memoryId: peer.memoryId, relation: 'complementary' }));
    const schema = analysis.analysisSchemaForCount(definition.schema, count);
    const request = { schemaName: definition.schemaName, schema };
    assert.equal(parse(key, output).analyses.length, count);
    assert.equal(parse(key, output, { maximumAnalyses: count }).analyses.length, count);
    assert.equal(validateMemoryTaskOutput(request, output).analyses.length, count);
    assert.throws(() => validateMemoryTaskOutput(request, { analyses: [...output.analyses, output.analyses[0]] }),
      { code: 'MEMORY_TASK_SCHEMA_INVALID' });
    assert.throws(() => parse(key, output, { maximumAnalyses: count - 1 }), /more than/);
    const modified = structuredClone(schema);
    modified.properties.analyses.items.properties.confidence.maximum = 2;
    assert.throws(() => assertMemoryTaskRequest({ ...request, schema: modified }), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
    assert.equal(Object.hasOwn(definition.schema.properties.analyses, 'maxItems'), false);
  }
  assert.deepEqual(parse(key, { analyses: [] }, { maximumAnalyses: 0 }), { analyses: [] });
  assert.throws(() => parse(key, { analyses: [item(memories(1)[0], fields)] }, { maximumAnalyses: 0 }), /more than 0/);
  for (const value of [-1, 1.5, NaN, null, '60']) {
    assert.throws(() => parse(key, { analyses: [] }, { maximumAnalyses: value }), /maximumAnalyses/);
  }
});

function invocationOptions(snapshot, generator) {
  return { snapshot, generator, definition: analysis.PREFERENCE_SPECIALIST_ANALYZERS.objectGrounding,
    promptDirectory, buildInput: value => JSON.stringify(value), parseGeneration: analysis.parsePreferenceSpecialistGeneration,
    enforceBoundary: (_role, result, evidence) => {
      const memory = evidence.memories.find(memory => memory.id === result.memoryId);
      if (!memory || result.sourceIds.some(id => !memory.sourceIds.includes(id))) throw new Error('Outside supplied evidence.');
      return result;
    } };
}

test('a retry merges eighty accepted judgments with the remaining judgment and then reuses the complete result', async () => {
  const snapshot = { memories: memories(81), sourceRecords: memories(81).map(memory => ({ id: memory.sourceIds[0], content: memory.content })) };
  let calls = 0;
  const generator = async request => {
    calls += 1;
    assertMemoryTaskRequest(request);
    const input = JSON.parse(request.input);
    assert.equal(input.memories.length, calls === 1 ? 81 : 1);
    assert.equal(input.sourceRecords.length, input.memories.length);
    assert.equal(request.schema.properties.analyses.maxItems, input.memories.length);
    const output = { analyses: input.memories.map(memory => item(memory, cases[0].fields)) };
    if (calls === 1) output.analyses[80].sourceIds = ['not-a-supplied-source'];
    validateMemoryTaskOutput(request, output);
    return { output, model: 'fixture' };
  };
  const options = invocationOptions(snapshot, generator);
  const first = await invokeEvidenceAnalyzer(options);
  assert.equal(first.analyses.length, 80);
  assert.deepEqual(first.retryMemoryIds, ['memory-80']);
  const run = result => ({ id: `run-${calls}`, analyzer_role: first.definition.role, metadata: analyzerRunMetadata(result) });
  const second = await invokeEvidenceAnalyzer({ ...options, previousRuns: [run(first)] });
  assert.equal(second.analyses.length, 81, second.error);
  assert.deepEqual(second.retryMemoryIds, []);
  assert.equal(second.contractHash, first.contractHash);
  const third = await invokeEvidenceAnalyzer({ ...options, previousRuns: [run(second)] });
  assert.equal(third.analyses.length, 81, third.error);
  assert.equal(calls, 2);
  assert.equal(new Set(third.analyses.map(result => result.memoryId)).size, 81);
});

for (const name of ['GOAL_ANALYZERS', 'IDENTITY_ANALYZERS']) test(`${name}: one retry can still compare all eighty completed peers`, async () => {
  const entry = cases.find(entry => entry.name === name);
  const snapshot = { memories: memories(81), sourceRecords: [] };
  const relationField = name === 'GOAL_ANALYZERS' ? 'peerRelations' : 'valueRelations';
  let calls = 0;
  const options = { ...invocationOptions(snapshot, async request => {
    calls += 1;
    const supplied = JSON.parse(request.input);
    const output = { analyses: supplied.memories.map(memory => item(memory, entry.fields)) };
    if (calls === 1) output.analyses[80].sourceIds = ['not-a-supplied-source'];
    else {
      assert.equal(supplied.memories.length, 1);
      assert.equal(supplied.comparisonMemories.length, 80);
      assert.equal(request.schema.properties.analyses.maxItems, 1);
      assert.equal(request.schema.properties.analyses.items.properties[relationField].maxItems, 80);
      output.analyses[0][relationField] = supplied.comparisonMemories.map(memory => ({ memoryId: memory.memoryId, relation: 'complementary' }));
    }
    validateMemoryTaskOutput(request, output);
    return { output };
  }), definition: entry.definition, parseGeneration: entry.parse,
    prepareInputSnapshot: view => ({ ...view, comparisonMemories: snapshot.memories
      .filter(memory => !view.memories.some(selected => selected.id === memory.id))
      .map(memory => ({ memoryId: memory.id, content: memory.content })) }),
  };
  const first = await invokeEvidenceAnalyzer(options);
  assert.equal(first.analyses.length, 80, first.error);
  const second = await invokeEvidenceAnalyzer({ ...options, previousRuns: [{ id: 'accepted-eighty',
    analyzer_role: entry.definition.role, metadata: analyzerRunMetadata(first) }] });
  assert.equal(second.analyses.length, 81, second.error);
  assert.equal(second.analyses.find(item => item.memoryId === 'memory-80')[relationField].length, 80);
  assert.equal(calls, 2);
});

test('explicit analysis budgets reject before generation instead of truncating evidence or converting zero to a default', async () => {
  const snapshot = { memories: memories(81), sourceRecords: [] };
  let calls = 0;
  for (const maximumAnalyses of [0, 60, 80, -1, 0.5]) {
    const result = await invokeEvidenceAnalyzer({ ...invocationOptions(snapshot, async () => { calls += 1; }), maximumAnalyses });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /maximumAnalyses/);
    assert.equal(result.retryMemoryIds.length, 81);
  }
  assert.equal(calls, 0);
  assert.equal(snapshot.memories.length, 81);
});

test('combined specialists keep the actual input count and independently validate all results', async () => {
  const definitions = Object.fromEntries(Object.entries(analysis.PREFERENCE_SPECIALIST_ANALYZERS).slice(0, 2));
  const snapshot = { memories: memories(81), sourceRecords: [] };
  let calls = 0;
  const generator = Object.assign(async request => {
    calls += 1;
    assertMemoryTaskRequest(request);
    const output = { results: Object.fromEntries(request.combinedAnalyzerKeys.map(key => [key, {
      analyses: snapshot.memories.map(memory => item(memory, key === 'objectGrounding' ? cases[0].fields
        : { expressionType: 'likes', directness: 'explicit_self_statement' })),
    }])) };
    validateMemoryTaskOutput(request, output);
    for (const key of request.combinedAnalyzerKeys) assert.equal(request.schema.properties.results.properties[key].properties.analyses.maxItems, 81);
    return { output, model: 'fixture' };
  }, { supportsCombinedStateAnalysis: true });
  const batch = createRelatedAnalyzerBatch({ definitions, generator, request: { id: 'capacity', processorVersion: 'v1' } });
  const results = await Promise.all(Object.entries(definitions).map(([key, definition]) => invokeEvidenceAnalyzer({
    ...invocationOptions(snapshot, batch[key]), definition,
  })));
  assert.equal(calls, 1);
  results.forEach(result => assert.equal(result.analyses.length, 81, result.error));
});
