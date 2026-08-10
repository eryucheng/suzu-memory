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
import { createMemoryService } from "@suzu-memory/service";

import { runMemoryCli } from "../src/index.mjs";
import { runMemoryWorker } from "../src/worker.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-cli-"));
}

function outputSink() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    json() { return JSON.parse(value); },
  };
}

test("CLI initializes and inspects one explicit Agent scope", async () => {
  const dataRoot = temporaryDirectory();
  const output = outputSink();
  await runMemoryCli({
    args: ["init", "--data-root", dataRoot, "--agent-id", "companion-test"],
    stdout: output.stream,
  });
  const envelope = output.json();
  assert.equal(envelope.status, "success");
  assert.equal(envelope.command, "init");
  assert.equal(envelope.data.agentId, "companion-test");
  assert.equal(envelope.data.memoryCount, 0);
});

test("CLI help lists every supported review queue", async () => {
  const output = outputSink();
  await runMemoryCli({ args: ["help"], stdout: output.stream });
  assert.match(output.json().data.usage, /reported-state,structure,relation,ingestion,maintenance-failure/u);
  assert.match(output.json().data.usage, /worker/u);
});

test("CLI worker runs one explicit maintenance cycle by default", async () => {
  const output = outputSink();
  const calls = [];
  await runMemoryCli({
    args: ["worker", "--agent-id", "worker-test", "--data-root", temporaryDirectory()],
    stdout: output.stream,
    serviceFactory: () => ({
      async runMaintenance(options) {
        calls.push(options);
        return { status: "completed", lane: options.lane };
      },
    }),
  });
  const envelope = output.json();
  assert.equal(envelope.data.mode, "once");
  assert.equal(envelope.data.cycles.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].processInputEvents, true);
});

test("worker propagates completed-with-failures instead of reporting a healthy cycle", async () => {
  const report = await runMemoryWorker({
    service: {
      async runMaintenance() {
        return {
          status: "completed-with-failures",
          lane: "all",
          failures: [{ stage: "semantic", code: "TEMPORARY_PROVIDER_FAILURE" }],
        };
      },
    },
  });
  assert.equal(report.status, "completed-with-failures");
  assert.equal(report.cycles.length, 1);
  assert.equal(report.cycles[0].result.status, "completed-with-failures");
});

test("CLI loads portable Agent scope from a config file", async () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "suzu-memory.json");
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    dataRoot: "./portable-data",
    agentId: "configured-companion",
  }), "utf8");
  const output = outputSink();
  await runMemoryCli({
    args: ["status", "--config", configPath],
    stdout: output.stream,
  });
  const envelope = output.json();
  assert.equal(envelope.status, "success");
  assert.equal(envelope.data.agentId, "configured-companion");
  assert.equal(envelope.data.dataRoot, path.join(directory, "portable-data"));
});

test("CLI search, edit, delete and restore all reuse the shared Service", async () => {
  const dataRoot = temporaryDirectory();
  const service = createMemoryService({ dataRoot, agentId: "companion-test" });
  service.initialize();
  const database = openMemoryDatabase(service.paths.databasePath);
  try {
    new MemoryRepository(database).upsertMemory({
      id: "event-walk",
      agentId: service.agentId,
      kind: "event",
      layer: "long_term",
      title: "一起散步",
      content: "用户和陪伴者周日晚上一起在河边散步。",
      subjectRole: "shared",
      subjectKey: "relationship:test",
      reality: "real",
      evidenceMode: "explicit",
      eventDate: "2026-08-02",
      recordedAt: "2026-08-02T14:00:00.000Z",
      status: "active",
    });
  } finally {
    database.close();
  }

  const base = ["--data-root", dataRoot, "--agent-id", "companion-test"];
  const searchOutput = outputSink();
  await runMemoryCli({
    args: ["search", "记得周日一起散步吗", ...base],
    stdout: searchOutput.stream,
  });
  assert.equal(searchOutput.json().data.fragments[0].memoryId, "event-walk");

  const editOutput = outputSink();
  await runMemoryCli({
    args: ["edit", "event-walk", "--title", "周日晚上的散步", ...base],
    stdout: editOutput.stream,
  });
  assert.equal(editOutput.json().data.title, "周日晚上的散步");

  await runMemoryCli({ args: ["delete", "event-walk", ...base], stdout: outputSink().stream });
  assert.equal(service.listMemories().total, 0);
  await runMemoryCli({ args: ["restore", "event-walk", ...base], stdout: outputSink().stream });
  assert.equal(service.listMemories().total, 1);
});

test("CLI ingests portable JSON events and lists the pending log", async () => {
  const dataRoot = temporaryDirectory();
  const directory = temporaryDirectory();
  const eventsPath = path.join(directory, "events.json");
  fs.writeFileSync(eventsPath, JSON.stringify([{
    protocolVersion: 1,
    eventId: "cli-event-1",
    eventType: "conversation.turn",
    occurredAt: "2026-08-04T06:00:00.000Z",
    actor: { role: "user", id: "user" },
    content: { text: "命令行可以导入标准事件文件。" },
  }]), "utf8");
  const base = ["--data-root", dataRoot, "--agent-id", "companion-test"];
  const ingestOutput = outputSink();
  await runMemoryCli({
    args: ["ingest", eventsPath, ...base],
    stdout: ingestOutput.stream,
  });
  assert.equal(ingestOutput.json().data.inserted, 1);
  const eventsOutput = outputSink();
  await runMemoryCli({ args: ["events", ...base], stdout: eventsOutput.stream });
  assert.equal(eventsOutput.json().data.total, 1);
  const maintenanceOutput = outputSink();
  await runMemoryCli({
    args: ["maintenance-status", ...base],
    stdout: maintenanceOutput.stream,
  });
  assert.equal(maintenanceOutput.json().data.pendingInputEvents, 1);
  const revisionOutput = outputSink();
  await runMemoryCli({
    args: [
      "revise-event",
      "cli-event-1",
      "--action",
      "retract",
      "--reason",
      "CLI revision test",
      ...base,
    ],
    stdout: revisionOutput.stream,
  });
  assert.equal(revisionOutput.json().data.revision.action, "retract");
  const inactiveOutput = outputSink();
  await runMemoryCli({
    args: ["events", "--lifecycle", "retracted", ...base],
    stdout: inactiveOutput.stream,
  });
  assert.equal(inactiveOutput.json().data.total, 1);
});

test("CLI can explicitly recover an interrupted processing batch", async () => {
  const dataRoot = temporaryDirectory();
  const service = createMemoryService({ dataRoot, agentId: "companion-test" });
  service.appendEvent({
    protocolVersion: 1,
    eventId: "interrupted-event",
    eventType: "conversation.turn",
    occurredAt: "2026-08-04T06:00:00.000Z",
    actor: { role: "user", id: "user" },
    content: { text: "这条事件模拟处理中断。" },
  });
  service.withRepository((repository) => repository.claimPendingInputEvents(service.agentId, {
    workerId: "dead-worker",
    leaseSeconds: 1800,
  }));
  const output = outputSink();
  await runMemoryCli({
    args: [
      "recover-events",
      "--force",
      "--data-root",
      dataRoot,
      "--agent-id",
      "companion-test",
    ],
    stdout: output.stream,
  });
  assert.equal(output.json().data.recovered, 1);
  assert.equal(service.listInputEvents({ statuses: ["pending"] }).total, 1);
});

test("CLI backs up, inspects and restores one offline Agent database", async () => {
  const dataRoot = temporaryDirectory();
  const service = createMemoryService({ dataRoot, agentId: "companion-test" });
  service.initialize();
  const database = openMemoryDatabase(service.paths.databasePath);
  try {
    new MemoryRepository(database).upsertMemory({
      id: "backup-event",
      agentId: service.agentId,
      kind: "event",
      layer: "long_term",
      content: "备份前的内容。",
    });
  } finally {
    database.close();
  }
  const backupPath = path.join(temporaryDirectory(), "portable.db");
  const base = ["--data-root", dataRoot, "--agent-id", "companion-test"];
  await runMemoryCli({
    args: ["backup-database", backupPath, ...base],
    stdout: outputSink().stream,
  });
  const inspection = outputSink();
  await runMemoryCli({
    args: ["inspect-backup", backupPath, ...base],
    stdout: inspection.stream,
  });
  assert.equal(inspection.json().data.status, "valid");
  service.editMemory("backup-event", { content: "恢复前的修改。" });
  await runMemoryCli({
    args: [
      "restore-database",
      backupPath,
      "--confirm-agent",
      "companion-test",
      ...base,
    ],
    stdout: outputSink().stream,
  });
  assert.equal(service.getMemory("backup-event").memory.content, "备份前的内容。");
});

test("CLI lists and resolves high-level reviews through the shared Service", async () => {
  const dataRoot = temporaryDirectory();
  const service = createMemoryService({ dataRoot, agentId: "companion-test" });
  service.initialize();
  const proposal = service.withRepository((repository) => {
    for (const id of ["review-a", "review-b"]) {
      repository.upsertMemory({
        id,
        agentId: service.agentId,
        kind: "event",
        layer: "episodic",
        content: `候选事件 ${id}。`,
      });
    }
    return proposeMemoryStructure(repository, {
      agentId: service.agentId,
      kind: "topic",
      content: "命令行审阅主题。",
      memberIds: ["review-a", "review-b"],
    });
  });
  const base = ["--data-root", dataRoot, "--agent-id", "companion-test"];
  const listOutput = outputSink();
  await runMemoryCli({ args: ["reviews", ...base], stdout: listOutput.stream });
  assert.equal(listOutput.json().data.items[0].id, proposal.id);
  const resolveOutput = outputSink();
  await runMemoryCli({
    args: ["resolve", "structure", proposal.id, "--action", "dismiss", ...base],
    stdout: resolveOutput.stream,
  });
  assert.equal(resolveOutput.json().data.resolution.status, "dismissed");
});
