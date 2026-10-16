import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureCompanionRelationshipStructure,
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-memory/core";

import {
  appendCompanionEvents,
  normalizeCompanionEvent,
  processPendingCompanionEvents,
  reviseCompanionEvent,
} from "../src/index.mjs";
import { generateCompanionEventBatch } from "../src/processing-stages.mjs";

const AGENT_ID = "companion-test";
const IDENTITY = Object.freeze({
  spaceId: AGENT_ID,
  companionId: AGENT_ID,
  companionName: "Companion",
  primaryUserId: "user",
  primaryUserName: "User",
});

function event(overrides = {}) {
  return {
    protocolVersion: 1,
    eventId: "event-1",
    spaceId: AGENT_ID,
    eventType: "conversation.turn",
    occurredAt: "2026-08-04T02:00:00.000Z",
    knownAt: "2026-08-04T02:00:00.000Z",
    actor: { role: "user", id: "user", name: "User" },
    participants: [
      { role: "user", id: "user", name: "User" },
      { role: "companion", id: AGENT_ID, name: "Companion" },
    ],
    world: { id: "relationship", frame: "relational" },
    content: { text: "我们今天一起把记忆系统的事件入口定下来了。" },
    source: { kind: "test", locator: "test://conversation/1" },
    metadata: { channel: "direct-message" },
    ...overrides,
  };
}

function generatedEventCandidate(overrides = {}) {
  return {
    kind: "event",
    title: "共同完成事件入口设计",
    content: "User 和 Companion 共同确定了长期记忆事件入口的边界。",
    subjectRole: "shared",
    subjectName: "User 与 Companion",
    actorRoles: [
      { role: "experiencer", actorRole: "user", actorName: "User", confidence: 1 },
      { role: "experiencer", actorRole: "agent", actorName: "Companion", confidence: 1 },
    ],
    canonicalKey: "",
    stateFamily: "not_applicable",
    stateLabel: "",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "historical",
    revisionAction: "add",
    retentionReason: "significant_event",
    eventDate: "2026-08-04",
    eventStart: "2026-08-04T02:00:00.000Z",
    eventEnd: "",
    confidence: 0.95,
    importance: 0.75,
    sourceRefs: ["M0001", "M0002"],
    ...overrides,
  };
}

function repositoryFixture() {
  const database = openMemoryDatabase(":memory:");
  return { database, repository: new MemoryRepository(database) };
}

test("normalizes one primary user and one companion while allowing third-party event persons", () => {
  const normalized = normalizeCompanionEvent(event({
    participants: [{ role: "other", id: "museum-guide", name: "讲解员" }],
  }), IDENTITY);
  assert.equal(normalized.world.frame, "relational");
  assert.deepEqual(
    normalized.participants.map(({ role, id }) => ({ role, id })),
    [
      { role: "other", id: "museum-guide" },
      { role: "user", id: "user" },
      { role: "companion", id: AGENT_ID },
    ],
  );
  assert.throws(
    () => normalizeCompanionEvent(event({
      participants: [{ role: "user", id: "another-user", name: "其他用户" }],
    }), IDENTITY),
    /second primary user/u,
  );
  assert.throws(
    () => normalizeCompanionEvent(event({
      participants: [{ role: "companion", id: "another-companion", name: "其他陪伴者" }],
    }), IDENTITY),
    /second companion/u,
  );
});

test("repairs one schema-valid JSON object that fails strict extraction validation", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).items;
  const schemas = [];
  const generator = async ({ input, schemaName }) => {
    schemas.push(schemaName);
    if (schemaName === "long-term-memory-extraction-v2") {
      return {
        output: { memories: [generatedEventCandidate({ sourceRefs: ["M0001"], eventDate: "August 4, 2026" })] },
        usage: { prompt_tokens: 10, completion_tokens: 5 },
        durationMs: 10,
        requestId: "initial-request",
        metadata: { schemaName },
      };
    }
    assert.match(input, /eventDate.*YYYY-MM-DD/u);
    return {
      output: { memories: [generatedEventCandidate({ sourceRefs: ["M0001"] })] },
      usage: { prompt_tokens: 4, completion_tokens: 2 },
      durationMs: 5,
      requestId: "repair-request",
      metadata: { schemaName },
    };
  };
  const generated = await generateCompanionEventBatch({
    events: pending,
    identity: IDENTITY,
    generator,
  });
  assert.deepEqual(schemas, [
    "long-term-memory-extraction-v2",
    "long-term-memory-extraction-repair-v2",
  ]);
  assert.equal(generated.generation.output.memories[0].eventDate, "2026-08-04");
  assert.deepEqual(generated.generation.usage, { prompt_tokens: 14, completion_tokens: 7 });
  assert.equal(generated.generation.durationMs, 15);
  assert.equal(generated.generation.metadata.repaired, true);
  assert.equal(generated.generation.metadata.initialRequestId, "initial-request");
  database.close();
});

test("keeps the repair pass in the source language of the invalid candidate", async () => {
  const { database, repository } = repositoryFixture();
  const englishEvent = event({
    content: { text: "I painted a sunrise last year." },
  });
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: englishEvent });
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).items;
  let repairPrompt = "";
  const generated = await generateCompanionEventBatch({
    events: pending,
    identity: IDENTITY,
    generator: async ({ schemaName, systemPrompt }) => {
      if (schemaName === "long-term-memory-extraction-v2") {
        return {
          output: { memories: [generatedEventCandidate({ sourceRefs: ["M0001"], eventDate: "August 4, 2026" })] },
          usage: {},
        };
      }
      repairPrompt = systemPrompt;
      return {
        output: { memories: [generatedEventCandidate({ sourceRefs: ["M0001"] })] },
        usage: {},
      };
    },
  });
  assert.equal(generated.generation.metadata.repaired, true);
  assert.match(repairPrompt, /M0001=en/u);
  assert.match(repairPrompt, /write them in English/u);
  database.close();
});

test("retains individually valid candidates when one repair cannot satisfy domain rules", async () => {
  const invalid = generatedEventCandidate({ eventDate: "August 4, 2026" });
  const valid = generatedEventCandidate({ title: "有效候选", sourceRefs: ["M0001"] });
  let calls = 0;
  const generator = async () => {
    calls += 1;
    return {
      output: { memories: [valid, invalid] },
      usage: { prompt_tokens: 3, completion_tokens: 2 },
      durationMs: 4,
      requestId: `request-${calls}`,
      metadata: { schemaName: calls === 1 ? "initial" : "repair" },
    };
  };
  const generated = await generateCompanionEventBatch({
    events: [event()],
    identity: IDENTITY,
    generator,
  });
  assert.equal(calls, 2);
  assert.equal(generated.generation.output.memories.length, 1);
  assert.equal(generated.generation.output.memories[0].title, "有效候选");
  assert.deepEqual(generated.generation.usage, { prompt_tokens: 6, completion_tokens: 4 });
  assert.equal(generated.generation.metadata.repaired, false);
  assert.equal(generated.generation.metadata.salvaged, true);
  assert.equal(generated.generation.metadata.salvageSource, "initial+repair");
  assert.equal(generated.generation.metadata.rejectedCandidates.length, 2);
  assert.deepEqual(
    generated.generation.metadata.rejectedCandidates.map((item) => item.stage),
    ["initial", "repair"],
  );
  assert.match(generated.generation.metadata.repairValidationError, /eventDate/u);
});

test("never lets a repair response delete candidates that were already valid", async () => {
  const invalid = generatedEventCandidate({ eventDate: "August 4, 2026" });
  const valid = generatedEventCandidate({ title: "必须保留的有效候选", sourceRefs: ["M0001"] });
  let calls = 0;
  const generated = await generateCompanionEventBatch({
    events: [event()],
    identity: IDENTITY,
    generator: async () => {
      calls += 1;
      return {
        output: calls === 1 ? { memories: [valid, invalid] } : { memories: [] },
        usage: {},
      };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(
    generated.generation.output.memories.map((candidate) => candidate.title),
    ["必须保留的有效候选"],
  );
  assert.equal(generated.generation.metadata.repaired, true);
  assert.equal(generated.generation.metadata.initialValidCandidateCount, 1);
  assert.equal(generated.generation.metadata.initialInvalidCandidateCount, 1);
  assert.equal(generated.generation.metadata.finalCandidateCount, 1);
});

test("corrects known participant roles from host identity before evidence gates", async () => {
  const generated = await generateCompanionEventBatch({
    events: [event({
      actor: { role: "companion", id: AGENT_ID, name: "Companion" },
      content: { text: "我刚才整理完了事件入口。" },
    })],
    identity: IDENTITY,
    generator: async () => ({
      output: {
        memories: [generatedEventCandidate({
          subjectRole: "user",
          subjectName: "Companion",
          actorRoles: [
            { role: "experiencer", actorRole: "user", actorName: "Companion", confidence: 1 },
          ],
          sourceRefs: ["M0001"],
        })],
      },
      usage: {},
    }),
  });
  assert.equal(generated.generation.output.memories[0].subjectRole, "agent");
  assert.equal(generated.generation.output.memories[0].actorRoles[0].actorRole, "agent");
  assert.equal(generated.generation.metadata.knownParticipantRoleCorrectionCount, 2);
});

test("appends events idempotently and rejects conflicting replays without producing memory", () => {
  const { database, repository } = repositoryFixture();
  const first = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event(),
  });
  const replay = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ recordedAt: "2026-08-04T03:00:00.000Z" }),
  });
  assert.equal(first.inserted, 1);
  assert.equal(replay.reused, 1);
  assert.equal(repository.listInputEvents(AGENT_ID).total, 1);
  assert.equal(repository.listMemories(AGENT_ID, { statuses: [] }).total, 0);
  assert.throws(
    () => appendCompanionEvents({
      repository,
      agentId: AGENT_ID,
      identity: IDENTITY,
      events: event({ content: { text: "同一个 id 却换了内容。" } }),
    }),
    (error) => error.code === "INPUT_EVENT_CONFLICT",
  );
  database.close();
});

test("supersedes a pending event append-only and claims only its replacement", () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const revised = reviseCompanionEvent({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    targetEventId: "event-1",
    action: "amend",
    reason: "The original message was edited by its author.",
    replacementEvent: event({
      eventId: "event-1-revision-2",
      content: { text: "我们今天重新确认了记忆系统的事件入口。" },
    }),
  });
  assert.equal(revised.wasInserted, true);
  assert.equal(repository.getInputEventByExternalId(AGENT_ID, "event-1").lifecycle, "superseded");
  const replay = reviseCompanionEvent({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    targetEventId: "event-1",
    action: "amend",
    reason: "The original message was edited by its author.",
    replacementEvent: event({
      eventId: "event-1-revision-2",
      content: { text: "我们今天重新确认了记忆系统的事件入口。" },
    }),
  });
  assert.equal(replay.wasInserted, false);
  const pipeline = repository.inspectInputPipeline(AGENT_ID);
  assert.deepEqual(pipeline.eventCounts, { pending: 1, processing: 0, archived: 0 });
  assert.deepEqual(pipeline.lifecycleCounts, { active: 1, superseded: 1, retracted: 0 });
  const claimed = repository.claimPendingInputEvents(AGENT_ID, { workerId: "revision-worker" });
  assert.deepEqual(claimed.events.map((item) => item.external_id), ["event-1-revision-2"]);
  database.close();
});

test("retracts archived evidence and removes memories that have no active source", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const processed = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: [],
  });
  assert.equal(processed.status, "processed");
  const activeBefore = repository.listMemories(AGENT_ID, {
    statuses: ["active"],
    kinds: ["utterance"],
  }).items;
  assert.equal(activeBefore.length, 1);
  const revised = reviseCompanionEvent({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    targetEventId: "event-1",
    action: "retract",
    reason: "The source message was removed.",
  });
  assert.equal(revised.invalidatedSources, 1);
  assert.equal(revised.affectedMemories, 1);
  assert.equal(repository.getInputEventByExternalId(AGENT_ID, "event-1").lifecycle, "retracted");
  assert.equal(repository.getMemory(activeBefore[0].id).status, "deleted");
  assert.equal(repository.getMemoryDetail(AGENT_ID, activeBefore[0].id).sources[0].lifecycle, "retracted");
  assert.equal(repository.listMemories(AGENT_ID, { statuses: ["active"] }).total, 0);
  database.close();
});

test("rejects a revision while the target event is owned by a processing batch", () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  repository.claimPendingInputEvents(AGENT_ID, { workerId: "active-worker" });
  assert.throws(() => reviseCompanionEvent({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    targetEventId: "event-1",
    action: "retract",
  }), (error) => error.code === "INPUT_EVENT_REVISION_RACE");
  database.close();
});

test("fragments oversized events without losing text and keeps replay idempotency", () => {
  const { database, repository } = repositoryFixture();
  const text = "甲".repeat(145);
  const first = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ eventId: "large-event", content: { text } }),
    maximumEventCharacters: 12,
  });
  const replay = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ eventId: "large-event", content: { text } }),
    maximumEventCharacters: 12,
  });
  assert.equal(first.accepted, 1);
  assert.ok(first.eventRecords > 1);
  assert.equal(replay.reused, first.eventRecords);
  assert.equal(first.events.map((item) => item.content.text).join(""), text);
  assert.equal(
    repository.listInputEvents(AGENT_ID, { statuses: ["pending"], limit: 100 }).items
      .map((item) => item.content.text).join(""),
    text,
  );
  assert.equal(first.events[0].external_id, "large-event");
  assert.deepEqual(
    first.events.map((item) => item.metadata.suzuMemoryFragment.index),
    first.events.map((_, index) => index + 1),
  );
  assert.throws(
    () => appendCompanionEvents({
      repository,
      agentId: AGENT_ID,
      identity: IDENTITY,
      events: event({ eventId: "large-event", content: { text: `${text}已改变` } }),
      maximumEventCharacters: 12,
    }),
    (error) => error.code === "INPUT_EVENT_CONFLICT",
  );
  database.close();
});

test("claims a fragmented logical event atomically instead of using the remaining batch tail", () => {
  const { database, repository } = repositoryFixture();
  const longText = "甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未申酉";
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    maximumEventCharacters: 10,
    events: [
      event({
        eventId: "short-before-long",
        occurredAt: "2026-08-04T01:59:00.000Z",
        knownAt: "2026-08-04T01:59:00.000Z",
        content: { text: "12345678" },
      }),
      event({ eventId: "atomic-long-event", content: { text: longText } }),
    ],
  });
  const first = repository.claimPendingInputEvents(AGENT_ID, {
    maximumEvents: 100,
    maximumContentCharacters: 22,
    workerId: "first-worker",
  });
  assert.deepEqual(first.events.map((item) => item.external_id), ["short-before-long"]);
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 2);
  assert.deepEqual(
    pending.items.map((item) => item.metadata.suzuMemoryFragment.index),
    [1, 2],
  );
  const second = repository.claimPendingInputEvents(AGENT_ID, {
    maximumEvents: 100,
    maximumContentCharacters: 22,
    workerId: "second-worker",
  });
  assert.equal(second.events.length, 2);
  assert.equal(second.events.map((item) => item.content.text).join(""), longText);
  database.close();
});

test("quarantines an unprocessable logical event and continues to the next event", () => {
  const { database, repository } = repositoryFixture();
  const longText = "甲".repeat(26);
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    maximumEventCharacters: 10,
    events: [
      event({ eventId: "over-budget-logical-event", content: { text: longText } }),
      event({ eventId: "healthy-event-after-quarantine", content: { text: "后面的正常事件仍应被领取。" } }),
    ],
  });
  const claimed = repository.claimPendingInputEvents(AGENT_ID, {
    maximumEvents: 100,
    maximumContentCharacters: 20,
    workerId: "blocked-worker",
  });
  assert.equal(claimed.quarantined.length, 1);
  assert.equal(claimed.quarantined[0].code, "INPUT_EVENT_FRAGMENT_GROUP_TOO_LARGE");
  assert.equal(claimed.quarantined[0].details.fragmentCount, 3);
  assert.equal(claimed.quarantined[0].details.characterCount, longText.length);
  assert.equal(claimed.events.length, 2);
  assert.ok(claimed.events.every((item) => (
    item.external_id.startsWith("healthy-event-after-quarantine")
  )));
  assert.equal(
    claimed.events.map((item) => item.content.text).join(""),
    "后面的正常事件仍应被领取。",
  );
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 0);
  const quarantined = repository.listInputEvents(AGENT_ID, {
    statuses: ["archived"],
    limit: 100,
  }).items.filter((item) => item.processing_disposition === "quarantined");
  assert.equal(quarantined.length, 3);
  assert.ok(quarantined.every((item) => /Logical input event/u.test(item.last_error)));
  const review = repository.listMaintenanceTasks(AGENT_ID, {
    taskTypes: ["input-event-quarantine"],
    statuses: ["failed"],
  });
  assert.equal(review.length, 1);
  assert.equal(review[0].review_state, "pending");
  database.close();
});

test("claims only the oldest prefix within the auditable content budget", () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [
      event({ eventId: "budget-1", content: { text: "12345678" } }),
      event({ eventId: "budget-2", content: { text: "abcdefgh" } }),
    ],
  });
  const claimed = repository.claimPendingInputEvents(AGENT_ID, {
    maximumEvents: 2,
    maximumContentCharacters: 10,
    workerId: "budget-worker",
  });
  assert.equal(claimed.events.length, 1);
  assert.equal(claimed.events[0].external_id, "budget-1");
  assert.equal(claimed.batch.input_character_count, 8);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).total, 1);
  database.close();
});

test("quarantines a legacy oversized event instead of sending it to a model", () => {
  const { database, repository } = repositoryFixture();
  repository.appendInputEvent({
    agentId: AGENT_ID,
    externalId: "legacy-oversized",
    eventType: "conversation.turn",
    actorRole: "user",
    actorKey: "user",
    occurredAt: "2026-08-04T02:00:00.000Z",
    content: { text: "x".repeat(20) },
  });
  const claimed = repository.claimPendingInputEvents(AGENT_ID, {
    maximumContentCharacters: 10,
    workerId: "budget-worker",
  });
  assert.equal(claimed.batch, null);
  assert.equal(claimed.quarantined.length, 1);
  assert.equal(claimed.quarantined[0].code, "INPUT_EVENT_TOO_LARGE");
  assert.equal(claimed.quarantined[0].details.characterCount, 20);
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 0);
  const archived = repository.listInputEvents(AGENT_ID, { statuses: ["archived"] });
  assert.equal(archived.total, 1);
  assert.equal(archived.items[0].processing_disposition, "quarantined");
  assert.match(archived.items[0].last_error, /exceeding the 10-character/u);
  database.close();
});

test("keeps extraction as a separately testable stage without host context", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).items;
  const generated = await generateCompanionEventBatch({
    events: pending,
    identity: IDENTITY,
    memoriesOverride: [generatedEventCandidate({ sourceRefs: ["M0001"] })],
  });
  assert.equal(generated.messages.length, 1);
  assert.equal(generated.generation.output.memories.length, 1);
  assert.equal(Object.hasOwn(generated.generation.output, "summary"), false);
  database.close();
});

test("uses boundary messages for interpretation without archiving or citing them again", async () => {
  const { database, repository } = repositoryFixture();
  const core = event({
    eventId: "archive-core",
    occurredAt: "2026-08-04T02:01:00.000Z",
    knownAt: "2026-08-04T02:01:00.000Z",
    content: { text: "我今天去了科技馆。" },
  });
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: core });
  let receivedInput = "";
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    previousContextEvents: [event({
      eventId: "read-only-previous",
      occurredAt: "2026-08-04T02:00:00.000Z",
      knownAt: "2026-08-04T02:00:00.000Z",
      actor: { role: "companion", id: AGENT_ID, name: "Companion" },
      content: { text: "你今天准备去哪里？" },
    })],
    continuationGuidanceEvents: [event({
      eventId: "read-only-guidance",
      occurredAt: "2026-08-04T02:02:00.000Z",
      knownAt: "2026-08-04T02:02:00.000Z",
      content: { text: "参观还没有结束。" },
    })],
    generator: async ({ input }) => {
      receivedInput = input;
      return { output: { memories: [generatedEventCandidate({ sourceRefs: ["M0001"] })] }, usage: {} };
    },
  });
  assert.equal(result.messagesArchived, 1);
  assert.equal(result.previousContextMessages, 1);
  assert.equal(result.continuationGuidanceMessages, 1);
  assert.match(receivedInput, /只读的前文衔接/u);
  assert.match(receivedInput, /只读的后文衔接/u);
  const utterances = repository.listMemories(AGENT_ID, {
    statuses: [],
    kinds: ["utterance"],
  }).items;
  assert.deepEqual(utterances.map((item) => item.content), [core.content.text]);
  assert.doesNotMatch(JSON.stringify(repository.listMemories(AGENT_ID, { statuses: [] }).items), /准备去哪里|参观还没有结束/u);
  database.close();
});

test("shares one provider request across archive windows but rejects cross-window evidence", async () => {
  const { database, repository } = repositoryFixture();
  const first = event({ eventId: "window-event-1", content: { text: "第一件独立事情。" } });
  const second = event({
    eventId: "window-event-2",
    occurredAt: "2026-08-04T03:00:00.000Z",
    knownAt: "2026-08-04T03:00:00.000Z",
    content: { text: "第二件独立事情。" },
  });
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [first, second],
  });
  let requests = 0;
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    archiveWindows: [
      { id: "window-a", coreEventIds: [first.eventId] },
      { id: "window-b", coreEventIds: [second.eventId] },
    ],
    generator: async () => {
      requests += 1;
      return {
        output: {
          memories: [generatedEventCandidate({ sourceRefs: ["M0001", "M0002"] })],
        },
        usage: {},
      };
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.archiveWindows, 2);
  assert.equal(result.messagesArchived, 2);
  assert.equal(result.candidateResults[0].status, "reject");
  assert.deepEqual(result.candidateResults[0].reasons, ["cross-window-evidence"]);
  const followedBy = database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_edges
    WHERE agent_id = ? AND relation = 'followed_by'
  `).get(AGENT_ID);
  assert.equal(Number(followedBy.count), 0);
  database.close();
});

test("preserves utterance order across budget splits only with explicit continuity", async () => {
  const { database, repository } = repositoryFixture();
  const first = event({ eventId: "continued-event-1", content: { text: "同一长会话的前半段。" } });
  const second = event({
    eventId: "continued-event-2",
    occurredAt: "2026-08-04T03:01:00.000Z",
    knownAt: "2026-08-04T03:01:00.000Z",
    actor: { role: "companion", id: AGENT_ID, name: "Companion" },
    content: { text: "同一长会话的后半段。" },
  });
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [first, second],
  });
  await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    archiveWindows: [
      { id: "split-a", continuityId: "conversation-1", coreEventIds: [first.eventId] },
      { id: "split-b", continuityId: "conversation-1", coreEventIds: [second.eventId] },
    ],
    memoriesOverride: [],
  });
  const followedBy = database.prepare(`
    SELECT COUNT(*) AS count
    FROM memory_edges
    WHERE agent_id = ? AND relation = 'followed_by'
  `).get(AGENT_ID);
  assert.equal(Number(followedBy.count), 1);
  database.close();
});

test("reassembles every fragment before extraction and archives one complete utterance", async () => {
  const { database, repository } = repositoryFixture();
  const longText = "第一部分尚未说完。\n\n第二部分继续说明，第三部分才给出完整结论。";
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    maximumEventCharacters: 12,
    events: event({ eventId: "reassembled-event", content: { text: longText } }),
  });
  const pending = repository.listInputEvents(AGENT_ID, {
    statuses: ["pending"],
    limit: 100,
  }).items;
  const generated = await generateCompanionEventBatch({
    events: pending,
    identity: IDENTITY,
    memoriesOverride: [],
  });
  assert.equal(generated.messages.length, 1);
  assert.equal(generated.messages[0].text, longText);
  assert.equal(generated.messages[0].inputEventIds.length, pending.length);
  assert.equal(generated.messages[0].logicalEvent.fragmentCount, pending.length);
  assert.match(generated.input, new RegExp(`同一原始事件已完整重组，共${pending.length}段`, "u"));

  const processed = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    maximumContentCharacters: 100,
    memoriesOverride: [],
  });
  assert.equal(processed.eventsProcessed, pending.length);
  assert.equal(processed.messagesArchived, 1);
  const utterances = repository.listMemories(AGENT_ID, {
    statuses: [],
    kinds: ["utterance"],
  }).items;
  assert.equal(utterances.length, 1);
  assert.equal(utterances[0].content, longText);
  const detail = repository.getMemoryDetail(AGENT_ID, utterances[0].id);
  assert.equal(detail.sources[0].metadata.logicalEvent.fragmentCount, pending.length);
  assert.deepEqual(detail.sources[0].metadata.inputEventIds, pending.map((item) => item.id));
  database.close();
});

test("processes a bilateral relationship-world batch without a host transcript", async () => {
  const { database, repository } = repositoryFixture();
  const identityStructure = ensureCompanionRelationshipStructure({
    repository,
    agentId: AGENT_ID,
    primaryUserId: IDENTITY.primaryUserId,
    primaryUserName: IDENTITY.primaryUserName,
    companionId: IDENTITY.companionId,
    companionName: IDENTITY.companionName,
  });
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [
      event(),
      event({
        eventId: "event-2",
        occurredAt: "2026-08-04T02:01:00.000Z",
        knownAt: "2026-08-04T02:01:00.000Z",
        actor: { role: "companion", id: AGENT_ID, name: "Companion" },
        content: { text: "我会把关系世界和物理事实分开记录。" },
      }),
    ],
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    now: new Date("2026-08-04T02:05:00.000Z"),
    memoriesOverride: [generatedEventCandidate()],
  });
  assert.equal(result.status, "processed");
  assert.equal(result.eventsProcessed, 2);
  assert.equal(result.memoriesStored, 1);
  assert.equal(result.candidateResults[0].candidateIndex, 0);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 2);
  const memories = repository.listMemories(AGENT_ID, { statuses: [], limit: 20 }).items;
  assert.equal(memories.filter((memory) => memory.kind === "utterance").length, 2);
  const storedEvent = memories.find((memory) => memory.kind === "event");
  assert.ok(storedEvent);
  assert.equal(storedEvent.reality, "real");
  assert.equal(storedEvent.world_id, "relationship");
  assert.equal(storedEvent.world_frame, "relational");
  assert.equal(result.relationshipMemberships.status, "ready");
  assert.equal(result.relationshipMemberships.linked, 1);
  assert.equal(
    repository.listRelationshipMemories({
      agentId: AGENT_ID,
      relationshipId: identityStructure.relationship.id,
    })[0].id,
    storedEvent.id,
  );
  assert.equal(
    (await processPendingCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY })).status,
    "skipped",
  );
  database.close();
});

test("archives supplied primary identities with the same actor keys used by entity bindings", async () => {
  const { database, repository } = repositoryFixture();
  const identity = Object.freeze({
    ...IDENTITY,
    primaryUserId: "caroline",
    primaryUserName: "Caroline",
    companionId: "melanie",
    companionName: "Melanie",
  });
  const participants = [
    { role: "user", id: identity.primaryUserId, name: identity.primaryUserName },
    { role: "companion", id: identity.companionId, name: identity.companionName },
  ];
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity,
    events: [
      event({
        eventId: "identity-user-event",
        actor: { role: "user", id: identity.primaryUserId, name: identity.primaryUserName },
        participants,
        content: { text: "I had breakfast before the meeting." },
      }),
      event({
        eventId: "identity-companion-event",
        occurredAt: "2026-08-04T02:01:00.000Z",
        knownAt: "2026-08-04T02:01:00.000Z",
        actor: { role: "companion", id: identity.companionId, name: identity.companionName },
        participants,
        content: { text: "I will remember that detail." },
      }),
    ],
  });

  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity,
    memoriesOverride: [],
  });

  assert.equal(result.status, "processed");
  const userBinding = repository.getActorEntityBinding({
    agentId: AGENT_ID,
    actorRole: "user",
    actorKey: identity.primaryUserId,
  });
  const companionBinding = repository.getActorEntityBinding({
    agentId: AGENT_ID,
    actorRole: "agent",
    actorKey: identity.companionId,
  });
  assert.ok(userBinding);
  assert.ok(companionBinding);
  const userMemories = repository.listActorEntityMemories({
    agentId: AGENT_ID,
    entityId: userBinding.entity_id,
  });
  const companionMemories = repository.listActorEntityMemories({
    agentId: AGENT_ID,
    entityId: companionBinding.entity_id,
  });
  assert.equal(userMemories.some((memory) => memory.content.includes("breakfast")), true);
  assert.equal(companionMemories.some((memory) => memory.content.includes("remember that detail")), true);
  database.close();
});

test("stores one-off daily evidence as an episodic event without promoting a stable state", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({
      content: { text: "我中午吃了牛肉面。" },
      world: { id: "primary", frame: "physical" },
    }),
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    now: new Date("2026-08-04T02:05:00.000Z"),
    memoriesOverride: [generatedEventCandidate({
      title: "中午吃了牛肉面",
      content: "User 中午吃了牛肉面。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [
        { role: "experiencer", actorRole: "user", actorName: "User", confidence: 1 },
      ],
      retentionReason: "episodic_event",
      importance: 0.25,
      sourceRefs: ["M0001"],
    })],
  });
  assert.equal(result.status, "processed");
  assert.equal(result.memoriesStored, 1);
  const memories = repository.listMemories(AGENT_ID, { statuses: [], limit: 20 }).items;
  const storedEvent = memories.find((memory) => memory.kind === "event");
  assert.ok(storedEvent);
  assert.equal(storedEvent.content, "User 中午吃了牛肉面。");
  assert.equal(storedEvent.state_family, "not_applicable");
  assert.equal(memories.some((memory) => memory.kind === "preference"), false);
  database.close();
});

test("returns failed batches to pending so generation can be retried safely", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  await assert.rejects(
    processPendingCompanionEvents({
      repository,
      agentId: AGENT_ID,
      identity: IDENTITY,
      generator: async () => { throw new Error("provider unavailable"); },
    }),
    /provider unavailable/u,
  );
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 1);
  assert.match(pending.items[0].last_error, /provider unavailable/u);
  assert.equal(repository.listInputBatches(AGENT_ID)[0].status, "failed");
  database.close();
});

test("output exhaustion preserves raw evidence and enters review after one extraction attempt", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  let calls = 0;
  const diagnostics = { maxOutputTokens: 65536, usage: { outputTokens: 65536 } };
  const run = () => processPendingCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY,
    generator: async () => { calls++; throw Object.assign(new Error('Output protection reached'), { code: 'MAX_TOKENS', diagnostics }); },
    now: new Date('2026-08-04T02:05:00.000Z') });
  const result = await run();
  assert.equal(result.status, 'processed');
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ['archived'] }).total, 1);
  const review = repository.listMaintenanceTasks(AGENT_ID, { taskTypes: ['long-term-extraction'] })[0];
  assert.equal(review.review_state, 'pending');
  assert.equal(review.attempt_count, 1);
  assert.equal(review.result.failures[0].errorCode, 'MAX_TOKENS');
  assert.deepEqual(review.result.failures[0].details.providerDiagnostics, diagnostics);
  await run();
  assert.equal(calls, 1);
  database.close();
});

test("archives raw evidence and queues human review after three ordinary extraction failures", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  let attempts = 0;
  const generator = async () => {
    attempts += 1;
    const error = new Error("提取模型输出不符合结构化结果。");
    error.code = "MEMORY_GENERATION_INVALID_OUTPUT";
    throw error;
  };

  for (const minute of [5, 6]) {
    await assert.rejects(
      processPendingCompanionEvents({
        repository,
        agentId: AGENT_ID,
        identity: IDENTITY,
        generator,
        now: new Date(`2026-08-04T02:${String(minute).padStart(2, "0")}:00.000Z`),
      }),
      /提取模型输出不符合结构化结果/u,
    );
  }
  const pending = repository.listInputEvents(AGENT_ID, { statuses: ["pending"] });
  assert.equal(pending.total, 1);
  assert.equal(pending.items[0].metadata.suzuMemoryProcessing.attemptCount, 2);
  assert.equal(pending.items[0].metadata.suzuMemoryProcessing.failureHistory.length, 2);

  const terminal = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    generator,
    now: new Date("2026-08-04T02:07:00.000Z"),
  });
  assert.equal(terminal.status, "processed");
  assert.equal(attempts, 3);
  assert.equal(terminal.generatedCandidates, 0);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 1);
  const review = repository.listMaintenanceTasks(AGENT_ID, {
    taskTypes: ["long-term-extraction"],
  })[0];
  assert.equal(review.status, "failed");
  assert.equal(review.review_state, "pending");
  assert.equal(review.attempt_count, 3);
  assert.equal(review.result.failures[0].errorCode, "MEMORY_GENERATION_INVALID_OUTPUT");
  assert.equal(repository.listMemories(AGENT_ID, { kinds: ["utterance"] }).total, 1);
  database.close();
});

test("claims only the caller-scoped pending events for an archive window", async () => {
  const { database, repository } = repositoryFixture();
  const first = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ eventId: "event-first", occurredAt: "2026-08-04T02:00:00.000Z" }),
  });
  const second = appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ eventId: "event-second", occurredAt: "2026-08-04T03:00:00.000Z" }),
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    candidateEventIds: second.events.map((item) => item.id),
    memoriesOverride: [],
  });
  assert.equal(result.status, "processed");
  assert.equal(repository.getInputEvent(AGENT_ID, first.events[0].id).status, "pending");
  assert.equal(repository.getInputEvent(AGENT_ID, second.events[0].id).status, "archived");
  database.close();
});

test("archives raw evidence and queues human review after transport retries are exhausted", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const generator = async () => {
    const error = new Error(
      "记忆处理 API 返回的不是有效响应 JSON（status=200，attempt=3/3）。",
    );
    error.code = "MEMORY_PROVIDER_TRANSPORT_EXHAUSTED";
    error.transportAttempts = 3;
    error.maximumTransportAttempts = 3;
    error.diagnostics = {
      kind: "invalid-response-envelope",
      status: 200,
      contentType: "text/html",
      responseCharacters: 12,
      requestId: "fixture-request",
    };
    throw error;
  };

  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    generator,
    now: new Date("2026-08-04T02:05:00.000Z"),
  });

  assert.equal(result.status, "processed");
  assert.equal(result.eventsProcessed, 1);
  assert.equal(result.messagesArchived, 1);
  assert.equal(result.generatedCandidates, 0);
  assert.equal(result.generationDiagnostics.degraded, true);
  assert.equal(result.generationDiagnostics.transportAttempts, 3);
  assert.match(result.generationDiagnostics.failureReviewTaskId, /^maintenance-task-/u);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).total, 0);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 1);

  const batch = repository.listInputBatches(AGENT_ID)[0];
  assert.equal(batch.status, "completed");
  assert.equal(batch.output.degraded, true);
  assert.equal(batch.output.failureReviewTaskId, result.generationDiagnostics.failureReviewTaskId);
  const review = repository.getMaintenanceTask(
    AGENT_ID,
    result.generationDiagnostics.failureReviewTaskId,
  );
  assert.equal(review.task_type, "long-term-extraction");
  assert.equal(review.status, "failed");
  assert.equal(review.review_state, "pending");
  assert.equal(review.attempt_count, 3);
  assert.equal(review.max_attempts, 3);
  assert.equal(review.failureHistory.length, 1);
  assert.equal(review.failureHistory[0].attempt, 3);
  assert.equal(review.result.failures[0].errorCode, "MEMORY_PROVIDER_TRANSPORT_EXHAUSTED");
  assert.equal(review.payload.memoryIds.length, 1);
  assert.equal(repository.getMemory(review.payload.memoryIds[0]).kind, "utterance");

  const next = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    generator,
  });
  assert.equal(next.status, "skipped");
  assert.equal(next.reason, "no-pending-events");
  database.close();
});

test("reclaims an expired interrupted input batch without allowing its old worker to finish", () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const interrupted = repository.claimPendingInputEvents(AGENT_ID, {
    workerId: "worker-interrupted",
    leaseSeconds: 60,
    createdAt: "2026-08-04T02:00:00.000Z",
  });
  assert.equal(interrupted.events.length, 1);

  const beforeExpiry = repository.claimPendingInputEvents(AGENT_ID, {
    workerId: "worker-too-early",
    leaseSeconds: 60,
    createdAt: "2026-08-04T02:00:30.000Z",
  });
  assert.equal(beforeExpiry.batch, null);

  const reclaimed = repository.claimPendingInputEvents(AGENT_ID, {
    workerId: "worker-retry",
    leaseSeconds: 60,
    createdAt: "2026-08-04T02:01:01.000Z",
  });
  assert.equal(reclaimed.events.length, 1);
  assert.notEqual(reclaimed.batch.id, interrupted.batch.id);
  assert.equal(repository.getInputBatch(AGENT_ID, interrupted.batch.id).status, "failed");
  assert.match(
    repository.getInputBatch(AGENT_ID, interrupted.batch.id).error_message,
    /lease expired/u,
  );
  assert.throws(
    () => repository.completeInputBatch(AGENT_ID, interrupted.batch.id, {
      success: true,
      leaseOwner: "worker-interrupted",
      completedAt: "2026-08-04T02:01:02.000Z",
    }),
    (error) => error.code === "INPUT_BATCH_LEASE_LOST",
  );
  repository.completeInputBatch(AGENT_ID, reclaimed.batch.id, {
    success: false,
    leaseOwner: "worker-retry",
    errorMessage: "retry later",
    completedAt: "2026-08-04T02:01:03.000Z",
  });
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).total, 1);
  database.close();
});

test("queues expensive post-processing without calling providers in the archive turn", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  let embeddingCalls = 0;
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: [generatedEventCandidate({
      sourceRefs: ["M0001"],
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [
        { role: "experiencer", actorRole: "user", actorName: "User", confidence: 1 },
      ],
    })],
    embeddingProvider: async () => {
      embeddingCalls += 1;
      throw new Error("embedding unavailable");
    },
  });
  assert.equal(result.status, "processed");
  assert.equal(embeddingCalls, 0);
  assert.equal(result.embeddingIndex.status, "queued");
  assert.deepEqual(
    result.maintenanceTasks.map((task) => `${task.lane}:${task.taskType}`).sort(),
    [
      "embedding:memory-embedding",
      "semantic:event-continuity",
      "semantic:structure-proposal",
    ],
  );
  const queuedTasks = repository.listMaintenanceTasks(AGENT_ID, { statuses: ["pending"] });
  const embeddingTask = queuedTasks.find((task) => task.task_type === "memory-embedding");
  const semanticTasks = queuedTasks.filter((task) => task.lane === "semantic");
  const utterance = repository.listMemories(AGENT_ID, { statuses: ["active"] }).items
    .find((memory) => memory.kind === "utterance");
  assert.deepEqual(
    new Set(embeddingTask.payload.memoryIds),
    new Set([result.candidateResults[0].memoryId, utterance.id]),
  );
  assert.equal(semanticTasks.every((task) => (
    JSON.stringify(task.payload.memoryIds) === JSON.stringify([result.candidateResults[0].memoryId])
  )), true);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 1);
  database.close();
});

test("rolls back archival when required follow-up tasks cannot be persisted", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({ repository, agentId: AGENT_ID, identity: IDENTITY, events: event() });
  const originalEnqueue = repository.enqueueMaintenanceTask.bind(repository);
  repository.enqueueMaintenanceTask = (options) => {
    if (options.taskType === "memory-embedding") {
      throw Object.assign(new Error("queue storage unavailable"), { code: "QUEUE_STORAGE_UNAVAILABLE" });
    }
    return originalEnqueue(options);
  };
  await assert.rejects(processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: [generatedEventCandidate({ sourceRefs: ["M0001"] })],
  }), /queue storage unavailable/u);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["pending"] }).total, 1);
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 0);
  assert.equal(repository.listMaintenanceTasks(AGENT_ID, { statuses: ["pending"] }).length, 0);
  repository.enqueueMaintenanceTask = originalEnqueue;
  const retried = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: [generatedEventCandidate({ sourceRefs: ["M0001"] })],
  });
  assert.equal(retried.status, "processed");
  assert.equal(repository.listInputEvents(AGENT_ID, { statuses: ["archived"] }).total, 1);
  assert.ok(repository.listMaintenanceTasks(AGENT_ID, { statuses: ["pending"] }).length > 0);
  database.close();
});

test("stores review-gated personal impressions as isolated provisional memories", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({
      actor: { role: "companion", id: AGENT_ID, name: "Companion" },
      content: { text: "我感觉 User 最近可能很喜欢逛科技馆。" },
    }),
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: [generatedEventCandidate({
      kind: "preference",
      title: "对科技馆的兴趣",
      content: "User 似乎喜欢逛科技馆。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [],
      canonicalKey: "preference:museum-visits",
      stateFamily: "preference",
      stateLabel: "喜欢逛科技馆",
      evidenceMode: "inferred",
      temporalState: "current",
      retentionReason: "explicit_preference",
      eventDate: "",
      eventStart: "",
      sourceRefs: ["M0001"],
    })],
  });
  assert.equal(result.memoriesForReview, 1);
  assert.equal(result.candidateResults[0].status, "review");
  assert.ok(result.candidateResults[0].provisionalMemoryId);
  assert.deepEqual(result.candidateResults[0].reasons, ["user-memory-without-user-source"]);
  const provisional = repository.listPendingProvisionalMemories(AGENT_ID);
  assert.equal(provisional.length, 1);
  assert.equal(provisional[0].id, result.candidateResults[0].provisionalMemoryId);
  assert.equal(provisional[0].layer, "provisional");
  assert.equal(provisional[0].status, "archived");
  assert.equal(provisional[0].metadata.epistemicStatus, "agent_impression");
  assert.equal(repository.listMemories(AGENT_ID, { statuses: ["active"] }).total, 1);
  assert.deepEqual(
    result.maintenanceTasks.map((task) => `${task.lane}:${task.taskType}`),
    ["embedding:memory-embedding"],
  );
  assert.equal(Number(database.prepare(`
    SELECT COUNT(*) AS count FROM memory_edges
    WHERE agent_id = ? AND (from_memory_id = ? OR to_memory_id = ?)
  `).get(AGENT_ID, provisional[0].id, provisional[0].id).count), 0);
  database.close();
});

test("queues inferred preference candidates for the behavioral specialist", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({ content: { text: "我最近可能越来越喜欢逛科技馆了。" } }),
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: [generatedEventCandidate({
      kind: "preference",
      title: "对科技馆的兴趣",
      content: "User 可能越来越喜欢逛科技馆。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [
        { role: "preference_holder", actorRole: "user", actorName: "User", confidence: 0.7 },
      ],
      canonicalKey: "preference:museum-visits",
      stateFamily: "preference",
      stateLabel: "喜欢逛科技馆",
      evidenceMode: "inferred",
      temporalState: "current",
      retentionReason: "explicit_preference",
      eventDate: "",
      eventStart: "",
      sourceRefs: ["M0001"],
    })],
  });
  assert.equal(result.stateAnalysisRequestsQueued, 1);
  assert.equal(result.candidateResults[0].status, "analysis_pending");
  const requests = repository.listStateAnalysisRequests(AGENT_ID, { statuses: ["pending"] });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].representation_layer, "inferred");
  assert.equal(repository.listPendingProvisionalMemories(AGENT_ID).length, 0);
  database.close();
});

test("does not expose structurally unresolved reviews as personal impressions", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: event({
      actor: { role: "companion", id: AGENT_ID, name: "Companion" },
      content: { text: "我感觉 User 最近可能很喜欢逛科技馆。" },
    }),
  });
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    memoriesOverride: [generatedEventCandidate({
      kind: "preference",
      title: "对科技馆的兴趣",
      content: "User 似乎喜欢逛科技馆。",
      subjectRole: "user",
      subjectName: "User",
      actorRoles: [],
      canonicalKey: "preference:museum-visits",
      stateFamily: "preference",
      stateLabel: "喜欢逛科技馆",
      evidenceMode: "inferred",
      temporalState: "current",
      retentionReason: "significant_event",
      eventDate: "",
      eventStart: "",
      sourceRefs: ["M0001"],
    })],
  });
  assert.equal(result.candidateResults[0].status, "review");
  assert.deepEqual(
    result.candidateResults[0].reasons,
    ["retention-reason-kind-mismatch", "user-memory-without-user-source"],
  );
  assert.equal(result.candidateResults[0].provisionalMemoryId, "");
  assert.equal(repository.listPendingProvisionalMemories(AGENT_ID).length, 0);
  database.close();
});

test("uses the long-term extraction prompt and refuses to guess across mixed world evidence", async () => {
  const { database, repository } = repositoryFixture();
  appendCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    events: [
      event({ content: { text: "我们在关系世界里一起整理记忆。" } }),
      event({
        eventId: "event-physical",
        occurredAt: "2026-08-04T02:02:00.000Z",
        knownAt: "2026-08-04T02:02:00.000Z",
        world: { id: "physical-home", frame: "physical" },
        content: { text: "User 此时坐在物理世界的电脑前。" },
      }),
    ],
  });
  let receivedSystemPrompt = "";
  const result = await processPendingCompanionEvents({
    repository,
    agentId: AGENT_ID,
    identity: IDENTITY,
    generator: async ({ systemPrompt }) => {
      receivedSystemPrompt = systemPrompt;
      return {
        output: {
          memories: [generatedEventCandidate()],
        },
        usage: {},
      };
    },
  });
  assert.match(receivedSystemPrompt, /world=relational/u);
  assert.equal(result.memoriesForReview, 1);
  assert.deepEqual(result.candidateResults[0].reasons, ["mixed-world-evidence-needs-resolution"]);
  assert.equal(repository.listMemories(AGENT_ID, { statuses: [], kinds: ["event"] }).total, 0);
  database.close();
});
