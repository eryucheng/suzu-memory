import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readUsageEvents } from "@suzu-memory/usage-ledger";
import { openMemoryDatabase } from "@suzu-memory/core";

import { runMemoryEvaluationCli } from "../src/index.mjs";

test("CLI enables the bound embedding route only when explicitly requested and reports its cost", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-evaluation-cli-"));
  const databasePath = path.join(root, "memory.db");
  const casesPath = path.join(root, "cases.json");
  const dataRoot = path.join(root, "data");
  openMemoryDatabase(databasePath).close();
  fs.writeFileSync(casesPath, JSON.stringify({
    version: 1,
    cases: [{
      id: "no-match-with-vector",
      query: "完全不存在的回忆",
      expect: { status: "no-match", emptyContext: true },
    }],
  }), "utf8");

  let resolvedKind = "";
  let providerOptions = null;
  let output = "";
  const report = await runMemoryEvaluationCli({
    args: [
      "--database", databasePath,
      "--agent", "agent-evaluation",
      "--cases", casesPath,
      "--data-root", dataRoot,
      "--with-embedding",
    ],
    stdout: { write: (value) => { output += value; } },
    environment: {},
    connectionResolver: async ({ kind }) => {
      resolvedKind = kind;
      return {
        type: "dashscope",
        provider: "阿里云百炼",
        baseUrl: "https://dashscope.aliyuncs.com/api/v1",
        model: "text-embedding-v4",
        key: "test-secret-key",
      };
    },
    embeddingProviderFactory: (options) => {
      providerOptions = options;
      const provider = async () => ({
        vector: Float32Array.from([1, 0, 0]),
        model: "text-embedding-v4",
        usage: { prompt_tokens: 2000, total_tokens: 2000 },
        requestId: "request-cli-vector",
        metadata: { provider: "stub" },
      });
      provider.model = options.model;
      provider.dimensions = options.dimensions;
      return provider;
    },
  });

  assert.equal(resolvedKind, "memory-embedding");
  assert.equal(providerOptions.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(providerOptions.model, "text-embedding-v4");
  assert.equal(providerOptions.dimensions, 1024);
  assert.equal(report.summary.externalUsage.requestCount, 1);
  assert.equal(report.summary.externalUsage.amountCny, 0.001);
  assert.equal(output.includes("test-secret-key"), false);

  const ledgerPath = path.join(
    dataRoot,
    "agents",
    "agent-evaluation",
    "cost-ledger",
    "events.jsonl",
  );
  const ledger = await readUsageEvents(ledgerPath);
  assert.equal(ledger.events.length, 1);
  assert.equal(ledger.events[0].feature, "memory-retrieval-embedding");
  assert.equal(ledger.events[0].model, "text-embedding-v4");

  const offlineReport = await runMemoryEvaluationCli({
    args: [
      "--database", databasePath,
      "--agent", "agent-evaluation",
      "--cases", casesPath,
      "--data-root", dataRoot,
    ],
    stdout: { write: () => {} },
    environment: {},
    connectionResolver: async () => {
      throw new Error("离线评测不应解析 API 连接。");
    },
    embeddingProviderFactory: () => {
      throw new Error("离线评测不应创建 Embedding Provider。");
    },
  });
  assert.equal(offlineReport.summary.externalUsage.requestCount, 0);
  assert.equal((await readUsageEvents(ledgerPath)).events.length, 1);
});
