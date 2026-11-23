import { createHash } from "node:crypto";
import { memoryWorldsCompatible } from './ontology.mjs';
import { OrganizationCandidateError } from './organization-error.mjs';
import { readOrganizationInput, assertOrganizationInputCurrent } from './organization-input.mjs';

export const MEMORY_EXPLANATORY_RELATIONS = Object.freeze({
  causes: '发生原因', reason_for: '决策理由', condition_for: '适用条件',
});

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, fallback, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function validateEndpoint(repository, agentId, memoryId, label) {
  const memory = repository.getMemory(clean(memoryId));
  if (!memory || memory.agent_id !== agentId || memory.status === "deleted") {
    throw new OrganizationCandidateError(`${label} relation endpoint must exist for the same Agent.`);
  }
  return memory;
}

function validateEvidence(repository, {
  agentId,
  fromMemoryId,
  toMemoryId,
  evidenceSourceIds,
}) {
  const sourceIds = [...new Set(
    (Array.isArray(evidenceSourceIds) ? evidenceSourceIds : [])
      .map(clean)
      .filter(Boolean),
  )].sort();
  if (!sourceIds.length) {
    throw new OrganizationCandidateError("A causal relation proposal requires original source evidence.");
  }
  const fromSources = new Set(
    repository.getMemoryDetail(agentId, fromMemoryId)?.sources.map((source) => source.id) || [],
  );
  const toSources = new Set(
    repository.getMemoryDetail(agentId, toMemoryId)?.sources.map((source) => source.id) || [],
  );
  let coversFrom = false;
  let coversTo = false;
  const evidence = sourceIds.map((sourceId) => {
    const source = repository.getSource(sourceId);
    if (!source || source.agent_id !== agentId) {
      throw new OrganizationCandidateError("Relation evidence must belong to the same Agent.");
    }
    if (source.lifecycle !== "active") {
      throw new OrganizationCandidateError("Relation evidence must still be active.");
    }
    const from = fromSources.has(sourceId);
    const to = toSources.has(sourceId);
    if (!from && !to) {
      throw new OrganizationCandidateError("Relation evidence must already support at least one proposed endpoint.");
    }
    coversFrom ||= from;
    coversTo ||= to;
    return {
      sourceId,
      endpointCoverage: from && to ? "both" : from ? "from" : "to",
    };
  });
  if (!coversFrom || !coversTo) {
    throw new OrganizationCandidateError("Causal relation evidence must cover both proposed endpoints.");
  }
  return evidence;
}

function normalizeCandidate(repository, input = {}) {
  if (!repository) throw new Error("Relation proposal requires a repository.");
  const agentId = clean(input.agentId);
  const relation = clean(input.relation);
  const fromMemoryId = clean(input.fromMemoryId ?? input.from_memory_id);
  const toMemoryId = clean(input.toMemoryId ?? input.to_memory_id);
  if (!agentId || !Object.hasOwn(MEMORY_EXPLANATORY_RELATIONS, relation) || !fromMemoryId || !toMemoryId) {
    throw new OrganizationCandidateError("Relation proposal requires agentId, an explanatory relation, and two endpoints.");
  }
  if (fromMemoryId === toMemoryId) {
    throw new OrganizationCandidateError("A causal relation cannot point to itself.");
  }
  if (input.expectedInput) assertOrganizationInputCurrent(repository, agentId, input.expectedInput);
  const from = validateEndpoint(repository, agentId, fromMemoryId, "Cause");
  const to = validateEndpoint(repository, agentId, toMemoryId, "Effect");
  if (!memoryWorldsCompatible(from, to, { allowRealSpaces: true })) {
    throw new OrganizationCandidateError('Relation endpoints must belong to compatible worlds.');
  }
  const evidence = validateEvidence(repository, {
    agentId,
    fromMemoryId,
    toMemoryId,
    evidenceSourceIds: input.evidenceSourceIds ?? input.evidence_source_ids,
  });
  const rationale = clean(input.rationale);
  if (!rationale) {
    throw new OrganizationCandidateError("Causal relation proposal requires a reviewable rationale.");
  }
  const scope = input.scope ?? input.metadata?.scope ?? '';
  if (typeof scope !== 'string') throw new OrganizationCandidateError('Relation scope must be text.');
  return {
    agentId,
    batchId: clean(input.batchId),
    relation,
    fromMemoryId,
    toMemoryId,
    weight: bounded(input.weight, 0.5),
    confidence: bounded(input.confidence, 0.5),
    rationale,
    provenance: clean(input.provenance) || "relation-proposal-v1",
    evidence,
    metadata: { ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {}),
      scope: scope.trim(),
      organizationInput: readOrganizationInput(repository, agentId, [fromMemoryId, toMemoryId]) },
    createdAt: clean(input.createdAt) || new Date().toISOString(),
  };
}

function candidateHash(candidate) {
  return createHash("sha256").update(JSON.stringify({
    relation: candidate.relation,
    fromMemoryId: candidate.fromMemoryId,
    toMemoryId: candidate.toMemoryId,
    evidenceSourceIds: candidate.evidence.map((item) => item.sourceId).sort(),
    inputHash: candidate.metadata.organizationInput.hash,
  })).digest("hex");
}

function findWithdrawnRelation(repository, { agentId, fromMemoryId, toMemoryId, relation, metadata }) {
  // A legacy human withdrawal without a version cannot be silently superseded.
  return repository.database.prepare(`SELECT id FROM memory_relation_proposals
      WHERE agent_id = ? AND from_memory_id = ? AND to_memory_id = ? AND relation = ?
        AND review_state IN ('dismissed', 'revoked')
        AND (CASE review_state WHEN 'dismissed' THEN resolved_by ELSE revoked_by END) NOT LIKE 'system:%'
        AND (json_extract(metadata_json, '$.organizationInput.hash') = ?
          OR json_type(metadata_json, '$.organizationInput') IS NULL)
      ORDER BY updated_at DESC, id LIMIT 1`).get(agentId, fromMemoryId, toMemoryId, relation, metadata.organizationInput.hash);
}

export function proposeMemoryRelation(repository, input = {}) {
  return repository.transaction(() => {
    const candidate = normalizeCandidate(repository, input);
    const retired = findWithdrawnRelation(repository, candidate);
    if (retired) return { ...repository.getRelationProposal(candidate.agentId, retired.id), wasInserted: false };
    const existing = repository.findEdge(candidate);
    if (existing) {
      const owner = repository.getRelationProposal(candidate.agentId, existing.metadata?.relationProposalId);
      if (relationProposalOwnsEdge(owner, existing) && ['pending', 'accepted'].includes(owner.review_state)) {
        assertOrganizationInputCurrent(repository, candidate.agentId, owner.metadata.organizationInput);
        return { ...owner, wasInserted: false };
      }
      throw new OrganizationCandidateError('The causal relation already has an independent edge and will not be overwritten.');
    }
    const proposalHash = candidateHash(candidate);
    const id = clean(input.id) || `relation-proposal-${createHash("sha256")
      .update(`${candidate.agentId}\u001f${proposalHash}`).digest("hex").slice(0, 24)}`;
    const proposal = repository.recordRelationProposal({ ...candidate, id, proposalHash });
    if (proposal.review_state !== 'pending') return proposal;
    const materialized = materializeMemoryRelationProposal(repository, { agentId: candidate.agentId, proposalId: proposal.id });
    return { ...materialized.proposal, wasInserted: proposal.wasInserted, materialization: materialized.status };
  });
}

// The proposal owns only the exact edge it applied. Review is independent of
// application; both pending and confirmed results can be live and reversible.
export function relationProposalOwnsEdge(proposal, edge) {
  return Boolean(proposal && edge && edge.id === proposal.result_edge_id
    && edge.agent_id === proposal.agent_id && edge.updated_at === proposal.result_edge_updated_at
    && edge.from_memory_id === proposal.from_memory_id && edge.to_memory_id === proposal.to_memory_id
    && edge.relation === proposal.relation && edge.direction === proposal.direction
    && edge.weight === proposal.weight && edge.confidence === proposal.confidence
    && ['memory-relation-proposal-v1', 'accepted-relation-proposal-v1'].includes(edge.provenance)
    && edge.metadata?.relationProposalId === proposal.id && edge.metadata.rationale === proposal.rationale
    && (edge.metadata.scope ?? '') === (proposal.metadata?.scope ?? '')
    && Array.isArray(edge.metadata.evidenceSourceIds)
    && JSON.stringify([...edge.metadata.evidenceSourceIds].sort())
      === JSON.stringify(proposal.evidence.map(source => source.id).sort()));
}

export function materializeMemoryRelationProposal(repository, { agentId, proposalId } = {}) {
  return repository.transaction(() => {
    const proposal = repository.getRelationProposal(clean(agentId), proposalId);
    if (!proposal) throw new Error('Relation proposal does not exist for this Agent.');
    if (proposal.review_state !== 'pending') throw new Error(`Only a pending relation proposal can be materialized; it is ${proposal.review_state}.`);
    assertOrganizationInputCurrent(repository, proposal.agent_id, proposal.metadata.organizationInput);
    const candidate = normalizeCandidate(repository, { agentId: proposal.agent_id, relation: proposal.relation,
      fromMemoryId: proposal.from_memory_id, toMemoryId: proposal.to_memory_id,
      evidenceSourceIds: proposal.evidence.map(source => source.id), rationale: proposal.rationale, scope: proposal.metadata?.scope });
    const withdrawn = findWithdrawnRelation(repository, candidate);
    if (withdrawn) return { status: 'retired', edge: null,
      proposal: repository.resolveRelationProposal({ agentId: proposal.agent_id, proposalId: proposal.id,
        resolution: 'dismissed', resolvedBy: 'system:relation-recovery', note: `Relation was withdrawn as ${withdrawn.id}.` }) };
    if (proposal.result_edge_id) {
      const edge = repository.getEdge(proposal.agent_id, proposal.result_edge_id);
      if (!relationProposalOwnsEdge(proposal, edge)) throw new Error('Applied relation edge has changed and cannot be replaced.');
      return { status: 'already-materialized', proposal, edge };
    }
    if (repository.findEdge({ agentId: proposal.agent_id, fromMemoryId: proposal.from_memory_id,
      toMemoryId: proposal.to_memory_id, relation: proposal.relation })) {
      throw new OrganizationCandidateError('The causal relation already has an independent edge and will not be overwritten.');
    }
    const edge = repository.upsertEdge({ agentId: proposal.agent_id, fromMemoryId: proposal.from_memory_id,
      toMemoryId: proposal.to_memory_id, relation: proposal.relation, direction: 'directed',
      weight: proposal.weight, confidence: proposal.confidence, provenance: 'memory-relation-proposal-v1',
      metadata: { relationProposalId: proposal.id, evidenceSourceIds: proposal.evidence.map(source => source.id),
        rationale: proposal.rationale, scope: candidate.metadata.scope } });
    return { status: 'materialized-pending-review', edge,
      proposal: repository.setPendingRelationProposalResult({ agentId: proposal.agent_id, proposalId: proposal.id,
        resultEdgeId: edge.id, resultEdgeUpdatedAt: edge.updated_at }) };
  });
}

export function resolveMemoryRelationProposal(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Resolving a relation proposal requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedAction = clean(action);
  if (!["accept", "dismiss"].includes(normalizedAction)) {
    throw new Error(`Unknown relation proposal action: ${normalizedAction || "(empty)"}.`);
  }
  if (normalizedAction === "dismiss") {
    return repository.transaction(() => ({
      status: "dismissed",
      proposal: repository.resolveRelationProposal({
        agentId: normalizedAgentId,
        proposalId,
        resolution: "dismissed",
        resolvedBy,
        note,
      }),
      edge: null,
    }));
  }

  return repository.transaction(() => {
    const { proposal, edge } = materializeMemoryRelationProposal(repository, { agentId: normalizedAgentId, proposalId });
    if (!edge) throw new Error('The relation was withdrawn for this input and cannot be confirmed as a new result.');
    return {
      status: "accepted",
      proposal: repository.resolveRelationProposal({
        agentId: normalizedAgentId,
        proposalId: proposal.id,
        resolution: "accepted",
        resultEdgeId: edge.id,
        resultEdgeUpdatedAt: edge.updated_at,
        resolvedBy,
        note,
      }),
      edge,
    };
  });
}

export function revokeMemoryRelationProposal(repository, {
  agentId,
  proposalId,
  revokedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Revoking a relation proposal requires a repository.");
  return repository.revokeRelationProposal({
    agentId,
    proposalId,
    revokedBy,
    note,
  });
}
