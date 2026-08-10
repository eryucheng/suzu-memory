#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeZh4oDatasetFromMoomSource } from "./zh4o-source.mjs";

export function memoryZh4oSourceUsage() {
  return "node packages/evaluation/src/zh4o-source-cli.mjs --source-root <MOOM-Roleplay-Dialogue 克隆目录> --output <派生数据.json> [--manifest <来源清单.json>]";
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (["--help", "-h"].includes(token)) {
      options.help = true;
      continue;
    }
    if (!token.startsWith("--")) throw new Error("不支持位置参数：" + token + "。");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error("选项 " + token + " 缺少值。");
    const key = token.slice(2);
    if (!["source-root", "output", "manifest"].includes(key)) {
      throw new Error("不支持选项 " + token + "。");
    }
    options[key] = value;
    index += 1;
  }
  return options;
}

export function runMemoryZh4oSourceCli({
  args = process.argv.slice(2),
  stdout = process.stdout,
} = {}) {
  const options = parseArgs(args);
  if (options.help) {
    const usage = memoryZh4oSourceUsage();
    stdout.write(usage + "\n");
    return { status: "help", usage };
  }
  if (!options["source-root"] || !options.output) throw new Error(memoryZh4oSourceUsage());
  const result = writeZh4oDatasetFromMoomSource({
    sourceRoot: path.resolve(options["source-root"]),
    outputPath: path.resolve(options.output),
    manifestPath: options.manifest ? path.resolve(options.manifest) : "",
  });
  const response = {
    status: "written",
    outputPath: result.outputPath,
    manifestPath: result.manifestPath,
    samples: result.manifest.output.samples,
    questions: result.manifest.output.questions,
    officialCommit: result.manifest.officialCommit,
  };
  stdout.write(JSON.stringify(response, null, 2) + "\n");
  return response;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runMemoryZh4oSourceCli();
  } catch (error) {
    process.stderr.write("错误：" + error.message + "\n");
    process.exitCode = 1;
  }
}
