import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";
import { createMemoryService } from "@suzu-memory/service";

import {
  buildConversationTurnEvents,
  createChatHostMemoryAdapter,
  createMemoryInterventionPolicy,
  executeChatTurn,
} from "../src/index.mjs";

const IDENTITY = Object.freeze({
  spaceId: "companion-test",
  primaryUserId: "user-test",
  primaryUserName: "User",
  companionId: "companion-test",
  companionName: "Companion",
  defaultWorldId: "relationship",
  defaultWorldFrame: "relational",
});

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-host-adapter-"));
}

function fakeMemory() {
  const calls = [];
  const inputEvents = [];
  return {
    calls,
    inputEvents,
    async bindRewardObservation(options) {
      calls.push(["follow-up", options]);
      return { id: "reward-observation-1" };
    },
    async search(query, options) {
      calls.push(["search", query, options]);
      return {
        status: "ready",
        context: "用户之前去过科技馆。",
        fragments: [{ memoryId: "memory-museum" }],
        trace: { id: "trace-1", persisted: true, selectedIds: ["memory-museum"] },
      };
    },
    async setRetrievalSessionHead(options) {
      calls.push(["head", options]);
      return options.traceId ? { trace_id: options.traceId } : null;
    },
    async appendEvents(events) {
      calls.push(["append", events]);
      return { accepted: events.length, inserted: events.length, reused: 0 };
    },
    async listInputEvents(options = {}) {
      calls.push(["list-events", options]);
      const statuses = Array.isArray(options.statuses) ? options.statuses : [];
      const rows = inputEvents.filter((event) => (
        (!statuses.length || statuses.includes(event.status))
        && (!options.hostId || event.metadata?.host?.id === options.hostId)
        && (!options.sessionId || event.metadata?.host?.sessionId === options.sessionId)
      ));
      const offset = Number(options.offset || 0);
      const limit = Number(options.limit || 100);
      return { items: rows.slice(offset, offset + limit), total: rows.length, offset, limit };
    },
    async recoverProcessingEvents(options = {}) {
      calls.push(["recover-events", options]);
      return { recovered: 0, batches: [] };
    },
    async processPendingEvents(options = {}) {
      calls.push(["process-events", options]);
      const selected = new Set(options.candidateEventIds || []);
      const selectedRows = inputEvents.filter((event) => selected.has(event.id) && event.status === "pending");
      selectedRows.forEach((event) => { event.status = "archived"; });
      return { status: selectedRows.length ? "processed" : "skipped", eventsProcessed: selectedRows.length };
    },
    async bindRetrievalUsageResponse(options) {
      calls.push(["response", options]);
      return { id: "usage-request-1" };
    },
    recordRetrievalFeedback(options) {
      calls.push(["feedback", options]);
      return { id: "feedback-1" };
    },
    async runMaintenance(options) {
      calls.push(["maintenance", options]);
      return { status: "completed", lane: options.lane || "all" };
    },
  };
}

test("adapter exposes one host-neutral before/after reply lifecycle", async () => {
  const memory = fakeMemory();
  const adapter = createChatHostMemoryAdapter({
    memory,
    hostId: "claude-code",
    identity: IDENTITY,
  });
  const prepared = await adapter.beforeReply({
    sessionId: "session-1",
    turnId: "turn-1",
    userText: "还记得科技馆吗？",
    userOccurredAt: "2026-08-05T01:00:00.000Z",
  });
  assert.equal(prepared.memoryContext.content, "用户之前去过科技馆。");
  assert.equal(prepared.memoryContext.traceId, "trace-1");
  assert.match(prepared.runtimeSessionId, /^host-session-[0-9a-f]{64}$/u);
  assert.deepEqual(memory.calls.slice(0, 3).map((item) => item[0]), [
    "follow-up", "search", "head",
  ]);
  const search = memory.calls.find((item) => item[0] === "search");
  assert.deepEqual(search[2].world, {
    id: IDENTITY.defaultWorldId,
    frame: IDENTITY.defaultWorldFrame,
  });
  assert.equal(search[2].allowCrossWorld, false);
  assert.deepEqual(search[2].queryPerspective.speakerNames, [IDENTITY.primaryUserName]);
  assert.deepEqual(search[2].queryPerspective.addresseeNames, [IDENTITY.companionName]);

  const completed = await adapter.afterReply({
    sessionId: "session-1",
    turnId: "turn-1",
    retrievalTraceId: prepared.memoryContext.traceId,
    userMessage: {
      id: "user-message-1",
      text: "还记得科技馆吗？",
      occurredAt: "2026-08-05T01:00:00.000Z",
    },
    assistantMessage: {
      id: "assistant-message-1",
      text: "记得，你之前去过科技馆。",
      occurredAt: "2026-08-05T01:00:02.000Z",
    },
    recordedAt: "2026-08-05T01:00:03.000Z",
  });
  assert.equal(completed.events.length, 2);
  assert.deepEqual(completed.events.map((event) => event.actor.role), ["user", "companion"]);
  assert.ok(completed.events.every((event) => (
    event.world.id === IDENTITY.defaultWorldId
    && event.world.frame === IDENTITY.defaultWorldFrame
  )));
  assert.equal(completed.events[1].metadata.retrievalTraceId, "trace-1");
  assert.deepEqual(memory.calls.slice(3, 5).map((item) => item[0]), ["append", "response"]);
  assert.equal(
    memory.calls.find((item) => item[0] === "follow-up")[1].sessionId,
    memory.calls.find((item) => item[0] === "response")[1].sessionId,
  );
});

test("runtime session heads are isolated when different hosts reuse the same session id", async () => {
  const firstMemory = fakeMemory();
  const secondMemory = fakeMemory();
  const first = createChatHostMemoryAdapter({
    memory: firstMemory,
    hostId: "codex:desktop-a",
    identity: IDENTITY,
  });
  const second = createChatHostMemoryAdapter({
    memory: secondMemory,
    hostId: "claude-code:desktop-a",
    identity: IDENTITY,
  });
  const [firstPrepared, secondPrepared] = await Promise.all([
    first.beforeReply({ sessionId: "session-1", turnId: "turn-1", userText: "第一边" }),
    second.beforeReply({ sessionId: "session-1", turnId: "turn-1", userText: "第二边" }),
  ]);
  assert.equal(firstPrepared.sessionId, "session-1");
  assert.equal(secondPrepared.sessionId, "session-1");
  assert.notEqual(firstPrepared.runtimeSessionId, secondPrepared.runtimeSessionId);
  assert.equal(
    firstMemory.calls.find((item) => item[0] === "head")[1].sessionId,
    firstPrepared.runtimeSessionId,
  );
  assert.equal(
    secondMemory.calls.find((item) => item[0] === "head")[1].sessionId,
    secondPrepared.runtimeSessionId,
  );
});

test("turn event ids are deterministic and host-scoped", () => {
  const input = {
    identity: IDENTITY,
    hostId: "codex",
    sessionId: "session-2",
    turnId: "turn-9",
    userMessage: { text: "第一句话", occurredAt: "2026-08-05T02:00:00.000Z" },
    assistantMessage: { text: "第二句话", occurredAt: "2026-08-05T02:00:01.000Z" },
    recordedAt: "2026-08-05T02:00:02.000Z",
  };
  const first = buildConversationTurnEvents(input);
  const replay = buildConversationTurnEvents(input);
  assert.deepEqual(first.map((event) => event.eventId), replay.map((event) => event.eventId));
  assert.notEqual(first[0].eventId, first[1].eventId);
  assert.equal(first[0].metadata.host.id, "codex");
  assert.match(first[0].source.locator, /^host:\/\/codex\/sessions\//u);
  assert.equal(first[0].metadata.memoryWindow.id, first[1].metadata.memoryWindow.id);
  assert.equal(first[0].metadata.memoryWindow.unitId, first[1].metadata.memoryWindow.unitId);
});

test("host idle maintenance uses the same archive windows as the benchmark planner", async () => {
  const memory = fakeMemory();
  const adapter = createChatHostMemoryAdapter({ memory, hostId: "codex", identity: IDENTITY });
  const stored = [
    ...buildConversationTurnEvents({
      identity: IDENTITY,
      hostId: "codex",
      sessionId: "archive-session",
      turnId: "turn-1",
      userMessage: { text: "我去科技馆了", occurredAt: "2026-08-05T01:00:00.000Z" },
      assistantMessage: { text: "玩得怎么样？", occurredAt: "2026-08-05T01:00:01.000Z" },
    }),
    ...buildConversationTurnEvents({
      identity: IDENTITY,
      hostId: "codex",
      sessionId: "archive-session",
      turnId: "turn-2",
      userMessage: { text: "看了机器人展", occurredAt: "2026-08-05T01:01:00.000Z" },
      assistantMessage: { text: "那一定很有意思", occurredAt: "2026-08-05T01:01:01.000Z" },
    }),
  ].map((event, index) => ({
    ...event,
    id: `input-${index + 1}`,
    external_id: event.eventId,
    actor_role: event.actor.role,
    actor_key: event.actor.id,
    occurred_at: event.occurredAt,
    known_at: event.knownAt,
    recorded_at: event.recordedAt,
    status: "pending",
  }));
  memory.inputEvents.push(...stored);

  const result = await adapter.onSessionEnd({
    sessionId: "archive-session",
    maximumEvents: 2,
    maximumContentCharacters: 10_000,
    maximumPreviousContextMessages: 2,
    maximumPreviousContextCharacters: 10_000,
    maximumContinuationGuidanceMessages: 2,
    maximumContinuationGuidanceCharacters: 10_000,
  });
  assert.equal(result.input.length, 1);
  assert.equal(result.input[0].batches.length, 2);
  const processCalls = memory.calls.filter(([name]) => name === "process-events");
  assert.equal(processCalls.length, 2);
  assert.deepEqual(processCalls[0][1].candidateEventIds, ["input-1", "input-2"]);
  assert.deepEqual(processCalls[1][1].candidateEventIds, ["input-3", "input-4"]);
  assert.equal(processCalls[0][1].archiveWindows[0].previousContextEvents.length, 0);
  assert.equal(processCalls[0][1].archiveWindows[0].continuationGuidanceEvents.length, 2);
  assert.equal(processCalls[1][1].archiveWindows[0].previousContextEvents.length, 2);
  assert.equal(processCalls[1][1].archiveWindows[0].continuationGuidanceEvents.length, 0);
  const maintenance = memory.calls.find(([name]) => name === "maintenance");
  assert.equal(maintenance[1].processInputEvents, false);
});

test("nested source locators are preserved while legacy sourceLocator remains the explicit override", () => {
  const common = {
    identity: IDENTITY,
    hostId: "codex",
    sessionId: "source-session",
    turnId: "source-turn",
    userMessage: {
      text: "用户消息",
      source: { kind: "wechat", locator: "wechat://message/user-1" },
    },
    assistantMessage: {
      text: "助手消息",
      source: { kind: "wechat", locator: "wechat://message/assistant-1" },
    },
  };
  const nested = buildConversationTurnEvents(common);
  assert.equal(nested[0].source.locator, "wechat://message/user-1");
  assert.equal(nested[1].source.locator, "wechat://message/assistant-1");

  const overridden = buildConversationTurnEvents({
    ...common,
    userMessage: {
      ...common.userMessage,
      sourceLocator: "host://explicit-user-locator",
    },
  });
  assert.equal(overridden[0].source.locator, "host://explicit-user-locator");
});

test("host can explicitly skip recall without leaving a stale response binding", async () => {
  const memory = fakeMemory();
  const adapter = createChatHostMemoryAdapter({ memory, hostId: "codex", identity: IDENTITY });
  const prepared = await adapter.beforeReply({
    sessionId: "session-short",
    turnId: "turn-short",
    userText: "吃了",
    recall: { enabled: false, reason: "current-context-is-sufficient" },
  });
  assert.equal(prepared.status, "skipped");
  assert.equal(prepared.memoryContext.reason, "current-context-is-sufficient");
  assert.equal(memory.calls.some((item) => item[0] === "search"), false);
  assert.equal(memory.calls.find((item) => item[0] === "head")[1].traceId, "");
});

test("intervention policy skips a short reply when live context is sufficient", async () => {
  const decide = createMemoryInterventionPolicy();
  const result = await decide({
    userText: "吃了",
    recentMessages: [{ role: "assistant", content: "吃饭了吗？" }],
  });
  assert.equal(result.action, "skip");
  assert.equal(result.source, "deterministic-short-reply");
  assert.equal(result.query, "");
});

test("intervention policy recalls explicit history without calling a model", async () => {
  let calls = 0;
  const decide = createMemoryInterventionPolicy({
    generator: async () => {
      calls += 1;
      throw new Error("must not run");
    },
  });
  const result = await decide({ userText: "你还记得我上次去科技馆吗？" });
  assert.equal(result.action, "recall");
  assert.equal(result.source, "deterministic-history-cue");
  assert.equal(calls, 0);
});

test("intervention policy uses a structured LLM only for an ambiguous turn", async () => {
  let request = null;
  const decide = createMemoryInterventionPolicy({
    generator: async (value) => {
      request = value;
      return {
        output: {
          action: "recall",
          reasonCode: "unresolved-reference",
          query: "用户提到的那家店是什么店",
          confidence: 0.87,
        },
        model: "small-policy-model",
        requestId: "policy-request-1",
        durationMs: 12,
        usage: { prompt_tokens: 40, completion_tokens: 18 },
      };
    },
  });
  const result = await decide({
    userText: "那家店怎么样？",
    recentMessages: [{ role: "assistant", content: "你想继续聊哪个事情？" }],
  });
  assert.equal(request.schemaName, "memory-intervention-decision-v1");
  assert.match(request.input, /那家店怎么样/u);
  assert.equal(result.action, "recall");
  assert.equal(result.query, "用户提到的那家店是什么店");
  assert.equal(result.source, "structured-llm");
  assert.deepEqual(result.usage, { prompt_tokens: 40, completion_tokens: 18 });
});

test("context-dependent follow-ups are not forced into recall before the model sees live context", async () => {
  let calls = 0;
  const decide = createMemoryInterventionPolicy({
    generator: async () => {
      calls += 1;
      return {
        output: {
          action: "skip",
          reasonCode: "current-context-sufficient",
          query: "",
          confidence: 0.96,
        },
      };
    },
  });
  const result = await decide({
    userText: "后来呢？",
    recentMessages: [
      { role: "user", content: "我刚刚在讲今天开会的事。" },
      { role: "assistant", content: "会议开始时发生了什么？" },
    ],
  });
  assert.equal(calls, 1);
  assert.equal(result.action, "skip");
  assert.equal(result.source, "structured-llm");
});

test("auto recall mode applies the intervention decision and preserves explicit overrides", async () => {
  const memory = fakeMemory();
  const adapter = createChatHostMemoryAdapter({
    memory,
    hostId: "codex",
    identity: IDENTITY,
    interventionPolicy: createMemoryInterventionPolicy(),
  });
  const skipped = await adapter.beforeReply({
    sessionId: "auto-session",
    turnId: "auto-turn-1",
    userText: "吃了",
    recentMessages: [{ role: "assistant", content: "吃饭了吗？" }],
    recall: { mode: "auto" },
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.interventionDecision.action, "skip");
  assert.equal(memory.calls.some((item) => item[0] === "search"), false);

  const recalled = await adapter.beforeReply({
    sessionId: "auto-session",
    turnId: "auto-turn-2",
    userText: "吃了",
    recentMessages: [{ role: "assistant", content: "吃饭了吗？" }],
    recall: { mode: "auto", enabled: true, query: "过去的饮食记录" },
  });
  assert.equal(recalled.status, "ready");
  assert.equal(recalled.interventionDecision, null);
  assert.equal(memory.calls.find((item) => item[0] === "search")[1], "过去的饮食记录");
});

test("executeChatTurn gives raw memory context to the host and archives the final reply", async () => {
  const memory = fakeMemory();
  const adapter = createChatHostMemoryAdapter({ memory, hostId: "custom-runtime", identity: IDENTITY });
  const result = await executeChatTurn({
    adapter,
    sessionId: "wrapped-session",
    turnId: "wrapped-turn",
    userMessage: {
      id: "wrapped-user",
      text: "科技馆那次呢？",
      occurredAt: "2026-08-05T02:30:00.000Z",
    },
    generateReply: ({ memoryContext }) => {
      assert.equal(memoryContext.content, "用户之前去过科技馆。");
      return {
        id: "wrapped-agent",
        text: "记得那次科技馆。",
        occurredAt: "2026-08-05T02:30:01.000Z",
      };
    },
  });
  assert.equal(result.assistantMessage.text, "记得那次科技馆。");
  assert.deepEqual(memory.calls.map((item) => item[0]), [
    "follow-up", "search", "head", "append", "response",
  ]);
});

test("executeChatTurn forwards world, participants, metadata, and recorded time through both lifecycle sides", async () => {
  const memory = fakeMemory();
  const adapter = createChatHostMemoryAdapter({ memory, hostId: "custom-runtime", identity: IDENTITY });
  await executeChatTurn({
    adapter,
    sessionId: "rich-turn-session",
    turnId: "rich-turn",
    userMessage: {
      text: "我们在设定里讨论这座虚构城市。",
      source: { kind: "chat", locator: "chat://turn/user" },
    },
    participants: [{ id: "friend-1", role: "other", name: "Friend" }],
    world: { id: "novel-city", frame: "fictional" },
    metadata: { scene: "chapter-one", feedback: { channel: "test" } },
    recordedAt: "2026-08-05T03:30:00.000Z",
    generateReply: () => ({
      text: "那座城市的雨一直没有停。",
      source: { kind: "chat", locator: "chat://turn/assistant" },
    }),
  });
  const search = memory.calls.find((item) => item[0] === "search");
  assert.deepEqual(search[2].world, { id: "novel-city", frame: "fictional" });
  assert.equal(search[2].allowCrossWorld, false);
  const events = memory.calls.find((item) => item[0] === "append")[1];
  assert.equal(events[0].world.id, "novel-city");
  assert.equal(events[0].world.frame, "fictional");
  assert.equal(events[0].metadata.scene, "chapter-one");
  assert.equal(events[0].recordedAt, "2026-08-05T03:30:00.000Z");
  assert.equal(events[0].participants.at(-1).id, "friend-1");
  assert.equal(events[0].source.locator, "chat://turn/user");
  assert.equal(events[1].source.locator, "chat://turn/assistant");
});

test("executeChatTurn clears the session head when host generation fails", async () => {
  const memory = fakeMemory();
  const adapter = createChatHostMemoryAdapter({ memory, hostId: "custom-runtime", identity: IDENTITY });
  await assert.rejects(executeChatTurn({
    adapter,
    sessionId: "failed-session",
    turnId: "failed-turn",
    userMessage: { text: "失败测试" },
    generateReply: async () => {
      throw new Error("host generation failed");
    },
  }), /host generation failed/u);
  assert.equal(memory.calls.at(-1)[0], "head");
  assert.equal(memory.calls.at(-1)[1].traceId, "");
  assert.equal(memory.calls.some((item) => item[0] === "append"), false);
});

test("executeChatTurn still generates a reply when long-term retrieval is unavailable", async () => {
  const memory = fakeMemory();
  memory.search = async () => {
    throw Object.assign(new Error("retriever offline"), { code: "RETRIEVER_OFFLINE" });
  };
  const adapter = createChatHostMemoryAdapter({ memory, hostId: "custom-runtime", identity: IDENTITY });
  let receivedContext = null;
  const result = await executeChatTurn({
    adapter,
    sessionId: "degraded-retrieval-session",
    turnId: "degraded-retrieval-turn",
    userMessage: { text: "还记得那件事吗？" },
    generateReply: async ({ memoryContext }) => {
      receivedContext = memoryContext;
      return "即使记忆暂时不可用，我也会继续回答。";
    },
  });
  assert.equal(result.prepared.status, "degraded");
  assert.equal(result.prepared.memoryDiagnostics.stage, "retrieval");
  assert.equal(receivedContext.status, "degraded");
  assert.equal(receivedContext.content, "");
  assert.equal(result.assistantMessage.text, "即使记忆暂时不可用，我也会继续回答。");
});

test("executeChatTurn keeps a completed reply when archival fails", async () => {
  const memory = fakeMemory();
  memory.appendEvents = async () => {
    throw Object.assign(new Error("archive unavailable"), { code: "ARCHIVE_OFFLINE" });
  };
  const adapter = createChatHostMemoryAdapter({ memory, hostId: "custom-runtime", identity: IDENTITY });
  const result = await executeChatTurn({
    adapter,
    sessionId: "degraded-archive-session",
    turnId: "degraded-archive-turn",
    userMessage: { text: "存档失败测试" },
    generateReply: async () => "这条回复仍会送达用户。",
  });
  assert.equal(result.assistantMessage.text, "这条回复仍会送达用户。");
  assert.equal(result.archived.status, "degraded");
  assert.equal(result.archived.memoryDiagnostics.code, "ARCHIVE_OFFLINE");
});

test("adapter lifecycle persists events, response use, and next-message feedback in the real Service", async () => {
  const dataRoot = temporaryDirectory();
  const service = createMemoryService({
    dataRoot,
    agentId: IDENTITY.spaceId,
    defaults: {
      primaryUserId: IDENTITY.primaryUserId,
      userName: IDENTITY.primaryUserName,
      companionId: IDENTITY.companionId,
      memoryOwner: IDENTITY.companionName,
    },
  });
  service.initialize();
  service.withRepository((repository) => repository.upsertMemory({
    id: "museum-memory",
    agentId: service.agentId,
    kind: "event",
    layer: "episodic",
    title: "科技馆之行",
    content: "用户上周六去了科技馆，并参观了机器人展。",
    subjectRole: "user",
    subjectKey: IDENTITY.primaryUserId,
    worldId: IDENTITY.defaultWorldId,
    worldFrame: IDENTITY.defaultWorldFrame,
    eventDate: "2026-08-01",
    status: "active",
  }));
  const adapter = createChatHostMemoryAdapter({
    memory: service,
    hostId: "codex",
    identity: IDENTITY,
  });
  const prepared = await adapter.beforeReply({
    sessionId: "real-session",
    turnId: "real-turn-1",
    userText: "记得我上周六去科技馆吗？",
    userOccurredAt: "2026-08-05T03:00:00.000Z",
  });
  assert.equal(prepared.memoryContext.status, "ready");
  assert.ok(prepared.memoryContext.traceId);
  await adapter.afterReply({
    sessionId: "real-session",
    turnId: "real-turn-1",
    retrievalTraceId: prepared.memoryContext.traceId,
    userMessage: { text: "记得我上周六去科技馆吗？", occurredAt: "2026-08-05T03:00:00.000Z" },
    assistantMessage: { text: "记得，你参观了机器人展。", occurredAt: "2026-08-05T03:00:02.000Z" },
    recordedAt: "2026-08-05T03:00:03.000Z",
  });
  const afterTurn = service.withRepository((repository) => ({
    events: repository.listInputEvents(service.agentId, { statuses: ["pending"] }),
    usage: repository.listRetrievalUsageRequests(service.agentId, { statuses: ["pending"] }),
  }), { readOnly: true });
  assert.equal(afterTurn.events.total, 2);
  assert.equal(afterTurn.usage.length, 1);

  await adapter.beforeReply({
    sessionId: "real-session",
    turnId: "real-turn-2",
    userText: "对，就是那个机器人展。",
    userOccurredAt: "2026-08-05T03:01:00.000Z",
    recall: { enabled: false },
  });
  const observations = service.withRepository(
    (repository) => repository.listRewardObservations(service.agentId, { statuses: ["pending"] }),
    { readOnly: true },
  );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].feedback_text, "对，就是那个机器人展。");

  const database = openMemoryDatabase(service.paths.databasePath, { readOnly: true });
  try {
    const repository = new MemoryRepository(database);
    assert.equal(repository.getMemory("museum-memory").importance, 0.5);
  } finally {
    database.close();
  }
});

test("real host session maintenance applies the shared archive planner before semantic maintenance", async () => {
  const dataRoot = temporaryDirectory();
  const service = createMemoryService({
    dataRoot,
    agentId: IDENTITY.spaceId,
    defaults: {
      primaryUserId: IDENTITY.primaryUserId,
      userName: IDENTITY.primaryUserName,
      companionId: IDENTITY.companionId,
      memoryOwner: IDENTITY.companionName,
    },
  });
  service.initialize();
  const adapter = createChatHostMemoryAdapter({ memory: service, hostId: "codex", identity: IDENTITY });
  await adapter.afterReply({
    sessionId: "windowed-real-session",
    turnId: "turn-1",
    userMessage: { text: "我去科技馆了", occurredAt: "2026-08-05T01:00:00.000Z" },
    assistantMessage: { text: "玩得怎么样？", occurredAt: "2026-08-05T01:00:01.000Z" },
  });
  await adapter.afterReply({
    sessionId: "windowed-real-session",
    turnId: "turn-2",
    userMessage: { text: "看了机器人展", occurredAt: "2026-08-05T01:01:00.000Z" },
    assistantMessage: { text: "听起来很有意思", occurredAt: "2026-08-05T01:01:01.000Z" },
  });
  const completed = await adapter.onSessionEnd({
    sessionId: "windowed-real-session",
    lane: "embedding",
    maximumEvents: 2,
    maximumContentCharacters: 10_000,
    memoriesOverride: [],
  });
  assert.equal(completed.input[0].batches.length, 2);
  const pending = service.listInputEvents({
    statuses: ["pending"], hostId: "codex", sessionId: "windowed-real-session",
  });
  assert.equal(pending.total, 0);
  const archived = service.listInputEvents({
    statuses: ["archived"], hostId: "codex", sessionId: "windowed-real-session",
  });
  assert.equal(archived.total, 4);
  const windows = completed.input[0].batches.map((batch) => batch.windowIds);
  assert.equal(windows.length, 2);
});

test("a later host turn can be archived after earlier turns are already archived", async () => {
  const dataRoot = temporaryDirectory();
  const service = createMemoryService({
    dataRoot,
    agentId: IDENTITY.spaceId,
    defaults: {
      primaryUserId: IDENTITY.primaryUserId,
      userName: IDENTITY.primaryUserName,
      companionId: IDENTITY.companionId,
      memoryOwner: IDENTITY.companionName,
    },
  });
  service.initialize();
  const adapter = createChatHostMemoryAdapter({ memory: service, hostId: "codex", identity: IDENTITY });
  await adapter.afterReply({
    sessionId: "continued-real-session",
    turnId: "turn-1",
    userMessage: { text: "第一轮已经归档。", occurredAt: "2026-08-05T01:00:00.000Z" },
    assistantMessage: { text: "第一轮回复。", occurredAt: "2026-08-05T01:00:01.000Z" },
  });
  const first = await adapter.onIdle({
    sessionId: "continued-real-session",
    lane: "embedding",
    memoriesOverride: [],
  });
  assert.equal(first.status, "completed");

  await adapter.afterReply({
    sessionId: "continued-real-session",
    turnId: "turn-2",
    userMessage: { text: "第二轮应该不会被第一轮阻塞。", occurredAt: "2026-08-05T01:02:00.000Z" },
    assistantMessage: { text: "第二轮回复。", occurredAt: "2026-08-05T01:02:01.000Z" },
  });
  const second = await adapter.onIdle({
    sessionId: "continued-real-session",
    lane: "embedding",
    memoriesOverride: [],
  });
  assert.equal(second.status, "completed");
  assert.equal(second.input[0].batches.length, 1);
  const pending = service.listInputEvents({
    statuses: ["pending"], hostId: "codex", sessionId: "continued-real-session",
  });
  const archived = service.listInputEvents({
    statuses: ["archived"], hostId: "codex", sessionId: "continued-real-session",
  });
  assert.equal(pending.total, 0);
  assert.equal(archived.total, 4);
});

test("a fresh adapter discovers persisted pending host sessions after restart", async () => {
  const dataRoot = temporaryDirectory();
  const service = createMemoryService({
    dataRoot,
    agentId: IDENTITY.spaceId,
    defaults: {
      primaryUserId: IDENTITY.primaryUserId,
      userName: IDENTITY.primaryUserName,
      companionId: IDENTITY.companionId,
      memoryOwner: IDENTITY.companionName,
    },
  });
  const firstProcess = createChatHostMemoryAdapter({ memory: service, hostId: "codex", identity: IDENTITY });
  await firstProcess.afterReply({
    sessionId: "recover-after-restart",
    turnId: "turn-1",
    userMessage: { text: "这批事件来自重启前。", occurredAt: "2026-08-05T04:00:00.000Z" },
    assistantMessage: { text: "我会在空闲时整理它。", occurredAt: "2026-08-05T04:00:01.000Z" },
  });
  service.withRepository((repository) => repository.claimPendingInputEvents(service.agentId, {
    workerId: "stopped-host-worker",
    leaseSeconds: 60,
    createdAt: "2026-08-05T04:01:00.000Z",
  }));
  const restarted = createChatHostMemoryAdapter({ memory: service, hostId: "codex", identity: IDENTITY });
  const completed = await restarted.onIdle({
    lane: "embedding",
    now: "2026-08-05T04:03:00.000Z",
    maximumEvents: 10,
    maximumContentCharacters: 10_000,
    memoriesOverride: [],
  });
  assert.equal(completed.recovered.recovered, 1);
  assert.equal(completed.input.length, 1);
  assert.equal(completed.input[0].sessionId, "recover-after-restart");
  const pending = service.listInputEvents({
    statuses: ["pending"], hostId: "codex", sessionId: "recover-after-restart",
  });
  assert.equal(pending.total, 0);
});

test("idle isolates one session archive failure and still maintains later sessions", async () => {
  const memory = fakeMemory();
  const adapter = createChatHostMemoryAdapter({ memory, hostId: "codex", identity: IDENTITY });
  const failingTurn = await adapter.afterReply({
    sessionId: "temporarily-failing-session",
    turnId: "turn-1",
    userMessage: { text: "第一段会暂时提取失败。" },
    assistantMessage: { text: "我会稍后再整理。" },
  });
  const healthyTurn = await adapter.afterReply({
    sessionId: "healthy-session",
    turnId: "turn-1",
    userMessage: { text: "第二段应该继续归档。" },
    assistantMessage: { text: "这段会照常整理。" },
  });
  memory.inputEvents.push(
    // The repository exposes its stable event id as `id`; turn construction
    // intentionally calls the wire-field `eventId`. Mirror that boundary in
    // this fake so the archive planner exercises the real candidate path.
    ...failingTurn.events.map((event) => ({ ...event, id: event.eventId, status: "pending" })),
    ...healthyTurn.events.map((event) => ({ ...event, id: event.eventId, status: "pending" })),
  );
  const originalProcessPendingEvents = memory.processPendingEvents;
  let attempts = 0;
  memory.processPendingEvents = async (options) => {
    attempts += 1;
    if (attempts === 1) {
      const error = new Error("Temporary extraction transport failure.");
      error.code = "TEMPORARY_EXTRACTION_FAILURE";
      throw error;
    }
    return originalProcessPendingEvents(options);
  };

  const completed = await adapter.onIdle({ lane: "embedding" });

  assert.equal(completed.status, "completed-with-failures");
  assert.equal(completed.input.length, 2);
  assert.equal(completed.input[0].status, "failed");
  assert.equal(completed.input[0].sessionId, "temporarily-failing-session");
  assert.equal(completed.input[0].error.code, "TEMPORARY_EXTRACTION_FAILURE");
  assert.equal(completed.input[1].status, "processed");
  assert.equal(completed.input[1].sessionId, "healthy-session");
  assert.deepEqual(completed.failures.map((item) => item.sessionId), ["temporarily-failing-session"]);
  assert.equal(memory.calls.filter((item) => item[0] === "maintenance").length, 1);
  assert.equal(
    memory.inputEvents.filter((event) => event.metadata.host.sessionId === "temporarily-failing-session"
      && event.status === "pending").length,
    2,
  );
  assert.equal(
    memory.inputEvents.filter((event) => event.metadata.host.sessionId === "healthy-session"
      && event.status === "archived").length,
    2,
  );
});
