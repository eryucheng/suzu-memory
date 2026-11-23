import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase, proposePreferenceState,
  resolvePreferenceStateProposal, materializePreferenceStateProposal } from '@suzu-memory/core';
import { processPendingStateAnalysisRequests, processStateAnalysisRequest, accumulateInferredPreference,
  reconcileInferredPreferences, DEFAULT_PREFERENCE_FORMATION_POLICY } from '../src/index.mjs';
import { buildReviewProposalDetail } from '../../service/src/review-console.mjs';

function bindSemanticWorld(fixture, request, world) {
  const draft = fixture.repository.upsertMemory({ id: `semantic-${request.id}`, agentId: request.agent_id,
    kind: 'derived_hypothesis', layer: 'provisional', status: 'archived', title: 'Preference draft', content: 'A fixed preference draft.',
    subjectRole: request.subject_role, subjectKey: request.subject_key, canonicalKey: request.canonical_key,
    stateFamily: 'preference', representationLayer: 'inferred', evidenceMode: 'inferred', ...world,
    metadata: { stateAnalysisDraft: true, stateAnalysisRequestId: request.id } });
  fixture.repository.database.prepare('UPDATE memory_state_analysis_requests SET metadata_json=? WHERE agent_id=? AND id=?')
    .run(JSON.stringify({ ...request.metadata, semanticMemoryId: draft.id }), request.agent_id, request.id);
  return fixture.repository.getStateAnalysisRequest(request.agent_id, request.id);
}

function setup(t, { archiveCandidate = false } = {}) {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const fixtures = new Map();
  let calls = 0;
  function add(index, { day = 10, space = 'reading-room', holder = 'suzu', constraint = 'none', alternatives = 'available',
    behaviorType = 'choice', evidenceMode = 'inferred', expressionType = 'none', objectLabel = '推理小说', sourceTimeKnown = true,
    reportedByUser = false } = {}) {
    const at = `2026-09-${day}T12:00:0${index % 10}.000Z`;
    const speaker = reportedByUser ? 'reader' : holder;
    const speakerRole = reportedByUser ? 'user' : 'agent';
    const subjectRole = reportedByUser ? 'other' : 'agent';
    const batchId = `batch-${index}`;
    const source = repository.upsertSource({ agentId: 'owner', sourceKind: 'transcript-message', externalId: `source-${index}`,
      occurredAt: at, knownAt: at, speaker, content: `${holder} 在有其他选项时主动选了推理小说。`,
      metadata: { eventSource: { spaceId: space }, sourceTimeKnown } });
    const memory = repository.upsertMemory({ id: `evidence-${index}`, agentId: 'owner', kind: 'utterance', layer: 'evidence',
      subjectRole: speakerRole, subjectKey: speaker, reality: 'real', evidenceMode: 'imported', temporalState: 'historical',
      content: source.content, eventStart: at, knownAt: at, metadata: { sourceTimeKnown },
      actorRoles: [{ role: 'speaker', actorRole: speakerRole, actorKey: speaker, isPrimary: true, confidence: 1 }] });
    repository.linkSource(memory.id, source.id, 'verbatim', { authority: 'verbatim_record', sourceTrust: 1, evidenceStrength: 1 });
    const decision = reportedByUser ? repository.recordIngestionDecision({ agentId: 'owner', batchId, candidateIndex: 0,
      decision: 'store', resultStatus: 'analysis_pending', sourceIds: [source.id], knownAt: at,
      candidate: { subjectRole, subjectKey: holder, subjectName: holder, ...(archiveCandidate && {
        kind: 'preference', stateFamily: 'preference', title: `${holder}选择了推理小说`, content: source.content,
        reality: 'real', temporalState: 'current', evidenceMode, actorRoles: [], confidence: 0.95,
      }) } }) : null;
    const request = repository.recordStateAnalysisRequest({ agentId: 'owner', batchId, candidateIndex: 0,
      stateFamily: 'preference', subjectRole, subjectKey: holder, canonicalKey: 'preference:mystery-novels',
      targetLabel: '推理小说', representationLayer: evidenceMode === 'explicit' ? 'reported' : 'inferred', evidenceMode,
      memoryIds: [memory.id], sourceIds: [source.id],
      metadata: { subjectName: holder, ...(decision && { ingestionDecisionId: decision.id }) }, createdAt: at });
    fixtures.set(request.id, { memory, source, request, constraint, alternatives, behaviorType, expressionType, objectLabel });
    return request;
  }
  const generator = async ({ stateAnalysisRequestId, analyzerRole, schemaName, input }) => {
    calls++;
    assert.equal(analyzerRole, 'combined-evidence');
    const f = fixtures.get(stateAnalysisRequestId);
    const common = { memoryId: f.memory.id, sourceIds: [f.source.id], confidence: 0.95, rationale: '原文支持。' };
    const analysis = { results: {
      objectGrounding: { analyses: [{ ...common, targetMatch: 'exact', matchedLabel: f.objectLabel }] },
      explicitExpression: { analyses: f.expressionType === 'none' ? [] : [{ ...common, expressionType: f.expressionType, directness: 'explicit_self_statement' }] },
      behaviorConditions: { analyses: [{ ...common, behaviorType: f.behaviorType, agency: 'self_initiated', constraint: f.constraint,
        alternatives: f.alternatives, instrumentalGoal: 'none', opportunityCost: 'none', canDecline: 'yes' }] },
      sharingAffect: { analyses: [] },
      timeScope: { analyses: [{ ...common, stateTime: 'current', occurrencePattern: 'single', scopeKind: 'exact_object',
        scopeLabel: f.objectLabel, contextLabel: '', revisionCue: 'none' }] },
    } };
    const output = schemaName === 'memory-state-match-analysis-v1' ? { analysis, stateMatch: {
      resolution: 'matched', candidateId: JSON.parse(input.slice(input.indexOf('{'))).stateCandidates[0].id,
      rationale: '同一主体选择同类小说。',
    } } : analysis;
    return { output, model: 'test', metadata: { provider: 'test' } };
  };
  generator.supportsCombinedStateAnalysis = true;
  const run = () => processPendingStateAnalysisRequests({ repository, agentId: 'owner', generator, maxRequests: 10 });
  return { repository, add, run, generator, fixtures, calls: () => calls };
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
  const applied = f.repository.getMemory(result.preferenceProposal.resultMemoryId);
  assert.equal(f.repository.listPendingProvisionalMemories('owner').length, 0);
  assert.match(applied.content, /推理小说.*稳定偏好/u);
  assert.equal(applied.representation_layer, 'inferred');
  assert.equal(applied.status, 'active');
  assert.equal(f.repository.getMemoryDetail('owner', applied.id).sources.length, 3);
  const repeated = accumulateInferredPreference({ repository: f.repository, request });
  assert.equal(repeated.status, 'already-reviewed');
  assert.equal(f.repository.listPreferenceStateProposals('owner').length, 1);
  assert.equal((await f.run()).selected, 0);
  assert.equal(f.calls(), 3);
  const detail = buildReviewProposalDetail({ repository: f.repository, agentId: 'owner',
    envelope: { type: 'preference-state', proposal: result.preferenceProposal } });
  assert.equal(detail.evidence.length, 3);
  assert.equal(detail.writePreview.proposedLevel, 'stable_preference');
  assert.equal(detail.permissions.canDismiss, true);
  resolvePreferenceStateProposal(f.repository, { agentId: 'owner', proposalId: result.preferenceProposal.id, action: 'dismiss' });
  assert.equal(f.repository.getMemory(applied.id).status, 'deleted');
  accumulateInferredPreference({ repository: f.repository, request });
  assert.equal(f.repository.listPendingProvisionalMemories('owner').length, 0);
});

test('accumulates attributed third-party behavior and preserves the speaker and evidence lifecycle', async t => {
  const f = setup(t);
  const holder = 'Rae';
  const target = { agentId: 'owner', subjectRole: 'other', subjectKey: holder, canonicalKey: 'preference:mystery-novels',
    stateFamily: 'preference', representationLayer: 'inferred' };
  let result;
  for (const [index, day, space] of [[1, 10, 'library'], [2, 10, 'book-club'], [3, 11, 'reading-room']]) {
    const request = f.add(index, { day, space, holder, reportedByUser: true });
    result = await processStateAnalysisRequest({ repository: f.repository, agentId: target.agentId, requestId: request.id,
      generator: f.generator });
    assert.equal(result.status, index === 1 ? 'completed-without-proposal' : 'proposal-pending', result.reason);
  }
  const proposal = result.preferenceProposal;
  const current = () => f.repository.getCurrentCanonicalMemory(target);
  assert.equal(proposal.review_state, 'pending');
  assert.equal(current()?.id, proposal.resultMemoryId);
  assert.equal(current()?.metadata.preferenceStateLevel, 'stable_preference');
  assert.equal(proposal.evidence.length, 3);
  for (const item of proposal.evidence) {
    const raw = f.repository.getMemoryDetail(target.agentId, item.memoryId);
    assert.equal(raw.memory.subject_role, 'user');
    assert.equal(raw.memory.subject_key, 'reader');
    assert.ok(raw.roles.some(role => role.role === 'speaker' && role.actor_key === 'reader'));
    assert.deepEqual(item.sourceIds, raw.sources.map(source => source.id));
  }
  const evidence = proposal.evidence.map(item => item.label);
  const proposalInput = { ...target, subjectLabel: holder, objectLabel: '推理小说',
    proposedLevel: 'stable_preference', previewStatus: 'stable-preference-review',
    policyVersion: proposal.policy_version, evidenceReviewMode: 'full_canonical', metadata: proposal.metadata };
  assert.throws(() => proposePreferenceState(f.repository, { ...proposalInput,
    evidence: [{ ...evidence[0], observationId: evidence[1].observationId }, ...evidence.slice(1)] }),
    /belongs to a different subject/u, 'An observation for another utterance cannot authorize this evidence.');

  const proposalCount = f.repository.listPreferenceStateProposals(target.agentId).length;
  reconcileInferredPreferences({ repository: f.repository, agentId: target.agentId });
  assert.equal(current()?.id, proposal.resultMemoryId);
  assert.equal(f.repository.listPreferenceStateProposals(target.agentId).length, proposalCount);
  resolvePreferenceStateProposal(f.repository, { agentId: target.agentId, proposalId: proposal.id, action: 'accept' });
  assert.equal(current()?.id, proposal.resultMemoryId);
  resolvePreferenceStateProposal(f.repository, { agentId: target.agentId, proposalId: proposal.id, action: 'dismiss' });
  const surviving = current();
  assert.equal(surviving?.metadata.preferenceStateLevel, 'selection_tendency');
  reconcileInferredPreferences({ repository: f.repository, agentId: target.agentId });
  assert.equal(current()?.id, surviving.id);
  assert.equal(f.repository.getMemory(proposal.resultMemoryId).status, 'deleted');

  const [observation] = f.repository.listStateEvidenceObservations(target.agentId, {
    ...target, memoryId: 'evidence-1',
  });
  f.repository.withdrawStateEvidenceObservation({ agentId: target.agentId, observationId: observation.id });
  assert.throws(() => proposePreferenceState(f.repository, { ...proposalInput, evidence }),
    /belongs to a different subject/u, 'A withdrawn observation cannot authorize the old evidence.');
  reconcileInferredPreferences({ repository: f.repository, agentId: target.agentId });
  assert.equal(f.repository.getMemory(surviving.id).status, 'deleted');
  assert.equal(current()?.metadata.preferenceStateLevel, 'selection_tendency');
  assert.equal(f.repository.getMemoryDetail(target.agentId, current().id).sources.length, 2);
  assert.equal(f.calls(), 3);
});

test('fixed semantic worlds keep effective preference versions and their audit history independent', async t => {
  const f = setup(t);
  const story = { reality: 'fictional', worldId: 'story-a', worldFrame: 'fictional' };
  for (const [index,day,space] of [[1,10,'library'],[2,10,'reading-room'],[3,11,'club']]) {
    bindSemanticWorld(f, f.add(index,{day,space}), story); await f.run();
  }
  let pending = f.repository.listPreferenceStateProposals('owner', { reviewStates: ['pending'] });
  const oldStory = pending.find(item => f.repository.getMemory(item.resultMemoryId)?.status === 'active');
  assert.ok(oldStory);
  const storyEvidence = f.repository.listStateEvidenceObservations('owner', { stateFamily: 'preference', world: story, limit: 100 });
  assert.equal(storyEvidence.length, 3);
  for (const observation of storyEvidence) {
    assert.deepEqual(observation.world, story);
    assert.deepEqual(f.repository.getStateEvidenceObservation('owner', observation.id).world, story);
    assert.equal(f.repository.getMemory(observation.memory_id).reality, 'real');
  }
  for (const [index,day,space] of [[4,12,'library'],[5,12,'reading-room'],[6,13,'club']]) { f.add(index,{day,space}); await f.run(); }
  pending = f.repository.listPreferenceStateProposals('owner', { reviewStates: ['pending'] });
  const real = pending.find(item => {
    const memory = f.repository.getMemory(item.resultMemoryId);
    return memory?.status === 'active' && memory.reality === 'real';
  });
  assert.ok(real);
  const next = bindSemanticWorld(f, f.add(7,{day:14,space:'story-club'}), story);
  const result = (await f.run()).results[0];
  assert.equal(result.status, 'proposal-pending');
  assert.equal(result.preferenceProposal.evidence.length, 4);
  assert.equal(f.repository.getPreferenceStateProposal('owner', oldStory.id).review_state, 'pending');
  assert.equal(f.repository.getMemory(oldStory.resultMemoryId).status, 'superseded');
  assert.equal(f.repository.getPreferenceStateProposal('owner', real.id).review_state, 'pending');
  assert.deepEqual(result.preferenceProposal.metadata.observationIds.sort(),
    f.repository.listStateEvidenceObservations('owner', { stateFamily: 'preference', world: story, limit: 100 }).map(item => item.id).sort());
  assert.equal(f.repository.listStateEvidenceObservations('owner', { stateFamily: 'preference', world: story, limit: 1 })[0].memory_id, next.memoryIds[0]);
  assert.equal(f.calls(), 7);
});

test('observation world owner supports legacy run provenance and falls back without accepting another Agent semantic ID', async t => {
  const f = setup(t); const request = bindSemanticWorld(f, f.add(1), { reality: 'fictional', worldId: 'story', worldFrame: 'fictional' });
  await f.run();
  let observation = f.repository.listStateEvidenceObservations('owner', { stateFamily: 'preference', limit: 1 })[0];
  assert.equal(observation.world.reality, 'fictional');
  const legacyScope = { ...observation.scope }; delete legacyScope.world;
  f.repository.database.prepare('UPDATE memory_state_evidence_observations SET scope_json=? WHERE id=?')
    .run(JSON.stringify(legacyScope), observation.id);
  const payload = { ...observation.payload }; delete payload.analysisRequest;
  f.repository.database.prepare('UPDATE memory_state_evidence_observations SET payload_json=? WHERE id=?').run(JSON.stringify(payload), observation.id);
  assert.equal(f.repository.getStateEvidenceObservation('owner', observation.id).world.reality, 'fictional');
  const foreign = f.repository.upsertMemory({ id: 'foreign-semantic', agentId: 'other', kind: 'fact', layer: 'provisional', content: 'Other Agent draft.',
    reality: 'fictional', worldId: 'foreign-story', worldFrame: 'fictional', metadata: { stateAnalysisDraft: true, stateAnalysisRequestId: request.id } });
  f.repository.database.prepare('UPDATE memory_state_analysis_requests SET metadata_json=? WHERE id=?').run(JSON.stringify({ semanticMemoryId: foreign.id }), request.id);
  observation = f.repository.getStateEvidenceObservation('owner', observation.id);
  assert.equal(observation.world.reality, 'real');
  assert.equal(f.repository.getStateAnalysisRequestSemanticMemory('owner', request.id), null);
  assert.equal(f.repository.listStateEvidenceObservations('owner', { stateFamily: 'preference', world: { reality: 'fictional', worldId: 'foreign-story', worldFrame: 'fictional' }, limit: 1 }).length, 0);
  assert.equal(f.repository.listStateEvidenceObservations('owner', { stateFamily: 'preference', world: { reality: 'real', worldId: 'another-room', worldFrame: 'physical' }, limit: 1 }).length, 1);
});

test('repeated days in one space do not satisfy distinct context support', async t => {
  const f = setup(t);
  for (let index = 1; index <= 3; index++) { f.add(index, { day: 10 + index }); await f.run(); }
  assert.equal(f.repository.listPreferenceStateProposals('owner').length, 0);
});

for (const interrupted of [false, true]) test(`upgrading accepted day-context preferences retires unsupported versions, interrupted ${interrupted}`, async t => {
  const f = setup(t);
  for (let index = 1; index <= 3; index++) { f.add(index, { day: 10 + index }); await f.run(); }
  const observations = f.repository.listStateEvidenceObservations('owner', { stateFamily: 'preference', limit: 100 })
    .sort((a, b) => a.memory_id.localeCompare(b.memory_id));
  const evidence = observations.map(item => ({ ...item.payload.legacySimulation,
    memoryId: item.memory_id, sourceIds: item.sourceIds, subjectRole: 'agent', subjectKey: 'suzu',
    evidenceGroupId: item.evidence_group_id, contextId: `day:${item.observed_at.slice(0, 10)}`,
    eventTime: item.observed_at, confidence: item.confidence, signal: item.signal }));
  const args = { agentId: 'owner', subjectRole: 'agent', subjectKey: 'suzu', canonicalKey: 'preference:mystery-novels',
    subjectLabel: 'Suzu', objectLabel: '推理小说', policyVersion: DEFAULT_PREFERENCE_FORMATION_POLICY.version,
    evidenceReviewMode: 'full_canonical' };
  const old = [];
  for (const [count, proposedLevel, previewStatus] of [[2, 'selection_tendency', 'selection-tendency'], [3, 'stable_preference', 'stable-preference-review']]) {
    const proposal = proposePreferenceState(f.repository, { ...args, proposedLevel, previewStatus, evidence: evidence.slice(0, count),
      metadata: { accumulatedPreference: true, observationHashes: observations.slice(0, count).map(item => ({ id: item.id, hash: item.observation_hash })) } });
    resolvePreferenceStateProposal(f.repository, { agentId: args.agentId, proposalId: proposal.id, action: 'accept' });
    old.push(proposal);
  }
  // Match the accepted day-fallback format reproduced with the shipped implementation.
  for (const proposal of old) {
    f.repository.database.prepare(`UPDATE memory_preference_state_proposals
      SET metadata_json=json_remove(metadata_json, '$.preferenceApplication') WHERE id=?`).run(proposal.id);
    f.repository.database.prepare("UPDATE memory_nodes SET metadata_json=json_remove(metadata_json, '$.reportedStateTransitionId') WHERE id=?")
      .run(proposal.resultMemoryId);
  }
  if (interrupted) {
    const remove = f.repository.setMemoryDeleted.bind(f.repository);
    f.repository.setMemoryDeleted = input => {
      if (old.some(proposal => proposal.resultMemoryId === input.memoryId)) throw new Error('legacy-state-write-failed');
      return remove(input);
    };
    try {
      assert.throws(() => reconcileInferredPreferences({ repository: f.repository, agentId: args.agentId }), /legacy-state-write-failed/u);
    } finally { f.repository.setMemoryDeleted = remove; }
    for (const proposal of old) assert.equal(f.repository.getPreferenceStateProposal(args.agentId, proposal.id).resultMemoryId,
      proposal.resultMemoryId, 'An interrupted upgrade preserves the saved version ownership for retry.');
  }
  reconcileInferredPreferences({ repository: f.repository, agentId: args.agentId });
  assert.equal(f.repository.getCurrentCanonicalMemory({ ...args, representationLayer: 'inferred', stateFamily: 'preference' }), null);
  for (const proposal of old) {
    assert.equal(f.repository.getMemory(proposal.resultMemoryId).status, 'deleted');
    const saved = f.repository.getPreferenceStateProposal(args.agentId, proposal.id);
    assert.equal(saved.review_state, 'accepted');
    assert.equal(saved.resultMemoryId, '');
    assert.equal(materializePreferenceStateProposal(f.repository, { agentId: args.agentId, proposalId: proposal.id }).memory, null);
  }
  reconcileInferredPreferences({ repository: f.repository, agentId: args.agentId });
  assert.equal(f.repository.listStateEvidenceObservations('owner', { lifecycles: ['current'], limit: 100 }).length, 3);
  assert.equal(f.calls(), 3, 'Upgrade recomputes the recorded evidence without additional model analysis.');
  assert.equal(f.repository.getCurrentCanonicalMemory({ ...args, representationLayer: 'inferred', stateFamily: 'preference' }), null);
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

for (const editedFallback of [false, true]) test(`invalid past evidence defers only its conclusion, edited review ${editedFallback}`, async t => {
  const f = setup(t, { archiveCandidate: true });
  const agentId = 'owner';
  f.add(1, { holder: 'Rae', reportedByUser: true });
  await f.run();
  const [old] = f.repository.listStateEvidenceObservations(agentId, { subjectKey: 'Rae' });
  // Simulate an older signal that this version cannot use for preference formation.
  f.repository.database.prepare('UPDATE memory_state_evidence_observations SET signal=? WHERE id=?').run('obsolete-choice', old.id);
  const affected = f.add(2, { holder: 'Rae', reportedByUser: true, day: 11, space: 'club' });
  const healthy = f.add(3, { holder: 'Jo', reportedByUser: true });
  const batch = await f.run();
  const [review, other] = [affected, healthy].map(request => batch.results.find(item => item.request?.id === request.id));
  assert.equal(batch.status, 'completed');
  assert.equal(review.status, 'provisional-review', review.reason);
  assert.equal(review.ingestionDecision.review_state, 'pending');
  assert.match(review.request.error_message, /obsolete-choice/u);
  assert.equal(other.status, 'completed-without-proposal');
  assert.equal(f.calls(), 3, JSON.stringify(batch.results.map(({ status, reason, attempts }) => ({ status, reason, attempts }))));
  const observationId = review.merged.observations[0].id;
  const [evidence] = f.repository.listMemories(agentId, { statuses: ['active'], limit: 100 }).items.filter(row => (
    row.metadata.preferenceEvidence?.observationId === observationId
  ));
  assert.ok(evidence, 'The newly validated behavior remains available while its aggregate is under review.');
  if (editedFallback) f.repository.editMemoryManually({ agentId, memoryId: review.provisional.id, patch: { title: '待人工整理的证据' } });

  f.repository.withdrawStateEvidenceObservation({ agentId, observationId: old.id });
  f.add(4, { holder: 'Rae', reportedByUser: true, day: 12, space: 'reading-room' });
  const resumed = (await f.run()).results[0];
  assert.equal(resumed.preferenceProposal.review_state, 'pending');
  assert.equal(f.repository.getMemory(resumed.preferenceProposal.resultMemoryId).status, 'active');
  const decision = f.repository.getIngestionDecision(agentId, review.ingestionDecision.id);
  const fallback = f.repository.getMemory(review.provisional.id);
  if (editedFallback) {
    assert.equal(decision.review_state, 'pending');
    assert.equal(fallback.title, '待人工整理的证据');
    assert.equal(fallback.status, 'archived');
  } else {
    assert.equal(decision.resolved_by, 'preference-accumulation');
    assert.equal(fallback.status, 'deleted');
  }
  assert.equal(f.repository.getMemory(evidence.id).status, 'active');
  assert.equal(f.calls(), 4);
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

test('updated evidence advances the effective version while preserving its pending audit history', async t => {
  const f = setup(t);
  f.add(1); await f.run();
  f.add(2, { day: 11, space: 'club' });
  const early = (await f.run()).results[0].preferenceProposal;
  assert.equal(early.proposed_level, 'selection_tendency');
  f.add(3, { day: 12, space: 'club' });
  const latest = (await f.run()).results[0].preferenceProposal;
  assert.equal(latest.proposed_level, 'stable_preference');
  assert.equal(f.repository.getPreferenceStateProposal('owner', early.id).review_state, 'pending');
  assert.equal(f.repository.getMemory(early.resultMemoryId).status, 'superseded');
  assert.equal(f.repository.getMemory(latest.resultMemoryId).status, 'active');
  assert.equal(f.repository.listPendingProvisionalMemories('owner').length, 0);
  f.add(4, { day: 13, space: 'other-club', behaviorType: 'avoidance' });
  const conflict = (await f.run()).results[0];
  assert.equal(conflict.inferredPreference.preview.independentSupport, 3);
  assert.equal(conflict.inferredPreference.preview.status, 'conflicting-evidence');
  assert.equal(conflict.preferenceProposal.proposed_level, 'no_conclusion');
  assert.equal(f.repository.getMemory(latest.resultMemoryId).status, 'superseded');
  const uncertain = f.repository.getMemory(conflict.preferenceProposal.resultMemoryId);
  assert.equal(uncertain.status, 'active');
  assert.match(uncertain.content, /没有足够证据/u);
  resolvePreferenceStateProposal(f.repository, { agentId: 'owner', proposalId: conflict.preferenceProposal.id, action: 'dismiss' });
  assert.equal(f.repository.getMemory(latest.resultMemoryId).status, 'active');
});
