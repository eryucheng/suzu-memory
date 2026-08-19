import fs from "node:fs";
import path from "node:path";

import {
  resolveAgentDataRoot,
  resolveMemoryDataRoot,
  stableAgentId,
} from "@suzu-memory/runtime";
import { createInjectedStructuredGenerator } from "@suzu-memory/providers";
import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";

import { processPendingRewardObservations } from "./reward-credit-service.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function parseOptions(values) {
  const options = {};
  const allowed = new Set(["project-root", "data-root", "database", "agent", "max-observations", "model"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "");
    if (!value.startsWith("--")) throw new Error(`memory-reward-analyze 不支持位置参数：${value}`);
    const key = value.slice(2);
    if (!allowed.has(key)) throw new Error(`memory-reward-analyze 不支持选项 --${key}。`);
    const next = values[index + 1];
    if (next === undefined || String(next).startsWith("--")) {
      throw new Error(`memory-reward-analyze 选项 --${key} 缺少值。`);
    }
    options[key] = String(next);
    index += 1;
  }
  return options;
}

function maximum(value) {
  if (value === undefined || value === "") return 10;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 500) {
    throw new Error("memory-reward-analyze 的 --max-observations 必须是 1 到 500 的整数。");
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

export function memoryRewardAnalysisUsage() {
  return "node packages/evaluation/src/reward-credit-cli.mjs [--project-root <Agent项目目录>] [--data-root <软件数据目录>] [--max-observations <1-500>]";
}

/** Explicit bounded worker. It records shadow proposals and never applies memory state. */
export async function runMemoryRewardAnalysisCli({
  args = process.argv.slice(2),
  stdout = process.stdout,
  agentGeneratorFactory = null,
} = {}) {
  const options = parseOptions(args);
  const projectRoot = path.resolve(clean(options["project-root"]) || process.cwd());
  const softwareDataDirectory = dataRoot(options["data-root"]);
  const agentId = clean(options.agent) || stableAgentId(projectRoot);
  if (!agentId) throw new Error("memory-reward-analyze 无法定位当前 Agent。");
  const agentRoot = resolveAgentDataRoot({ dataRoot: softwareDataDirectory, agentId });
  const databasePath = path.resolve(clean(options.database) || path.join(agentRoot, "memory", "memory.db"));
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error("当前 Agent 的记忆数据库尚未建立。");
  }
  const maxObservations = maximum(options["max-observations"]);
  const usageLedgerPath = path.join(agentRoot, "cost-ledger", "events.jsonl");
  const generator = createInjectedStructuredGenerator(agentGeneratorFactory, {
    label: "memory-reward-analyze",
    model: clean(options.model),
  });
  const analyzers = { outcome: generator, target: generator, credit: generator };
  const database = openMemoryDatabase(databasePath);
  let result;
  try {
    result = await processPendingRewardObservations({
      repository: new MemoryRepository(database),
      agentId,
      analyzers,
      maxObservations,
      usageLedgerPath,
    });
  } finally {
    database.close();
  }
  const summary = {
    status: result.status,
    processorVersion: result.processorVersion,
    policyVersion: result.policyVersion,
    agentId,
    maxObservations,
    selected: result.selected,
    counts: result.counts,
    automaticStateMutationAllowed: false,
    generatorMode: "current-agent",
    databasePath,
  };
  stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  return { ...result, generatorMode: summary.generatorMode, databasePath };
}
