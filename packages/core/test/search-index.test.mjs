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

test('search keeps scope and acceptance limits through the short-query fallback', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  for (const [id, content] of [['first', '猫咪'], ['second', '猫咪喜欢晒太阳。'], ['third', '猫咪喜欢午睡。']]) {
    repository.upsertMemory({ id, agentId: 'test', kind: 'event', layer: 'episodic', content });
  }
  const matches = repository.search('test', '猫咪', { limit: 1, eligibleMemoryIds: new Set(['second', 'third']),
    acceptMatch: memory => memory.id === 'third' });
  assert.deepEqual(matches.map(memory => memory.id), ['third']);
  assert.ok(!Object.hasOwn(matches[0], 'search_document'));
  const error = new Error('Caller cancelled the match.');
  assert.throws(() => repository.search('test', '猫咪', { acceptMatch() { throw error; } }), error);
  assert.equal(repository.search('test', '猫咪', { limit: 1 }).length, 1);
});

test('search pages accepted matches on supported SQLite runtimes without statement iterators', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const repository = new MemoryRepository(database);
  for (let i = 0; i < 25; i++) repository.upsertMemory({ id: `old-${i}`, agentId: 'test',
    kind: 'event', layer: 'episodic', content: '科技馆', status: 'archived', importance: 1 });
  repository.upsertMemory({ id: 'current', agentId: 'test', kind: 'event', layer: 'episodic',
    content: '参观科技馆，参加机器人展和科学讲座。' });
  const pageSizes = [];
  const oldRuntime = new MemoryRepository({ exec: database.exec.bind(database), prepare(sql) {
    const statement = database.prepare(sql);
    return { sourceSQL: statement.sourceSQL, get: statement.get.bind(statement), all(...parameters) {
      const result = statement.all(...parameters);
      if (sql.includes('OFFSET')) pageSizes.push(result.length);
      return result;
    } };
  } });
  const options = { limit: 20, includeArchived: true, acceptMatch: memory => memory.status !== 'archived' };
  assert.deepEqual(oldRuntime.search('test', '科技馆', options), repository.search('test', '科技馆', options));
  assert.deepEqual(pageSizes, [20, 6]);
  assert.throws(() => oldRuntime.search('test', '科技馆', { acceptMatch() { throw new Error('cancelled'); } }), /cancelled/u);
  database.exec('BEGIN; ROLLBACK');
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
