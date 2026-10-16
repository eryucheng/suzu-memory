import { createHash } from 'node:crypto';
import { executionEventSourceView, assertEventSourceExecutionCurrent, ROOT_STATE_SCOPE_KEY, memoryWorldsCompatible } from '@suzu-memory/core';
import { syncMemoryEmbeddings, prepareMemoryEmbeddingDocument } from '@suzu-memory/embedding-indexer';
import { lexicalScore } from '@suzu-memory/retriever';

export const STATE_MEMORY_MATCH_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['resolution', 'candidateId', 'rationale'],
  properties: {
    resolution: { type: 'string', enum: ['matched', 'new', 'ambiguous'] },
    candidateId: { type: 'string' }, rationale: { type: 'string', minLength: 1 },
  },
});

export function stateMatchAnalysisSchema(analysisSchema) {
  return { type: 'object', additionalProperties: false, required: ['stateMatch', 'analysis'],
    properties: { stateMatch: STATE_MEMORY_MATCH_SCHEMA, analysis: analysisSchema } };
}

function similarity(left, right) {
  if (!left || !right || left.length !== right.length) return -1;
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function candidateView(repository, memory) {
  const detail = repository.getMemoryDetail(memory.agent_id, memory.id);
  return {
    id: memory.id, kind: memory.kind, title: memory.title, content: memory.content,
    subjectRole: memory.subject_role, subjectKey: memory.subject_key,
    canonicalKey: memory.canonical_key, representationLayer: memory.representation_layer,
    temporalState: memory.temporal_state, statePhase: memory.state_phase,
    knownAt: memory.known_at, validFrom: memory.valid_from, validTo: memory.valid_to,
    eventDate: memory.event_date, eventStart: memory.event_start, worldFrame: memory.world_frame,
    reviewState: memory.layer === 'provisional' ? 'pending' : 'accepted',
    evidenceOnly: memory.metadata?.stateAnalysisDraft === true,
    roles: detail.roles.map(role => ({ role: role.role, actorRole: role.actor_role, actorKey: role.actor_key })),
    sourceIds: detail.sources.map(source => source.id),
  };
}

// Candidate selection is local; the existing evidence call resolves identity.
export async function prepareStateMemoryCandidates({ repository, request, embeddingProvider, usageLedgerPath }) {
  if (typeof embeddingProvider !== 'function') return null;
  const draft = repository.materializeStateAnalysisMemory(request.agent_id, request.id);
  if (!draft) return null;
  const report = await syncMemoryEmbeddings({ repository, agentId: request.agent_id,
    embeddingProvider, memoryIds: [draft.id], ledgerPath: usageLedgerPath, continueOnError: false });
  assertEventSourceExecutionCurrent();
  const sourceView = executionEventSourceView(repository, request.agent_id);
  const embeddings = new Map(repository.listEmbeddings(request.agent_id, embeddingProvider.model, { includeArchived: true })
    .map(row => [row.memory_id, row]));
  const vector = embeddings.get(draft.id)?.vector;
  if (!vector) throw new Error('State analysis semantic memory has no embedding.');
  const pending = new Set(repository.listPendingProvisionalMemories(request.agent_id, { limit: 5000 }).map(item => item.id));
  const ids = repository.database.prepare(`SELECT id FROM memory_nodes
    WHERE agent_id = ? AND subject_role = ? AND subject_key = ? AND state_family = ?
      AND representation_layer = ? AND status <> 'deleted' AND reality = ?
    ORDER BY recorded_at DESC, id`).all(request.agent_id, request.subject_role, request.subject_key,
      request.state_family, request.representation_layer, draft.reality);
  const ranked = [];
  for (const { id } of ids) {
    if (id === draft.id) continue;
    const memory = repository.getMemory(id);
    if (memory.state_scope_key !== ROOT_STATE_SCOPE_KEY) continue;
    if (!memoryWorldsCompatible(draft, memory, { allowRealSpaces: true })) continue;
    if (sourceView && !sourceView.allows(memory)) continue;
    const earlierRequest = memory.metadata?.stateAnalysisDraft
      ? repository.getStateAnalysisRequest(request.agent_id, memory.metadata.stateAnalysisRequestId) : null;
    const evidenceOnly = earlierRequest?.status === 'completed' && earlierRequest.metadata?.outcome === 'accumulating';
    const historical = memory.status === 'superseded' && memory.layer !== 'provisional';
    if (memory.status !== 'active' && !historical && !pending.has(id) && !evidenceOnly) continue;
    const row = embeddings.get(id);
    const score = row && row.content_hash === prepareMemoryEmbeddingDocument(repository, memory, { sourceView }).contentHash
      ? similarity(vector, row.vector) : -1;
    const lexical = lexicalScore(draft.content, `${memory.title}\n${memory.content}`).score;
    ranked.push({ memory, score, lexical, earlierRequest });
  }
  // Reserve recent candidates for short references and rows awaiting indexing.
  const selected = [...new Map([
    ...[...ranked].sort((a, b) => b.score - a.score || b.lexical - a.lexical).slice(0, 6),
    ...[...ranked].sort((a, b) => b.lexical - a.lexical || b.score - a.score).slice(0, 2),
    ...ranked.slice(0, 2),
  ].map(item => [item.memory.id, item])).values()];
  const candidates = selected.map(({ memory, earlierRequest }) => ({ ...candidateView(repository, memory),
    canonicalKey: earlierRequest?.canonical_key || memory.canonical_key }));
  const newCanonicalKey = `state-${createHash('sha256').update(request.id).digest('hex').slice(0, 24)}`;
  Object.assign(request, repository.bindStateAnalysisTarget({ agentId: request.agent_id, requestId: request.id,
    canonicalKey: newCanonicalKey, metadata: { semanticMemoryId: draft.id,
      stateIdentityResolution: null, stateCandidateIds: candidates.map(item => item.id) } }));
  const snapshots = [];
  const context = {
    draft, report, candidates, selected: null, ambiguous: false,
    resolved: false,
    attach(snapshot) {
      snapshots.push(snapshot);
      snapshot.semanticMemory = { id: draft.id, title: draft.title, content: draft.content };
      snapshot.stateCandidates = candidates;
      // A newly generated key is only a hint, never evidence of identity.
      snapshot.currentState = null;
    },
    resolve(match) {
      assertEventSourceExecutionCurrent();
      if (!match || !['matched', 'new', 'ambiguous'].includes(match.resolution)
        || typeof match.rationale !== 'string' || !match.rationale.trim()) throw new Error('Invalid state identity resolution.');
      const selected = match.resolution === 'matched' ? candidates.find(item => item.id === match.candidateId) : null;
      if ((match.resolution === 'matched' && !selected) || (match.resolution !== 'matched' && match.candidateId)) {
        throw new Error('State identity resolution references an unavailable candidate.');
      }
      if (selected) {
        const memory = repository.getMemory(selected.id);
        if (!memory || memory.status === 'deleted' || memory.content !== selected.content
          || memory.title !== selected.title || memory.state_phase !== selected.statePhase
          || memory.valid_to !== selected.validTo
          || (sourceView && !sourceView.allows(memory))) throw new Error('State identity candidate changed during analysis.');
      }
      context.selected = selected;
      if (selected && !selected.evidenceOnly) {
        const latest = repository.getCurrentCanonicalMemory({ agentId: request.agent_id,
          subjectRole: request.subject_role, subjectKey: request.subject_key, canonicalKey: selected.canonicalKey,
          representationLayer: request.representation_layer, stateFamily: request.state_family,
          includePending: true, includeHistorical: true });
        if (latest && !memoryWorldsCompatible(draft, latest, { allowRealSpaces: true })) {
          throw new Error('Canonical state identity crosses incompatible worlds.');
        }
        if (latest) context.selected = candidateView(repository, latest);
      }
      context.ambiguous = match.resolution === 'ambiguous';
      const canonicalKey = selected?.canonicalKey || newCanonicalKey;
      Object.assign(request, repository.bindStateAnalysisTarget({ agentId: request.agent_id, requestId: request.id,
        canonicalKey, metadata: { semanticMemoryId: draft.id, stateIdentityResolution: match,
          stateCandidateIds: candidates.map(item => item.id) } }));
      for (const snapshot of snapshots) {
        snapshot.target.canonicalKey = canonicalKey;
        snapshot.currentState = context.selected && !context.selected.evidenceOnly ? context.selected : null;
      }
      context.resolved = true;
    },
    refresh(input) {
      if (!context.resolved) return input;
      return { ...input, target: { ...input.target, canonicalKey: request.canonical_key },
        currentState: context.selected && !context.selected.evidenceOnly ? context.selected : null };
    },
  };
  if (!candidates.length) context.resolve({ resolution: 'new', candidateId: '', rationale: '没有可用的已有状态候选。' });
  return context;
}
