import {
  lexicalTerms,
  recallCorePhrases,
} from "./query.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function unit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function characterLength(value) {
  return Array.from(clean(value)).length;
}

function trueBm25Rank(value) {
  const rank = Number(value);
  return Number.isFinite(rank) && rank < 0;
}

export function planBm25Queries(query, { maximumQueries = 8 } = {}) {
  const phrases = recallCorePhrases(query);
  const searchableText = phrases.length ? phrases.join(" ") : clean(query);
  const values = [];
  const seen = new Set();
  const add = (value, source) => {
    const text = clean(value);
    if (characterLength(text) < 3 || seen.has(text)) return;
    seen.add(text);
    values.push({ text, source });
  };

  for (const phrase of phrases) add(phrase, "core-phrase");
  for (const term of lexicalTerms(searchableText)
    .filter((value) => characterLength(value) >= 3)
    .sort((left, right) => characterLength(right) - characterLength(left))) {
    add(term, "lexical-term");
  }
  return values.slice(0, Math.max(0, Math.trunc(Number(maximumQueries) || 0)));
}

export function collectBm25SeedScores({
  repository,
  agentId,
  query,
  maximumQueries = 8,
  maximumResultsPerQuery = 20,
  worldId = "",
  worldFrame = "",
}) {
  const queries = planBm25Queries(query, { maximumQueries });
  if (!queries.length) {
    return {
      status: "not-run",
      scores: new Map(),
      audit: {
        status: "not-run",
        reason: "no-fts-compatible-query",
        queries: [],
        queryCount: 0,
        matchedMemoryCount: 0,
        ignoredLikeFallbackCount: 0,
        matches: [],
      },
    };
  }

  const byMemory = new Map();
  let ignoredLikeFallbackCount = 0;
  for (const planned of queries) {
    const matches = repository.search(agentId, planned.text, {
      includeArchived: true,
      limit: maximumResultsPerQuery,
      worldId,
      worldFrame,
    });
    const ranked = matches.filter((memory) => trueBm25Rank(memory.search_rank));
    ignoredLikeFallbackCount += matches.length - ranked.length;
    const resultCount = ranked.length;
    for (let index = 0; index < ranked.length; index += 1) {
      const memory = ranked[index];
      const rank = index + 1;
      const selectivity = 1 / Math.sqrt(Math.max(1, resultCount));
      const rankEvidence = (1 / rank) * selectivity;
      const current = byMemory.get(memory.id) || {
        memoryId: memory.id,
        hits: [],
        matchedQueries: new Set(),
        bestRankEvidence: 0,
      };
      current.hits.push({
        query: planned.text,
        source: planned.source,
        rank,
        resultCount,
        searchRank: Number(memory.search_rank),
      });
      current.matchedQueries.add(planned.text);
      current.bestRankEvidence = Math.max(current.bestRankEvidence, rankEvidence);
      byMemory.set(memory.id, current);
    }
  }

  const scores = new Map();
  for (const match of byMemory.values()) {
    const coverage = match.matchedQueries.size / Math.max(1, queries.length);
    const normalizedScore = unit(match.bestRankEvidence * 0.7 + coverage * 0.3);
    scores.set(match.memoryId, {
      normalizedScore,
      coverage,
      matchedQueryCount: match.matchedQueries.size,
      queryCount: queries.length,
      bestRank: Math.min(...match.hits.map((hit) => hit.rank)),
      bestSearchRank: Math.min(...match.hits.map((hit) => hit.searchRank)),
      matchedQueries: [...match.matchedQueries],
      hits: match.hits,
    });
  }

  const auditMatches = [...scores.entries()]
    .map(([memoryId, score]) => ({ memoryId, ...score }))
    .sort((left, right) => right.normalizedScore - left.normalizedScore)
    .slice(0, 20);
  return {
    status: "ready",
    scores,
    audit: {
      status: "ready",
      queries,
      queryCount: queries.length,
      matchedMemoryCount: scores.size,
      ignoredLikeFallbackCount,
      matches: auditMatches,
    },
  };
}
