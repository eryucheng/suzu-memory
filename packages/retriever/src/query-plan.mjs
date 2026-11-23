import { resolveTemporalQuery } from './temporal-query.mjs';
import { recallCorePhrases } from './query.mjs';

/** Keep ordinary recall intact; exact dates also scope a topic-only search. */
export function createRetrievalQueryPlan({ query, now, timeZone }) {
  const retrievalQuery = String(query).trim();
  const temporal = resolveTemporalQuery(retrievalQuery, now, timeZone);
  const calendarQuery = temporal.precision === 'exact' && temporal.coreWindow
    && temporal.remainingQuery !== retrievalQuery && recallCorePhrases(temporal.remainingQuery).length
    ? { text: temporal.remainingQuery, ...temporal.coreWindow } : null;
  return { retrievalQuery, temporal, calendarQuery };
}
