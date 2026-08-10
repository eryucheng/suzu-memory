import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
  proposeMemoryStructure,
} from "@suzu-memory/core";
import { createMemoryServiceFromConfig, loadMemoryConfig } from "@suzu-memory/config";
import { createMemoryService } from "@suzu-memory/service";

import { createMemoryHttpServer } from "../src/index.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-server-"));
}

async function json(response) {
  const body = await response.json();
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  return body;
}

test("local HTTP product surface reuses Service status, retrieval and editing", async (context) => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "companion-test" });
  service.initialize();
  let proposalId = "";
  const database = openMemoryDatabase(service.paths.databasePath);
  try {
    const repository = new MemoryRepository(database);
    repository.upsertMemory({
      id: "event-dinner",
      agentId: service.agentId,
      kind: "event",
      layer: "long_term",
      title: "一起吃晚饭",
      content: "用户和陪伴者周六一起吃了晚饭。",
      subjectRole: "shared",
      subjectKey: "relationship:test",
      reality: "real",
      evidenceMode: "explicit",
      eventDate: "2026-08-01",
      recordedAt: "2026-08-01T12:00:00.000Z",
      status: "active",
    });
    repository.upsertMemory({
      id: "event-walk",
      agentId: service.agentId,
      kind: "event",
      layer: "long_term",
      title: "饭后散步",
      content: "用户和陪伴者吃完饭后一起散步。",
      subjectRole: "shared",
      subjectKey: "relationship:test",
      reality: "real",
      evidenceMode: "explicit",
      eventDate: "2026-08-01",
      recordedAt: "2026-08-01T13:00:00.000Z",
      status: "active",
    });
    proposalId = proposeMemoryStructure(repository, {
      agentId: service.agentId,
      kind: "episode",
      content: "同一次周六晚间相处。",
      subjectRole: "shared",
      subjectKey: "relationship:test",
      eventDate: "2026-08-01",
      memberIds: ["event-dinner", "event-walk"],
    }).id;
  } finally {
    database.close();
  }
  const controller = createMemoryHttpServer({ service, apiKey: "test-key" });
  context.after(() => controller.close());
  const address = await controller.listen({ port: 0 });

  const consolePage = await fetch(`${address.baseUrl}/console/`);
  assert.equal(consolePage.status, 200);
  assert.equal(consolePage.headers.get("content-type"), "text/html; charset=utf-8");
  assert.match(await consolePage.text(), /记忆审核台/u);
  assert.match(consolePage.headers.get("content-security-policy"), /default-src 'self'/u);
  const health = await json(await fetch(`${address.baseUrl}/v1/health`));
  assert.equal(health.data.service, "suzu-memory");
  const unauthorized = await fetch(`${address.baseUrl}/v1/status`);
  assert.equal(unauthorized.status, 401);
  const headers = { authorization: "Bearer test-key", "content-type": "application/json" };
  const status = await json(await fetch(`${address.baseUrl}/v1/status`, { headers }));
  assert.equal(status.data.memoryCount, 2);

  const search = await json(await fetch(`${address.baseUrl}/v1/search`, {
    method: "POST",
    headers,
    body: JSON.stringify({ query: "记得周六一起吃晚饭吗", now: "2026-08-04T12:00:00.000Z" }),
  }));
  assert.equal(search.data.fragments[0].memoryId, "event-dinner");
  assert.equal(search.data.trace.persisted, true);
  const sessionId = "server-host-session";
  const retrievalHead = await json(await fetch(
    `${address.baseUrl}/v1/runtime-sessions/${sessionId}/retrieval-head`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ traceId: search.data.trace.id, now: "2026-08-04T12:00:01.000Z" }),
    },
  ));
  assert.equal(retrievalHead.data.trace_id, search.data.trace.id);
  const usage = await json(await fetch(
    `${address.baseUrl}/v1/runtime-sessions/${sessionId}/response`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        responseText: "记得，我们周六一起吃了晚饭。",
        now: "2026-08-04T12:00:02.000Z",
      }),
    },
  ));
  assert.equal(usage.data.status, "pending");
  const followUp = await json(await fetch(
    `${address.baseUrl}/v1/runtime-sessions/${sessionId}/follow-up`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        feedbackText: "对，就是那次晚饭。",
        now: "2026-08-04T12:00:03.000Z",
      }),
    },
  ));
  assert.equal(followUp.data.status, "pending");

  const edited = await json(await fetch(`${address.baseUrl}/v1/memories/event-dinner`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ patch: { title: "周六的晚饭" }, reason: "测试" }),
  }));
  assert.equal(edited.data.title, "周六的晚饭");

  const reviews = await json(await fetch(`${address.baseUrl}/v1/high-level-proposals`, { headers }));
  assert.equal(reviews.data.items[0].id, proposalId);
  const consoleOverview = await json(await fetch(`${address.baseUrl}/v1/review-console`, { headers }));
  assert.equal(consoleOverview.data.reviews.items[0].id, proposalId);
  assert.equal(consoleOverview.data.storage.activeDatabase.status, "valid");
  const consoleReview = await json(await fetch(
    `${address.baseUrl}/v1/review-console/proposals/structure/${encodeURIComponent(proposalId)}`,
    { headers },
  ));
  assert.equal(consoleReview.data.members.length, 2);
  assert.equal(consoleReview.data.permissions.canAccept, true);
  const review = await json(await fetch(
    `${address.baseUrl}/v1/high-level-proposals/structure/${encodeURIComponent(proposalId)}`,
    { headers },
  ));
  assert.equal(review.data.type, "structure");
  const resolved = await json(await fetch(
    `${address.baseUrl}/v1/high-level-proposals/structure/${encodeURIComponent(proposalId)}/resolve`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ action: "accept", actor: "human:test" }),
    },
  ));
  assert.equal(resolved.data.resolution.status, "accepted");
});

test("server refuses an unauthenticated non-loopback binding", async () => {
  const controller = createMemoryHttpServer({
    serviceOptions: { dataRoot: temporaryDirectory(), agentId: "companion-test" },
  });
  await assert.rejects(
    controller.listen({ host: "0.0.0.0", port: 0 }),
    /requires an API key/u,
  );
});

test("HTTP hides unexpected internal errors behind a stable server failure", async (context) => {
  const controller = createMemoryHttpServer({
    service: {
      agentId: "companion-test",
      initialize() { return { status: "ready" }; },
      info() {
        throw new Error("sqlite failed while opening C:/private/path/memory.db");
      },
    },
  });
  context.after(() => controller.close());
  const address = await controller.listen({ port: 0 });
  const response = await fetch(`${address.baseUrl}/v1/status`);
  const body = await json(response);
  assert.equal(response.status, 500);
  assert.deepEqual(body, {
    status: "error",
    error: {
      code: "INTERNAL_ERROR",
      message: "The server could not complete the request.",
    },
  });
  assert.doesNotMatch(JSON.stringify(body), /private\/path|sqlite failed/u);
});

test("server accepts the same portable config used by CLI and SDK", async (context) => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "suzu-memory.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    dataRoot: "./portable-data",
    agentId: "configured-companion",
    defaults: {
      ingestion: {
        maximumEventCharacters: 400_000,
        maximumBatchCharacters: 400_000,
      },
    },
    server: { host: "127.0.0.1", port: 0, maxBodyBytes: 2_000_000 },
  }), "utf8");
  const config = loadMemoryConfig(configPath);
  const controller = createMemoryHttpServer({
    service: createMemoryServiceFromConfig(config),
    maxBodyBytes: config.server.maxBodyBytes,
  });
  context.after(() => controller.close());
  const address = await controller.listen(config.server);
  const status = await json(await fetch(`${address.baseUrl}/v1/status`));
  assert.equal(status.data.agentId, "configured-companion");
  assert.equal(status.data.dataRoot, path.join(directory, "portable-data"));
  const largeEvent = {
    protocolVersion: 1,
    eventId: "configured-large-event",
    eventType: "conversation.turn",
    occurredAt: "2026-08-09T04:00:00.000Z",
    actor: { role: "user", id: "user" },
    content: { text: "中".repeat(400_000) },
  };
  const body = JSON.stringify({ event: largeEvent });
  assert.ok(Buffer.byteLength(body) > (1024 * 1024));
  const inserted = await json(await fetch(`${address.baseUrl}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }));
  assert.equal(inserted.data.inserted, 1);
});

test("HTTP search forwards an explicit world scope without forcing one for callers", async (context) => {
  const calls = [];
  const controller = createMemoryHttpServer({
    apiKey: "test-key",
    service: {
      agentId: "companion-test",
      initialize() { return { status: "ready" }; },
      async search(query, options) {
        calls.push({ query, options });
        return { status: "ready", candidates: [], fragments: [], context: "" };
      },
    },
  });
  context.after(() => controller.close());
  const address = await controller.listen({ port: 0 });
  const response = await json(await fetch(`${address.baseUrl}/v1/search`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: "科技馆里的机器人展",
      world: { id: "daily-life", frame: "physical" },
      allowCrossWorld: true,
      persistTrace: false,
    }),
  }));
  assert.equal(response.data.status, "ready");
  assert.deepEqual(calls, [{
    query: "科技馆里的机器人展",
    options: {
      now: undefined,
      anchors: undefined,
      anchorSelection: undefined,
      queryPerspective: undefined,
      world: { id: "daily-life", frame: "physical" },
      allowCrossWorld: true,
      options: undefined,
      persistTrace: false,
    },
  }]);
});

test("HTTP event endpoint is idempotent and exposes pending input without running a model", async (context) => {
  const service = createMemoryService({ dataRoot: temporaryDirectory(), agentId: "companion-test" });
  const controller = createMemoryHttpServer({ service });
  context.after(() => controller.close());
  const address = await controller.listen({ port: 0 });
  const event = {
    protocolVersion: 1,
    eventId: "http-event-1",
    eventType: "conversation.turn",
    occurredAt: "2026-08-04T04:00:00.000Z",
    actor: { role: "user", id: "user" },
    content: { text: "HTTP 入口只负责可靠写入。" },
  };
  const first = await json(await fetch(`${address.baseUrl}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ event }),
  }));
  assert.equal(first.data.inserted, 1);
  const replay = await json(await fetch(`${address.baseUrl}/v1/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: [event] }),
  }));
  assert.equal(replay.data.reused, 1);
  const pending = await json(await fetch(`${address.baseUrl}/v1/events?status=pending`));
  assert.equal(pending.data.total, 1);
  const maintenance = await json(await fetch(`${address.baseUrl}/v1/maintenance`));
  assert.equal(maintenance.data.pendingInputEvents, 1);
  const flushed = await json(await fetch(`${address.baseUrl}/v1/maintenance/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ lane: "semantic" }),
  }));
  assert.equal(flushed.data.semantic.inputBatches[0].status, "disabled");

  const backup = await json(await fetch(`${address.baseUrl}/v1/database/backups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ now: "2026-08-05T04:20:00.000Z" }),
  }));
  assert.equal(backup.data.status, "valid");
  assert.ok(fs.existsSync(backup.data.databasePath));

  const revised = await json(await fetch(
    `${address.baseUrl}/v1/events/${encodeURIComponent(event.eventId)}/revision`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "retract", reason: "HTTP revision test" }),
    },
  ));
  assert.equal(revised.data.revision.action, "retract");
  const retracted = await json(await fetch(
    `${address.baseUrl}/v1/events?status=pending&lifecycle=retracted`,
  ));
  assert.equal(retracted.data.total, 1);
});

test("HTTP event processing forwards lease settings and exposes explicit recovery", async (context) => {
  const calls = [];
  const service = {
    agentId: "companion-test",
    initialize() { return { status: "ready" }; },
    async processPendingEvents(options) {
      calls.push({ method: "process", options });
      return { status: "skipped" };
    },
    recoverProcessingEvents(options) {
      calls.push({ method: "recover", options });
      return { recovered: 1, batches: [] };
    },
  };
  const controller = createMemoryHttpServer({ service });
  context.after(() => controller.close());
  const address = await controller.listen({ port: 0 });
  const headers = { "content-type": "application/json" };

  await json(await fetch(`${address.baseUrl}/v1/input-batches/process`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      maximumEvents: 7,
      maximumContentCharacters: 32_000,
      candidateEventIds: ["input-1", "input-2"],
      leaseSeconds: 1234,
      now: "2026-08-05T03:00:00.000Z",
    }),
  }));
  await json(await fetch(`${address.baseUrl}/v1/input-batches/recover`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      batchId: "input-batch-test",
      force: true,
      now: "2026-08-05T03:30:00.000Z",
    }),
  }));

  assert.deepEqual(calls, [
    {
      method: "process",
      options: {
        maximumEvents: 7,
        maximumContentCharacters: 32_000,
        candidateEventIds: ["input-1", "input-2"],
        leaseSeconds: 1234,
        now: "2026-08-05T03:00:00.000Z",
      },
    },
    {
      method: "recover",
      options: {
        batchId: "input-batch-test",
        force: true,
        now: "2026-08-05T03:30:00.000Z",
      },
    },
  ]);
});
