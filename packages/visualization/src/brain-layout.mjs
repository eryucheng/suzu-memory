import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  BIG_NEURON_KINDS,
  isStatefulMemoryKind,
} from "@suzu-memory/core";

// 普通节点改为全脑选座；升级布局版本以避免沿用围绕结构父节点聚团的旧缓存位置。
export const BRAIN_LAYOUT_VERSION = "brain-v7";

const STRUCTURAL_RELATIONS = new Set([
  "part_of_episode",
  "supports_topic",
  "about_subject",
  "observed_by",
  "remembered_by",
  "belongs_to_relationship",
  "member_of_relationship",
]);

const RELATION_FAMILIES = Object.freeze({
  part_of_episode: "structural",
  supports_topic: "structural",
  corrects: "lifecycle",
  supersedes: "lifecycle",
  contradicts: "lifecycle",
  scoped_exception_to: "lifecycle",
  established_from: "lifecycle",
  completes: "lifecycle",
  cancels: "lifecycle",
  supported_by: "evidence",
  challenged_by: "evidence",
  causes: "causal",
  timeline_next: "temporal",
  same_thread: "temporal",
  followed_by: "temporal",
  shares_entity: "entity",
  associated_with: "associative",
  about_subject: "actor",
  observed_by: "actor",
  remembered_by: "actor",
  belongs_to_relationship: "relationship",
  member_of_relationship: "relationship",
});

const TOPOLOGY_TABLES = Object.freeze([
  "actor_entity_bindings",
  "relationships",
  "relationship_members",
  "memory_relationship_memberships",
]);

function tableAvailable(database, tableName) {
  return Boolean(database.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(tableName));
}

function clean(value) {
  return String(value ?? "").trim();
}

function topologyNodeId(type) {
  return `topology:${type}`;
}

function topologyTablesAvailable(database) {
  const rows = database.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name IN (${TOPOLOGY_TABLES.map(() => "?").join(", ")})
  `).all(...TOPOLOGY_TABLES);
  return rows.length === TOPOLOGY_TABLES.length;
}

function memoryActorRolesAvailable(database) {
  return tableAvailable(database, "memory_actor_roles");
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bounded(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, finite(value)));
}

function hashUnit(value, salt) {
  const buffer = createHash("sha256").update(`${salt}\u001f${value}`).digest();
  return buffer.readUInt32BE(0) / 0xffffffff;
}

function positionValid(value) {
  return value
    && Number.isFinite(Number(value.x))
    && Number.isFinite(Number(value.y))
    && Number.isFinite(Number(value.z));
}

function roundPosition(value) {
  return {
    x: Math.round(value.x * 10_000) / 10_000,
    y: Math.round(value.y * 10_000) / 10_000,
    z: Math.round(value.z * 10_000) / 10_000,
  };
}

function constrainToBrain(position) {
  const sign = position.x < 0 ? -1 : 1;
  let localX = Math.max(0.08, Math.abs(position.x));
  let y = position.y;
  let z = position.z;
  const normalizedX = (localX - 0.08) / 1.08;
  const normalizedY = y / 0.88;
  const normalizedZ = z / 1.08;
  const distance = Math.sqrt(
    normalizedX * normalizedX
    + normalizedY * normalizedY
    + normalizedZ * normalizedZ,
  );
  if (distance > 0.96) {
    const scale = 0.96 / distance;
    localX = 0.08 + (localX - 0.08) * scale;
    y *= scale;
    z *= scale;
  }
  return { x: sign * localX, y, z };
}

function deterministicPoint(id) {
  const hemisphere = hashUnit(id, "hemisphere") < 0.5 ? -1 : 1;
  const azimuth = hashUnit(id, "azimuth") * Math.PI * 2;
  const vertical = hashUnit(id, "vertical") * 2 - 1;
  const radial = 0.38 + Math.cbrt(hashUnit(id, "radius")) * 0.56;
  const horizontal = Math.sqrt(Math.max(0, 1 - vertical * vertical));
  return constrainToBrain({
    x: hemisphere * (0.1 + Math.abs(Math.cos(azimuth)) * horizontal * radial * 1.08),
    y: vertical * radial * 0.88,
    z: Math.sin(azimuth) * horizontal * radial * 1.08,
  });
}

function majorNodeOrder(left, right) {
  const rank = (node) => {
    const graphNodeType = clean(node.graphNodeType || node.graph_node_type);
    const actorRole = clean(node.actorRole || node.actor_role);
    if (graphNodeType === "actor" && actorRole === "user") return 0;
    if (clean(node.kind) === "episode") return 1;
    if (graphNodeType === "relationship") return 2;
    if (clean(node.kind) === "topic") return 3;
    if (graphNodeType === "actor" && actorRole === "agent") return 4;
    return 5;
  };
  return rank(left) - rank(right)
    || clean(left.title).localeCompare(clean(right.title))
    || left.id.localeCompare(right.id);
}

function majorAnchorPoint(index, total) {
  const count = Math.max(1, total);
  const angle = ((index + 0.5) / count) * Math.PI * 2 + Math.PI * 0.18;
  return constrainToBrain({
    x: Math.cos(angle) * 0.82,
    y: Math.sin(angle) * 0.62,
    z: Math.sin(angle * 1.7 + Math.PI * 0.21) * 0.5,
  });
}

function majorAnchorPositions(nodes) {
  const majors = nodes
    .filter((node) => node.visualTier === "major")
    .sort(majorNodeOrder);
  return new Map(majors.map((node, index) => [
    node.id,
    majorAnchorPoint(index, majors.length),
  ]));
}

function readCache(cachePath, layoutVersion) {
  if (!cachePath || !fs.existsSync(cachePath)) return { positions: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8").replace(/^\uFEFF/u, ""));
    if (parsed.layoutVersion !== layoutVersion || typeof parsed.positions !== "object") {
      return { positions: {} };
    }
    return parsed;
  } catch {
    return { positions: {} };
  }
}

function writeCache(cachePath, value) {
  if (!cachePath) return;
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporary = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, cachePath);
}

export function relationVisualFamily(relation) {
  return RELATION_FAMILIES[clean(relation)] || "associative";
}

export function nodeVisualProfile(node = {}) {
  const graphNodeType = clean(node.graphNodeType || node.graph_node_type);
  if (graphNodeType === "actor") {
    const actorRole = clean(node.actorRole || node.actor_role);
    return {
      visualTier: "major",
      visualFamily: actorRole === "user" ? "user" : actorRole === "agent" ? "agent" : "entity",
    };
  }
  if (graphNodeType === "relationship") {
    return { visualTier: "major", visualFamily: "relationship" };
  }
  const kind = clean(node.kind);
  const stateFamily = clean(node.stateFamily || node.state_family);
  if (BIG_NEURON_KINDS.includes(kind)) {
    return { visualTier: "major", visualFamily: kind };
  }
  if (
    isStatefulMemoryKind(kind)
    || !["", "not_applicable", "unspecified"].includes(stateFamily)
  ) {
    return { visualTier: "state", visualFamily: "state" };
  }
  if (["plan", "commitment", "open_loop"].includes(kind)) {
    return { visualTier: "minor", visualFamily: "intent" };
  }
  if (["fact", "derived_hypothesis"].includes(kind)) {
    return { visualTier: "minor", visualFamily: "knowledge" };
  }
  if (kind === "reflection") {
    return { visualTier: "minor", visualFamily: "reflection" };
  }
  if (kind === "topic_or_episode") {
    return { visualTier: "minor", visualFamily: "legacy" };
  }
  return { visualTier: "minor", visualFamily: "event" };
}

function squaredDistance(left, right) {
  const x = left.x - right.x;
  const y = left.y - right.y;
  const z = left.z - right.z;
  return x * x + y * y + z * z;
}

function distributedSeat(node, positions) {
  const occupied = [...positions.values()];
  const candidateCount = Math.min(48, 24 + Math.ceil(Math.sqrt(occupied.length)));
  let selected = deterministicPoint(`seat:${node.id}:0`);
  let greatestClearance = -1;
  for (let index = 0; index < candidateCount; index += 1) {
    const candidate = deterministicPoint(`seat:${node.id}:${index}`);
    let nearestDistance = Infinity;
    for (const occupiedPosition of occupied) {
      const distance = squaredDistance(candidate, occupiedPosition);
      if (distance < nearestDistance) nearestDistance = distance;
      // Farthest-point sampling: this candidate can no longer beat the current one.
      if (nearestDistance <= greatestClearance) break;
    }
    if (nearestDistance > greatestClearance) {
      selected = candidate;
      greatestClearance = nearestDistance;
    }
  }
  return selected;
}

function initialPositions(nodes, cachedPositions) {
  const positions = new Map();
  const existingIds = new Set();
  for (const node of nodes) {
    const cached = cachedPositions[node.id];
    if (node.isOwner) {
      positions.set(node.id, { x: 0, y: 0, z: 0 });
      if (positionValid(cached)) existingIds.add(node.id);
      continue;
    }
    if (!positionValid(cached)) continue;
    positions.set(node.id, constrainToBrain({
      x: Number(cached.x),
      y: Number(cached.y),
      z: Number(cached.z),
    }));
    existingIds.add(node.id);
  }
  const majorAnchors = majorAnchorPositions(nodes);
  const ordered = [...nodes].sort((left, right) => (
    (left.visualTier === "major" ? 0 : 1) - (right.visualTier === "major" ? 0 : 1)
    || clean(left.eventDate || left.recordedAt).localeCompare(
      clean(right.eventDate || right.recordedAt),
    )
    || left.id.localeCompare(right.id)
  ));
  for (const node of ordered) {
    if (positions.has(node.id)) continue;
    if (node.visualTier === "major") {
      positions.set(node.id, majorAnchors.get(node.id) || deterministicPoint(`major:${node.id}`));
      continue;
    }
    // 结构边只表达关系，不再作为物理牵引，避免每个主题长成一团“爆炸头”。
    positions.set(node.id, distributedSeat(node, positions));
  }
  return { existingIds, positions };
}

export function layoutBrainGraph({
  nodes = [],
  cachePath = "",
  layoutVersion = BRAIN_LAYOUT_VERSION,
} = {}) {
  const profiledNodes = nodes.map((node) => ({
    ...node,
    ...nodeVisualProfile(node),
  }));
  const cache = readCache(cachePath, layoutVersion);
  const { existingIds, positions } = initialPositions(
    profiledNodes,
    cache.positions || {},
  );
  const serialized = Object.fromEntries(profiledNodes.map((node) => [
    node.id,
    roundPosition(positions.get(node.id) || deterministicPoint(node.id)),
  ]));
  writeCache(cachePath, {
    schemaVersion: 2,
    layoutVersion,
    updatedAt: new Date().toISOString(),
    positions: serialized,
  });
  return {
    layoutVersion,
    positions: serialized,
    reused: existingIds.size,
    created: profiledNodes.length - existingIds.size,
  };
}

export function loadStructuredMemoryGraph(repository, agentId) {
  const normalizedAgentId = clean(agentId);
  if (!repository) throw new Error("loadStructuredMemoryGraph 需要 repository。");
  if (!normalizedAgentId) throw new Error("loadStructuredMemoryGraph 需要 agentId。");
  const memoryNodes = repository.database.prepare(`
    SELECT id, kind, layer, title, content, event_date, event_start,
           recorded_at, confidence, importance, status,
           reality, evidence_mode,
           subject_role, subject_key, temporal_state, valid_from, valid_to,
           representation_layer, state_family, state_phase,
           json_extract(metadata_json, '$.structureReviewState') AS structure_review_state,
           json_extract(metadata_json, '$.subjectName') AS subject_name
    FROM memory_nodes
    WHERE agent_id = ? AND status = 'active' AND kind <> 'utterance'
    ORDER BY COALESCE(event_date, event_start, recorded_at), id
  `).all(normalizedAgentId).map((row) => {
    const profile = nodeVisualProfile({ kind: row.kind, stateFamily: row.state_family });
    return {
      id: row.id,
      kind: row.kind,
      layer: row.layer,
      title: clean(row.title) || "未命名记忆",
      preview: clean(row.content).slice(0, 180),
      eventDate: row.event_date || "",
      eventStart: row.event_start || "",
      recordedAt: row.recorded_at || "",
      confidence: finite(row.confidence, 1),
      importance: finite(row.importance, 0.5),
      status: row.status,
      reality: row.reality || "uncertain",
      evidenceMode: row.evidence_mode || "unknown",
      subjectRole: row.subject_role || "unknown",
      subjectKey: row.subject_key || "",
      subjectName: clean(row.subject_name),
      temporalState: row.temporal_state || "unknown",
      validFrom: row.valid_from || "",
      validTo: row.valid_to || "",
      representationLayer: row.representation_layer || "unspecified",
      stateFamily: row.state_family || "not_applicable",
      statePhase: row.state_phase || "not_applicable",
      structureReviewState: clean(row.structure_review_state),
      ...profile,
    };
  });
  const nodes = [...memoryNodes];
  const edges = repository.database.prepare(`
    SELECT edge.id, edge.from_memory_id, edge.to_memory_id,
           edge.relation, edge.direction, edge.weight, edge.confidence
    FROM memory_edges AS edge
    JOIN memory_nodes AS source ON source.id = edge.from_memory_id
    JOIN memory_nodes AS target ON target.id = edge.to_memory_id
    WHERE edge.agent_id = ?
      AND source.status = 'active'
      AND target.status = 'active'
      AND source.kind <> 'utterance'
      AND target.kind <> 'utterance'
    ORDER BY edge.weight DESC, edge.id
  `).all(normalizedAgentId).map((row) => ({
    id: row.id,
    source: row.from_memory_id,
    target: row.to_memory_id,
    relation: row.relation,
    direction: row.direction,
    weight: finite(row.weight, 0.5),
    confidence: finite(row.confidence, 1),
    visualFamily: relationVisualFamily(row.relation),
    structural: STRUCTURAL_RELATIONS.has(row.relation),
  }));
  if (topologyTablesAvailable(repository.database)) {
    const actorBindings = repository.listActorEntityBindings(normalizedAgentId);
    const identityKey = (role, key) => JSON.stringify([clean(role), clean(key)]);
    const bindings = new Map(actorBindings.map(binding => [identityKey(binding.actor_role, binding.actor_key), binding]));
    // Select a stable representative for each confirmed person, independent of memory order.
    const entityBindings = new Map();
    for (const binding of actorBindings) {
      if (!entityBindings.has(binding.entity_id)
        || (binding.actor_role === 'agent' && binding.actor_key === normalizedAgentId)) {
        entityBindings.set(binding.entity_id, binding);
      }
    }
    const actors = new Map();
    const topologyEdgeKeys = new Set();
    function actorNode(role, key, name = '') {
      if (!['user', 'agent', 'other'].includes(role) || !clean(key)) return null;
      const binding = bindings.get(identityKey(role, key));
      const identity = binding ? JSON.stringify(['entity', binding.entity_id]) : JSON.stringify(['actor', role, key]);
      if (actors.has(identity)) return actors.get(identity);
      const representative = binding ? entityBindings.get(binding.entity_id) : null;
      role = representative?.actor_role || role;
      key = representative?.actor_key || key;
      const isOwner = role === 'agent' && key === normalizedAgentId;
      const displayName = clean(representative?.display_name) || clean(name) || (isOwner ? '记忆主体' : '未命名人物');
      const node = { id: isOwner ? topologyNodeId('agent') : topologyNodeId(`actor:${encodeURIComponent(role)}:${encodeURIComponent(key)}`),
        graphNodeType: 'actor', actorRole: role, actorKey: key, entityId: binding?.entity_id || '', isOwner,
        kind: 'actor_entity', layer: 'topology', title: isOwner ? '我' : displayName,
        preview: isOwner ? displayName : `我记忆中的${displayName}：与这个人有关的经历、看法和约定。`,
        confidence: 1, importance: 1, status: 'active' };
      actors.set(identity, node);
      nodes.push(node);
      return node;
    }
    function addTopologyEdge(source, target, relation, confidence = 1) {
      if (!source || !target) return;
      const key = JSON.stringify([source, target, relation]);
      if (topologyEdgeKeys.has(key)) return;
      topologyEdgeKeys.add(key);
      edges.push({ id: `topology:edge:${key}`, source, target, relation, direction: 'directed',
        weight: 0.82, confidence: finite(confidence, 1), visualFamily: relationVisualFamily(relation), structural: true });
    }
    const owner = actorNode('agent', normalizedAgentId);
    const memoryNodeIds = new Set(memoryNodes.map(node => node.id));
    if (memoryActorRolesAvailable(repository.database)) {
      const roles = repository.database.prepare(`
        SELECT role.memory_id, role.actor_role, role.actor_key, role.role, role.confidence,
               json_extract(role.metadata_json, '$.actorName') AS actor_name
        FROM memory_actor_roles AS role
        JOIN memory_nodes AS memory ON memory.id = role.memory_id AND memory.agent_id = role.agent_id
        WHERE role.agent_id = ? AND memory.status = 'active' AND memory.kind <> 'utterance'
        ORDER BY role.memory_id, role.actor_role, role.actor_key, role.role
      `).all(normalizedAgentId);
      for (const role of roles) {
        const actor = actorNode(role.actor_role, role.actor_key, role.actor_name);
        if (actor) addTopologyEdge(role.memory_id, actor.id, role.role === 'observer' ? 'observed_by' : 'about_subject', role.confidence);
      }
    }
    for (const memory of memoryNodes) {
      const actor = actorNode(memory.subjectRole, memory.subjectKey, memory.subjectName);
      if (actor) addTopologyEdge(memory.id, actor.id, 'about_subject');
    }
    const memberships = repository.database.prepare(`
      SELECT membership.memory_id, membership.relationship_id, membership.confidence
      FROM memory_relationship_memberships AS membership
      JOIN memory_nodes AS memory ON memory.id = membership.memory_id AND memory.agent_id = membership.agent_id
      WHERE membership.agent_id = ? AND memory.status = 'active' AND memory.kind <> 'utterance'
      ORDER BY membership.relationship_id, membership.memory_id
    `).all(normalizedAgentId);
    const usedRelationships = new Set(memberships.map(membership => membership.relationship_id));
    for (const relationship of repository.listRelationships(normalizedAgentId)) {
      if (!usedRelationships.has(relationship.id)) continue;
      const members = relationship.members.flatMap(member => actorBindings
        .filter(binding => binding.entity_id === member.entity_id)
        .map(binding => actorNode(binding.actor_role, binding.actor_key, binding.display_name)));
      const memberNodes = [...new Map(members.filter(Boolean).map(node => [node.id, node])).values()];
      // Relationship membership supplies person links, not another visual hub.
      // The same memory node can belong to several people without duplication.
      for (const membership of memberships.filter(item => item.relationship_id === relationship.id)) {
        if (!memoryNodeIds.has(membership.memory_id)) continue;
        for (const member of memberNodes) addTopologyEdge(membership.memory_id, member.id, 'about_subject', membership.confidence);
      }
    }
    // This is a view of the owner's memory, not a claim about social affiliation.
    for (const actor of actors.values()) if (!actor.isOwner) addTopologyEdge(actor.id, owner.id, 'remembered_by');
  }
  for (const node of nodes) {
    Object.assign(node, nodeVisualProfile(node));
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const node of nodes) {
    node.connectionCount = 0;
    node.memberCount = 0;
    node.containerIds = [];
  }
  for (const edge of edges) {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (source) source.connectionCount += 1;
    if (target) target.connectionCount += 1;
    if (edge.structural && source && target?.visualTier === "major" && !source.containerIds.includes(target.id)) {
      source.containerIds.push(target.id);
      target.memberCount += 1;
    }
  }
  return { nodes, edges };
}

export function createBrainSnapshot({
  repository,
  agentId,
  cachePath = "",
  layoutVersion = BRAIN_LAYOUT_VERSION,
} = {}) {
  const graph = loadStructuredMemoryGraph(repository, agentId);
  const layout = layoutBrainGraph({
    nodes: graph.nodes,
    edges: graph.edges,
    cachePath,
    layoutVersion,
  });
  const counts = graph.nodes.reduce((result, node) => {
    result[node.visualTier] += 1;
    return result;
  }, { major: 0, state: 0, minor: 0 });
  return {
    status: "ready",
    generatedAt: new Date().toISOString(),
    layoutVersion,
    nodes: graph.nodes.map((node) => ({
      ...node,
      position: layout.positions[node.id],
    })),
    edges: graph.edges,
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      ...counts,
    },
    layout: {
      reused: layout.reused,
      created: layout.created,
    },
  };
}
