import assert from 'node:assert/strict';
import test from 'node:test';
import { modelCalendarFields } from '../src/index.mjs';

test('model calendar fields retain real dates and suppress synthetic ordering timestamps', () => {
  const fields = ['eventDate', 'eventStart', 'knownAt', 'recordedAt'];
  const record = { event_date: '2025-12-25', event_start: null,
    known_at: '2000-01-02T12:00:00Z', recorded_at: '2000-01-02T12:00:01Z' };
  assert.equal(modelCalendarFields(record, fields).knownAt, record.known_at);
  const unknown = modelCalendarFields({ ...record, metadata: { sourceTimeKnown: false } }, fields);
  assert.deepEqual(unknown, { sourceTimeKnown: false, eventDate: null, eventStart: null, knownAt: null, recordedAt: null });
  const source = { occurred_at: record.known_at, metadata: { eventMetadata: { timelineOrder: 'synthetic-only' } } };
  assert.deepEqual(modelCalendarFields(source, ['occurredAt']), { sourceTimeKnown: false, occurredAt: null });
  const explicitEventDate = modelCalendarFields(record, fields, [source]);
  assert.equal(explicitEventDate.eventDate, '2025-12-25');
  assert.equal(explicitEventDate.knownAt, null);
  assert.equal(explicitEventDate.recordedAt, null);
  assert.equal(record.known_at, '2000-01-02T12:00:00Z');
});
