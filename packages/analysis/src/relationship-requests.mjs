import { createHash } from 'node:crypto';
import { isCounterpartRelationshipStatement } from './relationship-contracts.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);

// A counterpart's own statement is evidence for a separate directed request,
// never confirmation of the original holder's view or of a shared relationship.
export function queueCounterpartRelationshipRequests(repository, request, evaluation) {
  if (request.metadata?.reverseOfRequestId || evaluation.status === 'incomplete') return [];
  const snapshot = evaluation.snapshot;
  const byId = key => new Map((evaluation.analyses[key] || []).map(item => [item.memoryId, item]));
  const perspectives = byId('perspectiveDirection');
  const groups = new Map();
  for (const grounding of evaluation.analyses.relationGrounding || []) {
    const perspective = perspectives.get(grounding.memoryId);
    if (!['exact', 'subcategory'].includes(grounding.targetMatch)
      || ['unknown', 'no_relation', 'uncertain'].includes(grounding.polarity)
      || grounding.relationType === 'unknown' || !grounding.relationLabel
      || (snapshot.target.relationshipDimension && grounding.relationType !== snapshot.target.relationshipDimension)
      || (['permission', 'boundary'].includes(grounding.relationType) && !grounding.scopeLabel)
      || (grounding.polarity === 'conditional' && !grounding.conditionLabel)
      || !isCounterpartRelationshipStatement(perspective)
      || perspective.holderMatch !== 'yes' || perspective.counterpartMatch !== 'yes') continue;
    const memory = snapshot.memories.find(item => item.id === grounding.memoryId);
    const sources = grounding.sourceIds.filter(id => perspective.sourceIds.includes(id));
    if (!memory || !sources.length) continue;
    const key = digest([grounding.relationType, grounding.scopeLabel, grounding.conditionLabel]);
    const group = groups.get(key) || { grounding, memories: [], sourceIds: new Set() };
    group.memories.push(memory);
    sources.forEach(id => group.sourceIds.add(id));
    groups.set(key, group);
  }
  if (!groups.size) return [];
  const existing = repository.listStateAnalysisRequests(request.agent_id, {
    stateFamily: 'relationship', batchId: request.batch_id, limit: 500,
  });
  return repository.transaction(() => [...groups].flatMap(([key, group]) => {
    const sourceIds = [...group.sourceIds].sort();
    const subject = snapshot.counterpart;
    if (existing.some(other => other.id !== request.id && other.subject_role === subject.subjectRole
      && other.subject_key === subject.subjectKey
      && other.targetSpec.counterpartRole === request.subject_role
      && other.targetSpec.counterpartKey === request.subject_key
      && (!other.targetSpec.relationshipDimension || other.targetSpec.relationshipDimension === group.grounding.relationType)
      && sourceIds.every(id => other.sourceIds.includes(id)))) return [];
    const batchId = `relationship-direction-${digest([request.id, key])}`;
    const canonicalKey = `relationship-${digest([subject.subjectRole, subject.subjectKey,
      request.subject_role, request.subject_key, key])}`;
    const targetSpec = { counterpartRole: request.subject_role, counterpartKey: request.subject_key,
      counterpartLabel: request.metadata?.subjectName || request.subject_key,
      direction: 'holder_to_counterpart', relationshipDimension: group.grounding.relationType };
    const sources = snapshot.sourceRecords.filter(source => group.sourceIds.has(source.id));
    const content = sources.map(source => source.content).join('\n');
    const targetLabel = group.grounding.relationLabel;
    const result = repository.recordStateAnalysisRequest({
      agentId: request.agent_id, batchId, candidateIndex: 0,
      stateFamily: 'relationship', subjectRole: subject.subjectRole, subjectKey: subject.subjectKey,
      canonicalKey, targetLabel, targetSpec, representationLayer: 'reported', evidenceMode: 'explicit',
      memoryIds: group.memories.map(memory => memory.id), sourceIds,
      metadata: { actorIdentity: request.metadata?.actorIdentity, sourceLanguage: request.metadata?.sourceLanguage,
        archiveWindowId: request.metadata?.archiveWindowId, subjectName: subject.label,
        candidateKind: 'relationship', retentionReason: 'relationship', revisionAction: 'add', temporalState: 'unknown',
        extractionBatchId: batchId, generator: 'suzu-memory-relationship-direction-v1', reverseOfRequestId: request.id },
      createdAt: request.created_at,
    });
    if (result.wasInserted) repository.recordIngestionDecision({
      agentId: request.agent_id, batchId, candidateIndex: 0, decision: 'store', resultStatus: 'analysis_pending',
      candidate: { kind: 'relationship', stateFamily: 'relationship', title: targetLabel, content,
        subjectRole: subject.subjectRole, subjectName: subject.label, canonicalKey,
        stateLabel: targetLabel, stateTarget: { counterpartRole: targetSpec.counterpartRole,
          counterpartName: targetSpec.counterpartLabel, relationshipDimension: targetSpec.relationshipDimension },
        reality: 'real', evidenceMode: 'explicit', temporalState: 'unknown', revisionAction: 'add',
        retentionReason: 'relationship', actorRoles: [], sourceRefs: sourceIds, confidence: group.grounding.confidence,
        importance: 0.5 },
      sourceRefs: sourceIds, sourceIds, knownAt: group.memories[0].knownAt,
    });
    return [result];
  }));
}
