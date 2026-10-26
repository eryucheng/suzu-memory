import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiCompatibleStructuredGenerator } from "../src/index.mjs";

function response(payload, { status = 200, headers = {} } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] || "" },
    text: async () => body,
    json: async () => payload,
  };
}

test('output truncation is a typed failure with usage and is not repeated as a transport retry', async () => {
  let calls = 0;
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://api.example.test/v1', model: 'fixture', apiKey: 'secret' },
    maxOutputTokens: 32768,
    fetchImpl: async (_url, options) => {
      calls++;
      assert.equal(JSON.parse(options.body).max_tokens, 32768);
      return response({ id: 'truncated', model: 'fixture', usage: { prompt_tokens: 20, completion_tokens: 32768 },
        choices: [{ finish_reason: 'length', message: { content: '{"memories":[' } }] });
    },
  });
  await assert.rejects(generate({ input: 'source' }), error => error.code === 'MAX_TOKENS'
    && error.usage.completion_tokens === 32768 && error.requestId === 'truncated'
    && error.diagnostics.maxOutputTokens === 32768);
  assert.equal(calls, 1);
});

test('a malformed completed output retains the provider usage for failure accounting', async () => {
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://api.example.test/v1', model: 'fixture', apiKey: 'secret' },
    fetchImpl: async () => response({ model: 'fixture', usage: { total_tokens: 42 },
      choices: [{ finish_reason: 'stop', message: { content: 'invalid json' } }] }),
  });
  await assert.rejects(generate({ input: 'source' }), error => error.usage.total_tokens === 42
    && error.model === 'fixture' && /有效 JSON/u.test(error.message));
});

test("OpenAI-compatible generator requests JSON and returns the shared generator envelope", async () => {
  let request = null;
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: {
      name: "DeepSeek",
      type: "openai-compatible",
      baseUrl: "https://api.example.test/v1",
      model: "deepseek-chat",
      apiKey: "secret",
      extraHeaders: { "X-Evaluation": "header-pass-through", Authorization: "must-not-override" },
      extraBody: {
        thinking: { type: "disabled" },
        model: "must-not-override",
      },
    },
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return response({
        id: "request-1",
        model: "deepseek-chat",
        choices: [{ message: { content: "```json\n{\"analyses\":[]}\n```" } }],
        usage: { prompt_tokens: 12, completion_tokens: 4 },
      });
    },
  });
  const result = await generate({
    input: "evidence",
    systemPrompt: "analyze",
    schemaName: "memory-goal-v1",
    schema: { type: "object", required: ["analyses"] },
  });
  assert.equal(request.url, "https://api.example.test/v1/chat/completions");
  assert.equal(request.options.headers.Authorization, "Bearer secret");
  assert.equal(request.options.headers["X-Evaluation"], "header-pass-through");
  assert.equal(request.body.model, "deepseek-chat");
  assert.deepEqual(request.body.thinking, { type: "disabled" });
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.match(request.body.messages[0].content, /JSON Schema/u);
  assert.deepEqual(result.output, { analyses: [] });
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 4 });
  assert.equal(result.model, "deepseek-chat");
  assert.equal(result.requestId, "request-1");
  assert.equal(result.metadata.provider, "DeepSeek");
  assert.equal(generate.supportsCombinedStateAnalysis, true);
  assert.equal(generate.supportsCombinedConsolidation, true);
});

test("DashScope saved base URL uses its OpenAI-compatible text endpoint", async () => {
  let requestedUrl = "";
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: {
      type: "dashscope",
      baseUrl: "https://dashscope.aliyuncs.com/api/v1",
      model: "fixture-qwen",
      key: "secret",
    },
    fetchImpl: async (url) => {
      requestedUrl = url;
      return response({ choices: [{ message: { content: "{\"analyses\":[]}" } }] });
    },
  });
  await generate({ input: "evidence", systemPrompt: "analyze" });
  assert.equal(requestedUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
});

test("strict tool mode sends the supplied schema to the configured endpoint and parses arguments", async () => {
  let request = null;
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: { analyses: { type: "array", items: { type: "string" } } },
    required: ["analyses"],
  };
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com",
      endpoint: "beta/chat/completions",
      model: "deepseek-v4-flash",
      apiKey: "secret",
      structuredOutputMode: "strict-tool",
      extraBody: { thinking: { type: "disabled" } },
    },
    fetchImpl: async (url, options) => {
      request = { url, body: JSON.parse(options.body) };
      return response({
        id: "strict-request-1",
        choices: [{
          message: {
            tool_calls: [{
              type: "function",
              function: {
                name: "memory-goal-v1",
                arguments: '{"analyses":[]}',
              },
            }],
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      });
    },
  });
  const result = await generate({
    input: "evidence",
    systemPrompt: "analyze",
    schemaName: "memory-goal-v1",
    schema,
  });
  assert.equal(request.url, "https://api.deepseek.com/beta/chat/completions");
  assert.equal(request.body.response_format, undefined);
  assert.deepEqual(request.body.thinking, { type: "disabled" });
  assert.equal(request.body.tools[0].function.name, "memory-goal-v1");
  assert.equal(request.body.tools[0].function.strict, true);
  assert.deepEqual(request.body.tools[0].function.parameters, schema);
  assert.deepEqual(request.body.tool_choice, {
    type: "function",
    function: { name: "memory-goal-v1" },
  });
  assert.deepEqual(result.output, { analyses: [] });
  assert.equal(result.metadata.responseFormat, "strict-tool");
});

test("strict tools expand conditional objects without requiring forbidden fields or mutating the owner schema", async () => {
  const schema = { type: 'object', additionalProperties: false, required: ['memories'], properties: {
    memories: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['family', 'content'],
      properties: { family: { type: 'string', enum: ['identity', 'event'] },
        content: { type: 'string', minLength: 1 }, target: { type: 'object', description: 'Conditional target.' } },
      anyOf: [
        { type: 'object', required: ['target'], properties: { family: { type: 'string', enum: ['identity'] },
          target: { type: 'object', additionalProperties: false, required: ['field'], properties: { field: { type: 'string' } } } } },
        { type: 'object', properties: { family: { type: 'string', enum: ['event'] }, target: false } },
      ],
    } },
  } };
  const original = structuredClone(schema);
  const requests = [];
  for (const structuredOutputMode of ['strict-tool', 'json-object']) {
    const generate = createOpenAiCompatibleStructuredGenerator({
      connection: { baseUrl: 'https://api.example.test', model: 'fixture', apiKey: 'secret', structuredOutputMode },
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return response({ choices: [{ message: { content: '{"memories":[]}', tool_calls: [{
          function: { name: 'conditional', arguments: '{"memories":[]}' },
        }] } }] });
      },
    });
    assert.deepEqual((await generate({ schema, schemaName: 'conditional' })).output, { memories: [] });
  }
  const [identity, event] = requests[0].tools[0].function.parameters.properties.memories.items.anyOf;
  assert.deepEqual(identity.properties.family.enum, ['identity']);
  assert.deepEqual(identity.required, ['family', 'content', 'target']);
  assert.deepEqual(identity.properties.target, { ...original.properties.memories.items.properties.target,
    additionalProperties: false, required: ['field'], properties: { field: { type: 'string' } } });
  assert.equal(identity.additionalProperties, false);
  assert.deepEqual(event.properties.family.enum, ['event']);
  assert.deepEqual(event.required, ['family', 'content']);
  assert.equal(Object.hasOwn(event.properties, 'target'), false);
  assert.equal(event.additionalProperties, false);
  assert.deepEqual(event.properties.content, { type: 'string', minLength: 1 });
  assert.ok(requests[1].messages[0].content.includes(JSON.stringify(original)));
  assert.deepEqual(schema, original);
});

test("strict conditional expansion rejects conflicting constraints before contacting a provider", async () => {
  let calls = 0;
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: { baseUrl: 'https://api.example.test', model: 'fixture', apiKey: 'secret', structuredOutputMode: 'strict-tool' },
    fetchImpl: async () => { calls += 1; throw new Error('Unexpected HTTP request'); },
  });
  await assert.rejects(() => generate({ schema: {
    type: 'object', properties: { value: { type: 'string', minLength: 2 } }, required: ['value'],
    anyOf: [{ properties: { value: { type: 'string', minLength: 3 } } }],
  } }), /冲突约束：minLength/);
  assert.equal(calls, 0);
});

test("configured provider errors do not expose credentials and invalid JSON is rejected", async () => {
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: {
      baseUrl: "https://api.example.test",
      model: "fixture",
      apiKey: "do-not-leak",
      maximumTransportAttempts: 1,
    },
    fetchImpl: async () => response({ error: { message: "provider unavailable" } }, { status: 503 }),
  });
  await assert.rejects(
    () => generate({ input: "evidence", systemPrompt: "analyze" }),
    (error) => /503.*provider unavailable/u.test(error.message) && !error.message.includes("do-not-leak"),
  );

  const invalid = createOpenAiCompatibleStructuredGenerator({
    connection: {
      baseUrl: "https://api.example.test",
      model: "fixture",
      apiKey: "secret",
    },
    fetchImpl: async () => response({ choices: [{ message: { content: "not-json" } }] }),
  });
  await assert.rejects(
    () => invalid({ input: "evidence", systemPrompt: "analyze" }),
    /不是有效 JSON/u,
  );
});

test("retries a broken HTTP response envelope without exposing its body", async () => {
  let calls = 0;
  const generate = createOpenAiCompatibleStructuredGenerator({
    connection: {
      baseUrl: "https://api.example.test",
      model: "fixture",
      apiKey: "secret",
      maximumTransportAttempts: 3,
      transportRetryDelayMs: 0,
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) {
        return response("private upstream proxy body", {
          headers: { "content-type": "text/html", "x-request-id": `broken-${calls}` },
        });
      }
      return response({
        id: "recovered-request",
        choices: [{ message: { content: '{"analyses":[]}' } }],
      });
    },
  });
  const result = await generate({ input: "evidence", systemPrompt: "analyze" });
  assert.equal(calls, 3);
  assert.equal(result.requestId, "recovered-request");
  assert.equal(result.metadata.transportAttempts, 3);

  const alwaysBroken = createOpenAiCompatibleStructuredGenerator({
    connection: {
      baseUrl: "https://api.example.test",
      model: "fixture",
      apiKey: "secret",
      maximumTransportAttempts: 2,
      transportRetryDelayMs: 0,
    },
    fetchImpl: async () => response("private upstream proxy body", {
      headers: { "content-type": "text/html", "x-request-id": "broken-final" },
    }),
  });
  await assert.rejects(
    () => alwaysBroken({ input: "evidence", systemPrompt: "analyze" }),
    (error) => error.code === "MEMORY_PROVIDER_TRANSPORT_EXHAUSTED"
      && error.transportAttempts === 2
      && error.maximumTransportAttempts === 2
      && error.diagnostics.kind === "invalid-response-envelope"
      && /attempt=2\/2/u.test(error.message)
      && /contentType=text\/html/u.test(error.message)
      && /requestId=broken-final/u.test(error.message)
      && !error.message.includes("private upstream proxy body"),
  );
});
