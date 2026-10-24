#!/usr/bin/env node
import fs from "node:fs";
import { randomUUID } from 'node:crypto';
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadMemoryConfig, validateMemoryProviderConfig } from "@suzu-memory/config";
import { loadZh4oDataset, zh4oDatasetSha256 } from "./zh4o-contract.mjs";
import { runZh4oMemorySystemBenchmark } from "./zh4o-system.mjs";
import { readEvaluationCodeRevision } from './code-revision.mjs';

export function memoryZh4oSystemUsage() {
  return "node packages/evaluation/src/zh4o-system-cli.mjs --dataset <zh4o-data.json> --config <memory.config.json> --work-dir <评测目录> [--resume <report或pending文件>] [--dry-run] [--retrieval-only] [--no-control] [--without-embedding] [--source-diagnostics] [--start-sample <0起>] [--max-samples <数量>] [--max-questions-per-sample <数量>] [--candidate-k <显式覆盖返回数>] [--maximum-context-characters <显式覆盖上下文长度>] [--maximum-drain-passes <收尾保护上限>] [--embedding-interval-ms <间隔>] [--output <report.json>]";
}

const switches = new Set(["dry-run", "retrieval-only", "no-control", "without-embedding", "source-diagnostics"]);
const values = new Set(["dataset", "config", "work-dir", "output", "resume", "start-sample", "max-samples",
  "max-questions-per-sample", "candidate-k", "maximum-context-characters", "maximum-drain-passes", "embedding-interval-ms"]);

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (["--help", "-h"].includes(token)) { result.help = true; continue; }
    const name = token.startsWith("--") ? token.slice(2) : "";
    if (switches.has(name)) { result[name] = true; continue; }
    if (!values.has(name)) throw new Error(`不支持选项 ${token}。`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${token} 缺少值。`);
    result[name] = value;
  }
  return result;
}

function integer(value, fallback, label, minimum = 1) {
  if (value === undefined) return fallback;
  const selected = Number(value);
  if (!Number.isSafeInteger(selected) || selected < minimum) throw new Error(`${label} 必须是大于等于 ${minimum} 的整数。`);
  return selected;
}

export async function runMemoryZh4oSystemCli({ args = process.argv.slice(2), environment = process.env,
  fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  const options = parseArgs(args);
  if (options.help) { const usage = memoryZh4oSystemUsage(); stdout.write(`${usage}\n`); return { status: "help", usage }; }
  if (!options.dataset || !options.config) throw new Error(memoryZh4oSystemUsage());
  const config = loadMemoryConfig(path.resolve(options.config));
  const capabilities = validateMemoryProviderConfig(config, { environment, requireGeneration: true, embedding: !options["without-embedding"] });
  const datasetPath = path.resolve(options.dataset);
  const samples = loadZh4oDataset(datasetPath);
  const runOptions = {
    datasetPath, config, environment, fetchImpl,
    startSample: integer(options["start-sample"], 0, "--start-sample", 0),
    maximumSamples: integer(options["max-samples"], Number.MAX_SAFE_INTEGER, "--max-samples"),
    maximumQuestionsPerSample: integer(options["max-questions-per-sample"], Number.MAX_SAFE_INTEGER, "--max-questions-per-sample"),
    candidateK: integer(options["candidate-k"], undefined, "--candidate-k"),
    maximumContextCharacters: integer(options["maximum-context-characters"], undefined, "--maximum-context-characters"),
    maximumDrainPasses: integer(options["maximum-drain-passes"], 1000, "--maximum-drain-passes"),
    embeddingRequestIntervalMs: integer(options["embedding-interval-ms"], 0, "--embedding-interval-ms", 0),
    withoutEmbedding: Boolean(options["without-embedding"]), retrievalOnly: Boolean(options["retrieval-only"]),
    control: options["no-control"] ? "none" : "no-memory", includeSourceDiagnostics: Boolean(options["source-diagnostics"]),
  };
  if (runOptions.startSample >= samples.length) throw new Error("样本起点超出数据集范围。");
  if (options["dry-run"]) {
    const selected = samples.slice(runOptions.startSample, runOptions.startSample + runOptions.maximumSamples);
    const questions = selected.reduce((sum, sample) => sum + Math.min(sample.questions.length, runOptions.maximumQuestionsPerSample), 0);
    const result = { status: "validated", datasetSha256: zh4oDatasetSha256(datasetPath),
      samples: selected.length, questions, generationModel: config.providers.generation.model,
      embeddingModel: capabilities.embedding ? config.providers.embedding.model : null,
      ingestion: config.defaults.ingestion, retrieval: config.defaults.retrieval,
      retrievalOverrides: { candidateK: runOptions.candidateK, maximumContextCharacters: runOptions.maximumContextCharacters },
      answerRequests: questions * (runOptions.control === "no-memory" ? 2 : 1),
      note: "已检查配置结构、所需密钥是否已设置及数据格式；未建库、未调用模型。答题请求数不含记忆整理。" };
    stdout.write(`${JSON.stringify(result, null, 2)}\n`); return result;
  }
  if (!options["work-dir"]) throw new Error(memoryZh4oSystemUsage());
  const workDirectory = path.resolve(options["work-dir"]);
  const resumeReport = options.resume ? JSON.parse(fs.readFileSync(path.resolve(options.resume), 'utf8')) : null;
  const reportName = runOptions.retrievalOnly ? `report.retrieval-${Date.now()}.json` : "report.json";
  const outputPath = path.resolve(options.output || path.join(workDirectory, reportName));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) {
    if (!fs.statSync(outputPath).isFile()) throw new Error('Report output must be a file, not a directory.');
    fs.accessSync(outputPath, fs.constants.W_OK);
  }
  const stagedPath = `${outputPath}.${randomUUID()}.pending`;
  fs.closeSync(fs.openSync(stagedPath, 'wx', 0o600));
  let completeReport = false, hasCheckpoint = false;
  const writingPath = `${stagedPath}.writing`;
  const saveCheckpoint = report => {
    try {
      const descriptor = fs.openSync(writingPath, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`); fs.fsyncSync(descriptor); }
      finally { fs.closeSync(descriptor); }
      fs.renameSync(writingPath, stagedPath);
      hasCheckpoint = true;
    } finally { fs.rmSync(writingPath, { force: true }); }
  };
  try {
    const report = await runZh4oMemorySystemBenchmark({ ...runOptions, workDirectory, codeRevision: readEvaluationCodeRevision(),
      resumeReport, onCheckpoint: saveCheckpoint,
      onProgress: event => { if (event.completed === event.total || event.completed % 20 === 0) stderr.write(`${JSON.stringify({
        phase: event.phase, sampleId: event.sampleId, completed: event.completed, total: event.total,
        status: event.row?.status, correct: event.row?.correct,
      })}\n`); } });
    saveCheckpoint(report);
    completeReport = true;
    fs.renameSync(stagedPath, outputPath);
    stdout.write(`${JSON.stringify({ status: report.status, report: outputPath, scores: report.scores,
      controls: report.controls, degradedSamples: report.diagnostics.degradedSamples }, null, 2)}\n`);
    return report;
  } catch (error) {
    if (completeReport && fs.existsSync(stagedPath)) {
      throw new Error(`Report could not be moved to its destination; the complete report is retained at ${stagedPath}.`, { cause: error });
    }
    if (hasCheckpoint && fs.existsSync(stagedPath)) {
      throw new Error(`Evaluation interrupted; the last complete checkpoint is retained at ${stagedPath}.`, { cause: error });
    }
    throw error;
  } finally {
    if (!hasCheckpoint) fs.rmSync(stagedPath, { force: true });
    fs.rmSync(writingPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runMemoryZh4oSystemCli().then(report => {
    if (['aborted', 'incomplete', 'completed-with-failures'].includes(report.status)) process.exitCode = 1;
  }).catch(error => { process.stderr.write(`错误：${error.message}\n`); process.exitCode = 1; });
}
