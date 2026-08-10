function clean(value) {
  return String(value ?? "").trim();
}

function parseSnapshot(input) {
  const text = String(input ?? "");
  const marker = text.indexOf("\n\n{");
  if (marker < 0) return null;
  try {
    const value = JSON.parse(text.slice(marker + 2));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sameSnapshot(calls) {
  const snapshots = calls.map((call) => parseSnapshot(call.request.input));
  if (snapshots.some((snapshot) => !snapshot)) return null;
  const signature = JSON.stringify(snapshots[0]);
  return snapshots.every((snapshot) => JSON.stringify(snapshot) === signature)
    ? snapshots[0]
    : null;
}

function combinedSchema(calls) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "object",
        additionalProperties: false,
        required: calls.map((call) => call.key),
        properties: Object.fromEntries(calls.map((call) => [
          call.key,
          call.request.schema,
        ])),
      },
    },
  };
}

function combinedPrompt(calls) {
  const sections = calls.map((call) => [
    `## results.${call.key} (${call.request.analyzerRole})`,
    clean(call.request.systemPrompt),
  ].join("\n"));
  return [
    "你要在一次请求中完成多个彼此相关、但结论必须相互独立的专职分析。",
    "每个专职角色继续严格遵守自己的职责、证据边界和弃权条件。",
    "不得用一个角色的推断替另一个角色补齐证据，不得改变固定主体、时间、现实层或 currentState。",
    "按 JSON Schema 把各角色结果分别写入 results.<key>；同一记忆在没有相应证据时可以从该角色结果中省略。",
    "",
    ...sections,
  ].join("\n\n");
}

function combinedInput(calls, snapshot) {
  const roles = calls.map((call) => `${call.key}: ${call.request.analyzerRole}`).join("\n");
  return [
    "请对下面同一份只读快照完成这些专职分析：",
    roles,
    "",
    "快照：",
    JSON.stringify(snapshot, null, 2),
  ].join("\n");
}

function splitGeneration(generation, calls) {
  const results = generation?.output?.results;
  if (!results || typeof results !== "object" || Array.isArray(results)) {
    throw new Error("Combined state analysis did not return a results object.");
  }
  return calls.map((call, index) => {
    if (!Object.hasOwn(results, call.key)) {
      throw new Error(`Combined state analysis omitted results.${call.key}.`);
    }
    return {
      ...generation,
      output: results[call.key],
      usage: index === 0 ? generation.usage || {} : null,
      costAmount: index === 0 ? generation.costAmount : 0,
      metadata: {
        ...generation.metadata,
        combinedStateAnalysis: true,
        combinedAnalyzerKeys: calls.map((item) => item.key),
        usageRecordedByAnalyzerKey: calls[0].key,
      },
    };
  });
}

function noCurrentStateGeneration(request) {
  const snapshot = parseSnapshot(request.input);
  if (!snapshot || snapshot.currentState) return null;
  const itemSchema = request.schema?.properties?.analyses?.items;
  const required = Array.isArray(itemSchema?.required) ? itemSchema.required : [];
  if (!required.includes("currentStatePresent") || !required.includes("relation")) return null;
  const analyses = (Array.isArray(snapshot.memories) ? snapshot.memories : [])
    .map((memory) => {
      const sourceIds = Array.isArray(memory?.sourceIds)
        ? [...new Set(memory.sourceIds.map(clean).filter(Boolean))]
        : [];
      if (!clean(memory?.id) || !sourceIds.length) return null;
      const result = {
        memoryId: clean(memory.id),
        sourceIds,
        confidence: 1,
        rationale: "调用方提供的只读快照中不存在当前状态。",
        currentStatePresent: false,
        relation: "no_current_state",
      };
      for (const field of ["scopeOverlap", "valueOverlap"]) {
        if (required.includes(field)) result[field] = "unknown";
      }
      return result;
    })
    .filter(Boolean);
  return {
    output: { analyses },
    usage: {},
    model: "local-deterministic-rule",
    requestId: "",
    durationMs: 0,
    costAmount: 0,
    costCurrency: "",
    metadata: {
      provider: "local",
      deterministicStateRelation: true,
    },
  };
}

function phaseFor(definition) {
  if (definition?.role === "current-relation"
    || definition?.role === "time-current-relation") return "comparison";
  return "evidence";
}

async function runCalls(generator, calls, stateFamily, phase) {
  if (calls.length === 1) return [await generator(calls[0].request)];
  const snapshot = sameSnapshot(calls);
  if (!snapshot) {
    return Promise.all(calls.map((call) => generator(call.request)));
  }
  const first = calls[0].request;
  const generation = await generator({
    ...first,
    input: combinedInput(calls, snapshot),
    systemPrompt: combinedPrompt(calls),
    schema: combinedSchema(calls),
    schemaName: `memory-${stateFamily}-${phase}-combined-v1`,
    analyzerRole: `combined-${phase}`,
    combinedAnalyzerKeys: calls.map((call) => call.key),
  });
  return splitGeneration(generation, calls);
}

export function createRelatedAnalyzerBatch({
  definitions,
  generator,
  request,
} = {}) {
  if (!definitions || typeof definitions !== "object") {
    throw new Error("Related analyzer batching requires analyzer definitions.");
  }
  if (typeof generator !== "function") {
    throw new Error("Related analyzer batching requires a generator.");
  }
  const decorate = (input) => ({
    ...input,
    stateAnalysisRequestId: request.id,
    stateAnalysisProcessorVersion: request.processorVersion,
  });
  if (generator.supportsCombinedStateAnalysis !== true) {
    return Object.fromEntries(Object.keys(definitions).map((key) => [
      key,
      (input) => generator(decorate(input)),
    ]));
  }

  const queues = new Map();
  function enqueue(key, definition, input) {
    const decorated = decorate(input);
    if (definition.role === "current-relation") {
      const deterministic = noCurrentStateGeneration(decorated);
      if (deterministic) return Promise.resolve(deterministic);
    }
    const phase = phaseFor(definition);
    let queue = queues.get(phase);
    if (!queue) {
      queue = { calls: [], scheduled: false };
      queues.set(phase, queue);
    }
    return new Promise((resolve, reject) => {
      queue.calls.push({ key, definition, request: decorated, resolve, reject });
      if (queue.scheduled) return;
      queue.scheduled = true;
      queueMicrotask(async () => {
        const calls = queue.calls.splice(0);
        queue.scheduled = false;
        try {
          const outputs = await runCalls(
            generator,
            calls,
            clean(calls[0]?.definition?.stateFamily) || "state",
            phase,
          );
          calls.forEach((call, index) => call.resolve(outputs[index]));
        } catch (error) {
          calls.forEach((call) => call.reject(error));
        }
      });
    });
  }

  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [
    key,
    (input) => enqueue(key, definition, input),
  ]));
}
