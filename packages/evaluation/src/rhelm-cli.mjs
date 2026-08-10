#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resolveMemoryDataRoot } from "@suzu-memory/runtime";
import { createOpenAiCompatibleEmbeddingProvider } from "@suzu-memory/providers";

import {
  loadRhelmDataset,
  rhelmDatasetTreeSha256,
} from "./rhelm-contract.mjs";
import { runRhelmRetrievalBenchmark } from "./rhelm-retrieval.mjs";
import {
  memoryEmbeddingProviderFromConnection,
  resolveMemoryEmbeddingConnection,
} from "./embedding-connection.mjs";

export function memoryRhelmUsage() {
  return "node packages/evaluation/src/rhelm-cli.mjs --dataset-root <RHELM目录> --database <benchmark.db> [--output <report.json>] [--persona <人物名,人物名>] [--start <0-1304>] [--max-questions <1-1305>] [--with-embedding] [--embedding-interval-ms <0-10000>] [--data-root <软件数据目录>] [--dry-run]";
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (token === "--with-embedding") {
      options.withEmbedding = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`不支持位置参数：${token}。`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`选项 ${token} 缺少值。`);
    const key = token.slice(2);
    if (![
      "dataset-root",
      "database",
      "output",
      "persona",
      "start",
      "max-questions",
      "data-root",
      "embedding-interval-ms",
    ].includes(key)) {
      throw new Error(`不支持选项 ${token}。`);
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

function clean(value) {
  return String(value ?? "").trim();
}

function numericOption(value, fallback, label) {
  if (value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) throw new Error(`${label} 必须是整数。`);
  return numeric;
}

function softwareDataRoot(value, environment) {
  return resolveMemoryDataRoot({
    configuredRoot: clean(value) || clean(environment.SUZU_MEMORY_DATA_ROOT),
    localAppData: clean(environment.LOCALAPPDATA),
    fallbackBase: "",
  });
}

function selectedPersonas(value) {
  return [...new Set(clean(value).split(",").map((entry) => entry.trim()).filter(Boolean))];
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function progressPrinter(event) {
  if (event.completed !== event.total && event.completed % 25 !== 0) return;
  process.stderr.write(`${JSON.stringify({
    phase: event.phase,
    completed: event.completed,
    total: event.total,
    persona: event.persona,
  })}\n`);
}

export async function runMemoryRhelmCli({
  args = process.argv.slice(2),
  environment = process.env,
  connectionResolver = null,
  embeddingProviderFactory = createOpenAiCompatibleEmbeddingProvider,
} = {}) {
  const options = parseArgs(args);
  if (!options["dataset-root"]) throw new Error(memoryRhelmUsage());
  const datasetRoot = path.resolve(options["dataset-root"]);
  if (!fs.existsSync(datasetRoot)) throw new Error(`RHELM 数据目录不存在：${datasetRoot}`);
  const personas = selectedPersonas(options.persona);
  if (options.dryRun) {
    const dataset = loadRhelmDataset(datasetRoot);
    const allQuestions = dataset.personas.flatMap((persona) => persona.questions);
    const result = {
      status: "validated",
      task: "retrieval-only",
      datasetRoot,
      datasetSha256: rhelmDatasetTreeSha256(datasetRoot),
      personas: dataset.personas.length,
      questions: allQuestions.length,
      sourceMemories: dataset.personas.reduce((sum, persona) => sum + persona.sources.length, 0),
      temporallyInconsistentCases: allQuestions.filter((question) => !question.temporallyValid).length,
      missingCharacteristicsCases: allQuestions.filter((question) => question.characteristicsMissing).length,
      chunking: dataset.chunking,
      note: "dry-run 只校验 RHELM 数据、证据和时间契约，不建库、不调用检索器。",
    };
    emit(result);
    return result;
  }
  if (!options.database) throw new Error(memoryRhelmUsage());
  let embeddingProvider = null;
  if (options.withEmbedding) {
    const dataRoot = softwareDataRoot(options["data-root"], environment);
    const connection = await resolveMemoryEmbeddingConnection({
      connectionResolver,
      dataRoot,
      agentId: "benchmark-rhelm",
      environment,
    });
    embeddingProvider = memoryEmbeddingProviderFromConnection(
      connection,
      embeddingProviderFactory,
    );
  }
  const report = await runRhelmRetrievalBenchmark({
    datasetRoot,
    databasePath: path.resolve(options.database),
    personas,
    start: numericOption(options.start, 0, "--start"),
    maximumQuestions: numericOption(
      options["max-questions"],
      Number.MAX_SAFE_INTEGER,
      "--max-questions",
    ),
    embeddingProvider,
    embeddingRequestIntervalMs: numericOption(
      options["embedding-interval-ms"],
      0,
      "--embedding-interval-ms",
    ),
    onProgress: progressPrinter,
  });
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.outputPath = outputPath;
  }
  emit(report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMemoryRhelmCli().catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  });
}
