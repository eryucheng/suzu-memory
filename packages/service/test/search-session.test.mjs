import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySearchSession } from '../src/index.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryRepository, openMemoryDatabase } from '@suzu-memory/core';
import { retrieveMemories, closeRetrievalWorker, DEFAULT_RETRIEVAL_OPTIONS } from '@suzu-memory/retriever';

const record = (id, text = id) => ({ memoryId: id, text: `记忆编号：${id}\n${text}` });
const reply = records => ({ status: records.length ? 'ready' : 'no-match', records });

test('native searches continue unread text with stable references and exclude only completed records', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-search-continuation-'));
  const databasePath = path.join(root, 'memory.db');
  t.after(async () => { await closeRetrievalWorker(databasePath); fs.rmSync(root, { recursive: true, force: true }); });
  const database = openMemoryDatabase(databasePath), repository = new MemoryRepository(database);
  try {
    for (let i = 0; i < 5; i++) repository.upsertMemory({ id: `record-${i}`, agentId: 'test', kind: 'utterance',
      layer: 'evidence', content: `博物馆 museum ${i}。` + '展馆 museum 的路线和展品介绍。'.repeat(30)
        + (i === 0 ? '猫的名字是Miso。The cat is named Miso.' : 'End of this conversation.'),
      subjectRole: 'user', subjectKey: 'lin', metadata: { speaker: 'Lin' } });
  } finally { database.close(); }
  const memory = { async search(query, options) {
    return retrieveMemories({ databasePath, agentId: 'test', query, anchorMemoryIds: options.anchors,
      options: { ...options.options, execution: 'inline' }, signal: options.signal });
  } };
  const maximumContextChars = 1200;
  const session = createMemorySearchSession({ memory, maximumContextChars });
  t.after(() => session.close());
  const first = await session.execute({ query: '博物馆 museum' });
  assert.equal(first.memoryIds.length, 5);
  assert.ok(!first.text.includes('Miso'));
  const reference = `m${first.memoryIds.indexOf('record-0') + 1}`;
  const second = await session.execute({ query: 'cat name 猫的名字', anchors: [reference] });
  assert.ok(second.text.includes('The cat is named Miso.'));
  assert.match(second.text, new RegExp('记忆编号：' + reference + '\\n'));
  const third = await session.execute({ query: 'cat name 猫的名字', anchors: [reference] });
  assert.ok(!third.text.includes('Miso'));
  assert.ok([first, second, third].every(result => result.text.length <= maximumContextChars));
  assert.ok(first.text.length + second.text.length > maximumContextChars);

  const changing = createMemorySearchSession({ memory, maximumContextChars });
  t.after(() => changing.close());
  const earlier = await changing.execute({ query: '博物馆 museum' });
  const ref = `m${earlier.memoryIds.indexOf('record-0') + 1}`;
  const editing = openMemoryDatabase(databasePath);
  const revised = '博物馆 museum：更新后的事实，猫名改为Nova。The cat is now named Nova.';
  try { new MemoryRepository(editing).editMemoryManually({ agentId: 'test', memoryId: 'record-0', patch: { content: revised } }); }
  finally { editing.close(); }
  const updated = await changing.execute({ query: 'cat name 猫的名字', anchors: [ref] });
  assert.ok(updated.text.includes(revised), 'A changed source restarts its delivery instead of using the obsolete offset.');
});

test('one cancelled caller does not cancel its peer; cancelling all callers releases and allows retry', async () => {
  let reads = 0, aborted = 0, finish;
  const started = [];
  const session = createMemorySearchSession({ memory: { search(_query, { signal }) {
    reads++;
    return new Promise((resolve, reject) => {
      const abort = () => { aborted++; reject(signal.reason); };
      signal.addEventListener('abort', abort, { once: true });
      finish = () => { signal.removeEventListener('abort', abort); resolve(reply([record('one')])); };
      started.splice(0).forEach(resolve => resolve());
    });
  } } });
  const a = new AbortController(), b = new AbortController();
  const first = session.execute({ query: 'same' }, { signal: a.signal });
  const second = session.execute({ query: 'same' }, { signal: b.signal });
  await new Promise(resolve => started.push(resolve));
  a.abort();
  await assert.rejects(first, { name: 'AbortError' });
  assert.equal(aborted, 0);
  finish();
  assert.deepEqual((await second).memoryIds, ['one']);
  assert.equal(reads, 1);

  const c = new AbortController();
  const cancelled = session.execute({ query: 'different' }, { signal: c.signal });
  await new Promise(resolve => started.push(resolve));
  c.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(aborted, 1);
  const retry = session.execute({ query: 'different' });
  await new Promise(resolve => started.push(resolve));
  session.close();
  await assert.rejects(retry, { name: 'AbortError' });
  assert.equal(aborted, 2);
  assert.equal(reads, 3);
  await assert.rejects(session.execute({ query: 'closed' }), { name: 'AbortError' });
});

test('each search uses its configured or requested limit and fills slots with new evidence', async () => {
  for (const configured of [undefined, 3]) {
    const expected = configured ?? 10;
    const all = Array.from({ length: 25 }, (_, index) => record(`event-${index}`));
    const requests = [];
    const session = createMemorySearchSession({ maximumContextChars: 4000,
      searchOptions: { options: configured === undefined ? {} : { maximumContextMemories: configured } },
      memory: { defaults: { retrieval: { maximumContextMemories: 10 } }, async search(_query, options) {
        requests.push(options);
        return reply(all.filter(record => !options.options.excludedMemoryIds.includes(record.memoryId))
          .slice(0, options.options.maximumContextMemories));
      } } });
    const first = await session.execute({ query: 'Avery activities' });
    const next = await session.execute({ query: 'Avery activities', limit: 2 });
    const followUp = await session.execute({ query: 'Avery outdoor activities' });
    assert.deepEqual([first.memoryIds.length, next.memoryIds.length, followUp.memoryIds.length], [expected, 2, expected]);
    const returned = [first, next, followUp].flatMap(result => result.memoryIds);
    assert.equal(new Set(returned).size, returned.length);
    assert.deepEqual(returned, all.slice(0, returned.length).map(record => record.memoryId));
    assert.deepEqual(requests.map(request => request.options.maximumContextMemories), [expected, 2, expected]);
  }
});

test('memory tools share in-flight searches and disclose each record once', async () => {
  let reads = 0;
  const session = createMemorySearchSession({ maximumContextChars: 2000, maximumContextMemories: 5,
    memory: { async search(_query, options) {
      reads++; assert.equal(options.persistTrace, false); assert.equal(options.reactivate, false);
      await new Promise(resolve => setTimeout(resolve, 5)); return reply([record('one')]);
    } } });
  const results = await Promise.all([session.execute({ query: 'Avery activities' }), session.execute({ query: 'Avery activities' })]);
  assert.equal(reads, 1);
  assert.equal(results.flatMap(result => result.memoryIds).length, 1);
  assert.equal(results.filter(result => result.status === 'already-seen').length, 1);
  assert.equal(session.stats.duplicateQueries, 1);
  assert.match(results.find(result => result.memoryIds.length).text, /记忆编号：m1\n/u);
});

test('model references map to internal IDs across searches without changing evidence or audit records', async () => {
  const ids = ['mem-12345678-abcd-4321-abcd-123456789abc', 'reported-state-abcdef0123456789',
    'utterance-0123456789abcdef'];
  const evidence = ['[2023-08-23] Caroline applied to adoption agencies this week.',
    '[2023-08-23] 小明说上周去游泳了。', '[2023-08-24] Further evidence.'];
  const originals = ids.map((id, index) => ({ ...record(id, evidence[index]), eventSources: [{ eventId: `source-${index}` }] }));
  const originalSnapshot = structuredClone(originals);
  const requests = [];
  const memory = { async search(query, options) {
    requests.push(options);
    return reply(query === 'first' ? originals.slice(0, 2) : [originals[0], originals[2]]);
  } };
  const session = createMemorySearchSession({ memory, maximumContextChars: 2000 });
  const first = await session.execute({ query: 'first' });
  assert.deepEqual(first.memoryIds, ids.slice(0, 2));
  assert.deepEqual(first.records, originalSnapshot.slice(0, 2));
  assert.match(first.text, /记忆编号：m1\n/u);
  assert.match(first.text, /记忆编号：m2\n/u);
  assert.ok(!first.text.includes('记忆 ID：'));
  for (let index = 0; index < 2; index++) {
    assert.ok(first.text.includes(evidence[index]));
    assert.ok(!first.text.includes(ids[index]));
    assert.equal(originals[index].text, `记忆编号：${ids[index]}\n${evidence[index]}`);
  }
  const second = await session.execute({ query: 'follow-up', anchors: [' m2 ', 'm1', 'm1'] });
  assert.deepEqual(requests[1].anchors, ids.slice(0, 2).sort());
  assert.deepEqual(requests[1].options.excludedMemoryIds, ids.slice(0, 2).sort());
  assert.deepEqual(second.memoryIds, [ids[2]]);
  assert.match(second.text, /记忆编号：m3\n/u);
  assert.ok(second.text.includes(evidence[2]));
  assert.ok(!second.text.includes(ids[2]));
  for (const anchors of [['m4'], [ids[0]]]) {
    await assert.rejects(session.execute({ query: 'invalid reference', anchors }), { code: 'INVALID_MEMORY_QUERY' });
  }
  const independent = createMemorySearchSession({ memory });
  await assert.rejects(independent.execute({ query: 'another answer', anchors: ['m1'] }), { code: 'INVALID_MEMORY_QUERY' });
  assert.equal(requests.length, 2);
  assert.equal(session.stats.calls, 2);
  assert.equal(independent.stats.calls, 0);
  assert.deepEqual(originals, originalSnapshot);
});






test('search output honors explicit budgets and otherwise inherits host or retrieval defaults', async () => {
  for (const [hostBudget, explicitBudget] of [[800, undefined], [800, 240], [undefined, undefined]]) {
    const maximum = explicitBudget ?? hostBudget ?? DEFAULT_RETRIEVAL_OPTIONS.maximumContextChars;
    const session = createMemorySearchSession({ searchOptions: { options: explicitBudget ? { maximumContextChars: explicitBudget } : {} },
      memory: { defaults: { retrieval: hostBudget ? { maximumContextChars: hostBudget } : {} },
        async search(_query, options) {
          assert.equal(options.options.maximumContextChars, maximum);
          return reply([record('evidence', 'The shared activity was swimming. '.repeat(40))]);
        } } });
    const result = await session.execute({ query: 'shared activity' });
    assert.ok(result.text.length <= maximum);
    assert.deepEqual(result.memoryIds, ['evidence']);
    assert.ok(result.text.includes('The shared activity was swimming.'));
  }
});

test('a budget too small for the response envelope does not mark evidence as seen', async () => {
  const session=createMemorySearchSession({maximumContextChars:1,memory:{async search(){return reply([record('one')]);}}});
  const result=await session.execute({query:'first'});
  assert.deepEqual(result.memoryIds,[]);
  assert.ok(result.text.length<=1);
  await assert.rejects(session.execute({query:'follow-up',anchors:['m1']}),{code:'INVALID_MEMORY_QUERY'});
});

test('failed searches can retry and cancellation emits no records', async () => {
  let reads = 0;
  const session = createMemorySearchSession({ maximumContextChars: 2000,
    memory: { async search() { if (++reads === 1) throw new Error('temporary'); return reply([record('one')]); } } });
  await assert.rejects(session.execute({ query: 'first' }), /temporary/);
  assert.deepEqual((await session.execute({ query: 'first' })).memoryIds, ['one']);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(session.execute({ query: 'cancelled' }, { signal: controller.signal }), { name: 'AbortError' });
  assert.equal(reads, 2);
});

test('the total tool-call budget also bounds repeated and empty queries', async () => {
  let reads = 0;
  const session = createMemorySearchSession({ maximumSearches: 2,
    memory: { async search() { reads++; return reply([]); } } });
  await session.execute({ query: 'no results' }); await session.execute({ query: 'no results' });
  assert.equal((await session.execute({ query: 'another query' })).status, 'budget-exhausted');
  assert.equal(reads, 1);
});
