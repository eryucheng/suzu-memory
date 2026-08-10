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
import { createMemoryHttpServer } from "@suzu-memory/server";

import {
  createEmbeddedMemoryClient,
  createHttpMemoryClient,
} from "../src/index.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-sdk-"));
}

test("SDK exposes the same product through embedded and HTTP clients", async (context) => {
  const embedded = createEmbeddedMemoryClient({
    dataRoot: temporaryDirectory(),
    agentId: "companion-test",
  });
  assert.equal(embedded.info().memoryCount, 0);

  const controller = createMemoryHttpServer({ service: embedded });
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

  const databaseForClaim = openMemoryDatabase(embedded.paths.databasePath);
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
  const database = openMemoryDatabase(embedded.paths.databasePath);
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
