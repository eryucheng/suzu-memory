#!/usr/bin/env node

import { createMemoryHttpServer } from "../src/index.mjs";
import { createMemoryServiceFromConfig, loadMemoryConfig } from "@suzu-memory/config";

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const current = String(args[index]);
    if (!current.startsWith("--")) throw new Error(`Unexpected argument: ${current}`);
    const key = current.slice(2);
    const value = args[index + 1];
    if (value === undefined || String(value).startsWith("--")) {
      throw new Error(`Option --${key} requires a value.`);
    }
    options[key] = String(value);
    index += 1;
  }
  return options;
}

function maxBodyBytes(value) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > (64 * 1024 * 1024)) {
    throw new Error("--max-body-bytes must be an integer between 1024 and 67108864.");
  }
  return parsed;
}

try {
  const options = parseOptions(process.argv.slice(2));
  const loadedConfig = options.config ? loadMemoryConfig(options.config) : null;
  const configuredService = loadedConfig
    ? createMemoryServiceFromConfig(loadedConfig, {
      overrides: {
        dataRoot: options["data-root"] || loadedConfig.dataRoot,
        projectRoot: options["project-root"] || loadedConfig.projectRoot,
        agentId: options["agent-id"] || loadedConfig.agentId,
        databasePath: options.database || loadedConfig.databasePath,
        usageLedgerPath: options["usage-ledger"] || loadedConfig.usageLedgerPath,
      },
    })
    : null;
  const controller = createMemoryHttpServer({
    service: configuredService,
    serviceOptions: {
      dataRoot: options["data-root"],
      projectRoot: options["project-root"],
      agentId: options["agent-id"],
      databasePath: options.database,
      usageLedgerPath: options["usage-ledger"],
    },
    apiKey: options["api-key"]
      || process.env[loadedConfig?.server?.apiKeyEnv || "SUZU_MEMORY_API_KEY"]
      || "",
    maxBodyBytes: options["max-body-bytes"] === undefined
      ? loadedConfig?.server?.maxBodyBytes
      : maxBodyBytes(options["max-body-bytes"]),
  });
  const address = await controller.listen({
    host: options.host || loadedConfig?.server?.host || "127.0.0.1",
    port: options.port === undefined ? (loadedConfig?.server?.port ?? 37779) : Number(options.port),
  });
  process.stdout.write(`${JSON.stringify({ status: "ready", ...address }, null, 2)}\n`);
  const stop = async () => {
    await controller.close();
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    error: { code: error?.code || "SERVER_START_ERROR", message: error?.message || String(error) },
  }, null, 2)}\n`);
  process.exitCode = 1;
}
