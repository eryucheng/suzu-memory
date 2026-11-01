import { REPORTED_STATE_TERMINAL_PHASES } from './reported-state-policy.mjs';

const clean = value => String(value ?? '').trim();
const TERMINAL_PHASES = new Set(REPORTED_STATE_TERMINAL_PHASES);
export const STATE_REPRESENTATION_LAYERS = Object.freeze(['reported', 'established', 'inferred']);

export function isProvisionalMemory(node) {
  return node?.layer === "provisional"
    && node?.metadata?.provisional === true;
}

export function isStructuredStateMemory(node) {
  return !isProvisionalMemory(node)
    && Boolean(clean(node?.canonical_key))
    && !["", "not_applicable", "unspecified"].includes(clean(node?.state_family));
}

function reportedStateClosureReader(database, agentId, provisionalNodes) {
  const eligiblePendingIds = new Set(provisionalNodes.map(node => node.metadata?.reportedStateProposalId).filter(Boolean));
  const reviews = new Map();
  return node => {
    if (node?.status !== "superseded" || node.representation_layer !== "reported" || !node.valid_to) return "";
    if (!TERMINAL_PHASES.has(node.state_phase)) return "";
    const transitionId = clean(node.metadata?.reportedStateTransitionId);
    if (transitionId && !eligiblePendingIds.has(transitionId)) {
      if (!reviews.has(transitionId)) reviews.set(transitionId, database.prepare(
        "SELECT review_state FROM memory_reported_state_proposals WHERE agent_id = ? AND id = ?",
      ).get(agentId, transitionId)?.review_state);
      if (reviews.get(transitionId) !== "accepted") return "";
    }
    return node.state_phase;
  };
}

function resolveCurrentState(repository, primary, { includeClosed = false, closurePhase = null } = {}) {
  if (
    !primary
    || primary.status === "active"
    || !clean(primary.canonical_key)
    || [
      "utterance",
      "event",
      "episode",
      "topic",
      "reflection",
      "topic_or_episode",
    ].includes(primary.kind)
  ) return null;
  const current = repository.getCurrentCanonicalMemory({
    agentId: primary.agent_id,
    subjectRole: primary.subject_role,
    subjectKey: primary.subject_key,
    canonicalKey: primary.canonical_key,
    representationLayer: primary.representation_layer,
    stateFamily: primary.state_family,
    stateScopeKey: primary.state_scope_key,
    worldId: primary.world_id,
    worldFrame: primary.world_frame,
    includePending: true,
    includeHistorical: includeClosed,
  });
  const closed = Boolean(current && includeClosed && closurePhase?.(current));
  const pending = isProvisionalMemory(current) && current.status === "archived"
    && current.metadata?.epistemicStatus === "reported_state";
  if (current && (current.status === "active" || pending || closed)
    && (current.id !== primary.id || closed)) return current;
  if (primary.representation_layer !== "inferred") return null;
  const established = repository.getCurrentCanonicalMemory({
    agentId: primary.agent_id,
    subjectRole: primary.subject_role,
    subjectKey: primary.subject_key,
    canonicalKey: primary.canonical_key,
    representationLayer: "established",
    stateFamily: primary.state_family,
    stateScopeKey: primary.state_scope_key,
    worldId: primary.world_id,
    worldFrame: primary.world_frame,
  });
  if (!established || established.id === primary.id) return null;
  const promotionEdge = repository.findEdge({
    agentId: primary.agent_id,
    fromMemoryId: established.id,
    toMemoryId: primary.id,
    relation: "established_from",
  });
  return promotionEdge ? established : null;
}

function currentRepresentationCompletion(repository, primary) {
  if (
    !primary
    || primary.status !== "active"
    || !clean(primary.canonical_key)
    || !clean(primary.subject_role)
    || !clean(primary.subject_key)
    || ["", "not_applicable", "unspecified"].includes(clean(primary.state_family))
    || ["", "not_applicable", "unspecified"].includes(clean(primary.state_scope_key))
    || !STATE_REPRESENTATION_LAYERS.includes(clean(primary.representation_layer))
  ) return null;
  const nodes = STATE_REPRESENTATION_LAYERS
    .map((representationLayer) => repository.getCurrentCanonicalMemory({
      agentId: primary.agent_id,
      subjectRole: primary.subject_role,
      subjectKey: primary.subject_key,
      canonicalKey: primary.canonical_key,
      representationLayer,
      stateFamily: primary.state_family,
      stateScopeKey: primary.state_scope_key,
      worldId: primary.world_id,
      worldFrame: primary.world_frame,
    }))
    .filter(Boolean);
  if (nodes.length < 2 || !nodes.some((node) => node.id === primary.id)) return null;
  return {
    mode: "parallel-current-representations",
    nodes,
  };
}

function stateScopeCompletion(database, primary, eligibleMemoryIds) {
  if (!primary || primary.status !== "active" || !eligibleMemoryIds.has(primary.id)) return null;
  const scopeKey = clean(primary.state_scope_key);
  if (scopeKey === "root") {
    const rows = database.prepare(`
      SELECT exception.*, edge.id AS scope_edge_id
      FROM memory_edges AS edge
      JOIN memory_nodes AS exception
        ON exception.agent_id = edge.agent_id AND exception.id = edge.from_memory_id
      WHERE edge.agent_id = ?
        AND edge.to_memory_id = ?
        AND edge.relation = 'scoped_exception_to'
        AND exception.status = 'active'
        AND exception.state_scope_key LIKE 'scope:%'
        AND exception.subject_role = ?
        AND exception.subject_key = ?
        AND exception.canonical_key = ?
        AND exception.representation_layer = ?
        AND exception.state_family = ?
        AND exception.world_id = ?
        AND exception.world_frame = ?
      ORDER BY COALESCE(exception.valid_from, exception.known_at, exception.recorded_at) DESC,
        exception.updated_at DESC, exception.id ASC
    `).all(
      primary.agent_id,
      primary.id,
      primary.subject_role,
      primary.subject_key,
      primary.canonical_key,
      primary.representation_layer,
      primary.state_family,
      primary.world_id,
      primary.world_frame,
    ).filter((node) => eligibleMemoryIds.has(node.id));
    if (!rows.length) return null;
    return {
      mode: "root-with-exceptions",
      nodes: [primary, ...rows],
      edgeIds: rows.map((row) => row.scope_edge_id),
    };
  }
  if (!/^scope:[0-9a-f]{64}$/u.test(scopeKey)) return null;
  const root = database.prepare(`
    SELECT broad.*, edge.id AS scope_edge_id
    FROM memory_edges AS edge
    JOIN memory_nodes AS broad
      ON broad.agent_id = edge.agent_id AND broad.id = edge.to_memory_id
    WHERE edge.agent_id = ?
      AND edge.from_memory_id = ?
      AND edge.relation = 'scoped_exception_to'
      AND broad.status = 'active'
      AND broad.state_scope_key = 'root'
      AND broad.subject_role = ?
      AND broad.subject_key = ?
      AND broad.canonical_key = ?
      AND broad.representation_layer = ?
      AND broad.state_family = ?
      AND broad.world_id = ?
      AND broad.world_frame = ?
    ORDER BY broad.updated_at DESC, broad.id ASC
  `).all(
    primary.agent_id,
    primary.id,
    primary.subject_role,
    primary.subject_key,
    primary.canonical_key,
    primary.representation_layer,
    primary.state_family,
    primary.world_id,
    primary.world_frame,
  ).find((node) => eligibleMemoryIds.has(node.id));
  if (!root) return null;
  return {
    mode: "exception-with-root",
    nodes: [primary, root],
    edgeIds: [root.scope_edge_id],
  };
}

// State identity, review provenance and lifecycle are core read semantics.
// The caller supplies the eligible nodes from its fixed read snapshot.
export function createStateReadView({ repository, agentId, provisionalNodes = [], eligibleMemoryIds = null }) {
  const eligible = eligibleMemoryIds || { has: () => true };
  const allows = node => Boolean(node && node.agent_id === agentId && eligible.has(node.id));
  const transitions = new Map(provisionalNodes.filter(allows)
    .filter(node => node.metadata?.reportedStateProposalId)
    .map(node => [node.metadata.reportedStateProposalId, node]));
  const closure = reportedStateClosureReader(repository.database, agentId, provisionalNodes);
  const closurePhase = node => allows(node) ? closure(node) : '';
  const currentById = new Map();
  return {
    closurePhase,
    current(primary, options = {}) {
      if (!allows(primary)) return null;
      const key = JSON.stringify([primary.id, Boolean(options.includeClosed)]);
      if (!currentById.has(key)) {
        let node;
        try { node = resolveCurrentState(repository, primary, { ...options, closurePhase }); }
        catch (error) {
          if (error.code !== 'EVENT_SOURCE_TASK_DEFERRED') throw error;
        }
        const transition = transitions.get((node || primary).metadata?.reportedStateTransitionId);
        currentById.set(key, allows(transition) ? transition : allows(node) ? node : null);
      }
      return currentById.get(key);
    },
    representations(primary) {
      if (!allows(primary)) return null;
      const result = currentRepresentationCompletion(repository, primary);
      if (!result) return null;
      const nodes = result.nodes.filter(allows);
      return nodes.length > 1 ? { ...result, nodes } : null;
    },
    scopes(primary) {
      return allows(primary) ? stateScopeCompletion(repository.database, primary, eligible) : null;
    },
  };
}
