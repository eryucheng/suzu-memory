#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveAgentDataRoot,
  resolveMemoryDataRoot,
} from "@suzu-memory/runtime";
import { createOpenAiCompatibleEmbeddingProvider } from "@suzu-memory/providers";

import {
  loadEvaluationCases,
  runMemoryEvaluation,
  writeEvaluationReport,
} from "./evaluator.mjs";
import { createCurrentRetrieverExecutor } from "./retriever-adapter.mjs";
import {
  memoryEmbeddingProviderFromConnection,
  resolveMemoryEmbeddingConnection,
} from "./embedding-connection.mjs";

function parseArguments(argv) {
  const values = {
    databasePath: "",
    agentId: "",
    casesPath: "",
    outputPath: "",
    includeContext: false,
    strict: false,
    withEmbedding: false,
    dataRoot: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--database") values.databasePath = argv[++index] || "";
    else if (argument === "--agent") values.agentId = argv[++index] || "";
    else if (argument === "--cases") values.casesPath = argv[++index] || "";
    else if (argument === "--output") values.outputPath = argv[++index] || "";
    else if (argument === "--include-context") values.includeContext = true;
    else if (argument === "--strict") values.strict = true;
    else if (argument === "--with-embedding") values.withEmbedding = true;
    else if (argument === "--data-root") values.dataRoot = argv[++index] || "";
    else if (["--help", "-h"].includes(argument)) values.help = true;
    else throw new Error(`未知参数：${argument}`);
  }
  return values;
}

function usage() {
  return `用法：
  suzu-memory-eval \\
    --database <memory.db> \\
    --agent <agent-id> \\
    --cases <cases.json> \\
    [--output <report.json>] [--include-context] [--strict]
    [--with-embedding] [--data-root <软件数据目录>]

默认不调用Embedding API，只评测当前离线文本与时间召回路径。
--with-embedding 会显式使用软件绑定的 memory-embedding 连接，并记录本轮请求费用。
--include-context 会把实际注入文本写入本机报告，报告不得上传仓库。
--strict 会在存在未通过案例时返回非零退出码。`;
}

function clean(value) {
  return String(value ?? "").trim();
}

function softwareDataRoot(value, environment) {
  return resolveMemoryDataRoot({
    configuredRoot: clean(value) || clean(environment.SUZU_MEMORY_DATA_ROOT),
    localAppData: clean(environment.LOCALAPPDATA),
    fallbackBase: "",
  });
}

export async function runMemoryEvaluationCli({
  args: argumentValues = process.argv.slice(2),
  stdout = process.stdout,
  environment = process.env,
  connectionResolver = null,
  embeddingProviderFactory = createOpenAiCompatibleEmbeddingProvider,
} = {}) {
  const args = parseArguments(argumentValues);
  if (args.help) {
    stdout.write(`${usage()}\n`);
    return null;
  }
  for (const [name, value] of [
    ["--database", args.databasePath],
    ["--agent", args.agentId],
    ["--cases", args.casesPath],
  ]) {
    if (!value) throw new Error(`缺少参数 ${name}。\n\n${usage()}`);
  }
  const loaded = loadEvaluationCases(args.casesPath);
  let embeddingProvider = null;
  let usageLedgerPath = "";
  if (args.withEmbedding) {
    const dataRoot = softwareDataRoot(args.dataRoot, environment);
    const resolved = await resolveMemoryEmbeddingConnection({
      connectionResolver,
      dataRoot,
      agentId: args.agentId,
      environment,
    });
    embeddingProvider = memoryEmbeddingProviderFromConnection(resolved, embeddingProviderFactory);
    usageLedgerPath = path.join(
      resolveAgentDataRoot({ dataRoot, agentId: args.agentId }),
      "cost-ledger",
      "events.jsonl",
    );
  }
  const execute = createCurrentRetrieverExecutor({
    databasePath: args.databasePath,
    agentId: args.agentId,
    embeddingProvider,
    usageLedgerPath,
  });
  const report = await runMemoryEvaluation({
    cases: loaded.cases,
    execute,
    includeContext: args.includeContext,
  });
  if (args.outputPath) {
    report.caseSource = loaded.sourcePath;
    report.reportPath = writeEvaluationReport(args.outputPath, report);
  }
  stdout.write(`${JSON.stringify({
    status: report.summary.failed ? "baseline-has-failures" : "passed",
    summary: report.summary,
    reportPath: args.outputPath ? path.resolve(args.outputPath) : "",
  }, null, 2)}\n`);
  if (args.strict && report.summary.failed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMemoryEvaluationCli().catch((error) => {
    process.stderr.write(`错误：${error.message}\n`);
    process.exitCode = 1;
  });
}
