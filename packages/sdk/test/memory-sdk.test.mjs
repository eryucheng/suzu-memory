import { createTestDirectory, closeAfterTests } from '../../../test/support/suite-resources.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { once } from "node:events";
import net from "node:net";
import { createChatHostMemoryAdapter } from "../../host-adapter/src/index.mjs";

import {
  MemoryRepository,
  openMemoryDatabase,
  proposeMemoryStructure,
} from "@suzu-memory/core";
import { createMemoryHttpServer } from "@suzu-memory/server";

import {
  createEmbeddedMemoryClient,
  createHttpMemoryClient,
} from "../src/index.mjs";

function temporaryDirectory() {
  return createTestDirectory(path.join(os.tmpdir(), "suzu-memory-sdk-"));
}

test("SDK exposes the same product through embedded and HTTP clients", async (context) => {
  const embedded = closeAfterTests(createEmbeddedMemoryClient({
    dataRoot: temporaryDirectory(),
    agentId: "companion-test",
  }));
  assert.equal(embedded.info().memoryCount, 0);

  const controller = closeAfterTests(createMemoryHttpServer({ service: embedded }));
  context.after(() => controller.close());
  const address = await controller.listen({ port: 0 });
  const client = createHttpMemoryClient({ baseUrl: address.baseUrl });
  assert.equal((await client.health()).service, "suzu-memory");
  assert.equal((await client.status()).agentId, "companion-test");
  assert.equal((await client.listMemories()).total, 0);
  const backup = await client.backupDatabase({ now: "2026-08-05T04:30:00.000Z" });
  assert.equal(backup.status, "valid");
  assert.ok(fs.existsSync(backup.databasePath));
  await client.appendEvent({
    protocolVersion: 1,
    eventId: "sdk-event-1",
    eventType: "conversation.turn",
    occurredAt: "2026-08-04T05:00:00.000Z",
    actor: { role: "user", id: "user" },
    content: { text: "SDK 和 HTTP 使用同一事件协议。" },
  });
  assert.equal((await client.listInputEvents({ statuses: ["pending"] })).total, 1);

  const databaseForClaim = closeAfterTests(openMemoryDatabase(embedded.paths.databasePath));
  try {
    const repository = new MemoryRepository(databaseForClaim);
    const claimed = repository.claimPendingInputEvents(embedded.agentId, {
      maximumEvents: 1,
      leaseSeconds: 1800,
      createdAt: "2026-08-04T05:01:00.000Z",
    });
    assert.ok(claimed.batch);
  } finally {
    databaseForClaim.close();
  }
  const recovered = await client.recoverProcessingEvents({
    force: true,
    now: "2026-08-04T05:02:00.000Z",
  });
  assert.equal(recovered.recovered, 1);
  assert.equal((await client.listInputEvents({ statuses: ["pending"] })).total, 1);

  let proposalId = "";
  const database = closeAfterTests(openMemoryDatabase(embedded.paths.databasePath));
  try {
    const repository = new MemoryRepository(database);
    for (const [id, content] of [["sdk-a", "第一件事。"], ["sdk-b", "第二件事。"]]) {
      repository.upsertMemory({
        id,
        agentId: embedded.agentId,
        kind: "event",
        layer: "episodic",
        content,
      });
    }
    for (const [id, kind] of [["sdk-archived-event", "event"], ["sdk-archived-fact", "fact"]]) {
      repository.upsertMemory({ id, agentId: embedded.agentId, kind, layer: "episodic",
        content: "已归档的 SDK 筛选记录。", status: "archived" });
    }
    proposalId = proposeMemoryStructure(repository, {
      agentId: embedded.agentId,
      kind: "topic",
      content: "SDK 测试主题。",
      memberIds: ["sdk-a", "sdk-b"],
    }).id;
  } finally {
    database.close();
  }
  const retrieved = await client.search("第一件事", {
    now: "2026-08-05T05:00:00.000Z",
  });
  assert.equal(retrieved.status, "ready");
  const filtered = await client.listMemories({ statuses: ["archived"], kinds: ["event"] });
  assert.deepEqual(filtered.items.map(memory => memory.id), ["sdk-archived-event"]);
  const missed = await client.search("unmatched-quartz-z7", { now: "2026-08-05T05:00:00.000Z" });
  assert.equal(missed.status, "no-match");
  const traces = await client.listRetrievalTraces({ resultStatus: "no-match" });
  assert.deepEqual(traces.map(trace => trace.id), [missed.trace.id]);
  const feedback = await client.recordRetrievalFeedback(retrieved.trace.id, {
    signal: "used", targetMemoryIds: ["sdk-a"],
  });
  assert.equal(feedback.signal, "used", "Feedback signal is business data, not an AbortSignal.");
  const recall = { now: "2026-08-05T05:00:00.000Z", persistTrace: false, reactivate: true, activationId: "sdk-stable-recall",
    options: { recallReactivation: { enabled: true, configurationVersion: "sdk-recall-v1",
      activationGain: 0.025, maximumActivation: 0.35, scaleDays: 10,
      decayExponent: 0.5, maximumScoreAdjustment: 0.03 } } };
  const activated = await client.search("第一件事", recall);
  assert.equal(activated.trace.persisted, false);
  assert.ok(activated.trace.reactivation.applied > 0);
  assert.equal((await client.search("第一件事", recall)).trace.reactivation.applied, 0,
    "The same activationId must not apply recall activation twice.");
  assert.equal((await client.setRetrievalSessionHead({
    sessionId: "sdk-runtime-session",
    traceId: retrieved.trace.id,
    now: "2026-08-05T05:00:01.000Z",
  })).trace_id, retrieved.trace.id);
  assert.equal((await client.bindRetrievalUsageResponse({
    sessionId: "sdk-runtime-session",
    responseText: "第一件事已经被记住了。",
    now: "2026-08-05T05:00:02.000Z",
  })).status, "pending");
  assert.equal((await client.bindRewardObservation({
    sessionId: "sdk-runtime-session",
    feedbackText: "对，就是第一件事。",
    now: "2026-08-05T05:00:03.000Z",
  })).status, "pending");
  assert.equal((await client.listHighLevelProposals()).items[0].id, proposalId);
  assert.equal((await client.reviewConsoleOverview()).reviews.items[0].id, proposalId);
  assert.equal((await client.getReviewConsoleProposal("structure", proposalId)).members.length, 2);
  assert.equal((await client.getHighLevelProposal("structure", proposalId)).type, "structure");
  assert.equal((await client.resolveHighLevelProposal("structure", proposalId, {
    action: "dismiss",
  })).resolution.status, "dismissed");
});

async function assertPortReleased(port) {
  const probe = net.createServer();
  try { await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); }); }
  finally { if (probe.listening) await new Promise(resolve => probe.close(resolve)); }
}

test("cancelling an HTTP SDK search cancels its service operation", { timeout: 5000 }, async context => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const controller = createMemoryHttpServer({ service: {
    agentId: "sdk-cancel", initialize() {},
    search(_query, { signal }) {
      entered(signal);
      return new Promise((resolve, reject) => {
        release = () => resolve({ status: "no-match" });
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  } });
  const address = await controller.listen({ port: 0 });
  context.diagnostic("HTTP cancellation check PID=" + process.pid + " port=" + address.port);
  const cancel = new AbortController();
  const pending = createHttpMemoryClient({ baseUrl: address.baseUrl }).search("cancel this search", { signal: cancel.signal });
  pending.catch(() => {});
  try {
    const serviceSignal = await started;
    assert.equal(typeof serviceSignal?.throwIfAborted, "function");
    const stopped = once(serviceSignal, "abort", { signal: AbortSignal.timeout(2000) });
    cancel.abort(new DOMException("Caller cancelled.", "AbortError"));
    await stopped;
    await assert.rejects(pending, { name: "AbortError" });
    assert.equal(serviceSignal.aborted, true);
  } finally {
    release?.(); await Promise.allSettled([pending]); await controller.close();
    await assertPortReleased(address.port);
  }
});

test("host idle and session-end windows retain host, session and flush through the HTTP SDK", async context => {
  const memory = closeAfterTests(createEmbeddedMemoryClient({ dataRoot: temporaryDirectory(), agentId: "sdk-window" }));
  const windows = [];
  memory.runMaintenance = async options => { windows.push(options.chunkPolicy); return { status: "completed" }; };
  const controller = createMemoryHttpServer({ service: memory });
  const address = await controller.listen({ port: 0 });
  context.diagnostic("HTTP window check PID=" + process.pid + " port=" + address.port);
  const identity = { spaceId: "sdk-window", primaryUserId: "user", companionId: "sdk-window" };
  try {
    for (const client of [memory, createHttpMemoryClient({ baseUrl: address.baseUrl })]) {
      const adapter = createChatHostMemoryAdapter({ memory: client, hostId: "sdk-host", identity });
      await adapter.onIdle({ sessionId: "selected-session" });
      await adapter.onSessionEnd({ sessionId: "selected-session" });
    }
    assert.equal(windows.length, 4);
    for (const [index, window] of windows.entries()) {
      assert.ok(window && typeof window === "object", "Every maintenance call retains a chunk policy.");
      assert.equal(window.hostId, "sdk-host");
      assert.equal(window.sessionId, "selected-session");
      assert.equal(window.flush, index % 2 === 1);
    }
    for (const field of ["hostId", "sessionId", "flush", "maximumCoreCharacters", "maximumCoreMessages",
      "maximumContextCharacters", "maximumRequestCharacters"]) {
      assert.equal(windows[2][field], windows[0][field], field);
      assert.equal(windows[3][field], windows[1][field], field);
    }
  } finally { await controller.close(); await assertPortReleased(address.port); }
});
