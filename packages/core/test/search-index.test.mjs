import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '../src/index.mjs';

test('search updates delete through indexed rowids and keep one current entry', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  const update = content => repository.upsertMemory({ id: 'indexed', agentId: 'test', kind: 'event', layer: 'episodic', content });
  update('最初讨论猫咪。');
  for (let count = 0; count < 20; count++) update(`现在讨论灯塔博物馆 ${count}。`);
  assert.equal(database.prepare('SELECT count(*) n FROM memory_fts').get().n, 1);
  assert.equal(database.prepare('SELECT count(*) n FROM memory_fts_rows').get().n, 1);
  assert.equal(repository.search('test', '猫咪').length, 0);
  assert.equal(repository.search('test', '灯塔博物馆')[0].id, 'indexed');
  database.exec('BEGIN IMMEDIATE');
  update('外部事务中临时改成紫藤艺术馆。');
  assert.equal(repository.search('test', '紫藤艺术馆')[0].id, 'indexed');
  database.exec('ROLLBACK');
  assert.equal(repository.search('test', '紫藤艺术馆').length, 0);
  assert.equal(repository.search('test', '灯塔博物馆')[0].id, 'indexed');
  const plan = database.prepare('EXPLAIN QUERY PLAN SELECT fts_rowid FROM memory_fts_rows WHERE memory_id=?').all('indexed');
  assert.ok(plan.some(row => row.detail.includes('INDEX memory_fts_rows_memory')));
  const ftsPlan = database.prepare('EXPLAIN QUERY PLAN DELETE FROM memory_fts WHERE rowid=?').all(1);
  assert.ok(ftsPlan.some(row => row.detail.includes('=')), JSON.stringify(ftsPlan));
});

test('v44 search rows are backfilled without changing stored records or search ranks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-search-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'memory.db');
  let database = openMemoryDatabase(file);
  const repository = new MemoryRepository(database);
  repository.upsertMemory({ id: 'legacy', agentId: 'test', kind: 'event', layer: 'episodic', content: '科技馆机器人展。' });
  const before = repository.search('test', '科技馆');
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'retrieval_revision_%' OR name='memory_lexical_text_invalidate')").all()) {
    database.exec(`DROP TRIGGER "${row.name}"`);
  }
  database.exec(`DROP TABLE memory_fts_rows; DELETE FROM schema_migrations WHERE version=45;
    DELETE FROM memory_meta WHERE key IN ('retrieval-database-id','retrieval-revision');`);
  database.close();
  database = openMemoryDatabase(file);
  try {
    assert.deepEqual(new MemoryRepository(database).search('test', '科技馆'), before);
    assert.equal(database.prepare('SELECT memory_id FROM memory_fts_rows').get().memory_id, 'legacy');
  } finally { database.close(); }
});
