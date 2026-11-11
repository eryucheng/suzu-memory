import { createRetrievalQueryPlan } from './query-plan.mjs';
import { selectRetrievalContext } from './context-selection.mjs';
import { fuseCandidateLanes } from './candidate-selection.mjs';
export { fuseCandidateLanes } from './candidate-selection.mjs';
import { formatPrimary, closedStateLabel, renderRecallOutput } from './context-renderer.mjs';
import { createStateReadView, isProvisionalMemory as isProvisionalNode } from '@suzu-memory/core';
import { appendUsageEvent } from "@suzu-memory/usage-ledger";
import { createEventSourceView, DEFAULT_MEMORY_TIME_ZONE, withEventSourceExecution, MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";

import { boundedOccurrences, lexicalScore, planVectorQuery, prepareLexicalQuery, recallCorePhrases } from "./query.mjs";
import { buildOrdinarySeedCandidates, createSeedLexicalScorer, lexicalRoute, seedRoutingAudit } from "./seed-routes.mjs";
import { collectBm25SeedScores } from "./bm25-route.mjs";
import { memoryCalendarDate, rankTemporalCandidates, temporalOverviewCandidates } from './temporal-ranking.mjs';
import { prefilterCandidateIds } from './candidate-prefilter.mjs';
import { createNodeReader } from './node-reader.mjs';
import { appliedPlasticityAudit, memoryAccessibilityAdjustment, normalizeAppliedPlasticityOptions } from "./plasticity-ranking.mjs";
import { affectiveBiasAudit, buildAffectiveCandidateAdjustments, normalizeAffectiveBiasOptions } from "./affective-ranking.mjs";
import { buildNaturalDecayAdjustments, naturalDecayAudit, normalizeNaturalDecayOptions } from "./natural-decay.mjs";
import { buildRecallReactivationAdjustments, normalizeRecallReactivationOptions, recallReactivationAudit } from "./recall-reactivation.mjs";

export const DEFAULT_RETRIEVAL_OPTIONS = Object.freeze({
  timeZone: DEFAULT_MEMORY_TIME_ZONE,
  temporalWeight: 0.35,
  maximumCandidates: 20,
  maximumReturnedCandidates: 5,
  includeCandidateContext: false,
  maximumContextChars: 24_000,
  maximumContextMemories: 5,
  maximumChainDepth: 3,
  minimumChainPathScore: 0.3,
  minimumActivationContribution: 0.12,
  maximumActivationWork: 100,
  maximumConvergenceCandidates: 50,
  fanoutSuppressionExponent: 0.5,
  minimumVectorSimilarity: 0.42,
  strongVectorSimilarity: 0.5,
  minimumLexicalScore: 4,
  strongLexicalScore: 4,
  maximumBm25Queries: 8,
  maximumBm25ResultsPerQuery: 20,
  minimumBm25CorroborationScore: 0.55,
  strongBm25Score: 0.65,
  bm25ContributionWeight: 0.18,
  provisionalScoreMultiplier: 0.9,
  recallReactivation: Object.freeze({ enabled: false }),
  naturalDecay: Object.freeze({ enabled: false }),
  heading: "",
  guidance: "",
});

function clean(value) {
  return String(value ?? "").trim();
}

function normalizeWorldScope(world = {}, allowCrossWorld = false) {
  const value = world && typeof world === "object" && !Array.isArray(world) ? world : {};
  const id = clean(value.id || value.worldId);
  const frame = clean(value.frame || value.worldFrame);
  return {
    id,
    frame,
    reality: clean(value.reality) || ((id || frame) && ['', 'physical', 'relational', 'unknown'].includes(frame) ? 'real' : ''),
    allowCrossWorld: Boolean(allowCrossWorld || value.allowCrossWorld),
  };
}

function nodeMatchesWorldScope(node, scope) {
  if (scope?.allowCrossWorld) return true;
  if (scope?.reality && clean(node?.reality) !== scope.reality) return false;
  if (scope?.id && clean(node?.world_id) !== scope.id) return false;
  if (scope?.frame && clean(node?.world_frame) !== scope.frame) return false;
  return true;
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function retrievalTracePayload({
  agentId,
  query,
  resultStatus,
  retrievalMode = "",
  seedIds = [],
  selectedIds = [],
  paths = [],
  matchedEntities = [],
  context = "",
  candidateCount = 0,
  vectorStatus = "",
  metadata = {},
}) {
  return {
    agentId,
    queryText: query,
    resultStatus,
    retrievalMode,
    seedIds,
    selectedIds,
    paths,
    matchedEntityIds: matchedEntities.map((entity) => entity.entityId),
    contextChars: context.length,
    candidateCount,
    vectorStatus,
    metadata,
  };
}

function dot(left, right) {
  if (left.length !== right.length) return Number.NEGATIVE_INFINITY;
  let value = 0;
  for (let index = 0; index < left.length; index += 1) value += left[index] * right[index];
  return value;
}

function loadPendingProvisionalNodes(repository, agentId) {
  if (typeof repository.listPendingProvisionalMemories !== "function") return [];
  return repository.listPendingProvisionalMemories(agentId, { limit: 5_000 })
    .map((node) => ({
      ...node,
      confidence: Number(node.confidence),
      importance: Number(node.importance),
      provisional: true,
      provisional_decision_id: clean(node.provisionalDecisionId),
      provisional_reason_codes: Array.isArray(node.provisionalReasonCodes)
        ? node.provisionalReasonCodes
        : [],
    }));
}

function provisionalCandidateReview(node, scoreMultiplier) {
  return isProvisionalNode(node) ? {
    reviewDecisionId: clean(node.provisional_decision_id), scoreMultiplier,
    epistemicStatus: clean(node.metadata?.epistemicStatus) || 'agent_impression',
  } : null;
}

function applyProvisionalCandidatePolicy(candidates, options) {
  const multiplier = Math.max(0, Math.min(
    1,
    Number(options.provisionalScoreMultiplier) || 0.9,
  ));
  return candidates.map((candidate) => {
    if (!isProvisionalNode(candidate.node)) return candidate;
    const before = Number(candidate.score || 0);
    const score = before * multiplier;
    return {
      ...candidate,
      score,
      provisional: provisionalCandidateReview(candidate.node, multiplier),
      routeContributions: {
        ...(candidate.routeContributions || {}),
        "provisional-review": score - before,
      },
    };
  }).sort((left, right) => (
    right.score - left.score
    || right.node.importance - left.node.importance
    || Date.parse(right.node.recorded_at || "") - Date.parse(left.node.recorded_at || "")
  ));
}

function loadAccessibilityAdjustments(repository, agentId, plasticityPolicy) {
  if (!plasticityPolicy?.enabled) return new Map();
  return new Map(repository.listMemoryAccessibilityStates(agentId, {
    policyVersions: plasticityPolicy.memory.allowedPolicyVersions,
  }).map((state) => [
    state.memory_id,
    memoryAccessibilityAdjustment(state, plasticityPolicy),
  ]).filter(([, adjustment]) => Boolean(adjustment)));
}

function loadSourceAuthorities(database, agentId, memoryIds) {
  const result = new Map();
  const ids = [...new Set(memoryIds.map(clean).filter(Boolean))];
  if (!ids.length) return result;
  const requiredTables = ["memory_nodes", "memory_sources"];
  const tables = new Set(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN ('memory_nodes', 'memory_sources')
  `).all().map((row) => row.name));
  if (!requiredTables.every((name) => tables.has(name))) return result;
  const columns = new Set(database.prepare("PRAGMA table_info(memory_sources)")
    .all().map((row) => row.name));
  if (!columns.has("authority")) return result;
  const placeholders = ids.map(() => "?").join(", ");
  for (const row of database.prepare(`
    SELECT link.memory_id, link.authority
    FROM memory_sources AS link
    JOIN memory_nodes AS memory ON memory.id = link.memory_id
    WHERE memory.agent_id = ? AND link.memory_id IN (${placeholders})
    ORDER BY link.memory_id ASC, link.source_id ASC
  `).all(agentId, ...ids)) {
    if (!result.has(row.memory_id)) result.set(row.memory_id, []);
    const authority = clean(row.authority);
    if (authority && !result.get(row.memory_id).includes(authority)) {
      result.get(row.memory_id).push(authority);
    }
  }
  return result;
}

function temporalCandidates({
  nodes,
  temporal,
  query,
  options,
  entityScores = new Map(),
  naturalDecayAdjustments = new Map(),
  recallReactivationAdjustments = new Map(),
  preparedQuery = prepareLexicalQuery(query),
}) {
  const topic = recallCorePhrases(query).join(" ");
  const candidates = nodes.filter((node) => (
    !['utterance', 'topic', 'reflection'].includes(node.kind)
    && (topic || ['event', 'episode'].includes(node.kind))
    && memoryCalendarDate(node, options.timeZone) >= temporal.startDate
    && memoryCalendarDate(node, options.timeZone) <= temporal.endDate
  ));
  return candidates.map((node) => {
    const lexical = topic
      ? lexicalScore(preparedQuery, `${node.title || ""}\n${node.content}`)
      : { score: 0, overlap: 0, exactPhrase: false, queryTerms: [], matchedTerms: [] };
    const entityScore = Number(entityScores.get(node.id) || 0);
    const contentMatched = Boolean(
      topic
      && (
        lexical.exactPhrase
        || (
          lexical.score >= Number(options.strongLexicalScore)
          && lexical.overlap >= 2
        )
      ),
    );
    const specificity = Object.freeze({
      time: true,
      entity: entityScore > 0,
      content: contentMatched,
    });
    const bypassNaturalDecay = Object.values(specificity).every(Boolean);
    const storedNaturalDecay = naturalDecayAdjustments.get(node.id) || null;
    const naturalDecay = storedNaturalDecay && bypassNaturalDecay
      ? Object.freeze({
          ...storedNaturalDecay,
          bypassed: true,
          bypassReason: "high-specificity-match",
          specificity,
          scoreAdjustment: 0,
        })
      : storedNaturalDecay;
    const recallReactivation = recallReactivationAdjustments.get(node.id) || null;
    const lexicalMatch = lexicalRoute(lexical, options);
    const lexicalContribution = Number(lexicalMatch?.contribution || 0);
    const baseScore = topic ? lexicalContribution : 1;
    const score = Math.max(
      0,
      baseScore
        + Number(naturalDecay?.scoreAdjustment || 0)
        + Number(recallReactivation?.scoreAdjustment || 0),
    );
    const routeMatches = [{
      route: "temporal",
      strength: "exact",
      independentlyAdmissible: !topic,
      rawScore: 1,
      normalizedScore: 1,
      contribution: topic ? 0 : 1,
    }];
    if (topic) {
      routeMatches.push({
        route: "lexical",
        strength: lexical.exactPhrase ? "exact" : contentMatched ? "strong" : "supporting",
        independentlyAdmissible: false,
        rawScore: lexical.score,
        normalizedScore: Number(lexicalMatch?.normalizedScore || 0),
        contribution: lexicalContribution,
      });
    }
    if (entityScore > 0) {
      routeMatches.push({
        route: "entity",
        strength: "exact",
        independentlyAdmissible: false,
        rawScore: entityScore,
        normalizedScore: entityScore,
        contribution: 0,
      });
    }
    return {
      node,
      lexical,
      similarity: Number.NEGATIVE_INFINITY,
      entityScore,
      score,
      baseScore,
      recallReactivation,
      naturalDecay,
      specificity,
      admission: topic ? "temporal-topic" : "independent",
      routeMatches,
      routeContributions: {
        temporal: topic ? 0 : 1,
        ...(topic ? { lexical: lexicalContribution } : {}),
        ...(entityScore > 0 ? { entity: 0 } : {}),
        "recall-reactivation": Number(recallReactivation?.scoreAdjustment || 0),
        "natural-decay": Number(naturalDecay?.scoreAdjustment || 0),
      },
    };
  }).filter((item) => !topic || item.lexical.overlap > 0 || item.lexical.exactPhrase)
    .sort((left, right) => (
      right.score - left.score
      || memoryCalendarDate(left.node, options.timeZone).localeCompare(memoryCalendarDate(right.node, options.timeZone))
      || right.node.importance - left.node.importance
    ));
}

function matchedRouteStatus(candidates, convergenceCandidates, route) {
  if (candidates.some((candidate) => (
    candidate.routeMatches?.some((match) => match.route === route)
  ))) return "matched";
  if (convergenceCandidates.some((candidate) => (
    candidate.routeMatches?.some((match) => match.route === route)
  ))) return "supporting-only";
  return "no-match";
}

function isPersonEntity(entity) {
  return entity.kind === 'person' || entity.kind === 'agent';
}

function entitySeedScores(repository, agentId, query, { eligibleMemoryIds = null } = {}) {
  const normalizedQuery = query.normalize("NFKC").toLocaleLowerCase("zh-CN");
  const scores = new Map();
  const rankingScores = new Map();
  const matches = [];
  const named = [];
  for (const entity of repository.listEntities(agentId)) {
    const labels = [entity.canonical_name, ...entity.aliases]
      .map((label) => String(label || "").normalize("NFKC").trim())
      .filter(Boolean)
      .sort((left, right) => right.length - left.length);
    const mentions = labels.flatMap(label => {
      const normalizedLabel = label.toLocaleLowerCase("zh-CN");
      if (normalizedLabel.length < 2) return [];
      const latin = /^[\p{Script=Latin}\p{N}\s'_’.-]+$/u.test(normalizedLabel);
      const starts = latin ? boundedOccurrences(normalizedQuery, normalizedLabel) : [];
      if (!latin) {
        for (let index = normalizedQuery.indexOf(normalizedLabel); index >= 0; index = normalizedQuery.indexOf(normalizedLabel, index + 1)) starts.push(index);
      }
      return starts.map(start => ({ label, start, end: start + normalizedLabel.length, entityId: entity.id }));
    });
    if (mentions.length) named.push({ entity, mentions });
  }
  const references = repository.listEntityMemoryReferences({ agentId, entityIds: named.map(item => item.entity.id),
    statuses: ['active'], eligibleMemoryIds });
  const byEntity = new Map();
  for (const reference of references) {
    const links = byEntity.get(reference.entityId) || { direct: [], actor: [] };
    links[reference.source].push(reference.memoryId); byEntity.set(reference.entityId, links);
  }
  const eligible = named.filter(item => byEntity.has(item.entity.id));
  const concreteMentions = eligible.filter(item => item.entity.kind !== 'concept').flatMap(item => item.mentions);
  // A longer declared name owns its mention; a short prefix is not another
  // resolved object. Shared or overlapping mentions retain all candidates.
  const maximalMentions = concreteMentions.filter(mention => !concreteMentions.some(other =>
    other.start <= mention.start && other.end >= mention.end && other.end - other.start > mention.end - mention.start));
  const unambiguous = maximalMentions.filter(mention => !maximalMentions.some(other => other.entityId !== mention.entityId
    && other.start < mention.end && mention.start < other.end));
  const confidence = label => Math.min(1, 0.75 + label.length / Math.max(20, normalizedQuery.length) * 0.25);
  const resolved = new Map();
  for (const mention of unambiguous) resolved.set(mention.entityId, Math.max(resolved.get(mention.entityId) || 0, confidence(mention.label)));
  for (const { entity, mentions } of eligible) {
    const matchedLabel = mentions[0].label, score = confidence(matchedLabel);
    const { direct: directMemoryIds, actor: actorMemoryIds } = byEntity.get(entity.id);
    const memoryIds = [...new Set([...directMemoryIds, ...actorMemoryIds])];
    if (!memoryIds.length) continue;
    for (const memoryId of memoryIds) {
      scores.set(memoryId, Math.max(scores.get(memoryId) || 0, score));
      if (resolved.has(entity.id)) rankingScores.set(memoryId, Math.max(rankingScores.get(memoryId) || 0, resolved.get(entity.id)));
    }
    matches.push({
      entityId: entity.id,
      kind: entity.kind,
      canonicalName: entity.canonical_name,
      matchedLabel,
      memoryIds,
      directMemoryIds,
      actorMemoryIds,
    });
  }
  return { scores, rankingScores, matches };
}

function vectorScores(input) {
  return withEventSourceExecution(input.repository, () => vectorScoresInExecution(input), { signal: input.signal });
}

async function vectorScoresInExecution({
  repository,
  agentId,
  query,
  embeddingProvider,
  usageLedgerPath,
  now,
  eligibleMemoryIds = null,
  embeddingCache = true,
  embeddingCacheMaxBytes,
  signal = null,
}) {
  if (typeof embeddingProvider !== "function") {
    return { status: "disabled", scores: new Map(), usageRecorded: false };
  }
  const queryPlan = planVectorQuery(query);
  if (!queryPlan.text) return { status: 'not-run', scores: new Map(), usageRecorded: false };
  let response;
  let failure;
  try {
    signal?.throwIfAborted();
    response = await embeddingProvider(queryPlan.text, { signal });
  } catch (error) {
    failure = error;
    response = error;
  }
  let usageRecorded = false;
  let warning = "";
  if (usageLedgerPath && response.usage && Object.keys(response.usage).length) {
    try {
      await appendUsageEvent(usageLedgerPath, {
        timestamp: now.toISOString(),
        agentId,
        provider: response.metadata?.provider || "",
        model: response.model,
        source: "memory-retriever",
        feature: "memory-retrieval-embedding",
        requestId: response.requestId || "",
        usage: response.usage,
        metadata: response.metadata || {},
      });
      usageRecorded = true;
    } catch (error) {
      warning = `费用流水写入失败：${error.message}`;
    }
  }
  signal?.throwIfAborted();
  if (failure) {
    return { status: 'error', scores: new Map(), usageRecorded,
      queryText: queryPlan.text, querySource: queryPlan.source,
      warning: [`Embedding 不可用，已退回文本检索：${failure.message}`, warning].filter(Boolean).join('；') };
  }
  const embeddings = repository.listEmbeddings(agentId, response.model, {
    includeArchived: true,
    cache: embeddingCache,
    cacheMaxBytes: embeddingCacheMaxBytes,
  }).filter((embedding) => (
    !eligibleMemoryIds || eligibleMemoryIds.has(embedding.memory_id)
  ));
  const scores = new Map(embeddings.map((embedding) => [
    embedding.memory_id,
    dot(response.vector, embedding.vector),
  ]));
  return {
    status: embeddings.length ? "ready" : "missing-index",
    scores,
    vectors: new Map(embeddings.map(embedding => [embedding.memory_id, embedding.vector])),
    model: response.model,
    indexedMemories: embeddings.length,
    dimensions: response.vector.length,
    queryText: queryPlan.text,
    querySource: queryPlan.source,
    usageRecorded,
    warning,
  };
}

export async function retrieveMemories({
  databasePath, agentId, query, anchorMemoryIds = [], now = new Date(), embeddingProvider = null,
  usageLedgerPath = '', queryPerspective = {}, world = {}, allowCrossWorld = false,
  sourceScope = null, signal = null, options: overrides = {},
} = {}) {
  signal?.throwIfAborted();
  const normalizedAgentId = clean(agentId), normalizedQuery = clean(query);
  if (!normalizedAgentId) throw new Error('retrieveMemories 需要 agentId。');
  if (!normalizedQuery) throw new Error('retrieveMemories 需要 query。');
  const executionTime = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(executionTime.getTime())) throw new Error('now 不是有效时间。');
  const options = { ...DEFAULT_RETRIEVAL_OPTIONS, ...overrides };
  const worldScope = normalizeWorldScope(world, allowCrossWorld);
  const plasticityPolicy = normalizeAppliedPlasticityOptions(options.plasticity);
  const recallPolicy = normalizeRecallReactivationOptions(options.recallReactivation);
  const decayPolicy = normalizeNaturalDecayOptions(options.naturalDecay);
  const affectivePolicy = normalizeAffectiveBiasOptions(options.affectiveBias);
  const { retrievalQuery, temporal } = createRetrievalQueryPlan({
    query: normalizedQuery, now: executionTime, timeZone: options.timeZone });
  const requestedAnchors = [...new Set((Array.isArray(anchorMemoryIds) ? anchorMemoryIds : [])
    .map(clean).filter(Boolean))].slice(0, 3);
  const database = openMemoryDatabase(databasePath, { readOnly: true });
  let sourceView = null, transaction = false;
  try {
    if (sourceScope) { database.exec('BEGIN'); transaction = true; }
    const base = new MemoryRepository(database);
    sourceView = sourceScope ? createEventSourceView(base, sourceScope, normalizedAgentId) : null;
    const repository = sourceView ? new Proxy(base, { get(target, key) {
      if (key === 'getCurrentCanonicalMemory') return (...args) => {
        const node = target[key](...args); return sourceView.allows(node) ? node : null;
      };
      if (key === 'expand') return (agent, ids, settings) => target.expand(agent, ids,
        { ...settings, allowedMemoryIds: sourceView.memoryIds });
      if (key === 'listEmbeddings') return (...args) => target[key](...args).filter(row => {
        const ids = parseJson(row.source_memory_ids_json, []);
        return ids.includes(row.memory_id) && ids.every(id => sourceView.memoryIds.has(id));
      });
      const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
    } }) : base;
    const accessibility = loadAccessibilityAdjustments(repository, normalizedAgentId, plasticityPolicy);
    const recallStates = recallPolicy.enabled ? repository.listMemoryRecallReactivationStates(normalizedAgentId,
      { policyVersions: [recallPolicy.configurationVersion] }) : [];
    const reactivation = buildRecallReactivationAdjustments(recallStates, executionTime, recallPolicy);
    const affective = buildAffectiveCandidateAdjustments({ repository, agentId: normalizedAgentId, policy: affectivePolicy });
    const reader = createNodeReader(database, normalizedAgentId, options);
    if (reader.stats.deferred && !transaction) { database.exec('BEGIN'); transaction = true; }
    const nodes = [...reader.load(['active']), ...reader.load(['superseded', 'disputed']),
      ...loadPendingProvisionalNodes(repository, normalizedAgentId)]
      .filter(node => (!sourceView || sourceView.allows(node)) && nodeMatchesWorldScope(node, worldScope));
    const eligibleMemoryIds = new Set(nodes.map(node => node.id)), nodeById = new Map(nodes.map(node => [node.id, node]));
    const decay = buildNaturalDecayAdjustments(nodes.filter(node => !isProvisionalNode(node)), executionTime, decayPolicy);
    const entities = entitySeedScores(repository, normalizedAgentId, retrievalQuery, { eligibleMemoryIds });
    const personNames = [...(queryPerspective.speakerNames || []), ...(queryPerspective.addresseeNames || []),
      ...entities.matches.filter(isPersonEntity).map(match => match.matchedLabel)];
    const preparedQuery = prepareLexicalQuery(retrievalQuery, { personNames });
    const topicalIds = new Set(entities.matches.filter(match => !isPersonEntity(match) && match.kind !== 'concept')
      .flatMap(match => [...match.directMemoryIds, ...match.actorMemoryIds]));
    const personOnlyIds = new Set(entities.matches.filter(isPersonEntity)
      .flatMap(match => [...match.directMemoryIds, ...match.actorMemoryIds]).filter(id => !topicalIds.has(id)));
    const bm25 = collectBm25SeedScores({ repository, agentId: normalizedAgentId, query: retrievalQuery, preparedQuery,
      maximumQueries: options.maximumBm25Queries, maximumResultsPerQuery: options.maximumBm25ResultsPerQuery,
      eligibleMemoryIds, worldId: worldScope.allowCrossWorld ? '' : worldScope.id,
      worldFrame: worldScope.allowCrossWorld ? '' : worldScope.frame });
    const vector = await vectorScores({ repository, agentId: normalizedAgentId, query: retrievalQuery,
      embeddingProvider, usageLedgerPath, now: executionTime, eligibleMemoryIds,
      embeddingCache: options.embeddingCache !== false, embeddingCacheMaxBytes: options.embeddingCacheMaxBytes, signal });
    signal?.throwIfAborted();
    const coarse = prefilterCandidateIds(database, normalizedAgentId, preparedQuery,
      { bm25Scores: bm25.scores, vectorScores: vector.scores, entityScores: entities.scores }, options, nodes.length);
    const candidateNodes = coarse ? nodes.filter(node => isProvisionalNode(node) || coarse.has(node.id)
      || requestedAnchors.includes(node.id)) : nodes;
    reader.hydrate(candidateNodes);
    const conceptLabels = repository.listMemoryConceptLabels({ agentId: normalizedAgentId,
      memoryIds: candidateNodes.map(node => node.id) });
    const scoreLexical = createSeedLexicalScorer(preparedQuery, { includeQuestions: true, conceptLabels });
    const specific = temporal.matched && temporal.precision === 'exact' && decayPolicy.enabled
      ? new Map(temporalCandidates({ nodes: candidateNodes, temporal, query: temporal.remainingQuery, preparedQuery,
        options, entityScores: entities.scores }).filter(candidate => Object.values(candidate.specificity).every(Boolean))
        .map(candidate => [candidate.node.id, candidate.specificity])) : new Map();
    let convergenceCandidates = applyProvisionalCandidatePolicy(buildOrdinarySeedCandidates({
      nodes: candidateNodes, query: retrievalQuery, preparedQuery, scoreLexical,
      bm25Scores: bm25.scores, vectorScores: vector.scores, entityScores: entities.scores, entityRankingScores: entities.rankingScores,
      subjectOnlyEntityMemoryIds: personOnlyIds, options, includeWeakLexical: true,
      accessibilityAdjustments: accessibility, recallReactivationAdjustments: reactivation,
      naturalDecayAdjustments: decay, naturalDecayBypassMemoryIds: new Set(specific.keys()),
      naturalDecaySpecificityByMemory: specific, affectiveAdjustments: affective.adjustments,
    }), options);
    // Calendar lookup is an additional route, including when a date has no text topic.
    // It never replaces lexical/vector matches or imposes an inferred date filter.
    const dateCandidates = temporal.matched && !recallCorePhrases(temporal.remainingQuery).length ? temporalOverviewCandidates(nodes, temporal,
      options).slice(0, options.maximumCandidates).map(candidate => ({
        ...candidate, score: 0, temporalRanking: undefined,
      })) : [];
    reader.hydrate(dateCandidates.map(candidate => candidate.node));
    const anchors = requestedAnchors.map(id => nodeById.get(id)).filter(Boolean).map(node => ({
      node, score: 1, admission: 'independent', continuationAnchor: true,
      provisional: provisionalCandidateReview(node, 1),
      lexical: { score: 0, overlap: 0, exactPhrase: false, matchedTerms: [], queryTerms: [] },
      routeMatches: [{ route: 'continuation', strength: 'exact', independentlyAdmissible: true,
        rawScore: 1, normalizedScore: 1, contribution: 1 }], routeContributions: { continuation: 1 },
    }));
    const ranked = values => rankTemporalCandidates(values, temporal, options);
    convergenceCandidates = ranked(fuseCandidateLanes([...convergenceCandidates, ...dateCandidates], anchors,
      Number.MAX_SAFE_INTEGER)).slice(0, Math.max(options.maximumCandidates, options.maximumConvergenceCandidates));
    const candidates = convergenceCandidates.filter(candidate => candidate.admission !== 'convergence-only')
      .slice(0, options.maximumCandidates);
    const primaryCandidate = anchors[0] || candidates[0];
    const stateView = createStateReadView({ repository, agentId: normalizedAgentId,
      provisionalNodes: nodes.filter(isProvisionalNode), eligibleMemoryIds });
    const chain = primaryCandidate ? selectRetrievalContext({ database, repository, agentId: normalizedAgentId,
      primaryCandidate, candidates, convergenceCandidates, eligibleMemoryIds, plasticityPolicy,
      preparedQuery, scoreLexical, embeddingVectors: vector.vectors, stateView, options })
      : { nodes: [], paths: [], activation: null, selection: null, seeds: { enabled: false, candidates: [], connections: [] } };
    signal?.throwIfAborted();
    const returnedCandidates = candidates.slice(0, options.maximumReturnedCandidates);
    const authorities = loadSourceAuthorities(database, normalizedAgentId, [
      ...chain.nodes.map(node => node.id), ...(options.includeCandidateContext ? returnedCandidates.map(candidate => candidate.node.id) : []),
    ]);
    const actorNames = new Map([
      [queryPerspective.speakerKey, queryPerspective.speakerNames?.[0]],
      [queryPerspective.addresseeKey, queryPerspective.addresseeNames?.[0]],
    ].filter(([key, name]) => key && name));
    const output = renderRecallOutput({ nodes: chain.nodes }, { ...options, showRecallDate: true, actorNames,
      sourceAuthoritiesByMemoryId: authorities, closureLabel: node => closedStateLabel(stateView.closurePhase(node)) });
    const displayedIds = output.records.map(record => record.memoryId), displayed = new Set(displayedIds);
    const selectedNodes = chain.nodes.filter(node => displayed.has(node.id));
    const primary = selectedNodes[0];
    const status = primary ? 'ready' : 'no-match';
    const plannedRoutes = ['lexical', 'bm25', 'entity', ...(temporal.matched ? ['temporal'] : []),
      ...(embeddingProvider ? ['vector'] : []), ...(anchors.length ? ['continuation'] : [])];
    const seedRouting = seedRoutingAudit({ plannedRoutes,
      executedRoutes: plannedRoutes.filter(route => route !== 'bm25' || bm25.status === 'ready'),
      candidates, convergenceCandidates, primaryMemoryId: primary?.id || '', bm25Routing: bm25.audit,
      routeStatus: { lexical: matchedRouteStatus(candidates, convergenceCandidates, 'lexical'),
        bm25: bm25.status === 'ready' ? matchedRouteStatus(candidates, convergenceCandidates, 'bm25') : bm25.status,
        entity: entities.matches.length ? 'matched' : 'no-match',
        vector: vector.status === 'ready' ? matchedRouteStatus(candidates, convergenceCandidates, 'vector') : vector.status,
        ...(temporal.matched ? { temporal: convergenceCandidates.some(candidate => candidate.temporalRanking?.timeScore > 0)
          ? 'matched' : 'no-match' } : {}) } });
    const provisionalIds = selectedNodes.filter(isProvisionalNode).map(node => node.id);
    const paths = chain.paths.filter(path => displayed.has(path.memoryId));
    const retrievalMode = anchors.length ? 'continuation' : primary?.kind === 'utterance'
      ? vector.status === 'ready' ? 'episodic-hybrid' : 'episodic-lexical'
      : vector.status === 'ready' ? 'hybrid' : entities.matches.length ? 'entity-lexical' : 'lexical';
    const trace = retrievalTracePayload({ agentId: normalizedAgentId, query: normalizedQuery,
      resultStatus: status, retrievalMode, seedIds: chain.seeds.candidates.map(candidate => candidate.node.id),
      selectedIds: selectedNodes.filter(node => !isProvisionalNode(node)).map(node => node.id), paths,
      matchedEntities: entities.matches, context: output.context, candidateCount: returnedCandidates.length,
      vectorStatus: vector.status, metadata: {
        temporal, seedRouting, displayedMemoryIds: displayedIds, provisionalMemoryIds: provisionalIds,
        recalledMemoryIds: displayedIds.filter(id => !provisionalIds.includes(id)),
        focusMemoryId: primary?.id || '', continuationMemoryId: selectedNodes.at(-1)?.id || '',
        continuationAnchorIds: anchors.map(candidate => candidate.node.id),
        contextSelection: chain.selection, activationField: chain.activation, outputBudget: output.outputBudget,
        plasticity: { ...appliedPlasticityAudit(plasticityPolicy), loadedMemoryStateCount: accessibility.size,
          adjustedCandidateCount: candidates.filter(candidate => candidate.accessibility).length,
          adjustedEdgeTraversalCount: chain.activation?.plasticity?.adjustedEdgeTraversalCount || 0 },
        recallReactivation: recallReactivationAudit(recallPolicy, { loadedStateCount: reactivation.size,
          adjustedCandidateCount: candidates.filter(candidate => candidate.recallReactivation).length }),
        naturalDecay: naturalDecayAudit(decayPolicy, {
          adjustedCandidateCount: candidates.filter(candidate => candidate.naturalDecay?.scoreAdjustment).length,
          bypassedCandidateCount: candidates.filter(candidate => candidate.naturalDecay?.bypassed).length }),
        affectiveBias: affectiveBiasAudit(affectivePolicy, { ...affective,
          adjustedCandidateCount: candidates.filter(candidate => candidate.affectiveBias).length }),
      } });
    return { status, query: normalizedQuery, temporal, searchedMemories: nodes.length, retrievalMode,
      candidates: returnedCandidates.map(candidate => ({ memoryId: candidate.node.id,
        matchedMemoryId: candidate.node.id, kind: candidate.node.kind, title: candidate.node.title,
        content: candidate.node.content, score: candidate.score, lexicalScore: candidate.lexical?.score || 0,
        lexicalOverlap: candidate.lexical?.overlap || 0, exactPhrase: Boolean(candidate.lexical?.exactPhrase),
        vectorSimilarity: Number.isFinite(candidate.similarity) ? candidate.similarity : null,
        bm25Score: Number(candidate.bm25?.normalizedScore || 0), entityScore: candidate.entityScore || 0,
        admission: candidate.admission, routeMatches: candidate.routeMatches,
        retrievalLane: candidate.retrievalLane, laneRank: candidate.laneRank,
        bm25MatchedQueryCount: Number(candidate.bm25?.matchedQueryCount || 0),
        provisionalReview: candidate.provisional ? { reviewDecisionId: candidate.provisional.reviewDecisionId,
          epistemicStatus: candidate.provisional.epistemicStatus, scoreMultiplier: candidate.provisional.scoreMultiplier,
          reasonCodes: [...(candidate.node.provisional_reason_codes || [])] } : null,
        temporalRanking: candidate.temporalRanking, accessibility: candidate.accessibility,
        recallReactivation: candidate.recallReactivation || null,
        naturalDecay: candidate.naturalDecay ? { ...candidate.naturalDecay, bypassed: Boolean(candidate.naturalDecay.bypassed) } : null,
        affectiveBias: candidate.affectiveBias || null, provisional: Boolean(candidate.provisional),
        ...(options.includeCandidateContext ? { recallContext: `记忆状态：${candidate.node.status}；现实范围：${candidate.node.reality || 'unknown'}；时间性质：${candidate.node.temporal_state || 'unknown'}。\n` + formatPrimary(candidate.node, [],
          { ...options, sourceAuthoritiesByMemoryId: authorities, maximumContextChars: 1000 }),
          ...(sourceView ? { eventSources: sourceView.sourcesFor([candidate.node.id]) } : {}) } : {}),
      })),
      records: output.records.map(record => ({ ...record,
        ...(sourceView ? { eventSources: sourceView.sourcesFor([record.memoryId]) } : {}) })),
      fragments: primary ? [{ memoryId: primary.id, memoryIds: displayedIds, memoryType: primary.kind,
        provisional: isProvisionalNode(primary), provisionalReviewDecisionId: primary.provisional_decision_id || '', text: output.text,
        evidenceIds: selectedNodes.filter(node => node.kind === 'utterance').map(node => node.id),
        ...(sourceView ? { eventSources: sourceView.sourcesFor(displayedIds) } : {}) }] : [],
      context: output.context, guidance: options.guidance, outputBudget: output.outputBudget, matchedEntities: entities.matches,
      disclosureLevel: !primary ? 'none' : primary.kind === 'utterance' ? 'evidence'
        : selectedNodes.length > 1 ? 'related-memories' : 'conclusion', vector: { ...vector, scores: undefined, vectors: undefined },
      bm25: { status: bm25.status, audit: bm25.audit }, trace, seedRouting,
      graph: { seedId: primaryCandidate?.node.id || '', nodeIds: displayedIds,
        edgeIds: [...new Set(paths.flatMap(path => path.edges.map(edge => edge.edgeId)))],
        selectedMemoryIds: displayedIds, paths, activationField: chain.activation, contextSelection: chain.selection,
        evidenceMemoryIds: selectedNodes.filter(node => node.kind === 'utterance').map(node => node.id),
        convergedSeeds: chain.seeds.enabled ? { memoryIds: chain.seeds.candidates.map(candidate => candidate.node.id),
          connections: chain.seeds.connections } : null },
    };
  } finally {
    if (transaction) database.exec('ROLLBACK');
    try { sourceView?.assertCurrent(); } finally { database.close(); }
  }
}
