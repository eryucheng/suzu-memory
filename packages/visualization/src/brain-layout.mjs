import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  BIG_NEURON_KINDS,
  isStatefulMemoryKind,
} from "@suzu-memory/core";

// 主题根节点需要跨两侧半球均匀分布；升级布局版本以避免沿用独立哈希造成的单侧缓存位置。
export const BRAIN_LAYOUT_VERSION = "brain-v6";

const STRUCTURAL_RELATIONS = new Set([
  "part_of_episode",
  "supports_topic",
  "about_subject",
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

function deterministicOffset(id, scale = 0.16) {
  return {
    x: (hashUnit(id, "offset-x") * 2 - 1) * scale,
    y: (hashUnit(id, "offset-y") * 2 - 1) * scale,
    z: (hashUnit(id, "offset-z") * 2 - 1) * scale,
  };
}

function semanticPosition(node) {
  const stateFamily = clean(node.stateFamily || node.state_family);
  const semanticType = node.visualTier === "state"
    && !["", "not_applicable", "unspecified"].includes(stateFamily)
    ? `state:${stateFamily}`
    : `kind:${clean(node.kind) || clean(node.visualFamily) || "memory"}`;
  const group = deterministicPoint(`type:${semanticType}`);
  const individual = deterministicPoint(`node:${node.id}`);
  const groupWeight = node.visualTier === "state" ? 0.62 : 0.2;
  const local = deterministicOffset(
    `type-offset:${node.id}`,
    node.visualTier === "state" ? 0.12 : 0.04,
  );
  return constrainToBrain({
    x: group.x * groupWeight + individual.x * (1 - groupWeight) + local.x,
    y: group.y * groupWeight + individual.y * (1 - groupWeight) + local.y,
    z: group.z * groupWeight + individual.z * (1 - groupWeight) + local.z,
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

function adjacencyFor(nodes, edges) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const value = {
      id: edge.id,
      relation: edge.relation,
      visualFamily: edge.visualFamily || relationVisualFamily(edge.relation),
      structural: Boolean(edge.structural || STRUCTURAL_RELATIONS.has(edge.relation)),
      weight: bounded(edge.weight, 0, 1),
    };
    adjacency.get(edge.source).push({ ...value, neighborId: edge.target });
    adjacency.get(edge.target).push({ ...value, neighborId: edge.source });
  }
  return adjacency;
}

function averagePositions(values) {
  return values.reduce((result, value) => ({
    x: result.x + value.x / values.length,
    y: result.y + value.y / values.length,
    z: result.z + value.z / values.length,
  }), { x: 0, y: 0, z: 0 });
}

function initialPositions(nodes, edges, cachedPositions) {
  const positions = new Map();
  const existingIds = new Set();
  for (const node of nodes) {
    const cached = cachedPositions[node.id];
    if (!positionValid(cached)) continue;
    positions.set(node.id, constrainToBrain({
      x: Number(cached.x),
      y: Number(cached.y),
      z: Number(cached.z),
    }));
    existingIds.add(node.id);
  }
  const adjacency = adjacencyFor(nodes, edges);
  const majorAnchors = majorAnchorPositions(nodes);
  const structuralContainers = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (!STRUCTURAL_RELATIONS.has(edge.relation)) continue;
    structuralContainers.get(edge.source)?.push(edge.target);
  }
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
    const containerPositions = (structuralContainers.get(node.id) || [])
      .map((id) => positions.get(id))
      .filter(Boolean);
    const neighborPositions = adjacency.get(node.id)
      .map((value) => positions.get(value.neighborId))
      .filter(Boolean);
    const anchors = containerPositions.length ? containerPositions : neighborPositions;
    if (!anchors.length) {
      positions.set(node.id, semanticPosition(node));
      continue;
    }
    const center = averagePositions(anchors);
    const offset = deterministicOffset(node.id, containerPositions.length ? 0.13 : 0.17);
    positions.set(node.id, constrainToBrain({
      x: center.x + offset.x,
      y: center.y + offset.y,
      z: center.z + offset.z,
    }));
  }
  return { adjacency, existingIds, positions };
}

function relaxNewPositions(nodes, adjacency, positions, existingIds) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const movableIds = nodes
    .filter((node) => node.visualTier !== "major" && !existingIds.has(node.id))
    .map((node) => node.id);
  if (!movableIds.length) return;
  const iterations = existingIds.size ? 22 : 72;
  const allIds = nodes.map((node) => node.id);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const changes = new Map();
    for (const id of movableIds) {
      const point = positions.get(id);
      let dx = 0;
      let dy = 0;
      let dz = 0;
      for (const edge of adjacency.get(id)) {
        const neighbor = positions.get(edge.neighborId);
        if (!neighbor) continue;
        const pull = edge.structural
          ? 0.095 + edge.weight * 0.055
          : 0.018 + edge.weight * 0.024;
        dx += (neighbor.x - point.x) * pull;
        dy += (neighbor.y - point.y) * pull;
        dz += (neighbor.z - point.z) * pull;
      }
      for (const otherId of allIds) {
        if (otherId === id) continue;
        const other = positions.get(otherId);
        const x = point.x - other.x;
        const y = point.y - other.y;
        const z = point.z - other.z;
        const distanceSquared = x * x + y * y + z * z;
        if (distanceSquared <= 0.0001 || distanceSquared >= 0.075) continue;
        const otherTier = nodeById.get(otherId)?.visualTier;
        const repulsion = (otherTier === "major" ? 0.0009 : 0.00135) / distanceSquared;
        dx += x * repulsion;
        dy += y * repulsion;
        dz += z * repulsion;
      }
      const magnitude = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz) / 0.052);
      changes.set(id, constrainToBrain({
        x: point.x + dx / magnitude,
        y: point.y + dy / magnitude,
        z: point.z + dz / magnitude,
      }));
    }
    for (const [id, position] of changes) positions.set(id, position);
  }
}

export function layoutBrainGraph({
  nodes = [],
  edges = [],
  cachePath = "",
  layoutVersion = BRAIN_LAYOUT_VERSION,
} = {}) {
  const profiledNodes = nodes.map((node) => ({
    ...node,
    ...nodeVisualProfile(node),
  }));
  const cache = readCache(cachePath, layoutVersion);
  const { adjacency, existingIds, positions } = initialPositions(
    profiledNodes,
    edges,
    cache.positions || {},
  );
  relaxNewPositions(profiledNodes, adjacency, positions, existingIds);
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
           json_extract(metadata_json, '$.structureReviewState') AS structure_review_state
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
    const actorBindings = repository.database.prepare(`
      SELECT actor_role, actor_key, display_name
      FROM actor_entity_bindings
      WHERE agent_id = ?
      ORDER BY actor_role ASC, actor_key ASC
    `).all(normalizedAgentId);
    const user = actorBindings.find((binding) => clean(binding.actor_role) === "user");
    const agent = actorBindings.find((binding) => (
      clean(binding.actor_role) === "agent"
      && clean(binding.actor_key) === normalizedAgentId
    )) || actorBindings.find((binding) => clean(binding.actor_role) === "agent");
    const relationships = repository.database.prepare(`
      SELECT id, label,
             json_extract(metadata_json, '$.companionActorKey') AS companion_actor_key
      FROM relationships
      WHERE agent_id = ? AND status = 'active'
      ORDER BY updated_at DESC, id ASC
    `).all(normalizedAgentId);
    const primaryRelationship = relationships.find((relationship) => (
      clean(relationship.companion_actor_key) === normalizedAgentId
    )) || relationships[0] || null;
    const roots = {
      user: user ? topologyNodeId("user") : "",
      agent: agent ? topologyNodeId("agent") : "",
      relationship: primaryRelationship ? topologyNodeId("relationship") : "",
    };
    const userName = clean(user?.display_name) || "当前用户";
    const agentName = clean(agent?.display_name) || "当前 Agent";
    if (roots.user) {
      nodes.push({
        id: roots.user,
        graphNodeType: "actor",
        actorRole: "user",
        kind: "actor_entity",
        layer: "topology",
        title: "我",
        preview: userName,
        confidence: 1,
        importance: 1,
        status: "active",
      });
    }
    if (roots.agent) {
      nodes.push({
        id: roots.agent,
        graphNodeType: "actor",
        actorRole: "agent",
        kind: "actor_entity",
        layer: "topology",
        title: "Agent",
        preview: agentName,
        confidence: 1,
        importance: 1,
        status: "active",
      });
    }
    if (roots.relationship) {
      nodes.push({
        id: roots.relationship,
        graphNodeType: "relationship",
        kind: "relationship_context",
        layer: "topology",
        title: clean(primaryRelationship.label) || "关系",
        preview: `${userName} 与 ${agentName}`,
        confidence: 1,
        importance: 1,
        status: "active",
      });
    }

    const memoryNodeIds = new Set(memoryNodes.map((node) => node.id));
    const actorRootByRole = {
      user: roots.user,
      agent: roots.agent,
    };
    const topologyEdgeKeys = new Set();
    const addTopologyEdge = ({
      id,
      source,
      target,
      relation,
      weight = 0.82,
      confidence = 1,
    }) => {
      if (!source || !target) return false;
      const key = `${source}\u001f${target}\u001f${relation}`;
      if (topologyEdgeKeys.has(key)) return false;
      topologyEdgeKeys.add(key);
      edges.push({
        id,
        source,
        target,
        relation,
        direction: "directed",
        weight,
        confidence,
        visualFamily: relationVisualFamily(relation),
        structural: true,
      });
      return true;
    };

    // `subject_role` 只能表达一个主语。新版抽取还会保存说话者、参与者、经历者等
    // `memory_actor_roles`；大脑里的“我 / Agent / 关系”应按这些真实角色连线，
    // 而不是退回旧的实体关联表或凭固定身份造关联。
    const roleRootsByMemory = new Map();
    const sharedRoleMemoryIds = new Set();
    if (memoryActorRolesAvailable(repository.database)) {
      const actorRoles = repository.database.prepare(`
        SELECT role.memory_id, role.actor_role, role.confidence
        FROM memory_actor_roles AS role
        JOIN memory_nodes AS memory
          ON memory.id = role.memory_id
         AND memory.agent_id = role.agent_id
        WHERE role.agent_id = ?
          AND memory.status = 'active'
          AND memory.kind <> 'utterance'
        ORDER BY role.memory_id, role.actor_role, role.role, role.is_primary DESC
      `).all(normalizedAgentId);
      for (const actorRole of actorRoles) {
        if (!memoryNodeIds.has(actorRole.memory_id)) continue;
        const normalizedActorRole = clean(actorRole.actor_role);
        if (normalizedActorRole === "shared") {
          sharedRoleMemoryIds.add(actorRole.memory_id);
          continue;
        }
        const rootId = actorRootByRole[normalizedActorRole];
        if (!rootId) continue;
        const rootIds = roleRootsByMemory.get(actorRole.memory_id) || new Set();
        rootIds.add(rootId);
        roleRootsByMemory.set(actorRole.memory_id, rootIds);
        addTopologyEdge({
          id: `topology:actor-role:${actorRole.memory_id}:${rootId}`,
          source: actorRole.memory_id,
          target: rootId,
          relation: "about_subject",
          weight: 0.82,
          confidence: finite(actorRole.confidence, 1),
        });
      }
    }
    for (const memory of memoryNodes) {
      const subjectRole = clean(memory.subjectRole);
      if (subjectRole === "shared") {
        sharedRoleMemoryIds.add(memory.id);
        continue;
      }
      const rootId = actorRootByRole[subjectRole];
      // 旧库没有角色表、或者新版记录没有可用角色时，仍保留旧主语映射。
      if (rootId && !roleRootsByMemory.get(memory.id)?.has(rootId)) {
        addTopologyEdge({
          id: `topology:subject:${memory.id}:${rootId}`,
          source: memory.id,
          target: rootId,
          relation: "about_subject",
        });
      }
    }

    if (roots.relationship) {
      const relationshipMemberships = repository.database.prepare(`
        SELECT membership.memory_id, membership.membership_type,
               membership.confidence
        FROM memory_relationship_memberships AS membership
        JOIN memory_nodes AS memory
          ON memory.id = membership.memory_id
         AND memory.agent_id = membership.agent_id
        JOIN relationships AS relationship
          ON relationship.id = membership.relationship_id
         AND relationship.agent_id = membership.agent_id
        WHERE membership.agent_id = ?
          AND memory.status = 'active'
          AND memory.kind <> 'utterance'
          AND relationship.status = 'active'
        ORDER BY membership.relationship_id, membership.memory_id, membership.membership_type
      `).all(normalizedAgentId);
      const relationshipMemoryIds = new Set();
      for (const memoryId of sharedRoleMemoryIds) {
        relationshipMemoryIds.add(memoryId);
        addTopologyEdge({
          id: `topology:relationship-shared:${memoryId}`,
          source: memoryId,
          target: roots.relationship,
          relation: "belongs_to_relationship",
          weight: 0.82,
        });
      }
      // 同一条记忆同时涉及用户与 Agent 时，它本身就是这段关系的内容。
      // 这条边来自真实角色记录，补足尚未跑到关系成员同步的新版数据。
      for (const [memoryId, rootIds] of roleRootsByMemory) {
        if (!rootIds.has(roots.user) || !rootIds.has(roots.agent)) continue;
        relationshipMemoryIds.add(memoryId);
        addTopologyEdge({
          id: `topology:relationship-roles:${memoryId}`,
          source: memoryId,
          target: roots.relationship,
          relation: "belongs_to_relationship",
          weight: 0.82,
        });
      }
      for (const membership of relationshipMemberships) {
        if (!memoryNodeIds.has(membership.memory_id)) continue;
        relationshipMemoryIds.add(membership.memory_id);
        addTopologyEdge({
          id: `topology:relationship:${membership.memory_id}`,
          source: membership.memory_id,
          target: roots.relationship,
          relation: "belongs_to_relationship",
          weight: finite(membership.confidence, 1),
          confidence: finite(membership.confidence, 1),
        });
      }
      for (const memory of memoryNodes) {
        if (
          relationshipMemoryIds.has(memory.id)
          || (clean(memory.kind) !== "relationship" && clean(memory.stateFamily) !== "relationship")
        ) continue;
        addTopologyEdge({
          id: `topology:relationship-state:${memory.id}`,
          source: memory.id,
          target: roots.relationship,
          relation: "belongs_to_relationship",
        });
      }

      const memberRoles = new Set(primaryRelationship
        ? repository.database.prepare(`
          SELECT binding.actor_role
          FROM relationship_members AS member
          JOIN actor_entity_bindings AS binding
            ON binding.agent_id = member.agent_id
           AND binding.entity_id = member.entity_id
          WHERE member.agent_id = ? AND member.relationship_id = ?
        `).all(normalizedAgentId, primaryRelationship.id).map((row) => clean(row.actor_role))
        : []);
      for (const actorRole of memberRoles) {
        const rootId = actorRootByRole[actorRole];
        if (!rootId || actorRole === "shared") continue;
        addTopologyEdge({
          id: `topology:relationship-member:${actorRole}`,
          source: rootId,
          target: roots.relationship,
          relation: "member_of_relationship",
          weight: 1,
          confidence: 1,
        });
      }
    }
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
    if (edge.structural && source && target?.visualTier === "major") {
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
