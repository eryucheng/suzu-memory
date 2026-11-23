import { isDeepStrictEqual } from 'node:util';
import { withModelReferences, memoryWorldsCompatible } from '@suzu-memory/core';
import { memoryBudgetError } from './budgeted-parts.mjs';
import { organizationModelSchema, organizationSelectionScope, decodeOrganizationSelections } from './model-schema.mjs';

export const STRUCTURE_REQUEST_CHARACTERS = 32_000;
export const RELATION_REQUEST_CHARACTERS = 48_000;

export function structureGenerationMaterial(snapshot) {
  const memories = snapshot.currentMemories;
  const ids = new Set(memories.map(memory => memory.id));
  return { memories, candidateContainers: snapshot.candidateContainers.map(container => {
    const members = new Set(container.memberIds);
    const { memberIdsTruncated, ...view } = container;
    return { ...view, memberIds: container.memberIds.filter(id => ids.has(id)),
      addableMemberIds: memories.filter(memory => !members.has(memory.id) && memoryWorldsCompatible(container, memory))
        .map(memory => memory.id) };
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
  'triggerMemoryIds', 'historicalMemoryIds', 'firstMemberId', 'secondMemberId', 'additionalMemberIds', 'anchorMemoryIds', 'candidateMemoryIds',
  'anchorMemoryId', 'relatedMemoryId', 'fromMemoryId', 'toMemoryId', 'targetMemoryId', 'groups']);

function sharedMaterialFirst({ memories, sourceRecords, ...context }, sharedNewFirst) {
  const historicalIds = new Set(context.retrospectiveContext.historicalMemoryIds);
  const historicalMemories = memories.filter(memory => historicalIds.has(memory.id));
  const newMemories = memories.filter(memory => !historicalIds.has(memory.id));
  const leadingMemories = sharedNewFirst ? newMemories : historicalMemories;
  // Give sources cited by both sides a single place in the shared material.
  const sourceIds = new Set(leadingMemories.flatMap(memory => memory.sourceIds));
  const sources = new Map(sourceRecords.map(source => [source.id, source]));
  const leadingSources = [...sourceIds].map(id => sources.get(id)).filter(Boolean);
  const remainingSources = sourceRecords.filter(source => !sourceIds.has(source.id));
  if (sharedNewFirst) return {
    memories: newMemories, sourceRecords: leadingSources,
    historicalMaterial: { memories: historicalMemories, sourceRecords: remainingSources },
    ...context,
  };
  return {
    historicalMaterial: { memories: historicalMemories, sourceRecords: leadingSources },
    memories: newMemories,
    sourceRecords: remainingSources,
    ...context,
  };
}

/** Canonical IDs stay in the application contract. Only the model wire uses local references. */
export function withGenerationReferences(request, { historicalPrefix = false, sharedNewFirst = false, selectionInBody = false } = {}) {
  const material = JSON.parse(request.input);
  const input = historicalPrefix ? sharedMaterialFirst(material, sharedNewFirst) : material;
  const history = [...(input.historicalMaterial?.memories || []), ...(input.historicalMaterial?.sourceRecords || [])];
  // Number the actual shared rows before any rows specific to the part.
  const rows = historicalPrefix && sharedNewFirst
    ? [...input.memories, ...input.sourceRecords, ...history, ...(input.candidateContainers || [])]
    : [...history, ...input.memories, ...(input.candidateContainers || []), ...(input.sourceRecords || [])];
  const ids = [
    ...rows.flatMap(row => [row.id, ...(row.entities || []).map(entity => entity.id)]),
    ...(input.eventContinuity?.groups || []).flat(),
    ...(input.eventContinuity?.transitions || []).flatMap(({ fromMemoryId, toMemoryId }) => [fromMemoryId, toMemoryId]),
  ];
  const referenced = withModelReferences(request, { material: input, fields: referenceFields, ids });
  const modelSchemaTemplate = request.modelSchema || request.schema;
  const modelMaterial = JSON.parse(referenced.modelInput);
  const selectionScope = organizationSelectionScope(request.schemaName, modelMaterial);
  if (modelMaterial.candidateContainers) modelMaterial.candidateContainers = modelMaterial.candidateContainers
    .map(({ addableMemberIds, ...container }) => container);
  delete modelMaterial.retrospectiveContext;
  delete modelMaterial.relationContext;
  if (selectionInBody) {
    modelMaterial.selectionScope = selectionScope;
    return { ...referenced, modelSchemaTemplate, modelSchema: modelSchemaTemplate, modelInput: JSON.stringify(modelMaterial),
      decodeOutput: output => decodeOrganizationSelections(output, selectionScope, referenced.decodeOutput, request.schemaName) };
  }
  return { ...referenced, modelSchemaTemplate,
    modelInput: JSON.stringify(modelMaterial), modelSchema: organizationModelSchema(modelSchemaTemplate, request.schemaName, selectionScope) };
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
