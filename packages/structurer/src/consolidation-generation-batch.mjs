import { mergeEventSourceMaterials } from '@suzu-memory/core';
import { assertGenerationRequestBudget, mergeGenerationMaterials, withGenerationReferences } from './generation-input.mjs';
import { isMemoryBudgetError } from './budgeted-parts.mjs';

function clean(value) {
  return String(value ?? "").trim();
}

function combinedSchema(calls, model = false) {
  return {
    type: "object",
    additionalProperties: false,
    required: calls.map((call) => call.key),
    properties: Object.fromEntries(calls.map((call) => [call.key,
      model ? call.request.modelSchemaTemplate || call.request.modelSchema || call.request.schema : call.request.schema])),
  };
}

function combinedPrompt(calls, historicalPrefix) {
  return [
    "使用共享材料，分别完成以下任务。",
    ...(historicalPrefix ? ["将 historicalMaterial 和顶层的 memories、sourceRecords 按各自同名表合用。"] : []),
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
  return calls.map((call, index) => ({
      ...generation,
      output: output[call.key],
      ...outputUsage(generation, calls, index),
    }));
}

export function buildConsolidationRequest(calls, { sharedNewFirst = false } = {}) {
  if (calls.length === 1) return calls[0].request;
  const first = calls[0].request;
  const material = mergeGenerationMaterials(calls.map(call => JSON.parse(call.request.input)));
  const historicalPrefix = Boolean(material.retrospectiveContext);
  const planned = calls.some(call => call.request.schemaName === 'memory-structure-memberships-v1');
  return withGenerationReferences({
    ...first,
    input: JSON.stringify(material),
    systemPrompt: combinedPrompt(calls, historicalPrefix),
    schema: combinedSchema(calls),
    modelSchema: combinedSchema(calls, true),
    decodeModelOutput: output => Object.fromEntries(calls.map(call => {
      const value = output?.[call.key];
      // Each child owner diagnoses malformed output without discarding another
      // child's valid, already-paid result.
      try { return [call.key, call.request.decodeModelOutput && value !== undefined
        ? call.request.decodeModelOutput(value) : value]; }
      catch { return [call.key, value]; }
    })),
    schemaName: planned ? 'memory-organization-decisions-v2' : 'memory-consolidation-combined-v2',
    analyzerRole: "memory-consolidation-combined",
    combinedOutputs: calls.map(call => call.key),
    ...(first.sourceMaterial ? { sourceMaterial: mergeEventSourceMaterials(calls.map(call => call.request.sourceMaterial)) } : {}),
  }, { historicalPrefix, sharedNewFirst, selectionInBody: planned });
}

export function prepareConsolidationGeneration(calls, { generator, taskBudgets, sharedNewFirst, fullRelationRequest }) {
  const maximumCharacters = calls.reduce((total, call) => total + taskBudgets[call.key], 0);
  const budgeted = inputs => {
    const request = buildConsolidationRequest(inputs, { sharedNewFirst });
    assertGenerationRequestBudget(request, maximumCharacters, generator);
    return request;
  };
  if (fullRelationRequest && calls.length === 2) {
    const fullCalls = calls.map(call => call.key === 'relations' ? { ...call, request: fullRelationRequest } : call);
    try { return { request: budgeted(fullCalls), fullRelationSelected: true }; }
    catch (error) {
      if (!isMemoryBudgetError(error)) throw error;
    }
  }
  return { request: budgeted(calls), fullRelationSelected: false };
}

export function createConsolidationGenerationBatch(generator, combinedRequest, taskBudgets) {
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
            const call = pending[0];
            // A sibling can fail its input check before joining the prepared batch.
            if (combinedRequest.combinedOutputs?.length > 1) {
              assertGenerationRequestBudget(call.request, taskBudgets[call.key], generator);
            }
            call.resolve(await generator(call.request));
            return;
          }
          generation = await generator(combinedRequest);
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
