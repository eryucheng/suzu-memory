#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createMemoryServiceFromConfig } from "@suzu-memory/config";

const EXAMPLE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EVENTS_PATH = path.join(EXAMPLE_DIRECTORY, "conversation.jsonl");
const DEFAULT_QUERY = "2026年8月1日，User去了哪里，最喜欢哪个展览？";

function readOption(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

export function parseArguments(args = []) {
  const options = {
    configPath: "",
    eventsPath: DEFAULT_EVENTS_PATH,
    query: DEFAULT_QUERY,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--config") {
      options.configPath = path.resolve(readOption(args, index, "--config"));
      index += 1;
    } else if (argument === "--events") {
      options.eventsPath = path.resolve(readOption(args, index, "--events"));
      index += 1;
    } else if (argument === "--query") {
      options.query = readOption(args, index, "--query").trim();
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  return options;
}

export function loadEvents(eventsPath) {
  const resolvedPath = path.resolve(eventsPath);
  const source = fs.readFileSync(resolvedPath, "utf8").replace(/^\uFEFF/u, "");
  const events = [];

  source.split(/\r?\n/u).forEach((line, index) => {
    const value = line.trim();
    if (!value) return;
    try {
      events.push(JSON.parse(value));
    } catch (error) {
      throw new Error(
        `Invalid JSON in ${resolvedPath} at line ${index + 1}: ${error.message}`,
      );
    }
  });

  if (!events.length) {
    throw new Error(`No events found in ${resolvedPath}.`);
  }
  return events;
}

export async function runBasicHost({ memory, events, query }) {
  const imported = memory.appendEvents(events);
  const maintenance = await memory.runMaintenance({ lane: "all" });
  const memories = memory.listMemories();
  const retrieval = await memory.search(query);

  return {
    status: "completed",
    query,
    import: {
      accepted: imported.accepted,
      inserted: imported.inserted,
      reused: imported.reused,
    },
    maintenance: {
      status: maintenance.status,
      lane: maintenance.lane,
      semanticStatus: maintenance.semantic?.status || "",
      embeddingStatus: maintenance.embedding?.status || "",
    },
    memoryCount: memories.total,
    retrieval: {
      status: retrieval.status,
      context: retrieval.context || "",
      traceId: retrieval.trace?.id || "",
    },
  };
}

function printUsage() {
  process.stdout.write(`Usage:\n  node examples/basic-host/basic-host.mjs --config <config.json> [options]\n\nOptions:\n  --events <conversation.jsonl>  Replace the fictional event fixture.\n  --query <text>                 Replace the retrieval query.\n  --help                         Show this help.\n`);
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  if (options.help) {
    printUsage();
    return;
  }
  if (!options.configPath) {
    throw new Error("--config is required. Copy suzu-memory.example.json and configure providers first.");
  }

  const memory = createMemoryServiceFromConfig(options.configPath);
  const events = loadEvents(options.eventsPath);
  const result = await runBasicHost({ memory, events, query: options.query });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exitCode = 1;
  });
}
