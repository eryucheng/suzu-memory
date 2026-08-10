import fs from "node:fs";
import path from "node:path";

import {
  resolveAgentDataRoot,
  resolveMemoryDataRoot,
  stableAgentId,
} from "@suzu-memory/runtime";
import { createClaudeCliGenerator } from "@suzu-memory/providers";

import { REWARD_CREDIT_HOLDOUT_V1 } from "../fixtures/reward-credit-holdout-v1.mjs";
import { REWARD_CREDIT_MINI_V1 } from "../fixtures/reward-credit-mini-v1.mjs";
import {
  runRewardCreditBenchmark,
  validateRewardCreditBenchmark,
} from "./reward-credit-benchmark.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function parseOptions(values) {
  const options = {};
  const allowedValues = new Set([
    "project-root",
    "data-root",
    "output",
    "max-cases",
    "start",
    "model",
    "suite",
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "");
    if (value === "--dry-run") {
      options["dry-run"] = true;
      continue;
    }
    if (!value.startsWith("--")) throw new Error(`memory-reward-benchmark 不支持位置参数：${value}`);
    const key = value.slice(2);
    if (!allowedValues.has(key)) throw new Error(`memory-reward-benchmark 不支持选项 --${key}。`);
    const next = values[index + 1];
    if (next === undefined || String(next).startsWith("--")) {
      throw new Error(`memory-reward-benchmark 选项 --${key} 缺少值。`);
    }
    options[key] = String(next);
    index += 1;
  }
  return options;
}

const BENCHMARK_SUITES = Object.freeze({
  "mini-v1": Object.freeze({ benchmark: REWARD_CREDIT_MINI_V1, expectedCaseCount: 140 }),
  "holdout-v1": Object.freeze({ benchmark: REWARD_CREDIT_HOLDOUT_V1, expectedCaseCount: 84 }),
});

function resolveBenchmarkSuite(value) {
  const suite = clean(value) || "mini-v1";
  const selected = BENCHMARK_SUITES[suite];
  if (!selected) {
    throw new Error(
      `memory-reward-benchmark 的 --suite 必须是 ${Object.keys(BENCHMARK_SUITES).join(" 或 ")}。`,
    );
  }
  return { suite, ...selected };
}

function integer(value, { name, minimum, maximum, required = false, fallback = 0 }) {
  if ((value === undefined || value === "") && !required) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`memory-reward-benchmark 的 --${name} 必须是 ${minimum} 到 ${maximum} 的整数。`);
  }
  return parsed;
}

function dataRoot(value) {
  return resolveMemoryDataRoot({
    configuredRoot: clean(value) || process.env.SUZU_MEMORY_DATA_ROOT || "",
    localAppData: process.env.LOCALAPPDATA || "",
    fallbackBase: "",
  });
}

function writeAtomic(filePath, value) {
  const outputPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, outputPath);
  return outputPath;
}

export function memoryRewardBenchmarkUsage() {
  return "node packages/evaluation/src/reward-credit-benchmark-cli.mjs [--suite <mini-v1|holdout-v1>] --max-cases <数量> --output <report.json> [--start <起始序号>] [--model <model>] [--project-root <Agent项目目录>] [--data-root <软件数据目录>] [--dry-run]";
}

export async function runMemoryRewardBenchmarkCli({
  args = process.argv.slice(2),
  stdout = process.stdout,
  agentGeneratorFactory = createClaudeCliGenerator,
} = {}) {
  const options = parseOptions(args);
  const selected = resolveBenchmarkSuite(options.suite);
  const validation = validateRewardCreditBenchmark(selected.benchmark, {
    expectedCaseCount: selected.expectedCaseCount,
  });
  if (options["dry-run"]) {
    const result = {
      status: "validated",
      suite: selected.suite,
      benchmarkVersion: validation.version,
      cases: validation.cases,
      categories: validation.categories,
      externalModelCalls: 0,
      automaticStateMutationAllowed: false,
    };
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  const maxCases = integer(options["max-cases"], {
    name: "max-cases",
    minimum: 1,
    maximum: validation.cases,
    required: true,
  });
  const start = integer(options.start, {
    name: "start",
    minimum: 0,
    maximum: validation.cases - 1,
    fallback: 0,
  });
  if (start + maxCases > validation.cases) {
    throw new Error("memory-reward-benchmark 的案例范围超过所选套件总数。");
  }
  if (!clean(options.output)) throw new Error("memory-reward-benchmark 缺少 --output。");
  const outputPath = path.resolve(options.output);
  const projectRoot = path.resolve(clean(options["project-root"]) || process.cwd());
  const softwareDataRoot = dataRoot(options["data-root"]);
  const agentId = stableAgentId(projectRoot);
  const usageLedgerPath = path.join(
    resolveAgentDataRoot({ dataRoot: softwareDataRoot, agentId }),
    "cost-ledger",
    "events.jsonl",
  );
  const generator = agentGeneratorFactory({ model: clean(options.model) });
  const startedAt = new Date().toISOString();
  const checkpoint = { processing: [], results: [] };
  const report = await runRewardCreditBenchmark({
    benchmark: selected.benchmark,
    start,
    maxCases,
    usageLedgerPath,
    analyzersForCase: async () => ({ outcome: generator, target: generator, credit: generator }),
    onCaseComplete: ({ result, processing }) => {
      checkpoint.processing.push(processing);
      checkpoint.results.push(result);
      writeAtomic(outputPath, {
        schemaVersion: "reward-credit-benchmark-checkpoint-v1",
        status: "running",
        suite: selected.suite,
        benchmarkVersion: validation.version,
        startedAt,
        selection: { start, count: maxCases, completed: checkpoint.results.length },
        processing: checkpoint.processing,
        results: checkpoint.results,
        automaticStateMutationAllowed: false,
      });
    },
  });
  const completed = {
    ...report,
    suite: selected.suite,
    status: report.processing.every((item) => item.status === "analyzed")
      ? "completed"
      : "completed-with-failures",
    startedAt,
    completedAt: new Date().toISOString(),
    model: clean(options.model) || "current-agent-default",
    outputPath,
  };
  writeAtomic(outputPath, completed);
  stdout.write(`${JSON.stringify({
    status: completed.status,
    suite: completed.suite,
    benchmarkVersion: completed.benchmarkVersion,
    selection: completed.selection,
    metrics: completed.metrics,
    model: completed.model,
    outputPath,
    automaticStateMutationAllowed: false,
  }, null, 2)}\n`);
  return completed;
}
