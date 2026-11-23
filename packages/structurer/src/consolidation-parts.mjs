// Each part owns a bipartite comparison and, optionally, the pairs within its
// anchor set. The same scope is persisted, sent to the model and validated.
const relationContext = (anchorMemoryIds, candidateMemoryIds, includeAnchorPairs) =>
  ({ anchorMemoryIds, candidateMemoryIds, includeAnchorPairs });

export function consolidationProgress(run) {
  const saved = run.metadata.organizationProgress;
  if (!saved) return { pairCoverageVersion: 1, parts: [{ id: run.id, status: 'pending',
    organizeNewMemories: run.metadata.organizationMode === 'unified-v1',
    relationContext: relationContext(run.triggerIds, run.candidateIds, true) }] };
  if (saved.pairCoverageVersion === 1) return saved;
  // Previous releases covered only new/old pairs. Preserve all their results;
  // give the missing within-batch comparisons a separate, resumable part.
  const parts = saved.parts.map(({ memoryIds, historicalIds = [], ...part }) => ({ ...part,
    relationContext: relationContext(memoryIds, historicalIds, false) }));
  if (run.triggerIds.length >= 2) parts.push({ id: `${run.id}.within-batch`, status: 'pending',
    relationContext: relationContext(run.triggerIds, [], true) });
  return { ...saved, pairCoverageVersion: 1, parts };
}

export function structureContextForPart(part, run) {
  const { anchorMemoryIds, candidateMemoryIds } = part.relationContext;
  if (run.metadata.organizationMode === 'unified-v1') return {
    triggerMemoryIds: anchorMemoryIds, historicalMemoryIds: candidateMemoryIds,
    ...(part.relationContext.includeAnchorPairs ? { includeTriggerPairs: true } : {}),
  };
  return candidateMemoryIds.length && candidateMemoryIds.every(id => run.candidateIds.includes(id))
    ? { triggerMemoryIds: anchorMemoryIds, historicalMemoryIds: candidateMemoryIds } : null;
}

export function sharesAnchorPrefix(part, parts) {
  if (!/\.[01]$/u.test(part.id)) return false;
  const parent = parts.find(item => item.id === part.id.slice(0, -2));
  const scope = part.relationContext, previous = parent?.relationContext;
  return Boolean(previous && scope.candidateMemoryIds.length < previous.candidateMemoryIds.length
    && scope.anchorMemoryIds.length === previous.anchorMemoryIds.length
    && scope.anchorMemoryIds.every((id, index) => id === previous.anchorMemoryIds[index]));
}

export function partitionConsolidationPart(part) {
  const scope = part.relationContext;
  const { anchorMemoryIds, candidateMemoryIds, includeAnchorPairs } = scope;
  const field = candidateMemoryIds.length > anchorMemoryIds.length ? 'candidateMemoryIds' : 'anchorMemoryIds';
  const ids = scope[field];
  if (ids.length < 2) return [];
  const coveredOutputs = [...new Set([...(part.coveredOutputs || []),
    ...['structure', 'relations'].filter(key => part[key]
      && !['capacity-reached', 'partial-failure'].includes(part[key].status))])];
  const { structure, relations, result, error, errorCode, providerDiagnostics, ...base } = part;
  const middle = Math.ceil(ids.length / 2);
  const children = [ids.slice(0, middle), ids.slice(middle)].map((members, index) => ({ ...base,
    id: `${part.id}.${index}`, status: 'pending', coveredOutputs,
    relationContext: { ...scope, [field]: members,
      includeAnchorPairs: includeAnchorPairs && (field === 'anchorMemoryIds' || index === 0) },
  }));
  if (includeAnchorPairs && field === 'anchorMemoryIds'
    && (!coveredOutputs.includes('relations') || (part.organizeNewMemories && !coveredOutputs.includes('structure')))) {
    // Internal pairs on either side stay in the ordinary children. Only the
    // pairs cut by this partition need another comparison, in both directions.
    children.push({ id: `${part.id}.cross`, status: 'pending',
      organizeNewMemories: part.organizeNewMemories,
      coveredOutputs,
      relationContext: relationContext(ids.slice(0, middle), ids.slice(middle), false),
      requiresFullRelationEvidence: part.requiresFullRelationEvidence });
  }
  return children;
}
