import assert from 'node:assert/strict';
import test from 'node:test';
import * as analysis from '@suzu-memory/analysis';
import { createRelatedAnalyzerBatch } from '../../analysis/src/related-analyzer-batch.mjs';
import { LONG_TERM_EXTRACTION_SCHEMA, LONG_TERM_EXTRACTION_REPAIR_SCHEMA, parseGeneratedLongTermExtraction, normalizeGeneratedLongTermExtraction } from '@suzu-memory/extraction';
import { MEMORY_STRUCTURE_OUTPUT_SCHEMA, MEMORY_RELATION_OUTPUT_SCHEMA, MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA } from '@suzu-memory/structurer';
import { MEMORY_RETRIEVAL_CONTEXT_PROPOSAL_SCHEMA, MEMORY_RETRIEVAL_CONTEXT_CRITIC_SCHEMA } from '@suzu-memory/embedding-indexer';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '../src/index.mjs';
import { createOpenAiCompatibleStructuredGenerator } from '../../providers/src/index.mjs';

test('extraction contracts retain typed targets without replicating the common memory body', async () => {
  const request = { schemaName: 'long-term-memory-extraction-v4', schema: LONG_TERM_EXTRACTION_SCHEMA };
  const original = structuredClone(request.schema);
  let wireSchema;
  const generator = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://api.example.test', model: 'fixture', apiKey: 'secret', structuredOutputMode: 'strict-tool' },
    fetchImpl: async (_url, options) => {
      const tool = JSON.parse(options.body).tools[0].function;
      wireSchema = tool.parameters;
      return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{
        function: { name: tool.name, arguments: tool.name.endsWith('repair-v4') ? '{"results":[]}' : '{"memories":[]}' },
      }] } }] }) };
    },
  });
  await generator(request);
  assert.deepEqual(request.schema, original);
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
  assert.equal(Object.hasOwn(wireSchema.properties.memories.items, 'anyOf'), false);
  const base = { title: '小林负责蓝色书架', content: '小林负责蓝色书架。',
    subject: { name: '小林' }, actors: [], reality: 'real', evidenceMode: 'explicit',
    temporalState: 'current', revisionAction: 'add', time: null, confidence: 0.9, importance: 0.5, sourceRefs: ['M0001'] };
  const targets = {
    identity: { identityField: 'other', fieldCardinality: 'single' },
    belief: { object: { world: '天气' } },
    relationship: { counterpart: { name: 'Mio' }, dimension: 'support' },
    affective_association: { trigger: { world: 'flowers' } },
  };
  for (const [category, target] of Object.entries(targets)) {
    const candidate = { ...base, classification: { category, key: 'bookshelf-responsibility', label: '负责的书架', target } };
    const output = { memories: [candidate] };
    assert.deepEqual(validateMemoryTaskOutput(request, output), output);
    for (const wrong of [{}, { ...target, unrelatedPerson: '无关人物' }]) {
      const invalid = { memories: [{ ...candidate, classification: { ...candidate.classification, target: wrong } }] };
      assert.throws(() => validateMemoryTaskOutput(request, invalid), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
      assert.throws(() => parseGeneratedLongTermExtraction(invalid), /target/);
    }
    const { target: ignored, ...missing } = candidate.classification;
    assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ ...candidate, classification: missing }] }));
  }
  const event = { ...base, classification: { category: 'event' } };
  for (const invalid of [{ ...event, classification: { category: ['event'] } }, { ...event, subject: { ref: ['P1'] } }]) {
    assert.throws(() => validateMemoryTaskOutput(request, { memories: [invalid] }));
    assert.throws(() => parseGeneratedLongTermExtraction({ memories: [invalid] }));
  }
  assert.deepEqual(validateMemoryTaskOutput(request, { memories: [event] }).memories, [event]);
  const causal = { memories: [{ ...event, title: '参观取消', content: '小林因为博物馆闭馆取消了参观。' }],
    causalExcerpts: [{ sourceRef: 'M0001', start: '因为博物馆闭馆', end: '取消了参观。' }] };
  assert.deepEqual(validateMemoryTaskOutput(request, causal), causal);
  assert.throws(() => validateMemoryTaskOutput(request, { ...causal,
    causalExcerpts: [{ ...causal.causalExcerpts[0], start: 123 }] }), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
  for (const field of ['retentionReason', 'stateFamily', 'canonicalKey']) {
    assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ ...event, [field]: '' }] }));
  }
  assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ ...event, classification: { category: 'event', label: '' } }] }));
  assert.throws(() => normalizeGeneratedLongTermExtraction({ memories: [{ ...event, subject: { ref: 'P99' } }] }, { participants: [] }), /未知人物引用/);
  const repair = { schemaName: 'long-term-memory-extraction-repair-v5', schema: LONG_TERM_EXTRACTION_REPAIR_SCHEMA };
  const repaired = { results: [{ candidateIndex: 3, status: 'repaired', memories: [event] }] };
  assert.deepEqual(validateMemoryTaskOutput(repair, repaired), repaired);
  await generator(repair);
  verifyStrictObjects(wireSchema);
  assert.throws(() => assertMemoryTaskRequest({ ...request, schemaName: 'long-term-memory-extraction-v2' }), /Unknown Memory task/);
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
  for (const schemaName of ['long-term-memory-extraction-v4']) {
    const request = { schemaName, schema: LONG_TERM_EXTRACTION_SCHEMA };
    validateMemoryTaskOutput(request, { memories: [] });
    assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ content: 'unsupported' }] }));
  }
  const repair = { schemaName: 'long-term-memory-extraction-repair-v5', schema: LONG_TERM_EXTRACTION_REPAIR_SCHEMA };
  validateMemoryTaskOutput(repair, { results: [{ candidateIndex: 2, status: 'rejected', reason: 'No supporting source.' }] });
  validateMemoryTaskOutput(repair, { results: [] });
  assert.throws(() => validateMemoryTaskOutput(repair, { results: [{ candidateIndex: 2, status: 'repaired', memories: [] }] }));
  assert.throws(() => validateMemoryTaskOutput(repair, { results: [{ candidateIndex: 2, status: 'rejected', reason: '' }] }));
  assert.throws(() => validateMemoryTaskOutput(repair, { memories: [] }));
  for (const [schemaName, schema] of [['memory-structure-proposals-v2', MEMORY_STRUCTURE_OUTPUT_SCHEMA], ['memory-relation-proposals-v1', MEMORY_RELATION_OUTPUT_SCHEMA]]) {
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
