import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { closeRetrievalWorker, lexicalScore, prepareLexicalQuery, recallCorePhrases, retrieveMemories } from '../src/index.mjs';

const agentId = 'short-keyword-agent';
let root;
let databasePath;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-short-keyword-'));
  databasePath = path.join(root, 'memory.db');
  const database = openMemoryDatabase(databasePath);
  try {
    const repository = new MemoryRepository(database);
    for (const [id, content, extra] of [
      ['coffee', '用户每天早上喝咖啡。'],
      ['cat', '用户养的猫是橘猫，小名是小橘。'],
      ['library', '用户周末去图书馆借书。'],
      ['agent-cat', '助手养的猫是黑猫，小名是大白。', { subjectRole: 'agent', subjectKey: agentId }],
    ]) {
      repository.upsertMemory({
        id, agentId, kind: 'fact', layer: 'semantic', content,
        subjectRole: 'user', subjectKey: 'user',
        ...extra,
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

function recall(query, options, extra = {}) {
  return retrieveMemories({
    databasePath, agentId, query,
    now: new Date('2026-10-24T12:00:00+08:00'),
    options,
    ...extra,
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
  test(`recalls a short topic inside a question without vectors: ${query}`, async () => {
    await assertRecalls(query, memoryId, contentPattern);
  });
}

for (const [query, topic, content] of [
  ['我说过咖啡的事吗', '咖啡', '用户每天早上喝咖啡。'],
  ['我聊过咖啡的事情吗', '咖啡', '用户每天早上喝咖啡。'],
  ['我家的猫叫什么', '猫', '用户养的猫是橘猫，小名是小橘。'],
  ['我的橘猫叫什么名字', '橘猫', '用户养的猫是橘猫，小名是小橘。'],
  ['我家狗叫什么名字', '狗', '用户家里养的狗叫大黄。'],
  ['我的鸟名字是什么', '鸟', '用户养的鸟叫啾啾。'],
  ['学校叫什么名称', '学校', '用户的学校是星海学校。'],
  ['我家乡叫什么名字', '家乡', '用户的家乡是青岛。'],
  ['你家庭叫什么名字', '家庭', '家庭的名字是星海之家。'],
  ['我的家乡叫什么名字', '家乡', '用户的家乡是青岛。'],
]) test(`extracts a literal topic from a recall or naming question: ${query}`, () => {
  assert.deepEqual(recallCorePhrases(query), [topic]);
  const match = lexicalScore(prepareLexicalQuery(query), content);
  assert.ok(match.exactPhrase);
  assert.ok(match.matchedTerms.includes(topic));
});

for (const query of ['我的猫叫什么名字', '我家猫叫什么', '我家的猫名字是什么',
  '我家的猫 叫什么', '我家的猫叫 什么名字', '我家的 猫叫什么名字', '我家 猫叫什么', '我的猫名字 是什么']) {
  test(`keeps the owner of a named pet: ${query}`, async () => {
    const result = await recall(query);
    assert.equal(result.status, 'ready');
    assert.match(result.context, /小橘/u);
    assert.ok(result.candidates.some(candidate => candidate.memoryId === 'cat'));
    assert.ok(!result.candidates.some(candidate => candidate.memoryId === 'agent-cat'));
    assert.doesNotMatch(result.context, /大白/u);
  });
}

test('resolves the other participant when asking for their pet name', async () => {
  const result = await recall('你的猫叫什么名字');
  assert.equal(result.status, 'ready');
  assert.match(result.context, /大白/u);
  assert.ok(result.candidates.some(candidate => candidate.memoryId === 'agent-cat'));
  assert.ok(!result.candidates.some(candidate => candidate.memoryId === 'cat'));
  assert.doesNotMatch(result.context, /小橘/u);
});

test('spaced naming questions respect an agent speaking perspective', async () => {
  const perspective = { queryPerspective: { speakerRole: 'agent', speakerKey: agentId, addresseeRole: 'user', addresseeKey: 'user' } };
  for (const [query, expectedId, excludedId] of [
    ['我的猫 叫什么名字', 'agent-cat', 'cat'],
    ['你的猫叫 什么名字', 'cat', 'agent-cat'],
  ]) {
    const result = await recall(query, undefined, perspective);
    assert.equal(result.status, 'ready', query);
    assert.ok(result.candidates.some(candidate => candidate.memoryId === expectedId));
    assert.ok(!result.candidates.some(candidate => candidate.memoryId === excludedId));
  }
});

test('a possessive prefix does not turn a noun starting with home into a single-character topic', () => {
  assert.equal(lexicalScore('我家乡叫什么名字', '用户周末去乡村散步。').score, 0);
  assert.equal(lexicalScore('你家庭叫什么名字', '用户在庭院里浇花。').score, 0);
});

for (const execution of ['inline', 'worker']) test(`short topics survive SQL prefilter and deferred bodies (${execution})`, async () => {
  for (const query of ['我说过咖啡的事吗', '我家的猫叫什么', '橘猫叫什么名字']) {
    const reference = await recall(query, { execution: 'inline', sqlPrefilter: false });
    assert.equal(reference.status, 'ready', query);
    const actual = await recall(query, { execution, sqlPrefilterThreshold: 1 });
    assert.deepEqual(actual, reference, query);
  }
});

for (const query of ['我家的狗叫什么', '我家的鱼叫什么名字', '我提过滑雪的事情吗']) {
  test(`a missing short topic returns no unrelated memories: ${query}`, async () => {
    const result = await recall(query);
    assert.equal(result.status, 'no-match');
    assert.deepEqual(result.candidates, []);
    assert.equal(result.context, '');
  });
}

test('a grammatical character or one digit is not promoted to an exact topic', () => {
  for (const query of ['我', '的', '吗', '1']) {
    assert.equal(lexicalScore(query, '我的猫在 1 号房间。').exactPhrase, false, query);
  }
});

test('single characters in a longer question are not promoted to complete topics', () => {
  const query = '他们用什么来耕地 A 拖拉机 B 犁耙 C 坦克 D 牛';
  assert.ok(!prepareLexicalQuery(query).queryTerms.includes('牛'));
  assert.equal(lexicalScore(query, '农场里有一头牛。').score, 0);
});

test('does not replace a missing two-character topic with an unrelated fact', async () => {
  const result = await recall('我说过滑雪的事吗');
  assert.equal(result.status, 'no-match');
  assert.deepEqual(result.candidates, []);
  assert.equal(result.context, '');
});
