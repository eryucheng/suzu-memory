import { resolveTemporalQuery } from './temporal-query.mjs';

/** The caller owns the search question. Calendar hints never narrow recall. */
export function createRetrievalQueryPlan({ query, now, timeZone }) {
  return { retrievalQuery: String(query).trim(), temporal: resolveTemporalQuery(query, now, timeZone) };
}
