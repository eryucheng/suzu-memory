import assert from "node:assert/strict";
import test from "node:test";

import {
  memoryZh4oSystemUsage,
  runMemoryZh4oSystemCli,
} from "../src/zh4o-system-cli.mjs";

function outputSink() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    value() { return value; },
  };
}

for (const argument of ["--help", "-h"]) {
  test(`ZH-4O CLI ${argument} returns usage without requiring a dataset`, async () => {
    const output = outputSink();
    const result = await runMemoryZh4oSystemCli({
      args: [argument],
      stdout: output.stream,
    });
    assert.equal(result.status, "help");
    assert.equal(result.usage, memoryZh4oSystemUsage());
    assert.match(output.value(), /--dataset <zh4o-data\.json>/u);
  });
}
