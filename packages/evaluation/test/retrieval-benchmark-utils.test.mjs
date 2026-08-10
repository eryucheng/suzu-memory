import assert from "node:assert/strict";
import test from "node:test";

import {
  drainBenchmarkSemanticMaintenance,
} from "../src/retrieval-benchmark-utils.mjs";

function maintenanceStatus(stateRequestIds = []) {
  const items = stateRequestIds.map((id) => ({ id, status: "pending" }));
  return {
    tasks: [],
    pendingStateAnalysisRequests: items.length,
    stateAnalysisRequests: {
      pending: items.length,
      blocked: 0,
      failed: 0,
      total: items.length,
      items,
    },
    consolidationRuns: { planned: 0, running: 0, failed: 0 },
  };
}

function selectedStateRequestResult() {
  return {
    semanticTasks: { selected: 0 },
    stateAnalysis: { selected: 1 },
    consolidation: { selected: 0 },
  };
}

test("semantic maintenance retries one unchanged retryable state request", async () => {
  let attempts = 0;
  const service = {
    maintenanceStatus() {
      return attempts >= 2 ? maintenanceStatus() : maintenanceStatus(["state-1"]);
    },
    async runSemanticMaintenance() {
      attempts += 1;
      return selectedStateRequestResult();
    },
  };
  const result = await drainBenchmarkSemanticMaintenance({
    service,
    options: { generator: async () => ({}) },
    maximumPasses: 10,
  });
  assert.equal(attempts, 2);
  assert.equal(result.complete, true);
  assert.equal(result.pendingAfter, 0);
  assert.equal(result.hitStagnantLimit, false);
});

test("semantic maintenance stops after three identical no-progress retries", async () => {
  let attempts = 0;
  const service = {
    maintenanceStatus() {
      return maintenanceStatus(["state-1"]);
    },
    async runSemanticMaintenance() {
      attempts += 1;
      return selectedStateRequestResult();
    },
  };
  const result = await drainBenchmarkSemanticMaintenance({
    service,
    options: { generator: async () => ({}) },
    maximumPasses: 10,
  });
  assert.equal(attempts, 3);
  assert.equal(result.complete, false);
  assert.equal(result.pendingAfter, 1);
  assert.equal(result.hitStagnantLimit, true);
  assert.equal(result.stagnantPasses, 3);
});
