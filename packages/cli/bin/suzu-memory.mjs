#!/usr/bin/env node

import { runMemoryCli } from "../src/index.mjs";

try {
  await runMemoryCli();
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    error: {
      code: error?.code || "CLI_ERROR",
      message: error?.message || String(error),
    },
  }, null, 2)}\n`);
  process.exitCode = 1;
}
