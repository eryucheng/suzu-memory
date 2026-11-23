import { createHash } from 'node:crypto';
import { enqueueMemoryMaintenanceTasks, MAINTENANCE_TASK_TYPES } from './maintenance-tasks.mjs';
import { reportedStateSourceFingerprint } from './reported-state-policy.mjs';

const PROVENANCE = 'preference-evidence-v1';
const STATEMENTS = new Set(['likes', 'prefers', 'dislikes', 'avoids']);
const ACTIONS = new Set(['choice', 'acceptance', 'avoidance']);
const SCOPES = new Set(['exact_object', 'subcategory', 'category', 'context_only']);
const clean = value => String(value ?? '').trim();
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function preferenceEvidenceKind({ objectGrounding: object, explicitExpression: statement,
  behaviorConditions: behavior, timeScope: time }) {
  if (!['exact', 'subcategory'].includes(object?.targetMatch) || !clean(object.matchedLabel)
    || !['current', 'timeless', 'historical'].includes(time?.stateTime)
    || !SCOPES.has(time.scopeKind) || (time.scopeKind === 'context_only' && !clean(time.contextLabel))) return null;
  if (statement?.directness === 'explicit_reported_statement' && STATEMENTS.has(statement.expressionType)) return 'report';
  if (statement?.directness === 'quoted_or_roleplay'
    || (statement?.directness === 'explicit_self_statement'
      && ['likes', 'prefers', 'dislikes'].includes(statement.expressionType))) return null;
  if (time.occurrencePattern === 'single' && time.stateTime !== 'timeless' && ACTIONS.has(behavior?.behaviorType)) {
    return 'single_behavior';
  }
  return null;
}

function readEvidence(repository, observation) {
  if (observation?.state_family !== 'preference' || observation.lifecycle !== 'current') return null;
  const kind = preferenceEvidenceKind(observation.payload);
  const requestId = observation.payload.analysisRequest?.id;
  if (!kind || !requestId) return null;
  const agentId = observation.agent_id;
  const request = repository.getStateAnalysisRequest(agentId, requestId);
  if (!request || request.state_family !== 'preference' || request.subject_role !== observation.subject_role
    || request.subject_key !== observation.subject_key
    || request.canonical_key !== observation.canonical_key || !request.memoryIds.includes(observation.memory_id)
    || observation.sourceIds.some(id => !request.sourceIds.includes(id))) return null;
  const detail = repository.getMemoryDetail(agentId, observation.memory_id);
  // Structured facts and events already carry their own subject and sources.
  if (!detail || detail.memory.kind !== 'utterance' || detail.memory.status !== 'active') return null;
  const byId = new Map(detail.sources.filter(source => source.relation === 'verbatim' && source.lifecycle === 'active')
    .map(source => [source.id, source]));
  const { explicitExpression, behaviorConditions, objectGrounding, timeScope } = observation.payload;
  const claim = kind === 'report' ? explicitExpression : behaviorConditions;
  const sourceIds = [...new Set([...(claim.sourceIds || []), ...(objectGrounding.sourceIds || []),
    ...(timeScope.sourceIds || [])])].sort();
  if (!claim.sourceIds?.length || sourceIds.some(id => !observation.sourceIds.includes(id))) return null;
  const sources = sourceIds.map(id => byId.get(id));
  const originalText = clean(detail.memory.content);
  if (!originalText || !sources.length || sources.some(source => clean(source?.content) !== originalText)) return null;
  const version = hash([observation.id, observation.observation_hash, detail.memory.content,
    detail.memory.subject_role, detail.memory.subject_key, sources.map(reportedStateSourceFingerprint)]);
  return { kind, request, detail, sources, version };
}

export function materializePreferenceEvidenceMemory(repository, observation) {
  if (observation.state_family !== 'preference' || observation.lifecycle !== 'current'
    || !observation.payload.analysisRequest?.id || !preferenceEvidenceKind(observation.payload)) return null;
  const agentId = observation.agent_id;
  const id = 'preference-evidence-' + hash([agentId, observation.subject_role, observation.subject_key,
    observation.canonical_key, observation.memory_id]).slice(0, 24);
  const existing = repository.getMemory(id);
  // A removed result stays removed across re-analysis of the same utterance.
  if (existing?.status === 'deleted') return null;
  if (existing?.metadata?.manuallyEdited) return existing.status === 'active' ? existing : null;
  const input = readEvidence(repository, observation);
  const applied = existing?.metadata?.preferenceEvidence;
  // Changed material needs a new analysis. A restart cannot give old
  // attribution to a replacement source or edit.
  if (!input || (applied?.observationId === observation.id && applied.version !== input.version)) {
    if (applied?.observationId === observation.id && existing.status === 'active') repository.updateMemoryStatus(id, 'archived');
    return null;
  }
  const { kind, request, detail, sources, version } = input;
  if (existing?.status === 'active' && applied?.version === version) return existing;
  const { objectGrounding, timeScope } = observation.payload;
  const subject = clean(request.metadata?.subjectName);
  const label = kind === 'report' ? '偏好转述' : '单次行为';
  const object = clean(objectGrounding.matchedLabel);
  const quotedObject = sources.some(source => source.content.includes(object)) ? object : '';
  const title = [subject ? `关于${subject}的${label}` : label, quotedObject].filter(Boolean).join(' · ');
  const content = sources.map(source => `${clean(source.speaker) || '原话'}：${source.content}`).join('\n');
  return repository.transaction(() => {
    const memory = repository.upsertMemory({ id, agentId, kind: 'fact', layer: 'evidence', title, content,
      subjectRole: observation.subject_role, subjectKey: observation.subject_key, ...observation.world,
      evidenceMode: kind === 'report' ? 'explicit' : 'observed',
      temporalState: kind === 'single_behavior' || timeScope.stateTime === 'historical' ? 'historical' : 'current',
      knownAt: detail.memory.known_at || observation.observed_at, recordedAt: observation.observed_at,
      confidence: observation.confidence, importance: 0.5,
      metadata: { sourceTimeKnown: detail.memory.metadata?.sourceTimeKnown,
        preferenceEvidence: { kind, version, observationId: observation.id, memoryId: observation.memory_id,
          subjectLabel: subject, stateTime: timeScope.stateTime,
          scope: { kind: timeScope.scopeKind, context: timeScope.contextLabel } } },
    });
    repository.database.prepare('DELETE FROM memory_sources WHERE memory_id=? AND provenance=?').run(id, PROVENANCE);
    for (const source of sources) repository.linkSource(id, source.id, 'evidence', {
      authority: kind === 'report' ? 'hearsay' : 'verbatim_record', sourceTrust: 0.5, evidenceStrength: 1, provenance: PROVENANCE,
    });
    repository.upsertEdge({ agentId, fromMemoryId: id, toMemoryId: observation.memory_id,
      relation: 'supported_by', direction: 'directed', weight: 1, confidence: 1, provenance: PROVENANCE });
    if (observation.subject_key.startsWith('entity:')) {
      const entityId = observation.subject_key.slice('entity:'.length);
      if (repository.getEntity(agentId, entityId)) repository.linkMemoryEntities({ memoryId: id, entityIds: [entityId] });
    }
    enqueueMemoryMaintenanceTasks({ repository, agentId, batchId: `${id}:${version}`, memoryIds: [id],
      taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding] });
    return memory;
  });
}

export function preferenceEvidenceMayRestore(repository, memory) {
  const evidence = memory.metadata?.preferenceEvidence;
  if (!evidence) return true;
  const observation = repository.getStateEvidenceObservation(memory.agent_id, evidence.observationId);
  return Boolean(evidence.version && readEvidence(repository, observation)?.version === evidence.version);
}

export function invalidatePreferenceEvidenceMemories(repository, { agentId, memoryIds, observationIds }) {
  if (!memoryIds.length && !observationIds.length) return;
  const rows = repository.database.prepare(`
    WITH changed AS (SELECT value AS id FROM json_each(?)),
      observations AS (SELECT id, memory_id FROM memory_state_evidence_observations
        WHERE agent_id=? AND id IN (SELECT value FROM json_each(?)))
    SELECT DISTINCT node.id FROM memory_edges edge JOIN memory_nodes node ON node.id=edge.from_memory_id
    WHERE edge.agent_id=? AND edge.provenance=? AND edge.relation='supported_by' AND node.status='active'
      AND edge.to_memory_id IN (SELECT id FROM changed UNION SELECT memory_id FROM observations)
      AND (edge.to_memory_id IN changed OR json_extract(node.metadata_json,'$.preferenceEvidence.observationId')
        IN (SELECT id FROM observations))
  `).all(JSON.stringify(memoryIds), agentId, JSON.stringify(observationIds), agentId, PROVENANCE);
  for (const { id } of rows) repository.updateMemoryStatus(id, 'archived');
}
