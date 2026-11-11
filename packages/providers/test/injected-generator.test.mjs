import assert from "node:assert/strict";
import test from "node:test";

import { createInjectedStructuredGenerator } from "../src/index.mjs";

test("offline memory tools require their host to supply a structured generator", () => {
  assert.throws(
    () => createInjectedStructuredGenerator(null, { label: "memory-analyze" }),
    /memory-analyze requires an explicitly supplied structured generator/u,
  );
});

test("injected generator preserves host model selection, execution and request budget hooks", async () => {
  const requests = [], budgetChecks = [];
  const generator = Object.assign(async request => { requests.push(request); return { output: { memories: [] } }; },
    { assertRequestBudget: request => budgetChecks.push(request) });
  let received = null;
  const selected = createInjectedStructuredGenerator((options) => {
    received = options;
    return generator;
  }, { label: "memory-analyze", model: "deepseek-chat" });
  assert.deepEqual(received, { model: "deepseek-chat" });
  const request = { input: 'Lin visited the museum.', schemaName: 'memory-extraction' };
  selected.assertRequestBudget(request);
  assert.deepEqual(await selected(request), { output: { memories: [] } });
  assert.deepEqual(requests, [request]);
  assert.deepEqual(budgetChecks, [request]);
});
