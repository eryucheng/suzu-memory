import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySearchSession } from '@suzu-memory/service';
import { answerWithMemoryTools } from '../src/memory-tool-answer.mjs';

const toolCall = (id, query, anchors) => ({ id, type: 'function',
  function: { name: 'suzu_memory_search', arguments: JSON.stringify({ query, ...(anchors ? { anchors } : {}) }) } });

for (const queries of [['Avery hobbies', 'Avery outdoor activities'], ['小明的爱好', '小明的户外活动']]) {
  test(`the reader can follow a full Top10 with another full search: ${queries[0]}`, async () => {
    const searches = [], prefixes = [];
    const session = createMemorySearchSession({ maximumContextChars: 1000,
      memory: { defaults: { retrieval: { maximumContextMemories: 10 } },
        async search(query, options) {
          searches.push(query);
          assert.equal(options.options.maximumContextMemories, 10);
          assert.equal(options.options.maximumContextChars, 1000);
          assert.deepEqual(options.anchors, query === queries[1] ? ['0-1'] : []);
          return { status: 'ready', records: Array.from({ length: 10 }, (_, index) => ({
            memoryId: `${queries.indexOf(query)}-${index}`, text: `${query}: fact ${index}.`,
          })) };
        } } });
    let step = 0;
    const result = await answerWithMemoryTools({ messages: [{ role: 'user', content: queries[0] }],
      searchSession: session, complete: async (messages, options) => {
        assert.equal(options.tools[0].function.name, 'suzu_memory_search');
        prefixes.push(structuredClone(messages));
        const query = queries[step++];
        return { message: query ? { role: 'assistant', content: null,
          tool_calls: [toolCall(`call-${step}`, query, step === 2 ? ['m2'] : undefined)] }
          : { role: 'assistant', content: 'The answer combines both searches.' } };
      } });
    assert.deepEqual(searches, queries);
    assert.equal(result.answer, 'The answer combines both searches.');
    assert.equal(result.search.emittedRecords, 20);
    const toolMessages = result.messages.filter(message => message.role === 'tool');
    assert.equal(toolMessages.length, 2);
    assert.match(toolMessages[0].content, /记忆编号：m2\n/u);
    assert.match(toolMessages[1].content, /记忆编号：m11\n/u);
    assert.deepEqual(prefixes[2].slice(0, prefixes[1].length), prefixes[1]);
  });
}

test('only the tool-call limit disables follow-up tools before the final reader call', async () => {
  const session = createMemorySearchSession({ maximumSearches: 2, maximumContextMemories: 1, maximumContextChars: 180,
    memory: { async search(query) {
      return { status: 'ready', records: [{ memoryId: query, text: 'Evidence. '.repeat(10) }] };
    } } });
  let calls = 0;
  const result = await answerWithMemoryTools({ messages: [], searchSession: session,
    complete: async (_messages, options) => {
      if (++calls <= 2) {
        assert.ok(options.tools);
        return { message: { role: 'assistant', tool_calls: [toolCall(`call-${calls}`, `query-${calls}`)] } };
      }
      assert.equal(options.tools, undefined);
      return { message: { role: 'assistant', content: 'The fact.' } };
    } });
  assert.equal(calls, 3);
  assert.equal(result.search.searches, 2);
  assert.equal(result.search.emittedRecords, 2);
  assert.ok(result.search.emittedChars > 180);
});

test('a batch of tool calls cannot exceed the search-call limit', async () => {
  let reads = 0, calls = 0;
  const session = createMemorySearchSession({ maximumSearches: 2,
    memory: { async search() { reads++; return { status: 'no-match', records: [] }; } } });
  const result = await answerWithMemoryTools({ messages: [], searchSession: session,
    complete: async (_messages, options) => ++calls === 1
      ? { message: { role: 'assistant', tool_calls: ['first', 'second', 'third'].map(id => toolCall(id, id)) } }
      : (assert.equal(options.tools, undefined), { message: { role: 'assistant', content: 'No evidence found.' } }) });
  assert.equal(reads, 2);
  assert.equal(result.search.calls, 2);
  assert.equal(result.messages.filter(message => message.role === 'tool').length, 3);
});
