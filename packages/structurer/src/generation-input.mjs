import { isDeepStrictEqual } from 'node:util';
import { withModelReferences } from '@suzu-memory/core';
import { memoryBudgetError } from './budgeted-parts.mjs';

export const STRUCTURE_REQUEST_CHARACTERS = 32_000;
export const RELATION_REQUEST_CHARACTERS = 48_000;

export function structureGenerationMaterial(snapshot) {
  const memories = snapshot.currentMemories;
  const ids = new Set(memories.map(memory => memory.id));
  return { memories, candidateContainers: snapshot.candidateContainers.map(container => {
    const members = new Set(container.memberIds);
    const { memberIdsTruncated, ...view } = container;
    return { ...view, memberIds: container.memberIds.filter(id => ids.has(id)),
      addableMemberIds: memories.filter(memory => !members.has(memory.id)).map(memory => memory.id) };
  }), ...(snapshot.eventContinuity ? { eventContinuity: snapshot.eventContinuity } : {}),
  retrospectiveContext: snapshot.retrospectiveContext };
}

export function mergeGenerationMaterials(materials) {
  const result = {}, memories = new Map();
  for (const material of materials) {
    for (const memory of material.memories) {
      const merged = memories.get(memory.id) || {};
      for (const [key, value] of Object.entries(memory)) {
        if (Object.hasOwn(merged, key) && !isDeepStrictEqual(merged[key], value)) {
          throw new Error(`Organization inputs disagree on memory field ${key}.`);
        }
        merged[key] = value;
      }
      memories.set(memory.id, merged);
    }
    for (const [key, value] of Object.entries(material)) {
      if (key === 'memories') continue;
      if (Object.hasOwn(result, key) && !isDeepStrictEqual(result[key], value)) {
        throw new Error(`Organization inputs disagree on ${key}.`);
      }
      result[key] = value;
    }
  }
  return { memories: [...memories.values()], ...result };
}

const referenceFields = new Set(['id', 'memberIds', 'addableMemberIds', 'sourceIds', 'evidenceSourceIds',
  'triggerMemoryIds', 'historicalMemoryIds', 'fromMemoryId', 'toMemoryId', 'targetMemoryId', 'groups']);

function historicalMaterialFirst({ memories, sourceRecords, ...context }) {
  const historicalIds = new Set(context.retrospectiveContext.historicalMemoryIds);
  const historicalMemories = memories.filter(memory => historicalIds.has(memory.id));
  // A source cited by both sides keeps its place in the historical material.
  const sourceIds = new Set(historicalMemories.flatMap(memory => memory.sourceIds));
  const sources = new Map(sourceRecords.map(source => [source.id, source]));
  return {
    historicalMaterial: {
      memories: historicalMemories,
      sourceRecords: [...sourceIds].map(id => sources.get(id)).filter(Boolean),
    },
    memories: memories.filter(memory => !historicalIds.has(memory.id)),
    sourceRecords: sourceRecords.filter(source => !sourceIds.has(source.id)),
    ...context,
  };
}

/** Canonical IDs stay in the application contract. Only the model wire uses local references. */
export function withGenerationReferences(request, { historicalPrefix = false } = {}) {
  const material = JSON.parse(request.input);
  const input = historicalPrefix ? historicalMaterialFirst(material) : material;
  // Number historical rows before part-specific rows so they can share a prefix.
  const rows = [...(input.historicalMaterial?.memories || []), ...(input.historicalMaterial?.sourceRecords || []),
    ...input.memories, ...(input.candidateContainers || []), ...(input.sourceRecords || [])];
  const ids = [
    ...rows.flatMap(row => [row.id, ...(row.entities || []).map(entity => entity.id)]),
    ...(input.eventContinuity?.groups || []).flat(),
    ...(input.eventContinuity?.transitions || []).flatMap(({ fromMemoryId, toMemoryId }) => [fromMemoryId, toMemoryId]),
  ];
  return withModelReferences(request, { material: input, fields: referenceFields, ids });
}

export function assertGenerationRequestBudget(request, maximumCharacters, generator) {
  if (maximumCharacters !== Infinity && (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 1)) {
    throw new Error('maximumRequestCharacters must be a positive safe integer.');
  }
  if (maximumCharacters !== Infinity) {
    const characters = generator?.measureRequest ? generator.measureRequest(request)
      : request.input.length + request.systemPrompt.length + JSON.stringify(request.schema).length;
    if (characters > maximumCharacters) {
      throw memoryBudgetError(`Complete organization request (${characters} characters) exceeds the ${maximumCharacters}-character budget.`);
    }
  }
  generator?.assertRequestBudget?.(request);
}
