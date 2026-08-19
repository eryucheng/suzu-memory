import assert from "node:assert/strict";
import test from "node:test";

import { createInjectedStructuredGenerator } from "../src/index.mjs";

test("offline memory tools require their host to supply a structured generator", () => {
  assert.throws(
    () => createInjectedStructuredGenerator(null, { label: "memory-analyze" }),
    /memory-analyze requires an explicitly supplied structured generator/u,
  );
});

test("injected generator receives the selected model and preserves its callable surface", () => {
  const generator = async () => ({ output: {} });
  let received = null;
  const selected = createInjectedStructuredGenerator((options) => {
    received = options;
    return generator;
  }, { label: "memory-analyze", model: "deepseek-chat" });
  assert.equal(selected, generator);
  assert.deepEqual(received, { model: "deepseek-chat" });
});
