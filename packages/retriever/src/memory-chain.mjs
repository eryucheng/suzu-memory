import { isProvisionalMemory as isProvisionalNode } from '@suzu-memory/core';
import { appliedPlasticityAudit, edgeRelationUtilityAdjustment } from './plasticity-ranking.mjs';
import { normalizedEvidenceLimit } from './candidate-selection.mjs';
const parseJson = (value, fallback = {}) => { try { return JSON.parse(value); } catch { return fallback; } };
const RELATION_UTILITY_BY_VIEW = Object.freeze({
  associative: Object.freeze({
    associated_with: 1,
    causes: 1,
    timeline_next: 1,
    part_of_episode: 1,
    supports_topic: 0.9,
    shares_entity: 0.9,
    same_thread: 0.8,
    corrects: 0.9,
    supersedes: 0.9,
    established_from: 1,
    contradicts: 0.7,
    completes: 0.9,
    cancels: 0.9,
    scoped_exception_to: 1,
  }),
});

const MANDATORY_PROPAGATION_RELATIONS = new Set([
  "corrects",
  "supersedes",
  "established_from",
  "completes",
  "cancels",
  "scoped_exception_to",
]);

const REVERSE_CHRONOLOGY_RELATIONS = new Set([
  "corrects",
  "supersedes",
  "established_from",
  "completes",
  "cancels",
]);


const CONVERGENCE_RELATIONS = Object.freeze([
  "part_of_episode",
  "supports_topic",
  "same_thread",
  "shares_entity",
  "timeline_next",
  "corrects",
  "supersedes",
  "completes",
  "cancels",
  "scoped_exception_to",
]);


function propagationPolicy(relation) {
  if (MANDATORY_PROPAGATION_RELATIONS.has(relation)) return "mandatory";
  if ([
    "timeline_next",
    "same_thread",
    "part_of_episode",
    "supports_topic",
    "causes",
  ].includes(relation)) return "conditional";
  return "associative";
}

function traversalPropagationPolicy(edge, currentId, view) {
  const basePolicy = propagationPolicy(edge.relation);
  if (
    basePolicy !== "mandatory"
    || view !== "associative"
    || !REVERSE_CHRONOLOGY_RELATIONS.has(edge.relation)
  ) return basePolicy;
  return edge.to_memory_id === currentId ? "mandatory" : "conditional";
}

function relationUtility(relation, view) {
  return Number(RELATION_UTILITY_BY_VIEW[view]?.[relation] || 0);
}

function relationFactor(relation) {
  if (relation === "part_of_episode") return 1;
  if (relation === "same_thread") return 1;
  if (relation === "supports_topic") return 0.95;
  if (relation === "shares_entity") return 0.97;
  if (relation === "timeline_next") return 0.98;
  if (relation === "associated_with") return 0.95;
  if (relation === "causes") return 1;
  if (relation === "scoped_exception_to") return 1;
  return 0.9;
}

function edgeTraversalStrength(edge, view, learningMultiplier = 1) {
  return Math.max(0, Number(edge.weight))
    * Math.max(0, Number(edge.confidence))
    * relationFactor(edge.relation)
    * relationUtility(edge.relation, view)
    * Math.max(0, Number(learningMultiplier));
}

function fanoutFactors(traversals, exponent, view, currentId) {
  const factors = new Map();
  const policies = new Map(traversals.map(({ edge }) => [
    edge.id,
    traversalPropagationPolicy(edge, currentId, view),
  ]));
  const budgeted = traversals.filter(({ edge }) => policies.get(edge.id) !== "mandatory");
  const totalStrength = budgeted.reduce(
    (sum, traversal) => sum + traversal.strength,
    0,
  );
  const normalizedExponent = Math.max(0, Math.min(1, Number(exponent)));
  for (const traversal of traversals) {
    const { edge } = traversal;
    if (policies.get(edge.id) === "mandatory") {
      factors.set(edge.id, 1);
      continue;
    }
    const share = totalStrength > 0
      ? traversal.strength / totalStrength
      : 0;
    factors.set(edge.id, share > 0 ? Math.pow(share, normalizedExponent) : 0);
  }
  return { factors, policies, budgetedFanout: budgeted.length };
}

function nodeAllowedForTraversal(node) {
  return node && ['active', 'superseded', 'disputed'].includes(node.status);
}

export function followMemoryChain({
  database,
  agentId,
  primary,
  seedCandidates = [],
  eligibleMemoryIds = null,
  plasticityPolicy,
  options,
}) {
  if (!primary) return { nodes: [], paths: [], activation: null };
  const seeds = seedCandidates.length
    ? seedCandidates
    : [{ node: primary, score: 1 }];
  const relationView = 'associative';
  const maximumWork = Math.max(1, Math.trunc(Number(options.maximumActivationWork) || 100));
  const edgeLimit = ` LIMIT ${Math.trunc(maximumWork)}`;
  const outgoing = database.prepare(`
    SELECT edge.*, proposal.review_state AS relation_review_state,
      learned.value AS learned_utility_value,
      learned.policy_version AS learned_utility_policy_version,
      learned.last_observation_window_id AS learned_utility_window_id,
      learned.last_applied_at AS learned_utility_applied_at
    FROM memory_edges AS edge
    LEFT JOIN memory_relation_proposals AS proposal
      ON proposal.agent_id = edge.agent_id AND proposal.result_edge_id = edge.id
    LEFT JOIN memory_edge_relation_utility_state AS learned
      ON learned.agent_id = edge.agent_id AND learned.edge_id = edge.id
      AND learned.intent_view = ?
    WHERE edge.agent_id = ? AND edge.from_memory_id = ?
    ORDER BY edge.weight DESC, edge.updated_at DESC${edgeLimit}
  `);
  const incoming = database.prepare(`
    SELECT edge.*, proposal.review_state AS relation_review_state,
      learned.value AS learned_utility_value,
      learned.policy_version AS learned_utility_policy_version,
      learned.last_observation_window_id AS learned_utility_window_id,
      learned.last_applied_at AS learned_utility_applied_at
    FROM memory_edges AS edge
    LEFT JOIN memory_relation_proposals AS proposal
      ON proposal.agent_id = edge.agent_id AND proposal.result_edge_id = edge.id
    LEFT JOIN memory_edge_relation_utility_state AS learned
      ON learned.agent_id = edge.agent_id AND learned.edge_id = edge.id
      AND learned.intent_view = ?
    WHERE edge.agent_id = ? AND edge.to_memory_id = ?
    ORDER BY edge.weight DESC, edge.updated_at DESC${edgeLimit}
  `);
  const nodeQuery = database.prepare(`
    SELECT * FROM memory_nodes
    WHERE agent_id = ? AND id = ? AND status <> 'deleted'
  `);
  const maximumDepth = Math.max(1, Number(options.maximumChainDepth));
  const maximumNodes = Math.max(1, Number(options.maximumConvergenceCandidates));
  const minimumScore = Math.max(0, Number(options.minimumChainPathScore));
  const minimumContribution = Math.max(0, Number(options.minimumActivationContribution));
  const primarySeedScore = Math.max(0.0001, Number(seeds[0]?.score) || 1);
  const contributions = new Map();
  const seedValues = seeds.map((candidate, index) => ({
    id: candidate.node.id,
    node: candidate.node,
    score: index === 0
      ? 1
      : Math.max(0.45, Math.min(1, (Number(candidate.score) || 0) / primarySeedScore)),
    depth: 0,
    path: [],
    seedId: candidate.node.id,
  }));
  const queue = [];
  for (const seed of seedValues) {
    if (!contributions.has(seed.id)) contributions.set(seed.id, new Map());
    contributions.get(seed.id).set(seed.seedId, seed);
    if (!isProvisionalNode(seed.node) && seed.node.kind !== 'utterance') queue.push(seed);
  }
  const traversalCache = new Map(), nodeCache = new Map();
  let processedStates = 0;
  while (queue.length && processedStates < maximumWork) {
    queue.sort((left, right) => right.score - left.score);
    const current = queue.shift();
    processedStates += 1;
    if (current.depth >= maximumDepth) continue;
    let view = traversalCache.get(current.id);
    if (!view) {
      const traversable = [
        ...outgoing.all(relationView, agentId, current.id),
        ...incoming.all(relationView, agentId, current.id),
      ].filter((edge) => (relationUtility(edge.relation, relationView) > 0
        && (edge.relation !== 'causes' || edge.relation_review_state === 'accepted'))
        || (edge.relation === 'supported_by' && edge.from_memory_id === current.id))
        .map((edge) => {
          const neighborId = edge.from_memory_id === current.id
            ? edge.to_memory_id
            : edge.from_memory_id;
          if (eligibleMemoryIds && !eligibleMemoryIds.has(neighborId)) return null;
          if (!nodeCache.has(neighborId)) nodeCache.set(neighborId, nodeQuery.get(agentId, neighborId));
          const node = nodeCache.get(neighborId);
          if (!nodeAllowedForTraversal(node)) return null;

          const propagation = traversalPropagationPolicy(edge, current.id, relationView);
          const learned = propagation === "mandatory" || (edge.relation === 'supported_by') ? null : edgeRelationUtilityAdjustment(
            edge.learned_utility_value === null || edge.learned_utility_value === undefined
              ? null
              : {
                value: edge.learned_utility_value,
                policy_version: edge.learned_utility_policy_version,
                last_observation_window_id: edge.learned_utility_window_id,
                last_applied_at: edge.learned_utility_applied_at,
              },
            plasticityPolicy,
          );
          return {
            edge,
            neighborId,
            node,
            propagationPolicy: propagation,
            learned,
            strength: edge.relation === 'supported_by'
              ? Math.max(0, Number(edge.weight)) * Math.max(0, Number(edge.confidence))
              : edgeTraversalStrength(edge, relationView, learned?.multiplier ?? 1),
          };
        })
        .filter((value) => Boolean(value?.node));
      const fanout = fanoutFactors(
        traversable.filter(value => value.edge.relation !== 'supported_by'),
        options.fanoutSuppressionExponent,
        relationView,
        current.id,
      );
      view = { traversable, fanout };
      traversalCache.set(current.id, view);
    }
    const { traversable, fanout } = view;
    for (const traversal of traversable) {
      const { edge, neighborId, node } = traversal;
      const directEvidence = edge.relation === 'supported_by';
      const fanoutFactor = directEvidence ? 1 : fanout.factors.get(edge.id) || 0;
      const score = current.score
        * traversal.strength
        * fanoutFactor
        * 0.82;
      if (score < minimumContribution) continue;
      if (!contributions.has(neighborId)) contributions.set(neighborId, new Map());
      const previous = contributions.get(neighborId).get(current.seedId);
      if (score <= (previous?.score || 0)) continue;
      const value = {
        id: neighborId,
        node: {
          ...node,
          confidence: Number(node.confidence),
          importance: Number(node.importance),
          metadata: parseJson(node.metadata_json, {}),
        },
        score,
        depth: current.depth + 1,
        seedId: current.seedId,
        path: [...current.path, {
          edgeId: edge.id,
          relation: edge.relation,
          fromMemoryId: edge.from_memory_id,
          toMemoryId: edge.to_memory_id,
          weight: Number(edge.weight),
          confidence: Number(edge.confidence),
          relationView,
          relationUtility: edge.relation === 'supported_by' ? 1 : relationUtility(edge.relation, relationView),
          learnedRelationUtility: traversal.learned ? {
            value: traversal.learned.value,
            policyVersion: traversal.learned.policyVersion,
            configurationVersion: traversal.learned.configurationVersion,
            multiplier: traversal.learned.multiplier,
          } : null,
          appliedRelationUtility: (edge.relation === 'supported_by' ? 1 : relationUtility(edge.relation, relationView))
            * (traversal.learned?.multiplier ?? 1),
          propagationPolicy: directEvidence ? 'direct-evidence' : fanout.policies.get(edge.id),
          traversalFromMemoryId: current.id,
          traversalToMemoryId: neighborId,
          chronologyDirection: "not-applicable",
          fanout: fanout.budgetedFanout,
          fanoutFactor,
        }],
      };
      contributions.get(neighborId).set(current.seedId, value);
      // Sources are terminal evidence. Adjacent dialogue is resolved as an
      // exchange by context selection, never as arbitrary graph propagation.
      if (node.kind !== 'utterance') queue.push(value);
    }
  }
  const aggregated = [...contributions.entries()].map(([id, bySeed]) => {
    const values = [...bySeed.values()];
    const activation = 1 - values.reduce(
      (remaining, value) => remaining * (1 - Math.max(0, Math.min(1, value.score))),
      1,
    );
    const best = values.sort((left, right) => right.score - left.score)[0];
    return {
      id,
      node: best.node,
      activation,
      sourceCount: bySeed.size,
      best,
      contributions: [...bySeed.values()]
        .sort((left, right) => right.score - left.score)
        .map((value) => ({ seedMemoryId: value.seedId, score: value.score })),
    };
  });
  const seedIds = new Set(seedValues.map((seed) => seed.id));
  const selectedSeeds = seedValues
    .map((seed) => aggregated.find((value) => value.id === seed.id))
    .filter(Boolean);
  const related = aggregated
    .filter((value) => !seedIds.has(value.id) && value.activation >= minimumScore)
    .sort((left, right) => (
      right.activation - left.activation
      || right.sourceCount - left.sourceCount
      || right.node.importance - left.node.importance
    ));
  const values = [...selectedSeeds, ...related].sort((left, right) => right.activation - left.activation).slice(0, maximumNodes);

  return {
    nodes: values.map((value) => value.node),
    candidates: values.map(value => ({
      node: value.node,
      score: value.best.score * primarySeedScore,
      admission: 'graph-linked',
    })),
    paths: values.filter((value) => value.best.path.length).map((value) => ({
      memoryId: value.id,
      score: value.activation,
      sourceCount: value.sourceCount,
      seedContributions: value.contributions,
      edges: value.best.path,
    })),
    activation: {
      relationView,
      seedMemoryIds: seedValues.map((seed) => seed.id),
      processedStates,
      edgeLookupCount: traversalCache.size * 2,
      nodeLookupCount: nodeCache.size,
      truncated: queue.length > 0,
      selected: values.map((value) => ({
        memoryId: value.id,
        activation: value.activation,
        sourceCount: value.sourceCount,
      })),
      plasticity: {
        ...appliedPlasticityAudit(plasticityPolicy),
        adjustedEdgeTraversalCount: [...new Set(values
          .flatMap((value) => value.best.path)
          .filter((step) => step.learnedRelationUtility)
          .map((step) => step.edgeId))].length,
      },
    },
  };
}

export function selectConvergedSeeds({
  database,
  agentId,
  candidates,
  primaryCandidate,
  eligibleMemoryIds = null,
  options,
}) {
  const disabled = { enabled: false, candidates: primaryCandidate ? [primaryCandidate] : [], connections: [] };
  // Discovery is bounded independently from the final context budget.
  const maximumSeeds = Math.max(1, normalizedEvidenceLimit(options.maximumCandidates, 20));
  if (!primaryCandidate || maximumSeeds <= 1) return disabled;
  const eligible = candidates.filter((candidate) => (
    candidate.node.id !== primaryCandidate.node.id
    && (!isProvisionalNode(candidate.node) || candidate.node.metadata?.epistemicStatus === "reported_state")
  ));
  if (!eligible.length) return disabled;
  const pool = [primaryCandidate, ...eligible];
  const ids = pool.map((candidate) => candidate.node.id);
  const placeholders = ids.map(() => "?").join(", ");
  const relationPlaceholders = CONVERGENCE_RELATIONS.map(() => "?").join(", ");
  const edges = database.prepare(`
    SELECT * FROM memory_edges
    WHERE agent_id = ?
      AND relation IN (${relationPlaceholders})
      AND (from_memory_id IN (${placeholders}) OR to_memory_id IN (${placeholders}))
  `).all(agentId, ...CONVERGENCE_RELATIONS, ...ids, ...ids).filter((edge) => (
    !eligibleMemoryIds
    || (eligibleMemoryIds.has(edge.from_memory_id) && eligibleMemoryIds.has(edge.to_memory_id))
  ));
  const neighbors = new Map(ids.map((id) => [id, new Map()]));
  for (const edge of edges) {
    if (neighbors.has(edge.from_memory_id)) {
      neighbors.get(edge.from_memory_id).set(edge.to_memory_id, edge);
    }
    if (neighbors.has(edge.to_memory_id)) {
      neighbors.get(edge.to_memory_id).set(edge.from_memory_id, edge);
    }
  }
  const selected = [primaryCandidate];
  const connections = [];
  for (const candidate of eligible) {
    if (selected.length >= maximumSeeds) break;
    let connection = null;
    for (const current of selected) {
      const direct = neighbors.get(current.node.id)?.get(candidate.node.id);
      if (direct) {
        connection = {
          fromMemoryId: current.node.id,
          toMemoryId: candidate.node.id,
          relation: direct.relation,
          viaMemoryId: "",
        };
        break;
      }
      const leftNeighbors = neighbors.get(current.node.id) || new Map();
      const rightNeighbors = neighbors.get(candidate.node.id) || new Map();
      const shared = [...leftNeighbors.keys()].find((id) => rightNeighbors.has(id));
      if (shared) {
        connection = {
          fromMemoryId: current.node.id,
          toMemoryId: candidate.node.id,
          relation: "converges_via",
          viaMemoryId: shared,
        };
        break;
      }
    }
    // Directly admitted matches share the same budget regardless of kind.
    // Weak text-only clues still need a graph relation to a selected match.
    if (!connection && candidate.admission === "convergence-only") continue;
    selected.push(candidate);
    if (connection) connections.push(connection);
  }
  return selected.length > 1
    ? { enabled: true, candidates: selected, connections }
    : disabled;
}
