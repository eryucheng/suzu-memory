import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase, resolvePreferenceStateProposal } from '@suzu-memory/core';
import { processPendingStateAnalysisRequests, accumulateInferredPreference } from '../src/index.mjs';
import { buildReviewProposalDetail } from '../../service/src/review-console.mjs';

function setup(t) {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const fixtures = new Map();
  let calls = 0;
  function add(index, { day = 10, space = 'reading-room', holder = 'suzu', constraint = 'none', alternatives = 'available',
    behaviorType = 'choice', evidenceMode = 'inferred', expressionType = 'none', objectLabel = '推理小说', sourceTimeKnown = true } = {}) {
    const at = `2026-09-${day}T12:00:0${index % 10}.000Z`;
    const source = repository.upsertSource({ agentId: 'owner', sourceKind: 'transcript-message', externalId: `source-${index}`,
      occurredAt: at, knownAt: at, speaker: holder, content: `${holder} 在有其他选项时主动选了推理小说。`,
      metadata: { eventSource: { spaceId: space }, sourceTimeKnown } });
    const memory = repository.upsertMemory({ id: `evidence-${index}`, agentId: 'owner', kind: 'utterance', layer: 'evidence',
      subjectRole: 'agent', subjectKey: holder, reality: 'real', evidenceMode: 'imported', temporalState: 'historical',
      content: source.content, eventStart: at, knownAt: at, metadata: { sourceTimeKnown },
      actorRoles: [{ role: 'speaker', actorRole: 'agent', actorKey: holder, isPrimary: true, confidence: 1 }] });
    repository.linkSource(memory.id, source.id, 'verbatim', { authority: 'verbatim_record', sourceTrust: 1, evidenceStrength: 1 });
    const request = repository.recordStateAnalysisRequest({ agentId: 'owner', batchId: `batch-${index}`, candidateIndex: 0,
      stateFamily: 'preference', subjectRole: 'agent', subjectKey: holder, canonicalKey: 'preference:mystery-novels',
      targetLabel: '推理小说', representationLayer: evidenceMode === 'explicit' ? 'reported' : 'inferred', evidenceMode,
      memoryIds: [memory.id], sourceIds: [source.id], metadata: { subjectName: holder }, createdAt: at });
    fixtures.set(request.id, { memory, source, request, constraint, alternatives, behaviorType, expressionType, objectLabel });
    return request;
  }
  const generator = async ({ stateAnalysisRequestId, analyzerRole }) => {
    calls++;
    assert.equal(analyzerRole, 'combined-evidence');
    const f = fixtures.get(stateAnalysisRequestId);
    const common = { memoryId: f.memory.id, sourceIds: [f.source.id], confidence: 0.95, rationale: '原文支持。' };
    return { output: { results: {
      objectGrounding: { analyses: [{ ...common, targetMatch: 'exact', matchedLabel: f.objectLabel }] },
      explicitExpression: { analyses: f.expressionType === 'none' ? [] : [{ ...common, expressionType: f.expressionType, directness: 'explicit_self_statement' }] },
      behaviorConditions: { analyses: [{ ...common, behaviorType: f.behaviorType, agency: 'self_initiated', constraint: f.constraint,
        alternatives: f.alternatives, instrumentalGoal: 'none', opportunityCost: 'none', canDecline: 'yes' }] },
      sharingAffect: { analyses: [] },
      timeScope: { analyses: [{ ...common, stateTime: 'current', occurrencePattern: 'single', scopeKind: 'exact_object',
        scopeLabel: f.objectLabel, contextLabel: '', revisionCue: 'none' }] },
    } }, model: 'test', metadata: { provider: 'test' } };
  };
  generator.supportsCombinedStateAnalysis = true;
  const run = () => processPendingStateAnalysisRequests({ repository, agentId: 'owner', generator, maxRequests: 10 });
  return { repository, add, run, fixtures, calls: () => calls };
}

test('accumulates three independent choices across days and spaces with one model call per batch', async t => {
  const f = setup(t);
  f.add(1);
  let report = await f.run();
  assert.equal(report.results[0].inferredPreference.preview.status, 'behavior-only');
  assert.equal(f.repository.listPendingProvisionalMemories('owner').length, 0);
  f.add(2);
  await f.run();
  assert.equal(f.repository.listPreferenceStateProposals('owner').length, 0);
  const request = f.add(3, { day: 11, space: 'book-club' });
  report = await f.run();
  assert.equal(f.calls(), 3);
  const result = report.results[0];
  assert.equal(result.status, 'proposal-pending');
  assert.equal(result.preferenceProposal.proposed_level, 'stable_preference');
  assert.equal(result.preferenceProposal.evidence.length, 3);
  assert.equal(result.inferredPreference.preview.distinctSupportDays, 2);
  assert.equal(result.inferredPreference.preview.distinctSupportContexts, 2);
  const pending = f.repository.listPendingProvisionalMemories('owner');
  assert.equal(pending.length, 1);
  assert.match(pending[0].content, /推理小说.*稳定偏好/u);
  assert.equal(pending[0].representation_layer, 'inferred');
  assert.equal(f.repository.getMemoryDetail('owner', pending[0].id).sources.length, 3);
  const repeated = accumulateInferredPreference({ repository: f.repository, request });
  assert.equal(repeated.proposal.id, result.preferenceProposal.id);
  assert.equal(f.repository.listPreferenceStateProposals('owner').length, 1);
  assert.equal((await f.run()).selected, 0);
  assert.equal(f.calls(), 3);
  const detail = buildReviewProposalDetail({ repository: f.repository, agentId: 'owner',
    envelope: { type: 'preference-state', proposal: result.preferenceProposal } });
  assert.equal(detail.evidence.length, 3);
  assert.equal(detail.writePreview.proposedLevel, 'stable_preference');
  assert.equal(detail.permissions.canDismiss, true);
  resolvePreferenceStateProposal(f.repository, { agentId: 'owner', proposalId: result.preferenceProposal.id, action: 'dismiss' });
  assert.equal(f.repository.getMemory(pending[0].id).status, 'deleted');
  accumulateInferredPreference({ repository: f.repository, request });
  assert.equal(f.repository.listPendingProvisionalMemories('owner').length, 0);
});

test('repeated days in one space do not satisfy distinct context support', async t => {
  const f = setup(t);
  for (let index = 1; index <= 3; index++) { f.add(index, { day: 10 + index }); await f.run(); }
  assert.equal(f.repository.listPreferenceStateProposals('owner').length, 0);
});

test('unknown behavior contexts retain unresolved evidence without retrying specialist calls', async t => {
  const f = setup(t);
  const request = f.add(1, { space: '', sourceTimeKnown: false });
  const report = await f.run();
  assert.equal(f.calls(), 1);
  assert.equal(report.results[0].automaticRetries, 0);
  assert.equal(report.results[0].status, 'completed-without-proposal');
  const [observation] = f.repository.listStateEvidenceObservations('owner');
  assert.equal(observation.context_id, '');
  assert.equal(observation.qualification, 'unresolved');
  assert.equal(observation.excluded_reason, 'missing-behavior-context');
  assert.equal(observation.effective_direction, 'neutral');
  assert.equal(f.repository.getStateAnalysisRequest('owner', request.id).metadata.attemptCount, undefined);
  assert.equal(f.repository.listPreferenceStateProposals('owner').length, 0);
  assert.equal((await f.run()).selected, 0);
  assert.equal(f.calls(), 1);
});

test('an explicit preference does not require a known calendar day or behavior context', async t => {
  const f = setup(t);
  f.add(1, { space: '', sourceTimeKnown: false, evidenceMode: 'explicit', expressionType: 'likes' });
  const report = await f.run();
  assert.equal(f.calls(), 1);
  assert.equal(report.results[0].automaticRetries, 0);
  assert.equal(report.results[0].status, 'proposal-pending');
  const [observation] = f.repository.listStateEvidenceObservations('owner');
  assert.equal(observation.context_id, '');
  assert.equal(observation.qualification, 'qualified');
  assert.equal(observation.signal, 'explicit_preference');
});

test('constrained choices, missing alternatives and other holders do not inflate support', async t => {
  const f = setup(t);
  f.add(1);
  f.add(2, { day: 11, space: 'club', alternatives: 'unknown' });
  f.add(3, { day: 12, space: 'club', holder: 'mio' });
  f.add(4, { day: 12, space: 'club', behaviorType: 'exposure' });
  f.add(5, { day: 12, space: 'club', constraint: 'work' });
  const report = await f.run();
  assert.equal(report.results.length, 5);
  assert.equal(f.repository.listPreferenceStateProposals('owner').length, 0);
  const ledger = f.repository.listStateEvidenceObservations('owner');
  assert.ok(ledger.some(item => item.excluded_reason === 'no-verified-alternative-choice'));
  assert.ok(ledger.some(item => item.excluded_reason === 'non-qualifying-passive-exposure'));
  assert.ok(ledger.some(item => item.excluded_reason === 'blocked-by-work-constraint'));
});

test('accepting an inferred proposal preserves a reported state and removes its provisional copy', async t => {
  const f = setup(t);
  const reported = f.repository.upsertMemory({ id: 'reported-preference', agentId: 'owner', kind: 'preference', layer: 'semantic',
    content: 'Suzu 明确说喜欢推理小说。', subjectRole: 'agent', subjectKey: 'suzu', canonicalKey: 'preference:mystery-novels',
    representationLayer: 'reported', stateFamily: 'preference', evidenceMode: 'explicit', temporalState: 'current',
    statePhase: 'active', reality: 'real', knownAt: '2026-09-09T00:00:00.000Z', validFrom: '2026-09-09T00:00:00.000Z' });
  f.add(1); await f.run();
  f.add(2); await f.run();
  const request = f.add(3, { day: 11, space: 'club' });
  const report = await f.run();
  const proposal = report.results[0].preferenceProposal;
  const accepted = resolvePreferenceStateProposal(f.repository, { agentId: 'owner', proposalId: proposal.id, action: 'accept' });
  assert.equal(accepted.memory.representation_layer, 'inferred');
  assert.equal(accepted.memory.kind, 'derived_hypothesis');
  assert.equal(f.repository.listPendingProvisionalMemories('owner').length, 0);
  assert.equal(f.repository.getMemoryDetail('owner', accepted.memory.id).sources.length, 3);
  assert.equal(f.repository.getMemory(reported.id).status, 'active');
  assert.equal(accumulateInferredPreference({ repository: f.repository, request }).status, 'already-reviewed');
  assert.equal(f.repository.listPreferenceStateProposals('owner').length, 1);
});

test('updated evidence replaces an older pending inference without accumulating pending copies', async t => {
  const f = setup(t);
  f.add(1); await f.run();
  f.add(2, { day: 11, space: 'club' });
  const early = (await f.run()).results[0].preferenceProposal;
  assert.equal(early.proposed_level, 'selection_tendency');
  f.add(3, { day: 12, space: 'club' });
  const latest = (await f.run()).results[0].preferenceProposal;
  assert.equal(latest.proposed_level, 'stable_preference');
  assert.equal(f.repository.getPreferenceStateProposal('owner', early.id).review_state, 'dismissed');
  assert.equal(f.repository.listPendingProvisionalMemories('owner').length, 1);
});
