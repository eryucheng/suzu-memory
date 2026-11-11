import { mergeEventSourceMaterials } from '@suzu-memory/core';
import { mergeGenerationMaterials, withGenerationReferences } from './generation-input.mjs';

function clean(value) {
  return String(value ?? "").trim();
}

function combinedSchema(calls, model = false) {
  return {
    type: "object",
    additionalProperties: false,
    required: calls.map((call) => call.key),
    properties: Object.fromEntries(calls.map((call) => [call.key,
      model ? call.request.modelSchema || call.request.schema : call.request.schema])),
  };
}

function combinedPrompt(calls, historicalPrefix) {
  return [
    "根据共享材料分别生成 structure 结构提案与 relations 因果提案。",
    ...(historicalPrefix ? ["将 historicalMaterial 和顶层的 memories、sourceRecords 按各自同名表合用。"] : []),
    "structure 依据 memories、candidateContainers 和 eventContinuity 归组；relations 依据 memories 与 sourceRecords 判断因果。",
    "不得为了让结构与关系彼此一致而补充快照中不存在的事实；任何一类都可以返回空 proposals。",
    "按 JSON Schema 分别输出 structure 与 relations。",
    "",
    ...calls.map((call) => [
      `## ${call.key}`,
      clean(call.request.systemPrompt),
    ].join("\n")),
  ].join("\n\n");
}

function outputUsage(generation, calls, index) {
  return { usage: index === 0 ? generation?.usage || {} : null,
    costAmount: index === 0 ? generation?.costAmount : 0,
    metadata: { ...generation?.metadata, combinedConsolidation: true,
      combinedOutputs: calls.map(call => call.key), usageRecordedByOutput: calls[0].key } };
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
      ...outputUsage(generation, calls, index),
    };
  });
}

export function buildConsolidationRequest(calls) {
  if (calls.length === 1) return calls[0].request;
  const first = calls[0].request;
  const material = mergeGenerationMaterials(calls.map(call => JSON.parse(call.request.input)));
  const historicalPrefix = Boolean(material.retrospectiveContext);
  return withGenerationReferences({
    ...first,
    input: JSON.stringify(material),
    systemPrompt: combinedPrompt(calls, historicalPrefix),
    schema: combinedSchema(calls),
    modelSchema: combinedSchema(calls, true),
    decodeModelOutput: output => Object.fromEntries(calls.map(call => [call.key,
      call.request.decodeModelOutput && output?.[call.key] !== undefined
        ? call.request.decodeModelOutput(output[call.key]) : output?.[call.key]])),
    schemaName: "memory-consolidation-combined-v1",
    analyzerRole: "memory-consolidation-combined",
    combinedOutputs: calls.map(call => call.key),
    ...(first.sourceMaterial ? { sourceMaterial: mergeEventSourceMaterials(calls.map(call => call.request.sourceMaterial)) } : {}),
  }, { historicalPrefix });
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
        let generation;
        try {
          if (pending.length === 1) {
            pending[0].resolve(await generator(pending[0].request));
            return;
          }
          generation = await generator(buildConsolidationRequest(pending));
          const outputs = splitGeneration(generation, pending);
          pending.forEach((call, index) => call.resolve(outputs[index]));
        } catch (error) {
          const response = generation || error;
          pending.forEach((call, index) => call.reject(Object.assign(new Error(error.message, { cause: error }), error, {
            name: error.name, model: response?.model, requestId: response?.requestId, durationMs: response?.durationMs,
            ...outputUsage(response, pending, index),
          })));
        }
      });
    });
  }

  return {
    structure: (request) => enqueue("structure", request),
    relations: (request) => enqueue("relations", request),
  };
}
