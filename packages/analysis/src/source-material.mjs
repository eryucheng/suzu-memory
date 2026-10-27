import { currentEventSourceExecution, eventSourceMaterial } from '@suzu-memory/core';

export function analysisSystemPrompt(prompt) {
  return `${prompt}\n\nKeep free-text labels, values, claims, and time expressions in the language of each item's direct evidence. Preserve names and quotations. Do not translate English evidence into Chinese. Schema keys and enum values remain unchanged.`;
}

// These are the typed material fields in the specialist snapshots. Resolve
// provenance before calling a generator, including the current-state comparison.
export function analysisSourceMaterial(snapshot) {
  const execution = currentEventSourceExecution();
  if (!execution?.sourceScope) return null;
  return eventSourceMaterial(execution.repository, execution.sourceScope.agentId, [
    ...(snapshot.memories || []).flatMap(memory => [memory.id, ...(memory.episodeIds || [])]),
    ...(snapshot.omitted?.memoriesExcluded || []).map(memory => memory.id),
    ...(snapshot.currentState ? [snapshot.currentState.id] : []),
    ...(snapshot.semanticMemory ? [snapshot.semanticMemory.id] : []),
    ...(snapshot.stateCandidates || []).map(memory => memory.id),
  ], (snapshot.sourceRecords || []).map(source => source.id));
}
