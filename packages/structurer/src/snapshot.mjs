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

function containerView(repository, memory, maximumContentChars, maximumMemberIds, sourceView, materialIds) {
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
  for (const member of members) materialIds.add(member.id);
  return {
    ...memoryView(repository, memory, maximumContentChars),
    memberIds: members.map((member) => member.id),
    memberCount: members.length,
    memberIdsTruncated: false,
  };
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
  const characterLimit = Math.min(200_000, Math.max(4_000, Math.trunc(Number(maxSnapshotChars) || 32_000)));
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
  const snapshot = {
    schemaVersion: 1,
    batchId: clean(batchId),
    currentMemories: current.map((memory) => memoryView(repository, memory, perMemoryLimit)),
    candidateContainers: candidateIds.slice(0, containerLimit).map((id) => (
      containerView(repository, repository.getMemory(id), perMemoryLimit, memberLimit, sourceView, materialIds)
    )),
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
