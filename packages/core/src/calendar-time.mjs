export const DEFAULT_MEMORY_TIME_ZONE = 'Asia/Shanghai';

const formatters = new Map();

function formatterFor(timeZone) {
  const zone = String(timeZone);
  if (formatters.has(zone)) return formatters.get(zone);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3,
      hourCycle: 'h23', timeZoneName: 'longOffset',
    });
  } catch (error) {
    if (!(error instanceof RangeError) || zone === 'UTC') throw error;
    return formatterFor('UTC');
  }
  formatters.set(zone, formatter);
  return formatter;
}

function calendarParts(value, timeZone) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return Object.fromEntries(formatterFor(timeZone).formatToParts(date)
    .map(part => [part.type, part.value]));
}

export function dateKeyInTimeZone(value, timeZone = DEFAULT_MEMORY_TIME_ZONE) {
  const parts = calendarParts(value, timeZone);
  return parts ? `${parts.year}-${parts.month}-${parts.day}` : '';
}

export function timestampInTimeZone(value, timeZone = DEFAULT_MEMORY_TIME_ZONE) {
  const parts = calendarParts(value, timeZone);
  if (!parts) return '';
  const offset = parts.timeZoneName === 'GMT' ? 'Z' : parts.timeZoneName.replace(/^GMT/u, '');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond}${offset}`;
}
