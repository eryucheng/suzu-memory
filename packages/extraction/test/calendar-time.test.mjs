import assert from 'node:assert/strict';
import test from 'node:test';
import { buildLongTermExtractionInput } from '../src/index.mjs';

test('extraction renders local timestamps and an explicit timezone without changing source evidence', () => {
  const timestamp = '2026-10-21T23:30:00.000Z';
  const message = { id: 'early-morning', role: 'user', timestamp, text: '今天去了灯塔博物馆。' };
  const built = buildLongTermExtractionInput({ messages: [message],
    previousContextMessages: [{ ...message, id: 'previous', timestamp: '2026-10-21T16:00:00.000Z' }],
    continuationGuidanceMessages: [{ ...message, id: 'next', timestamp: '2026-10-22T00:00:00.000Z' }] });
  assert.match(built.input, /Asia\/Shanghai/);
  assert.match(built.input, /2026-10-22T07:30:00\.000\+08:00/);
  assert.match(built.input, /2026-10-22T00:00:00\.000\+08:00/);
  assert.match(built.input, /2026-10-22T08:00:00\.000\+08:00/);
  assert.equal(built.messages[0].timestamp, timestamp);
  assert.equal(message.timestamp, timestamp);
});

test('extraction honors a configured timezone across daylight-saving and negative offsets', () => {
  for (const [timestamp, expected] of [
    ['2026-08-04T03:30:00.000Z', '2026-08-03T20:30:00.000-07:00'],
    ['2026-01-04T03:30:00.000Z', '2026-01-03T19:30:00.000-08:00'],
  ]) {
    const built = buildLongTermExtractionInput({ timeZone: 'America/Los_Angeles',
      messages: [{ id: 'local-evening', role: 'user', timestamp, text: '今天去了灯塔博物馆。' }] });
    assert.ok(built.input.includes(expected), built.input);
    assert.match(built.input, /America\/Los_Angeles/);
    assert.equal(built.messages[0].timestamp, timestamp);
  }
});
