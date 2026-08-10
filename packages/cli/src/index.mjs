import fs from "node:fs";

import { createMemoryServiceFromConfig } from "@suzu-memory/config";
import { createMemoryService } from "@suzu-memory/service";
import { runMemoryWorker } from "./worker.mjs";

const BOOLEAN_OPTIONS = new Set([
  "all",
  "help",
  "include-deleted",
  "force",
  "overwrite",
  "no-input-events",
  "no-trace",
  "allow-cross-world",
  "once",
  "continuous",
]);

function clean(value) {
  return String(value ?? "").trim();
}

function parseArguments(args) {
  const values = Array.isArray(args) ? [...args] : [];
  const positionals = [];
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const current = String(values[index]);
    if (!current.startsWith("--")) {
      positionals.push(current);
      continue;
    }
    const separator = current.indexOf("=");
    const key = current.slice(2, separator >= 0 ? separator : undefined);
    if (!key) throw new Error("CLI option name cannot be empty.");
    if (separator >= 0) {
      options[key] = current.slice(separator + 1);
      continue;
    }
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const next = values[index + 1];
    if (next === undefined || String(next).startsWith("--")) {
      throw new Error(`Option --${key} requires a value.`);
    }
    options[key] = String(next);
    index += 1;
  }
  return { positionals, options };
}

function numberOption(value, label) {
  if (value === undefined || value === "") return undefined;
  const result = Number(value);
  if (!Number.isFinite(result)) throw new Error(`${label} must be a number.`);
  return result;
}

function serviceOptions(options, overrides = {}) {
  return {
    dataRoot: clean(options["data-root"]),
    projectRoot: clean(options["project-root"]),
    agentId: clean(options["agent-id"]),
    databasePath: clean(options.database),
    usageLedgerPath: clean(options["usage-ledger"]),
    ...overrides,
  };
}

function required(value, label) {
  const result = clean(value);
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function readEventsFile(filePath) {
  const resolved = required(filePath, "events-file");
  const text = fs.readFileSync(resolved, "utf8").replace(/^\uFEFF/u, "").trim();
  if (!text) throw new Error("events-file is empty.");
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === "object" && Array.isArray(parsed.events)) return parsed.events;
    if (parsed && typeof parsed === "object") return [parsed];
  } catch (jsonError) {
    try {
      return text.split(/\r?\n/u).filter((line) => line.trim()).map((line) => JSON.parse(line));
    } catch (jsonlError) {
      throw new Error(`Cannot parse events-file as JSON or JSONL: ${jsonlError.message || jsonError.message}`);
    }
  }
  throw new Error("events-file must contain an event object or event array.");
}

function editPatch(options) {
  const mappings = {
    title: "title",
    content: "content",
    kind: "kind",
    layer: "layer",
    "subject-role": "subjectRole",
    "subject-key": "subjectKey",
    "canonical-key": "canonicalKey",
    reality: "reality",
    "representation-layer": "representationLayer",
    "state-family": "stateFamily",
    "state-phase": "statePhase",
    "temporal-state": "temporalState",
    "event-date": "eventDate",
    "event-start": "eventStart",
    "event-end": "eventEnd",
    "known-at": "knownAt",
    perspective: "perspective",
  };
  const patch = {};
  for (const [option, property] of Object.entries(mappings)) {
    if (Object.hasOwn(options, option)) patch[property] = options[option];
  }
  for (const [option, property] of [["confidence", "confidence"], ["importance", "importance"]]) {
    if (Object.hasOwn(options, option)) patch[property] = numberOption(options[option], `--${option}`);
  }
  if (!Object.keys(patch).length) throw new Error("edit requires at least one editable field.");
  return patch;
}

function maintenanceOptions(options) {
  return {
    lane: clean(options.lane) || "all",
    processInputEvents: !options["no-input-events"],
    maximumInputBatches: numberOption(
      options["max-input-batches"],
      "--max-input-batches",
    ) || 1,
    maximumEvents: numberOption(options["max-events"], "--max-events") || 100,
    maximumContentCharacters: numberOption(
      options["max-content-characters"],
      "--max-content-characters",
    ),
    leaseSeconds: numberOption(options["lease-seconds"], "--lease-seconds"),
    maximumTasks: numberOption(options["max-tasks"], "--max-tasks") || 10,
    maximumStateRequests: numberOption(
      options["max-state-requests"],
      "--max-state-requests",
    ) || 10,
    maximumConsolidationRuns: numberOption(
      options["max-consolidation-runs"],
      "--max-consolidation-runs",
    ) || 3,
    batchSize: numberOption(options["embedding-batch-size"], "--embedding-batch-size") || 10,
    now: clean(options.now) || new Date(),
  };
}

export function memoryCliUsage() {
  return [
    "suzu-memory <command> --agent-id <id> [--data-root <path>]",
    "",
    "Commands:",
    "  init | status",
    "  ingest <events.json|events.jsonl>",
    "  revise-event <event-id> --action <amend|supersede|retract> [replacement-event.json] [--reason <text>]",
    "  events [--status <pending,processing,archived>] [--type <event-type>] [--lifecycle <active,superseded,retracted>]",
    "  event-batches [--limit <1-500>]",
    "  process-events [--max-events <1-500>] [--max-content-characters <n>] [--lease-seconds <60-86400>]",
    "  recover-events [--batch-id <id>] [--force]",
    "  backup-database [destination.db] [--overwrite]",
    "  inspect-backup <backup.db>",
    "  restore-database <backup.db> --confirm-agent <agent-id>",
    "  maintenance-status",
    "  maintenance [--lane embedding|semantic|all] [--no-input-events]",
    "  worker [--continuous] [--interval-ms <1000-86400000>] [--max-cycles <n>] [maintenance options]",
    "  reviews [--type <reported-state,structure,relation,ingestion,maintenance-failure>] [--state <pending,accepted,dismissed,revoked>]",
    "  review <type> <proposal-id>",
    "  resolve <type> <proposal-id> --action <accept|dismiss> [--reason <text>]",
    "  revoke-relation <proposal-id> [--reason <text>]",
    "  list [--query <text>] [--kind <kind>] [--all]",
    "  get <memory-id>",
    "  search <query>",
    "  edit <memory-id> --title <text> | --content <text> [...]",
    "  delete <memory-id> [--reason <text>]",
    "  restore <memory-id> [--reason <text>]",
    "  traces [--limit <1-500>]",
    "  brain",
  ].join("\n");
}

export async function runMemoryCli({
  args = process.argv.slice(2),
  stdout = process.stdout,
  serviceFactory = createMemoryService,
  configuredServiceFactory = createMemoryServiceFromConfig,
} = {}) {
  const parsed = parseArguments(args);
  const [command = "help", ...positionals] = parsed.positionals;
  if (["help", "--help", "-h"].includes(command) || parsed.options.help) {
    const data = { usage: memoryCliUsage() };
    stdout.write(`${JSON.stringify({ status: "success", command: "help", data }, null, 2)}\n`);
    return data;
  }
  const service = clean(parsed.options.config)
    ? configuredServiceFactory(parsed.options.config, {
      overrides: serviceOptions(parsed.options),
    })
    : serviceFactory(serviceOptions(parsed.options));
  let data;
  if (["init", "status"].includes(command)) {
    data = service.info();
  } else if (command === "ingest") {
    data = service.appendEvents(readEventsFile(positionals[0]));
  } else if (command === "revise-event") {
    const action = required(parsed.options.action, "--action");
    const replacementEvents = positionals[1] ? readEventsFile(positionals[1]) : [];
    if (replacementEvents.length > 1) {
      throw new Error("revise-event replacement file must contain exactly one logical event.");
    }
    data = service.reviseEvent(required(positionals[0], "event-id"), {
      action,
      replacementEvent: replacementEvents[0] || null,
      revisionId: clean(parsed.options["revision-id"]),
      reason: clean(parsed.options.reason),
      now: clean(parsed.options.now) || new Date(),
    });
  } else if (command === "events") {
    data = service.listInputEvents({
      statuses: clean(parsed.options.status)
        ? clean(parsed.options.status).split(",")
        : ["pending"],
      eventTypes: clean(parsed.options.type) ? clean(parsed.options.type).split(",") : [],
      lifecycles: clean(parsed.options.lifecycle)
        ? clean(parsed.options.lifecycle).split(",")
        : ["active"],
      limit: numberOption(parsed.options.limit, "--limit") || 100,
      offset: numberOption(parsed.options.offset, "--offset") || 0,
    });
  } else if (command === "event-batches") {
    data = service.listInputBatches({
      limit: numberOption(parsed.options.limit, "--limit") || 100,
      offset: numberOption(parsed.options.offset, "--offset") || 0,
    });
  } else if (command === "recover-events") {
    data = service.recoverProcessingEvents({
      batchId: clean(parsed.options["batch-id"]),
      force: Boolean(parsed.options.force),
      now: clean(parsed.options.now) || new Date(),
    });
  } else if (command === "backup-database") {
    data = service.backupDatabase({
      destinationPath: clean(positionals[0]),
      overwrite: Boolean(parsed.options.overwrite),
      now: clean(parsed.options.now) || new Date(),
    });
  } else if (command === "inspect-backup") {
    data = service.inspectDatabaseBackup(required(positionals[0], "backup-path"));
  } else if (command === "restore-database") {
    data = service.restoreDatabaseBackup(
      required(positionals[0], "backup-path"),
      {
        confirmAgentId: required(parsed.options["confirm-agent"], "--confirm-agent"),
        now: clean(parsed.options.now) || new Date(),
      },
    );
  } else if (command === "process-events") {
    data = await service.processPendingEvents({
      maximumEvents: numberOption(parsed.options["max-events"], "--max-events") || 100,
      maximumContentCharacters: numberOption(
        parsed.options["max-content-characters"],
        "--max-content-characters",
      ),
      leaseSeconds: numberOption(parsed.options["lease-seconds"], "--lease-seconds"),
      now: clean(parsed.options.now) || new Date(),
    });
  } else if (command === "maintenance-status") {
    data = service.maintenanceStatus({
      limit: numberOption(parsed.options.limit, "--limit") || 100,
    });
  } else if (command === "maintenance") {
    data = await service.runMaintenance(maintenanceOptions(parsed.options));
  } else if (command === "worker") {
    data = await runMemoryWorker({
      service,
      maintenanceOptions: maintenanceOptions(parsed.options),
      once: !Boolean(parsed.options.continuous),
      intervalMs: numberOption(parsed.options["interval-ms"], "--interval-ms") || 15_000,
      maximumCycles: numberOption(parsed.options["max-cycles"], "--max-cycles") || 0,
    });
  } else if (command === "reviews") {
    data = service.listHighLevelProposals({
      types: clean(parsed.options.type)
        ? clean(parsed.options.type).split(",")
        : undefined,
      reviewStates: clean(parsed.options.state)
        ? clean(parsed.options.state).split(",")
        : ["pending"],
      limit: numberOption(parsed.options.limit, "--limit") || 100,
    });
  } else if (command === "review") {
    data = service.getHighLevelProposal(
      required(positionals[0], "proposal-type"),
      required(positionals[1], "proposal-id"),
    );
    if (!data) throw new Error("High-level proposal was not found.");
  } else if (command === "resolve") {
    data = service.resolveHighLevelProposal(
      required(positionals[0], "proposal-type"),
      required(positionals[1], "proposal-id"),
      {
        action: required(parsed.options.action, "--action"),
        actor: clean(parsed.options.actor) || "human",
        reason: clean(parsed.options.reason),
      },
    );
  } else if (command === "revoke-relation") {
    data = service.revokeHighLevelRelation(
      required(positionals[0], "proposal-id"),
      {
        actor: clean(parsed.options.actor) || "human",
        reason: clean(parsed.options.reason),
      },
    );
  } else if (command === "list") {
    const statuses = parsed.options.all
      ? []
      : parsed.options["include-deleted"] ? ["active", "deleted"] : ["active"];
    data = service.listMemories({
      query: clean(parsed.options.query),
      kinds: clean(parsed.options.kind) ? clean(parsed.options.kind).split(",") : [],
      statuses,
      limit: numberOption(parsed.options.limit, "--limit") || 50,
      offset: numberOption(parsed.options.offset, "--offset") || 0,
    });
  } else if (command === "get") {
    data = service.getMemory(required(positionals[0], "memory-id"));
  } else if (command === "search") {
    const query = required(positionals.join(" "), "query");
    data = await service.search(query, {
      now: clean(parsed.options.now) || new Date(),
      persistTrace: !parsed.options["no-trace"],
      world: {
        id: clean(parsed.options["world-id"]),
        frame: clean(parsed.options["world-frame"]),
      },
      allowCrossWorld: Boolean(parsed.options["allow-cross-world"]),
    });
  } else if (command === "edit") {
    data = service.editMemory(required(positionals[0], "memory-id"), editPatch(parsed.options), {
      actor: clean(parsed.options.actor) || "human",
      reason: clean(parsed.options.reason),
    });
  } else if (command === "delete" || command === "restore") {
    const memoryId = required(positionals[0], "memory-id");
    const actionOptions = {
      actor: clean(parsed.options.actor) || "human",
      reason: clean(parsed.options.reason),
    };
    data = command === "delete"
      ? service.deleteMemory(memoryId, actionOptions)
      : service.restoreMemory(memoryId, actionOptions);
  } else if (command === "traces") {
    data = service.listRetrievalTraces({
      resultStatus: clean(parsed.options.status),
      limit: numberOption(parsed.options.limit, "--limit") || 100,
      offset: numberOption(parsed.options.offset, "--offset") || 0,
    });
  } else if (command === "brain") {
    data = service.brainSnapshot();
  } else {
    throw new Error(`Unknown command: ${command}.\n${memoryCliUsage()}`);
  }
  stdout.write(`${JSON.stringify({ status: "success", command, data }, null, 2)}\n`);
  return data;
}
