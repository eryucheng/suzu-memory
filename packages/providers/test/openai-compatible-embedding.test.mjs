import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiCompatibleEmbeddingProvider } from "../src/index.mjs";

test("OpenAI compatible embedding provider supports ordered batches without breaking single queries", async () => {
  const requests = [];
  const provider = createOpenAiCompatibleEmbeddingProvider({
    baseUrl: "https://example.test/v1",
    apiKey: "test-key",
    model: "embedding-test",
    dimensions: 3,
    fetchImplementation: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      const inputs = JSON.parse(options.body).input;
      return new Response(JSON.stringify({
        model: "embedding-test",
        data: inputs.map((_, index) => ({
          index: inputs.length - index - 1,
          embedding: [inputs.length - index, 1, 0],
        })).reverse(),
        usage: { prompt_tokens: inputs.length },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "request-1" },
      });
    },
  });

  const batch = await provider.embedMany(["甲", "乙"]);
  assert.equal(batch.vectors.length, 2);
  assert.equal(batch.vectors[0].length, 3);
  assert.ok(Math.abs(batch.vectors[0][0] - 1 / Math.sqrt(2)) < 1e-6);
  assert.ok(Math.abs(batch.vectors[1][0] - 2 / Math.sqrt(5)) < 1e-6);
  assert.equal(batch.requestId, "request-1");
  assert.deepEqual(requests[0].body, {
    model: "embedding-test",
    input: ["甲", "乙"],
    dimensions: 3,
  });

  const single = await provider("丙");
  assert.equal(single.vector.length, 3);
  assert.equal(single.vectors.length, 1);
  assert.equal(provider.model, "embedding-test");
  assert.equal(provider.dimensions, 3);
});

test('rejects ambiguous batches and unusable vectors while retaining the charged response', async () => {
  for (const data of [
    [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }],
    [{ index: 0, embedding: [1, 0] }, { index: 2, embedding: [0, 1] }],
    [{ index: 0, embedding: [1, 0] }, { embedding: [0, 1] }],
    [{ index: 0, embedding: [0, 0] }, { index: 1, embedding: [0, 1] }],
  ]) {
    const provider = createOpenAiCompatibleEmbeddingProvider({
      baseUrl: 'https://example.test/v1', apiKey: 'test-key', model: 'embedding-test',
      fetchImplementation: async () => new Response(JSON.stringify({
        data, model: 'embedding-test', usage: { prompt_tokens: 17, total_tokens: 17 },
      }), { headers: { 'x-request-id': 'charged-invalid-response' } }),
    });
    await assert.rejects(provider.embedMany(['Caroline likes swimming.', 'Melanie likes hiking.']), error => {
      assert.match(error.message, /index|向量/u);
      assert.deepEqual(error.usage, { prompt_tokens: 17, total_tokens: 17 });
      assert.equal(error.model, 'embedding-test');
      assert.equal(error.requestId, 'charged-invalid-response');
      return true;
    });
  }
});
