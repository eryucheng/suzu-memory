import { isStateAnalysisBudgetError } from "./request-budget.mjs";
import { mergeEventSourceMaterials } from '@suzu-memory/core';
import { stateMatchAnalysisSchema } from './state-memory-candidates.mjs';
import { createHash } from 'node:crypto';

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

function combinedRequest(calls, snapshot, stateFamily, phase) {
  const first = calls[0].request;
  return {
    ...first,
    input: combinedInput(calls, snapshot),
    systemPrompt: combinedPrompt(calls),
    schema: combinedSchema(calls),
    schemaName: `memory-${stateFamily}-${phase}-combined-v1`,
    analyzerRole: `combined-${phase}`,
    combinedAnalyzerKeys: calls.map(call => call.key),
    ...(first.sourceMaterial ? { sourceMaterial: mergeEventSourceMaterials(calls.map(call => call.request.sourceMaterial)) } : {}),
  };
}

// Only split independent analyzer roles. Every role retains the same complete
// evidence, target, current state and source material.
function planCalls(generator, calls, stateFamily, phase) {
  const snapshot = calls.length > 1 ? sameSnapshot(calls) : null;
  if (calls.length > 1 && (!snapshot || generator.supportsCombinedStateAnalysis !== true)) {
    return calls.flatMap(call => planCalls(generator, [call], stateFamily, phase));
  }
  const request = calls.length === 1 ? calls[0].request : combinedRequest(calls, snapshot, stateFamily, phase);
  try {
    generator.assertRequestBudget?.(request);
    return [{ calls, request }];
  } catch (error) {
    if (!isStateAnalysisBudgetError(error) || calls.length === 1) throw error;
    const middle = Math.ceil(calls.length / 2);
    return [calls.slice(0, middle), calls.slice(middle)].flatMap(group => planCalls(generator, group, stateFamily, phase));
  }
}

export function createRelatedAnalyzerBatch({
  definitions,
  generator,
  request,
  onBudgetExceeded = () => {},
  onGenerationError = () => {},
  stateContext = null,
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
    stateAnalysisAttempt: request.attempt || 1,
  });
  const pending = [];
  let scheduled = false;
  function enqueue(key, definition, input) {
    const decorated = decorate(input);
    if ((!stateContext || (stateContext.resolved && !stateContext.selected))
      && definition.role === "current-relation" && generator.supportsCombinedStateAnalysis === true) {
      const deterministic = noCurrentStateGeneration(decorated);
      if (deterministic) return Promise.resolve(deterministic);
    }
    return new Promise((resolve, reject) => {
      pending.push({ key, definition, request: decorated, resolve, reject });
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(async () => {
        const calls = pending.splice(0);
        scheduled = false;
        try {
          const groups = new Map();
          for (const call of calls) {
            const phase = phaseFor(call.definition);
            const family = clean(call.definition.stateFamily) || "state";
            const key = `${family}:${phase}`;
            if (!groups.has(key)) groups.set(key, { family, phase, calls: [] });
            groups.get(key).calls.push(call);
          }
          // Finish all budget checks before starting any provider work.
          const plans = [...groups.values()].flatMap(group => planCalls(generator, group.calls, group.family, group.phase));
          for (const plan of plans) {
            let actualRequest = plan.request;
            if (stateContext?.resolved) {
              const marker = actualRequest.input.indexOf('\n\n{');
              const combinedMarker = actualRequest.input.indexOf('快照：\n');
              const jsonStart = marker >= 0 ? marker + 2 : combinedMarker >= 0 ? combinedMarker + '快照：\n'.length : -1;
              if (jsonStart >= 0) actualRequest = { ...actualRequest,
                input: actualRequest.input.slice(0, jsonStart) + JSON.stringify(stateContext.refresh(JSON.parse(actualRequest.input.slice(jsonStart))), null, 2) };
            }
            const resolveIdentity = stateContext && !stateContext.resolved;
            if (resolveIdentity) actualRequest = {
              ...actualRequest,
              schemaName: 'memory-state-match-analysis-v1',
              stateMatchAnalysisTask: { schemaName: plan.request.schemaName, schema: plan.request.schema,
                combinedAnalyzerKeys: plan.request.combinedAnalyzerKeys },
              schema: stateMatchAnalysisSchema(plan.request.schema),
              systemPrompt: [
                '先判断 semanticMemory 是否描述 stateCandidates 中同一事项或状态对象的后续证据，将判断写入 stateMatch。',
                'matched 必须引用候选 id；new 表示独立的新事项；ambiguous 表示现有材料无法确定。new 和 ambiguous 的 candidateId 为空字符串。',
                '人物、日期、对象和具体约定需要相互吻合；语义相似、同名、同一个话题都不足以证明是同一事项。改期本身不表示新事项。',
                '待审核候选仍参与比较，evidenceOnly 表示尚未形成状态的已有证据。不得将候选内容当成本批新证据。',
                'analysis 字段完成下述已有专职职责。stateMatch 仅选择事项身份，不代替各项证据判断，也不修改记忆正文。',
                actualRequest.systemPrompt,
              ].join('\n\n'),
            };
            generator.assertRequestBudget?.(actualRequest);
            const deterministic = !resolveIdentity && plan.calls.length === 1
              && plan.calls[0].definition.role === 'current-relation' && generator.supportsCombinedStateAnalysis === true
              ? noCurrentStateGeneration(actualRequest) : null;
            let generation = deterministic || await generator(actualRequest);
            if (resolveIdentity) {
              stateContext.resolve(generation?.output?.stateMatch);
              generation = { ...generation, output: generation.output.analysis };
            }
            generation = { ...generation, metadata: { ...generation.metadata,
              analysisInputHash: createHash('sha256').update(actualRequest.input).digest('hex'),
              analysisSchemaName: actualRequest.schemaName } };
            const outputs = plan.calls.length === 1 ? [generation] : splitGeneration(generation, plan.calls);
            plan.calls.forEach((call, index) => call.resolve(outputs[index]));
          }
        } catch (error) {
          onGenerationError(error);
          if (isStateAnalysisBudgetError(error)) onBudgetExceeded(error);
          calls.forEach(call => call.reject(error));
        }
      });
    });
  }

  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [
    key,
    (input) => enqueue(key, definition, input),
  ]));
}
