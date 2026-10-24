import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { closeRetrievalWorker, retrieveMemories } from '../src/index.mjs';

const agentId = 'short-keyword-agent';
let root;
let databasePath;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-short-keyword-'));
  databasePath = path.join(root, 'memory.db');
  const database = openMemoryDatabase(databasePath);
  try {
    const repository = new MemoryRepository(database);
    for (const [id, content] of [
      ['coffee', '用户每天早上喝咖啡。'],
      ['cat', '用户养的猫是橘猫，小名是小橘。'],
      ['library', '用户周末去图书馆借书。'],
    ]) {
      repository.upsertMemory({
        id, agentId, kind: 'fact', layer: 'semantic', content,
        subjectRole: 'user', subjectKey: 'user',
      });
    }
  } finally {
    database.close();
  }
});

after(async () => {
  if (databasePath) await closeRetrievalWorker(databasePath);
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function recall(query) {
  return retrieveMemories({
    databasePath, agentId, query,
    now: new Date('2026-10-24T12:00:00+08:00'),
  });
}

async function assertRecalls(query, memoryId, contentPattern) {
  const result = await recall(query);
  assert.equal(result.status, 'ready', query);
  assert.ok(result.candidates.some(candidate => candidate.memoryId === memoryId), query);
  assert.match(result.context, contentPattern);
}

for (const [query, memoryId, contentPattern] of [
  ['咖啡', 'coffee', /喝咖啡/u],
  ['我喝咖啡吗', 'coffee', /喝咖啡/u],
  ['我早上喝什么', 'coffee', /喝咖啡/u],
  ['小橘', 'cat', /小橘/u],
]) {
  test(`recalls a matching fact without vectors: ${query}`, async () => {
    await assertRecalls(query, memoryId, contentPattern);
  });
}

for (const [query, memoryId, contentPattern] of [
  ['我说过咖啡的事吗', 'coffee', /喝咖啡/u],
  ['我家的猫叫什么', 'cat', /小橘/u],
  ['橘猫叫什么名字', 'cat', /小橘/u],
]) {
  test(`recalls a two-character topic inside a question without vectors: ${query}`, {
    todo: 'A single two-character match in a longer question is not admitted without vectors.',
  }, async () => {
    await assertRecalls(query, memoryId, contentPattern);
  });
}

test('does not replace a missing two-character topic with an unrelated fact', async () => {
  const result = await recall('我说过滑雪的事吗');
  assert.equal(result.status, 'no-match');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.context, '');
});
