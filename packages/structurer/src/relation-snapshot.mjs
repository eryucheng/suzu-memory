import { memoryBudgetError } from "./budgeted-parts.mjs";
import { DIRECT_INGESTION_MEMORY_KINDS, executionEventSourceView, eventSourceMaterial, modelCalendarFields } from "@suzu-memory/core";

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

export function buildRelationSnapshot({
  repository,
  agentId,
  batchId = "",
  memoryIds = [],
  maxMemories = Infinity,
  maxSourcesPerMemory = Infinity,
  maxMemoryContentChars = Infinity,
  maxSourceContentChars = Infinity,
  maxSnapshotChars = 48_000,
  retrospective = null,
} = {}) {
  if (!repository) throw new Error("Relation snapshot requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Relation snapshot requires agentId.");
  const sourceView = executionEventSourceView(repository, normalizedAgentId);
  const requestedIds = uniqueStrings(memoryIds).filter(id => !sourceView || sourceView.memoryIds.has(id));
  const memoryLimit = completeLimit(maxMemories);
  const sourceLimit = completeLimit(maxSourcesPerMemory);
  const memoryCharLimit = completeLimit(maxMemoryContentChars);
  const sourceCharLimit = completeLimit(maxSourceContentChars);
  const snapshotCharLimit = Math.min(250_000, Math.max(4_000, Math.trunc(Number(maxSnapshotChars) || 48_000)));
  const sourceRecords = new Map();
  const excluded = [];
  const memories = [];
  if (requestedIds.length > memoryLimit) {
    throw memoryBudgetError(`Relation snapshot exceeds the complete ${memoryLimit}-memory budget.`);
  }
  for (const id of requestedIds) {
    const memory = repository.getMemory(id);
    if (!memory || memory.agent_id !== normalizedAgentId) {
      throw new Error(`Relation snapshot memory must exist for the same Agent: ${id}`);
    }
    if (memory.status !== "active" || !DIRECT_INGESTION_MEMORY_KINDS.includes(memory.kind)) {
      excluded.push({ id, reason: memory.status !== "active" ? "not-active" : "not-direct-memory" });
      continue;
    }
    const detail = repository.getMemoryDetail(normalizedAgentId, id);
    const sources = detail.sources.filter(source => !sourceView || sourceView.sourceIds.has(source.id));
    if (sources.length > sourceLimit) {
      throw memoryBudgetError(`Relation snapshot memory ${id} exceeds the complete ${sourceLimit}-source budget.`);
    }
    for (const source of sources) {
      if (!sourceRecords.has(source.id)) {
        sourceRecords.set(source.id, {
          id: source.id,
          sourceKind: source.source_kind,
          ...modelCalendarFields(source, ['occurredAt', 'knownAt', 'recordedAt']),
          speaker: source.speaker,
          content: completeText(source.content, sourceCharLimit, `Source ${source.id}`),
        });
      }
    }
    memories.push({
      id: memory.id,
      kind: memory.kind,
      layer: memory.layer,
      title: String(memory.title ?? ""),
      content: completeText(memory.content, memoryCharLimit, `Memory ${memory.id}`),
      subjectRole: memory.subject_role,
      subjectKey: memory.subject_key,
      reality: memory.reality,
      worldId: memory.world_id,
      worldFrame: memory.world_frame,
      temporalState: memory.temporal_state,
      ...modelCalendarFields(memory, ['eventDate', 'eventStart', 'eventEnd', 'knownAt'], sources),
      sourceIds: sources.map((source) => source.id),
      sourcesTruncated: false,
    });
  }
  let retrospectiveContext = null;
  if (retrospective) {
    const triggerMemoryIds = uniqueStrings(retrospective.triggerMemoryIds);
    const historicalMemoryIds = uniqueStrings(retrospective.historicalMemoryIds);
    const currentIds = new Set(memories.map((memory) => memory.id));
    if (!triggerMemoryIds.length || !historicalMemoryIds.length
      || [...triggerMemoryIds, ...historicalMemoryIds].some((id) => !currentIds.has(id))
      || triggerMemoryIds.some((id) => historicalMemoryIds.includes(id))) {
      throw new Error("Retrospective relation context must partition snapshot memories into trigger and historical IDs.");
    }
    retrospectiveContext = { triggerMemoryIds, historicalMemoryIds };
  }
  const snapshot = {
    schemaVersion: 1,
    batchId: clean(batchId),
    memories,
    sourceRecords: [...sourceRecords.values()],
    retrospectiveContext,
    inputPolicy: {
      candidateEndpointsAreBounded: true,
      sourceIdsMustAlreadySupportAnEndpoint: true,
      includesFilesystemPaths: false,
      includesSourceMetadata: false,
      modelCannotWriteEdges: true,
    },
    omitted: {
      requestedMemories: requestedIds.length,
      memoriesExcluded: excluded,
      memoriesTruncated: 0,
    },
  };
  const material = eventSourceMaterial(repository, normalizedAgentId, requestedIds, [...sourceRecords.keys()]);
  if (JSON.stringify(snapshot).length > snapshotCharLimit) {
    throw memoryBudgetError(`Relation snapshot exceeds the ${snapshotCharLimit}-character privacy budget.`);
  }
  if (material) snapshot.sourceMaterial = material;
  return snapshot;
}
