import { extractionModelFixture } from '../../../test/support/extraction-fixtures.mjs';
import { createTestDirectory, closeAfterTests } from '../../../test/support/suite-resources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getEventSourceCleanup, PreferenceStateValidationError } from '@suzu-memory/core';
import { createMemoryService } from '../src/index.mjs';

for (const version of [1, 2]) test(`older preference cleanup resumes after a newer source fence, protocol ${version}`, async () => {
  const dataRoot = createTestDirectory(path.join(os.tmpdir(), 'preference-cleanup-'));
  const agentId = 'owner', owner = 'product-events', spaceId = 'direct';
  const options = { dataRoot, agentId, defaults: { primaryUserId: 'human-a' } };
  const memory = closeAfterTests(createMemoryService(options));
  const scope = (upperBound, cleared = 0) => version === 1
    ? { agentId, owner, eventUpperBound: upperBound, clears: cleared ? [{ spaceId, throughSequence: cleared }] : [] }
    : { version, agentId, owner, agentGeneration: 1, experienceUpperBound: upperBound,
      globalEventUpperBound: upperBound, contentRevision: cleared, clearedThroughExperienceSequence: cleared };
  const statements = ['I chose herbal tea at lunch.', 'The temperature dropped.', 'Museum tickets are in the drawer.'];
  memory.appendEventSources({ scope: scope(3), events: statements.map((text, index) => {
    const eventId = `message-${index + 1}`;
    return { occurredAt: '2026-09-12T12:00:00.000Z', content: { text }, source: {
      version, owner, recipientAgentId: agentId, eventId, commitSequence: index + 1, spaceId,
      eventType: 'message.created', sender: { kind: 'local-user', id: 'human-a' }, topology: { kind: 'space' },
      ...(version === 2 ? { agentGeneration: 1, experienceRef: {
        experienceId: `experience-${index + 1}`, experienceSequence: index + 1, itemIndex: 0, sourceEventId: eventId,
      } } : {}),
    } };
  }) });
  await memory.processPendingEvents({ maximumEvents: 3, sourceScope: scope(3), memoriesOverride: [] });
  memory.withRepository(repository => {
    const first = repository.listMemories(agentId, { kinds: ['utterance'], statuses: ['active'] }).items
      .find(item => item.content === statements[0]);
    const sources = repository.listMemorySources(first.id);
    repository.recordStateEvidenceObservation({ agentId, stateFamily: 'preference', subjectRole: first.subject_role,
      subjectKey: first.subject_key, canonicalKey: 'herbal-tea', memoryId: first.id, evidenceGroupId: 'lunch-1',
      signal: 'active_choice', claimedDirection: 'support', effectiveDirection: 'support', qualification: 'qualified',
      origin: 'deterministic', sourceIds: sources.map(item => item.id), payloadSchemaVersion: 'preference-import-v1',
      scope: { currentRepresentationLayer: 'inferred' } });
  });
  const originalScope = scope(1, 1);
  assert.throws(() => memory.eraseEventSources({ id: 'first', scope: originalScope,
    onProgress: job => { if (job.phase === 'database-cleaned') throw new Error('cleanup interruption'); },
  }), /cleanup interruption/u);
  assert.equal(memory.getEventSourceCleanup('first').result.pendingPreferenceTargets.length, 1);
  assert.equal(memory.eraseEventSources({ id: 'second', scope: scope(3, 2) }).complete, true);
  await memory.close();

  const reopened = closeAfterTests(createMemoryService(options));
  assert.equal(reopened.initialize().status, 'ready');
  const recovered = reopened.getEventSourceCleanup('first');
  assert.equal(recovered.complete, true);
  assert.deepEqual(recovered.result.pendingPreferenceTargets, []);
  assert.throws(() => reopened.getEventSourceProgress({ scope: originalScope }), { code: 'EVENT_SOURCE_SCOPE_STALE' });
  const active = reopened.listMemories({ kinds: ['utterance'], statuses: ['active'] }).items;
  assert.deepEqual(active.map(item => item.content), [statements[2]]);
});

test('invalid imported preference evidence cannot prevent reopening or rebuilding other preferences', async () => {
  fs.mkdirSync(os.tmpdir(), { recursive: true });
  const dataRoot = createTestDirectory(path.join(os.tmpdir(), 'preference-recovery-'));
  const agentId = 'owner';
  const options = { dataRoot, agentId };
  let memory = closeAfterTests(createMemoryService(options));
  const target = { subjectRole: 'agent', subjectKey: agentId, canonicalKey: 'a-invalid' };
  const validTarget = { ...target, canonicalKey: 'z-valid' };
  function importObservation(repository, { index, preference, label, signal = 'active_choice' }) {
    const at = `2026-09-${10 + index}T12:00:00.000Z`;
    const content = `有其他选项时，还是主动选了${label}。`;
    const source = repository.upsertSource({ agentId, sourceKind: 'transcript-message', externalId: `source-${index}`,
      content, occurredAt: at });
    const utterance = repository.upsertMemory({ agentId, id: `utterance-${index}`, ...preference,
      kind: 'utterance', layer: 'evidence', content, knownAt: at });
    repository.linkSource(utterance.id, source.id, 'verbatim');
    return repository.recordStateEvidenceObservation({ agentId, ...preference, stateFamily: 'preference',
      memoryId: utterance.id, sourceIds: [source.id], evidenceGroupId: `source-${index}`, contextId: `episode:${index}`,
      signal, origin: 'imported', claimedDirection: 'support', effectiveDirection: 'support',
      qualification: 'qualified', confidence: 0.95, observedAt: at,
      scope: { currentRepresentationLayer: 'inferred' }, payloadSchemaVersion: 'imported-preference-v1',
      payload: { objectGrounding: { targetMatch: 'exact', matchedLabel: label },
        timeScope: { scopeKind: 'exact_object' }, legacySimulation: { agency: 'self_initiated',
          constraint: 'none', alternatives: 'available', instrumentalGoal: 'none', opportunityCost: 'none' } },
    });
  }
  const invalid = memory.withRepository(repository => {
    const invalid = importObservation(repository, { index: 1, preference: target, label: '旧唱片', signal: 'obsolete-choice' });
    for (const index of [2, 3, 4]) importObservation(repository, { index, preference: validTarget, label: '版画' });
    return invalid;
  });
  await memory.close();
  memory = closeAfterTests(createMemoryService(options));

  const startup = memory.initialize();
  assert.equal(startup.status, 'ready');
  const [failure] = startup.inferredPreferenceReconciliation.failed;
  assert.equal(startup.inferredPreferenceReconciliation.failed.length, 1);
  assert.deepEqual(failure.target, target);
  assert.match(failure.error, /obsolete-choice/u);
  const [pending] = memory.listHighLevelProposals({ types: ['preference-state'] }).items;
  assert.equal(pending.proposal.review_state, 'pending');
  assert.equal(pending.proposal.canonical_key, validTarget.canonicalKey);
  const appliedId = pending.proposal.resultMemoryId;
  assert.equal(memory.getMemory(appliedId).memory.status, 'active');
  const recall = await memory.search('版画', { now: '2026-09-15T12:00:00.000Z', persistTrace: false });
  assert.ok(recall.graph.selectedMemoryIds.includes(appliedId), recall.context);
  assert.equal(memory.getMemory(invalid.memory_id).memory.status, 'active');

  memory.withRepository(repository => repository.withdrawStateEvidenceObservation({ agentId, observationId: invalid.id }));
  await memory.close();
  memory = closeAfterTests(createMemoryService(options));
  assert.deepEqual(memory.initialize().inferredPreferenceReconciliation.failed, []);
  assert.equal(memory.listHighLevelProposals({ types: ['preference-state'] }).items[0].proposal.resultMemoryId, appliedId);
});

test('attributed reports and single actions are independently recallable and retractable evidence', async () => {
  fs.mkdirSync(os.tmpdir(), { recursive: true });
  const dataRoot = createTestDirectory(path.join(os.tmpdir(), 'preference-evidence-'));
  const agentId = 'owner';
  const options = { dataRoot, agentId, defaults: { primaryUserId: 'human-a', userName: '小齐', memoryOwner: 'Suzu' } };
  let memory = closeAfterTests(createMemoryService(options));
  const scope = eventUpperBound => ({ owner: 'product-events', agentId, eventUpperBound, clears: [] });
  const inputs = [
    { text: '林岚说她排练结束后喜欢喝冰豆浆。', label: '冰豆浆', mode: 'explicit', type: 'likes', behavior: 'none' },
    { text: '在今天的聚餐上，我给林岚递了梨汁，她摆摆手没有接。', label: '梨汁', mode: 'inferred', type: 'none', behavior: 'avoidance' },
  ];
  const offers = [];
  for (const [index, item] of inputs.entries()) {
    const position = index + 1;
    const occurredAt = `2026-09-1${index}T12:00:00.000Z`;
    memory.appendEventSources({ scope: scope(position), events: [{
      occurredAt, content: { text: item.text },
      source: { version: 1, owner: 'product-events', recipientAgentId: agentId, eventId: `report-${position}`,
        commitSequence: position, spaceId: 'direct', eventType: 'message.created',
        sender: { kind: 'local-user', id: 'human-a', name: '小齐' }, topology: { kind: 'space' } },
    }] });
    const archived = await memory.processPendingEvents({ maximumEvents: 1, sourceScope: scope(position),
      generator: async () => ({ output: {
        entities: [{ ref: 'E1', kind: 'person', name: '林岚', aliases: [] }],
        memories: extractionModelFixture([{
          kind: 'preference', stateFamily: 'preference', stateLabel: item.label, title: `林岚与${item.label}`, content: item.text,
          subjectRole: 'other', subjectName: '林岚', actorRoles: [], canonicalKey: `drink-${position}`,
          evidenceMode: item.mode, reality: 'real', temporalState: 'current', revisionAction: 'add',
          eventDate: '', eventStart: '', eventEnd: '', confidence: 0.88, importance: 0.5, sourceRefs: ['M0001'],
        }]).map(candidate => ({ ...candidate, subject: { ref: 'E1' } })),
      } }) });
    assert.equal(archived.stateAnalysisRequestsQueued, 1, JSON.stringify(archived));
    const generator = Object.assign(async ({ stateAnalysisRequestId, schemaName }) => {
      const request = memory.withRepository(repository => repository.getStateAnalysisRequest(agentId, stateAnalysisRequestId));
      const entry = { memoryId: request.memoryIds[0], sourceIds: request.sourceIds, confidence: 0.92, rationale: '原话明确描述该人物与对象。' };
      const analysis = { results: {
        objectGrounding: { analyses: [{ ...entry, targetMatch: 'exact', matchedLabel: item.label }] },
        explicitExpression: { analyses: item.type === 'none' ? [] : [{ ...entry, expressionType: item.type, directness: 'explicit_reported_statement' }] },
        behaviorConditions: { analyses: item.behavior === 'none' ? [] : [{ ...entry, behaviorType: item.behavior,
          agency: 'self_initiated', constraint: 'none', alternatives: 'unknown', instrumentalGoal: 'none',
          opportunityCost: 'unknown', canDecline: 'yes' }] },
        sharingAffect: { analyses: [] },
        timeScope: { analyses: [{ ...entry, stateTime: 'current', occurrencePattern: item.behavior === 'none' ? 'habitual' : 'single',
          scopeKind: 'context_only', scopeLabel: item.label, contextLabel: item.behavior === 'none' ? '排练后' : '当天聚餐',
          revisionCue: 'none' }] },
      } };
      return { output: schemaName === 'memory-state-match-analysis-v1' ? { analysis,
        stateMatch: { resolution: 'new', candidateId: '', rationale: '另一个饮品。' } } : analysis };
    }, { supportsCombinedStateAnalysis: true });
    const result = await memory.runSemanticMaintenance({ generator, structureGenerator: null, processInputEvents: false,
      sourceScope: scope(position) });
    assert.deepEqual(result.failures, []);
    const details = memory.withRepository(repository => repository.listMemories(agentId, { statuses: ['active'], limit: 500 }).items
      .filter(row => row.metadata?.preferenceEvidence?.kind && row.content.includes(item.text))
      .map(row => repository.getMemoryDetail(agentId, row.id)));
    assert.equal(details.length, 1, 'The validated evidence is usable as soon as the analysis completes.');
    const [detail] = details;
    assert.equal(detail.memory.subject_role, 'other');
    assert.equal(detail.memory.state_family, 'unspecified', 'The source record has no authority over the current preference state.');
    assert.equal(detail.sources[0].speaker, '小齐');
    assert.equal(detail.sources[0].content, item.text);
    offers.push(detail.memory);
    const recall = await memory.search(`林岚 ${item.label}`, { sourceScope: scope(position), persistTrace: false, now: occurredAt });
    assert.ok(recall.graph.selectedMemoryIds.includes(detail.memory.id), recall.context);
    assert.match(recall.context, item.behavior === 'none' ? /转述/u : /单次行为/u);
  }

  const reportRawId = offers[0].metadata.preferenceEvidence.memoryId;
  memory.deleteMemory(reportRawId);
  assert.equal(memory.getMemory(offers[0].id).memory.status, 'archived');
  memory.restoreMemory(reportRawId);
  const restoredReport = await memory.search('林岚 冰豆浆', { sourceScope: scope(2), persistTrace: false,
    now: '2026-09-12T00:00:00Z' });
  assert.ok(restoredReport.graph.selectedMemoryIds.includes(offers[0].id));
  memory.deleteMemory(offers[0].id);
  memory.deleteMemory(reportRawId);
  memory.restoreMemory(reportRawId);
  await memory.close();
  memory = closeAfterTests(createMemoryService(options));
  assert.equal(memory.getMemory(offers[0].id).memory.status, 'deleted', 'A restart preserves the withdrawal.');
  assert.equal(memory.getMemory(offers[1].id).memory.status, 'active', 'Only the selected result is withdrawn.');
  const rawId = offers[1].metadata.preferenceEvidence.memoryId;
  memory.deleteMemory(rawId);
  assert.equal(memory.getMemory(offers[1].id).memory.status, 'archived', 'Deleting the original evidence retires its result.');
  assert.throws(() => memory.restoreMemory(offers[1].id), /original current observation and sources/u);
  memory.restoreMemory(rawId);
  assert.equal(memory.getMemory(offers[1].id).memory.status, 'active', 'Restoring an unchanged source restores its valid result.');
  memory.editMemory(rawId, { content: '当时林岚没有拒绝梨汁，我先前记错了。' });
  assert.equal(memory.getMemory(offers[1].id).memory.status, 'archived', 'Editing the original evidence invalidates its old analysis.');
  assert.throws(() => memory.restoreMemory(offers[1].id), /original current observation and sources/u);
  const result = memory.eraseEventSources({ id: 'erase-reported-drinks', scope: { ...scope(2), clears: [{ spaceId: 'direct', throughSequence: 2 }] } });
  assert.equal(result.complete, true);
  const after = await memory.search('林岚 梨汁', { sourceScope: { ...scope(2), clears: [{ spaceId: 'direct', throughSequence: 2 }] },
    persistTrace: false, now: '2026-09-12T00:00:00Z' });
  assert.ok(!after.context.includes('梨汁'), 'Removing the original source also removes the derived evidence.');
});

for (const [earlyEmbedding, action, reality, oneSpace = false, sourceChange = 'erase'] of [
  [false, 'accept', 'real'], [false, 'dismiss', 'real'], [true, 'accept', 'real'], [true, 'dismiss', 'real'],
  [false, 'accept', 'fictional'], [false, 'accept', 'real', true],
  [false, 'accept', 'real', false, 'delete'], [false, 'accept', 'real', false, 'edit'],
  [false, 'accept', 'real', false, 'retry'], [false, 'accept', 'real', false, 'restore'],
  [false, 'accept', 'real', false, 'restore-latest'], [false, 'accept', 'real', false, 'restart'],
  [false, 'accept', 'real', false, 'validation-failure'],
]) test(`inferred preferences apply and recover through event sources, ${action}, embedding ${earlyEmbedding}, ${reality}, one space ${oneSpace}, source ${sourceChange}`, async () => {
  fs.mkdirSync(os.tmpdir(), { recursive: true });
  const dataRoot = createTestDirectory(path.join(os.tmpdir(), 'service-'));
  const agentId = 'owner';
  const options = { dataRoot, agentId, defaults: { primaryUserId: 'human-a', userName: '阿宁', memoryOwner: 'Suzu' } };
  let memory = closeAfterTests(createMemoryService(options));
  const scope = upper => ({ owner: 'product-events', agentId, eventUpperBound: upper, clears: [] });
  const world = reality === 'fictional' ? { reality, worldId: 'novel', worldFrame: 'fictional' } : {};
  let calls = 0;
  const embeddingCalls = [];
  const embeddingProvider = earlyEmbedding ? Object.assign(async (text, context) => {
    assert.ok(context.sourceMaterial.eventSources.length);
    embeddingCalls.push(text);
    return { model: 'test-embedding', vector: [1, 0, 0] };
  }, { model: 'test-embedding', dimensions: 3 }) : null;
  let analyzedLabel = '推理小说';
  const generator = Object.assign(async ({ analyzerRole, stateAnalysisRequestId, schemaName, input }) => {
    calls++;
    assert.equal(analyzerRole, 'combined-evidence');
    const request = memory.withRepository(repository => repository.getStateAnalysisRequest(agentId, stateAnalysisRequestId));
    const common = { memoryId: request.memoryIds[0], sourceIds: request.sourceIds, confidence: 0.95, rationale: '有替代选择时主动选择。' };
    const analysis = { results: {
      objectGrounding: { analyses: [{ ...common, targetMatch: 'exact', matchedLabel: analyzedLabel }] },
      explicitExpression: { analyses: [] },
      behaviorConditions: { analyses: [{ ...common, behaviorType: 'choice', agency: 'self_initiated', constraint: 'none',
        alternatives: 'available', instrumentalGoal: 'none', opportunityCost: 'none', canDecline: 'yes' }] },
      sharingAffect: { analyses: [] },
      timeScope: { analyses: [{ ...common, stateTime: 'current', occurrencePattern: 'single', scopeKind: 'exact_object',
        scopeLabel: analyzedLabel, contextLabel: '', revisionCue: 'none' }] },
    } };
    const snapshot = JSON.parse(input.slice(input.indexOf('{')));
    return { output: schemaName === 'memory-state-match-analysis-v1' ? { stateMatch: {
      resolution: 'matched', candidateId: snapshot.stateCandidates[0].id, rationale: '同一主体对推理小说的新选择证据，mystery novels 是同义名称。',
    }, analysis } : analysis };
  }, { supportsCombinedStateAnalysis: true });
  let latestAnalysis;
  const restore = sourceChange.startsWith('restore');
  const choices = restore ? sourceChange === 'restore' ? 2 : 3 : 4;
  const evidenceIds = [];
  for (let index = 1; index <= choices; index++) {
    const day = restore ? 9 + index : index < 3 ? 10 : 8 + index;
    const occurredAt = `2026-09-${day}T12:00:0${index}.000Z`;
    analyzedLabel = index === 2 ? 'mystery novels' : '推理小说';
    const text = `第 ${index} 次选书时，虽然也有散文集可选，我还是主动选了${analyzedLabel}。`;
    memory.appendEventSources({ scope: scope(index), events: [{ occurredAt, content: { text },
      ...(reality === 'fictional' ? { world: { id: 'novel', frame: 'fictional' } } : {}),
      source: { version: 1, owner: 'product-events', recipientAgentId: agentId, eventId: `choice-${index}`,
        commitSequence: index, spaceId: restore ? `space-${index}`
          : oneSpace || index < 3 ? 'direct-a' : index === 3 ? 'book-club' : 'night-reading',
        eventType: 'message.created', sender: { kind: 'local-user', id: 'human-a', name: '阿宁' }, topology: { kind: 'space' } } }] });
    const archived = await memory.processPendingEvents({ maximumEvents: 1, sourceScope: scope(index), generator: async () => ({ output: {
      entities: [{ ref: 'E1', kind: 'concept', name: '推理小说', aliases: ['mystery novels'] }],
      memories: extractionModelFixture([{
        kind: 'preference', title: '阿宁主动选择推理小说', content: `阿宁${text}`, subjectRole: 'user', subjectName: '阿宁',
        actorRoles: [{ role: 'preference_holder', actorRole: 'user', actorName: '阿宁', confidence: 0.95 }],
        canonicalKey: `novel-preference-batch-${index}`, stateFamily: 'preference', stateLabel: '推理小说',
        evidenceMode: 'inferred', reality, temporalState: 'current', revisionAction: 'add', eventDate: occurredAt.slice(0, 10),
        eventStart: '', eventEnd: '', confidence: 0.95, importance: 0.5, sourceRefs: ['M0001'],
      }]).map(candidate => ({ ...candidate, entityRefs: ['E1'] })),
    } }) });
    assert.equal(archived.stateAnalysisRequestsQueued, 1);
    const maintenance = await memory.runSemanticMaintenance({ generator, embeddingProvider, structureGenerator: null,
      processInputEvents: false, sourceScope: scope(index) });
    assert.equal(maintenance.failures.length, 0, JSON.stringify(maintenance.failures));
    latestAnalysis = maintenance.stateAnalysis.results[0];
    assert.ok(latestAnalysis);
    evidenceIds.push(latestAnalysis.request.memoryIds[0]);
    assert.notEqual(latestAnalysis.status, 'provisional-review', latestAnalysis.reason);
    if (latestAnalysis.preferenceProposal) assert.ok(latestAnalysis.preferenceProposal.resultMemoryId,
      'A computed preference is effective before its audit confirmation.');
  }
  assert.equal(calls, choices);
  if (earlyEmbedding) assert.equal(embeddingCalls.length, choices);
  assert.equal(latestAnalysis.inferredPreference.preview.independentSupport, choices);
  assert.equal(latestAnalysis.inferredPreference.preview.distinctSupportContexts, oneSpace ? 1 : restore ? choices : 3);
  const reviews = memory.listHighLevelProposals({ types: ['preference-state'] });
  if (oneSpace) {
    assert.equal(reviews.items.length, 0);
    assert.equal(latestAnalysis.inferredPreference.preview.status, 'behavior-only');
    return;
  }
  const latest = reviews.items.find(item => memory.getMemory(item.proposal.resultMemoryId).memory.status === 'active');
  assert.ok(latest);
  assert.equal(latest.proposal.proposed_level, sourceChange === 'restore' ? 'selection_tendency' : 'stable_preference');
  const detail = memory.getReviewConsoleProposal('preference-state', latest.id);
  assert.equal(detail.evidence.length, choices);
  const applied = memory.getMemory(latest.proposal.resultMemoryId);
  assert.equal(memory.withRepository(repository => repository.listPendingProvisionalMemories(agentId)).length, 0);
  assert.ok(applied.entities.some(entity => entity.canonical_name === '推理小说'));
  const recallOptions = { sourceScope: scope(choices), now: '2026-09-13T00:00:00Z', persistTrace: false, ...world };
  const current = () => memory.withRepository(repository => repository.getCurrentCanonicalMemory({ ...world, agentId,
    subjectRole: applied.memory.subject_role, subjectKey: applied.memory.subject_key,
    canonicalKey: applied.memory.canonical_key, stateFamily: 'preference', representationLayer: 'inferred' }));
  const before = await memory.search('mystery novels', recallOptions);
  assert.ok(before.graph.selectedMemoryIds.includes(applied.memory.id));
  const result = memory.resolveHighLevelProposal('preference-state', latest.id, { action });
  assert.equal(result.resolution.proposal.review_state, action === 'accept' ? 'accepted' : 'dismissed');
  if (action === 'dismiss') {
    assert.equal(memory.getMemory(applied.memory.id).memory.status, 'deleted');
    const previous = memory.getMemory(latest.proposal.previousMemoryId).memory;
    assert.equal(previous.status, 'active');
    await memory.close();
    memory = closeAfterTests(createMemoryService(options));
    const restored = await memory.search('mystery novels', recallOptions);
    assert.ok(restored.graph.selectedMemoryIds.includes(previous.id));
    assert.equal(memory.getMemory(applied.memory.id).memory.status, 'deleted');
    return;
  }
  assert.deepEqual(memory.getMemory(applied.memory.id).memory, applied.memory);
  assert.equal(result.maintenance.status, 'not-required');
  assert.equal(memory.getReviewConsoleProposal('preference-state', latest.id).permissions.canRevoke, true);
  if (restore) {
    const sourceId = evidenceIds.at(-1);
    memory.deleteMemory(sourceId);
    assert.equal(current()?.metadata.preferenceStateLevel || null, choices === 2 ? null : 'selection_tendency');
    memory.restoreMemory(sourceId);
    assert.equal(current()?.id, applied.memory.id);
    assert.equal(current()?.metadata.preferenceStateLevel, choices === 2 ? 'selection_tendency' : 'stable_preference');
    memory.resolveHighLevelProposal('preference-state', latest.id, { action: 'dismiss' });
    const survivingId = current()?.id || null;
    memory.restoreMemory(sourceId);
    assert.equal(current()?.id || null, survivingId, 'Restoring source evidence preserves the explicit withdrawal of its conclusion.');
    return;
  }
  if (!earlyEmbedding && reality === 'real' && sourceChange === 'erase') {
    const previous = memory.getMemory(latest.proposal.previousMemoryId).memory;
    memory.resolveHighLevelProposal('preference-state', previous.metadata.preferenceProposalId, { action: 'dismiss' });
    assert.equal(memory.getMemory(applied.memory.id).memory.status, 'active');
    const survivingEvidence = memory.withRepository(repository => repository.listStateEvidenceObservations(agentId, {
      stateFamily: 'preference', subjectRole: applied.memory.subject_role, subjectKey: applied.memory.subject_key,
      canonicalKey: applied.memory.canonical_key, qualifications: ['qualified'], limit: 100,
    }), { sourceScope: scope(4) });
    assert.equal(survivingEvidence.length, 4, 'Withdrawing an older result preserves the independent behavior evidence.');
    memory.resolveHighLevelProposal('preference-state', latest.id, { action: 'dismiss' });
    assert.equal(memory.getMemory(previous.id).memory.status, 'deleted');
  }
  let partialScope = scope(choices);
  if (['delete', 'edit'].includes(sourceChange)) {
    for (const id of evidenceIds.slice(0, 2)) {
      if (sourceChange === 'delete') memory.deleteMemory(id);
      else memory.editMemory(id, { content: '这次选书经历属于同事。' });
    }
  } else {
    partialScope = { ...scope(choices), clears: [{ spaceId: 'direct-a', throughSequence: choices }] };
    const validationFailure = sourceChange === 'validation-failure';
    if (validationFailure || ['retry', 'restart'].includes(sourceChange)) {
      const original = memory.withRepository.bind(memory);
      let fail = true;
      memory.withRepository = (callback, options) => original((repository, database) => {
        const record = repository.recordPreferenceStateProposal.bind(repository);
        repository.recordPreferenceStateProposal = input => {
          if (fail && input.metadata?.accumulatedPreference) {
            fail = false;
            if (validationFailure) throw new PreferenceStateValidationError('preference-evidence-needs-review');
            throw new Error('preference-persistence-failed');
          }
          return record(input);
        };
        return callback(repository, database);
      }, options);
      try {
        if (validationFailure) {
          const cleanup = memory.eraseEventSources({ id: 'clear-first-two-choices', scope: partialScope });
          assert.equal(cleanup.complete, true, 'Source erasure finishes even when a replacement preference cannot be formed.');
        } else {
          assert.throws(() => memory.eraseEventSources({ id: 'clear-first-two-choices', scope: partialScope }), /preference-persistence-failed/u);
        }
      } finally { memory.withRepository = original; }
      const interrupted = memory.withRepository(repository => getEventSourceCleanup(repository, agentId, 'clear-first-two-choices'));
      assert.equal(interrupted.complete, validationFailure);
      assert.ok(interrupted.result.pendingPreferenceTargets.length, 'The unsuccessful recalculation is retained for recovery.');
      if (validationFailure || sourceChange === 'restart') {
        await memory.close();
        memory = closeAfterTests(createMemoryService(options));
      }
    }
    const completed = validationFailure ? memory.getEventSourceCleanup('clear-first-two-choices')
      : memory.eraseEventSources({ id: 'clear-first-two-choices', scope: partialScope });
    assert.equal(completed.complete, true);
    assert.deepEqual(completed.result.pendingPreferenceTargets, []);
  }
  const remaining = current();
  assert.equal(remaining?.metadata.preferenceStateLevel, 'selection_tendency');
  assert.equal(memory.getMemory(remaining.id).sources.length, 2);
  const afterPartial = await memory.search('推理小说', { ...recallOptions, sourceScope: partialScope });
  assert.ok(afterPartial.graph.selectedMemoryIds.includes(remaining.id));
  const cleared = { ...scope(choices), clears: ['direct-a', 'book-club', 'night-reading']
    .map(spaceId => ({ spaceId, throughSequence: choices })) };
  assert.equal(memory.eraseEventSources({ id: 'clear-preference-evidence', scope: cleared }).complete, true);
  assert.equal(memory.getMemory(remaining.id).memory.status, 'deleted');
});
