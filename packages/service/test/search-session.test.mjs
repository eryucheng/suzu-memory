import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySearchSession } from '../src/index.mjs';

const record = (id, text = id) => ({ memoryId: id, text: `记忆编号：${id}\n${text}` });
const reply = records => ({ status: records.length ? 'ready' : 'no-match', records });

test('every search inherits the configured record count, including after returning a full Top10', async () => {
  for (const override of [undefined, 3]) {
    const expected = override ?? 10;
    const session = createMemorySearchSession({ maximumContextChars: 4000,
      searchOptions: { options: override === undefined ? {} : { maximumContextMemories: override } },
      memory: { defaults: { retrieval: { maximumContextMemories: 10 } },
        async search(_query, options) {
          assert.equal(options.options.maximumContextMemories, expected);
          return reply(Array.from({ length: options.options.maximumContextMemories }, (_, index) => record(_query + '-' + index)));
        } } });
    for (const query of ['Avery activities', 'Avery outdoor activities']) {
      const result = await session.execute({ query });
      assert.equal(result.records.length, expected);
      assert.equal(result.memoryIds.at(-1), query + '-' + (expected - 1));
    }
    assert.equal(session.stats.emittedRecords, expected * 2);
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
  const requests = [];
  const memory = { async search(query, options) {
    requests.push(options);
    return reply(query === 'first' ? originals.slice(0, 2) : [originals[0], originals[2]]);
  } };
  const session = createMemorySearchSession({ memory, maximumContextChars: 2000 });
  const first = await session.execute({ query: 'first' });
  assert.deepEqual(first.memoryIds, ids.slice(0, 2));
  assert.strictEqual(first.records[0], originals[0]);
  assert.strictEqual(first.result.records[1], originals[1]);
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
});

test('each query has its own record limit and previously returned evidence does not occupy new slots', async () => {
  const requests = [];
  const session = createMemorySearchSession({ maximumContextChars: 1000, maximumContextMemories: 2,
    memory: { async search(query, options) { requests.push(options);
      return reply(query === 'first' ? [record('one')] : [record('one'), record('two'), record('three')]);
    } } });
  assert.deepEqual((await session.execute({ query: 'first' })).memoryIds, ['one']);
  assert.deepEqual((await session.execute({ query: 'second' })).memoryIds, ['two', 'three']);
  assert.equal(requests[1].options.maximumContextMemories, 2);
  assert.deepEqual(requests[1].options.excludedMemoryIds, ['one']);
  assert.equal((await session.execute({ query: 'third' })).status, 'already-seen');
  assert.equal(requests.length, 3);
});

test('a repeated query can retrieve another full batch before applying the per-search record limit', async () => {
  let reads = 0;
  const session = createMemorySearchSession({ maximumContextMemories: 3, maximumContextChars: 4000,
    memory: { async search(_query, options) {
      reads++;
      return reply(['one', 'two', 'three', 'four'].filter(id => !options.options.excludedMemoryIds.includes(id))
        .slice(0, options.options.maximumContextMemories).map(id => record(id)));
    } } });
  assert.deepEqual((await session.execute({ query: 'Avery activities', limit: 2 })).memoryIds, ['one', 'two']);
  assert.deepEqual((await session.execute({ query: 'Avery activities', limit: 2 })).memoryIds, ['three', 'four']);
  assert.equal(reads, 2);
});

test('the character limit applies to each response and does not disable follow-up searches', async () => {
  const session = createMemorySearchSession({
    searchOptions: { options: { maximumContextChars: 180 } },
    memory: { defaults: { retrieval: { maximumContextChars: 4000 } },
      async search(query, options) {
        assert.equal(options.options.maximumContextChars, 180);
        return reply([record(query, '有用的补充证据。'.repeat(13))]);
      } } });
  const first = await session.execute({ query: 'first' });
  const second = await session.execute({ query: 'second' });
  assert.deepEqual(first.memoryIds, ['first']);
  assert.deepEqual(second.memoryIds, ['second']);
  assert.ok(first.text.length <= 180 && second.text.length <= 180);
  assert.ok(session.stats.emittedChars > 180);
});

test('an oversized record does not mark evidence as seen or consume future response capacity', async () => {
  const session = createMemorySearchSession({ maximumContextChars: 180,
    memory: { async search(query) {
      return reply([record('one', query === 'broad' ? 'x'.repeat(300) : 'Specific evidence.')]);
    } } });
  const first = await session.execute({ query: 'broad' });
  assert.deepEqual(first.memoryIds, []);
  assert.notEqual(first.status, 'already-seen');
  await assert.rejects(session.execute({ query: 'follow-up', anchors: ['m1'] }), { code: 'INVALID_MEMORY_QUERY' });
  const second = await session.execute({ query: 'specific' });
  assert.deepEqual(second.memoryIds, ['one']);
  assert.match(second.text, /记忆编号：m1\n/u);
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
