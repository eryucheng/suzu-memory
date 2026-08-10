#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createProvidersFromMemoryConfig,
  loadMemoryConfig,
} from "@suzu-memory/config";

import {
  loadZh4oDataset,
  zh4oDatasetSha256,
} from "./zh4o-contract.mjs";
import { runZh4oMemorySystemBenchmark } from "./zh4o-system.mjs";

export function memoryZh4oSystemUsage() {
  return "node packages/evaluation/src/zh4o-system-cli.mjs --dataset <zh4o-data.json> --config <memory.config.json> --work-dir <专用评测目录> [--start-sample <0-27>] [--max-samples <样本数>] [--max-questions-per-sample <题数>] [--candidate-k <默认9>] [--maximum-events <每批消息数>] [--maximum-content-characters <每批字符数>] [--maximum-context-characters <作答上下文字符数>] [--maximum-semantic-passes <维护轮数>] [--embedding-interval-ms <0-10000>] [--without-embedding] [--retain-sample-databases] [--resume-sample-databases] [--output <report.json>] [--dry-run]";
}

function clean(value) {
  return String(value ?? "").trim();
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (["--help", "-h"].includes(token)) {
      options.help = true;
      continue;
    }
    if ([
      "--dry-run",
      "--without-embedding",
      "--retain-sample-databases",
      "--resume-sample-databases",
    ].includes(token)) {
      options[token.slice(2)] = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error(`不支持位置参数：${token}。`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`选项 ${token} 缺少值。`);
    const key = token.slice(2);
    if (![
      "dataset",
      "config",
      "work-dir",
      "output",
      "start-sample",
      "max-samples",
      "max-questions-per-sample",
      "candidate-k",
      "embedding-interval-ms",
      "maximum-events",
      "maximum-content-characters",
      "maximum-context-characters",
      "maximum-semantic-passes",
    ].includes(key)) throw new Error(`不支持选项 ${token}。`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function integer(value, fallback, label, { minimum = Number.MIN_SAFE_INTEGER } = {}) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) throw new Error(`${label} 必须是大于等于 ${minimum} 的整数。`);
  return number;
}

function detectCodeRevision(repositoryRoot = path.resolve(import.meta.dirname, "../../..")) {
  try {
    return {
      commit: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim(),
      dirty: Boolean(execFileSync("git", ["status", "--short", "--untracked-files=normal"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
      }).trim()),
    };
  } catch {
    return { commit: "", dirty: null };
  }
}

function emit(value, stdout = process.stdout) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function progressPrinter(event) {
  if (event.completed !== event.total && event.completed % 20 !== 0) return;
  process.stderr.write(`${JSON.stringify({
    phase: event.phase,
    sample: event.sample,
    samples: event.samples,
    completed: event.completed,
    total: event.total,
    category: event.row?.category,
    status: event.row?.status,
    candidates: event.row?.candidateCount,
    correct: event.row?.correct,
  })}\n`);
}

export async function runMemoryZh4oSystemCli({
  args = process.argv.slice(2),
  environment = process.env,
  fetchImpl = globalThis.fetch,
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(args);
  if (options.help) {
    const usage = memoryZh4oSystemUsage();
    stdout.write(`${usage}\n`);
    return { status: "help", usage };
  }
  if (!options.dataset) throw new Error(memoryZh4oSystemUsage());
  const datasetPath = path.resolve(options.dataset);
  if (!fs.existsSync(datasetPath)) throw new Error(`ZH-4O 数据集不存在：${datasetPath}`);
  if (options["dry-run"]) {
    const samples = loadZh4oDataset(datasetPath);
    const result = {
      status: "validated",
      task: "zh4o-roleplay-memory-multiple-choice",
      datasetPath,
      datasetSha256: zh4oDatasetSha256(datasetPath),
      samples: samples.length,
      sessions: samples.reduce((sum, item) => sum + item.sessions.length, 0),
      turns: samples.reduce((sum, item) => (
        sum + item.sessions.reduce((inner, session) => inner + session.turns.length, 0)
      ), 0),
      questions: samples.reduce((sum, item) => sum + item.questions.length, 0),
      note: "dry-run 只校验公开 ZH-4O 数据契约，不建库、不调用 Provider。",
    };
    emit(result);
    return result;
  }
  if (!options.config || !options["work-dir"]) throw new Error(memoryZh4oSystemUsage());
  const config = loadMemoryConfig(path.resolve(options.config));
  const providers = createProvidersFromMemoryConfig(config, { environment, fetchImpl });
  if (typeof providers.generator !== "function") {
    throw new Error("完整 ZH-4O 评测的 config 必须配置 generation provider。 ");
  }
  const report = await runZh4oMemorySystemBenchmark({
    datasetPath,
    workDirectory: path.resolve(options["work-dir"]),
    startSample: integer(options["start-sample"], 0, "--start-sample", { minimum: 0 }),
    maximumSamples: integer(options["max-samples"], Number.MAX_SAFE_INTEGER, "--max-samples", { minimum: 1 }),
    maximumQuestionsPerSample: integer(
      options["max-questions-per-sample"],
      Number.MAX_SAFE_INTEGER,
      "--max-questions-per-sample",
      { minimum: 1 },
    ),
    candidateK: integer(options["candidate-k"], 9, "--candidate-k", { minimum: 1 }),
    maximumEvents: integer(options["maximum-events"], 50, "--maximum-events", { minimum: 1 }),
    maximumContentCharacters: integer(
      options["maximum-content-characters"],
      24_000,
      "--maximum-content-characters",
      { minimum: 1_000 },
    ),
    maximumContextCharacters: integer(
      options["maximum-context-characters"],
      24_000,
      "--maximum-context-characters",
      { minimum: 1_000 },
    ),
    maximumSemanticPasses: integer(
      options["maximum-semantic-passes"],
      100,
      "--maximum-semantic-passes",
      { minimum: 0 },
    ),
    embeddingRequestIntervalMs: integer(
      options["embedding-interval-ms"],
      0,
      "--embedding-interval-ms",
      { minimum: 0 },
    ),
    generator: providers.generator,
    structureGenerator: providers.structureGenerator,
    retrievalContextGenerator: providers.retrievalContextGenerator,
    answerGenerator: providers.generator,
    embeddingProvider: options["without-embedding"] ? null : providers.embedding,
    retainSampleDatabases: Boolean(options["retain-sample-databases"]),
    resumeSampleDatabases: Boolean(options["resume-sample-databases"]),
    codeRevision: detectCodeRevision(),
    onProgress: progressPrinter,
  });
  if (options.output) {
    const outputPath = path.resolve(options.output);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    report.outputPath = outputPath;
  }
  emit(report, stdout);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMemoryZh4oSystemCli().catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  });
}
