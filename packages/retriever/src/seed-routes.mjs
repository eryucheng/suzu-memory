import { lexicalCoverage, lexicalScore, prepareLexicalQuery, recallCorePhrases } from "./query.mjs";
import { utteranceStatements } from './query-text.mjs';

function clean(value) {
  return String(value ?? "").trim();
}

function unit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

export function lexicalRoute(lexical, options, indexedMatches = false) {
  // Indexed matches own text ranking. Keep a bounded coverage fallback for
  // unsupported short terms, or for a query with no usable index matches.
  const fallbackOverlap = indexedMatches
    ? (lexical.matchedTerms || []).filter(term => Array.from(term).length < 3).length
    : lexical.overlap;
  const coverage = unit(fallbackOverlap / Math.max(1, lexical.queryTerms.length));
  const normalizedScore = indexedMatches ? coverage : lexicalCoverage(lexical);
  const contribution = normalizedScore * unit(options.bm25ContributionWeight);
  const independentlyAdmissible = lexical.exactPhrase || (
    (lexical.admissionScore ?? lexical.score) >= Number(options.strongLexicalScore)
    && (lexical.admissionOverlap ?? lexical.overlap) >= 2
  );
  if (!lexical.overlap && !lexical.exactPhrase) return null;
  return {
    route: "lexical",
    strength: lexical.exactPhrase
      ? "exact"
      : independentlyAdmissible ? "strong" : "supporting",
    independentlyAdmissible,
    rawScore: lexical.score,
    normalizedScore,
    contribution,
    overlap: lexical.overlap,
    exactPhrase: lexical.exactPhrase,
    matchedTerms: lexical.matchedTerms || [],
  };
}

function vectorRoute(similarity, options) {
  if (!Number.isFinite(similarity) || similarity < Number(options.minimumVectorSimilarity)) {
    return null;
  }
  const contribution = unit((similarity - 0.25) / 0.55) * 0.4;
  const independentlyAdmissible = similarity >= Number(options.strongVectorSimilarity);
  return {
    route: "vector",
    strength: independentlyAdmissible ? "strong" : "supporting",
    independentlyAdmissible,
    rawScore: similarity,
    normalizedScore: unit(contribution / 0.4),
    contribution,
  };
}

function bm25Route(match, options) {
  if (!match || !(Number(match.normalizedScore) > 0)) return null;
  const normalizedScore = unit(match.normalizedScore);
  const contribution = normalizedScore * unit(options.bm25ContributionWeight);
  const independentlyAdmissible = normalizedScore >= Number(options.strongBm25Score);
  return {
    route: "bm25",
    strength: independentlyAdmissible ? "strong" : "supporting",
    independentlyAdmissible,
    rawScore: Number(match.bestSearchRank),
    normalizedScore,
    contribution,
    coverage: Number(match.coverage),
    matchedQueryCount: Number(match.matchedQueryCount),
    queryCount: Number(match.queryCount),
    bestRank: Number(match.bestRank),
    matchedQueries: [...(match.matchedQueries || [])],
  };
}

function entityRoute(score) {
  if (!(Number(score) > 0)) return null;
  const contribution = unit(score) * 0.35;
  return {
    route: "entity",
    strength: "exact",
    independentlyAdmissible: true,
    rawScore: Number(score),
    normalizedScore: unit(score),
    contribution,
  };
}

function priorContribution(node) {
  return Math.min(0.05, Math.max(0, Number(node.importance)) * 0.05) + (node.status === 'active' ? 0.08 : 0);
}

// Share base lexical scores only within one query and node snapshot. Route
// admission, priors and adjustments are still calculated by each caller.
export function createSeedLexicalScorer(preparedQuery, { includeQuestions = false } = {}) {
  const scores = new WeakMap();
  const prepare = node => {
    let entry = scores.get(node);
    if (!entry) {
      const content = node.content;
      const statements = node.kind === 'utterance' ? utteranceStatements(content) : null;
      const lexical = lexicalScore(
        preparedQuery,
        [node.event_date || "", node.title || "", statements && !includeQuestions ? statements.text : content]
          .filter(Boolean).join("\n"),
      );
      entry = { lexical, statements };
      scores.set(node, entry);
    }
    return entry;
  };
  return Object.assign(node => prepare(node).lexical, {
    dialogue(node) {
      const entry = prepare(node);
      if (!entry.statements?.hasQuestion) return { hasQuestion: false };
      entry.statementLexical ??= includeQuestions ? lexicalScore(preparedQuery,
        [node.event_date || '', node.title || '', entry.statements.text].filter(Boolean).join('\n')) : entry.lexical;
      entry.questionLexical ??= lexicalScore(preparedQuery, entry.statements.questions);
      return { ...entry.statements, statementRelevance: lexicalCoverage(entry.statementLexical),
        questionRelevance: lexicalCoverage(entry.questionLexical) };
    },
  });
}

export function buildOrdinarySeedCandidates({
  nodes,
  query,
  bm25Scores = new Map(),
  vectorScores = new Map(),
  entityScores = new Map(),
  subjectOnlyEntityMemoryIds = new Set(),
  options,
  includeWeakLexical = false,
  accessibilityAdjustments = new Map(),
  recallReactivationAdjustments = new Map(),
  naturalDecayAdjustments = new Map(),
  naturalDecayBypassMemoryIds = new Set(),
  naturalDecaySpecificityByMemory = new Map(),
  affectiveAdjustments = new Map(),
  preparedQuery = prepareLexicalQuery(query),
  scoreLexical = createSeedLexicalScorer(preparedQuery, { includeQuestions: true }),
}) {
  const values = [];
  for (const node of nodes) {
    const lexical = scoreLexical(node);
    const bm25 = bm25Scores.get(node.id) || null;
    const similarity = vectorScores.get(node.id) ?? Number.NEGATIVE_INFINITY;
    const entityScore = entityScores.get(node.id) || 0;
    let routeMatches = [
      lexicalRoute(lexical, options, bm25Scores.size > 0),
      bm25Route(bm25, options),
      vectorRoute(similarity, options),
      entityRoute(entityScore),
    ].filter(Boolean);
    // A person's name identifies the search subject. It may admit a record,
    // but cannot replace a match to what is being asked about that person.
    if (preparedQuery.topicTerms?.length && subjectOnlyEntityMemoryIds.has(node.id)) {
      routeMatches = routeMatches.map(route => route.route === 'entity'
        ? { ...route, contribution: 0 } : route);
    }
    const independentRoutes = routeMatches.filter((route) => route.independentlyAdmissible);
    // One text score: prefer BM25 where available. A per-memory index miss
    // must not receive a larger fallback than the indexed matches it lost to.
    if (routeMatches.some(route => route.route === "bm25")) {
      routeMatches = routeMatches.map(route => route.route === "lexical"
        ? { ...route, contribution: 0 } : route);
    }
    const lexicalMatch = routeMatches.find((route) => route.route === "lexical");
    const bm25Match = routeMatches.find((route) => route.route === "bm25");
    const vectorMatch = routeMatches.find((route) => route.route === "vector");
    const lexicalVectorCorroborated = Boolean(
      lexicalMatch
      && vectorMatch
      && lexical.score >= Number(options.minimumLexicalScore)
      && lexical.overlap > 0
      && similarity >= Number(options.minimumVectorSimilarity),
    );
    const bm25Corroborated = Boolean(
      bm25Match
      && bm25Match.normalizedScore >= Number(options.minimumBm25CorroborationScore)
      && vectorMatch
      && similarity >= Number(options.minimumVectorSimilarity)
    );
    const corroborated = lexicalVectorCorroborated || bm25Corroborated;
    const convergenceOnly = !independentRoutes.length
      && !corroborated
      && includeWeakLexical
      && lexical.overlap > 0;
    if (!independentRoutes.length && !corroborated && !convergenceOnly) continue;
    const prior = priorContribution(node);
    const baseScore = routeMatches.reduce((sum, route) => sum + route.contribution, 0) + prior;
    const accessibility = accessibilityAdjustments.get(node.id) || null;
    const accessibilityAdjustment = Number(accessibility?.scoreAdjustment || 0);
    const storedNaturalDecay = naturalDecayAdjustments.get(node.id) || null;
    const naturalDecay = storedNaturalDecay && naturalDecayBypassMemoryIds.has(node.id)
      ? Object.freeze({
          ...storedNaturalDecay,
          bypassed: true,
          bypassReason: "high-specificity-match",
          specificity: naturalDecaySpecificityByMemory.get(node.id),
          scoreAdjustment: 0,
        })
      : storedNaturalDecay;
    const naturalDecayAdjustment = Number(naturalDecay?.scoreAdjustment || 0);
    const recallReactivation = recallReactivationAdjustments.get(node.id) || null;
    const recallReactivationAdjustment = Number(recallReactivation?.scoreAdjustment || 0);
    const affectiveBias = affectiveAdjustments.get(node.id) || null;
    const affectiveAdjustment = Number(affectiveBias?.scoreAdjustment || 0);
    const score = Math.max(
      0,
      baseScore
        + accessibilityAdjustment
        + recallReactivationAdjustment
        + naturalDecayAdjustment
        + affectiveAdjustment,
    );
    values.push({
      node,
      lexical,
      bm25,
      similarity,
      entityScore,
      score,
      baseScore,
      accessibility,
      recallReactivation,
      naturalDecay,
      affectiveBias,
      admission: independentRoutes.length
        ? "independent"
        : corroborated ? "corroborated" : "convergence-only",
      routeMatches,
      routeContributions: Object.fromEntries([
        ...routeMatches.map((route) => [route.route, route.contribution]),
        ["prior", prior],
        ["accessibility", accessibilityAdjustment],
        ["recall-reactivation", recallReactivationAdjustment],
        ["natural-decay", naturalDecayAdjustment],
        ["affective", affectiveAdjustment],
      ]),
    });
  }
  return values.sort((left, right) => (
    right.score - left.score
    || right.node.importance - left.node.importance
    || Date.parse(right.node.recorded_at || "") - Date.parse(left.node.recorded_at || "")
  ));
}

export function seedRoutingAudit({
  plannedRoutes = [],
  executedRoutes = [],
  candidates = [],
  convergenceCandidates = [],
  primaryMemoryId = "",
  routeStatus = {},
  bm25Routing = {},
}) {
  const directIds = new Set(candidates.map((candidate) => candidate.node.id));
  const convergenceOnly = convergenceCandidates.filter(
    (candidate) => !directIds.has(candidate.node.id),
  );
  const auditedConvergence = convergenceOnly.slice(0, 10);
  const all = new Map();
  for (const candidate of [...candidates, ...auditedConvergence]) {
    if (all.has(candidate.node.id)) continue;
    all.set(candidate.node.id, {
      memoryId: candidate.node.id,
      matchedMemoryId: clean(candidate.matchedMemoryId) || candidate.node.id,
      admission: directIds.has(candidate.node.id)
        ? candidate.admission || "independent"
        : "convergence-only",
      fusedScore: Number(candidate.score),
      routes: (candidate.routeMatches || []).map((route) => ({
        route: route.route,
        strength: route.strength,
        independentlyAdmissible: Boolean(route.independentlyAdmissible),
        rawScore: Number.isFinite(route.rawScore) ? Number(route.rawScore) : null,
        normalizedScore: Number(route.normalizedScore),
        ...(route.route === "bm25" ? {
          coverage: Number(route.coverage),
          matchedQueryCount: Number(route.matchedQueryCount),
          queryCount: Number(route.queryCount),
          bestRank: Number(route.bestRank),
          matchedQueries: [...(route.matchedQueries || [])],
        } : {}),
      })),
      accessibility: candidate.accessibility ? {
        value: Number(candidate.accessibility.value),
        policyVersion: candidate.accessibility.policyVersion,
        configurationVersion: candidate.accessibility.configurationVersion,
        scoreAdjustment: Number(candidate.accessibility.scoreAdjustment),
      } : null,
      recallReactivation: candidate.recallReactivation ? {
        value: Number(candidate.recallReactivation.value),
        retention: Number(candidate.recallReactivation.retention),
        activationCount: Number(candidate.recallReactivation.activationCount),
        policyVersion: candidate.recallReactivation.policyVersion,
        configurationVersion: candidate.recallReactivation.configurationVersion,
        model: candidate.recallReactivation.model,
        scaleDays: Number(candidate.recallReactivation.scaleDays),
        decayExponent: Number(candidate.recallReactivation.decayExponent),
        equivalentHalfLifeDays: Number(candidate.recallReactivation.equivalentHalfLifeDays),
        maximumActivation: Number(candidate.recallReactivation.maximumActivation),
        scoreAdjustment: Number(candidate.recallReactivation.scoreAdjustment),
      } : null,
      naturalDecay: candidate.naturalDecay ? {
        value: Number(candidate.naturalDecay.value),
        retention: Number(candidate.naturalDecay.retention),
        ageDays: Number(candidate.naturalDecay.ageDays),
        referenceTime: candidate.naturalDecay.referenceTime,
        timeBasis: candidate.naturalDecay.timeBasis,
        model: candidate.naturalDecay.model,
        scaleDays: Number(candidate.naturalDecay.scaleDays),
        decayExponent: Number(candidate.naturalDecay.decayExponent),
        equivalentHalfLifeDays: Number(candidate.naturalDecay.equivalentHalfLifeDays),
        configurationVersion: candidate.naturalDecay.configurationVersion,
        scoreAdjustment: Number(candidate.naturalDecay.scoreAdjustment),
        bypassed: Boolean(candidate.naturalDecay.bypassed),
        bypassReason: clean(candidate.naturalDecay.bypassReason),
        specificity: candidate.naturalDecay.specificity || null,
      } : null,
      affectiveBias: candidate.affectiveBias ? {
        scoreAdjustment: Number(candidate.affectiveBias.scoreAdjustment),
        configurationVersion: candidate.affectiveBias.configurationVersion,
        activationMemoryIds: [...candidate.affectiveBias.activationMemoryIds],
        decisionIds: [...candidate.affectiveBias.decisionIds],
        entityIds: [...candidate.affectiveBias.entityIds],
      } : null,
    });
  }
  return {
    plannedRoutes: [...plannedRoutes],
    executedRoutes: [...executedRoutes],
    routeStatus: { ...routeStatus },
    bm25Routing: bm25Routing && typeof bm25Routing === "object"
      ? { ...bm25Routing }
      : {},
    directCandidateCount: candidates.length,
    convergenceCandidateCount: convergenceOnly.length,
    omittedConvergenceCandidateCount: Math.max(0, convergenceOnly.length - auditedConvergence.length),
    primaryMemoryId: clean(primaryMemoryId),
    candidates: [...all.values()],
  };
}
