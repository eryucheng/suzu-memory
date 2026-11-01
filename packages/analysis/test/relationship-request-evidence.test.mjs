import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { archiveLongTermEvidence, buildLongTermExtractionInput } from '@suzu-memory/extraction';
import { assertMemoryTaskRequest, validateMemoryTaskOutput } from '@suzu-memory/service';
import { processStateAnalysisRequest } from '../src/index.mjs';

function fixture(t, texts, { independentReverse = false, sameTime = false } = {}) {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const identity = { companionId: 'melanie', companionName: 'Melanie', primaryUserId: 'caroline', primaryUserName: 'Caroline' };
  const built = buildLongTermExtractionInput({ identity, memoryOwner: 'Melanie', userName: 'Caroline',
    messages: texts.map(([role, text], i) => ({ id: `message-${i}`, role,
      speaker: role === 'user' ? 'Caroline' : 'Melanie', text,
      timestamp: `2026-10-20T10:0${sameTime ? 0 : i}:00.000Z` })) });
  const candidate = { kind: 'relationship', stateFamily: 'relationship', title: 'Support',
    content: texts.filter(([role]) => role === 'user').map(([, text]) => text).join('\n'),
    subjectRole: 'user', subjectName: 'Caroline', canonicalKey: 'caroline-support-melanie',
    stateLabel: 'Support', stateTarget: { counterpartRole: 'agent', counterpartName: 'Melanie', relationshipDimension: 'support' },
    reality: 'real', evidenceMode: 'explicit', temporalState: 'current', revisionAction: 'add',
    retentionReason: 'relationship', confidence: 0.9, importance: 0.5, actorRoles: [],
    sourceRefs: built.messages.map(message => message.memoryRef) };
  const reverse = independentReverse ? { ...candidate, subjectRole: 'agent', subjectName: 'Melanie',
    canonicalKey: 'melanie-support-caroline', content: texts.filter(([role]) => role === 'assistant').map(([, text]) => text).join('\n'),
    stateTarget: { counterpartRole: 'user', counterpartName: 'Caroline', relationshipDimension: 'support' },
    sourceRefs: built.messages.filter(message => message.role === 'assistant').map(message => message.memoryRef) } : null;
  const archive = archiveLongTermEvidence({ repository, agentId: 'melanie', identity,
    messages: built.messages, batchId: 'support-batch', recordedAt: '2026-10-20T10:10:00.000Z', generatedMemories: [candidate, reverse].filter(Boolean) });
  assert.equal(archive.stateAnalysisRequestsQueued, independentReverse ? 2 : 1);
  return { repository, request: repository.getStateAnalysisRequest('melanie', archive.candidateResults[0].stateAnalysisRequestId) };
}

function generatorFor({ comparison = 'supports', forgedReference = false,
  groundingDimension = 'support', duplicateSupport = false, counterpartAttribution = 'explicit_counterpart_statement',
  counterpartDirection } = {}) {
  const calls = [];
  const generator = Object.assign(async request => {
    calls.push(request);
    assertMemoryTaskRequest(request);
    const start = request.input.indexOf('快照：\n');
    const snapshot = JSON.parse(start >= 0 ? request.input.slice(start + '快照：\n'.length)
      : request.input.slice(request.input.indexOf('{')));
    const roles = request.combinedAnalyzerKeys || ['currentRelation'];
    const outputFor = key => ({ analyses: snapshot.memories.flatMap(memory => {
      const common = { memoryId: memory.id, sourceIds: memory.sourceIds, confidence: 0.9, rationale: 'Direct evidence.' };
      const own = memory.actorRoles.some(role => role.role === 'speaker'
        && role.actorRole === snapshot.target.subjectRole && role.actorKey === snapshot.target.subjectKey);
      if (key === 'relationGrounding') {
        const support = { ...common, targetMatch: 'exact', relationType: groundingDimension,
          polarity: 'affirms', relationLabel: memory.content, scopeLabel: '', conditionLabel: '' };
        return [
          support,
          ...(duplicateSupport ? [{ ...support }] : []),
        ];
      }
      if (key === 'perspectiveDirection') return { ...common, holderMatch: 'yes', counterpartMatch: 'yes',
        direction: !own && counterpartDirection ? counterpartDirection
          : /\bwe\b|我们/iu.test(memory.content) ? 'mutual_claim' : own ? 'holder_to_counterpart' : 'counterpart_to_holder',
        attribution: own ? 'explicit_self_statement' : counterpartAttribution };
      if (key === 'scopeTime') return { ...common, stateTime: 'current', duration: 'ongoing', revocationCue: 'none' };
      const reference = snapshot.relationshipComparison;
      const peer = reference && reference.memoryId !== memory.id;
      return { ...common, currentStatePresent: false, relation: 'no_current_state', scopeOverlap: 'unknown',
        comparisonMemoryId: peer ? forgedReference ? 'outside-the-request' : reference.memoryId : '',
        comparisonRelation: peer ? comparison : 'no_comparison', comparisonScopeOverlap: peer ? 'exact' : 'unknown' };
    }) });
    const output = request.combinedAnalyzerKeys
      ? { results: Object.fromEntries(roles.map(key => [key, outputFor(key)])) } : outputFor('currentRelation');
    validateMemoryTaskOutput(request, output);
    return { output, model: 'test-relationship', metadata: { provider: 'test' } };
  }, { supportsCombinedStateAnalysis: true });
  return { generator, calls };
}

const process = (f, generator, requestId = f.request.id) => processStateAnalysisRequest({
  repository: f.repository, agentId: 'melanie', requestId, generator });

for (const texts of [
  [['user', 'We can always be there for each other.'], ['assistant', 'I am here for you too.'], ['user', 'Your support makes life easier.']],
  [['user', '我们会一直支持彼此。'], ['assistant', '我也会支持你。'], ['user', '你的支持让我轻松很多。']],
]) test(`compatible relationship statements and independent reverse views: ${texts[0][1]}`, async t => {
  const f = fixture(t, texts);
  const { generator, calls } = generatorFor();
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.equal(calls.length, 2, 'one combined evidence call and one bounded peer comparison');
  assert.equal(result.proposal.draft.relationshipView.sharedConfirmation, 'unconfirmed');
  assert.equal(result.review.automaticRuntimePermissionChangeAllowed, false);
  assert.equal(result.evaluation.observations.filter(o => o.qualification === 'qualified').length, 2);
  const [reverse] = result.evaluation.counterpartRequests;
  assert.ok(reverse);
  assert.equal(reverse.subject_key, 'melanie');
  assert.equal(reverse.targetSpec.counterpartKey, 'caroline');
  assert.equal(reverse.memoryIds.length, 1);
  assert.equal(f.repository.getMemory(reverse.memoryIds[0]).content, texts[1][1]);
  assert.equal(f.repository.materializeStateAnalysisMemory('melanie', reverse.id).content, texts[1][1]);
  const reversed = await process(f, generator, reverse.id);
  assert.equal(reversed.status, 'proposal-pending', JSON.stringify(reversed));
  assert.equal(reversed.proposal.subject_key, 'melanie');
  assert.equal(reversed.proposal.draft.counterpart.key, 'caroline');
  assert.deepEqual(reversed.evaluation.counterpartRequests, []);
  const completedCalls = calls.length;
  assert.equal((await process(f, generator)).status, 'already-resolved');
  assert.equal(calls.length, completedCalls);
  assert.equal(f.repository.listStateAnalysisRequests('melanie', { stateFamily: 'relationship' }).length, 2);
});

for (const texts of [
  [['user', 'We support each other.'], ['assistant', 'We can face challenges together.']],
  [['user', '我们会互相支持。'], ['assistant', '我们可以一起面对困难。']],
]) test(`each speaker's mutual claim routes to their own view: ${texts[0][1]}`, async t => {
  const f = fixture(t, texts);
  const { generator, calls } = generatorFor();
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.equal(result.evaluation.observations.length, 1, 'counterpart evidence cannot establish the original holder view');
  assert.equal(result.proposal.draft.relationshipView.sharedConfirmation, 'unconfirmed');
  const [reverse] = result.evaluation.counterpartRequests;
  assert.ok(reverse);
  assert.equal(reverse.memoryIds.length, 1);
  assert.equal(f.repository.getMemory(reverse.memoryIds[0]).content, texts[1][1]);
  const reversed = await process(f, generator, reverse.id);
  assert.equal(reversed.status, 'proposal-pending', JSON.stringify(reversed));
  assert.equal(reversed.proposal.draft.relationshipView.expressedDirection, 'mutual_claim');
  assert.equal(reversed.proposal.draft.relationshipView.sharedConfirmation, 'unconfirmed');
  assert.deepEqual(reversed.evaluation.counterpartRequests, []);
  assert.equal(calls.length, 2, 'one evidence call for each independently attributed view');
});

test('an unrelated relationship dimension cannot establish the fixed support proposition', async t => {
  const f = fixture(t, [['user', 'I value your support and feel close to you.']]);
  const { generator, calls } = generatorFor({ groundingDimension: 'closeness' });
  const result = await process(f, generator);
  assert.equal(result.status, 'provisional-review');
  assert.deepEqual(result.evaluation.analyses.relationGrounding, []);
  assert.equal(f.repository.listReportedStateProposals('melanie').length, 0);
  assert.equal(calls.length, 1);
});

test('an output exceeding the declared schema leaves the combined analysis pending', async t => {
  const f = fixture(t, [['user', 'I am here for you.']]);
  const { generator } = generatorFor({ duplicateSupport: true });
  const result = await process(f, generator);
  assert.equal(result.status, 'retry-pending');
  assert.deepEqual(result.evaluation.failedRoles, ['relationGrounding', 'perspectiveDirection', 'scopeTime']);
  assert.equal(f.repository.listReportedStateProposals('melanie').length, 0);
});

test('a counterpart mutual claim cannot be forged as a holder self statement', async t => {
  const f = fixture(t, [['user', 'I am here for you.'], ['assistant', 'We can face challenges together.']]);
  const { generator } = generatorFor({ counterpartAttribution: 'explicit_self_statement' });
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending');
  assert.equal(result.evaluation.status, 'partial');
  assert.equal(result.evaluation.observations.length, 1);
  assert.deepEqual(result.evaluation.counterpartRequests, []);
  assert.deepEqual(result.evaluation.failedRoles, ['perspectiveDirection']);
  assert.equal(f.repository.listReportedStateProposals('melanie').length, 1);
});

test('an unknown counterpart direction neither invents a view nor blocks the holder evidence', async t => {
  const f = fixture(t, [['user', 'I am here for you.'], ['assistant', 'Thank you.']]);
  const { generator } = generatorFor({ counterpartDirection: 'unknown' });
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.equal(result.evaluation.observations.length, 1);
  assert.deepEqual(result.evaluation.counterpartRequests, []);
});

test('a counterpart pair description is retained only in the independently attributed reverse request', async t => {
  const f = fixture(t, [['user', 'I support you.'], ['assistant', 'Our friendship matters to me.']]);
  const { generator } = generatorFor({ counterpartDirection: 'about_pair' });
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.equal(result.evaluation.observations.length, 1);
  const [reverse] = result.evaluation.counterpartRequests;
  assert.ok(reverse);
  assert.equal(reverse.subject_key, 'melanie');
  assert.equal(f.repository.getMemory(reverse.memoryIds[0]).content, 'Our friendship matters to me.');
  assert.equal(result.proposal.draft.relationshipView.sharedConfirmation, 'unconfirmed');
});

test('a counterpart statement cannot claim the holder-to-counterpart direction', async t => {
  const f = fixture(t, [['user', 'I am here for you.'], ['assistant', 'I support you too.']]);
  const { generator } = generatorFor({ counterpartDirection: 'holder_to_counterpart' });
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending');
  assert.equal(result.evaluation.status, 'partial');
  assert.equal(result.evaluation.observations.length, 1);
  assert.deepEqual(result.evaluation.counterpartRequests, []);
  assert.deepEqual(result.evaluation.failedRoles, ['perspectiveDirection']);
});

for (const comparison of ['unknown', 'same_scope_conflict', 'unrelated']) {
  test(`non-equivalent peer evidence stays under review: ${comparison}`, async t => {
    const f = fixture(t, [['user', 'I value our friendship.'], ['user', 'I am here for you.']]);
    const { generator } = generatorFor({ comparison });
    const result = await process(f, generator);
    assert.equal(result.status, 'provisional-review');
    assert.equal(result.review.reason, 'multiple-unresolved-direct-states-without-change-cue');
    assert.equal(f.repository.listReportedStateProposals('melanie').length, 0);
  });
}

test('peer comparison cannot reference evidence outside its fixed request', async t => {
  const f = fixture(t, [['user', 'I value our friendship.'], ['user', 'I am here for you.']]);
  const { generator } = generatorFor({ forgedReference: true });
  const result = await process(f, generator);
  assert.equal(result.status, 'retry-pending');
  assert.deepEqual(result.evaluation.failedRoles, ['currentRelation']);
  assert.equal(f.repository.listReportedStateProposals('melanie').length, 0);
});

test('a mutual claim alone does not invent the counterpart view', async t => {
  const f = fixture(t, [['user', 'We are always there for each other.']]);
  const { generator, calls } = generatorFor();
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending');
  assert.equal(result.proposal.draft.relationshipView.expressedDirection, 'mutual_claim');
  assert.equal(result.proposal.draft.relationshipView.sharedConfirmation, 'unconfirmed');
  assert.deepEqual(result.evaluation.counterpartRequests, []);
  assert.equal(calls.length, 1, 'one statement requires no semantic peer comparison');
});

test('an independently extracted reverse request prevents duplicate routing', async t => {
  const f = fixture(t, [['user', 'I am here for you.'], ['assistant', 'I am here for you too.']], { independentReverse: true });
  const { generator } = generatorFor();
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending');
  assert.deepEqual(result.evaluation.counterpartRequests, []);
  assert.equal(f.repository.listStateAnalysisRequests('melanie', { stateFamily: 'relationship' }).length, 2);
});

test('same-time compatible statements use one consistent comparison reference', async t => {
  const f = fixture(t, [['user', 'I value our friendship.'], ['user', 'I am here for you.'],
    ['user', 'Your support helps me.']], { sameTime: true });
  const { generator } = generatorFor();
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending', JSON.stringify(result));
  assert.equal(result.review.consideredObservationIds.length, 3);
});

test('keeps complete evidence and retries only the item missing its required comparison', async t => {
  const f = fixture(t, [['user', 'I value our friendship.'], ['user', 'I am here for you.']]);
  const first = generatorFor({ forgedReference: true });
  const result = await process(f, first.generator);
  assert.equal(result.status, 'retry-pending');
  assert.equal(result.evaluation.observations.filter(item => item.qualification === 'qualified').length, 1);
  assert.equal(result.evaluation.pendingComparisonMemoryIds.length, 1);
  const second = generatorFor();
  const completed = await process(f, second.generator);
  assert.equal(completed.status, 'proposal-pending', JSON.stringify(completed));
  assert.equal(second.calls.length, 1, 'successful evidence roles must not call the generator again');
  const input = second.calls[0].input;
  const snapshot = JSON.parse(input.slice(input.indexOf('{')));
  assert.deepEqual(snapshot.memories.map(memory => memory.id), result.evaluation.pendingComparisonMemoryIds);
  const ids = new Set(snapshot.memories.flatMap(memory => memory.sourceIds));
  assert.deepEqual(snapshot.sourceRecords.map(source => source.id).sort(), [...ids].sort());
});

test('one malformed perspective item does not discard an independent valid holder statement', async t => {
  const f = fixture(t, [['user', 'I am here for you.'], ['assistant', 'We can face challenges together.']]);
  const base = generatorFor();
  const generator = Object.assign(async request => {
    const result = await base.generator(request);
    const analyses = result.output.results?.perspectiveDirection?.analyses;
    if (analyses?.length > 1) analyses[1].attribution = 'invalid-attribution';
    return result;
  }, { supportsCombinedStateAnalysis: true });
  const result = await process(f, generator);
  assert.equal(result.status, 'proposal-pending');
  assert.equal(result.evaluation.status, 'partial');
  assert.equal(result.evaluation.rejected.perspectiveDirection.length, 1);
  assert.equal(result.evaluation.observations.length, 1);
  assert.deepEqual(result.evaluation.counterpartRequests, []);
});
