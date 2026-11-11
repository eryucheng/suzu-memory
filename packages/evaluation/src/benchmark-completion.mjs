import { openAiCompatibleChatEndpoint } from '@suzu-memory/providers';
import { runQuestionOperation } from './zh4o-execution.mjs';

/** Ordinary answers and function tools use the same normalized generation connection as ingestion. */
export function createBenchmarkCompletion(config, { environment = process.env, fetchImpl = globalThis.fetch } = {}) {
  const connection = config.providers.generation;
  if (!connection) throw new Error('A generation provider or an injected complete function is required.');
  const key = connection.apiKey || environment[connection.apiKeyEnv];
  if (!key) throw new Error('Generation API key is not configured.');
  const endpoint = openAiCompatibleChatEndpoint(connection.baseUrl, connection.type, connection.endpoint);
  return (messages, { tools, toolChoice, json = false, signal } = {}) => runQuestionOperation(async () => {
    signal?.throwIfAborted();
    const timeout = AbortSignal.timeout(connection.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const payload = { ...connection.extraBody, model: connection.model,
      max_tokens: connection.maxOutputTokens, temperature: connection.extraBody.temperature ?? 0, messages };
    delete payload.tools;
    delete payload.tool_choice;
    delete payload.response_format;
    if (tools) payload.tools = tools;
    if (toolChoice) payload.tool_choice = toolChoice;
    if (json) payload.response_format = { type: 'json_object' };
    let response, envelope;
    try {
      response = await fetchImpl(endpoint, { method: 'POST', headers: { ...connection.extraHeaders,
        Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: requestSignal });
      envelope = await response.json();
    } catch (error) {
      signal?.throwIfAborted();
      if (timeout.aborted) throw Object.assign(new Error('Generation request timed out.'), { code: 'ETIMEDOUT' });
      if (response && !response.ok) throw Object.assign(new Error(`Provider HTTP ${response.status}`), { status: response.status });
      throw error;
    }
    if (!response.ok) throw Object.assign(new Error(envelope?.error?.message || `Provider HTTP ${response.status}`), { status: response.status });
    const choice = envelope.choices?.[0];
    if (choice?.finish_reason === 'length') throw Object.assign(new Error('Generation output reached the configured token limit.'), { code: 'MAX_TOKENS' });
    if (choice?.message?.role !== 'assistant') throw new Error('Provider returned no assistant message.');
    return { message: choice.message, model: envelope.model, usage: envelope.usage || {} };
  }, { delayMs: connection.transportRetryDelayMs, maximumAttempts: connection.maximumTransportAttempts ?? 3, signal });
}
