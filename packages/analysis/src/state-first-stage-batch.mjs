import { isDeepStrictEqual } from 'node:util';
import { mergeEventSourceMaterials, withModelReferences } from '@suzu-memory/core';
import { appendUsageEvent } from '@suzu-memory/usage-ledger';
import { analysisSystemPrompt } from './source-material.mjs';
import { projectStateModelInput, stateModelSchema, stateReferenceFields, decodeStateModelOutput } from './state-model-input.mjs';
import { isStateAnalysisBudgetError, stateAnalysisBudgetError } from './request-budget.mjs';

export const STATE_FIRST_STAGE_BATCH_SCHEMA_NAME = 'memory-state-first-stage-batch-v1';
const object = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });

function boundary(repository, request) {
  const candidate = repository.getIngestionDecisionByBatchCandidate(request.agent_id, request.batch_id, request.candidate_index)?.candidate;
  const memories = request.memoryIds.map(id => repository.getMemory(id));
  if (!candidate?.reality || memories.some(memory => !memory || memory.status === 'deleted')) return null;
  const worlds = memories.map(memory => [candidate.reality, memory.world_id, memory.world_frame]);
  if (!worlds.length || worlds.some(world => !isDeepStrictEqual(world, worlds[0]))) return null;
  return JSON.stringify([request.batch_id, request.subject_role, request.subject_key,
    request.representation_layer, request.evidence_mode, worlds[0],
    [...request.memoryIds].sort(), [...request.sourceIds].sort()]);
}

// Consume a ready prefix only: never move work past another evidence boundary
// or an earlier request of the same family. The execution's source cutoff is fixed.
export function selectStateFirstStageGroup(repository, requests, generator) {
  if (generator.supportsCombinedStateAnalysis !== true) return requests.slice(0, 1);
  const key = boundary(repository, requests[0]);
  const families = new Set(), group = [];
  for (const request of requests) {
    if (group.length && (!key || boundary(repository, request) !== key || families.has(request.state_family))) break;
    group.push(request);
    families.add(request.state_family);
  }
  return group;
}

export function buildStateFirstStageBatch(jobs) {
  const materials = jobs.map(job => projectStateModelInput(job.snapshot,
    { matchState: job.request.schemaName === 'memory-state-match-analysis-v1' }));
  const shared = {};
  // Share fields only when the actual projections agree, including attribution.
  for (const key of ['sourceRecords', 'memories', 'inputPolicy']) {
    if (Object.hasOwn(materials[0], key) && materials.every(material => isDeepStrictEqual(material[key], materials[0][key]))) {
      shared[key] = materials[0][key];
    }
  }
  const keys = jobs.map((_, index) => `task${index + 1}`);
  const material = { shared, tasks: Object.fromEntries(materials.map((value, index) => [keys[index],
    Object.fromEntries(Object.entries(value).filter(([key]) => !Object.hasOwn(shared, key))),
  ])) };
  const stateAnalysisTasks = jobs.map((job, index) => ({ key: keys[index],
    stateAnalysisRequestId: job.request.stateAnalysisRequestId,
    stateFamily: job.request.stateAnalysisFamily || job.request.stateFamily,
    schemaName: job.request.schemaName, schema: job.request.schema,
    ...(job.request.stateMatchAnalysisTask ? { stateMatchAnalysisTask: job.request.stateMatchAnalysisTask } : {}),
    ...(job.request.combinedAnalyzerKeys ? { combinedAnalyzerKeys: job.request.combinedAnalyzerKeys } : {}),
  }));
  const request = {
    schemaName: STATE_FIRST_STAGE_BATCH_SCHEMA_NAME,
    schema: object({ results: object(Object.fromEntries(jobs.map((job, index) => [keys[index], job.request.schema]))) }),
    stateAnalysisTasks,
    decodeModelOutput: output => output?.results && typeof output.results === 'object'
      ? { ...output, results: Object.fromEntries(Object.entries(output.results).map(([key, value]) => {
        const job = jobs[keys.indexOf(key)];
        return [key, job ? decodeStateModelOutput(job.request, value) : value];
      })) } : output,
    input: JSON.stringify(material),
    systemPrompt: analysisSystemPrompt([
      'Complete each tasks.<key> independently and return its result in results.<key>. Each task inherits the fields in shared; its own target, candidates and instructions apply only to that task.',
      'Use only original evidence for each judgment. Another task\'s conclusion is not evidence. Cite only sources belonging to the analyzed memory. Candidate IDs are restricted separately for each task.',
      ...jobs.map((job, index) => `## results.${keys[index]} (${stateAnalysisTasks[index].stateFamily})\n${job.request.systemPrompt}`),
    ].join('\n\n'), { sourceRecords: materials[0].sourceRecords }),
    ...(jobs.some(job => job.request.sourceMaterial)
      ? { sourceMaterial: mergeEventSourceMaterials(jobs.map(job => job.request.sourceMaterial)) } : {}),
  };
  const referenced = withModelReferences(request, { material, fields: stateReferenceFields });
  const encoded = JSON.parse(referenced.modelInput);
  return { ...referenced, modelSchema: object({ results: object(Object.fromEntries(jobs.map((job, index) => [keys[index],
    stateModelSchema(job.request, { ...encoded.shared, ...encoded.tasks[keys[index]] }),
  ]))) }) };
}

function judgmentCount(schema) {
  if (schema?.properties?.analyses) return schema.properties.analyses.maxItems ?? Infinity;
  return Object.values(schema?.properties || {}).reduce((sum, child) => sum + judgmentCount(child), 0);
}

// This is a bounded rendezvous for one claimed group, not a persistent queue.
// Each member submits its first evidence call or finishes without one.
export function createStateFirstStageBatch({ generator, requestIds, agentId, usageLedgerPath = '',
  maximumRequestCharacters = 120_000, maximumJudgments = 80 } = {}) {
  for (const [key, value] of Object.entries({ maximumRequestCharacters, maximumJudgments })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${key} must be a positive safe integer.`);
  }
  const waiting = new Set(requestIds), jobs = [];
  let dispatched = false;

  function fits(request, group) {
    generator.assertRequestBudget?.(request);
    if (group.length < 2) return;
    const characters = generator.measureRequest ? generator.measureRequest(request)
      : request.modelInput.length + request.systemPrompt.length + JSON.stringify(request.modelSchema).length;
    if (characters > maximumRequestCharacters || judgmentCount(request.schema) > maximumJudgments) {
      throw stateAnalysisBudgetError('The complete first-stage batch exceeds its request or judgment budget.');
    }
  }

  async function account(receipt, group) {
    const warnings = [];
    if (usageLedgerPath && receipt?.model && receipt?.usage) {
      try {
        await appendUsageEvent(usageLedgerPath, { agentId, model: receipt.model,
          provider: receipt.metadata?.provider || '', source: 'memory-evaluation',
          feature: 'memory-state-first-stage', requestId: receipt.requestId || '', usage: receipt.usage,
          metadata: { ...receipt.metadata, stateAnalysisRequestIds: group.map(job => job.id),
            durationMs: Number(receipt.durationMs || 0) } });
      } catch (error) { warnings.push('费用流水写入失败：' + error.message); }
    }
    return warnings;
  }

  function portion(receipt, group, index, warnings) {
    return { ...receipt, usage: index === 0 ? receipt.usage : null,
      costAmount: index === 0 ? receipt.costAmount : 0,
      metadata: { ...receipt.metadata, stateBatchUsageRecorded: true,
        stateAnalysisRequestIds: group.map(job => job.id), usageWarnings: index === 0 ? warnings : [] } };
  }

  async function send(group) {
    const current = [];
    for (const job of group) {
      try { job.assertCurrent(); current.push(job); }
      catch (error) { job.reject(error); }
    }
    if (!current.length) return;
    const request = current.length > 1 ? buildStateFirstStageBatch(current) : current[0].request;
    try { fits(request, current); }
    catch (error) {
      if (current.length > 1 && isStateAnalysisBudgetError(error)) {
        const middle = Math.ceil(current.length / 2);
        await send(current.slice(0, middle)); await send(current.slice(middle));
      } else current.forEach(job => job.reject(error));
      return;
    }
    let generation;
    try { generation = await generator(request); }
    catch (error) {
      const warnings = await account(error, current);
      if (error.code === 'MAX_TOKENS' && current.length > 1) {
        const middle = Math.ceil(current.length / 2);
        await send(current.slice(0, middle)); await send(current.slice(middle));
      } else current.forEach((job, index) => job.reject(Object.assign(new Error(error.message, { cause: error }),
        error, portion(error, current, index, warnings))));
      return;
    }
    const warnings = await account(generation, current);
    current.forEach((job, index) => {
      const receipt = portion(generation, current, index, warnings);
      try {
        job.assertCurrent();
        if (current.length === 1) job.resolve(receipt);
        else {
          const results = generation.output?.results;
          const key = request.stateAnalysisTasks[index].key;
          if (!results || typeof results !== 'object' || Array.isArray(results) || !Object.hasOwn(results, key)) {
            throw new Error(`First-stage response omitted ${key}.`);
          }
          job.resolve({ ...receipt, output: results[key] });
        }
      } catch (error) {
        job.reject(Object.assign(error, receipt));
      }
    });
  }

  function flush() {
    if (dispatched || waiting.size) return;
    dispatched = true;
    // Fatal construction errors must settle every waiting member as well.
    void send(jobs).catch(error => jobs.forEach(job => job.reject(error)));
  }
  return {
    generate(id, request, snapshot, assertCurrent) {
      if (!waiting.delete(id)) throw new Error('A request may submit only one first-stage call.');
      const promise = new Promise((resolve, reject) => jobs.push({ id, request, snapshot, assertCurrent, resolve, reject }));
      flush();
      return promise;
    },
    complete(id) { waiting.delete(id); flush(); },
  };
}
