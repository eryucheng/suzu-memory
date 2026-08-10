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
