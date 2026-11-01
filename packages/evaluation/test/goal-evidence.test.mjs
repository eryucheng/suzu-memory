import assert from "node:assert/strict";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";
import { evaluateGoalEvidence, reviewReportedGoalState } from "../src/index.mjs";
import { proposeReportedStateFromReview } from "../../analysis/src/reported-state-persistence.mjs";

const KEY = "user:goal:publish-memory-project";

function setup({ withCurrent = false } = {}) {
  const database = openMemoryDatabase(":memory:");
  const repository = new MemoryRepository(database);
  const add = ({ id, content, sourceContent, occurredAt = "2026-07-10T12:00:00.000Z" }) => {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: `source-${id}`,
      occurredAt,
      speaker: "User",
      content: sourceContent,
    });
    const memory = repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "semantic",
      content,
      subjectRole: "user",
      subjectKey: "user",
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "current",
      eventStart: occurredAt,
      knownAt: occurredAt,
      actorRoles: [
        { role: "speaker", actorRole: "user", actorKey: "user", isPrimary: true },
        { role: "participant", actorRole: "user", actorKey: "user" },
      ],
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: "subject_firsthand",
      sourceTrust: 0.95,
      evidenceStrength: 1,
      provenance: "test",
    });
    return { memory, source };
  };
  let current = null;
  if (withCurrent) {
    const source = repository.upsertSource({
      agentId: "agent-test",
      sourceKind: "conversation",
      externalId: "source-current-publish-plan",
      occurredAt: "2026-07-01T08:00:00.000Z",
      speaker: "User",
      content: "我决定把记忆系统整理完后发布。",
    });
    const memory = repository.upsertMemory({
      id: "current-publish-plan",
      agentId: "agent-test",
      kind: "plan",
      layer: "prospective",
      content: "用户计划整理并发布记忆系统。",
      subjectRole: "user",
      subjectKey: "user",
      canonicalKey: KEY,
      stateFamily: "goal",
      statePhase: "active",
      reality: "real",
      evidenceMode: "explicit",
      temporalState: "in_progress",
      knownAt: "2026-07-01T08:00:00.000Z",
      validFrom: "2026-07-01T08:00:00.000Z",
    });
    repository.linkSource(memory.id, source.id, "evidence", {
      authority: "subject_firsthand",
      sourceTrust: 0.95,
      evidenceStrength: 1,
      provenance: "test",
    });
    current = { memory, source };
  }
  return { database, repository, add, current };
}

function common(record) {
  return {
    memoryId: record.memory.id,
    sourceIds: [record.source.id],
    confidence: 0.9,
    rationale: "直接来源支持该字段。",
  };
}

function analyzersFor(record, {
  targetMatch = "exact",
  goalText = "整理并发布记忆系统",
  intentionLevel = "plan",
  specificity = "actionable",
  holderMatch = "yes",
  attribution = "explicit_self_statement",
  responsibility = "subject",
  agency = "self_chosen",
  acceptsResponsibility = "yes",
  lifecycle = "active",
  completionBasis = "none",
  currentStatePresent = false,
  relation = "no_current_state",
} = {}) {
  return {
    targetIntent: async () => ({ output: { analyses: [{
      ...common(record), targetMatch, goalText, intentionLevel, specificity,
    }] } }),
    holderResponsibility: async () => ({ output: { analyses: [{
      ...common(record), holderMatch, attribution, responsibility, agency, acceptsResponsibility,
    }] } }),
    lifecycle: async () => ({ output: { analyses: [{
      ...common(record), lifecycle, completionBasis, timeReference: "",
    }] } }),
    currentRelation: async () => ({ output: { analyses: [{
      ...common(record), currentStatePresent, relation,
    }] } }),
  };
}

function evaluate(fixture, record, analyzers, overrides = {}) {
  return evaluateGoalEvidence({
    repository: fixture.repository,
    agentId: "agent-test",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    goalLabel: "整理并发布记忆系统",
    memoryIds: [record.memory.id],
    analyzers,
    ...overrides,
  });
}

test("creates only a shadow plan action for a direct decided goal", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "publish-plan",
    content: "用户决定整理并发布记忆系统。",
    sourceContent: "我决定整理完就把记忆系统发布出来。",
  });
  const before = Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count);
  const result = await evaluate(fixture, record, analyzersFor(record));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "create");
  assert.equal(result.actionPreviews[0].proposedKind, "plan");
  assert.equal(result.actionPreviews[0].automaticStateWriteAllowed, false);
  assert.equal(
    Number(fixture.database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count),
    before,
  );
  fixture.database.close();
});

test("does not promote a wish or an unaccepted external requirement into a goal", async () => {
  const wishFixture = setup();
  const wish = wishFixture.add({
    id: "travel-wish",
    content: "用户希望以后有机会环游世界。",
    sourceContent: "我希望有一天能环游世界。",
  });
  const wishResult = await evaluate(wishFixture, wish, analyzersFor(wish, {
    goalText: "环游世界",
    intentionLevel: "wish",
    specificity: "vague",
  }));
  assert.equal(wishResult.observations[0].qualification, "excluded");
  assert.equal(wishResult.observations[0].excluded_reason, "wish-is-not-a-current-goal");
  wishFixture.database.close();

  const requiredFixture = setup();
  const required = requiredFixture.add({
    id: "work-requirement",
    content: "单位要求用户整理材料，但用户没有表示接受为自己的计划。",
    sourceContent: "单位让我整理这批材料，我还没答应怎么处理。",
  });
  const requiredResult = await evaluate(requiredFixture, required, analyzersFor(required, {
    goalText: "整理单位材料",
    intentionLevel: "external_requirement",
    agency: "external_requirement",
    acceptsResponsibility: "no",
  }));
  assert.equal(requiredResult.observations[0].qualification, "excluded");
  assert.equal(requiredResult.observations[0].excluded_reason, "external-requirement-belongs-to-condition");
  requiredFixture.database.close();
});

test("requires direct proof before previewing completion", async () => {
  const inferredFixture = setup({ withCurrent: true });
  const inferred = inferredFixture.add({
    id: "inferred-completion",
    content: "模型根据时间猜测用户已经发布。",
    sourceContent: "按计划这个时候应该弄完了吧。",
  });
  const inferredResult = await evaluate(inferredFixture, inferred, analyzersFor(inferred, {
    lifecycle: "completed",
    completionBasis: "inferred",
    currentStatePresent: true,
    relation: "completes",
  }));
  assert.equal(inferredResult.observations[0].qualification, "unresolved");
  assert.equal(inferredResult.observations[0].excluded_reason, "goal-completion-not-directly-proven");
  assert.equal(inferredResult.actionPreviews[0].action, "no_conclusion");
  inferredFixture.database.close();

  const completeFixture = setup({ withCurrent: true });
  const complete = completeFixture.add({
    id: "explicit-completion",
    content: "用户明确说已经发布完成。",
    sourceContent: "已经整理完并发布了。",
  });
  const completeResult = await evaluate(completeFixture, complete, analyzersFor(complete, {
    lifecycle: "completed",
    completionBasis: "explicit_self_report",
    currentStatePresent: true,
    relation: "completes",
  }));
  assert.equal(completeResult.observations[0].qualification, "qualified");
  assert.equal(completeResult.actionPreviews[0].action, "complete");
  assert.equal(completeFixture.repository.getMemory(completeFixture.current.memory.id).status, "active");
  completeFixture.database.close();
});

test("treats blocked work as a pause and a narrower step as progress, not cancellation or replacement", async () => {
  const blockedFixture = setup({ withCurrent: true });
  const blocked = blockedFixture.add({
    id: "blocked-goal",
    content: "用户因为等待资料暂时无法继续发布计划。",
    sourceContent: "还在等资料，先卡在这里，不是取消。",
  });
  const blockedResult = await evaluate(blockedFixture, blocked, analyzersFor(blocked, {
    lifecycle: "blocked",
    currentStatePresent: true,
    relation: "pauses",
  }));
  assert.equal(blockedResult.actionPreviews[0].action, "pause");
  assert.notEqual(blockedResult.actionPreviews[0].action, "cancel");
  blockedFixture.database.close();

  const stepFixture = setup({ withCurrent: true });
  const step = stepFixture.add({
    id: "goal-step",
    content: "用户正在完成发布计划中的 README 步骤。",
    sourceContent: "我先把 README 写完，这是发布前的一步。",
  });
  const stepResult = await evaluate(stepFixture, step, analyzersFor(step, {
    targetMatch: "subcategory",
    goalText: "写完 README",
    lifecycle: "in_progress",
    currentStatePresent: true,
    relation: "narrower_step",
  }));
  assert.equal(stepResult.actionPreviews[0].action, "progress_update");
  assert.equal(stepResult.actionPreviews[0].reason, "new-item-is-a-step-not-a-replacement");
  stepFixture.database.close();
});

test("does not let an old historical mention reopen a current goal", async () => {
  const fixture = setup({ withCurrent: true });
  const record = fixture.add({
    id: "historical-goal-mention",
    content: "用户回顾过去曾计划发布记忆系统。",
    sourceContent: "我以前计划过要发布这个记忆系统。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    lifecycle: "historical",
    currentStatePresent: true,
    relation: "same_goal",
  }));
  assert.equal(result.observations[0].qualification, "qualified");
  assert.equal(result.actionPreviews[0].action, "no_conclusion");
  assert.equal(result.actionPreviews[0].reason, "historical-goal-evidence-does-not-change-current-state");
  fixture.database.close();
});

test("explicitly rejects shared goals until bilateral review exists", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "shared-goal",
    content: "双方想一起完成项目。",
    sourceContent: "我们一起把它做完。",
  });
  await assert.rejects(() => evaluate(fixture, record, analyzersFor(record), {
    subjectRole: "shared",
    subjectKey: "user+agent-test",
  }), /individual fixed subject/u);
  fixture.database.close();
});

test("keeps a provider failure as audit only and writes no merged goal evidence", async () => {
  const fixture = setup();
  const record = fixture.add({
    id: "goal-provider-failure",
    content: "用户决定整理并发布记忆系统。",
    sourceContent: "我决定整理完就发布。",
  });
  const analyzers = analyzersFor(record);
  analyzers.lifecycle = async () => {
    throw new Error("provider unavailable");
  };
  const result = await evaluate(fixture, record, analyzers);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.failedRoles, ["lifecycle"]);
  assert.deepEqual(result.observations, []);
  fixture.database.close();
});

test("compares goal evidence against the explicitly selected representation layer", async () => {
  const fixture = setup();
  fixture.repository.upsertMemory({
    id: "reported-publish-plan",
    agentId: "agent-test",
    kind: "plan",
    layer: "prospective",
    content: "用户表示自己计划发布记忆项目。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    stateFamily: "goal",
    statePhase: "active",
    reality: "real",
    evidenceMode: "explicit",
    representationLayer: "reported",
    temporalState: "in_progress",
    knownAt: "2026-07-01T08:00:00.000Z",
    validFrom: "2026-07-01T08:00:00.000Z",
  });
  fixture.repository.upsertMemory({
    id: "established-publish-plan",
    agentId: "agent-test",
    kind: "plan",
    layer: "prospective",
    content: "持续产出支持项目处于执行中。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: KEY,
    stateFamily: "goal",
    statePhase: "active",
    reality: "real",
    evidenceMode: "observed",
    representationLayer: "established",
    temporalState: "in_progress",
    knownAt: "2026-07-20T08:00:00.000Z",
    validFrom: "2026-07-20T08:00:00.000Z",
  });
  const record = fixture.add({
    id: "reported-layer-progress",
    content: "用户说项目正在继续。",
    sourceContent: "我还在继续做这个项目。",
  });
  const result = await evaluate(fixture, record, analyzersFor(record, {
    lifecycle: "in_progress",
    currentStatePresent: true,
    relation: "progress_update",
  }), {
    currentRepresentationLayer: "reported",
  });
  assert.equal(result.snapshot.currentState.id, "reported-publish-plan");
  assert.equal(result.snapshot.currentState.representationLayer, "reported");
  assert.equal(result.observations[0].scope.currentRepresentationLayer, "reported");
  fixture.database.close();
});

for (const sourceContent of ["我决定整理并发布记忆系统。", "I decided to finish and publish the memory project."]) {
  for (const defect of ["format", "source", "duplicate"]) {
    test("preserves goal siblings and retries only the rejected item: " + defect + sourceContent, async t => {
      const fixture = setup();
      t.after(() => fixture.database.close());
      const records = ["good", "bad"].map(id => fixture.add({ id, content: sourceContent, sourceContent }));
      const calls = {}; let broken = true;
      const analyzers = Object.fromEntries(Object.keys(analyzersFor(records[0])).map(key => [key, async request => {
        const snapshot = JSON.parse(request.input.slice(request.input.indexOf("{")));
        (calls[key] ||= []).push({ memories: snapshot.memories.map(memory => memory.id),
          sources: snapshot.sourceRecords.map(source => source.id) });
        const analyses = [];
        for (const record of records.filter(record => snapshot.memories.some(memory => memory.id === record.memory.id))) {
          const generated = await analyzersFor(record)[key]();
          const item = generated.output.analyses[0];
          if (!broken && key === "targetIntent" && snapshot.memories.length === 1) {
            assert.deepEqual(snapshot.comparisonMemories.map(memory => memory.memoryId), ["good"]);
            item.peerRelations = [{ memoryId: "good", relation: "complementary" }];
          }
          if (broken && key === "targetIntent" && record.memory.id === "bad") {
            if (defect === "format") item.targetMatch = "invalid-match";
            if (defect === "source") item.sourceIds = [records[0].source.id];
            if (defect === "duplicate") analyses.push({ ...item });
          }
          analyses.push(item);
        }
        return { output: { analyses } };
      }]));
      const options = { memoryIds: records.map(record => record.memory.id), snapshotOptions: { reuseAnalysisRuns: true } };
      const first = await evaluate(fixture, records[0], analyzers, options);
      assert.equal(first.status, "incomplete");
      assert.deepEqual(first.analyses.targetIntent.map(item => item.memoryId), ["good"]);
      assert.deepEqual(first.observations.map(item => [item.memory_id, item.qualification]), [["good", "qualified"]]);
      broken = false;
      const second = await evaluate(fixture, records[0], analyzers, options);
      assert.equal(second.status, "analyzed");
      assert.equal(second.observations.filter(item => item.qualification === "qualified").length, 2);
      assert.deepEqual(calls.targetIntent[1], { memories: ["bad"], sources: [records[1].source.id] });
      for (const [key, requests] of Object.entries(calls)) assert.equal(requests.length, key === "targetIntent" ? 2 : 1);
      fixture.repository.upsertSource({ agentId: "agent-test", sourceKind: "conversation", externalId: "source-bad",
        occurredAt: "2026-07-10T12:00:00Z", speaker: "User", content: sourceContent + " Updated detail." });
      await evaluate(fixture, records[0], analyzers, options);
      for (const [key, requests] of Object.entries(calls)) assert.equal(requests.length, key === "targetIntent" ? 3 : 2);
    });
  }
}

for (const relation of ["complementary", "conflicting", "outside"]) test(`goal evidence retains bounded semantic peer comparison: ${relation}`, async t => {
  const f = setup(); t.after(() => f.database.close());
  const records = [f.add({ id: "plan", content: "I plan to publish the notes.", sourceContent: "I plan to publish the notes." }),
    f.add({ id: "detail", occurredAt: "2026-07-11T12:00:00Z", content: "I am proofreading the notes for publication.", sourceContent: "I am proofreading the notes for publication." })];
  let calls = 0;
  const analyzers = Object.fromEntries(Object.keys(analyzersFor(records[0])).map(key => [key, async request => {
    calls++;
    const analyses = await Promise.all(records.map(async (record, index) => {
      const item = (await analyzersFor(record, { goalText: index ? "Proofread the notes for publication" : "Publish the notes" })[key](request)).output.analyses[0];
      if (key === "targetIntent" && index) item.peerRelations = [{ memoryId: relation === "outside" ? "not-in-snapshot" : records[0].memory.id,
        relation: relation === "outside" ? "complementary" : relation }];
      return item;
    }));
    return { output: { analyses } };
  }]));
  const evaluation = await evaluate(f, records[0], analyzers, { memoryIds: records.map(item => item.memory.id), currentRepresentationLayer: "reported" });
  assert.equal(calls, 4, "peer comparison adds no analyzer role or call");
  if (relation === "outside") {
    assert.equal(evaluation.status, "incomplete");
    assert.deepEqual(evaluation.observations.map(item => item.memory_id), ["plan"]);
    return;
  }
  const result = reviewReportedGoalState({ repository: f.repository, agentId: "agent-test", subjectRole: "user", subjectKey: "user",
    canonicalKey: KEY, subjectLabel: "User", goalLabel: "Publish the notes" });
  assert.equal(result.status, relation === "conflicting" ? "review_required" : "ready");
  if (relation === "complementary") {
    const persisted = proposeReportedStateFromReview({ repository: f.repository, reviewResult: result, reviewVersion: "test-peer" });
    const [memory] = f.repository.listPendingProvisionalMemories("agent-test");
    assert.equal(persisted.status, "pending");
    assert.match(memory.content, /plan to publish/);
    assert.match(memory.content, /proofreading/);
    assert.equal(f.repository.getMemoryDetail("agent-test", memory.id).sources.length, 2);
  }
});
