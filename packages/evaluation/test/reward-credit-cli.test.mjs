import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgentDataRoot, stableAgentId } from "@suzu-memory/runtime";
import { openMemoryDatabase } from "@suzu-memory/core";

import { runMemoryRewardAnalysisCli } from "../src/reward-credit-cli.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-reward-cli-"));
  const projectRoot = path.join(root, "agent");
  const dataRoot = path.join(root, "data");
  fs.mkdirSync(projectRoot, { recursive: true });
  const agentId = stableAgentId(projectRoot);
  const agentRoot = resolveAgentDataRoot({ dataRoot, agentId });
  const databasePath = path.join(agentRoot, "memory", "memory.db");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  openMemoryDatabase(databasePath).close();
  return { root, projectRoot, dataRoot, databasePath };
}

test("memory-reward-analyze is bounded and never enables automatic state mutation", async (context) => {
  const values = fixture();
  context.after(() => fs.rmSync(values.root, { recursive: true, force: true }));
  let factoryCalls = 0;
  let output = "";
  const result = await runMemoryRewardAnalysisCli({
    args: ["--project-root", values.projectRoot, "--data-root", values.dataRoot, "--max-observations", "3"],
    stdout: { write: (value) => { output += value; } },
    agentGeneratorFactory: () => {
      factoryCalls += 1;
      return async () => ({ output: {} });
    },
  });
  assert.equal(factoryCalls, 1);
  assert.equal(result.status, "empty");
  assert.equal(result.automaticStateMutationAllowed, false);
  assert.match(output, /"automaticStateMutationAllowed": false/u);
  await assert.rejects(
    () => runMemoryRewardAnalysisCli({
      args: ["--project-root", values.projectRoot, "--data-root", values.dataRoot, "--max-observations", "501"],
      stdout: { write: () => undefined },
    }),
    /1 到 500/u,
  );
});
