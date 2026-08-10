import fs from "node:fs";
import path from "node:path";

import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";

import {
  evaluateRewardCreditCalibration,
  rewardCalibrationResultFromObservation,
} from "./reward-credit-calibration.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function parseOptions(values) {
  const options = {};
  const allowed = new Set(["database", "agent", "cases", "output"]);
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || "");
    if (!value.startsWith("--")) throw new Error(`memory-reward-calibrate 不支持位置参数：${value}`);
    const key = value.slice(2);
    if (!allowed.has(key)) throw new Error(`memory-reward-calibrate 不支持选项 --${key}。`);
    const next = values[index + 1];
    if (next === undefined || String(next).startsWith("--")) {
      throw new Error(`memory-reward-calibrate 选项 --${key} 缺少值。`);
    }
    options[key] = String(next);
    index += 1;
  }
  return options;
}

function readJson(filePath, label) {
  try {
    const content = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error.message}`);
  }
}

function loadCalibrationCases(filePath) {
  const sourcePath = path.resolve(filePath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error("memory-reward-calibrate 找不到标注案例文件。");
  }
  const parsed = readJson(sourcePath, "标注案例文件");
  const cases = Array.isArray(parsed) ? parsed : parsed?.cases;
  if (!Array.isArray(cases) || !cases.length) {
    throw new Error("标注案例文件必须包含非空 cases 数组。");
  }
  const seenCaseIds = new Set();
  const normalized = cases.map((item) => {
    const caseId = clean(item?.caseId);
    const observationId = clean(item?.observationId);
    if (!caseId || !observationId || !item?.expected || typeof item.expected !== "object") {
      throw new Error("每个校准案例必须包含 caseId、observationId 和 expected。");
    }
    if (seenCaseIds.has(caseId)) throw new Error(`校准案例 caseId 重复：${caseId}`);
    seenCaseIds.add(caseId);
    return { ...item, caseId, observationId };
  });
  return { cases: normalized, sourcePath };
}

function writeReport(filePath, report) {
  const outputPath = path.resolve(filePath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, outputPath);
  return outputPath;
}

export function memoryRewardCalibrationUsage() {
  return "node packages/evaluation/src/reward-credit-calibration-cli.mjs --database <memory.db> --agent <agent-id> --cases <labels.json> [--output <report.json>]";
}

/** Read-only calibration against human-labelled, already analyzed shadow observations. */
export async function runMemoryRewardCalibrationCli({
  args = process.argv.slice(2),
  stdout = process.stdout,
} = {}) {
  const options = parseOptions(args);
  for (const key of ["database", "agent", "cases"]) {
    if (!clean(options[key])) throw new Error(`memory-reward-calibrate 缺少 --${key}。`);
  }
  const databasePath = path.resolve(options.database);
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error("memory-reward-calibrate 找不到记忆数据库。");
  }
  const agentId = clean(options.agent);
  const loaded = loadCalibrationCases(options.cases);
  const database = openMemoryDatabase(databasePath);
  let results;
  try {
    const repository = new MemoryRepository(database);
    results = loaded.cases.map((item) => rewardCalibrationResultFromObservation({
      repository,
      agentId,
      observationId: item.observationId,
      caseId: item.caseId,
    }));
  } finally {
    database.close();
  }
  const metrics = evaluateRewardCreditCalibration({ cases: loaded.cases, results });
  const report = {
    schemaVersion: "reward-credit-calibration-report-v1",
    generatedAt: new Date().toISOString(),
    agentId,
    databasePath,
    caseSource: loaded.sourcePath,
    metrics,
  };
  const outputPath = clean(options.output) ? writeReport(options.output, report) : "";
  stdout.write(`${JSON.stringify({
    status: "calibration-report",
    cases: metrics.cases,
    metrics,
    outputPath,
    automaticStateMutationAllowed: false,
  }, null, 2)}\n`);
  return { ...report, outputPath, automaticStateMutationAllowed: false };
}
