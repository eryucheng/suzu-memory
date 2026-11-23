import assert from "node:assert/strict";
import { MIGRATIONS } from "../src/schema.mjs";
import { createHash } from "node:crypto";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { retrieveMemories } from "../../retriever/src/index.mjs";
import { syncMemoryEmbeddings } from "../../embedding-indexer/src/index.mjs";
import { runSemanticMemoryMaintenance } from "../../maintenance/src/index.mjs";
import { MemoryService } from "../../service/src/index.mjs";
import { buildReviewProposalDetail } from "../../service/src/review-console.mjs";
import { readReportedStateTransition } from '../src/reported-state-policy.mjs';

import {
  MemoryRepository,
  openMemoryDatabase,
  resolveReportedStateProposal,
  applyReportedStateProposal,
  recoverAutomaticallyReviewedStates,
  materializeReportedStateProposal,
  materializePendingReportedStateProposals,
  stateScopeKeyFromScope,
} from "../src/index.mjs";

const TARGET = "user:belief:rain";

function setup() {
  const database = openMemoryDatabase(":memory:");
  return { database, repository: new MemoryRepository(database) };
}

function addReportedBeliefObservation(repository, {
  id = "belief-observation-1",
  comparisonLayer = "reported",
  stateFamily = "belief",
  canonicalKey = TARGET,
  sourceContent = "我觉得雨天很安静。",
  content = "用户明确说自己觉得雨天很安静。",
  occurredAt = "2026-08-02T08:00:00.000Z",
  signal = "explicit_belief",
} = {}) {
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt,
    speaker: "User",
    content: sourceContent,
  });
  const memory = repository.upsertMemory({
    id: `memory-${id}`,
    agentId: "agent-test",
    kind: "utterance",
    layer: "episodic",
    content,
    subjectRole: "user",
    subjectKey: "user",
    evidenceMode: "explicit",
    temporalState: "historical",
    knownAt: occurredAt,
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 1,
    evidenceStrength: 1,
    provenance: "test",
  });
  const run = repository.recordStateAnalysisRun({
    id: `run-${id}`,
    agentId: "agent-test",
    stateFamily,
    analyzerRole: `${stateFamily}-holder`,
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey,
    promptVersion: `reported-${stateFamily}-v1`,
    schemaVersion: `reported-${stateFamily}-schema-v1`,
    inputHash: createHash("sha256").update(id).digest("hex"),
    status: "completed",
    memoryIds: [memory.id],
    sourceIds: [source.id],
    output: { claim: sourceContent },
  });
  return repository.recordStateEvidenceObservation({
    id,
    agentId: "agent-test",
    stateFamily,
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey,
    memoryId: memory.id,
    evidenceGroupId: `group-${id}`,
    signal,
    claimedDirection: "support",
    effectiveDirection: "support",
    qualification: "qualified",
    confidence: 0.95,
    origin: "llm",
    scope: { currentRepresentationLayer: comparisonLayer },
    payloadSchemaVersion: `reported-${stateFamily}-observation-v1`,
    payload: { claimText: sourceContent },
    sourceIds: [source.id],
    analysisRunIds: [run.id],
  });
}

function beliefDraft(observation = null, {
  claimText = "我觉得雨天很安静。",
  validFrom = "2026-08-02T08:00:00.000Z",
} = {}) {
  const observationId = observation?.id || "belief-observation-1";
  const memoryId = observation?.memory_id || observation?.memoryId || "memory-belief-observation-1";
  const sourceIds = observation?.sourceIds || ["source-belief-observation-1"];
  return {
    kind: "belief_state",
    stateFamily: "belief",
    representationLayer: "reported",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    temporalState: "current",
    statePhase: "active",
    validFrom,
    proposition: { text: claimText, truthStatus: "unverified" },
    evidenceObservationIds: [observationId],
    evidenceMemoryIds: [memoryId],
    evidenceSourceIds: [...sourceIds],
  };
}

test("keeps a reported review result pending and idempotent without writing formal memory", () => {
  const { database, repository } = setup();
  const observation = addReportedBeliefObservation(repository);
  const beforeNodes = Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const input = {
    agentId: "agent-test",
    batchId: "belief-review-batch",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "create",
    proposedState: beliefDraft(),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("review-input").digest("hex"),
    selectedObservationId: observation.id,
    consideredObservationIds: [observation.id],
  };
  const first = repository.recordReportedStateProposal(input);
  const replay = repository.recordReportedStateProposal({
    ...input,
    id: "ignored-replay-id",
    batchId: "later-scheduler-retry",
  });

  assert.equal(first.wasInserted, true);
  assert.equal(replay.wasInserted, false);
  assert.equal(replay.id, first.id);
  assert.equal(replay.batch_id, "belief-review-batch");
  assert.equal(first.review_state, "pending");
  assert.equal(first.state_family, "belief");
  assert.equal(first.proposed_kind, "belief_state");
  assert.equal(first.selectedObservationId, observation.id);
  assert.deepEqual(first.consideredObservationIds, [observation.id]);
  assert.equal(repository.listReportedStateProposals("agent-test", {
    reviewStates: ["pending"],
    stateFamily: "belief",
  }).length, 1);
  assert.equal(
    Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    beforeNodes,
  );

  const dismissed = repository.dismissReportedStateProposal({
    agentId: "agent-test",
    proposalId: first.id,
    resolvedBy: "tester",
    note: "not-current-anymore",
  });
  assert.equal(dismissed.review_state, "dismissed");
  assert.equal(dismissed.resultMemoryId, "");
  assert.equal(repository.listReportedStateProposals("agent-test", {
    reviewStates: ["pending"],
  }).length, 0);
  assert.throws(() => repository.dismissReportedStateProposal({
    agentId: "agent-test",
    proposalId: first.id,
  }), /already dismissed/u);
  database.close();
});

test("rejects cross-layer evidence, family-kind mismatch, and stale current state", () => {
  const { database, repository } = setup();
  const wrongLayer = addReportedBeliefObservation(repository, {
    id: "wrong-layer-observation",
    comparisonLayer: "established",
  });
  const base = {
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "create",
    proposedState: beliefDraft(),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("wrong-layer").digest("hex"),
    selectedObservationId: wrongLayer.id,
    consideredObservationIds: [wrongLayer.id],
  };
  assert.throws(() => repository.recordReportedStateProposal(base), /outside the reviewed target or layer/u);
  assert.throws(() => repository.recordReportedStateProposal({
    ...base,
    proposedState: { ...beliefDraft(), kind: "fact" },
  }), /draft kind is invalid/u);
  assert.throws(() => repository.recordReportedStateProposal({
    ...base,
    action: "complete",
    previousMemoryId: "not-a-belief-action",
    proposedState: null,
  }), /action is invalid for its state family/u);

  repository.upsertMemory({
    id: "current-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "用户报告自己觉得雨天很安静。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
  });
  const valid = addReportedBeliefObservation(repository, { id: "valid-stale-state-observation" });
  assert.throws(() => repository.recordReportedStateProposal({ ...base,
    proposedState: beliefDraft(valid), selectedObservationId: valid.id, consideredObservationIds: [valid.id],
  }), /changed after review/u);
  database.close();
});

for (const scenario of ['pending', 'accepted', 'edited', 'newer', 'withdrawn', 'withdrawn-during-removal']) test(`restoring original speech recovers only its still-valid reported preference, ${scenario}`, t => {
  const { database, repository } = setup();
  t.after(() => database.close());
  const agentId = 'agent-test', canonicalKey = 'user:preference:rain';
  const target = { agentId, stateFamily: 'preference', subjectRole: 'user', subjectKey: 'user', canonicalKey };
  function statement(id, sourceContent, validFrom, polarity = 'positive') {
    const observation = addReportedBeliefObservation(repository, { id, stateFamily: 'preference', canonicalKey,
      signal: 'explicit_preference', sourceContent, content: sourceContent, occurredAt: validFrom });
    const { proposition, ...draft } = beliefDraft(observation, { validFrom });
    const proposal = repository.recordReportedStateProposal({ ...target, action: 'create',
      proposedState: { ...draft, kind: 'preference', stateFamily: 'preference', canonicalKey,
        preferenceClaim: { polarity, scope: { kind: 'exact_object', label: 'rain', context: '' } } },
      reviewVersion: 'reported-preference-review-v1', inputHash: createHash('sha256').update(id).digest('hex'),
      selectedObservationId: observation.id, consideredObservationIds: [observation.id] });
    const applied = materializeReportedStateProposal(repository, { agentId, proposalId: proposal.id });
    return { observation, proposal: applied.proposal, memory: applied.memory };
  }
  const original = statement('original', 'I like rainy days.', '2026-08-02T08:00:00.000Z');
  const current = () => repository.getCurrentCanonicalMemory({ ...target, representationLayer: 'reported' });
  assert.equal(current().id, original.memory.id);
  if (scenario === 'accepted' || scenario.startsWith('withdrawn')) {
    resolveReportedStateProposal(repository, { agentId, proposalId: original.proposal.id, action: 'accept' });
  }
  if (scenario === 'withdrawn') resolveReportedStateProposal(repository, { agentId, proposalId: original.proposal.id, action: 'dismiss' });
  const rawId = original.observation.memory_id;
  repository.setMemoryDeleted({ agentId, memoryId: rawId });
  assert.equal(current(), null);
  assert.equal(repository.listStateEvidenceObservations(agentId, { ...target, memoryId: rawId }).length, 0);
  if (scenario !== 'withdrawn') assert.throws(() => repository.setMemoryDeleted({ agentId, memoryId: original.memory.id, deleted: false }),
    /restoring its original evidence/u);
  if (scenario === 'withdrawn-during-removal') {
    const proposal = repository.getReportedStateProposal(agentId, original.proposal.id);
    assert.equal(buildReviewProposalDetail({ repository, agentId, envelope: { type: 'reported-state', proposal } }).permissions.canRevoke, true);
    resolveReportedStateProposal(repository, { agentId, proposalId: original.proposal.id, action: 'dismiss' });
  }
  if (scenario === 'edited') repository.editMemoryManually({ agentId, memoryId: rawId,
    patch: { content: 'I meant that I like snowy days.' } });
  const newer = scenario === 'newer' ? statement('later', 'I dislike rainy days.', '2026-08-03T08:00:00.000Z', 'negative') : null;

  repository.setMemoryDeleted({ agentId, memoryId: rawId, deleted: false });
  assert.equal(repository.getMemory(rawId).status, 'active');
  const saved = repository.getReportedStateProposal(agentId, original.proposal.id);
  if (scenario === 'pending' || scenario === 'accepted') {
    assert.equal(current().id, original.memory.id);
    assert.equal(saved.resultMemoryId, original.memory.id);
    assert.equal(saved.review_state, scenario);
    assert.ok(repository.findEdge({ agentId, fromMemoryId: original.memory.id, toMemoryId: rawId, relation: 'supported_by' }));
  } else {
    assert.equal(repository.getMemory(original.memory.id).status, 'deleted');
    assert.equal(current()?.id || null, newer?.memory.id || null);
  }
});

test("applies and withdraws preference reinforcement while keeping later evidence and state versions", () => {
  const { database, repository } = setup();
  const target = 'user:preference:rain';
  const addObservation = (fields) => addReportedBeliefObservation(repository, {
    stateFamily: 'preference', canonicalKey: target, signal: 'explicit_preference', ...fields,
  });
  const draft = (observation, { validFrom, polarity = 'positive' } = {}) => {
    const { proposition, ...fields } = beliefDraft(observation, { validFrom });
    return { ...fields, kind: 'preference', stateFamily: 'preference', canonicalKey: target,
      preferenceClaim: { polarity, scope: { kind: 'exact_object', label: '雨天', context: '' } } };
  };
  const initialObservation = addObservation({
    id: "initial-rain-belief",
    sourceContent: '我喜欢雨天安静的感觉。',
    content: '用户喜欢雨天安静的感觉。',
    occurredAt: "2026-08-02T08:00:00.000Z",
  });
  const initialProposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    batchId: "initial-review",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: target,
    action: "create",
    proposedState: draft(initialObservation),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("initial-review").digest("hex"),
    selectedObservationId: initialObservation.id,
    consideredObservationIds: [initialObservation.id],
    metadata: { target: { stateLabel: "对雨天的看法" } },
  });
  const created = resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: initialProposal.id,
    action: "accept",
    resolvedBy: "tester",
  });
  assert.equal(created.status, "created");
  assert.equal(created.memory.content, "用户喜欢雨天安静的感觉。");
  assert.equal(created.memory.state_family, "preference");
  assert.equal(created.memory.representation_layer, "reported");
  assert.equal(created.memory.metadata.reportedStateDraft.preferenceClaim.scope.label, "雨天");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: created.memory.id,
    toMemoryId: initialObservation.memory_id,
    relation: "supported_by",
  }).relation, "supported_by");

  const reinforcement = addObservation({
    id: "reinforce-rain-belief",
    sourceContent: "我还是喜欢雨天这种安静的感觉。",
    content: "用户再次明确表示喜欢雨天的安静。",
    occurredAt: "2026-08-03T08:00:00.000Z",
  });
  const reinforceInput = {
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: target,
    action: "reinforce",
    previousMemoryId: created.memory.id,
    proposedState: draft(reinforcement, {
      validFrom: "2026-08-03T08:00:00.000Z",
    }),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("reinforcement").digest("hex"),
    selectedObservationId: reinforcement.id,
    consideredObservationIds: [reinforcement.id],
  };
  const reinforceProposal = repository.recordReportedStateProposal(reinforceInput);
  const recovered = materializePendingReportedStateProposals(repository, { agentId: 'agent-test', action: 'reinforce' });
  assert.equal(recovered.materialized[0].proposal.id, reinforceProposal.id);
  const pending = repository.getReportedStateProposal('agent-test', reinforceProposal.id);
  assert.equal(pending.review_state, 'pending');
  assert.equal(pending.resultMemoryId, created.memory.id);
  assert.equal(buildReviewProposalDetail({ repository, agentId: 'agent-test',
    envelope: { type: 'reported-state', proposal: pending } }).applied, true);
  const sourceIds = () => new Set(repository.listMemorySources(created.memory.id).map(source => source.id));
  const initialSources = new Set(initialObservation.sourceIds);
  assert.deepEqual(sourceIds(), new Set([...initialSources, ...reinforcement.sourceIds]));
  assert.deepEqual(repository.listPendingProvisionalMemories('agent-test'), []);
  const reinforcementEdge = {
    agentId: 'agent-test', fromMemoryId: created.memory.id, toMemoryId: reinforcement.memory_id, relation: 'supported_by',
  };
  const beforeConfirmation = repository.findEdge(reinforcementEdge);
  const reinforced = resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: reinforceProposal.id,
    action: "accept",
  });
  assert.equal(reinforced.status, "reinforced");
  assert.equal(reinforced.memory.id, created.memory.id);
  assert.deepEqual(repository.findEdge(reinforcementEdge), beforeConfirmation);
  assert.equal(buildReviewProposalDetail({ repository, agentId: 'agent-test',
    envelope: { type: 'reported-state', proposal: reinforced.proposal } }).permissions.canRevoke, true);
  const setEvidenceDeleted = deleted => repository.setMemoryDeleted({
    agentId: 'agent-test', memoryId: reinforcement.memory_id, deleted,
  });
  setEvidenceDeleted(true);
  assert.deepEqual(sourceIds(), initialSources);
  const suspended = buildReviewProposalDetail({ repository, agentId: 'agent-test', envelope: { type: 'reported-state',
    proposal: repository.getReportedStateProposal('agent-test', reinforceProposal.id) } });
  setEvidenceDeleted(false);
  assert.deepEqual(sourceIds(), new Set([...initialSources, ...reinforcement.sourceIds]));
  assert.equal(suspended.applied, false);
  assert.equal(suspended.permissions.canRevoke, true);
  assert.equal(repository.getReportedStateProposal('agent-test', reinforceProposal.id).review_state, 'accepted');
  assert.equal(repository.listCanonicalStateHistory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: target,
    representationLayer: "reported",
    stateFamily: "preference",
  }).length, 1);

  const later = addObservation({
    id: 'later-rain-support', sourceContent: '我喜欢今晚下雨时的安静。', content: '用户喜欢下雨时的安静。',
    occurredAt: '2026-08-03T17:00:00Z',
  });
  const laterProposal = repository.recordReportedStateProposal({
    ...reinforceInput, proposedState: draft(later), selectedObservationId: later.id, consideredObservationIds: [later.id],
    inputHash: createHash('sha256').update('later-reinforcement').digest('hex'),
  });
  materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: laterProposal.id });
  setEvidenceDeleted(true);
  const revoked = resolveReportedStateProposal(repository, {
    agentId: 'agent-test', proposalId: reinforceProposal.id, action: 'dismiss',
  });
  assert.equal(revoked.proposal.review_state, 'dismissed');
  assert.equal(repository.findEdge(reinforcementEdge), null);
  setEvidenceDeleted(false);
  assert.deepEqual(sourceIds(), new Set([...initialSources, ...later.sourceIds]));
  const repeated = repository.recordReportedStateProposal({
    ...reinforceInput, inputHash: createHash('sha256').update('replayed-reinforcement').digest('hex'),
  });
  materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: repeated.id });
  assert.deepEqual(sourceIds(), new Set([...initialSources, ...later.sourceIds]));

  const source = repository.getSource(later.sourceIds[0]);
  repository.upsertSource({ agentId: source.agent_id, sourceKind: source.source_kind, externalId: source.external_id,
    occurredAt: source.occurred_at, knownAt: source.known_at, speaker: source.speaker, content: '刚才说的是隔壁，雨声很吵。' });
  assert.deepEqual(sourceIds(), initialSources);
  const invalidated = repository.getReportedStateProposal('agent-test', laterProposal.id);
  assert.equal(invalidated.review_state, 'pending');
  assert.equal(invalidated.resultMemoryId, '');
  assert.equal(materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: laterProposal.id }).memory, null);

  const changedObservation = addObservation({
    id: "changed-rain-belief",
    sourceContent: "我现在不喜欢雨天，听着烦躁。",
    content: "用户明确表示自己现在不喜欢雨天。",
    occurredAt: "2026-08-04T08:00:00.000Z",
  });
  const changedProposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: target,
    action: "supersede",
    previousMemoryId: created.memory.id,
    proposedState: draft(changedObservation, {
      polarity: 'negative',
      validFrom: "2026-08-04T08:00:00.000Z",
    }),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("changed-review").digest("hex"),
    selectedObservationId: changedObservation.id,
    consideredObservationIds: [changedObservation.id],
  });
  const changed = resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: changedProposal.id,
    action: "accept",
  });
  assert.equal(changed.status, "supersede");
  assert.notEqual(changed.memory.id, created.memory.id);
  assert.equal(repository.getMemory(created.memory.id).status, "superseded");
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: target,
    representationLayer: "reported",
    stateFamily: "preference",
  }).id, changed.memory.id);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: changed.memory.id,
    toMemoryId: created.memory.id,
    relation: "supersedes",
  }).metadata.transition, "supersede");

  const latestObservation = addObservation({
    id: 'changed-back-to-rain', sourceContent: '我现在又喜欢雨天了。',
    content: '用户改口说又喜欢雨天了。', occurredAt: '2026-08-05T08:00:00.000Z',
  });
  const latestProposal = repository.recordReportedStateProposal({
    agentId: 'agent-test', stateFamily: 'preference', subjectRole: 'user', subjectKey: 'user',
    canonicalKey: target, action: 'supersede', previousMemoryId: changed.memory.id,
    proposedState: draft(latestObservation, { validFrom: '2026-08-05T08:00:00.000Z' }),
    reviewVersion: 'reported-belief-review-v1', inputHash: createHash('sha256').update('changed-back').digest('hex'),
    selectedObservationId: latestObservation.id, consideredObservationIds: [latestObservation.id],
  });
  const { memory: latest } = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: latestProposal.id });
  const staleSource = repository.getSource(changedObservation.sourceIds[0]);
  repository.upsertSource({ agentId: staleSource.agent_id, sourceKind: staleSource.source_kind, externalId: staleSource.external_id,
    occurredAt: staleSource.occurred_at, knownAt: staleSource.known_at, speaker: staleSource.speaker,
    content: '我是转述隔壁的看法。' });
  assert.equal(repository.getReportedStateProposal('agent-test', changedProposal.id).resultMemoryId, '');
  assert.equal(repository.getMemory(changed.memory.id).status, 'deleted');
  assert.equal(repository.getMemory(latest.id).status, 'active');
  assert.equal(repository.getMemory(created.memory.id).status, 'superseded');

  resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: latestProposal.id, action: 'dismiss' });
  assert.equal(repository.getMemory(created.memory.id).status, 'active');
  assert.equal(repository.getMemory(changed.memory.id).status, 'deleted');
  assert.equal(repository.getMemory(latest.id).status, 'deleted');
  assert.deepEqual(sourceIds(), initialSources);
  database.close();
});

test("accepts terminal evidence without manufacturing a replacement statement", () => {
  const { database, repository } = setup();
  const key = "user:goal:publish-memory-system";
  const current = repository.upsertMemory({
    id: "current-publish-goal",
    agentId: "agent-test",
    kind: "plan",
    layer: "prospective",
    content: "用户计划发布记忆系统。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: key,
    representationLayer: "reported",
    stateFamily: "goal",
    statePhase: "active",
    temporalState: "in_progress",
    evidenceMode: "explicit",
    knownAt: "2026-08-01T08:00:00.000Z",
    validFrom: "2026-08-01T08:00:00.000Z",
  });
  const completion = addReportedBeliefObservation(repository, {
    id: "publish-completed",
    stateFamily: "goal",
    canonicalKey: key,
    sourceContent: "我已经把记忆系统发布了。",
    content: "用户明确报告自己已经发布记忆系统。",
    occurredAt: "2026-08-05T08:00:00.000Z",
    signal: "goal_completion",
  });
  const proposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "goal",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: key,
    action: "complete",
    previousMemoryId: current.id,
    proposedState: null,
    reviewVersion: "reported-goal-review-v1",
    inputHash: createHash("sha256").update("goal-completion").digest("hex"),
    selectedObservationId: completion.id,
    consideredObservationIds: [completion.id],
  });
  const accepted = resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  });
  assert.equal(accepted.status, "complete");
  assert.equal(accepted.memory.id, current.id);
  assert.equal(accepted.memory.content, "用户计划发布记忆系统。");
  assert.equal(accepted.memory.status, "superseded");
  assert.equal(accepted.memory.state_phase, "completed");
  assert.equal(accepted.memory.temporal_state, "completed");
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: key,
    representationLayer: "reported",
    stateFamily: "goal",
  }), null);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: current.id,
    toMemoryId: completion.memory_id,
    relation: "supported_by",
  }).relation, "supported_by");
  database.close();
});

test("marks a corrected attribution disputed and accepts scoped exceptions without replacing the root", () => {
  const correctedFixture = setup();
  const current = correctedFixture.repository.upsertMemory({
    id: "misattributed-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "用户据称觉得雨天很安静。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
    knownAt: "2026-08-01T08:00:00.000Z",
    validFrom: "2026-08-01T08:00:00.000Z",
  });
  const denial = addReportedBeliefObservation(correctedFixture.repository, {
    id: "deny-rain-belief",
    sourceContent: "我从来没说过我觉得雨天很安静。",
    content: "用户明确否认自己曾持有该雨天观念。",
    occurredAt: "2026-08-05T08:00:00.000Z",
    signal: "denies_prior_holding",
  });
  const correction = correctedFixture.repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "correct_attribution",
    previousMemoryId: current.id,
    proposedState: null,
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("correction-review").digest("hex"),
    selectedObservationId: denial.id,
    consideredObservationIds: [denial.id],
  });
  const corrected = resolveReportedStateProposal(correctedFixture.repository, {
    agentId: "agent-test",
    proposalId: correction.id,
    action: "accept",
  });
  assert.equal(corrected.status, "attribution-corrected");
  assert.equal(corrected.memory.status, "disputed");
  assert.equal(corrected.memory.state_phase, "retired");
  assert.equal(correctedFixture.repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: current.id,
    toMemoryId: denial.memory_id,
    relation: "challenged_by",
  }).relation, "challenged_by");
  correctedFixture.database.close();

  const scopedFixture = setup();
  const preferenceKey = "user:preference:fish";
  const broad = scopedFixture.repository.upsertMemory({
    id: "broad-fish-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户报告自己喜欢鱼类食物。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
    knownAt: "2026-08-01T08:00:00.000Z",
    validFrom: "2026-08-01T08:00:00.000Z",
  });
  const exception = addReportedBeliefObservation(scopedFixture.repository, {
    id: "raw-fish-exception",
    stateFamily: "preference",
    canonicalKey: preferenceKey,
    sourceContent: "我喜欢鱼，但不喜欢生鱼。",
    content: "用户报告自己喜欢鱼类食物，但不喜欢生鱼。",
    occurredAt: "2026-08-05T08:00:00.000Z",
    signal: "explicit_preference",
  });
  const exceptionDraft = {
    kind: "preference",
    stateFamily: "preference",
    representationLayer: "reported",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    temporalState: "current",
    statePhase: "active",
    validFrom: "2026-08-05T08:00:00.000Z",
    preferenceClaim: {
      objectLabel: "生鱼",
      polarity: "negative",
      scope: { kind: "subcategory", label: "生鱼", context: "" },
    },
    evidenceObservationIds: [exception.id],
    evidenceMemoryIds: [exception.memory_id],
    evidenceSourceIds: [...exception.sourceIds],
  };
  const exceptionProposal = scopedFixture.repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    action: "add_scoped_exception",
    previousMemoryId: broad.id,
    proposedState: exceptionDraft,
    reviewVersion: "reported-preference-review-v1",
    inputHash: createHash("sha256").update("scoped-exception").digest("hex"),
    selectedObservationId: exception.id,
    consideredObservationIds: [exception.id],
  });
  const acceptedException = resolveReportedStateProposal(scopedFixture.repository, {
    agentId: "agent-test",
    proposalId: exceptionProposal.id,
    action: "accept",
  });
  const exceptionScopeKey = stateScopeKeyFromScope({
    kind: "subcategory",
    label: "生鱼",
    context: "",
  });
  assert.equal(acceptedException.status, "scoped-exception-added");
  assert.equal(acceptedException.memory.state_scope_key, exceptionScopeKey);
  assert.equal(scopedFixture.repository.getReportedStateProposal(
    "agent-test",
    exceptionProposal.id,
  ).review_state, "accepted");
  assert.equal(scopedFixture.repository.getMemory(broad.id).status, "active");
  assert.equal(scopedFixture.repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    representationLayer: "reported",
    stateFamily: "preference",
  }).id, broad.id);
  assert.equal(scopedFixture.repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    representationLayer: "reported",
    stateFamily: "preference",
    stateScopeKey: exceptionScopeKey,
  }).id, acceptedException.memory.id);
  assert.equal(scopedFixture.repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: acceptedException.memory.id,
    toMemoryId: broad.id,
    relation: "scoped_exception_to",
  }).relation, "scoped_exception_to");

  const duplicateEvidence = addReportedBeliefObservation(scopedFixture.repository, {
    id: "raw-fish-exception-repeat",
    stateFamily: "preference",
    canonicalKey: preferenceKey,
    sourceContent: "我还是不喜欢生鱼。",
    content: "用户再次报告自己不喜欢生鱼。",
    occurredAt: "2026-08-06T08:00:00.000Z",
    signal: "explicit_preference",
  });
  const duplicateProposal = scopedFixture.repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    action: "add_scoped_exception",
    previousMemoryId: broad.id,
    proposedState: {
      ...exceptionDraft,
      validFrom: "2026-08-06T08:00:00.000Z",
      evidenceObservationIds: [duplicateEvidence.id],
      evidenceMemoryIds: [duplicateEvidence.memory_id],
      evidenceSourceIds: [...duplicateEvidence.sourceIds],
    },
    reviewVersion: "reported-preference-review-v1",
    inputHash: createHash("sha256").update("scoped-exception-repeat").digest("hex"),
    selectedObservationId: duplicateEvidence.id,
    consideredObservationIds: [duplicateEvidence.id],
  });
  assert.throws(() => resolveReportedStateProposal(scopedFixture.repository, {
    agentId: "agent-test",
    proposalId: duplicateProposal.id,
    action: "accept",
  }), /scope already has a current exception/u);
  assert.equal(scopedFixture.repository.getReportedStateProposal(
    "agent-test",
    duplicateProposal.id,
  ).review_state, "pending");

  const rootChangeEvidence = addReportedBeliefObservation(scopedFixture.repository, {
    id: "fish-root-change",
    stateFamily: "preference",
    canonicalKey: preferenceKey,
    sourceContent: "我现在各种鱼都喜欢吃。",
    content: "用户报告自己现在喜欢吃各种鱼类食物。",
    occurredAt: "2026-08-07T08:00:00.000Z",
    signal: "explicit_preference_change",
  });
  const rootChangeProposal = scopedFixture.repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "preference",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: preferenceKey,
    action: "supersede",
    previousMemoryId: broad.id,
    proposedState: {
      kind: "preference",
      stateFamily: "preference",
      representationLayer: "reported",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: preferenceKey,
      temporalState: "current",
      statePhase: "active",
      validFrom: "2026-08-07T08:00:00.000Z",
      preferenceClaim: {
        objectLabel: "鱼类食物",
        polarity: "positive",
        scope: { kind: "category", label: "鱼类食物" },
      },
      evidenceObservationIds: [rootChangeEvidence.id],
      evidenceMemoryIds: [rootChangeEvidence.memory_id],
      evidenceSourceIds: [...rootChangeEvidence.sourceIds],
    },
    reviewVersion: "reported-preference-review-v1",
    inputHash: createHash("sha256").update("fish-root-change").digest("hex"),
    selectedObservationId: rootChangeEvidence.id,
    consideredObservationIds: [rootChangeEvidence.id],
  });
  assert.throws(() => resolveReportedStateProposal(scopedFixture.repository, {
    agentId: "agent-test",
    proposalId: rootChangeProposal.id,
    action: "accept",
  }), /requires explicit scope reconciliation/u);
  assert.equal(scopedFixture.repository.getMemory(broad.id).status, "active");
  assert.equal(scopedFixture.repository.getReportedStateProposal(
    "agent-test",
    rootChangeProposal.id,
  ).review_state, "pending");
  scopedFixture.database.close();
});

test("rolls back a failed reported-state acceptance without resolving the proposal", () => {
  const { database, repository } = setup();
  const current = repository.upsertMemory({
    id: "newer-current-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "用户当前觉得雨天很安静。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    temporalState: "current",
    evidenceMode: "explicit",
    knownAt: "2026-08-05T08:00:00.000Z",
    validFrom: "2026-08-05T08:00:00.000Z",
  });
  const olderChange = addReportedBeliefObservation(repository, {
    id: "older-state-change",
    sourceContent: "我现在觉得雨天很烦。",
    content: "用户表示自己觉得雨天很烦。",
    occurredAt: "2026-08-04T08:00:00.000Z",
  });
  const proposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "supersede",
    previousMemoryId: current.id,
    proposedState: beliefDraft(olderChange, {
      claimText: "我现在觉得雨天很烦。",
      validFrom: "2026-08-04T08:00:00.000Z",
    }),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("older-change").digest("hex"),
    selectedObservationId: olderChange.id,
    consideredObservationIds: [olderChange.id],
  });
  const before = {
    nodes: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    sources: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_sources").get().count),
    edges: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count),
  };
  assert.throws(() => resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /cannot close before its validity begins/u);
  assert.deepEqual({
    nodes: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    sources: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_sources").get().count),
    edges: Number(database.prepare("SELECT COUNT(*) AS count FROM memory_edges").get().count),
  }, before);
  assert.equal(repository.getMemory(current.id).status, "active");
  assert.equal(repository.getReportedStateProposal("agent-test", proposal.id).review_state, "pending");
  database.close();
});

test("rejects acceptance after reviewed evidence content changes", () => {
  const { database, repository } = setup();
  const observation = addReportedBeliefObservation(repository, {
    id: "evidence-drift",
  });
  const proposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "create",
    proposedState: beliefDraft(observation),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("evidence-drift").digest("hex"),
    selectedObservationId: observation.id,
    consideredObservationIds: [observation.id],
  });
  repository.editMemoryManually({
    agentId: "agent-test",
    memoryId: observation.memory_id,
    patch: { content: "审核后被人工改写的证据正文。" },
    actor: "human:test",
    reason: "verify immutable proposal evidence",
  });
  assert.throws(() => resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /evidence memory changed after review/u);
  assert.equal(repository.getReportedStateProposal("agent-test", proposal.id).review_state, "pending");
  assert.equal(repository.getCurrentCanonicalMemory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
  }), null);
  database.close();
});

test("rejects acceptance after a reviewed evidence source becomes inactive", () => {
  const { database, repository } = setup();
  const observation = addReportedBeliefObservation(repository, {
    id: "evidence-source-retracted",
  });
  const proposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "create",
    proposedState: beliefDraft(observation),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("evidence-source-retracted").digest("hex"),
    selectedObservationId: observation.id,
    consideredObservationIds: [observation.id],
  });
  const sourceId = observation.sourceIds[0];
  database.prepare(`
    UPDATE source_records SET lifecycle = 'retracted', invalidated_at = ? WHERE id = ?
  `).run("2026-08-05T10:00:00.000Z", sourceId);
  assert.throws(() => resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: proposal.id,
    action: "accept",
  }), /evidence source is no longer active/u);
  assert.equal(repository.getReportedStateProposal("agent-test", proposal.id).review_state, "pending");
  database.close();
});

for (const originReview of ['pending', 'accepted']) for (const action of ['accept', 'dismiss']) {
  test(`repeated cancellation preserves the original close time and rollback owner: ${originReview}/${action}`, t => {
    const { repository, propose } = pendingGoalFixture(t);
    const initial = propose({ id: 'repeat-initial', content: '周末看展。' });
    const previous = resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: initial.id, action: 'accept' }).memory;
    const cancel = propose({ id: 'repeat-original', action: 'cancel', previous, content: '看展取消了。', time: '2026-08-03T08:00:00.000Z' });
    materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: cancel.id });
    if (originReview === 'accepted') resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: cancel.id, action: 'accept' });
    const closed = repository.getMemory(previous.id);
    const repeated = propose({ id: 'repeat-confirmation', action: 'cancel', previous: closed, content: '那个展已经取消，不去了。', time: '2026-08-04T08:00:00.000Z' });
    const pending = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: repeated.id });
    assert.ok(pending.memory.metadata.reportedStateConfirmation);
    assert.equal(pending.memory.metadata.reportedStateTransition, undefined);
    resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: repeated.id, action });
    const after = repository.getMemory(previous.id);
    assert.equal(after.valid_to, closed.valid_to);
    assert.equal(after.state_phase, 'cancelled');
    assert.equal(after.metadata.reportedStateTransitionId, closed.metadata.reportedStateTransitionId);
    if (originReview === 'pending') {
      resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: cancel.id, action: 'dismiss' });
      assert.equal(repository.getMemory(previous.id).state_phase, 'active');
    }
  });
}

function pendingGoalFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pending-reported-goal-"));
  const databasePath = path.join(root, "memory.db");
  const database = openMemoryDatabase(databasePath);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repository = new MemoryRepository(database);
  const canonicalKey = "user:goal:exhibition";
  function propose({ id, action = "create", previous = null, content, time = "2026-08-02T08:00:00.000Z" }) {
    const observation = addReportedBeliefObservation(repository, {
      id, stateFamily: "goal", canonicalKey, sourceContent: content, content, occurredAt: time,
    });
    const draft = ["create", "reinforce", "supersede"].includes(action) ? {
      ...beliefDraft(observation, { claimText: content, validFrom: time }), kind: "plan", stateFamily: "goal", canonicalKey,
      goalClaim: { text: content },
    } : null;
    return repository.recordReportedStateProposal({
      agentId: "agent-test", stateFamily: "goal", subjectRole: "user", subjectKey: "user", canonicalKey,
      action, previousMemoryId: previous?.id, proposedState: draft,
      reviewVersion: "test-pending-goal", inputHash: createHash("sha256").update(id).digest("hex"),
      selectedObservationId: observation.id, consideredObservationIds: [observation.id],
      metadata: { target: { subjectLabel: "小夏", stateLabel: "周末看展" } },
    });
  }
  const recall = (anchorMemoryIds) => retrieveMemories({
    databasePath, agentId: "agent-test", query: "看展的计划", anchorMemoryIds,
    options: { maximumContextChars: 1200 },
  });
  return { repository, database, databasePath, propose, recall };
}

for (const accepted of [false, true]) test(`removing the source of a replacement restores the original state, accepted=${accepted}`, t => {
  const { repository, propose } = pendingGoalFixture(t);
  const agentId = 'agent-test';
  const first = propose({ id: 'sourced-plan', content: '我周六去看展。' });
  const original = applyReportedStateProposal(repository, { agentId, proposalId: first.id }).memory;
  const later = propose({ id: 'sourced-change', action: 'supersede', previous: original,
    content: '改到周日去看展。', time: '2026-08-03T08:00:00Z' });
  const preview = materializeReportedStateProposal(repository, { agentId, proposalId: later.id }).memory;
  const added = accepted ? resolveReportedStateProposal(repository, { agentId, proposalId: later.id, action: 'accept' }).memory : preview;
  const source = later.draft.evidenceMemoryIds[0];
  const current = () => repository.getCurrentCanonicalMemory({ agentId, subjectRole: original.subject_role,
    subjectKey: original.subject_key, canonicalKey: original.canonical_key, representationLayer: original.representation_layer,
    stateFamily: original.state_family, stateScopeKey: original.state_scope_key, includePending: true });
  const deleteSource = deleted => repository.setMemoryDeleted({ agentId, memoryId: source, deleted });
  assert.equal(current().id, added.id);
  deleteSource(true);
  assert.equal(current().id, original.id);
  assert.equal(repository.getMemory(added.id).status, 'deleted');
  deleteSource(false);
  assert.equal(current().id, added.id);

  const originalEvidence = first.draft.evidenceMemoryIds[0];
  repository.setMemoryDeleted({ agentId, memoryId: originalEvidence });
  assert.equal(current().id, added.id);
  deleteSource(true);
  assert.equal(current(), null);
  repository.setMemoryDeleted({ agentId, memoryId: originalEvidence, deleted: false });
  assert.equal(current().id, original.id);

  repository.editMemoryManually({ agentId, memoryId: original.id, patch: { content: '我周六去看展，上午九点到。' } });
  deleteSource(false);
  assert.equal(current().id, original.id, 'Restoring old evidence must preserve a later change.');
  deleteSource(true);
  resolveReportedStateProposal(repository, { agentId, proposalId: later.id, action: 'dismiss' });
  deleteSource(false);
  assert.equal(current().id, original.id);
  assert.equal(repository.getReportedStateProposal(agentId, later.id).review_state, 'dismissed');
});

test('withdraws legacy reported-state reinforcement and keeps later independent evidence', t => {
  const { repository, database, propose } = pendingGoalFixture(t);
  const agentId = 'agent-test';
  const apply = proposal => applyReportedStateProposal(repository, { agentId, proposalId: proposal.id }).memory;
  const original = propose({ id: 'original-plan', content: '我周末打算去看展。' });
  const state = apply(original);
  const legacy = propose({ id: 'legacy-confirmation', action: 'reinforce', previous: state,
    content: '周末还是照原来的安排去看展。', time: '2026-08-03T08:00:00Z' });
  apply(legacy);
  database.prepare(`UPDATE memory_reported_state_proposals SET review_state='accepted',
    resolved_by='system:auto-explicit-self-report-v1', metadata_json=json_remove(metadata_json, '$.reportedStateApplication')
    WHERE id=?`).run(legacy.id);
  const later = propose({ id: 'later-confirmation', action: 'reinforce', previous: state,
    content: '我已经确认了周末看展的安排。', time: '2026-08-04T08:00:00Z' });
  apply(later);
  assert.equal(recoverAutomaticallyReviewedStates(repository, agentId), 1);

  const originalSource = legacy.draft.evidenceMemoryIds[0];
  repository.setMemoryDeleted({ agentId, memoryId: originalSource });
  assert.equal(repository.getMemory(state.id).status, 'active');
  assert.ok(repository.listMemorySources(state.id).every(source => !legacy.draft.evidenceSourceIds.includes(source.id)));
  resolveReportedStateProposal(repository, { agentId, proposalId: legacy.id, action: 'dismiss' });
  repository.setMemoryDeleted({ agentId, memoryId: originalSource, deleted: false });
  const current = repository.getMemoryDetail(agentId, state.id);
  assert.equal(current.memory.status, 'active');
  const draft = current.memory.metadata.reportedStateDraft;
  for (const field of ['evidenceObservationIds', 'evidenceMemoryIds', 'evidenceSourceIds']) {
    assert.deepEqual(new Set(draft[field]), new Set([...original.draft[field], ...later.draft[field]]));
  }
  assert.deepEqual(new Set(current.sources.map(source => source.id)), new Set(draft.evidenceSourceIds));
});


for (const [language, original, query, cancelled, replacement] of [
  ['Chinese', '周末去看展的计划已经确定，我准备周六去看展。', '看展的计划', '我不去了。', '改成周日，地点换到东馆。'],
  ['English', 'I plan to visit the art exhibition on Saturday.', 'exhibition plans', 'I am not going.', "Let's make it Sunday at the east hall instead."],
]) {
  for (const originalPending of [false, true]) for (const action of ['cancel', 'supersede']) {
    for (const resolution of ['accept', 'dismiss']) test(
      'ordinary recall follows state changes: ' + [language, originalPending, action, resolution].join(', '), async t => {
        const { repository, databasePath, propose } = pendingGoalFixture(t);
        const recall = () => retrieveMemories({ databasePath, agentId: 'agent-test', query,
          now: new Date('2026-08-05T08:00:00Z'), options: { execution: 'inline', maximumContextChars: 3000 } });
        const initial = propose({ id: 'original', content: original });
        const { memory: previous } = originalPending
          ? materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: initial.id })
          : resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: initial.id, action: 'accept' });
        assert.equal((await recall()).status, 'ready');
        const content = action === 'cancel' ? cancelled : replacement;
        const proposal = propose({ id: 'update', action, previous, content, time: '2026-08-03T08:00:00Z' });
        const { memory: pending } = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: proposal.id });
        const result = await recall();
        assert.equal(result.status, 'ready');
        assert.ok(result.context.includes(content), result.context);
        assert.ok(result.trace.metadata.provisionalMemoryIds.includes(pending.id));
        const candidate = result.candidates.find(item => item.memoryId === pending.id);
        if (candidate) {
          assert.equal(candidate.provisional, true);
          assert.equal(candidate.provisionalReview.reviewDecisionId, proposal.id);
        }
        const after = resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: proposal.id, action: resolution });
        const reviewed = await recall();
        assert.equal(reviewed.status, 'ready');
        assert.ok(!reviewed.trace.metadata.provisionalMemoryIds.includes(pending.id));
        if (resolution === 'dismiss') {
          assert.ok(reviewed.context.includes(original), reviewed.context);
          assert.ok(!reviewed.context.includes(content), reviewed.context);
        } else if (action === 'cancel') {
          assert.match(reviewed.context, /已取消/u);
          assert.ok(reviewed.graph.selectedMemoryIds.includes(previous.id));
        } else {
          assert.ok(reviewed.context.includes(content), reviewed.context);
          assert.ok(reviewed.graph.selectedMemoryIds.includes(after.memory.id));
        }
      });
  }
  test('ordinary recall follows successive pending replacements: ' + language, async t => {
    const { repository, databasePath, propose } = pendingGoalFixture(t);
    const initial = propose({ id: 'original', content: original });
    const { memory: previous } = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: initial.id });
    const first = propose({ id: 'first-update', action: 'supersede', previous, content: replacement, time: '2026-08-03T08:00:00Z' });
    const { memory: intermediate } = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: first.id });
    const latest = propose({ id: 'last-update', action: 'supersede', previous: intermediate,
      content: language === 'Chinese' ? '最后定在周二南馆。' : 'The final arrangement is Tuesday at the south hall.', time: '2026-08-04T08:00:00Z' });
    const { memory: current } = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: latest.id });
    repository.upsertMemory({ id: 'matched-event', agentId: 'agent-test', kind: 'event', layer: 'episodic',
      title: query, content: original, subjectRole: 'user', subjectKey: 'user', importance: 1, eventDate: '2026-08-02' });
    repository.upsertEdge({ agentId: 'agent-test', fromMemoryId: current.id, toMemoryId: 'matched-event',
      relation: 'shares_entity', direction: 'directed', weight: 1, confidence: 1 });
    const result = await retrieveMemories({ databasePath, agentId: 'agent-test', query,
      now: new Date('2026-08-05T08:00:00Z'), options: { execution: 'inline', maximumContextChars: 3000 } });
    assert.equal(result.status, 'ready');
    assert.ok(result.graph.selectedMemoryIds.includes(current.id), result.context);
    assert.ok(result.context.includes(current.content), result.context);
    assert.ok(!result.trace.metadata.recalledMemoryIds.includes(current.id));
    const matchedEvent = result.graph.activationField.selected.find(node => node.memoryId === 'matched-event');
    assert.equal(matchedEvent.sourceCount, 1, 'The pending state can be displayed without propagating activation to the event.');
    const bounded = await retrieveMemories({ databasePath, agentId: 'agent-test', query, anchorMemoryIds: [previous.id],
      now: new Date('2026-08-05T08:00:00Z'), options: { execution: 'inline', maximumContextChars: 3000, maximumContextMemories: 1 } });
    assert.deepEqual(bounded.graph.selectedMemoryIds, [current.id], 'The current state owns a one-record budget when following an older state.');
    assert.ok(bounded.context.includes(current.content));
  });
}


for (const action of ['cancel', 'supersede']) test('state updates retain source-scope boundaries: ' + action, async t => {
  const { repository, database, databasePath, propose } = pendingGoalFixture(t);
  const memory = new MemoryService({ databasePath, agentId: 'agent-test',
    defaults: { createPrimaryRelationship: false, primaryUserId: 'user' } });
  t.after(() => memory.close());
  const scope = (eventUpperBound, clears = []) => ({ owner: 'pending-review-test', agentId: 'agent-test', eventUpperBound, clears });
  const bindSource = (proposal, id, sequence) => {
    const observation = repository.getStateEvidenceObservation('agent-test', proposal.selectedObservationId);
    const source = repository.getMemoryDetail('agent-test', observation.memory_id).sources[0];
    const receipt = memory.appendEventSources({ scope: scope(2), events: [{ occurredAt: source.occurred_at,
      content: { text: source.content }, source: { version: 1, owner: 'pending-review-test', eventId: id,
        commitSequence: sequence, spaceId: sequence === 1 ? 'primary' : 'updates', eventType: 'message.created',
        recipientAgentId: 'agent-test', sender: { kind: 'local-user', id: 'user' }, topology: { kind: 'space' } } }] });
    repository.upsertSource({ id: source.id, agentId: source.agent_id, sourceKind: source.source_kind,
      externalId: source.external_id, sourceLocator: source.source_locator, content: source.content, speaker: source.speaker,
      occurredAt: source.occurred_at, knownAt: source.known_at, recordedAt: source.recorded_at,
      worldId: source.world_id, worldFrame: source.world_frame,
      metadata: { ...source.metadata, inputEventIds: receipt.events.map(event => event.id) } });
  };
  const original = propose({ id: 'original', content: 'I plan to visit the art exhibition on Saturday.' });
  bindSource(original, 'original', 1);
  const { memory: previous } = resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: original.id, action: 'accept' });
  const content = action === 'cancel' ? 'I am not going.' : 'Sunday at the east hall instead.';
  const update = propose({ id: 'update', action, previous, content, time: '2026-08-03T08:00:00Z' });
  bindSource(update, 'update', 2);
  const { memory: pending } = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: update.id });
  const recall = sourceScope => retrieveMemories({ databasePath, agentId: 'agent-test', query: 'exhibition plans', sourceScope,
    options: { execution: 'inline', maximumContextChars: 3000 }, now: new Date('2026-08-05T08:00:00Z') });
  for (const state of ['pending', 'accepted']) {
    if (state === 'accepted') resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: update.id, action: 'accept' });
    for (const hiddenScope of [scope(1), scope(2, [{ spaceId: 'updates', throughSequence: 2 }])]) {
      const hidden = await recall(hiddenScope);
      assert.ok(!hidden.context.includes(content), hidden.context);
      assert.doesNotMatch(hidden.context, /已取消/u);
      assert.ok(!hidden.trace?.metadata.provisionalMemoryIds.includes(pending.id));
    }
    const visible = await recall(scope(2));
    assert.equal(visible.status, 'ready');
    if (state === 'pending') assert.ok(visible.context.includes(content), visible.context);
    else if (action === 'cancel') assert.match(visible.context, /已取消/u);
    else assert.ok(visible.context.includes(content), visible.context);
  }
  {
    const prototype = Object.getPrototypeOf(database);
    const prepare = prototype.prepare;
    const reads = [], canonicalReads = [];
    prototype.prepare = function (sql) {
      const statement = prepare.call(this, sql);
      if (sql.includes('canonical_key = ?') && sql.includes('AND id <> ?')) {
        return { get: (...args) => { canonicalReads.push({ sql, args }); return statement.get(...args); } };
      }
      if (!sql.includes('SELECT review_state FROM memory_reported_state_proposals')) return statement;
      return { get: (...args) => { reads.push({ sql, args }); return statement.get(...args); } };
    };
    try { await recall(scope(2)); } finally { prototype.prepare = prepare; }
    assert.equal(canonicalReads.length, 1, 'Each historical state resolves its current state once per search.');
    assert.equal(reads.length, action === 'cancel' ? 1 : 0);
    if (reads.length) assert.deepEqual(reads[0].args, ['agent-test', update.id]);
    for (const read of [...reads, ...canonicalReads]) {
      const plan = database.prepare('EXPLAIN QUERY PLAN ' + read.sql).all(...read.args);
      assert.ok(plan.some(row => /SEARCH.*INDEX/u.test(row.detail)), JSON.stringify(plan));
    }
  }
});

for (const resolution of ["dismiss", "accept"]) {
  for (const originalPending of [false, true]) test(`replacement applies before review: ${resolution}, original pending ${originalPending}`, async t => {
    const { repository, propose, recall } = pendingGoalFixture(t);
    const initial = propose({ id: 'saturday', content: '周六下午在西侧训练场练习。' });
    const { memory: previous } = originalPending
      ? materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: initial.id })
      : resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: initial.id, action: 'accept' });
    const proposal = propose({ id: 'sunday', action: 'supersede', previous,
      content: '周六取消，改到周日上午东侧训练场。', time: '2026-08-03T08:00:00.000Z' });
    const { memory: pending } = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: proposal.id });
    assert.equal(repository.getMemory(previous.id).status, 'superseded');
    assert.equal(repository.getReportedStateProposal('agent-test', proposal.id).review_state, 'pending');
    assert.equal(repository.getCurrentCanonicalMemory({ agentId: 'agent-test', subjectRole: 'user', subjectKey: 'user',
      canonicalKey: previous.canonical_key, representationLayer: 'reported', stateFamily: 'goal', includePending: true }).id, pending.id);
    assert.match((await recall([pending.id])).context, /周六取消，改到周日上午/);
    assert.equal(materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: proposal.id }).status, 'existing');
    if (originalPending) resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: initial.id, action: 'accept' });
    const result = resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: proposal.id, action: resolution });
    if (resolution === 'accept') {
      assert.equal(result.memory.id, pending.id);
      assert.equal(result.memory.status, 'active');
      assert.equal(repository.getMemory(previous.id).status, 'superseded');
    } else {
      assert.equal(repository.getMemory(pending.id).status, 'deleted');
      assert.equal(result.restored.id, previous.id);
      assert.equal(result.restored.status, 'active');
    }
  });

  test(`pending goal is indexed and recalled before ${resolution}, then its provisional copy leaves recall`, async (t) => {
    const { repository, propose, recall } = pendingGoalFixture(t);
    const proposal = propose({ id: "new-goal", content: "小夏说：我准备周末去看展。" });
    // Also covers older pending proposals that predate materialization.
    const maintenance = await runSemanticMemoryMaintenance({ repository, agentId: "agent-test" });
    assert.equal(maintenance.pendingStateMaterialization.materialized.length, 1);
    const [pending] = repository.listPendingProvisionalMemories("agent-test");
    assert.equal(pending.metadata.reportedStateProposalId, proposal.id);
    const second = materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: proposal.id });
    assert.equal(second.status, "existing");
    const embedded = [];
    await syncMemoryEmbeddings({ repository, agentId: "agent-test", model: "test-pending", dimensions: 3, embeddingProvider: async text => {
      embedded.push(text); return { vector: [1, 0, 0], model: "test-pending" };
    } });
    assert.ok(embedded.some(text => text.includes(pending.content)));
    assert.ok(repository.listEmbeddings("agent-test", "test-pending", { includeArchived: true }).some(row => row.memory_id === pending.id));
    const before = await recall([pending.id]);
    assert.match(before.context, /准备周末去看展/);
    assert.ok(before.candidates.some(candidate => candidate.memoryId === pending.id && candidate.provisional));
    assert.ok(before.trace.metadata.provisionalMemoryIds.includes(pending.id));
    const result = resolveReportedStateProposal(repository, { agentId: "agent-test", proposalId: proposal.id, action: resolution });
    assert.equal(repository.listPendingProvisionalMemories("agent-test").length, 0);
    assert.equal(repository.getMemory(pending.id).status, "deleted");
    const after = await recall(resolution === "accept" ? [result.memory.id] : [pending.id]);
    assert.ok(!after.candidates.some(candidate => candidate.memoryId === pending.id));
    if (resolution === "accept") assert.match(after.context, /准备周末去看展/);
  });

  test(`cancellation takes effect before review and ${resolution} preserves the correct state`, async (t) => {
    const { repository, propose, recall } = pendingGoalFixture(t);
    const initial = propose({ id: "initial-goal", content: "小夏说：我准备周末去看展。" });
    const { memory: previous } = resolveReportedStateProposal(repository, {
      agentId: "agent-test", proposalId: initial.id, action: "accept",
    });
    const cancellation = propose({ id: "cancel-goal", action: "cancel", previous,
      content: "小夏说：我不去了，那个计划取消。", time: "2026-08-03T08:00:00.000Z" });
    const { memory: pending } = materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id });
    assert.equal(repository.getMemory(previous.id).status, "superseded");
    assert.equal(repository.getMemory(previous.id).state_phase, "cancelled");
    assert.equal(repository.getReportedStateProposal("agent-test", cancellation.id).review_state, "pending");
    const detail = buildReviewProposalDetail({ repository, agentId: "agent-test",
      envelope: { type: "reported-state", proposal: cancellation } });
    assert.equal(detail.appliedBeforeReview, true);
    assert.equal(detail.writePreview.statePhase, "cancelled");
    assert.match(detail.writePreview.content, /那个计划取消/);
    assert.equal(detail.permissions.canDismiss, true);
    assert.equal(materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id }).status, "existing");
    const recalled = await recall([previous.id]);
    assert.ok(recalled.fragments[0].memoryIds.includes(pending.id));
    assert.match(recalled.context, /已取消/);
    assert.match(recalled.context, /那个计划取消/);
    assert.ok(recalled.context.indexOf("那个计划取消") < recalled.context.indexOf("准备周末去看展"));
    assert.ok(!recalled.trace.selectedIds.includes(pending.id));
    const reviewed = MemoryService.prototype.resolveHighLevelProposal.call({
      agentId: "agent-test", withRepository(callback) { return callback(repository); },
    }, "reported-state", cancellation.id, { action: resolution });
    if (resolution === "dismiss") assert.equal(reviewed.resolution.restored.id, previous.id);
    assert.equal(repository.getMemory(previous.id).status, resolution === "accept" ? "superseded" : "active");
    assert.equal(repository.getMemory(previous.id).state_phase, resolution === "accept" ? "cancelled" : "active");
    const after = await recall([previous.id]);
    assert.ok(!after.fragments.flatMap(fragment => fragment.memoryIds).includes(pending.id));
    if (resolution === "dismiss") assert.doesNotMatch(after.context, /那个计划取消|已取消/);
  });
}

test("an older pending cancellation does not precede a newer accepted replacement", async (t) => {
  const { repository, propose, recall } = pendingGoalFixture(t);
  const initial = propose({ id: "old-goal", content: "小夏说：我准备周末去看展。" });
  const { memory: previous } = resolveReportedStateProposal(repository, {
    agentId: "agent-test", proposalId: initial.id, action: "accept",
  });
  const cancellation = propose({ id: "older-cancel", action: "cancel", previous,
    content: "小夏说：那次计划取消。", time: "2026-08-03T08:00:00.000Z" });
  materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id });
  const replacement = propose({ id: "newer-plan", action: "supersede", previous,
    content: "小夏说：已经重新约好了，下周一起看展。", time: "2026-08-04T08:00:00.000Z" });
  const { memory: current } = resolveReportedStateProposal(repository, { agentId: "agent-test", proposalId: replacement.id, action: "accept" });
  const result = await recall([previous.id]);
  assert.match(result.context, /已经重新约好了/);
  assert.ok(result.graph.selectedMemoryIds.includes(current.id));
  assert.ok(result.graph.selectedMemoryIds.indexOf(current.id) < result.graph.selectedMemoryIds.indexOf(previous.id));
  const dismissed = resolveReportedStateProposal(repository, {
    agentId: "agent-test", proposalId: cancellation.id, action: "dismiss",
  });
  assert.equal(dismissed.restored, null, "rejecting an older cancellation must not revive a replaced plan");
  assert.equal(repository.getMemory(previous.id).status, "superseded");
  assert.equal(repository.getCurrentCanonicalMemory({ agentId: "agent-test", subjectRole: "user", subjectKey: "user",
    canonicalKey: previous.canonical_key, representationLayer: "reported", stateFamily: "goal" }).content,
    "小夏说：已经重新约好了，下周一起看展。");
});

for (const resolution of ['accept', 'dismiss']) test(`reviewing an older pending replacement does not undo its successor: ${resolution}`, async t => {
  const { repository, propose, databasePath } = pendingGoalFixture(t);
  const initial = propose({ id: 'initial', content: '周六看展。' });
  const { memory: first } = resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: initial.id, action: 'accept' });
  const secondProposal = propose({ id: 'second', action: 'supersede', previous: first, content: '改到周日。', time: '2026-08-03T08:00:00Z' });
  const { memory: second } = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: secondProposal.id });
  const thirdProposal = propose({ id: 'third', action: 'supersede', previous: second, content: '改到下周。', time: '2026-08-04T08:00:00Z' });
  const { memory: third } = materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: thirdProposal.id });
  const reviewed = resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: secondProposal.id, action: resolution });
  assert.equal(repository.getMemory(first.id).status, 'superseded');
  if (resolution === 'dismiss') assert.equal(reviewed.restored, null);
  else assert.equal(reviewed.memory.status, 'superseded');
  assert.equal(repository.getCurrentCanonicalMemory({ agentId: 'agent-test', subjectRole: 'user', subjectKey: 'user',
    canonicalKey: first.canonical_key, representationLayer: 'reported', stateFamily: 'goal', includePending: true }).id, third.id);
  const withdrawn = resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: thirdProposal.id, action: 'dismiss' });
  assert.equal(withdrawn.restored?.id, resolution === 'dismiss' ? first.id : second.id);
  if (resolution === 'dismiss') {
    // Recreate the old database shape. The withdrawn middle version used to
    // leave its cutoff on the still-supported original after both dismissals.
    const transition = readReportedStateTransition(repository, repository.getReportedStateProposal('agent-test', secondProposal.id));
    assert.ok(repository.restoreReportedStateTransition({ agentId: 'agent-test', proposalId: secondProposal.id, ...transition, reapply: true }));
    const service = new MemoryService({ databasePath, dataRoot: path.dirname(databasePath), agentId: 'agent-test',
      defaults: { createPrimaryRelationship: false } });
    try {
      service.initialize();
      assert.equal(service.getMemory(first.id).memory.status, 'active');
      assert.equal(service.getMemory(second.id).memory.status, 'deleted');
      assert.equal(service.getMemory(third.id).memory.status, 'deleted');
    } finally { await service.close(); }
  }
});

for (const newestFirst of [false, true]) test(`recovers successive state replacements as their sources return, newest first=${newestFirst}`, t => {
  const { repository, propose } = pendingGoalFixture(t);
  const agentId = 'agent-test';
  const first = propose({ id: 'first-visit', content: '周六看展。' });
  const original = applyReportedStateProposal(repository, { agentId, proposalId: first.id }).memory;
  const middle = propose({ id: 'second-visit', action: 'supersede', previous: original,
    content: '改到周日。', time: '2026-08-03T08:00:00Z' });
  const second = materializeReportedStateProposal(repository, { agentId, proposalId: middle.id }).memory;
  const latest = propose({ id: 'third-visit', action: 'supersede', previous: second,
    content: '改到周一。', time: '2026-08-04T08:00:00Z' });
  const third = materializeReportedStateProposal(repository, { agentId, proposalId: latest.id }).memory;
  const toggle = (proposal, deleted) => repository.setMemoryDeleted({ agentId, memoryId: proposal.draft.evidenceMemoryIds[0], deleted });
  const currentId = () => repository.getCurrentCanonicalMemory({ agentId, subjectRole: original.subject_role, subjectKey: original.subject_key,
    canonicalKey: original.canonical_key, representationLayer: 'reported', stateFamily: 'goal', includePending: true })?.id;
  toggle(middle, true);
  assert.equal(currentId(), third.id);
  toggle(latest, true);
  assert.equal(currentId(), original.id);
  toggle(newestFirst ? latest : middle, false);
  assert.equal(currentId(), newestFirst ? third.id : second.id);
  toggle(newestFirst ? middle : latest, false);
  assert.equal(currentId(), third.id);
  assert.equal(repository.getReportedStateProposal(agentId, latest.id).review_state, 'pending');
  const confirmed = resolveReportedStateProposal(repository, { agentId, proposalId: latest.id, action: 'accept' });
  assert.equal(confirmed.memory.id, third.id);
  resolveReportedStateProposal(repository, { agentId, proposalId: latest.id, action: 'dismiss' });
  assert.equal(currentId(), second.id);
});

test('a pending plan without a formal result follows the availability of its own evidence', async t => {
  const { repository, propose, recall } = pendingGoalFixture(t);
  const agentId = 'agent-test';
  const proposal = propose({ id: 'pending-only', content: '我周六准备去看展。' });
  const { memory } = materializeReportedStateProposal(repository, { agentId, proposalId: proposal.id });
  const memoryId = proposal.draft.evidenceMemoryIds[0];
  const recallsPlan = async () => (await recall([memory.id])).context.includes(memory.content);
  assert.equal(await recallsPlan(), true);
  repository.setMemoryDeleted({ agentId, memoryId });
  assert.equal(repository.getMemory(memory.id).status, 'deleted');
  assert.equal(await recallsPlan(), false);
  repository.setMemoryDeleted({ agentId, memoryId, deleted: false });
  assert.equal(await recallsPlan(), true);
  assert.equal(repository.getReportedStateProposal(agentId, proposal.id).review_state, 'pending');
});

for (const resolution of ["accept", "dismiss"]) {
  for (const approveOriginalFirst of [true, false]) {
    test(`pending original goal survives review order: cancel ${resolution}, original first ${approveOriginalFirst}`, t => {
      const { repository, propose } = pendingGoalFixture(t);
      const initial = propose({ id: "unreviewed-goal", content: "小夏说：我准备周末去看展。" });
      const { memory: previous } = materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: initial.id });
      const cancellation = propose({ id: "cancel-unreviewed", action: "cancel", previous,
        content: "小夏说：看展的安排取消。", time: "2026-08-03T08:00:00.000Z" });
      materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id });
      assert.equal(repository.getMemory(previous.id).state_phase, "cancelled");
      const approveOriginal = () => resolveReportedStateProposal(repository, {
        agentId: "agent-test", proposalId: initial.id, action: "accept",
      });
      if (approveOriginalFirst) {
        const accepted = approveOriginal();
        assert.equal(accepted.memory.id, previous.id, "dependent transitions must retain their target identity");
        assert.equal(accepted.memory.state_phase, "cancelled", "approving the old plan must not reactivate it");
      }
      const reviewed = resolveReportedStateProposal(repository, {
        agentId: "agent-test", proposalId: cancellation.id, action: resolution,
      });
      if (resolution === "dismiss") {
        assert.equal(reviewed.restored.id, previous.id);
        assert.equal(reviewed.restored.status, approveOriginalFirst ? "active" : "archived");
        assert.equal(reviewed.restored.valid_to, null);
      }
      if (!approveOriginalFirst) approveOriginal();
      const final = repository.getMemory(previous.id);
      assert.equal(final.state_phase, resolution === "accept" ? "cancelled" : "active");
      assert.equal(final.status, resolution === "accept" ? "superseded" : "active");
      assert.equal(final.layer, "prospective");
      assert.equal(repository.listPendingProvisionalMemories("agent-test").length, 0);
    });
  }
}

test("dismissing a cancellation does not restore a deleted original goal", t => {
  const { repository, propose } = pendingGoalFixture(t);
  const initial = propose({ id: "dismissed-original", content: "小夏说：我准备周末去看展。" });
  const { memory: previous } = materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: initial.id });
  const cancellation = propose({ id: "cancel-dismissed-original", action: "cancel", previous,
    content: "小夏说：那个计划取消。", time: "2026-08-03T08:00:00.000Z" });
  materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id });
  resolveReportedStateProposal(repository, { agentId: "agent-test", proposalId: initial.id, action: "dismiss" });
  const result = resolveReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id, action: "dismiss" });
  assert.equal(result.restored, null);
  assert.equal(repository.getMemory(previous.id).status, "deleted");
});

test("failed cancellation materialization rolls back the lifecycle change", t => {
  const { repository, propose } = pendingGoalFixture(t);
  const initial = propose({ id: "atomic-original", content: "小夏说：我准备周末去看展。" });
  const { memory: previous } = resolveReportedStateProposal(repository, { agentId: "agent-test", proposalId: initial.id, action: "accept" });
  const cancellation = propose({ id: "atomic-cancel", action: "cancel", previous,
    content: "小夏说：那个计划取消。", time: "2026-08-03T08:00:00.000Z" });
  const linkSource = repository.linkSource.bind(repository);
  repository.linkSource = () => { throw new Error("simulated source link failure"); };
  assert.throws(() => materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id }), /simulated/);
  repository.linkSource = linkSource;
  assert.equal(repository.getMemory(previous.id).status, "active");
  assert.equal(repository.getMemory(previous.id).state_phase, "active");
  assert.equal(repository.getMemory(previous.id).metadata.reportedStateTransitionId, undefined);
  assert.equal(repository.listPendingProvisionalMemories("agent-test").length, 0);
  materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id });
  assert.equal(repository.getMemory(previous.id).state_phase, "cancelled");
});

test("maintenance applies an older pending cancellation that already has a provisional record", async t => {
  const { repository, propose } = pendingGoalFixture(t);
  const initial = propose({ id: "legacy-original", content: "小夏说：我准备周末去看展。" });
  const { memory: previous } = resolveReportedStateProposal(repository, { agentId: "agent-test", proposalId: initial.id, action: "accept" });
  const cancellation = propose({ id: "legacy-cancel", action: "cancel", previous,
    content: "小夏说：那个计划取消。", time: "2026-08-03T08:00:00.000Z" });
  const { memory: pending } = materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id });
  // Reconstruct the persisted layout from before transitions applied at materialization.
  repository.restoreReportedStateTransition({ agentId: "agent-test", proposalId: cancellation.id,
    ...pending.metadata.reportedStateTransition });
  const metadata = { ...pending.metadata };
  delete metadata.reportedStateTransition;
  repository.updateMemoryMetadata({ agentId: "agent-test", memoryId: pending.id, metadata });
  assert.equal(repository.getMemory(previous.id).status, "active");
  const result = await runSemanticMemoryMaintenance({ repository, agentId: "agent-test" });
  assert.equal(result.pendingStateMaterialization.failed.length, 0);
  assert.equal(repository.getMemory(previous.id).state_phase, "cancelled");
  assert.ok(repository.getMemory(pending.id).metadata.reportedStateTransition);
  const dismissed = resolveReportedStateProposal(repository, { agentId: "agent-test", proposalId: cancellation.id, action: "dismiss" });
  assert.equal(dismissed.restored.status, "active");
});

test("repairs only derived reported world attributes with matching semantic provenance", t => {
  const { database, repository } = setup(); t.after(() => database.close());
  const observation = addReportedBeliefObservation(repository);
  database.prepare("UPDATE memory_nodes SET world_id=?, world_frame=? WHERE id=?").run("story-a", "fictional", observation.memory_id);
  const draft = repository.upsertMemory({ id: "semantic-world-draft", agentId: "agent-test", kind: "belief_state", layer: "provisional",
    content: "Within this story, the subject finds rain peaceful.", title: "Rain", subjectRole: "user", subjectKey: "user",
    reality: "fictional", worldId: "story-a", worldFrame: "fictional",
    metadata: { stateAnalysisDraft: true, stateAnalysisRequestId: "world-request" } });
  const proposal = repository.recordReportedStateProposal({ agentId: "agent-test", stateFamily: "belief", subjectRole: "user", subjectKey: "user",
    canonicalKey: TARGET, action: "create", proposedState: beliefDraft(observation), reviewVersion: "test-world", inputHash: "world-input",
    selectedObservationId: observation.id, consideredObservationIds: [observation.id],
    metadata: { semanticMemoryId: draft.id, stateAnalysisRequestId: "world-request", semanticMemorySnapshot: { title: draft.title, content: draft.content } } });
  const pending = materializeReportedStateProposal(repository, { agentId: "agent-test", proposalId: proposal.id }).memory;
  const formal = resolveReportedStateProposal(repository, { agentId: "agent-test", proposalId: proposal.id, action: "accept" }).memory;
  assert.equal(formal.reality, "fictional");
  database.prepare("UPDATE memory_nodes SET reality='real' WHERE id=?").run(formal.id);
  const other = repository.upsertMemory({ id: "other-world-derived", agentId: "agent-test", kind: "belief_state", layer: "semantic",
    subjectRole: "user", subjectKey: "user", content: "A different world", reality: "real", worldId: "story-b", worldFrame: "fictional",
    metadata: { reportedStateProposalId: proposal.id } });
  const migration = MIGRATIONS.find(item => item.version === 47);
  database.exec(migration.sql);
  assert.equal(repository.getMemory(formal.id).reality, "fictional");
  assert.equal(repository.getMemory(other.id).reality, "real");
  assert.equal(repository.getMemory(pending.id).status, "deleted");
  const writes = Number(database.prepare("SELECT total_changes() AS n").get().n);
  database.exec(migration.sql);
  assert.equal(Number(database.prepare("SELECT total_changes() AS n").get().n), writes);
});

for (const action of ['accept', 'dismiss']) test(`a fictional goal completion and ${action} preserve the real goal`, t => {
  const { database, repository } = setup(); t.after(() => database.close());
  const key = 'user:goal:world-publication';
  const goal = (id, reality, worldId, worldFrame, day) => repository.upsertMemory({ id, agentId: 'agent-test', kind: 'plan', layer: 'prospective',
    content: id, subjectRole: 'user', subjectKey: 'user', canonicalKey: key, representationLayer: 'reported', stateFamily: 'goal',
    statePhase: 'active', temporalState: 'in_progress', evidenceMode: 'explicit', reality, worldId, worldFrame,
    knownAt: `2026-08-${day}T08:00:00.000Z`, validFrom: `2026-08-${day}T08:00:00.000Z` });
  const fictional = goal('fictional-goal', 'fictional', 'story', 'fictional', '01');
  const real = goal('real-goal', 'real', 'room', 'physical', '02');
  const evidence = addReportedBeliefObservation(repository, { id: `world-completion-${action}`, stateFamily: 'goal', canonicalKey: key,
    occurredAt: '2026-08-05T08:00:00.000Z', signal: 'goal_completion' });
  database.prepare("UPDATE memory_nodes SET reality='fictional',world_id='story',world_frame='fictional' WHERE id=?").run(evidence.memory_id);
  const proposal = repository.recordReportedStateProposal({ agentId: 'agent-test', stateFamily: 'goal', subjectRole: 'user', subjectKey: 'user',
    canonicalKey: key, action: 'complete', previousMemoryId: fictional.id, proposedState: null, reviewVersion: 'world-test', inputHash: `world-completion-${action}`,
    selectedObservationId: evidence.id, consideredObservationIds: [evidence.id] });
  materializeReportedStateProposal(repository, { agentId: 'agent-test', proposalId: proposal.id });
  assert.equal(repository.getMemory(real.id).status, 'active');
  resolveReportedStateProposal(repository, { agentId: 'agent-test', proposalId: proposal.id, action });
  assert.equal(repository.getMemory(real.id).status, 'active');
  assert.equal(repository.getMemory(fictional.id).status, action === 'accept' ? 'superseded' : 'active');
  assert.deepEqual([repository.getMemory(fictional.id).reality, repository.getMemory(fictional.id).world_id], ['fictional', 'story']);
});
