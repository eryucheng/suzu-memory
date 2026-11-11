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

test('unchanged search text avoids FTS writes while link metadata and invalidated prefilter text remain current', t => {
  const database = openMemoryDatabase(':memory:');
  t.after(() => database.close());
  const writes = [];
  const repository = new MemoryRepository({ exec: database.exec.bind(database), prepare(sql) {
    const statement = database.prepare(sql);
    return new Proxy(statement, { get(target, key) {
      if (key === 'run') return (...parameters) => {
        if (/^(?:INSERT INTO|DELETE FROM|UPDATE) memory_fts\b/u.test(sql.trim())) writes.push(sql);
        return target.run(...parameters);
      };
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } });
  } });
  repository.upsertMemory({ id: 'indexed', agentId: 'test', kind: 'event', layer: 'episodic',
    content: 'Avery enjoys ceramics, gardening and astronomy.' });
  writes.length = 0;
  for (const name of ['ceramics', 'gardening', 'astronomy']) {
    const concept = repository.upsertEntity({ agentId: 'test', kind: 'concept', canonicalName: name });
    repository.linkMemoryEntity({ memoryId: 'indexed', entityId: concept.id });
  }
  assert.equal(repository.listMemoryEntities('indexed').length, 3);
  assert.equal(writes.length, 0, 'adding already stated concepts does not rewrite the same search document');
  database.prepare('UPDATE memory_fts_rows SET lexical_text=NULL WHERE memory_id=?').run('indexed');
  repository.syncSearch('indexed');
  assert.ok(database.prepare('SELECT lexical_text FROM memory_fts_rows WHERE memory_id=?').get('indexed').lexical_text.includes('gardening'));
  assert.equal(writes.length, 0, 'prefilter invalidation is repaired without rebuilding unchanged FTS text');
  assert.equal(repository.search('test', 'gardening')[0].id, 'indexed');
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

for (const language of [
  { name: 'English', concept: 'optical astronomy', alias: 'night sky study', renamed: 'amateur stargazing',
    content: 'Avery attends the weekly activity.' },
  { name: 'Chinese', concept: '业余天文观测', alias: '夜空观察', renamed: '周末观星',
    content: '小禾每周都会参加那项活动。' },
]) {
  test(`concept names follow link, rename, rollback and unlink without changing the memory: ${language.name}`, t => {
    const database = openMemoryDatabase(':memory:');
    t.after(() => database.close());
    const repository = new MemoryRepository(database);
    repository.upsertMemory({ id: 'activity', agentId: 'test', kind: 'event', layer: 'episodic', content: language.content });
    const concept = repository.upsertEntity({ agentId: 'test', kind: 'concept', canonicalName: language.concept, aliases: [language.alias] });
    assert.equal(repository.search('test', language.alias).length, 0);
    repository.linkMemoryEntity({ memoryId: 'activity', entityId: concept.id });
    assert.equal(repository.search('test', language.alias)[0].id, 'activity');
    const before = repository.search('test', language.alias);
    repository.linkMemoryEntity({ memoryId: 'activity', entityId: concept.id });
    assert.deepEqual(repository.search('test', language.alias), before);
    repository.upsertEntity({ id: concept.id, agentId: 'test', kind: 'concept', canonicalName: language.renamed });
    assert.equal(repository.search('test', language.renamed)[0].id, 'activity');
    assert.equal(repository.search('test', language.concept)[0].id, 'activity', 'the previous name remains a declared alias');
    assert.equal(repository.getMemory('activity').content, language.content);
    database.exec('BEGIN');
    repository.unlinkMemoryEntity({ memoryId: 'activity', entityId: concept.id });
    assert.equal(repository.search('test', language.alias).length, 0);
    database.exec('ROLLBACK');
    assert.equal(repository.search('test', language.alias)[0].id, 'activity');
    repository.unlinkMemoryEntity({ memoryId: 'activity', entityId: concept.id });
    assert.equal(repository.search('test', language.alias).length, 0);
    assert.equal(database.prepare('SELECT count(*) n FROM memory_fts').get().n, 1);

    repository.upsertMemory({ id: 'activity', agentId: 'test', kind: 'event', layer: 'episodic', content: language.concept });
    repository.linkMemoryEntity({ memoryId: 'activity', entityId: concept.id });
    const indexed = database.prepare('SELECT content FROM memory_fts').get().content;
    assert.equal(indexed.split(language.concept).length - 1, 1, 'a body occurrence and its concept link share textual evidence');
    repository.unlinkMemoryEntity({ memoryId: 'activity', entityId: concept.id });
    assert.equal(repository.search('test', language.concept)[0].id, 'activity', 'unlinking metadata preserves matching original text');
  });
}

test('v50 concept links become searchable on upgrade while stored records and source scope stay unchanged', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-concept-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'memory.db');
  let database = openMemoryDatabase(file);
  const repository = new MemoryRepository(database);
  const memory = repository.upsertMemory({ id: 'legacy', agentId: 'test', kind: 'event', layer: 'episodic',
    content: 'Avery helped there every weekend.', worldId: 'story', worldFrame: 'fictional' });
  const concept = repository.upsertEntity({ agentId: 'test', kind: 'concept', canonicalName: 'community gardening' });
  repository.linkMemoryEntity({ memoryId: memory.id, entityId: concept.id });
  database.prepare('UPDATE memory_fts SET content=? WHERE memory_id=?').run(memory.content, memory.id);
  database.prepare('UPDATE memory_fts_rows SET lexical_text=NULL WHERE memory_id=?').run(memory.id);
  for (const row of database.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'retrieval_revision_memory_entities_%' OR name='retrieval_revision_concept_names')").all()) {
    database.exec(`DROP TRIGGER "${row.name}"`);
  }
  database.exec('DELETE FROM schema_migrations WHERE version=51');
  assert.equal(repository.search('test', 'gardening').length, 0);
  database.close();
  database = openMemoryDatabase(file);
  try {
    const upgraded = new MemoryRepository(database);
    assert.deepEqual(upgraded.getMemory(memory.id), memory);
    assert.equal(upgraded.search('test', 'gardening', { worldId: 'story', worldFrame: 'fictional' })[0].id, memory.id);
    assert.equal(upgraded.search('test', 'gardening', { worldId: 'elsewhere' }).length, 0);
    assert.equal(upgraded.search('another-agent', 'gardening').length, 0);
    const plan = database.prepare(`EXPLAIN QUERY PLAN SELECT link.memory_id FROM memory_entities link
      JOIN entities entity ON entity.id=link.entity_id WHERE link.memory_id IN (SELECT value FROM json_each(?))
      AND entity.agent_id=? AND entity.kind='concept'`).all(JSON.stringify([memory.id]), 'test');
    assert.ok(plan.some(row => /SEARCH link.*memory_id/u.test(row.detail)), JSON.stringify(plan));
  } finally { database.close(); }
});
