import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { archiveLongTermEvidence, buildLongTermExtractionInput } from '@suzu-memory/extraction';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';
import { IDENTITY_ANALYZERS, evaluateIdentityEvidence, processStateAnalysisRequest } from '../src/index.mjs';

function fixture(t, { selfReport = false, agentId = 'agent-test', batchId = 'identity-batch' } = {}) {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const identity = { companionId: agentId, companionName: '杰瑞', primaryUserId: 'user-test', primaryUserName: '王海' };
  const texts = selfReport ? ['我是一名教师。'] : ['王涟：又见面了！杰瑞', '真，你知道的，这是我弟弟，王涟'];
  const built = buildLongTermExtractionInput({ identity, memoryOwner: '杰瑞', userName: '王海',
    messages: texts.map((text, index) => ({ id: `${batchId}-${index}`, role: 'user', speaker: '王海',
      text, timestamp: '2026-07-10T12:00:00.000Z' })) });
  const archive = archiveLongTermEvidence({ repository, agentId, identity, messages: built.messages,
    batchId, recordedAt: '2026-07-10T12:01:00.000Z', generatedMemories: [{
      kind: 'fact', title: selfReport ? '王海的职业' : '王涟的身份',
      content: selfReport ? '王海是一名教师。' : '王涟是王海的弟弟。',
      subjectRole: selfReport ? 'user' : 'other', subjectName: selfReport ? '王海' : '王涟',
      canonicalKey: 'identity-target', reality: 'real', evidenceMode: 'explicit', stateFamily: 'identity',
      stateLabel: selfReport ? '职业' : '王涟的身份',
      stateTarget: { identityField: selfReport ? 'occupation' : 'other', fieldCardinality: 'single' },
      temporalState: 'current', confidence: 0.9, importance: 0.5, actorRoles: [],
      sourceRefs: built.messages.map(message => message.memoryRef), retentionReason: 'identity',
      revisionAction: 'add',
    }] });
  assert.equal(archive.stateAnalysisRequestsQueued, 1, JSON.stringify(archive.candidateResults));
  const request = repository.getStateAnalysisRequest(agentId, archive.candidateResults[0].stateAnalysisRequestId);
  return { database, repository, request, agentId };
}

function generatorFor({ selfReport = false, subjectMatch = 'yes', unrelatedSource = '', realCase = false } = {}) {
  const calls = [];
  const generator = Object.assign(async request => {
    calls.push(request);
    assertMemoryTaskRequest(request);
    const snapshot = JSON.parse(request.input.slice(request.input.indexOf('\n{') + 1));
    assert.equal(snapshot.target.subjectLabel, selfReport ? '王海' : '王涟');
    const common = memory => ({ memoryId: memory.id, sourceIds: memory.sourceIds,
      confidence: 0.9, rationale: '逐条核对原话中的人物和归属。' });
    const results = Object.fromEntries(request.combinedAnalyzerKeys.map(key => [key, {
      analyses: snapshot.memories.map((memory, index) => {
        const item = common(memory);
        if (key === 'fieldValue') return { ...item, ...(unrelatedSource ? { sourceIds: [unrelatedSource] } : {}),
          targetMatch: realCase ? index === 0 ? 'none' : 'contextual' : 'exact',
          identityField: snapshot.target.identityField,
          valueText: realCase ? index === 0 ? '' : '王海的弟弟' : '教师',
          statementPolarity: realCase && index === 0 ? 'no_fact' : 'asserts', valueScope: '' };
        if (key === 'subjectAttribution') return { ...item, subjectMatch,
          attribution: selfReport ? 'explicit_self_report' : 'third_party_report' };
        if (key === 'familyBoundary') return { ...item,
          classification: realCase ? index === 0 ? 'no_identity_fact' : 'relationship_role' : 'identity_fact', sensitivity: 'ordinary' };
        if (key === 'timeRevision') return { ...item, factTime: 'current', revisionCue: 'none', timeReference: '' };
        throw new Error(`Unexpected analyzer ${key}`);
      }),
    }]));
    const output = { results };
    validateMemoryTaskOutput(request, output);
    return { output, model: 'test-identity', metadata: { provider: 'test' } };
  }, { supportsCombinedStateAnalysis: true });
  return { calls, generator };
}

const process = (f, generator) => processStateAnalysisRequest({ repository: f.repository,
  agentId: f.agentId, requestId: f.request.id, generator });

test('third-person raw evidence completes in one call without changing the real speaker or approving identity', async t => {
  const f = fixture(t);
  const before = f.request.memoryIds.map(id => f.repository.getMemoryDetail(f.agentId, id));
  const { calls, generator } = generatorFor({ realCase: true });
  const result = await process(f, generator);
  assert.equal(calls.length, 1);
  assert.equal(result.evaluation.status, 'analyzed');
  assert.deepEqual(result.evaluation.failedRoles, []);
  assert.ok(Object.values(result.evaluation.runs).every(run => run.status === 'completed'));
  assert.ok(Object.values(result.evaluation.rejected).every(items => items.length === 0));
  assert.equal(result.status, 'provisional-review');
  assert.equal(result.request.status, 'completed');
  assert.equal(result.request.metadata.attemptCount || 0, 0);
  assert.equal(f.repository.listReportedStateProposals(f.agentId).length, 0);
  assert.deepEqual(f.request.memoryIds.map(id => f.repository.getMemoryDetail(f.agentId, id)), before);
  assert.equal((await process(f, generator)).status, 'already-resolved');
  assert.equal(calls.length, 1, 'completed analysis must not be sent again');
});

for (const subjectMatch of ['yes', 'no', 'unknown']) test(`third-party attribution ${subjectMatch} is analyzed without becoming a firsthand fact`, async t => {
  const f = fixture(t);
  const { calls, generator } = generatorFor({ subjectMatch });
  const result = await process(f, generator);
  assert.equal(calls.length, 1);
  assert.equal(result.evaluation.status, 'analyzed');
  assert.deepEqual(result.evaluation.failedRoles, []);
  assert.equal(result.status, 'provisional-review');
  assert.equal(f.repository.listReportedStateProposals(f.agentId).length, 0);
});

test('a quoted speaker label cannot authorize a third-person self report', async t => {
  const f = fixture(t);
  const base = generatorFor();
  const generator = Object.assign(async request => {
    const response = await base.generator(request);
    response.output.results.subjectAttribution.analyses.forEach(item => { item.attribution = 'explicit_self_report'; });
    return response;
  }, { supportsCombinedStateAnalysis: true });
  const result = await process(f, generator);
  assert.deepEqual(result.evaluation.failedRoles, ['subjectAttribution']);
  assert.ok(result.evaluation.rejected.subjectAttribution.every(item => /requires the fixed subject as speaker/.test(item.error)));
  assert.equal(result.status, 'retry-pending');
  assert.equal(f.repository.listReportedStateProposals(f.agentId).length, 0);
});

test('the actual speaker can still propose a directly reported identity', async t => {
  const f = fixture(t, { selfReport: true });
  const { calls, generator } = generatorFor({ selfReport: true });
  const result = await process(f, generator);
  assert.equal(calls.length, 1);
  assert.equal(result.evaluation.status, 'analyzed');
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.equal(result.proposal.subject_key, 'user-test');
});

for (const invalid of ['missing-name', 'different-name', 'different-scope', 'ambiguous-name']) {
  test(`invalid third-person target ${invalid} is rejected before any model call`, async t => {
    const f = fixture(t);
    const metadata = structuredClone(f.request.metadata);
    if (invalid === 'missing-name') metadata.subjectName = '';
    if (invalid === 'different-name') metadata.subjectName = '另一个人';
    if (invalid === 'different-scope') metadata.actorIdentity.unresolvedActorScope = 'another-session-scope';
    if (invalid === 'ambiguous-name') metadata.actorIdentity.participants.push(
      { name: '王涟', actorRole: 'other', actorKey: 'person-a', aliases: [] },
      { name: '王涟', actorRole: 'other', actorKey: 'person-b', aliases: [] });
    f.repository.bindStateAnalysisTarget({ agentId: f.agentId, requestId: f.request.id,
      canonicalKey: f.request.canonical_key, metadata });
    let calls = 0;
    const run = () => process(f, async () => { calls++; throw new Error('must not call'); });
    const result = await run();
    assert.equal(result.status, 'provisional-review');
    assert.equal(result.reason, 'request-subject-identity-mismatch');
    assert.equal(result.evaluation, null);
    assert.equal(calls, 0);
    assert.equal((await run()).status, 'already-resolved');
    assert.equal(calls, 0);
    const provisional = f.repository.listPendingProvisionalMemories(f.agentId);
    assert.equal(provisional.length, 1);
    assert.equal(provisional[0].subject_key, f.request.subject_key, 'review must preserve the original extraction subject');
  });
}

test('third-person analysis still rejects sources outside its own evidence', async t => {
  const f = fixture(t);
  const source = f.repository.upsertSource({ agentId: f.agentId,
    sourceKind: 'conversation-event', externalId: 'unrelated-source', content: '另一个会话的人物。' });
  const { calls, generator } = generatorFor({ unrelatedSource: source.id });
  const result = await process(f, generator);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.evaluation.failedRoles, ['fieldValue']);
  assert.ok(result.evaluation.rejected.fieldValue.every(item => /source must directly support its memory/.test(item.error)));
  assert.equal(f.repository.listReportedStateProposals(f.agentId).length, 0);
});

test('structured evidence retains its fixed-subject guard', async t => {
  const f = fixture(t);
  for (const id of f.request.memoryIds) {
    f.database.prepare("UPDATE memory_nodes SET kind = 'event' WHERE id = ?").run(id);
    f.repository.listMemorySources(id).forEach(source => f.repository.linkSource(id, source.id, 'evidence'));
  }
  const { generator } = generatorFor();
  const result = await process(f, generator);
  assert.equal(result.status, 'retry-pending');
  assert.equal(result.evaluation.failedRoles.length, 5);
  assert.ok(Object.values(result.evaluation.rejected).flat()
    .every(item => /does not identify the fixed subject/.test(item.error)));
});

test('bounded raw sources alone do not bypass the subject guard without an analysis request', async t => {
  const f = fixture(t);
  const result = await process(f, generatorFor().generator);
  const evaluation = await evaluateIdentityEvidence({
    repository: f.repository, agentId: f.agentId, subjectRole: f.request.subject_role, subjectKey: f.request.subject_key,
    subjectLabel: '王涟', canonicalKey: f.request.canonical_key, identityField: 'other', identityLabel: '王涟的身份',
    fieldCardinality: 'single', memoryIds: f.request.memoryIds, currentRepresentationLayer: 'reported',
    snapshotOptions: { allowUtteranceEvidence: true, allowedSourceIds: f.request.sourceIds },
    analyzers: Object.fromEntries(Object.keys(IDENTITY_ANALYZERS).map(key => [key, async () => ({
      output: { analyses: result.evaluation.analyses[key] }, model: 'test-unbound-identity',
    })])),
  });
  assert.equal(evaluation.status, 'incomplete');
  assert.equal(evaluation.failedRoles.length, 5);
  assert.ok(Object.values(evaluation.rejected).flat().every(item => /does not identify the fixed subject/.test(item.error)));
});
