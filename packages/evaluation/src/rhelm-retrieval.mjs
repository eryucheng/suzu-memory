import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-memory/core";
import { syncMemoryEmbeddings } from "@suzu-memory/embedding-indexer";
import { retrieveMemories } from "@suzu-memory/retriever";

import {
  RHELM_CHUNKING_VERSION,
  RHELM_CONTRACT_VERSION,
  RHELM_MEMORY_FORMAT_VERSION,
  createRhelmPersonaPlan,
  loadRhelmDataset,
  rhelmDatasetTreeSha256,
} from "./rhelm-contract.mjs";
import {
  benchmarkPercentile,
  boundedBenchmarkInteger,
  captureBenchmarkEmbeddingUsage,
  cleanBenchmarkValue,
  createEmbeddingRequestGate,
  meanBenchmarkValues,
  summarizeBenchmarkEmbeddingUsage,
} from "./retrieval-benchmark-utils.mjs";

export const RHELM_RETRIEVAL_PROTOCOL_VERSION = "suzu-rhelm-evidence-retrieval-v1";

function unique(values) {
  return [...new Set(values.map(cleanBenchmarkValue).filter(Boolean))];
}

function standardDcg(relevances) {
  return relevances.reduce((sum, relevance, index) => (
    sum + (Number(relevance || 0) / Math.log2(index + 2))
  ), 0);
}

export function evaluateRhelmEvidenceRanking({
  rankedSourceIds = [],
  evidenceSourceIds = [],
  ks = [5, 20, 50],
} = {}) {
  const ranked = rankedSourceIds.map(cleanBenchmarkValue).filter(Boolean);
  const evidence = unique(evidenceSourceIds);
  const evidenceSet = new Set(evidence);
  const metrics = {};
  let reciprocalRank = 0;
  for (let index = 0; index < ranked.length; index += 1) {
    if (evidenceSet.has(ranked[index])) {
      reciprocalRank = 1 / (index + 1);
      break;
    }
  }
  metrics.mrr = reciprocalRank;
  for (const rawK of ks) {
    const k = boundedBenchmarkInteger(rawK, 0, { minimum: 1, maximum: 1000 });
    const topK = ranked.slice(0, k);
    const retrieved = new Set(topK);
    const seenRelevantSources = new Set();
    const relevance = topK.map((sourceId) => {
      if (!evidenceSet.has(sourceId) || seenRelevantSources.has(sourceId)) return 0;
      seenRelevantSources.add(sourceId);
      return 1;
    });
    const ideal = Array.from({ length: Math.min(evidence.length, k) }, () => 1);
    const idealDcg = standardDcg(ideal);
    metrics[`recall_any@${k}`] = Number(
      evidence.length > 0 && evidence.some((sourceId) => retrieved.has(sourceId)),
    );
    metrics[`recall_all@${k}`] = Number(
      evidence.length > 0 && evidence.every((sourceId) => retrieved.has(sourceId)),
    );
    metrics[`source_recall@${k}`] = evidence.length
      ? evidence.filter((sourceId) => retrieved.has(sourceId)).length / evidence.length
      : 0;
    metrics[`ndcg_source@${k}`] = idealDcg > 0 ? standardDcg(relevance) / idealDcg : 0;
  }
  return metrics;
}

const ALLOWED_MEMORY_METADATA_KEYS = new Set([
  "benchmark",
  "chunkCount",
  "chunkOrdinal",
  "dateProvenance",
  "formatVersion",
  "sourceFile",
  "sourceId",
  "sourceType",
]);

export function assertRhelmPlanHasNoGoldLabels(plan) {
  for (const memory of plan.memories) {
    const unknownKeys = Object.keys(memory.metadata || {})
      .filter((key) => !ALLOWED_MEMORY_METADATA_KEYS.has(key));
    if (unknownKeys.length) {
      throw new Error(`RHELM 记忆 metadata 含未允许字段：${unknownKeys.join(", ")}。`);
    }
    if (/supporting_?evidence|expected_?answer|question_?type|characteristics/iu.test(
      JSON.stringify(Object.keys(memory.metadata || {})),
    )) {
      throw new Error("RHELM 记忆 metadata 包含评测标签字段。");
    }
    if (cleanBenchmarkValue(memory.id).includes(cleanBenchmarkValue(memory.metadata?.sourceId))) {
      throw new Error("RHELM 记忆 ID 不得直接暴露来源 ID。");
    }
  }
  return true;
}

function setBenchmarkDatabaseIdentity(database, datasetSha256) {
  const key = "benchmark.rhelm.dataset_sha256";
  const existing = database.prepare("SELECT value FROM memory_meta WHERE key = ?").get(key);
  if (existing?.value && existing.value !== datasetSha256) {
    throw new Error("目标数据库已绑定另一份 RHELM 数据集；请换一个数据库路径。");
  }
  if (!existing?.value) {
    const memoryCount = Number(
      database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get()?.count || 0,
    );
    if (memoryCount > 0) throw new Error("RHELM 评测只能使用空数据库或同数据集的评测数据库。");
  }
  database.prepare(`
    INSERT INTO memory_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, datasetSha256);
  database.prepare(`
    INSERT INTO memory_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run("benchmark.rhelm.memory_format", RHELM_MEMORY_FORMAT_VERSION);
}

function clearRhelmAgent(database, agentId) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM memory_fts WHERE agent_id = ?").run(agentId);
    database.prepare("DELETE FROM memory_nodes WHERE agent_id = ?").run(agentId);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function clearRhelmScratchDatabase(database) {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare("DELETE FROM memory_fts WHERE agent_id LIKE 'rhelm-%'").run();
    database.prepare("DELETE FROM memory_nodes WHERE agent_id LIKE 'rhelm-%'").run();
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function insertMemories(repository, memories) {
  if (!memories.length) return;
  const database = repository.database;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const memory of memories) repository.upsertMemory(memory);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function groupRows(rows, selector, ks) {
  const grouped = new Map();
  for (const row of rows) {
    for (const rawKey of selector(row)) {
      const key = cleanBenchmarkValue(rawKey);
      if (!key) continue;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
  }
  return Object.fromEntries([...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entries]) => [key, aggregateRows(entries, ks)]));
}

function aggregateRows(rows, ks) {
  const metricNames = ["mrr"];
  for (const k of ks) {
    metricNames.push(
      `recall_any@${k}`,
      `recall_all@${k}`,
      `source_recall@${k}`,
      `ndcg_source@${k}`,
    );
  }
  return {
    cases: rows.length,
    metrics: Object.fromEntries(metricNames.map((name) => [
      name,
      meanBenchmarkValues(rows.map((row) => row.metrics[name])),
    ])),
  };
}

function reportScope(rows, ks) {
  return {
    ...aggregateRows(rows, ks),
    byQuestionType: groupRows(rows, (row) => [row.questionType], ks),
    byCharacteristic: groupRows(rows, (row) => row.characteristics, ks),
  };
}

function selectedQuestionMap(dataset, { personas = [], start = 0, maximumQuestions } = {}) {
  const allowed = new Set(personas.map(cleanBenchmarkValue).filter(Boolean));
  const flattened = dataset.personas.filter((persona) => (
    !allowed.size || allowed.has(persona.persona)
  )).flatMap((persona) => persona.questions.map((question) => ({
    persona: persona.persona,
    question,
  })));
  const selectedStart = boundedBenchmarkInteger(start, 0, {
    minimum: 0,
    maximum: flattened.length,
  });
  const limit = boundedBenchmarkInteger(maximumQuestions, flattened.length, {
    minimum: 1,
    maximum: flattened.length,
  });
  const selected = flattened.slice(selectedStart, selectedStart + limit);
  const byPersona = new Map();
  for (const entry of selected) {
    if (!byPersona.has(entry.persona)) byPersona.set(entry.persona, []);
    byPersona.get(entry.persona).push(entry.question);
  }
  return { flattened, selectedStart, selected, byPersona };
}

export async function runRhelmRetrievalBenchmark({
  datasetRoot,
  databasePath,
  personas = [],
  start = 0,
  maximumQuestions = Number.MAX_SAFE_INTEGER,
  ks = [5, 20, 50],
  retrieverOptions = {},
  embeddingProvider = null,
  embeddingRequestIntervalMs = 0,
  onProgress = null,
} = {}) {
  const normalizedRoot = path.resolve(cleanBenchmarkValue(datasetRoot));
  const normalizedDatabasePath = path.resolve(cleanBenchmarkValue(databasePath));
  if (!fs.existsSync(normalizedRoot)) throw new Error(`RHELM 数据目录不存在：${normalizedRoot}`);
  const dataset = loadRhelmDataset(normalizedRoot);
  const datasetSha256 = rhelmDatasetTreeSha256(normalizedRoot);
  const selection = selectedQuestionMap(dataset, { personas, start, maximumQuestions });
  if (!selection.selected.length) throw new Error("RHELM 选定范围没有评测问题。");
  const normalizedKs = unique(ks).map((value) => boundedBenchmarkInteger(value, 0, {
    minimum: 1,
    maximum: 1000,
  })).sort((left, right) => left - right);
  const maximumK = Math.max(...normalizedKs);
  const embeddingUsageRecords = [];
  const requestGate = createEmbeddingRequestGate(embeddingRequestIntervalMs);
  const indexEmbeddingProvider = captureBenchmarkEmbeddingUsage(
    embeddingProvider,
    "index",
    embeddingUsageRecords,
    requestGate,
  );
  const queryEmbeddingProvider = captureBenchmarkEmbeddingUsage(
    embeddingProvider,
    "query",
    embeddingUsageRecords,
    requestGate,
  );
  const startedAt = new Date();
  const startedPerformance = performance.now();
  const database = openMemoryDatabase(normalizedDatabasePath);
  const repository = new MemoryRepository(database);
  setBenchmarkDatabaseIdentity(database, datasetSha256);
  clearRhelmScratchDatabase(database);
  let memoriesIndexed = 0;
  let uniqueSourcesIndexed = 0;
  const results = [];
  try {
    for (const personaData of dataset.personas) {
      const selectedQuestions = selection.byPersona.get(personaData.persona);
      if (!selectedQuestions?.length) continue;
      const plan = createRhelmPersonaPlan(personaData, datasetSha256);
      assertRhelmPlanHasNoGoldLabels(plan);
      let sourceCursor = 0;
      let indexedSourceIds = new Set();
      try {
        for (const [questionIndex, question] of selectedQuestions.entries()) {
          const pending = [];
          while (
            sourceCursor < plan.sources.length
            && plan.sources[sourceCursor].sourceDate <= question.questionDate
          ) {
            pending.push(plan.memories[sourceCursor]);
            indexedSourceIds.add(plan.sources[sourceCursor].sourceId);
            sourceCursor += 1;
          }
          insertMemories(repository, pending);
          memoriesIndexed += pending.length;
          uniqueSourcesIndexed += new Set(pending.map((memory) => memory.metadata.sourceId)).size;
          if (indexEmbeddingProvider && pending.length) {
            const embeddingIndex = await syncMemoryEmbeddings({
              repository,
              agentId: plan.agentId,
              embeddingProvider: indexEmbeddingProvider,
              batchSize: 10,
              continueOnError: false,
            });
            if (embeddingIndex.status !== "ready") {
              throw new Error(`RHELM ${personaData.persona} embedding 索引未就绪。`);
            }
          }
          const retrievalStarted = performance.now();
          const retrieval = await retrieveMemories({
            databasePath: normalizedDatabasePath,
            agentId: plan.agentId,
            query: question.question,
            now: question.questionDate,
            embeddingProvider: queryEmbeddingProvider,
            options: {
              ...retrieverOptions,
              maximumCandidates: Math.max(
                maximumK,
                boundedBenchmarkInteger(retrieverOptions.maximumCandidates, 50, { minimum: 1 }),
              ),
              maximumReturnedCandidates: maximumK,
            },
          });
          const candidateMemoryIds = (retrieval.candidates || []).map((candidate) => candidate.memoryId);
          const rankedSourceIds = candidateMemoryIds.map((memoryId) => (
            plan.memoryIdToSourceId.get(memoryId)
          )).filter(Boolean);
          const futureCandidateIds = candidateMemoryIds.filter((memoryId) => (
            plan.memoryIdToSourceDate.get(memoryId) > question.questionDate
          ));
          if (futureCandidateIds.length) {
            throw new Error(`RHELM ${personaData.persona}/${question.id} 检索泄漏未来记忆。`);
          }
          const metrics = evaluateRhelmEvidenceRanking({
            rankedSourceIds,
            evidenceSourceIds: question.evidenceSourceIds,
            ks: normalizedKs,
          });
          const row = {
            persona: personaData.persona,
            questionId: question.id,
            questionType: question.questionType,
            characteristics: question.characteristics,
            characteristicsMissing: question.characteristicsMissing,
            questionDate: question.originalQuestionDate,
            temporallyValid: question.temporallyValid,
            futureEvidenceSourceIds: question.futureEvidenceSourceIds,
            evidenceSources: question.evidenceSourceIds.length,
            indexedSources: indexedSourceIds.size,
            rankedSourceIds,
            candidateChunks: candidateMemoryIds.length,
            retrievalStatus: retrieval.status,
            retrievalMode: retrieval.retrievalMode || "",
            vectorStatus: retrieval.vector?.status || "disabled",
            vectorIndexedMemories: Number(retrieval.vector?.indexedMemories || 0),
            latencyMs: performance.now() - retrievalStarted,
            metrics,
          };
          results.push(row);
          if (typeof onProgress === "function") {
            onProgress({
              phase: "retrieve",
              completed: results.length,
              total: selection.selected.length,
              persona: personaData.persona,
              questionIndex: questionIndex + 1,
              questionsForPersona: selectedQuestions.length,
              row,
            });
          }
        }
      } finally {
        clearRhelmAgent(database, plan.agentId);
      }
    }
  } finally {
    database.close();
  }
  const finishedAt = new Date();
  const latencies = results.map((row) => row.latencyMs);
  const temporallyCompatible = results.filter((row) => row.temporallyValid);
  return {
    protocol: {
      name: "RHELM evidence-source retrieval",
      version: RHELM_RETRIEVAL_PROTOCOL_VERSION,
      contractVersion: RHELM_CONTRACT_VERSION,
      memoryFormatVersion: RHELM_MEMORY_FORMAT_VERSION,
      task: "retrieval-only",
      officialQaEvaluated: false,
      officialLlmJudgeEvaluated: false,
      metricStatus: "Suzu diagnostic; not the official RHELM QA score",
      granularity: {
        conversation: "individual user-assistant turn",
        external: "fixed whitespace-token chunks",
      },
      externalChunkingVersion: RHELM_CHUNKING_VERSION,
      goldLabelsStoredInMemory: false,
      futureSourcesVisible: false,
    },
    dataset: {
      root: normalizedRoot,
      sha256: datasetSha256,
      totalPersonas: dataset.personas.length,
      totalQuestions: dataset.personas.reduce((sum, persona) => sum + persona.questions.length, 0),
      eligibleQuestions: selection.flattened.length,
      selectedStart: selection.selectedStart,
      selectedQuestions: selection.selected.length,
      selectedPersonas: [...selection.byPersona.keys()],
      chunking: dataset.chunking,
    },
    database: {
      path: normalizedDatabasePath,
      memoriesIndexed,
      uniqueSourcesIndexed,
      retention: "scratch-cleared-after-each-persona",
    },
    run: {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: performance.now() - startedPerformance,
      ks: normalizedKs,
      maximumReturnedCandidates: maximumK,
      embeddingEnabled: Boolean(embeddingProvider),
      embeddingRequestIntervalMs: Math.max(
        0,
        Math.trunc(Number(embeddingRequestIntervalMs) || 0),
      ),
      embeddingUsage: summarizeBenchmarkEmbeddingUsage(
        embeddingUsageRecords,
        finishedAt.toISOString(),
      ),
    },
    scores: {
      all: reportScope(results, normalizedKs),
      temporallyCompatible: reportScope(temporallyCompatible, normalizedKs),
    },
    diagnostics: {
      temporalInconsistencyCases: results.length - temporallyCompatible.length,
      missingCharacteristicsCases: results.filter((row) => row.characteristicsMissing).length,
      emptyRetrievals: results.filter((row) => row.candidateChunks === 0).length,
      meanLatencyMs: meanBenchmarkValues(latencies),
      p50LatencyMs: benchmarkPercentile(latencies, 0.5),
      p95LatencyMs: benchmarkPercentile(latencies, 0.95),
      maximumLatencyMs: latencies.length ? Math.max(...latencies) : null,
    },
    results,
  };
}
