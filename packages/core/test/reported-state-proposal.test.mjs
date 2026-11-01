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

import {
  MemoryRepository,
  openMemoryDatabase,
  resolveReportedStateProposal,
  materializeReportedStateProposal,
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

test("accepts create, reinforce, and supersede as three distinct reported-state actions", () => {
  const { database, repository } = setup();
  const initialObservation = addReportedBeliefObservation(repository, {
    id: "initial-rain-belief",
    occurredAt: "2026-08-02T08:00:00.000Z",
  });
  const initialProposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    batchId: "initial-review",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "create",
    proposedState: beliefDraft(initialObservation),
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
  assert.equal(created.memory.content, "用户明确说自己觉得雨天很安静。");
  assert.equal(created.memory.state_family, "belief");
  assert.equal(created.memory.representation_layer, "reported");
  assert.equal(created.memory.metadata.reportedStateDraft.proposition.text, "我觉得雨天很安静。");
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: created.memory.id,
    toMemoryId: initialObservation.memory_id,
    relation: "supported_by",
  }).relation, "supported_by");

  const reinforcement = addReportedBeliefObservation(repository, {
    id: "reinforce-rain-belief",
    sourceContent: "我还是觉得雨天很安静。",
    content: "用户再次明确表示自己觉得雨天很安静。",
    occurredAt: "2026-08-03T08:00:00.000Z",
  });
  const reinforceProposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "reinforce",
    previousMemoryId: created.memory.id,
    proposedState: beliefDraft(reinforcement, {
      claimText: "我还是觉得雨天很安静。",
      validFrom: "2026-08-03T08:00:00.000Z",
    }),
    reviewVersion: "reported-belief-review-v1",
    inputHash: createHash("sha256").update("reinforcement").digest("hex"),
    selectedObservationId: reinforcement.id,
    consideredObservationIds: [reinforcement.id],
  });
  const reinforced = resolveReportedStateProposal(repository, {
    agentId: "agent-test",
    proposalId: reinforceProposal.id,
    action: "accept",
  });
  assert.equal(reinforced.status, "reinforced");
  assert.equal(reinforced.memory.id, created.memory.id);
  assert.equal(repository.listCanonicalStateHistory({
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
  }).length, 1);

  const changedObservation = addReportedBeliefObservation(repository, {
    id: "changed-rain-belief",
    sourceContent: "我现在觉得雨天让人烦躁。",
    content: "用户明确表示自己现在觉得雨天让人烦躁。",
    occurredAt: "2026-08-04T08:00:00.000Z",
  });
  const changedProposal = repository.recordReportedStateProposal({
    agentId: "agent-test",
    stateFamily: "belief",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: TARGET,
    action: "supersede",
    previousMemoryId: created.memory.id,
    proposedState: beliefDraft(changedObservation, {
      claimText: "我现在觉得雨天让人烦躁。",
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
    canonicalKey: TARGET,
    representationLayer: "reported",
    stateFamily: "belief",
  }).id, changed.memory.id);
  assert.equal(repository.findEdge({
    agentId: "agent-test",
    fromMemoryId: changed.memory.id,
    toMemoryId: created.memory.id,
    relation: "supersedes",
  }).metadata.transition, "supersede");
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
    sourceContent: "我现在不喜欢鱼了。",
    content: "用户报告自己现在不喜欢鱼类食物。",
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
        polarity: "negative",
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

for (const resolution of ['accept', 'dismiss']) test(`reviewing an older pending replacement does not undo its successor: ${resolution}`, t => {
  const { repository, propose } = pendingGoalFixture(t);
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
