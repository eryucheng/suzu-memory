import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runMemoryRewardBenchmarkCli } from "../src/reward-credit-benchmark-cli.mjs";

test("memory-reward-benchmark dry-run validates all cases without creating a generator", async () => {
  let factoryCalls = 0;
  let output = "";
  const result = await runMemoryRewardBenchmarkCli({
    args: ["--dry-run"],
    stdout: { write: (value) => { output += value; } },
    agentGeneratorFactory: () => {
      factoryCalls += 1;
      throw new Error("dry-run must not create a generator");
    },
  });
  assert.equal(factoryCalls, 0);
  assert.equal(result.cases, 140);
  assert.equal(result.suite, "mini-v1");
  assert.equal(Object.keys(result.categories).length, 14);
  assert.equal(result.externalModelCalls, 0);
  assert.match(output, /"status": "validated"/u);
});

test("memory-reward-benchmark dry-run validates the frozen holdout without creating a generator", async () => {
  let factoryCalls = 0;
  const result = await runMemoryRewardBenchmarkCli({
    args: ["--suite", "holdout-v1", "--dry-run"],
    stdout: { write: () => {} },
    agentGeneratorFactory: () => {
      factoryCalls += 1;
      throw new Error("dry-run must not create a generator");
    },
  });
  assert.equal(factoryCalls, 0);
  assert.equal(result.suite, "holdout-v1");
  assert.equal(result.cases, 84);
  assert.equal(Object.keys(result.categories).length, 14);
  assert.deepEqual([...new Set(Object.values(result.categories))], [6]);
  assert.equal(result.externalModelCalls, 0);
});

test("memory-reward-benchmark checkpoints and reports one bounded model case", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-reward-benchmark-cli-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "agent");
  const dataRoot = path.join(root, "data");
  const outputPath = path.join(root, "report.json");
  fs.mkdirSync(projectRoot, { recursive: true });
  let factoryCalls = 0;
  const generator = async ({ schemaName, input }) => {
    const parsed = JSON.parse(input);
    const memoryId = parsed.usedMemories[0].id;
    if (schemaName === "memory-reward-outcome-v1") return { output: {
      outcomeClass: "explicit_help",
      valence: "positive",
      evidenceTier: "explicit_attribution",
      confidence: 0.98,
      rationale: "用户明确表示旧方法提供了帮助。",
    } };
    if (schemaName === "memory-reward-target-v1") return { output: {
      targetType: "retrieved_memory",
      targetMemoryIds: [memoryId],
      explicitAttribution: true,
      confidence: 0.98,
      rationale: "反馈明确指向被召回的方法。",
    } };
    return { output: { analyses: [{
      memoryId,
      contributionClass: "direct",
      contributionShare: 1,
      contextKey: "problem-solving",
      confidence: 0.98,
      rationale: "该记忆直接促成结果。",
    }] } };
  };
  let output = "";
  const result = await runMemoryRewardBenchmarkCli({
    args: [
      "--max-cases", "1",
      "--output", outputPath,
      "--project-root", projectRoot,
      "--data-root", dataRoot,
    ],
    stdout: { write: (value) => { output += value; } },
    agentGeneratorFactory: () => {
      factoryCalls += 1;
      return generator;
    },
  });
  assert.equal(factoryCalls, 1);
  assert.equal(result.status, "completed");
  assert.equal(result.selection.count, 1);
  assert.equal(result.metrics.memoryDecisionExactRate, 1);
  assert.equal(fs.existsSync(outputPath), true);
  assert.match(output, /"status": "completed"/u);
  assert.equal(result.automaticStateMutationAllowed, false);
});
