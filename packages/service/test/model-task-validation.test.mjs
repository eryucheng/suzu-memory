import assert from 'node:assert/strict';
import test from 'node:test';
import * as analysis from '@suzu-memory/analysis';
import { createRelatedAnalyzerBatch } from '../../analysis/src/related-analyzer-batch.mjs';
import { LONG_TERM_EXTRACTION_SCHEMA, LONG_TERM_EXTRACTION_REPAIR_SCHEMA, parseGeneratedLongTermExtraction } from '@suzu-memory/extraction';
import { MEMORY_STRUCTURE_OUTPUT_SCHEMA, MEMORY_RELATION_OUTPUT_SCHEMA, MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA } from '@suzu-memory/structurer';
import { MEMORY_RETRIEVAL_CONTEXT_PROPOSAL_SCHEMA, MEMORY_RETRIEVAL_CONTEXT_CRITIC_SCHEMA } from '@suzu-memory/embedding-indexer';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '../src/index.mjs';
import { createOpenAiCompatibleStructuredGenerator } from '../../providers/src/index.mjs';

test('extraction target branches expose only their family fields and reject cross-family objects', async () => {
  const request = { schemaName: 'long-term-memory-extraction-v2', schema: LONG_TERM_EXTRACTION_SCHEMA };
  const original = structuredClone(request.schema);
  let wireSchema;
  const generator = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://api.example.test', model: 'fixture', apiKey: 'secret', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, options) => {
      wireSchema = JSON.parse(options.body).tools[0].function.parameters;
      const schemaName = JSON.parse(options.body).tools[0].function.name;
      return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{
        function: { name: schemaName, arguments: schemaName === 'long-term-memory-extraction-repair-v3' ? '{"results":[]}' : '{"memories":[]}' },
      }] } }] }) };
    },
  });
  await generator(request);
  assert.deepEqual(request.schema, original);
  const wireBranches = wireSchema.properties.memories.items.anyOf;
  assert.equal(wireBranches.length, LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.anyOf.length);
  const verifyStrictObjects = schema => {
    if (schema.type === 'object') {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
      Object.values(schema.properties).forEach(verifyStrictObjects);
    }
    if (schema.items) verifyStrictObjects(schema.items);
    schema.anyOf?.forEach(verifyStrictObjects);
  };
  verifyStrictObjects(wireSchema);
  const base = { kind: 'fact', title: '小林负责蓝色书架', content: '小林负责蓝色书架。',
    subjectRole: 'other', subjectName: '小林', actorRoles: [], canonicalKey: 'bookshelf-responsibility',
    stateFamily: 'identity', stateLabel: '负责的书架', reality: 'real', evidenceMode: 'explicit',
    temporalState: 'current', revisionAction: 'add', retentionReason: 'identity',
    eventDate: '', eventStart: '', eventEnd: '', confidence: 0.9, importance: 0.5, sourceRefs: ['M0001'] };
  const targets = {
    identity: { identityField: 'other', fieldCardinality: 'single' },
    belief: { objectRole: 'world', objectName: '天气' },
    relationship: { counterpartRole: 'other', counterpartName: 'Mio', relationshipDimension: 'support' },
    affective_association: { triggerRole: 'world', triggerName: 'flowers' },
  };
  const alternatives = LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.anyOf;
  for (const [family, target] of Object.entries(targets)) {
    const branch = alternatives.find(item => item.properties.stateFamily.enum[0] === family);
    const wireBranch = wireBranches.find(item => item.properties.stateFamily.enum[0] === family);
    assert.deepEqual(wireBranch.properties.stateTarget, {
      ...original.properties.memories.items.properties.stateTarget, ...branch.properties.stateTarget,
    });
    assert.deepEqual(Object.keys(branch.properties.stateTarget.properties).sort(), Object.keys(target).sort());
    const candidate = { ...base, stateFamily: family, stateTarget: target,
      ...(family === 'belief' ? { kind: 'belief_state', retentionReason: 'explicit_belief' } : {}),
      ...(family === 'affective_association' ? { kind: 'belief_state', retentionReason: 'state_change' } : {}),
      ...(family === 'relationship' ? { kind: 'relationship', retentionReason: 'relationship' } : {}) };
    const output = { memories: [candidate] };
    assert.deepEqual(validateMemoryTaskOutput(request, output).memories[0].stateTarget, target);
    assert.throws(() => validateMemoryTaskOutput(request, {
      memories: [{ ...candidate, retentionReason: 'explicit_preference' }],
    }), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
    for (const wrong of [{}, { ...target, objectName: '无关人物', direction: 'holder_to_counterpart' }]) {
      const invalid = { memories: [{ ...candidate, stateTarget: wrong }] };
      assert.throws(() => validateMemoryTaskOutput(request, invalid), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
      assert.throws(() => parseGeneratedLongTermExtraction(invalid), /stateTarget/);
    }
    const { stateTarget, ...missing } = candidate;
    assert.throws(() => validateMemoryTaskOutput(request, { memories: [missing] }));
  }
  const event = { ...base, kind: 'event', stateFamily: 'not_applicable', canonicalKey: '', stateLabel: '', retentionReason: 'episodic_event' };
  const eventBranch = wireBranches.find(item => item.properties.stateFamily.enum.includes('not_applicable'));
  assert.equal(Object.hasOwn(eventBranch.properties, 'stateTarget'), false);
  assert.deepEqual(eventBranch.properties.kind.enum, ['event', 'reflection']);
  assert.deepEqual(wireBranches.find(item => item.properties.stateFamily.enum.includes('goal')).properties.kind.enum,
    ['plan', 'commitment', 'open_loop']);
  assert.deepEqual(wireBranches.find(item => item.properties.stateFamily.enum.includes('preference')).properties.kind.enum,
    ['preference']);
  for (const [key, value] of Object.entries(original.properties.memories.items.properties)) {
    if (['stateTarget', 'stateFamily', 'kind', 'retentionReason'].includes(key)) continue;
    for (const branch of wireBranches) assert.deepEqual(branch.properties[key], value);
  }
  assert.equal(Object.hasOwn(validateMemoryTaskOutput(request, { memories: [event] }).memories[0], 'stateTarget'), false);
  for (const schemaName of ['long-term-memory-extraction-v2']) {
    const output = { memories: [{ ...event, stateTarget: null }] };
    const originalOutput = structuredClone(output);
    const normalized = validateMemoryTaskOutput({ ...request, schemaName }, output);
    assert.equal(Object.hasOwn(normalized.memories[0], 'stateTarget'), false);
    assert.deepEqual(output, originalOutput);
  }
  assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ ...event, stateTarget: {} }] }));
  assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ ...base, stateTarget: null }] }));
  assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ ...event, stateTarget: null, unexpected: null }] }));
  const repair = { schemaName: 'long-term-memory-extraction-repair-v3', schema: LONG_TERM_EXTRACTION_REPAIR_SCHEMA };
  const repairOutput = { results: [{ candidateIndex: 3, status: 'repaired', memories: [{ ...event, stateTarget: null }] }] };
  assert.equal(Object.hasOwn(validateMemoryTaskOutput(repair, repairOutput).results[0].memories[0], 'stateTarget'), false);
  await generator(repair);
  verifyStrictObjects(wireSchema);
  const mixed = { ...base, stateTarget: { ...targets.identity, objectRole: 'other', objectName: '小林' } };
  assert.throws(() => parseGeneratedLongTermExtraction({ memories: [mixed] }), /不适用：objectRole, objectName/);
  assert.throws(() => assertMemoryTaskRequest({ ...request, schemaName: 'long-term-memory-extraction-v1' }), /Unknown Memory task/);
});

for (const [name, definitions] of Object.entries(analysis).filter(([key]) => key.endsWith('_ANALYZERS'))) {
  test(`registered ${name} contracts validate every role and the actual batching requests`, async () => {
    const families = Map.groupBy(Object.entries(definitions), ([, definition]) => definition.stateFamily || 'state');
    for (const entries of families.values()) {
      const calls = [];
      const generator = Object.assign(async request => {
        calls.push(request);
        const output = request.combinedAnalyzerKeys
          ? { results: Object.fromEntries(request.combinedAnalyzerKeys.map(key => [key, { analyses: [] }])) }
          : { analyses: [] };
        assertMemoryTaskRequest(request);
        validateMemoryTaskOutput(request, output);
        const invalid = structuredClone(output);
        if (request.combinedAnalyzerKeys) invalid.results[request.combinedAnalyzerKeys[0]].analyses.push({});
        else invalid.analyses.push({});
        assert.throws(() => validateMemoryTaskOutput(request, invalid));
        assert.throws(() => assertMemoryTaskRequest({ ...request, schema: { type: 'object' } }), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
        return { output };
      }, { supportsCombinedStateAnalysis: true });
      const batch = createRelatedAnalyzerBatch({ definitions: Object.fromEntries(entries), generator, request: { id: 'validation-request', processorVersion: 'v1' } });
      await Promise.all(entries.map(async ([key, definition]) => {
        const request = { schemaName: definition.schemaName, schema: definition.schema, analyzerRole: definition.role,
          input: 'Snapshot:\n\n' + JSON.stringify({ memories: [], currentState: { id: 'current' } }),
          analysisSnapshot: { memories: [], currentState: { id: 'current' } }, systemPrompt: definition.role };
        assert.deepEqual(validateMemoryTaskOutput(request, { analyses: [] }), { analyses: [] });
        assert.throws(() => validateMemoryTaskOutput(request, { analyses: [{}] }));
        await batch[key](request);
      }));
      assert.ok(calls.length > 0);
      if (entries.length > 2) assert.ok(calls.some(request => request.combinedAnalyzerKeys?.length > 1));
    }
  });
}

test('extraction, repair, structure, relation and attribution use their registered owner contracts', () => {
  for (const schemaName of ['long-term-memory-extraction-v2']) {
    const request = { schemaName, schema: LONG_TERM_EXTRACTION_SCHEMA };
    validateMemoryTaskOutput(request, { memories: [] });
    assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ content: 'unsupported' }] }));
  }
  const repair = { schemaName: 'long-term-memory-extraction-repair-v3', schema: LONG_TERM_EXTRACTION_REPAIR_SCHEMA };
  validateMemoryTaskOutput(repair, { results: [{ candidateIndex: 2, status: 'rejected', reason: 'No supporting source.' }] });
  validateMemoryTaskOutput(repair, { results: [] });
  assert.throws(() => validateMemoryTaskOutput(repair, { results: [{ candidateIndex: 2, status: 'repaired', memories: [] }] }));
  assert.throws(() => validateMemoryTaskOutput(repair, { results: [{ candidateIndex: 2, status: 'rejected', reason: '' }] }));
  assert.throws(() => validateMemoryTaskOutput(repair, { memories: [] }));
  for (const [schemaName, schema] of [['memory-structure-proposals-v1', MEMORY_STRUCTURE_OUTPUT_SCHEMA], ['memory-relation-proposals-v1', MEMORY_RELATION_OUTPUT_SCHEMA]]) {
    validateMemoryTaskOutput({ schemaName, schema }, { proposals: [] });
    assert.throws(() => validateMemoryTaskOutput({ schemaName, schema }, { proposals: [{}] }));
  }
  const attribution = { schemaName: 'memory-subject-attribution-v1', schema: MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA };
  validateMemoryTaskOutput(attribution, { decision: 'abstain', subjectRole: '', subjectKey: '', sourceIds: [], actorRoles: [], confidence: 0, rationale: 'insufficient evidence' });
  assert.throws(() => validateMemoryTaskOutput(attribution, { decision: 'abstain' }), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
  assert.throws(() => assertMemoryTaskRequest({ schemaName: 'unknown-task', schema: { type: 'object' } }), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
});

test('retrieval-context wire bounds precede normalization and real critic semantics still reject approval with issues', () => {
  const proposal = { schemaName: 'memory_retrieval_context_proposal_v1', schema: MEMORY_RETRIEVAL_CONTEXT_PROPOSAL_SCHEMA };
  validateMemoryTaskOutput(proposal, { context: 'A valid retrieval context.', queryTerms: ['search'] });
  for (const output of [{ context: 123456789, queryTerms: [] }, { context: 'Valid context.', queryTerms: [12] },
    { context: 'Valid context.', queryTerms: Array.from({ length: 13 }, (_, i) => `query-${i}`) }]) {
    assert.throws(() => validateMemoryTaskOutput(proposal, output), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
  }
  const critic = { schemaName: 'memory_retrieval_context_critic_v1', schema: MEMORY_RETRIEVAL_CONTEXT_CRITIC_SCHEMA };
  validateMemoryTaskOutput(critic, { approved: true, issues: [] });
  assert.throws(() => validateMemoryTaskOutput(critic, { approved: true, issues: ['contradiction'] }), /存在审查问题/u);
});

test('combined consolidation validates both child domains and disallows undeclared children', () => {
  const schema = { type: 'object', additionalProperties: false, required: ['structure', 'relations'],
    properties: { structure: MEMORY_STRUCTURE_OUTPUT_SCHEMA, relations: MEMORY_RELATION_OUTPUT_SCHEMA } };
  const request = { schemaName: 'memory-consolidation-combined-v1', schema };
  const output = { structure: { proposals: [] }, relations: { proposals: [] } };
  validateMemoryTaskOutput(request, output);
  assert.throws(() => validateMemoryTaskOutput(request, { ...output, relations: { proposals: [{}] } }));
  assert.throws(() => validateMemoryTaskOutput(request, { ...output, extra: {} }));
});
