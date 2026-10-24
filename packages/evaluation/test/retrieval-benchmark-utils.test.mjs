import assert from "node:assert/strict";
import test from "node:test";

import {
  captureBenchmarkEmbeddingUsage,
  summarizeBenchmarkEmbeddingUsage,
} from "../src/retrieval-benchmark-utils.mjs";

test("embedding instrumentation forwards provider options and preserves batch calls", async () => {
  const options = { signal: new AbortController().signal }, calls = [], records = [];
  const provider = async (text, actual) => { calls.push([text, actual]); return { vector: [1] }; };
  provider.embedMany = async (texts, actual) => { calls.push([texts, actual]); return { vectors: [[1]] }; };
  const wrapped = captureBenchmarkEmbeddingUsage(provider, () => "query", records, async () => {});
  await wrapped("one", options); await wrapped.embedMany(["two"], options);
  assert.equal(calls[0][1], options); assert.equal(calls[1][1], options);
  assert.equal(records[0].phase, "query");
});

test("failed embedding calls retain their invocation count and leave cost unknown", async () => {
  const records = [], failure = new Error("network failed");
  const wrapped = captureBenchmarkEmbeddingUsage(async () => { throw failure; }, "query", records, async () => {});
  await assert.rejects(wrapped("query"), error => error === failure);
  const summary = summarizeBenchmarkEmbeddingUsage(records, "2026-10-23T00:00:00Z");
  assert.equal(summary.requests, 1);
  assert.equal(summary.estimatedCostCny, null);
});
