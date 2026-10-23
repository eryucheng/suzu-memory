import { lexicalScore, prepareLexicalQuery, recallCorePhrases } from "./query.mjs";
import { memoryCalendarDate } from './temporal-ranking.mjs';

function clean(value) {
  return String(value ?? "").trim();
}

function unit(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function memoryAllowed(node, intent) {
  if (intent === "utterance") return node.kind === "utterance";
  if (intent === "event") return node.kind !== "reflection";
  return true;
}

function actorEquals(actor, target) {
  return actor?.actor_role === target.role && actor?.actor_key === target.key;
}

function primaryEquals(node, target) {
  return node.subject_role === target.role && node.subject_key === target.key;
}

function stateNode(node) {
  return !["", "not_applicable", "unspecified"].includes(clean(node.state_family));
}

export function buildSubjectConstraint({
  subjectQuery,
  nodes,
  actorRolesByMemory = new Map(),
}) {
  const routeByMemory = new Map();
  const hardExcludedMemoryIds = new Set();
  if (!subjectQuery?.matched) {
    return { subjectQuery, routeByMemory, hardExcludedMemoryIds };
  }
  for (const node of nodes) {
    const roles = actorRolesByMemory.get(node.id) || [];
    let matched = false;
    let strength = "";
    if (subjectQuery.mode === "shared") {
      const memberMatches = (subjectQuery.members || []).map((member) => (
        primaryEquals(node, member) || roles.some((actor) => actorEquals(actor, member))
      ));
      matched = node.subject_role === "shared" || (
        memberMatches.length >= 2 && memberMatches.every(Boolean)
      );
      strength = node.subject_role === "shared" ? "exact-holder" : "shared-participants";
    } else {
      const target = { role: subjectQuery.role, key: subjectQuery.key };
      if (stateNode(node)) {
        matched = primaryEquals(node, target);
        strength = "exact-holder";
      } else if (node.kind === "utterance") {
        matched = primaryEquals(node, target) || roles.some((actor) => (
          actor.role === "speaker" && actorEquals(actor, target)
        ));
        strength = "exact-speaker";
      } else if (subjectQuery.focus === "state") {
        matched = primaryEquals(node, target);
        strength = "primary-subject";
      } else {
        matched = primaryEquals(node, target) || roles.some((actor) => actorEquals(actor, target));
        strength = primaryEquals(node, target) ? "primary-subject" : "structured-participant";
      }
      const declaredOwnerRole = clean(node.subject_role);
      const hasKnownOwner = Boolean(
        declaredOwnerRole
        && declaredOwnerRole !== "unknown"
        && (declaredOwnerRole === "world" || clean(node.subject_key)),
      );
      const exclusiveOwnedFact = node.kind === "fact" && hasKnownOwner;
      if (!matched && (
        stateNode(node)
        || node.kind === "utterance"
        || subjectQuery.focus === "state"
        || exclusiveOwnedFact
      )) {
        if (subjectQuery.focus === "state" || hasKnownOwner) {
          hardExcludedMemoryIds.add(node.id);
        }
      }
    }
    if (!matched) continue;
    routeByMemory.set(node.id, {
      route: "subject",
      strength,
      independentlyAdmissible: false,
      rawScore: 1,
      normalizedScore: 1,
      contribution: 0,
    });
  }
  return { subjectQuery, routeByMemory, hardExcludedMemoryIds };
}

export function applySubjectConstraint(candidates, constraint) {
  const rejectedMemoryIds = [];
  const values = [];
  for (const candidate of candidates) {
    if (constraint.hardExcludedMemoryIds.has(candidate.node.id)) {
      rejectedMemoryIds.push(candidate.node.id);
      continue;
    }
    const subjectRoute = constraint.routeByMemory.get(candidate.node.id);
    if (!subjectRoute) {
      values.push(candidate);
      continue;
    }
    values.push({
      ...candidate,
      routeMatches: [...(candidate.routeMatches || []), subjectRoute],
      routeContributions: {
        ...(candidate.routeContributions || {}),
        subject: 0,
      },
    });
  }
  return { candidates: values, rejectedMemoryIds };
}

export function lexicalRoute(lexical, options) {
  const magnitude = Math.min(
    1,
    lexical.score / Math.max(1, Number(options.strongLexicalScore) * 3),
  );
  const coverage = lexical.overlap / Math.max(1, lexical.queryTerms.length);
  const contribution = magnitude * 0.35
    + Math.min(1, coverage) * 0.2
    + (lexical.exactPhrase ? 0.25 : 0);
  const independentlyAdmissible = lexical.exactPhrase || (
    lexical.score >= Number(options.strongLexicalScore)
    && lexical.overlap >= 2
  );
  if (!lexical.overlap && !lexical.exactPhrase) return null;
  return {
    route: "lexical",
    strength: lexical.exactPhrase
      ? "exact"
      : independentlyAdmissible ? "strong" : "supporting",
    independentlyAdmissible,
    rawScore: lexical.score,
    normalizedScore: unit(contribution / 0.8),
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

function isCurrentStructuredState(node) {
  return stateNode(node)
    && clean(node.temporal_state) === "current"
    && clean(node.status) === "active"
    && clean(node.subject_role)
    && clean(node.subject_key)
    && clean(node.canonical_key)
    && !["", "unspecified"].includes(clean(node.representation_layer));
}

function priorContribution(node, intent, query, asksForHistoricalState, querySubject) {
  let contribution = Math.min(0.05, Math.max(0, Number(node.importance)) * 0.05);
  if (intent === "event" && node.kind !== "utterance") contribution += 0.08;
  if (intent === "event" && node.kind === "event" && node.event_date) contribution += 0.08;
  if (intent === "utterance" && node.kind === "utterance") contribution += 0.08;
  if (intent === "evidence" && node.kind !== "utterance") contribution += 0.08;
  if (
    intent === "auto"
    && querySubject?.matched
    && querySubject.mode === "personal"
    && isCurrentStructuredState(node)
  ) contribution += 0.1;
  if (node.status === "active") contribution += 0.08;
  else if (!asksForHistoricalState(query)) contribution -= 0.12;
  return contribution;
}

export function buildOrdinarySeedCandidates({
  nodes,
  query,
  intent,
  bm25Scores = new Map(),
  vectorScores = new Map(),
  entityScores = new Map(),
  options,
  includeWeakLexical = false,
  asksForHistoricalState = () => false,
  querySubject = null,
  accessibilityAdjustments = new Map(),
  recallReactivationAdjustments = new Map(),
  naturalDecayAdjustments = new Map(),
  naturalDecayBypassMemoryIds = new Set(),
  naturalDecaySpecificityByMemory = new Map(),
  affectiveAdjustments = new Map(),
  preparedQuery = prepareLexicalQuery(query),
}) {
  const values = [];
  for (const node of nodes) {
    if (!memoryAllowed(node, intent)) continue;
    const lexical = lexicalScore(
      preparedQuery,
      [node.event_date || "", node.title || "", node.content].filter(Boolean).join("\n"),
    );
    const bm25 = bm25Scores.get(node.id) || null;
    const similarity = vectorScores.get(node.id) ?? Number.NEGATIVE_INFINITY;
    const entityScore = entityScores.get(node.id) || 0;
    let routeMatches = [
      lexicalRoute(lexical, options),
      bm25Route(bm25, options),
      vectorRoute(similarity, options),
      entityRoute(entityScore),
    ].filter(Boolean);
    const independentRoutes = routeMatches.filter((route) => route.independentlyAdmissible);
    // BM25 and the custom n-gram route are two views over the same text. Keep
    // both in the audit, but never add both textual contributions. A strong
    // BM25 hit is itself enough to admit a memory; only suppress its score
    // when a different independent route has already admitted that memory.
    const hasNonBm25IndependentRoute = independentRoutes.some((route) => route.route !== "bm25");
    if (hasNonBm25IndependentRoute) {
      routeMatches = routeMatches.map((route) => (
        route.route === "bm25" ? { ...route, contribution: 0 } : route
      ));
    } else {
      const lexicalIndex = routeMatches.findIndex((route) => route.route === "lexical");
      const bm25Index = routeMatches.findIndex((route) => route.route === "bm25");
      const bm25IsIndependent = bm25Index >= 0
        && Boolean(routeMatches[bm25Index].independentlyAdmissible);
      if (bm25IsIndependent && lexicalIndex >= 0) {
        routeMatches = routeMatches.map((route, index) => (
          index === lexicalIndex ? { ...route, contribution: 0 } : route
        ));
      } else if (lexicalIndex >= 0 && bm25Index >= 0) {
        const lexicalContribution = Number(routeMatches[lexicalIndex].contribution || 0);
        const bm25Contribution = Number(routeMatches[bm25Index].contribution || 0);
        const suppressedIndex = bm25Contribution > lexicalContribution
          ? lexicalIndex
          : bm25Index;
        routeMatches = routeMatches.map((route, index) => (
          index === suppressedIndex ? { ...route, contribution: 0 } : route
        ));
      }
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
    const prior = priorContribution(
      node,
      intent,
      query,
      asksForHistoricalState,
      querySubject,
    );
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

export function buildEpisodicEvidenceSeedCandidates({
  nodes,
  query,
  temporal = null,
  options = {},
  ...routes
}) {
  const inTemporalRange = (node) => {
    if (!temporal?.matched || temporal.precision !== 'exact' || recallCorePhrases(temporal.remainingQuery).length) return true;
    const eventDate = memoryCalendarDate(node, options.timeZone);
    return Boolean(
      eventDate
      && eventDate >= clean(temporal.startDate)
      && eventDate <= clean(temporal.endDate)
    );
  };
  return buildOrdinarySeedCandidates({
    ...routes,
    options,
    nodes: (Array.isArray(nodes) ? nodes : []).filter((node) => (
      node.kind === "utterance" && inTemporalRange(node)
    )),
    query,
    intent: "utterance",
  }).map((candidate) => ({
    ...candidate,
    retrievalLane: "episodic-evidence",
  }));
}

export function seedRoutingAudit({
  plannedRoutes = [],
  executedRoutes = [],
  candidates = [],
  convergenceCandidates = [],
  primaryMemoryId = "",
  routeStatus = {},
  subjectRouting = {},
  stateRouting = {},
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
    subjectRouting: subjectRouting && typeof subjectRouting === "object"
      ? { ...subjectRouting }
      : {},
    stateRouting: stateRouting && typeof stateRouting === "object"
      ? { ...stateRouting }
      : {},
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
