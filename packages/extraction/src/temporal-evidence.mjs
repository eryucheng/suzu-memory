import { dateKeyInTimeZone, resolveCalendarExpression } from '@suzu-memory/core';

export function collectCalendarEvidence(text, anchor, timeZone) {
  const content = String(text || '');
  let grammar = content;
  const claims = [];
  for (;;) {
    const parsed = resolveCalendarExpression(grammar, anchor, timeZone, { forEvidence: true }), span = parsed.span;
    if (!span || span.end <= span.start) break;
    if (parsed.matched && parsed.precision === 'exact' && parsed.startDate && parsed.endDate) {
      const { startDate, endDate, boundary, yearUnspecified, nearbyDateRanges } = parsed;
      claims.push({ expression: content.slice(span.start, span.end), startDate, endDate, boundary, yearUnspecified, nearbyDateRanges, offset: span.start });
    }
    grammar = grammar.slice(0, span.start) + ' '.repeat(span.end - span.start) + grammar.slice(span.end);
  }
  return claims;
}

const clean = value => typeof value === 'string' ? value.trim() : '';

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function zonedInstant(value) {
  const text = clean(value);
  return /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(text)
    && validCalendarDate(text.slice(0, 10)) && Number.isFinite(Date.parse(text)) ? text : null;
}

/** An unusable time field limits date queries, independently of the event itself. */
export function normalizeExtractionTime(value, timeZone) {
  const suppliedDate = clean(typeof value === 'string' ? value : value?.date);
  const date = validCalendarDate(suppliedDate) ? suppliedDate : null;
  const start = zonedInstant(value?.start);
  const end = zonedInstant(value?.end);
  if ((date && start && date !== dateKeyInTimeZone(start, timeZone))
    || (start && end && Date.parse(end) < Date.parse(start))) return null;
  return date || start || end ? { ...(date ? { date } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}) } : null;
}
