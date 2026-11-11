import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOpenAiCompatibleStructuredGenerator } from '@suzu-memory/providers';
import { createChatHostMemoryAdapter } from '@suzu-memory/host-adapter';

import {
  createMemoryServiceFromConfig,
  createProvidersFromMemoryConfig,
  loadMemoryConfig,
  normalizeMemoryConfig,
  validateMemoryProviderConfig,
} from "../src/index.mjs";

function temporaryDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-config-"));
}

test('generation output defaults agree across config and direct providers while explicit budgets remain effective', async () => {
  const connection = { baseUrl: 'https://provider.test/v1', model: 'fixture', apiKey: 'fixture-key' };
  for (const maximum of [undefined, 2048]) {
    const expected = maximum ?? 32768;
    const config = normalizeMemoryConfig({ version: 1, agentId: 'agent-test', providers: {
      generation: { ...connection, ...(maximum === undefined ? {} : { maxOutputTokens: maximum }) },
      intervention: connection,
    } });
    assert.equal(config.providers.generation.maxOutputTokens, expected);
    assert.equal(config.providers.intervention.maxOutputTokens, 512);
    const requests = [];
    const fetchImpl = async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    };
    const configured = createProvidersFromMemoryConfig(config, { fetchImpl }).generator;
    const direct = createOpenAiCompatibleStructuredGenerator({ connection, fetchImpl,
      ...(maximum === undefined ? {} : { maxOutputTokens: maximum }) });
    for (const generator of [configured, direct]) assert.deepEqual((await generator({ input: 'evidence' })).output, { ok: true });
    assert.deepEqual(requests.map(request => request.max_tokens), [expected, expected]);
  }
});

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
    maximumCoreCharacters: 12_000, maximumCoreMessages: 100, maximumContextCharacters: 12_000, maximumRequestCharacters: 64_000,
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
    maximumCoreCharacters: 12_000, maximumCoreMessages: 100, maximumContextCharacters: 12_000, maximumRequestCharacters: 64_000,
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
  const controller = new AbortController();
  controller.abort();
  for (const embed of [text => providers.generator({ input: text, signal: controller.signal }),
    text => providers.interventionGenerator({ input: text, signal: controller.signal }),
    text => providers.embedding(text, { signal: controller.signal }),
    text => providers.embedding.embedMany([text], { signal: controller.signal })]) {
    await assert.rejects(embed('cancelled'), { name: 'AbortError' });
  }
  assert.equal(requests.length, 2, 'Cancelled requests must not contact the provider.');
});

test('configured extraction cancels its HTTP request without consuming the failure budget or losing its source', async t => {
  const root = temporaryDirectory();
  let started, requestSignal;
  const requests = [];
  const entered = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const service = createMemoryServiceFromConfig({ agentId: 'cancelled-extraction', dataRoot: root,
    defaults: { primaryUserId: 'u', userName: 'User', companionId: 'a', memoryOwner: 'Assistant' },
    providers: { generation: { baseUrl: 'https://provider.invalid', model: 'fixture', apiKey: 'fixture' } },
  }, { fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => {
    calls++;
    const respond = () => resolve(new Response(JSON.stringify({ choices: [{ message: { content: '{"memories":[]}' } }] })));
    requests.push({ signal, respond });
    if (calls === 1) requestSignal = signal;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    started();
  }) });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const host = createChatHostMemoryAdapter({ memory: service, hostId: 'config-test', identity: {
    spaceId: service.agentId, primaryUserId: 'u', primaryUserName: 'User', companionId: 'a', companionName: 'Assistant' } });
  await host.afterReply({ sessionId: 's', turnId: '1', userMessage: { text: 'I visited the museum.' } });
  const controller = new AbortController();
  const reason = new DOMException('Cancelled by user.', 'AbortError');
  const pending = service.processPendingEvents({ signal: controller.signal });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await entered;
  const independent = service.providers.generator({ input: 'An independent operation.' });
  controller.abort(reason);
  try {
    assert.equal(requestSignal.aborted, true);
    assert.equal(requests[1].signal.aborted, false, 'One operation must not cancel another operation using the same provider.');
  } finally { requests.forEach(request => request.respond()); }
  await rejected;
  assert.deepEqual((await independent).output, { memories: [] });
  assert.equal(calls, 2);
  const events = service.listInputEvents({ statuses: ['pending', 'processing'] }).items;
  assert.equal(events.length, 1);
  assert.equal(events[0].content.text, 'I visited the museum.');
  assert.equal(events[0].metadata.suzuMemoryProcessing?.failureHistory?.length || 0, 0);
  service.recoverProcessingEvents({ now: new Date(Date.now() + 3_600_000) });
  assert.equal(service.listInputEvents({ statuses: ['pending'] }).total, 1);
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

test('configured owner-only services preserve the absence of a primary human', async t => {
  const root = temporaryDirectory();
  const service = createMemoryServiceFromConfig({ agentId: 'owner-only', dataRoot: root,
    defaults: { memoryOwner: 'Suzu', primaryUserId: '', createPrimaryRelationship: false } });
  t.after(async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(service.defaults.createPrimaryRelationship, false);
  assert.equal(service.defaults.primaryUserId, '');
  assert.equal(service.defaults.userName, '');
  service.initialize();
  service.withRepository(repository => assert.deepEqual(repository.listRelationships('owner-only'), []));
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

test("instance identity and data overrides preserve configured engine settings and isolate explicit paths", async t => {
  const root = temporaryDirectory(), isolated = path.join(root, "sample");
  const service = createMemoryServiceFromConfig({ agentId: "original", dataRoot: root,
    databasePath: path.join(root, "production.db"), usageLedgerPath: path.join(root, "production.jsonl"),
    defaults: { relationshipLabel: "configured", ingestion: { maximumCoreCharacters: 2300 },
      retrieval: { timeZone: "America/Los_Angeles", maximumReturnedCandidates: 7 } },
  }, { overrides: { agentId: "sample", dataRoot: isolated, defaults: { memoryOwner: "Sample" } } });
  t.after(() => service.close());
  service.initialize();
  assert.equal(service.defaults.relationshipLabel, "configured");
  assert.equal(service.defaults.ingestion.maximumCoreCharacters, 2300);
  assert.equal(service.defaults.retrieval.maximumReturnedCandidates, 7);
  assert.equal(service.defaults.retrieval.timeZone, "America/Los_Angeles");
  assert.ok(service.paths.databasePath.startsWith(isolated + path.sep));
  assert.ok(service.paths.usageLedgerPath.startsWith(isolated + path.sep));
  assert.equal(fs.existsSync(path.join(root, "production.db")), false);
});

test("provider preflight validates credentials without contacting the configured endpoints", () => {
  const config = normalizeMemoryConfig({ agentId: "test", providers: {
    generation: { baseUrl: "https://model.invalid", model: "configured", apiKeyEnv: "REQUIRED_KEY" },
  } });
  assert.throws(() => validateMemoryProviderConfig(config, { environment: {}, requireGeneration: true }), /REQUIRED_KEY/);
  assert.deepEqual(validateMemoryProviderConfig(config, { environment: { REQUIRED_KEY: "fixture" }, requireGeneration: true }),
    { generation: true, embedding: false });
});
