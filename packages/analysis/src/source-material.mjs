import { currentEventSourceExecution, eventSourceMaterial } from '@suzu-memory/core';

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
