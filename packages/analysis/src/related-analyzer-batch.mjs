import fs from "node:fs";
import path from "node:path";
import { analysisSystemPrompt, analysisSourceMaterial } from "./source-material.mjs";
import { isStateAnalysisBudgetError, stateAnalysisBudgetError } from "./request-budget.mjs";
import { analysisCountLimit, analysisSchemaForCount } from './analysis-output.mjs';
import { mergeEventSourceMaterials, assertEventSourceExecutionCurrent } from '@suzu-memory/core';
import { stateMatchAnalysisSchema } from './state-memory-candidates.mjs';
import { createHash } from 'node:crypto';
import { appendUsageEvent } from '@suzu-memory/usage-ledger';

function clean(value) {
  return String(value ?? "").trim();
}

function providerRequest(request, snapshot = request.analysisSnapshot) {
  const { analysisSnapshot, renderAnalysisInput, ...provided } = request;
  return { ...provided, input: renderAnalysisInput ? renderAnalysisInput(snapshot) : provided.input };
}

function sameSnapshot(calls) {
  const snapshots = calls.map((call) => call.request.analysisSnapshot);
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

function combinedPrompt(calls, snapshot) {
  const sections = calls.map((call) => [
    `## results.${call.key} (${call.request.analyzerRole})`,
    clean(call.request.systemPrompt),
  ].join("\n"));
  return analysisSystemPrompt([
    "分别完成以下专职分析，将结果写入 results.<key>。各职责独立依据同一快照判断，一个职责的推断不能替另一个职责补齐证据。",
    ...sections,
  ].join("\n\n"), snapshot);
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

function noCurrentStateGeneration(request, snapshot = request.analysisSnapshot) {
  if (!snapshot || snapshot.currentState || snapshot.relationshipComparison) return null;
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
      if (required.includes("comparisonMemoryId")) {
        result.comparisonMemoryId = "";
        result.comparisonRelation = "no_comparison";
        result.comparisonScopeOverlap = "unknown";
      }
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
    analysisSnapshot: snapshot,
    renderAnalysisInput: value => combinedInput(calls, value),
    systemPrompt: combinedPrompt(calls, snapshot),
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
    generator.assertRequestBudget?.(providerRequest(request));
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
  function rejectCalls(calls, error) {
    onGenerationError(error);
    if (isStateAnalysisBudgetError(error)) onBudgetExceeded(error);
    calls.forEach(call => call.reject(error));
  }
  function enqueue(key, definition, input) {
    const decorated = decorate(input);
    if ((!stateContext || (stateContext.resolved && !stateContext.selected))
      && definition.role === "current-relation" && generator.supportsCombinedStateAnalysis === true) {
      const deterministic = noCurrentStateGeneration(decorated);
      if (deterministic) return Promise.resolve({ ...deterministic, metadata: { ...deterministic.metadata, stateAnalysisRequestId: request.id } });
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
          let stateResolutionError = null;
          for (const plan of plans) {
            if (stateResolutionError && stateContext && !stateContext.resolved
              && plan.calls.some(call => phaseFor(call.definition) === "comparison")) {
              rejectCalls(plan.calls, stateResolutionError);
              continue;
            }
            try {
              const snapshot = stateContext?.resolved
                ? stateContext.refresh(plan.request.analysisSnapshot) : plan.request.analysisSnapshot;
              let actualRequest = providerRequest(plan.request, snapshot);
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
                  'stateCandidates 仅供匹配；evidenceOnly 标记尚未形成状态的已有证据。',
                  '身份字段不同、关系对象或方向不同、关系维度不同均是不同状态；婚恋状态与对某个人的关系观点分开。',
                  'analysis 字段分别完成下述专职分析，stateMatch 仅判断是否为同一事项。',
                  actualRequest.systemPrompt,
                ].join('\n\n'),
              };
              generator.assertRequestBudget?.(actualRequest);
              const deterministic = !resolveIdentity && plan.calls.length === 1
                && plan.calls[0].definition.role === 'current-relation' && generator.supportsCombinedStateAnalysis === true
                ? noCurrentStateGeneration(actualRequest, snapshot) : null;
              let generation = deterministic || await generator(actualRequest);
              if (resolveIdentity) {
                stateContext.resolve(generation?.output?.stateMatch);
                generation = { ...generation, output: generation.output.analysis };
              }
              generation = { ...generation, metadata: { ...generation.metadata,
                analysisInputHash: createHash('sha256').update(actualRequest.input).digest('hex'),
                analysisSchemaName: actualRequest.schemaName, stateAnalysisRequestId: request.id } };
              const outputs = plan.calls.length === 1 ? [generation] : splitGeneration(generation, plan.calls);
              plan.calls.forEach((call, index) => call.resolve(outputs[index]));
            } catch (error) {
              assertEventSourceExecutionCurrent();
              if (stateContext && !stateContext.resolved) stateResolutionError = error;
              rejectCalls(plan.calls, error);
            }
          }
        } catch (error) {
          rejectCalls(calls, error);
        }
      });
    });
  }

  return Object.fromEntries(Object.entries(definitions).map(([key, definition]) => [
    key,
    (input) => enqueue(key, definition, input),
  ]));
}

// Reuse only results from the identical evidence, prompt and schema. Runs remain
// the durable owner; retries send just the bounded memories rejected previously.
export function analyzerContractHash(input, systemPrompt, definition) {
  return createHash('sha256').update(JSON.stringify([input, systemPrompt, definition.promptVersion, definition.schemaName, definition.schema])).digest('hex');
}

export function prepareAnalyzerReplay(previousRuns, definition, contractHash, snapshot) {
  const run = previousRuns.find(run => run.analyzer_role === definition.role
    && run.metadata?.analysisContractHash === contractHash
    && Array.isArray(run.metadata?.acceptedAnalyses));
  if (!run) return { snapshot, analyses: [], runId: '' };
  const analyses = run.metadata.acceptedAnalyses;
  const retryIds = new Set(run.metadata.retryMemoryIds || snapshot.memories.map(memory => memory.id));
  const memories = snapshot.memories.filter(memory => retryIds.has(memory.id));
  if (!memories.length) return { snapshot: null, analyses, runId: run.id, analysisRequestId: clean(run.metadata.stateAnalysisRequestId) };
  const sourceIds = new Set(memories.flatMap(memory => memory.sourceIds));
  return { snapshot: { ...snapshot, memories,
    sourceRecords: snapshot.sourceRecords.filter(source => sourceIds.has(source.id)) }, analyses, runId: run.id, analysisRequestId: clean(run.metadata.stateAnalysisRequestId) };
}

export async function invokeEvidenceAnalyzer({ definition, generator, snapshot, promptDirectory, maximumAnalyses,
  previousRuns = [], buildInput, prepareInputSnapshot = value => value, parseGeneration, enforceBoundary, analysisKey = definition.role }) {
  const systemPrompt = analysisSystemPrompt(fs.readFileSync(
    path.join(path.resolve(promptDirectory), definition.promptFile), 'utf8').replace(/^\uFEFF/u, '').trim(), snapshot);
  const inputSnapshot = value => {
    const prepared = prepareInputSnapshot(value, definition);
    const { inputPolicy, ...evidence } = prepared;
    if (!inputPolicy) return evidence;
    return { ...evidence, inputPolicy: Object.fromEntries([
      'memoryNarratorActorKey', 'firstPersonInMemoryRefersToOwner',
      'firstPersonInUtterancesAndSourcesRefersToSpeaker', 'stateTimeInterpretation',
    ].filter(key => Object.hasOwn(inputPolicy, key)).map(key => [key, inputPolicy[key]])) };
  };
  const renderInput = value => buildInput(value, definition);
  const schemaForSnapshot = value => analysisSchemaForCount(definition.schema, value.memories.length,
    new Set([...value.memories.map(memory => memory.id), ...(value.comparisonMemories || []).map(memory => memory.memoryId)]).size);
  const fullInputSnapshot = inputSnapshot(snapshot);
  const input = renderInput(fullInputSnapshot);
  const schema = schemaForSnapshot(fullInputSnapshot);
  const contractHash = analyzerContractHash(input, systemPrompt, { ...definition, schema });
  const replay = prepareAnalyzerReplay(previousRuns, definition, contractHash, snapshot);
  const sourceSnapshot = replay.snapshot || snapshot;
  let generation = null;
  try {
    const limit = analysisCountLimit(maximumAnalyses);
    if (snapshot.memories.length > limit) {
      throw stateAnalysisBudgetError(`Complete analysis requires ${snapshot.memories.length} judgments; maximumAnalyses is ${limit}.`);
    }
    const sourceMaterial = analysisSourceMaterial(sourceSnapshot);
    const requestSnapshot = inputSnapshot(sourceSnapshot);
    generation = replay.snapshot ? await generator({
      input: renderInput(requestSnapshot), systemPrompt,
      analysisSnapshot: requestSnapshot, renderAnalysisInput: renderInput,
      schema: schemaForSnapshot(requestSnapshot), schemaName: definition.schemaName,
      stateFamily: definition.stateFamily, analyzerRole: definition.role,
      ...(sourceMaterial ? { sourceMaterial } : {}),
    }) : { output: { analyses: [] }, model: 'local-analysis-replay', usage: null };
    const rejected = [];
    // Retain valid siblings even when a provider duplicates an entry. Accepted
    // results are bounded by the distinct supplied memory IDs below.
    const fresh = parseGeneration(analysisKey, generation?.output, {
      onRejected: item => rejected.push(item) }).analyses;
    const cached = parseGeneration(analysisKey, { analyses: replay.analyses }, { maximumAnalyses: snapshot.memories.length }).analyses;
    const accepted = [];
    const seen = new Set();
    for (const [index, item] of [...cached, ...fresh].entries()) {
      try {
        if (seen.has(item.memoryId)) throw new Error('An analyzer can analyze each memory at most once.');
        if (!cached.includes(item) && replay.snapshot
          && !replay.snapshot.memories.some(memory => memory.id === item.memoryId)) {
          throw new Error('Analyzer retry exceeded its remaining memory boundary.');
        }
        const bounded = enforceBoundary(analysisKey, item, snapshot);
        if (!bounded) continue;
        accepted.push(bounded);
        seen.add(item.memoryId);
      } catch (error) {
        assertEventSourceExecutionCurrent();
        rejected.push({ index, memoryId: item.memoryId, error: error.message });
      }
    }
    const invalidIds = new Set(rejected.map(item => item.memoryId));
    const analyses = accepted.filter(item => !invalidIds.has(item.memoryId));
    const validIds = new Set(analyses.map(item => item.memoryId));
    const knownIds = new Set(snapshot.memories.map(memory => memory.id));
    const unknownRejection = rejected.some(item => !knownIds.has(item.memoryId));
    const retryMemoryIds = snapshot.memories.filter(memory => invalidIds.has(memory.id)
      || (unknownRejection && !validIds.has(memory.id))).map(memory => memory.id);
    return { definition, input, generation, contractHash, reusedRunId: replay.runId, analysisRequestId: replay.analysisRequestId || "",
      retryMemoryIds, analyses, rejected,
      status: analyses.length ? 'completed' : rejected.length ? 'rejected' : 'abstained', error: '' };
  } catch (error) {
    assertEventSourceExecutionCurrent();
    return { definition, input, generation, contractHash, reusedRunId: replay.runId, analysisRequestId: replay.analysisRequestId || "",
      retryMemoryIds: sourceSnapshot.memories.map(memory => memory.id),
      analyses: replay.analyses, rejected: [], status: 'failed', error: error.message };
  }
}

export function analyzerRunMetadata(invocation) {
  return { stateAnalysisRequestId: clean(invocation.generation?.metadata?.stateAnalysisRequestId) || clean(invocation.analysisRequestId),
    analysisContractHash: invocation.contractHash, acceptedAnalyses: invocation.analyses,
    reusedAnalysisRunId: invocation.reusedRunId || '', retryMemoryIds: invocation.retryMemoryIds };
}

export function priorAnalyzerRuns(repository, snapshot, batchId, definitions, snapshotOptions) {
  return snapshotOptions.reuseAnalysisRuns ? repository.listStateAnalysisRuns(snapshot.agentId, {
    stateFamily: snapshot.target.stateFamily || definitions[0][1].stateFamily, batchId,
    limit: definitions.length * 3,
  }) : [];
}

// Each family owns its evidence semantics; execution records and usage have one owner.
export async function recordAnalyzerInvocations({ repository, agentId, batchId, stateFamily,
  snapshot, invocations, usageLedgerPath = '', metadata = {}, usageFeature = null }) {
  const runs = {}, analyses = {}, rejected = {}, warnings = [];
  const materials = new Map();
  for (const [key, invocation] of invocations) {
    const currentSnapshot = typeof snapshot === 'function' ? snapshot(key) : snapshot;
    const family = stateFamily || invocation.definition.stateFamily;
    const generation = invocation.generation;
    if (!materials.has(currentSnapshot)) materials.set(currentSnapshot, analysisSourceMaterial(currentSnapshot));
    if (clean(usageLedgerPath) && generation?.model && generation?.usage) {
      try {
        await appendUsageEvent(path.resolve(usageLedgerPath), {
          agentId: clean(agentId), provider: generation.metadata?.provider || '', model: generation.model,
          source: 'memory-evaluation', feature: usageFeature
            ? usageFeature(key, invocation.definition) : 'memory-' + family.replaceAll('_', '-') + '-' + invocation.definition.role,
          requestId: generation.requestId || '', usage: generation.usage,
          metadata: { batchId, durationMs: Number(generation.durationMs || 0), ...generation.metadata },
        });
      } catch (error) {
        assertEventSourceExecutionCurrent();
        warnings.push('费用流水写入失败：' + error.message);
      }
    }
    runs[key] = repository.recordStateAnalysisRun({ sourceMaterial: materials.get(currentSnapshot),
      agentId: clean(agentId), batchId, stateFamily: family, analyzerRole: invocation.definition.role,
      subjectRole: currentSnapshot.target.subjectRole, subjectKey: currentSnapshot.target.subjectKey,
      canonicalKey: currentSnapshot.target.canonicalKey,
      provider: clean(generation?.metadata?.provider) || 'unreported', model: clean(generation?.model) || 'unreported',
      promptVersion: invocation.definition.promptVersion, schemaVersion: invocation.definition.schemaName,
      inputHash: generation?.metadata?.analysisInputHash || createHash('sha256').update(invocation.input).digest('hex'),
      status: invocation.status, memoryIds: currentSnapshot.memories.map(memory => memory.id),
      sourceIds: [...new Set(currentSnapshot.memories.flatMap(memory => memory.sourceIds))].sort(),
      output: generation?.output ?? {}, rejected: invocation.rejected, usage: generation?.usage || {},
      costAmount: Number(generation?.costAmount ?? generation?.metadata?.costAmount ?? 0) || 0,
      costCurrency: clean(generation?.costCurrency ?? generation?.metadata?.costCurrency),
      requestId: clean(generation?.requestId), durationMs: Math.max(0, Math.trunc(Number(generation?.durationMs) || 0)),
      errorMessage: invocation.error,
      metadata: { ...analyzerRunMetadata(invocation), ...(typeof metadata === 'function' ? metadata(key) : metadata) },
    });
    analyses[key] = invocation.analyses;
    rejected[key] = invocation.rejected;
  }
  return { runs, analyses, rejected, warnings,
    failedRoles: invocations.map(([key]) => key).filter(key =>
      ['failed', 'rejected'].includes(runs[key].status) || rejected[key].length > 0),
    hasAnyAnalysis: Object.values(analyses).some(items => items.length > 0),
  };
}
