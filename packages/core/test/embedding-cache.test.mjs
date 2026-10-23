import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '../src/index.mjs';

test('vector cache budgets are configurable, bounded, and preserve independent return values', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  for (let i = 0; i < 10; i++) {
    repository.upsertMemory({ id: `v-${i}`, agentId: 'cache-agent', kind: 'fact', layer: 'semantic', content: '缓存验证' });
    repository.upsertEmbedding({ memoryId: `v-${i}`, model: 'cache', vector: new Float32Array(1024).fill(i) });
  }
  const original = repository.readEmbeddingRows.bind(repository);
  let reads = 0;
  repository.readEmbeddingRows = (...args) => { reads++; return original(...args); };
  const read = cacheMaxBytes => repository.listEmbeddings('cache-agent', 'cache', { cache: true, cacheMaxBytes });
  assert.equal(read(65536).length, 10);
  const cached = read(65536);
  assert.equal(reads, 1);
  cached[0].vector[0] = 999;
  assert.notEqual(read(65536)[0].vector[0], 999);
  read(1024); read(1024);
  assert.equal(reads, 3, 'smaller budgets evict existing entries and bypass oversized indexes');
  read(); read();
  assert.equal(reads, 4, 'default budget retains the index again');
  repository.upsertEmbedding({ memoryId: 'v-0', model: 'cache', vector: new Float32Array(1024).fill(0.25) });
  assert.equal(read()[0].vector[0], 0.25);
  assert.equal(reads, 5);
  assert.throws(() => read(-1), RangeError);
});
