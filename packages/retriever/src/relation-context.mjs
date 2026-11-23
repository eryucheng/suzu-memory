import { MEMORY_EXPLANATORY_RELATIONS } from '@suzu-memory/core';

// Traversal and rendered explanations read the same applied edge version.
export const APPLIED_RELATION_JOIN = `LEFT JOIN memory_relation_proposals AS proposal
  ON proposal.agent_id = edge.agent_id AND proposal.result_edge_id = edge.id
  AND proposal.id = json_extract(edge.metadata_json, '$.relationProposalId')
  AND proposal.result_edge_updated_at = edge.updated_at
  AND proposal.weight = edge.weight AND proposal.confidence = edge.confidence
  AND proposal.from_memory_id = edge.from_memory_id AND proposal.to_memory_id = edge.to_memory_id
  AND proposal.relation = edge.relation AND proposal.direction = edge.direction
  AND edge.provenance IN ('memory-relation-proposal-v1', 'accepted-relation-proposal-v1')
  AND proposal.rationale = json_extract(edge.metadata_json, '$.rationale')
  AND COALESCE(json_extract(proposal.metadata_json, '$.scope'), '') = COALESCE(json_extract(edge.metadata_json, '$.scope'), '')
  AND json_type(edge.metadata_json, '$.evidenceSourceIds') = 'array'
  AND NOT EXISTS (SELECT source_id FROM memory_relation_proposal_evidence WHERE proposal_id = proposal.id
    EXCEPT SELECT value FROM json_each(edge.metadata_json, '$.evidenceSourceIds'))
  AND NOT EXISTS (SELECT value FROM json_each(edge.metadata_json, '$.evidenceSourceIds')
    EXCEPT SELECT source_id FROM memory_relation_proposal_evidence WHERE proposal_id = proposal.id)
  AND NOT EXISTS (SELECT 1 FROM memory_relation_proposal_evidence evidence
    JOIN source_records source ON source.id = evidence.source_id
    WHERE evidence.proposal_id = proposal.id AND source.lifecycle <> 'active')`;

/** A record's explanation stays stable when other returned records or graph paths change. */
export function readRelationContext({ database, agentId, nodes, eligibleMemoryIds, options }) {
  if (!nodes.length) return [];
  const types = Object.keys(MEMORY_EXPLANATORY_RELATIONS);
  const query = database.prepare(`SELECT edge.* FROM memory_edges edge
    ${APPLIED_RELATION_JOIN}
    WHERE edge.agent_id = ? AND edge.to_memory_id = ? AND edge.relation IN (${types.map(() => '?').join(',')})
      AND proposal.review_state IN ('pending', 'accepted') AND edge.weight * edge.confidence >= ?
    ORDER BY edge.weight * edge.confidence DESC, edge.id LIMIT ?`);
  const limit = Math.max(1, Math.trunc(Number(options.maximumActivationWork) || 100));
  const minimum = Math.max(0, Number(options.minimumChainPathScore) || 0);
  return nodes.flatMap(node => query.all(agentId, node.id, ...types, minimum, limit)
    .filter(edge => eligibleMemoryIds.has(edge.from_memory_id) && eligibleMemoryIds.has(edge.to_memory_id))
    .map(edge => {
      const metadata = JSON.parse(edge.metadata_json);
      return { edgeId: edge.id, relation: edge.relation, fromMemoryId: edge.from_memory_id, toMemoryId: edge.to_memory_id,
        rationale: metadata.rationale, scope: metadata.scope || '', evidenceSourceIds: metadata.evidenceSourceIds };
    }));
}
