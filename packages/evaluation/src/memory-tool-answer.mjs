/** Drive the reader's normal tool calls; the memory service never calls a planner model. */
export async function answerWithMemoryTools({ messages, complete, searchSession, signal }) {
  const history = structuredClone(messages), steps = [];
  for (let step = 0; step <= searchSession.limits.maximumSearches; step++) {
    signal?.throwIfAborted();
    const remaining = searchSession.remaining();
    const canSearch = remaining.searches > 0 && step < searchSession.limits.maximumSearches;
    const response = await complete(history, { signal,
      tools: canSearch ? [{ type: 'function', function: searchSession.tool }] : undefined });
    const message = response.message;
    if (!message || message.role !== 'assistant') throw new Error('Missing assistant message.');
    steps.push({ ...response, message: structuredClone(message) });
    history.push(message);
    const calls = message.tool_calls || [];
    if (!calls.length) {
      if (!message.content?.trim()) throw new Error('Missing final answer.');
      return { answer: message.content.trim(), steps, messages: history, search: { ...searchSession.stats } };
    }
    if (!canSearch) throw new Error('Reader requested tools after the tool-call limit was reached.');
    // Stable tool-result order also keeps the next model request's prefix stable.
    for (const call of calls) {
      signal?.throwIfAborted();
      let text;
      try {
        if (call.type !== 'function' || call.function?.name !== searchSession.tool.name) {
          throw Object.assign(new Error('Unknown tool.'), { code: 'UNKNOWN_TOOL' });
        }
        let args;
        try { args = JSON.parse(call.function.arguments); }
        catch (error) { throw Object.assign(error, { code: 'INVALID_MEMORY_QUERY' }); }
        text = (await searchSession.execute(args, { signal })).text;
      } catch (error) {
        signal?.throwIfAborted();
        // Query validation is recoverable; transport/search failures retain their
        // identity so the runner can apply the established retry/failure policy.
        if (!['INVALID_MEMORY_QUERY', 'UNKNOWN_TOOL'].includes(error.code)) throw error;
        text = `工具参数无效：${error.message}`;
      }
      history.push({ role: 'tool', tool_call_id: call.id, content: text });
    }
  }
  throw new Error('Reader did not finish within its tool budget.');
}
