import assert from 'node:assert/strict';
import test from 'node:test';
import { dateKeyInTimeZone, timestampInTimeZone } from '../src/index.mjs';

test('calendar formatting preserves instants with explicit fractional-hour and date-line offsets', () => {
  const value = '2026-12-31T23:30:00.123Z';
  for (const [timeZone, date, formatted] of [
    ['UTC', '2026-12-31', '2026-12-31T23:30:00.123Z'],
    ['Asia/Kathmandu', '2027-01-01', '2027-01-01T05:15:00.123+05:45'],
    ['Pacific/Kiritimati', '2027-01-01', '2027-01-01T13:30:00.123+14:00'],
    ['America/Los_Angeles', '2026-12-31', '2026-12-31T15:30:00.123-08:00'],
  ]) {
    assert.equal(dateKeyInTimeZone(value, timeZone), date);
    assert.equal(timestampInTimeZone(value, timeZone), formatted);
    assert.equal(Date.parse(formatted), Date.parse(value));
  }
  assert.equal(dateKeyInTimeZone(''), '');
  assert.equal(dateKeyInTimeZone('invalid'), '');
  assert.equal(dateKeyInTimeZone(value, 'invalid-zone'), '2026-12-31');
});

test('zero UTC offsets use Z across Intl timezone-name variants', async t => {
  const OriginalDateTimeFormat = Intl.DateTimeFormat;
  for (const timezoneName of ['GMT', 'GMT+00:00', 'GMT-00:00']) {
    await t.test(timezoneName, async t => {
      t.mock.method(Intl, 'DateTimeFormat', function (...args) {
        const formatter = new OriginalDateTimeFormat(...args);
        return {
          formatToParts(value) {
            return formatter.formatToParts(value).map(part => part.type === 'timeZoneName'
              ? { ...part, value: timezoneName } : part);
          },
        };
      });
      const moduleUrl = new URL(`../src/calendar-time.mjs?offset=${encodeURIComponent(timezoneName)}`, import.meta.url);
      const { timestampInTimeZone } = await import(moduleUrl.href);
      const value = '2026-12-31T23:30:00.123Z';
      assert.equal(timestampInTimeZone(value, 'UTC'), value);
    });
  }
});

test('formatting many evidence timestamps reuses one timezone formatter', t => {
  const original = Intl.DateTimeFormat;
  let constructions = 0;
  t.mock.method(Intl, 'DateTimeFormat', function (...args) {
    constructions += 1;
    return new original(...args);
  });
  for (let index = 0; index < 200; index += 1) {
    assert.equal(dateKeyInTimeZone('2026-10-21T23:30:00Z', 'Asia/Tokyo'), '2026-10-22');
  }
  assert.equal(constructions, 1);
});
