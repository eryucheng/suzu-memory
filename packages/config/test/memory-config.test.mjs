import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createMemoryServiceFromConfig,
  createProvidersFromMemoryConfig,
  loadMemoryConfig,
  normalizeMemoryConfig,
} from "../src/index.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-config-"));
}

test("config resolves portable paths relative to its own file", () => {
  const directory = temporaryDirectory();
  const configPath = path.join(directory, "memory.json");
  fs.writeFileSync(configPath, `\uFEFF${JSON.stringify({
    version: 1,
    dataRoot: "./data",
    agentId: "companion-test",
  })}`, "utf8");
  const config = loadMemoryConfig(configPath);
  assert.equal(config.dataRoot, path.join(directory, "data"));
  assert.equal(config.agentId, "companion-test");
  assert.equal(config.sourcePath, configPath);
  assert.deepEqual(config.defaults.ingestion, {
    maximumEventCharacters: 12_000,
    maximumBatchCharacters: 48_000,
    leaseSeconds: 1800,
  });
});

test("config validates and exposes ingestion safety budgets", () => {
  const config = normalizeMemoryConfig({
    version: 1,
    agentId: "companion-test",
    defaults: {
      ingestion: {
        maximumEventCharacters: 8_000,
        maximumBatchCharacters: 32_000,
        leaseSeconds: 900,
      },
    },
  });
  assert.deepEqual(config.defaults.ingestion, {
    maximumEventCharacters: 8_000,
    maximumBatchCharacters: 32_000,
    leaseSeconds: 900,
  });
  assert.equal(config.server.maxBodyBytes, 1024 * 1024);
  const largeEventConfig = normalizeMemoryConfig({
    version: 1,
    agentId: "companion-test",
    defaults: {
      ingestion: {
        maximumEventCharacters: 400_000,
        maximumBatchCharacters: 400_000,
      },
    },
  });
  assert.ok(largeEventConfig.server.maxBodyBytes > (400_000 * 4));
  const customHttpLimit = normalizeMemoryConfig({
    version: 1,
    agentId: "companion-test",
    server: { maxBodyBytes: 2_000_000 },
  });
  assert.equal(customHttpLimit.server.maxBodyBytes, 2_000_000);
  assert.throws(
    () => normalizeMemoryConfig({
      version: 1,
      agentId: "companion-test",
      defaults: { ingestion: { maximumBatchCharacters: 100 } },
    }),
    /maximumBatchCharacters/u,
  );
  assert.throws(
    () => normalizeMemoryConfig({
      version: 1,
      agentId: "companion-test",
      defaults: {
        ingestion: {
          maximumEventCharacters: 50_000,
          maximumBatchCharacters: 40_000,
        },
      },
    }),
    /cannot exceed/u,
  );
  assert.throws(
    () => normalizeMemoryConfig({
      version: 1,
      agentId: "companion-test",
      server: { maxBodyBytes: 1023 },
    }),
    /server\.maxBodyBytes/u,
  );
});

test("config reuses existing OpenAI-compatible generation and embedding providers", async () => {
  const config = normalizeMemoryConfig({
    version: 1,
    agentId: "companion-test",
    providers: {
      generation: {
        baseUrl: "https://example.test/v1",
        model: "test-chat",
        apiKeyEnv: "TEST_API_KEY",
      },
      embedding: {
        baseUrl: "https://example.test/v1",
        model: "test-embedding",
        apiKeyEnv: "TEST_API_KEY",
        dimensions: 3,
      },
    },
  });
  assert.equal(config.providers.intervention, config.providers.generation);
  const requests = [];
  const providers = createProvidersFromMemoryConfig(config, {
    environment: { TEST_API_KEY: "secret" },
    fetchImpl: async (url, request) => {
      requests.push({ url, request });
      if (String(url).endsWith("/embeddings")) {
        return new Response(JSON.stringify({
          model: "test-embedding",
          data: [{ index: 0, embedding: [1, 0, 0] }],
          usage: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        id: "request-1",
        model: "test-chat",
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(providers.generator.supportsCombinedStateAnalysis, true);
  assert.equal(providers.generator.supportsCombinedConsolidation, true);
  assert.equal(providers.interventionGenerator, providers.generator);
  const generated = await providers.generator({ input: "test", systemPrompt: "test", schema: {} });
  assert.deepEqual(generated.output, { ok: true });
  const embedded = await providers.embedding("test");
  assert.deepEqual([...embedded.vector], [1, 0, 0]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((item) => item.request.headers.Authorization === "Bearer secret"));
});

test("config validates and preserves strict structured output mode", () => {
  const config = normalizeMemoryConfig({
    version: 1,
    agentId: "companion-test",
    providers: {
      generation: {
        baseUrl: "https://api.deepseek.com",
        endpoint: "beta/chat/completions",
        model: "deepseek-v4-flash",
        apiKey: "secret",
        structuredOutputMode: "strict-tool",
        maximumTransportAttempts: 4,
        transportRetryDelayMs: 750,
      },
    },
  });
  assert.equal(config.providers.generation.endpoint, "beta/chat/completions");
  assert.equal(config.providers.generation.structuredOutputMode, "strict-tool");
  assert.equal(config.providers.generation.maximumTransportAttempts, 4);
  assert.equal(config.providers.generation.transportRetryDelayMs, 750);
  assert.throws(
    () => normalizeMemoryConfig({
      version: 1,
      agentId: "companion-test",
      providers: {
        generation: {
          baseUrl: "https://example.test/v1",
          model: "test-chat",
          structuredOutputMode: "schema-maybe",
        },
      },
    }),
    /structuredOutputMode is not supported/u,
  );
});

test("config can use a dedicated small intervention model", async () => {
  const config = normalizeMemoryConfig({
    version: 1,
    agentId: "companion-test",
    providers: {
      generation: {
        baseUrl: "https://generation.example.test/v1",
        model: "large-memory-model",
        apiKey: "generation-secret",
      },
      intervention: {
        baseUrl: "https://policy.example.test/v1",
        model: "small-policy-model",
        apiKeyEnv: "POLICY_API_KEY",
      },
    },
  });
  assert.equal(config.providers.intervention.model, "small-policy-model");
  assert.equal(config.providers.intervention.timeoutMs, 30_000);
  assert.equal(config.providers.intervention.maxOutputTokens, 512);
  const requests = [];
  const providers = createProvidersFromMemoryConfig(config, {
    environment: { POLICY_API_KEY: "policy-secret" },
    fetchImpl: async (url, request) => {
      requests.push({ url: String(url), body: JSON.parse(request.body) });
      return new Response(JSON.stringify({
        model: "small-policy-model",
        choices: [{ message: { content: '{"action":"skip"}' } }],
        usage: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await providers.interventionGenerator({
    input: "test",
    systemPrompt: "test",
    schema: {},
  });
  assert.deepEqual(requests, [{
    url: "https://policy.example.test/v1/chat/completions",
    body: {
      model: "small-policy-model",
      messages: [
        {
          role: "system",
          content: "test\n\n只输出一个 JSON 对象，不要输出 Markdown 或解释。输出必须符合这个 JSON Schema：\n{}",
        },
        { role: "user", content: "test" },
      ],
      temperature: 0,
      max_tokens: 512,
      response_format: { type: "json_object" },
    },
  }]);
});

test("config accepts DashScope and routes generation and embeddings through compatible mode", async () => {
  const config = normalizeMemoryConfig({
    version: 1,
    agentId: "companion-test",
    providers: {
      generation: {
        type: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/api/v1",
        model: "test-chat",
        apiKey: "secret",
      },
      embedding: {
        type: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/api/v1",
        model: "test-embedding",
        apiKey: "secret",
        dimensions: 3,
      },
    },
  });
  const urls = [];
  const providers = createProvidersFromMemoryConfig(config, {
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).endsWith("/embeddings")) {
        return new Response(JSON.stringify({
          model: "test-embedding",
          data: [{ index: 0, embedding: [1, 0, 0] }],
          usage: {},
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        model: "test-chat",
        choices: [{ message: { content: '{"ok":true}' } }],
        usage: {},
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  await providers.generator({ input: "test", systemPrompt: "test", schema: {} });
  await providers.embedding("test");
  assert.deepEqual(urls, [
    "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    "https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings",
  ]);
});

test("configured service can initialize without configuring optional providers", () => {
  const service = createMemoryServiceFromConfig({
    version: 1,
    dataRoot: temporaryDirectory(),
    agentId: "companion-test",
  });
  assert.equal(service.info().agentId, "companion-test");
});

test("configured service does not require provider secrets for local inspection", () => {
  const service = createMemoryServiceFromConfig({
    version: 1,
    dataRoot: temporaryDirectory(),
    agentId: "companion-test",
    providers: {
      generation: {
        baseUrl: "https://example.test/v1",
        model: "test-chat",
        apiKeyEnv: "MISSING_API_KEY",
      },
    },
  }, { environment: {} });
  assert.equal(service.info().status, "ready");
});
