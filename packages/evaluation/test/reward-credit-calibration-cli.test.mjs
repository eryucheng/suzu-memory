import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";

import { runMemoryRewardCalibrationCli } from "../src/reward-credit-calibration-cli.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-reward-calibration-cli-"));
  const databasePath = path.join(root, "memory.db");
  const database = openMemoryDatabase(databasePath);
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "social-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "完全虚构的普通聊天记忆。",
  });
  const trace = repository.recordRetrievalTrace({
    id: "social-trace",
    agentId: "agent-test",
    queryText: "今天怎么样",
    recallIntent: "ordinary",
    resultStatus: "ready",
    selectedIds: ["social-memory"],
    metadata: { runtimeSessionKey: "social-session" },
  });
  repository.setRetrievalSessionHead({
    agentId: "agent-test",
    sessionId: "social-session",
    traceId: trace.id,
  });
  repository.bindRetrievalUsageResponse({
    agentId: "agent-test",
    sessionId: "social-session",
    responseText: "普通陪伴回复。",
  });
  const observation = repository.bindRewardObservation({
    agentId: "agent-test",
    sessionId: "social-session",
    feedbackText: "抱抱你。",
  });
  for (const [index, role, output] of [
    [1, "outcome", { outcomeClass: "social_affect" }],
    [2, "target", { targetType: "social_tone" }],
    [3, "credit", { credits: [] }],
  ]) {
    repository.recordRewardAnalysisRun({
      observationId: observation.id,
      agentId: "agent-test",
      analyzerRole: role,
      promptVersion: `${role}-test-v1`,
      schemaVersion: `${role}-test-v1`,
      inputHash: String(index).repeat(64),
      status: "completed",
      output,
    });
  }
  database.close();
  const casesPath = path.join(root, "labels.json");
  const outputPath = path.join(root, "report.json");
  fs.writeFileSync(casesPath, JSON.stringify({ cases: [{
    caseId: "social-affect-1",
    observationId: observation.id,
    category: "social_affect",
    expected: {
      outcomeClass: "social_affect",
      feedbackTarget: "social_tone",
      memoryCredits: [],
      pathCredits: [],
      mustNotChange: ["content", "subject", "confidence", "base_edge_weight"],
    },
  }] }));
  return { root, databasePath, casesPath, outputPath };
}

test("memory-reward-calibrate reads stored shadow results without changing memory", async (context) => {
  const values = fixture();
  context.after(() => fs.rmSync(values.root, { recursive: true, force: true }));
  let output = "";
  const result = await runMemoryRewardCalibrationCli({
    args: [
      "--database", values.databasePath,
      "--agent", "agent-test",
      "--cases", values.casesPath,
      "--output", values.outputPath,
    ],
    stdout: { write: (value) => { output += value; } },
  });
  assert.equal(result.metrics.cases, 1);
  assert.equal(result.metrics.outcomeAccuracy, 1);
  assert.equal(result.metrics.affectAsRewardFalsePositiveRate, 0);
  assert.equal(result.automaticStateMutationAllowed, false);
  assert.equal(fs.existsSync(values.outputPath), true);
  assert.match(output, /"status": "calibration-report"/u);

  const database = openMemoryDatabase(values.databasePath);
  const repository = new MemoryRepository(database);
  assert.equal(repository.listMemoryConsolidationStates("agent-test").length, 0);
  assert.equal(repository.listRewardApplications("agent-test").length, 0);
  database.close();
});
