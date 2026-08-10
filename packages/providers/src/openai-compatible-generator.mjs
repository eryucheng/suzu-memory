import {
  normalizeOpenAiCompatibleBaseUrl,
  openAiCompatibleEndpoint,
} from "./openai-compatible-url.mjs";

function clean(value) {
  return String(value ?? "").trim();
}
function httpEndpoint(baseUrl, type = "", endpoint = "") {
  const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl, type);
  if (clean(endpoint)) {
    return openAiCompatibleEndpoint(normalized, endpoint, type);
  }
  const parsed = new URL(normalized);
  if (parsed.pathname.endsWith("/chat/completions")) return parsed.toString();
  if (parsed.pathname.endsWith("/v1")) {
    return openAiCompatibleEndpoint(normalized, "chat/completions");
  }
  return openAiCompatibleEndpoint(normalized, "v1/chat/completions");
}

function jsonName(value) {
  const normalized = clean(value).replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 64);
  return normalized || "memory_analysis";
}

function parseJsonContent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  const text = clean(value)
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/^\uFEFF/u, "")
    .trim();
  if (!text) throw new Error("记忆处理 API 没有返回结构化内容。");
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("顶层必须是 JSON 对象");
    }
    return parsed;
  } catch (error) {
    throw new Error(`记忆处理 API 返回的不是有效 JSON：${error.message}`);
  }
}

function completionContent(payload, outputMode, schemaName) {
  if (outputMode === "strict-tool") {
    const calls = payload?.choices?.[0]?.message?.tool_calls;
    const selected = Array.isArray(calls)
      ? calls.find((call) => clean(call?.function?.name) === schemaName)
      : null;
    const argumentsText = selected?.function?.arguments;
    if (typeof argumentsText !== "string" && !argumentsText) {
      throw new Error(`记忆处理 API 没有调用要求的严格结构化工具 ${schemaName}。`);
    }
    return argumentsText;
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => clean(part?.text ?? part?.content)).filter(Boolean).join("\n");
  }
  return content;
}

function providerMessage(payload, status) {
  const message = clean(payload?.error?.message || payload?.message).slice(0, 500);
  return message ? `记忆处理 API 请求失败（${status}）：${message}` : `记忆处理 API 请求失败（${status}）。`;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function retryableHttpStatus(status) {
  const value = Number(status);
  return value === 408 || value === 425 || value === 429 || value >= 500;
}

function responseHeader(response, name) {
  return clean(response?.headers?.get?.(name));
}

function invalidEnvelopeMessage(response, bodyText, attempt, maximumAttempts) {
  const details = [
    `status=${Number(response?.status) || 0}`,
    `attempt=${attempt}/${maximumAttempts}`,
    `contentType=${responseHeader(response, "content-type") || "unknown"}`,
    `responseCharacters=${String(bodyText ?? "").length}`,
  ];
  const requestId = responseHeader(response, "x-request-id")
    || responseHeader(response, "x-dashscope-request-id");
  if (requestId) details.push(`requestId=${requestId}`);
  return `记忆处理 API 返回的不是有效响应 JSON（${details.join("，")}）。`;
}

function wait(milliseconds) {
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

function exhaustedTransportError(message, {
  attempt,
  maximumAttempts,
  diagnostics = {},
} = {}) {
  const error = new Error(message);
  error.code = "MEMORY_PROVIDER_TRANSPORT_EXHAUSTED";
  error.transportAttempts = Number(attempt || 0);
  error.maximumTransportAttempts = Number(maximumAttempts || 0);
  error.diagnostics = diagnostics && typeof diagnostics === "object" && !Array.isArray(diagnostics)
    ? diagnostics
    : {};
  return error;
}

/**
 * Creates the shared structured-generation contract used by long-term memory
 * extraction and specialist analysis. Provider-side JSON mode improves reliability; every specialist
 * still parses and validates the returned object against its own fixed rules.
 */
export function createOpenAiCompatibleStructuredGenerator({
  connection = {},
  fetchImpl = globalThis.fetch,
  timeoutMs,
  maxOutputTokens = 8_192,
} = {}) {
  const apiKey = clean(connection.apiKey || connection.key);
  const model = clean(connection.model);
  const endpoint = httpEndpoint(connection.baseUrl, connection.type, connection.endpoint);
  const outputMode = clean(connection.structuredOutputMode || "json-object").toLowerCase();
  if (!["json-object", "strict-tool"].includes(outputMode)) {
    throw new Error(`不支持的结构化输出方式：${outputMode}。`);
  }
  if (!apiKey) throw new Error("记忆处理 API 缺少可用密钥。");
  if (!model) throw new Error("记忆处理 API 缺少文字模型名称。");
  if (typeof fetchImpl !== "function") throw new Error("记忆处理 API 缺少 HTTP 客户端。");
  const requestTimeoutMs = boundedInteger(
    timeoutMs ?? connection.timeoutMs,
    180_000,
    1_000,
    600_000,
  );
  const outputLimit = boundedInteger(maxOutputTokens, 8_192, 256, 64_000);
  const maximumTransportAttempts = boundedInteger(
    connection.maximumTransportAttempts,
    3,
    1,
    5,
  );
  const transportRetryDelayMs = boundedInteger(
    connection.transportRetryDelayMs,
    500,
    0,
    30_000,
  );

  const generate = async function generate({
    input,
    systemPrompt,
    schema = {},
    schemaName = "memory-analysis-v1",
  } = {}) {
    const started = Date.now();
    const selectedSchemaName = jsonName(schemaName);
    const schemaText = JSON.stringify(schema);
    const outputInstruction = outputMode === "strict-tool"
      ? `必须调用 ${selectedSchemaName}，并让参数严格符合它的 JSON Schema。不要输出解释。`
      : `只输出一个 JSON 对象，不要输出 Markdown 或解释。输出必须符合这个 JSON Schema：\n${schemaText}`;
    const payload = {
      ...(connection.extraBody && typeof connection.extraBody === "object"
        && !Array.isArray(connection.extraBody) ? connection.extraBody : {}),
      model,
      messages: [
        {
          role: "system",
          content: `${clean(systemPrompt)}\n\n${outputInstruction}`,
        },
        { role: "user", content: String(input ?? "") },
      ],
      temperature: 0,
      max_tokens: outputLimit,
      ...(outputMode === "strict-tool" ? {
        tools: [{
          type: "function",
          function: {
            name: selectedSchemaName,
            description: "Return the validated structured memory result.",
            strict: true,
            parameters: schema,
          },
        }],
        tool_choice: {
          type: "function",
          function: { name: selectedSchemaName },
        },
      } : {
        response_format: { type: "json_object" },
      }),
    };
    for (let attempt = 1; attempt <= maximumTransportAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      let response;
      try {
        response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            ...(connection.extraHeaders && typeof connection.extraHeaders === "object"
              && !Array.isArray(connection.extraHeaders) ? connection.extraHeaders : {}),
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "User-Agent": "suzu-memory/0.1",
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } catch (error) {
        const message = error?.name === "AbortError"
          ? `记忆处理 API 请求超过 ${requestTimeoutMs}ms。`
          : `无法连接记忆处理 API：${clean(error?.message) || "未知网络错误"}`;
        if (attempt < maximumTransportAttempts) {
          await wait(transportRetryDelayMs * attempt);
          continue;
        }
        throw exhaustedTransportError(`${message}（已尝试 ${attempt} 次）`, {
          attempt,
          maximumAttempts: maximumTransportAttempts,
          diagnostics: { kind: error?.name === "AbortError" ? "timeout" : "network" },
        });
      } finally {
        clearTimeout(timer);
      }

      let envelope;
      let bodyText = "";
      try {
        if (typeof response.text === "function") {
          bodyText = await response.text();
          envelope = JSON.parse(bodyText.replace(/^\uFEFF/u, ""));
        } else {
          envelope = await response.json();
        }
        if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
          throw new Error("Response envelope must be a JSON object.");
        }
      } catch {
        const message = invalidEnvelopeMessage(
          response,
          bodyText,
          attempt,
          maximumTransportAttempts,
        );
        if (attempt < maximumTransportAttempts
          && (response.ok || retryableHttpStatus(response.status))) {
          await wait(transportRetryDelayMs * attempt);
          continue;
        }
        throw exhaustedTransportError(message, {
          attempt,
          maximumAttempts: maximumTransportAttempts,
          diagnostics: {
            kind: "invalid-response-envelope",
            status: Number(response?.status) || 0,
            contentType: responseHeader(response, "content-type") || "unknown",
            responseCharacters: String(bodyText ?? "").length,
            requestId: responseHeader(response, "x-request-id")
              || responseHeader(response, "x-dashscope-request-id"),
          },
        });
      }
      if (!response.ok) {
        const message = providerMessage(envelope, response.status);
        if (attempt < maximumTransportAttempts && retryableHttpStatus(response.status)) {
          await wait(transportRetryDelayMs * attempt);
          continue;
        }
        if (retryableHttpStatus(response.status)) {
          throw exhaustedTransportError(
            attempt > 1 ? `${message}（已尝试 ${attempt} 次）` : message,
            {
              attempt,
              maximumAttempts: maximumTransportAttempts,
              diagnostics: {
                kind: "retryable-http-status",
                status: Number(response.status) || 0,
                requestId: responseHeader(response, "x-request-id")
                  || responseHeader(response, "x-dashscope-request-id"),
              },
            },
          );
        }
        throw new Error(message);
      }
      return {
        output: parseJsonContent(completionContent(envelope, outputMode, selectedSchemaName)),
        usage: envelope.usage || {},
        model: clean(envelope.model) || model,
        requestId: clean(envelope.id)
          || responseHeader(response, "x-request-id")
          || responseHeader(response, "x-dashscope-request-id"),
        durationMs: Date.now() - started,
        metadata: {
          provider: clean(connection.name || connection.provider || connection.type) || "OpenAI Compatible",
          responseFormat: outputMode,
          schemaName: selectedSchemaName,
          transportAttempts: attempt,
        },
      };
    }
    throw new Error("记忆处理 API 传输重试未产生结果。");
  };
  generate.supportsCombinedStateAnalysis = true;
  generate.supportsCombinedConsolidation = true;
  return generate;
}
