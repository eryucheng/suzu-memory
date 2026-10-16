import assert from 'node:assert/strict';
import test from 'node:test';
import * as analysis from '@suzu-memory/analysis';
import { createRelatedAnalyzerBatch } from '../../analysis/src/related-analyzer-batch.mjs';
import { LONG_TERM_EXTRACTION_SCHEMA, parseGeneratedLongTermExtraction } from '@suzu-memory/extraction';
import { MEMORY_STRUCTURE_OUTPUT_SCHEMA, MEMORY_RELATION_OUTPUT_SCHEMA, MEMORY_SUBJECT_ATTRIBUTION_OUTPUT_SCHEMA } from '@suzu-memory/structurer';
import { MEMORY_RETRIEVAL_CONTEXT_PROPOSAL_SCHEMA, MEMORY_RETRIEVAL_CONTEXT_CRITIC_SCHEMA } from '@suzu-memory/embedding-indexer';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '../src/index.mjs';

test('extraction target branches expose only their family fields and reject cross-family objects', () => {
  const request = { schemaName: 'long-term-memory-extraction-v2', schema: LONG_TERM_EXTRACTION_SCHEMA };
  const base = { kind: 'fact', title: '小林负责蓝色书架', content: '小林负责蓝色书架。',
    subjectRole: 'other', subjectName: '小林', actorRoles: [], canonicalKey: 'bookshelf-responsibility',
    stateFamily: 'identity', stateLabel: '负责的书架', reality: 'real', evidenceMode: 'explicit',
    temporalState: 'current', revisionAction: 'add', retentionReason: 'identity',
    eventDate: '', eventStart: '', eventEnd: '', confidence: 0.9, importance: 0.5, sourceRefs: ['M0001'] };
  const targets = {
    identity: { identityField: 'other', fieldCardinality: 'single' },
    belief: { objectRole: 'world', objectName: '天气' },
    relationship: { counterpartRole: 'other', counterpartName: 'Mio' },
    affective_association: { triggerRole: 'other', triggerName: 'Mio' },
  };
  const alternatives = LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.anyOf;
  for (const [family, target] of Object.entries(targets)) {
    const branch = alternatives.find(item => item.properties.stateFamily.enum[0] === family);
    assert.deepEqual(Object.keys(branch.properties.stateTarget.properties).sort(), Object.keys(target).sort());
    const candidate = { ...base, stateFamily: family, stateTarget: target,
      ...(family === 'belief' ? { kind: 'belief_state', retentionReason: 'explicit_belief' } : {}),
      ...(family === 'affective_association' ? { kind: 'belief_state', retentionReason: 'state_change' } : {}),
      ...(family === 'relationship' ? { kind: 'relationship', retentionReason: 'relationship' } : {}) };
    const output = { memories: [candidate] };
    assert.deepEqual(validateMemoryTaskOutput(request, output).memories[0].stateTarget, target);
    for (const wrong of [{}, { ...target, objectName: '无关人物', direction: 'holder_to_counterpart' }]) {
      const invalid = { memories: [{ ...candidate, stateTarget: wrong }] };
      assert.throws(() => validateMemoryTaskOutput(request, invalid), { code: 'MEMORY_TASK_SCHEMA_INVALID' });
      assert.throws(() => parseGeneratedLongTermExtraction(invalid), /stateTarget/);
    }
    const { stateTarget, ...missing } = candidate;
    assert.throws(() => validateMemoryTaskOutput(request, { memories: [missing] }));
  }
  const event = { ...base, kind: 'event', stateFamily: 'not_applicable', canonicalKey: '', stateLabel: '', retentionReason: 'episodic_event' };
  assert.equal(Object.hasOwn(validateMemoryTaskOutput(request, { memories: [event] }).memories[0], 'stateTarget'), false);
  assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ ...event, stateTarget: {} }] }));
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
          input: 'Snapshot:\n\n' + JSON.stringify({ memories: [], currentState: { id: 'current' } }), systemPrompt: definition.role };
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
  for (const schemaName of ['long-term-memory-extraction-v2', 'long-term-memory-extraction-repair-v2']) {
    const request = { schemaName, schema: LONG_TERM_EXTRACTION_SCHEMA };
    validateMemoryTaskOutput(request, { memories: [] });
    assert.throws(() => validateMemoryTaskOutput(request, { memories: [{ content: 'unsupported' }] }));
  }
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
