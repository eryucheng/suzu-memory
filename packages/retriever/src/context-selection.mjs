import { selectConvergedSeeds, followMemoryChain } from './memory-chain.mjs';
import { fuseCandidateLanes, normalizedEvidenceLimit } from './candidate-selection.mjs';
import { selectRankedContext } from './ranked-context.mjs';
import { isProvisionalMemory, isStructuredStateMemory } from '@suzu-memory/core';

/** All searches use the same evidence selection, including anchored follow-ups. */
export function selectRetrievalContext({ database, agentId, primaryCandidate, candidates,
  convergenceCandidates, eligibleMemoryIds, plasticityPolicy, preparedQuery, scoreLexical,
  embeddingVectors, stateView, options }) {
  const seeds = selectConvergedSeeds({ database, agentId, candidates: convergenceCandidates,
    primaryCandidate, eligibleMemoryIds, options });
  const discovered = seeds.candidates.some(candidate => !isProvisionalMemory(candidate.node))
    ? followMemoryChain({ database, agentId, primary: primaryCandidate.node,
      seedCandidates: seeds.candidates, eligibleMemoryIds, plasticityPolicy, options })
    : { nodes: [], paths: [], candidates: [], activation: null };
  const admitted = convergenceCandidates.filter(candidate => candidate.admission !== 'convergence-only');
  const primary = primaryCandidate.node;
  const relatedStates = stateView && isStructuredStateMemory(primary) && !isProvisionalMemory(primary)
    ? [...(stateView.scopes(primary)?.nodes || []),
      ...(stateView.representations(primary)?.nodes || [])].filter(node => node && node.id !== primary.id)
      .map(node => ({ node, score: primaryCandidate.score * 0.9, admission: 'state-linked' })) : [];
  const selection = selectRankedContext({ database, agentId, preparedQuery, scoreLexical,
    candidates: fuseCandidateLanes([...admitted, ...candidates, ...seeds.candidates, ...relatedStates],
      discovered.candidates || [], Number.MAX_SAFE_INTEGER), eligibleMemoryIds, embeddingVectors,
    maximum: Math.max(1, normalizedEvidenceLimit(options.maximumContextMemories, 5)), stateView, options });
  const selected = new Set(selection.nodes.map(node => node.id));
  return { nodes: selection.nodes, paths: discovered.paths.filter(path => selected.has(path.memoryId)),
    activation: discovered.activation, selection: selection.audit, seeds };
}
