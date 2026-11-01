import assert from "node:assert/strict";
import test from "node:test";
import { MemoryRepository, openMemoryDatabase, resolveReportedStateProposal } from "@suzu-memory/core";
import {
  evaluateIdentityEvidence,
  reviewReportedIdentityState,
  proposeReportedStateFromReview,
} from "../src/index.mjs";

const KEY = "user:identity:residence:current";

function setup({ currentLayer = "", field = "residence", value = "杭州", cardinality = "sequence" } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  let current = null;
  if (currentLayer) {
    current = repository.upsertMemory({
      id: `current-${currentLayer}-identity`,
      agentId: "agent-test",
      kind: "fact",
      layer: "semantic",
      content: `用户报告的${field}是${value}。`,
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      representationLayer: currentLayer,
      stateFamily: "identity",
      statePhase: "active",
      reality: "real",
      evidenceMode: currentLayer === "reported" ? "explicit" : "observed",
      temporalState: "current",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
      metadata: {
        identityClaim: {
          identityField: field,
          identityLabel: "当前长期居住地",
          valueText: value,
          fieldCardinality: cardinality,
          scope: { valueScope: "长期居住地" },
          holderStatementStatus: currentLayer === "reported" ? "directly-reported" : "externally-supported",
          externalVerificationStatus: currentLayer === "reported" ? "unverified" : "verified",
        },
      },
      actorRoles: [{ role: "subject", actorRole: "user", actorKey: "user", isPrimary: true }],
    });
  }
  return { database, repository, current };
}

function add(fixture, {
  id,
  text,
  observedAt = "2026-07-10T12:00:00.000Z",
  speakerRole = "user",
  speakerKey = "user",
  worldId = "", worldFrame = "",
} = {}) {
  const source = fixture.repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: `source-${id}`,
    occurredAt: observedAt,
    speaker: speakerRole === "user" ? "User" : "Agent",
    content: text,
  });
  const memory = fixture.repository.upsertMemory({
    id,
    agentId: "agent-test",
    kind: "event",
    layer: "semantic",
    content: text,
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    ...(worldId ? { worldId, worldFrame } : {}),
    temporalState: "current",
    eventStart: observedAt,
    knownAt: observedAt,
    actorRoles: [
      { role: "speaker", actorRole: speakerRole, actorKey: speakerKey, isPrimary: true },
      { role: "subject", actorRole: "user", actorKey: "user" },
    ],
  });
  fixture.repository.linkSource(memory.id, source.id, "evidence", {
    authority: speakerRole === "user" ? "subject_firsthand" : "model_inference",
    sourceTrust: 0.9,
    evidenceStrength: 1,
    provenance: "test",
  });
  return { memory, source };
}

function common(record) {
  return { memoryId: record.memory.id, sourceIds: [record.source.id], confidence: 0.9, rationale: "来源直接支持。" };
}

function analyzers(record, {
  identityField = "residence",
  valueText = "上海",
  statementPolarity = "asserts",
  attribution = "explicit_self_report",
  classification = "identity_fact",
  sensitivity = "personal",
  factTime = "current",
  revisionCue = "none",
  currentStatePresent = false,
  relation = "no_current_state",
  valueOverlap = "none",
  valueScope = "长期居住地",
  valueRelations = [],
} = {}) {
  return {
    fieldValue: async () => ({ output: { analyses: [{ ...common(record), targetMatch: "exact",
      identityField, valueText, statementPolarity, valueScope, valueRelations }] } }),
    subjectAttribution: async () => ({ output: { analyses: [{ ...common(record), subjectMatch: "yes", attribution }] } }),
    familyBoundary: async () => ({ output: { analyses: [{ ...common(record), classification, sensitivity }] } }),
    timeRevision: async () => ({ output: { analyses: [{ ...common(record), factTime, revisionCue, timeReference: "" }] } }),
    currentRelation: async () => ({ output: { analyses: [{ ...common(record), currentStatePresent, relation, valueOverlap }] } }),
  };
}

async function evaluate(fixture, record, options = {}, overrides = {}) {
  return evaluateIdentityEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    identityField: options.identityField || "residence",
    identityLabel: "当前长期居住地",
    fieldCardinality: overrides.fieldCardinality || "sequence",
    memoryIds: [record.memory.id],
    analyzers: analyzers(record, options),
    currentRepresentationLayer: Object.hasOwn(overrides, "currentRepresentationLayer")
      ? overrides.currentRepresentationLayer
      : "reported",
  });
}

function review(fixture) {
  return reviewReportedIdentityState({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    subjectLabel: "用户",
    identityLabel: "当前长期居住地",
  });
}

function linkCurrent(fixture, record, relation = "supported_by") {
  fixture.repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: fixture.current.id,
    toMemoryId: record.memory.id,
    relation,
    direction: "directed",
    weight: 0.9,
    confidence: 0.9,
    provenance: "test",
  });
}

test("creates an unverified reported identity without establishing an external fact", async () => {
  const fixture = setup();
  const record = add(fixture, { id: "direct-residence", text: "我现在长期住在上海。" });
  await evaluate(fixture, record);
  const result = review(fixture);
  assert.equal(result.action, "create");
  assert.equal(result.proposedState.kind, "fact");
  assert.equal(result.proposedState.representationLayer, "reported");
  assert.equal(result.proposedState.identityClaim.externalVerificationStatus, "unverified");
  assert.equal(result.automaticEstablishedIdentityWriteAllowed, false);
  fixture.database.close();
});

test("does not disguise a direct system record as the subject's own report", async () => {
  const fixture = setup();
  const record = add(fixture, { id: "system-record", text: "账户资料中的长期居住城市为上海。" });
  await evaluate(fixture, record, { attribution: "direct_system_record" });
  const result = review(fixture);
  assert.equal(result.status, "skipped");
  assert.equal(result.automaticExternalAccountSyncAllowed, false);
  fixture.database.close();
});

test("does not let established identity occupy the reported layer", async () => {
  const fixture = setup({ currentLayer: "established" });
  const record = add(fixture, { id: "reported-over-established", text: "我现在长期住在上海。" });
  await evaluate(fixture, record);
  const result = review(fixture);
  assert.equal(result.action, "create");
  assert.equal(result.currentStateId, "");
  assert.equal(result.snapshot.currentState, null);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("rejects identity evidence compared against an unspecified layer", async () => {
  const fixture = setup();
  const record = add(fixture, { id: "unspecified-layer", text: "我现在长期住在上海。" });
  await evaluate(fixture, record, {}, { currentRepresentationLayer: "" });
  const result = review(fixture);
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "no-qualified-direct-current-identity-report");
  fixture.database.close();
});

test("keeps different direct identity reports unresolved without a change cue", async () => {
  const fixture = setup();
  const first = add(fixture, { id: "hangzhou", text: "我现在长期住在杭州。", observedAt: "2026-07-10T12:00:00.000Z" });
  const second = add(fixture, { id: "shanghai", text: "我现在长期住在上海。", observedAt: "2026-07-11T12:00:00.000Z" });
  await evaluate(fixture, first, { valueText: "杭州" });
  await evaluate(fixture, second, { valueText: "上海" });
  const result = review(fixture);
  assert.equal(result.status, "review_required");
  assert.equal(result.reason, "multiple-unresolved-direct-states-without-change-cue");
  fixture.database.close();
});

test("supersedes only the reported sequence after an explicit residence change", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = add(fixture, { id: "moved", text: "我已经从杭州搬到上海长期住了。" });
  await evaluate(fixture, record, {
    revisionCue: "changed",
    currentStatePresent: true,
    relation: "value_changed",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "supersede");
  assert.equal(result.proposedState.identityClaim.valueText, "上海");
  assert.equal(result.truthBoundary.establishedIdentityIsUnaffected, true);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("extends a multi-value identity without losing earlier values or their sources", async () => {
  const fixture = setup({ currentLayer: "reported", field: "alias", value: "小铃", cardinality: "multi_item" });
  const original = add(fixture, { id: "original-alias", text: "我使用别名小铃。", observedAt: "2026-07-09T12:00:00.000Z" });
  await evaluate(fixture, original, { identityField: "alias", valueText: "小铃", currentStatePresent: true, relation: "equivalent" }, { fieldCardinality: "multi_item" });
  linkCurrent(fixture, original);
  const record = add(fixture, { id: "other-alias", text: "我也使用别名小五。" });
  await evaluate(fixture, record, {
    identityField: "alias",
    valueText: "小五",
    currentStatePresent: true,
    relation: "additional_value",
  }, { fieldCardinality: "multi_item" });
  const result = review(fixture);
  assert.equal(result.status, "ready");
  assert.equal(result.action, "supersede");
  assert.deepEqual(new Set(result.proposedState.identityClaim.values.map(item => item.valueText)), new Set(["小铃", "小五"]));
  const proposal = proposeReportedStateFromReview({ repository: fixture.repository, reviewResult: result, reviewVersion: "test-identity-set" }).proposal;
  const accepted = resolveReportedStateProposal(fixture.repository, { agentId: "agent-test", proposalId: proposal.id, action: "accept" });
  assert.match(accepted.memory.content, /小铃/u);
  assert.match(accepted.memory.content, /小五/u);
  assert.equal(fixture.repository.listMemorySources(accepted.memory.id).length, 2);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "superseded");
  const repeated = review(fixture);
  assert.equal(repeated.action, "reinforce", "already retained additions must not replace the set again");
  const repeatedProposal = proposeReportedStateFromReview({ repository: fixture.repository, reviewResult: repeated, reviewVersion: "test-identity-set-repeat" }).proposal;
  const oldLinkSource = fixture.repository.linkSource.bind(fixture.repository);
  const oldUpdateMetadata = fixture.repository.updateMemoryMetadata.bind(fixture.repository);
  const writes = { source: 0, metadata: 0 };
  fixture.repository.linkSource = (id, ...args) => { if (id === accepted.memory.id) writes.source++; return oldLinkSource(id, ...args); };
  fixture.repository.updateMemoryMetadata = args => { if (args.memoryId === accepted.memory.id) writes.metadata++; return oldUpdateMetadata(args); };
  const confirmed = resolveReportedStateProposal(fixture.repository, { agentId: "agent-test", proposalId: repeatedProposal.id, action: "accept" });
  assert.deepEqual(writes, { source: 0, metadata: 0 }, "reusing the same evidence must not rewrite sources or metadata");
  assert.equal(confirmed.memory.id, accepted.memory.id);
  assert.equal(fixture.repository.listMemorySources(confirmed.memory.id).length, 2);
  assert.deepEqual(confirmed.memory.metadata.reportedStateDraft.identityClaim.values, accepted.memory.metadata.reportedStateDraft.identityClaim.values);
  fixture.database.close();
});

test("retires only the reported identity sequence after an explicit ending", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = add(fixture, { id: "residence-ended", text: "我已经不住在杭州了。" });
  await evaluate(fixture, record, {
    valueText: "杭州",
    statementPolarity: "denies",
    revisionCue: "ended",
    currentStatePresent: true,
    relation: "retires",
    valueOverlap: "exact",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "retire");
  assert.equal(result.proposedState, null);
  assert.equal(fixture.repository.getMemory(fixture.current.id).status, "active");
  fixture.database.close();
});

test("corrects a denied reported attribution without creating a replacement identity", async () => {
  const fixture = setup({ currentLayer: "reported" });
  const record = add(fixture, { id: "wrong-attribution", text: "我从没说过自己住在杭州，那条记录不是我的。" });
  await evaluate(fixture, record, {
    valueText: "杭州",
    statementPolarity: "denies",
    revisionCue: "denies_prior_state",
    currentStatePresent: true,
    relation: "same_scope_conflict",
    valueOverlap: "exact",
  });
  linkCurrent(fixture, record, "challenged_by");
  const result = review(fixture);
  assert.equal(result.action, "correct_attribution");
  assert.equal(result.proposedState, null);
  assert.equal(result.automaticCredentialWriteAllowed, false);
  fixture.database.close();
});

async function evaluateIdentityGroup(fixture, records, options, { identityField = "other", identityLabel = "pets" } = {}) {
  const keys = Object.keys(analyzers(records[0]));
  return evaluateIdentityEvidence({ repository: fixture.repository, agentId: "agent-test",
    subjectRole: "user", subjectKey: "user", canonicalKey: KEY, identityField,
    identityLabel, fieldCardinality: "multi_item", currentRepresentationLayer: "reported",
    memoryIds: records.map(record => record.memory.id),
    analyzers: Object.fromEntries(keys.map(key => [key, async () => ({ output: { analyses:
      (await Promise.all(records.map((record, index) => analyzers(record, { identityField, ...options[index] })[key]())))
        .flatMap(result => result.output.analyses) } })])),
  });
}

for (const [language, ownership, names] of [
  ["en", "I have a dog and a cat.", "Their names are Milo and Nori."],
  ["zh", "我有一只狗和一只猫。", "它们叫阿圆和小白。"],
]) {
  test("complementary identity facts preserve both values and sources: " + language, async () => {
    const fixture = setup();
    try {
      const first = add(fixture, { id: "pet-types", text: ownership });
      const second = add(fixture, { id: "pet-names", text: names, observedAt: "2026-07-10T12:01:00.000Z" });
      const result = await evaluateIdentityGroup(fixture, [first, second], [
        { valueText: ownership, valueScope: "pet types", valueRelations: [{ memoryId: second.memory.id, relation: "complementary" }] },
        { valueText: names, valueScope: "pet names" },
      ]);
      assert.equal(result.status, "analyzed");
      assert.ok(result.observations.every(item => item.qualification === "qualified"));
      const reviewed = review(fixture);
      assert.equal(reviewed.status, "ready");
      assert.equal(reviewed.action, "create");
      assert.equal(reviewed.proposedState.evidenceObservationIds.length, 2);
      const proposal = proposeReportedStateFromReview({ repository: fixture.repository, reviewResult: reviewed, reviewVersion: "identity-complementary-test" }).proposal;
      const accepted = resolveReportedStateProposal(fixture.repository, { agentId: "agent-test", proposalId: proposal.id, action: "accept" });
      assert.ok(accepted.memory.content.includes(ownership));
      assert.ok(accepted.memory.content.includes(names));
      assert.deepEqual(new Set(fixture.repository.listMemorySources(accepted.memory.id).map(item => item.id)), new Set([first.source.id, second.source.id]));
      assert.equal(accepted.memory.metadata.reportedStateDraft.identityClaim.values.length, 2);
      await evaluateIdentityGroup(fixture, [first, second], [
        { valueText: ownership, valueScope: "pet types", currentStatePresent: true, relation: "supports",
          valueRelations: [{ memoryId: second.memory.id, relation: "complementary" }] },
        { valueText: names, valueScope: "pet names", currentStatePresent: true, relation: "supports" },
      ]);
      assert.equal(review(fixture).action, "reinforce");
    } finally { fixture.database.close(); }
  });
}

test("explicit value conflicts override a claimed complementary relation", async () => {
  const fixture = setup();
  try {
    const first = add(fixture, { id: "name-one", text: "My only cat is named Nori." });
    const second = add(fixture, { id: "name-two", text: "My only cat is named Taro." });
    await evaluateIdentityGroup(fixture, [first, second], [
      { valueText: "Nori", valueRelations: [{ memoryId: second.memory.id, relation: "complementary" }] },
      { valueText: "Taro", valueRelations: [{ memoryId: first.memory.id, relation: "conflicting" }] },
    ]);
    assert.equal(review(fixture).status, "review_required");
  } finally { fixture.database.close(); }
});

test("identity peer comparisons reject references outside the bounded snapshot", async () => {
  const fixture = setup();
  try {
    const record = add(fixture, { id: "inside", text: "I have two pets." });
    const result = await evaluateIdentityGroup(fixture, [record], [{ valueText: "two pets",
      valueRelations: [{ memoryId: "outside", relation: "complementary" }] }]);
    assert.equal(result.status, "incomplete");
    assert.equal(result.observations.length, 0);
  } finally { fixture.database.close(); }
});

test("identity retries analyze only the failed item while keeping accepted peers read-only", async t => {
  const fixture = setup();
  try {
    const first = add(fixture, { id: "types", text: "I have a dog and a cat." });
    const second = add(fixture, { id: "names", text: "Their names are Milo and Nori." });
    const calls = {};
    const snapshots = [];
    let retry = false;
    const generators = Object.fromEntries(Object.keys(analyzers(first)).map(key => [key, async request => {
      calls[key] = (calls[key] || 0) + 1;
      const snapshot = JSON.parse(request.input.slice(request.input.indexOf('\n{') + 1));
      if (key === "fieldValue") snapshots.push({ memories: snapshot.memories.map(item => item.id),
        peers: snapshot.comparisonMemories?.map(item => item.memoryId) || [], sources: snapshot.sourceRecords.length });
      const analyses = await Promise.all(snapshot.memories.map(memory => {
        const isFirst = memory.id === first.memory.id;
        return analyzers(isFirst ? first : second, { identityField: "other", valueText: memory.content,
          valueScope: isFirst ? "pet types" : "pet names",
          valueRelations: retry && !isFirst ? [{ memoryId: first.memory.id, relation: "complementary" }] : [] })[key]();
      }));
      const items = analyses.flatMap(item => item.output.analyses);
      if (key === "fieldValue" && !retry) items.find(item => item.memoryId === second.memory.id).sourceIds = ["outside"];
      return { output: { analyses: items } };
    }]));
    const evaluate = () => evaluateIdentityEvidence({ repository: fixture.repository, agentId: "agent-test",
      subjectRole: "user", subjectKey: "user", canonicalKey: KEY, identityField: "other", identityLabel: "pets",
      fieldCardinality: "multi_item", currentRepresentationLayer: "reported", memoryIds: [first.memory.id,second.memory.id],
      analyzers: generators, snapshotOptions: { reuseAnalysisRuns: true } });
    assert.equal((await evaluate()).status, "incomplete");
    retry = true;
    assert.equal((await evaluate()).status, "analyzed");
    assert.equal(review(fixture).status, "ready");
    assert.deepEqual(calls, { fieldValue: 2, subjectAttribution: 1, familyBoundary: 1, timeRevision: 1, currentRelation: 1 });
    assert.deepEqual(snapshots.map(item => ({ ...item, memories: [...item.memories].sort() })), [{ memories: ["names","types"], peers: [], sources: 2 },
      { memories: ["names"], peers: ["types"], sources: 1 }]);
    t.diagnostic(JSON.stringify({ analyzerCalls: calls, snapshots }));
  } finally { fixture.database.close(); }
});

test("complementary wording does not combine facts from distinct fictional worlds", async () => {
  const fixture = setup();
  try {
    const first = add(fixture, { id: "world-one", text: "I have a dog.", worldId: "story-one", worldFrame: "fictional" });
    const second = add(fixture, { id: "world-two", text: "His name is Milo.", worldId: "story-two", worldFrame: "fictional" });
    await evaluateIdentityGroup(fixture, [first,second], [
      { valueText: "a dog", valueRelations: [{ memoryId: second.memory.id, relation: "complementary" }] },
      { valueText: "Milo" },
    ]);
    assert.equal(review(fixture).status, "review_required");
  } finally { fixture.database.close(); }
});

for (const [language, firstName, secondName, scopeOne, scopeTwo] of [
  ['en', 'Milo', 'Nori', 'family nickname', 'pen name'],
  ['zh', '阿圆', '小白', '家里用的昵称', '发表文章的笔名'],
]) {
  test('set additions survive a later confirmation in the same batch: ' + language, async t => {
    const f = setup({ currentLayer: 'reported', field: 'alias', value: firstName, cardinality: 'multi_item' });
    t.after(() => f.database.close());
    const original = add(f, { id: 'set-original', text: firstName, observedAt: '2026-07-09T12:00:00Z' });
    const extra = add(f, { id: 'set-extra', text: secondName, observedAt: '2026-07-10T12:00:00Z' });
    const confirmation = add(f, { id: 'set-confirmation', text: firstName, observedAt: '2026-07-10T12:01:00Z' });
    const base = { identityField: 'alias', currentStatePresent: true };
    await evaluate(f, original, { ...base, valueText: firstName, relation: 'equivalent' }, { fieldCardinality: 'multi_item' });
    linkCurrent(f, original);
    await evaluateIdentityGroup(f, [extra,confirmation], [
      { ...base, valueText: secondName, relation: 'additional_value',
        valueRelations: [{ memoryId: confirmation.memory.id, relation: 'complementary' }] },
      { ...base, valueText: firstName, relation: 'supports' },
    ], { identityField: 'alias', identityLabel: 'Aliases' });
    const reviewed = review(f);
    assert.equal(reviewed.status, 'ready');
    assert.equal(reviewed.action, 'supersede');
    const proposal = proposeReportedStateFromReview({ repository: f.repository, reviewResult: reviewed, reviewVersion: 'test-set-confirmation' }).proposal;
    const saved = resolveReportedStateProposal(f.repository, { agentId: 'agent-test', proposalId: proposal.id, action: 'accept' });
    assert.ok(saved.memory.content.includes(firstName));
    assert.ok(saved.memory.content.includes(secondName));
  });
  test('aggregated identity text preserves each value scope: ' + language, async t => {
    const f = setup(); t.after(() => f.database.close());
    const one = add(f, { id: 'scope-one', text: firstName + ': ' + scopeOne });
    const two = add(f, { id: 'scope-two', text: secondName + ': ' + scopeTwo });
    await evaluateIdentityGroup(f, [one,two], [
      { valueText: firstName, valueScope: scopeOne, valueRelations: [{ memoryId: two.memory.id, relation: 'complementary' }] },
      { valueText: secondName, valueScope: scopeTwo },
    ]);
    const proposal = proposeReportedStateFromReview({ repository: f.repository, reviewResult: review(f), reviewVersion: 'test-set-scopes' }).proposal;
    const saved = resolveReportedStateProposal(f.repository, { agentId: 'agent-test', proposalId: proposal.id, action: 'accept' });
    for (const scope of [scopeOne,scopeTwo]) assert.ok(saved.memory.content.includes(scope), saved.memory.content);
  });
}

test('dismissing a multi-value identity addition restores the prior set and sources', async t => {
  const f = setup(); t.after(() => f.database.close());
  const first = add(f, { id: 'rollback-first', text: 'I use the alias Milo.', observedAt: '2026-07-09T12:00:00Z' });
  await evaluateIdentityGroup(f, [first], [{ valueText: 'Milo', valueScope: 'alias' }]);
  const initial = proposeReportedStateFromReview({ repository: f.repository, reviewResult: review(f), reviewVersion: 'test-set-rollback' }).proposal;
  const prior = resolveReportedStateProposal(f.repository, { agentId: 'agent-test', proposalId: initial.id, action: 'accept' }).memory;
  const second = add(f, { id: 'rollback-second', text: 'I also use the alias Nori.', observedAt: '2026-07-10T12:00:00Z' });
  await evaluateIdentityGroup(f, [second], [{ valueText: 'Nori', valueScope: 'alias', currentStatePresent: true, relation: 'additional_value' }]);
  const addition = proposeReportedStateFromReview({ repository: f.repository, reviewResult: review(f), reviewVersion: 'test-set-rollback' }).proposal;
  assert.equal(f.repository.getMemory(prior.id).status, 'superseded');
  const dismissed = resolveReportedStateProposal(f.repository, { agentId: 'agent-test', proposalId: addition.id, action: 'dismiss' });
  assert.equal(dismissed.restored.id, prior.id);
  const current = f.repository.getMemory(prior.id);
  assert.equal(current.status, 'active');
  assert.equal(current.content, prior.content);
  assert.deepEqual(current.metadata.reportedStateDraft, prior.metadata.reportedStateDraft);
  assert.deepEqual(f.repository.listMemorySources(current.id).map(source => source.id), [first.source.id]);
});
