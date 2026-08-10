function clean(value) {
  return String(value ?? "").trim();
}

function combinedSchema(calls) {
  return {
    type: "object",
    additionalProperties: false,
    required: calls.map((call) => call.key),
    properties: Object.fromEntries(calls.map((call) => [call.key, call.request.schema])),
  };
}

function combinedPrompt(calls) {
  return [
    "你要在同一次请求中完成记忆结构提案与关系提案。两类结果相互独立，分别遵守自己的证据边界。",
    "不得为了让结构与关系彼此一致而补充快照中不存在的事实；任何一类都可以返回空 proposals。",
    "按 JSON Schema 分别输出 structure 与 relations。",
    "",
    ...calls.map((call) => [
      `## ${call.key}`,
      clean(call.request.systemPrompt),
    ].join("\n")),
  ].join("\n\n");
}

function combinedInput(calls) {
  return [
    "以下是两个彼此有界的只读任务输入：",
    ...calls.map((call) => [
      `## ${call.key}`,
      String(call.request.input ?? ""),
    ].join("\n")),
  ].join("\n\n");
}

function splitGeneration(generation, calls) {
  const output = generation?.output;
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error("Combined consolidation did not return an object.");
  }
  return calls.map((call, index) => {
    if (!Object.hasOwn(output, call.key)) {
      throw new Error(`Combined consolidation omitted ${call.key}.`);
    }
    return {
      ...generation,
      output: output[call.key],
      usage: index === 0 ? generation.usage || {} : null,
      costAmount: index === 0 ? generation.costAmount : 0,
      metadata: {
        ...generation.metadata,
        combinedConsolidation: true,
        combinedOutputs: calls.map((item) => item.key),
        usageRecordedByOutput: calls[0].key,
      },
    };
  });
}

export function createConsolidationGenerationBatch(generator) {
  if (typeof generator !== "function") {
    throw new Error("Combined consolidation requires a generator.");
  }
  const calls = [];
  let scheduled = false;

  function enqueue(key, request) {
    return new Promise((resolve, reject) => {
      calls.push({ key, request, resolve, reject });
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(async () => {
        const pending = calls.splice(0);
        scheduled = false;
        try {
          if (pending.length === 1) {
            pending[0].resolve(await generator(pending[0].request));
            return;
          }
          const first = pending[0].request;
          const generation = await generator({
            ...first,
            input: combinedInput(pending),
            systemPrompt: combinedPrompt(pending),
            schema: combinedSchema(pending),
            schemaName: "memory-consolidation-combined-v1",
            analyzerRole: "memory-consolidation-combined",
            combinedOutputs: pending.map((call) => call.key),
          });
          const outputs = splitGeneration(generation, pending);
          pending.forEach((call, index) => call.resolve(outputs[index]));
        } catch (error) {
          pending.forEach((call) => call.reject(error));
        }
      });
    });
  }

  return {
    structure: (request) => enqueue("structure", request),
    relations: (request) => enqueue("relations", request),
  };
}
