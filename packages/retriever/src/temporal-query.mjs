import { DEFAULT_MEMORY_TIME_ZONE, resolveCalendarExpression, CALENDAR_DATE_EXCLUSION as DATE_EXCLUSION } from '@suzu-memory/core';
import { maskQuotedText, maskRejectedRequests, queryConnectorLength } from './query-text.mjs';
export { addCalendarDays } from '@suzu-memory/core';

export function resolveTemporalQuery(query, now = new Date(), timeZone = DEFAULT_MEMORY_TIME_ZONE) {
  const text = String(query || '');
  let grammar = maskQuotedText(maskRejectedRequests(text));
  const scanExclusions = DATE_EXCLUSION.test(grammar);
  const excluded = [];
  let selected = null, last;
  for (;;) {
    const parsed = resolveCalendarExpression(grammar, now, timeZone);
    last = parsed;
    const span = parsed.span;
    if (!span) break;
    if (span.excluded) {
      span.end += queryConnectorLength(text.slice(span.end));
      excluded.push(span);
    } else if (!selected) selected = parsed;
    // Ordinary single-window queries retain the existing one-pass path.
    // Corrections also inspect trailing exclusions after the selected date.
    if (!scanExclusions) break;
    grammar = `${grammar.slice(0, span.start)}${' '.repeat(span.end - span.start)}${grammar.slice(span.end)}`;
  }
  if (!selected) {
    const { span, ...unresolved } = last;
    return { ...unresolved, remainingQuery: text };
  }
  const { span, ...resolved } = selected;
  let remainingQuery = text;
  for (const removed of [span, ...excluded]) {
    remainingQuery = `${remainingQuery.slice(0, removed.start)}${' '.repeat(removed.end - removed.start)}${remainingQuery.slice(removed.end)}`;
  }
  return {
    ...resolved,
    expression: text.slice(span.start, span.end),
    remainingQuery: remainingQuery.replace(/\s+/gu, ' ').trim(),
  };
}
