import {
  boundedOccurrences,
  lexicalScore,
  prepareLexicalQuery,
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

function preparedBm25Queries(query, prepared, { maximumQueries = 8 } = {}) {
  const phrases = recallCorePhrases(query);
  const values = [];
  const seen = new Set();
  const add = (value, source) => {
    const text = clean(value);
    if (characterLength(text) < 3 || seen.has(text)) return;
    seen.add(text);
    values.push({ text, source });
  };

  for (const phrase of phrases) add(phrase, "core-phrase");
  for (const term of (prepared.topicTerms || prepared.queryTerms)
    .filter((value) => characterLength(value) >= 3)
    .sort((left, right) => characterLength(right) - characterLength(left))) {
    add(term, "lexical-term");
  }
  return values.slice(0, Math.max(0, Math.trunc(Number(maximumQueries) || 0)));
}

export function planBm25Queries(query, options = {}) {
  return preparedBm25Queries(query, prepareLexicalQuery(query), options);
}

export function collectBm25SeedScores({
  repository,
  agentId,
  query,
  maximumQueries = 8,
  maximumResultsPerQuery = 20,
  preparedQuery = null,
  worldId = "",
  worldFrame = "",
}) {
  const prepared = preparedQuery || prepareLexicalQuery(query);
  const queries = preparedBm25Queries(query, prepared, { maximumQueries });
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

  const topicTerms = new Set(prepared.topicTerms || prepared.queryTerms);
  const queryEnglishTerms = Object.keys(prepared.englishForms).filter(term => topicTerms.has(term));
  const plannedMatches = queries.map(planned => ({ planned, matches: repository.search(agentId, planned.text, {
    includeArchived: true, limit: maximumResultsPerQuery, worldId, worldFrame,
  }), englishTerms: queryEnglishTerms.filter(term => boundedOccurrences(
    planned.text.normalize('NFKC').toLowerCase(), term).length) }));
  // The shared trigram index also finds fragments inside English words. Check
  // those hits against the same word matcher used by the lexical route. Read
  // only the bounded FTS hits, including their approved retrieval context.
  const englishMemoryIds = [...new Set(plannedMatches.filter(item => item.englishTerms.length)
    .flatMap(item => item.matches.filter(memory => trueBm25Rank(memory.search_rank)).map(memory => memory.id)))];
  const documents = new Map(englishMemoryIds.length && repository.database
    ? repository.database.prepare(`SELECT memory_id,title,content FROM memory_fts
        WHERE rowid IN (SELECT fts_rowid FROM memory_fts_rows INDEXED BY memory_fts_rows_memory
          WHERE memory_id IN (SELECT value FROM json_each(?)) AND agent_id=?)`)
      .all(JSON.stringify(englishMemoryIds), agentId).map(row => [row.memory_id, `${row.title}\n${row.content}`]) : []);
  const byMemory = new Map();
  const lexicalMatches = new Map();
  let ignoredLikeFallbackCount = 0;
  let rejectedWordBoundaryCount = 0;
  for (const { planned, matches, englishTerms } of plannedMatches) {
    const ftsRanked = matches.filter(memory => trueBm25Rank(memory.search_rank));
    ignoredLikeFallbackCount += matches.length - ftsRanked.length;
    const ranked = ftsRanked.filter(memory => {
      if (!englishTerms.length) return true;
      if (!lexicalMatches.has(memory.id)) lexicalMatches.set(memory.id, new Set(lexicalScore(prepared,
        documents.get(memory.id) ?? `${memory.title || ''}\n${memory.content || ''}`).matchedTerms));
      return englishTerms.every(term => lexicalMatches.get(memory.id).has(term));
    });
    rejectedWordBoundaryCount += ftsRanked.length - ranked.length;
    const resultCount = ranked.length;
    let rank = 0;
    for (let index = 0; index < ranked.length; index += 1) {
      const memory = ranked[index];
      if (index === 0 || Number(memory.search_rank) !== Number(ranked[index - 1].search_rank)) rank = index + 1;
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
      rejectedWordBoundaryCount,
      matches: auditMatches,
    },
  };
}
