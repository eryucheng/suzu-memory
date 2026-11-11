import { DEFAULT_MEMORY_TIME_ZONE, dateKeyInTimeZone, resolveCalendarExpression, sourceCalendarTimeKnown } from '@suzu-memory/core';

function calendarClaims(text, anchor, timeZone) {
  let grammar = String(text || '');
  const claims = [];
  for (;;) {
    const parsed = resolveCalendarExpression(grammar, anchor, timeZone), span = parsed.span;
    if (!span || span.end <= span.start) break;
    if (parsed.matched && parsed.precision === 'exact' && parsed.startDate && parsed.endDate) {
      claims.push({ expression: parsed.expression, startDate: parsed.startDate, endDate: parsed.endDate, offset: span.start });
    }
    grammar = grammar.slice(0, span.start) + ' '.repeat(span.end - span.start) + grammar.slice(span.end);
  }
  return claims;
}

/** Compare only explicit, resolvable calendar claims against this candidate's own sources. */
export function createExtractionTimeValidator(messages = [], timeZone = DEFAULT_MEMORY_TIME_ZONE) {
  const byRef = new Map(messages.map(message => [message.memoryRef, message])), parsedSources = new Map();
  const sourceFor = ref => {
    if (!parsedSources.has(ref)) {
      const message = byRef.get(ref), anchor = message?.timestamp;
      const known = sourceCalendarTimeKnown({ ...message, metadata: message?.sourceMetadata || message?.metadata });
      const day = known ? dateKeyInTimeZone(anchor, timeZone) : '';
      const claims = day ? calendarClaims(message.text, anchor, timeZone) : [];
      parsedSources.set(ref, { ref, anchor, day, claims });
    }
    return parsedSources.get(ref);
  };
  return candidate => {
    if (candidate.eventDate && candidate.eventStart
      && candidate.eventDate !== dateKeyInTimeZone(candidate.eventStart, timeZone)) {
      throw Object.assign(new Error('Temporal conflict: the event date and start time identify different days in ' + timeZone + '.'), {
        code: 'MEMORY_EXTRACTION_TIME_CONFLICT',
      });
    }
    const sources = (candidate.sourceRefs || []).map(sourceFor);
    const dated = sources.filter(source => source.claims.length);
    const anchors = [...new Map(sources.filter(source => source.day).map(source => [source.day, source.anchor])).values()];
    if (!anchors.length) return;
    const versions = anchors.map(anchor => calendarClaims([candidate.title || '', candidate.content].join('\n'), anchor, timeZone));
    const overlaps = (claim, source) => claim.startDate <= source.endDate && claim.endDate >= source.startDate;
    // A summary may legitimately mention both when an event happened and when
    // it was reported. Message dates support reporting anchors in the text,
    // but do not override a conflicting event interval in the date fields.
    const supported = dated.flatMap(source => source.claims);
    const reportingDays = new Set(sources.map(source => source.day).filter(Boolean));
    const claims = versions[0] || [];
    for (const claim of dated.length ? claims : []) {
      if (versions.some(values => values.some(value => value.offset === claim.offset
        && (supported.some(source => overlaps(value, source))
          || value.startDate === value.endDate && reportingDays.has(value.startDate))))) continue;
      conflict(claim);
    }
    // Without an explicit time in the summary, a source's other dated event
    // cannot determine which event this candidate describes.
    if (candidate.kind !== 'event' || !claims.length) return;
    for (const field of ['eventDate', 'eventStart', 'eventEnd']) {
      if (!candidate[field]) continue;
      const day = field === 'eventDate' ? candidate[field] : dateKeyInTimeZone(candidate[field], timeZone);
      if (day && !versions.some(values => values.some(claim => overlaps({ startDate: day, endDate: day }, claim)))) {
        conflict({ expression: field + '=' + candidate[field], startDate: day, endDate: day }, 'summary');
      }
    }
    function conflict(claim, basis = 'source') {
      const describe = values => values.map(value => value.expression + ' [' + value.startDate + '..' + value.endDate + ']').join(', ');
      const details = basis === 'summary' ? 'summary time (' + describe(claims) + ')'
        : 'cited source time (' + dated.map(source => source.ref + ': ' + describe(source.claims)).join('; ') + ')';
      throw Object.assign(new Error('Temporal conflict: ' + claim.expression + ' [' + claim.startDate + '..' + claim.endDate
        + '] contradicts the ' + details + '. Preserve the source time and its precision.'), {
        code: 'MEMORY_EXTRACTION_TIME_CONFLICT',
      });
    }
  };
}
