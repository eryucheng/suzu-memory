import test from 'node:test';
import assert from 'node:assert/strict';
import { planReplyChunk } from '../src/reply-chunks.mjs';

function rounds(from, through) {
  return Array.from({ length: through - from + 1 }, (_, n) => n + from).flatMap(round =>
    ['user', 'other-agent', 'bubble-1', 'bubble-2'].map(kind => ({
      id: `${round}-${kind}`, content: { text: `${round}-${kind}` },
      metadata: { eventSource: { eventId: `${round}-${kind}`, sourceRunId: `run-${round}`,
        sender: { kind: kind.startsWith('bubble') ? 'agent' : kind, id: kind.startsWith('bubble') ? 'self' : kind },
        spaceId: `space-${round % 3}` } },
    })));
}
const resolveReply = row => row.metadata.eventSource.sender.id === 'self'
  ? { id: row.metadata.eventSource.sourceRunId, complete: true,
    lastEventId: row.id.replace(/bubble-\d/u, 'bubble-2') } : null;
const measure = selection => 10 + Object.values(selection).flat().length * 10;
const plan = options => planReplyChunk({ resolveReply, measure, ...options });
const ids = rows => rows.map(row => row.id);

test('five own completed runs wait; six runs across spaces process five with read-only following round', async () => {
  assert.equal((await plan({ pending: rounds(1, 5) })).status, 'waiting');
  const result = await plan({ pending: rounds(1, 6) });
  assert.equal(result.status, 'ready');
  assert.deepEqual(ids(result.events), ids(rounds(1, 5)));
  assert.deepEqual(ids(result.continuationGuidanceEvents), ids(rounds(6, 6)));
  assert.deepEqual(result.previousContextEvents, []);
  const next = await plan({ pending: rounds(6, 11), previous: rounds(1, 5) });
  assert.deepEqual(ids(next.events), ids(rounds(6, 10)));
  assert.deepEqual(ids(next.previousContextEvents), ids(rounds(5, 5)));
  assert.deepEqual(ids(next.continuationGuidanceEvents), ids(rounds(11, 11)));
});

test('unfinished sixth reply and multiple bubbles do not prematurely complete a round', async () => {
  const pending = rounds(1, 6);
  assert.equal((await plan({ pending: pending.slice(0, -1) })).status, 'waiting');
  assert.equal((await plan({ pending, resolveReply: row => {
    const reply = resolveReply(row);
    return reply && { ...reply, complete: reply.id !== 'run-6' };
  } })).status, 'waiting');
});

test('token cap processes an early complete prefix and preserves all remaining sources', async () => {
  const pending = rounds(1, 3);
  const result = await plan({ pending, maximumRequestTokens: 100 });
  assert.equal(result.reason, 'token-limit');
  assert.deepEqual(ids(result.events), ids(rounds(1, 2)));
  assert.ok(result.estimatedRequestTokens <= 100);
  assert.deepEqual(pending.slice(result.events.length), rounds(3, 3));
});

test('cap includes overlaps and omits a whole overlap when it cannot fit', async () => {
  const result = await plan({ pending: rounds(6, 11), previous: rounds(1, 5), maximumRequestTokens: 230 });
  assert.equal(result.events.length, 20);
  assert.equal(result.previousContextEvents.length, 0);
  assert.equal(result.continuationGuidanceEvents.length, 0);
  assert.ok(result.estimatedRequestTokens <= 230);
});

test('an indivisible source exceeding the budget remains blocked and is never truncated', async () => {
  const result = await plan({ pending: rounds(1, 1), maximumRequestTokens: 15 });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'input-event-exceeds-token-limit');
  assert.deepEqual(result.inputEventIds, ['1-user']);
});

test('token split within a run counts its final bubble only in the later batch', async () => {
  const pending = rounds(1, 1);
  const result = await plan({ pending, maximumRequestTokens: 30 });
  assert.equal(result.events.length, 2);
  const next = await plan({ pending: [...pending.slice(2), ...rounds(2, 5)] });
  assert.equal(next.status, 'waiting');
  assert.equal(next.completedRounds, 5);
});
