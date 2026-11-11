import { memoryBudgetError } from "./budgeted-parts.mjs";
import {
  BIG_NEURON_KINDS,
  DIRECT_INGESTION_MEMORY_KINDS,
  executionEventSourceView,
  eventSourceMaterial,
  modelCalendarFields,
} from "@suzu-memory/core";

function clean(value) {
  return String(value ?? "").trim();
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function completeLimit(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : Infinity;
}

function completeText(value, maximum, label) {
  const text = String(value ?? "");
  if (text.length > maximum) throw memoryBudgetError(`${label} exceeds the complete ${maximum}-character budget.`);
  return text;
}

function actorView(repository, memoryId) {
  return repository.listMemoryRoles(memoryId).map((role) => ({
    role: role.role,
    actorRole: role.actor_role,
    actorKey: role.actor_key,
    isPrimary: Boolean(role.is_primary),
    confidence: Number(role.confidence),
  }));
}

function entityView(repository, memoryId) {
  return repository.listMemoryEntities(memoryId).map((entity) => ({
    id: entity.id,
    kind: entity.kind,
    name: entity.canonical_name,
    role: entity.link_role,
  }));
}

function memoryView(repository, memory, maximumContentChars) {
  return {
    id: memory.id,
    kind: memory.kind,
    layer: memory.layer,
    title: String(memory.title ?? ""),
    content: completeText(memory.content, maximumContentChars, `Memory ${memory.id}`),
    subjectRole: memory.subject_role,
    subjectKey: memory.subject_key,
    reality: memory.reality,
    worldId: memory.world_id,
    worldFrame: memory.world_frame,
    temporalState: memory.temporal_state,
    ...modelCalendarFields(memory, ['eventDate', 'eventStart', 'eventEnd', 'knownAt'],
      repository.listMemorySources(memory.id)),
    confidence: Number(memory.confidence),
    importance: Number(memory.importance),
    actorRoles: actorView(repository, memory.id),
    entities: entityView(repository, memory.id),
  };
}

function containerView(repository, memory, maximumContentChars, maximumMemberIds, sourceView, materialIds, continuityMemories) {
  const allMembers = memory.kind === "episode"
    ? repository.listEpisodeMembers({
      agentId: memory.agent_id,
      episodeId: memory.id,
      statuses: ["active", "superseded", "disputed", "archived"],
    })
    : repository.listTopicMembers({
      agentId: memory.agent_id,
      topicId: memory.id,
      statuses: ["active", "superseded", "disputed", "archived"],
    });
  const members = allMembers.filter(member => !sourceView || sourceView.allows(member));
  if (members.length > maximumMemberIds) {
    throw memoryBudgetError(`Container ${memory.id} exceeds the complete ${maximumMemberIds}-member budget.`);
  }
  for (const member of members) {
    materialIds.add(member.id);
    continuityMemories.set(member.id, member);
  }
  return {
    ...memoryView(repository, memory, maximumContentChars),
    memberIds: members.map((member) => member.id),
    memberCount: members.length,
    memberIdsTruncated: false,
  };
}

function eventContinuityView(repository, agentId, memories, sourceView) {
  const ids = [...memories.values()].filter(memory => memory.kind === "event"
    && memory.layer !== "provisional" && ["active", "superseded"].includes(memory.status))
    .map(memory => memory.id).sort();
  if (ids.length < 2) return null;
  const selected = JSON.stringify(ids);
  const links = repository.database.prepare(`
    SELECT from_memory_id, to_memory_id, relation,
      json_extract(metadata_json, '$.evidenceSourceIds') AS evidence_source_ids FROM memory_edges
    WHERE agent_id = ? AND from_memory_id IN (SELECT value FROM json_each(?))
      AND to_memory_id IN (SELECT value FROM json_each(?))
      AND relation IN ('same_thread', 'completes', 'cancels', 'corrects')
      AND provenance IN ('event-continuity-v1', 'event-continuity-human-v1')
    ORDER BY from_memory_id, to_memory_id, relation
  `).all(agentId, selected, selected);
  const neighbors = new Map(), transitions = [];
  for (const link of links) {
    if (sourceView) {
      const evidence = JSON.parse(link.evidence_source_ids || "null");
      if (!Array.isArray(evidence) || !evidence.length
        || evidence.some(id => !sourceView.sourceIds.has(id))) continue;
    }
    const from = link.from_memory_id, to = link.to_memory_id;
    if (!neighbors.has(from)) neighbors.set(from, new Set());
    if (!neighbors.has(to)) neighbors.set(to, new Set());
    neighbors.get(from).add(to);
    neighbors.get(to).add(from);
    if (link.relation !== "same_thread") transitions.push({ fromMemoryId: from, toMemoryId: to, relation: link.relation });
  }
  const groups = [], seen = new Set();
  for (const id of ids) {
    if (seen.has(id) || !neighbors.has(id)) continue;
    const members = [id]; seen.add(id);
    for (let index = 0; index < members.length; index++) {
      for (const next of neighbors.get(members[index])) {
        if (!seen.has(next)) { seen.add(next); members.push(next); }
      }
    }
    groups.push(members.sort());
  }
  return groups.length ? { groups, transitions } : null;
}

function checkedMemory(repository, agentId, id, label) {
  const memory = repository.getMemory(id);
  if (!memory || memory.agent_id !== agentId) {
    throw new Error(`${label} memory must exist for the same Agent: ${id}`);
  }
  return memory;
}

export function buildStructureSnapshot({
  repository,
  agentId,
  batchId = "",
  memoryIds = [],
  nearbyContainerIds = [],
  maxMemories = Infinity,
  maxContainers = 12,
  maxMemberIdsPerContainer = Infinity,
  maxContentChars = Infinity,
  maxSnapshotChars = 32_000,
  retrospective = null,
} = {}) {
  if (!repository) throw new Error("Structure snapshot requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Structure snapshot requires agentId.");
  const sourceView = executionEventSourceView(repository, normalizedAgentId);
  const requestedIds = uniqueStrings(memoryIds).filter(id => !sourceView || sourceView.memoryIds.has(id));
  const materialIds = new Set(requestedIds);
  const memoryLimit = completeLimit(maxMemories);
  const containerLimit = Math.min(50, Math.max(0, Math.trunc(Number(maxContainers) || 12)));
  const memberLimit = completeLimit(maxMemberIdsPerContainer);
  const perMemoryLimit = completeLimit(maxContentChars);
  const characterLimit = maxSnapshotChars === Infinity ? Infinity
    : Math.min(200_000, Math.max(4_000, Math.trunc(Number(maxSnapshotChars) || 32_000)));
  const excluded = [];
  const current = [];
  if (requestedIds.length > memoryLimit) {
    throw memoryBudgetError(`Structure snapshot exceeds the complete ${memoryLimit}-memory budget.`);
  }
  for (const id of requestedIds) {
    const memory = checkedMemory(repository, normalizedAgentId, id, "Current batch");
    if (memory.status !== "active" || !DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind)) {
      excluded.push({ id, reason: memory.status !== "active" ? "not-active" : "not-direct-memory" });
      continue;
    }
    current.push(memory);
  }

  const candidateIds = [];
  const addCandidate = (id) => {
    const normalized = clean(id);
    if (sourceView && !sourceView.memoryIds.has(normalized)) return;
    if (normalized && !candidateIds.includes(normalized)) candidateIds.push(normalized);
  };
  for (const id of uniqueStrings(nearbyContainerIds)) {
    const memory = checkedMemory(repository, normalizedAgentId, id, "Nearby container");
    if (memory.status === "active" && BIG_NEURON_KINDS.includes(memory.kind)) addCandidate(id);
  }
  if (current.length && containerLimit) {
    const graph = repository.expand(normalizedAgentId, current.map((memory) => memory.id), {
      maxDepth: 1,
      maxNodes: current.length + containerLimit,
      relations: ["part_of_episode", "supports_topic"],
      allowedMemoryIds: sourceView?.memoryIds,
    });
    for (const memory of graph.nodes) {
      if (memory.status === "active" && BIG_NEURON_KINDS.includes(memory.kind)) addCandidate(memory.id);
    }
    for (const memory of current) {
      for (const entity of repository.listMemoryEntities(memory.id)) {
        for (const related of repository.listEntityMemories({
          agentId: normalizedAgentId,
          entityId: entity.id,
        })) {
          if (related.status === "active" && BIG_NEURON_KINDS.includes(related.kind)) {
            addCandidate(related.id);
          }
          if (candidateIds.length >= containerLimit) break;
        }
        if (candidateIds.length >= containerLimit) break;
      }
      if (candidateIds.length >= containerLimit) break;
    }
    if (candidateIds.length < containerLimit) {
      const relatedGraph = repository.expand(
        normalizedAgentId,
        current.map((memory) => memory.id),
        {
          maxDepth: 1,
          maxNodes: current.length + (containerLimit * 3),
          relations: ["associated_with", "same_thread", "shares_entity"],
          allowedMemoryIds: sourceView?.memoryIds,
        },
      );
      const relatedIds = relatedGraph.nodes
        .filter((memory) => (
          memory.status === "active"
          && !BIG_NEURON_KINDS.includes(memory.kind)
          && !current.some((item) => item.id === memory.id)
        ))
        .map((memory) => memory.id);
      if (relatedIds.length) {
        const containers = repository.expand(normalizedAgentId, relatedIds, {
          maxDepth: 1,
          maxNodes: relatedIds.length + containerLimit,
          relations: ["part_of_episode", "supports_topic"],
          allowedMemoryIds: sourceView?.memoryIds,
        });
        for (const memory of containers.nodes) {
          if (memory.status === "active" && BIG_NEURON_KINDS.includes(memory.kind)) {
            addCandidate(memory.id);
          }
          if (candidateIds.length >= containerLimit) break;
        }
      }
    }
  }

  let retrospectiveContext = null;
  if (retrospective) {
    const triggerMemoryIds = uniqueStrings(retrospective.triggerMemoryIds);
    const historicalMemoryIds = uniqueStrings(retrospective.historicalMemoryIds);
    const currentIds = new Set(current.map((memory) => memory.id));
    if (!triggerMemoryIds.length || !historicalMemoryIds.length
      || [...triggerMemoryIds, ...historicalMemoryIds].some((id) => !currentIds.has(id))
      || triggerMemoryIds.some((id) => historicalMemoryIds.includes(id))) {
      throw new Error("Retrospective structure context must partition current memories into trigger and historical IDs.");
    }
    retrospectiveContext = { triggerMemoryIds, historicalMemoryIds };
  }
  const continuityMemories = new Map(current.map(memory => [memory.id, memory]));
  const candidateContainers = candidateIds.slice(0, containerLimit).map((id) => (
    containerView(repository, repository.getMemory(id), perMemoryLimit, memberLimit, sourceView, materialIds, continuityMemories)
  ));
  const eventContinuity = eventContinuityView(repository, normalizedAgentId, continuityMemories, sourceView);
  const snapshot = {
    schemaVersion: 1,
    batchId: clean(batchId),
    currentMemories: current.map((memory) => memoryView(repository, memory, perMemoryLimit)),
    candidateContainers,
    ...(eventContinuity ? { eventContinuity } : {}),
    retrospectiveContext,
    inputPolicy: {
      includesRawUtterances: false,
      includesSourceRecords: false,
      includesFilesystemPaths: false,
      currentBatchOnly: true,
      candidateContainersAreBounded: true,
    },
    omitted: {
      requestedMemories: requestedIds.length,
      currentMemoriesExcluded: excluded,
      currentMemoriesTruncated: 0,
      candidateContainersTruncated: Math.max(0, candidateIds.length - containerLimit),
    },
  };
  const material = eventSourceMaterial(repository, normalizedAgentId, [...materialIds, ...candidateIds]);
  if (JSON.stringify(snapshot).length > characterLimit) {
    throw memoryBudgetError(`Structure snapshot exceeds the ${characterLimit}-character privacy budget.`);
  }
  if (material) snapshot.sourceMaterial = material;
  return snapshot;
}
