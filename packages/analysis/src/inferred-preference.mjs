import { proposePreferenceState, commonMemoryWorld, memoryWorldScope, memoryWorldsCompatible,
  preferenceEvidenceSnapshot, invalidatePreferenceStateEvidence, materializePreferenceEvidenceMemory,
  assertEventSourceExecutionCurrent, PreferenceStateValidationError } from '@suzu-memory/core';
import { createHash } from 'node:crypto';
import { preferenceEvidenceContext } from './preference-snapshot.mjs';
import { simulatePreferenceFormation } from './preference-simulator.mjs';
import { isStateAnalysisBudgetError, stateAnalysisBudgetError } from './request-budget.mjs';

// Initial product policy uses the existing preference simulator's tested thresholds.
export const DEFAULT_PREFERENCE_FORMATION_POLICY = Object.freeze({
  version: 'preference-formation-v1',
  signalWeights: Object.freeze({ active_choice: 0.7, repeated_behavior: 0.6, active_sharing: 0.5, counter_behavior: 0.6 }),
  opportunityCostMultipliers: Object.freeze({ none: 1, low: 1.05, medium: 1.2, high: 1.4, unknown: 0.8 }),
  minimumConfidence: 0.6,
  minimumStableSupportScore: 1.3,
  minimumStableIndependentSupport: 3,
  minimumStableDistinctDays: 2,
  minimumStableDistinctContexts: 2,
  minimumChoiceEvidenceForStable: 1,
  minimumSelectionEvidence: 2,
  minimumSelectionContexts: 2,
  minimumToleranceEvidence: 2,
  minimumToleranceContexts: 2,
  maximumContributionPerDay: 1,
  maximumOppositionRatio: 0.25,
});

const LEVELS = { 'stable-preference-review': 'stable_preference', 'selection-tendency': 'selection_tendency',
  'situational-tolerance': 'situational_tolerance' };
const normalize = value => String(value ?? '').trim().toLocaleLowerCase('zh-CN');


export function accumulateInferredPreference({ repository, request, policy = DEFAULT_PREFERENCE_FORMATION_POLICY }) {
  const semantic = repository.getStateAnalysisRequestSemanticMemory(request.agent_id, request.id);
  const world = semantic ? memoryWorldScope(semantic) : commonMemoryWorld(request.memoryIds.map(id => repository.getMemory(id)));
  if (!world) return { status: 'review-required', reason: 'preference-world-scope-needs-resolution', proposal: null };
  return tryAccumulate(repository, {
    agentId: request.agent_id, subjectRole: request.subject_role, subjectKey: request.subject_key,
    canonicalKey: request.canonical_key, subjectLabel: request.metadata?.subjectName || request.subject_key, world,
  }, policy);
}

function tryAccumulate(repository, target, policy) {
  try {
    return repository.transaction(() => accumulate(repository, target, policy));
  } catch (error) {
    assertEventSourceExecutionCurrent();
    if (!(error instanceof PreferenceStateValidationError) && !isStateAnalysisBudgetError(error)) throw error;
    const { subjectRole, subjectKey, canonicalKey, world } = target;
    return { status: 'review-required', reason: error.message, proposal: null,
      failure: { target: { subjectRole, subjectKey, canonicalKey }, world, code: error.code, error: error.message } };
  }
}

function formationEvidence(repository, label, input) {
  const detail = repository.getMemoryDetail(input.agentId, input.memoryId);
  const sources = detail.sources.filter(source => input.sourceIds.includes(source.id));
  const identity = input.contextId.startsWith('episode:')
    ? { evidenceGroupId: input.evidenceGroupId, contextId: input.contextId }
    : preferenceEvidenceContext(detail.memory, sources, [], repository.timeZone);
  return { ...label, memoryId: input.memoryId, sourceIds: input.sourceIds,
    subjectRole: input.subjectRole, subjectKey: input.subjectKey, ...identity,
    eventTime: input.eventTime, confidence: input.confidence, signal: input.signal };
}

function accumulate(repository, target, policy) {
  const { agentId, subjectRole, subjectKey, canonicalKey, world } = target;
  const observations = repository.listStateEvidenceObservations(agentId, {
    world, stateFamily: 'preference', subjectRole, subjectKey, canonicalKey, lifecycles: ['current'], limit: 1000,
  });
  if (observations.length >= 1000) throw stateAnalysisBudgetError('Preference accumulation reaches the complete 1000-observation limit.');
  const result = formInferredPreference(repository, target, policy, observations);
  if (result.status !== 'review-required') dismissResolvedFallbacks(repository, agentId, observations);
  return result;
}

function formInferredPreference(repository, target, policy, observations) {
  const { agentId, subjectRole, subjectKey, canonicalKey, world } = target;
  const byMemory = new Map();
  for (const item of observations) {
    if (item.scope?.currentRepresentationLayer !== 'inferred' || item.signal.startsWith('explicit_')
      || item.qualification !== 'qualified' || !item.payload?.legacySimulation
      || repository.getMemory(item.memory_id)?.status !== 'active' || byMemory.has(item.memory_id)) continue;
    const requestId = item.payload.analysisRequest?.id;
    const request = requestId ? repository.getStateAnalysisRequest(agentId, requestId) : null;
    const decisionId = request?.metadata?.ingestionDecisionId;
    const decision = decisionId ? repository.getIngestionDecision(agentId, decisionId) : null;
    if (decision?.review_state === 'dismissed' && decision.resolved_by !== 'preference-accumulation') continue;
    byMemory.set(item.memory_id, item);
  }
  const selected = [...byMemory.values()].sort((a, b) => a.memory_id.localeCompare(b.memory_id));
  if (!selected.length) return { status: 'accumulating', reason: 'no-qualified-behavior', proposal: null };
  const scopes = new Set(selected.map(item => normalize(item.payload.objectGrounding?.matchedLabel)));
  const exact = selected.every(item => item.payload.objectGrounding?.targetMatch === 'exact');
  if ((!exact && scopes.size !== 1) || scopes.has('') || selected.some(item => item.payload.timeScope?.scopeKind === 'unknown')) {
    return { status: 'review-required', reason: 'preference-object-scope-needs-resolution', proposal: null };
  }
  const contexts = new Set(selected.filter(item => item.payload.timeScope?.scopeKind === 'context_only')
    .map(item => normalize(item.payload.timeScope?.contextLabel)));
  if (contexts.size > 1 || contexts.has('') || (contexts.size && selected.some(item => item.payload.timeScope?.scopeKind !== 'context_only'))) {
    return { status: 'review-required', reason: 'preference-context-scope-needs-resolution', proposal: null };
  }
  const evidence = selected.map(item => formationEvidence(repository, item.payload.legacySimulation, {
    agentId, memoryId: item.memory_id, sourceIds: item.sourceIds, subjectRole, subjectKey,
    contextId: item.context_id, evidenceGroupId: item.evidence_group_id,
    eventTime: item.observed_at, confidence: item.confidence, signal: item.signal,
  }));
  const preview = simulatePreferenceFormation({ subjectRole, subjectKey, canonicalKey, evidence, policy, timeZone: repository.timeZone });
  const current = repository.getCurrentCanonicalMemory({ ...world, agentId, subjectRole, subjectKey, canonicalKey,
    stateFamily: 'preference', representationLayer: 'inferred' });
  const proposedLevel = LEVELS[preview.status] || (current || ['conflicting-evidence', 'behavioral-opposition'].includes(preview.status) ? 'no_conclusion' : '');
  if (!proposedLevel) return { status: 'accumulating', reason: preview.status, preview, proposal: null };
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const observationHashes = selected.map(item => ({ id: item.id, hash: item.observation_hash }));
  const accumulationHash = hash([policy, evidence, proposedLevel]);
  if (current?.metadata?.accumulationHash === accumulationHash) return { status: 'already-reviewed', preview, proposal: null };
  const evidenceSourceIds = [...new Set(evidence.flatMap(item => item.sourceIds))].sort();
  const withdrawn = repository.listPreferenceStateProposals(agentId, { canonicalKey, reviewStates: ['dismissed'], limit: 500 })
    .some(proposal => proposal.resolved_by !== 'preference-accumulation'
      && proposal.subject_role === subjectRole && proposal.subject_key === subjectKey
      && JSON.stringify([...new Set(proposal.evidence.flatMap(item => item.sourceIds))].sort()) === JSON.stringify(evidenceSourceIds));
  if (withdrawn) return { status: 'withdrawn', reason: 'preference-evidence-withdrawn', preview, proposal: null };
  const scopeLabel = contexts.size ? selected.find(item => item.payload.timeScope?.scopeKind === 'context_only').payload.timeScope.contextLabel : '';
  const objectLabel = selected[0].payload.objectGrounding.matchedLabel;
  const proposal = proposePreferenceState(repository, {
    agentId, subjectRole, subjectKey, canonicalKey,
    subjectLabel: target.subjectLabel || subjectKey, objectLabel, scopeLabel,
    scope: { kind: contexts.size ? 'context_only' : 'exact_object', label: objectLabel, context: scopeLabel },
    proposedLevel, evidenceReviewMode: 'full_canonical', policyVersion: policy.version, previewStatus: preview.status,
    evidence: evidence.map((item, index) => ({ ...item, observationId: selected[index].id })),
    metrics: { supportScore: preview.supportScore, oppositionScore: preview.oppositionScore,
      independentSupport: preview.independentSupport, distinctSupportDays: preview.distinctSupportDays,
      distinctSupportContexts: preview.distinctSupportContexts, choiceEvidenceCount: preview.choiceEvidenceCount },
    rationale: preview.reasons.join('; '), provenance: 'accumulated-preference-evidence-v1',
    metadata: { accumulatedPreference: true, observationIds: selected.map(item => item.id), observationHashes, accumulationHash },
  });
  return { status: proposal.review_state === 'pending' ? 'proposal-pending' : 'already-reviewed', preview,
    proposal, memory: proposal.resultMemoryId ? repository.getMemory(proposal.resultMemoryId) : null };
}

function dismissResolvedFallbacks(repository, agentId, observations) {
  const requestIds = observations.map(item => item.payload?.analysisRequest?.id).filter(Boolean);
  if (!requestIds.length) return;
  const pending = repository.database.prepare(`SELECT request.id, decision.id AS decisionId,
      decision.provisional_memory_id AS provisionalMemoryId
    FROM memory_state_analysis_requests request JOIN memory_ingestion_decisions decision
      ON decision.agent_id=request.agent_id AND decision.id=json_extract(request.metadata_json, '$.ingestionDecisionId')
    WHERE request.agent_id=? AND request.id IN (SELECT value FROM json_each(?))
      AND decision.review_state='pending' AND request.error_message<>''
      AND (request.error_message='preference-object-scope-needs-resolution'
        OR json_type(request.metadata_json, '$.preferenceAccumulationErrorCode')='text')`)
    .all(agentId, JSON.stringify(requestIds));
  for (const { id, decisionId, provisionalMemoryId } of pending) {
    const provisional = provisionalMemoryId ? repository.getMemory(provisionalMemoryId) : null;
    if (provisional && (provisional.layer !== 'provisional' || provisional.metadata?.manuallyEdited
      || provisional.metadata?.ingestionDecisionId !== decisionId)) continue;
    repository.resolveIngestionDecision({ agentId, decisionId, resolution: 'dismissed',
      resolvedBy: 'preference-accumulation', note: 'Recomputed from the current preference evidence.' });
    if (provisional && provisional.status !== 'deleted') repository.setMemoryDeleted({ agentId,
      memoryId: provisionalMemoryId, actor: 'preference-accumulation',
      reason: 'Current evidence resolved the preference review.' });
    repository.database.prepare(`UPDATE memory_state_analysis_requests SET error_message='',
      metadata_json=json_set(json_remove(metadata_json, '$.preferenceAccumulationErrorCode'),
        '$.outcome', 'preference-recomputed') WHERE agent_id=? AND id=?`).run(agentId, id);
  }
}

export function reconcileInferredPreferences({ repository, agentId, targets, policy = DEFAULT_PREFERENCE_FORMATION_POLICY }) {
  const selected = targets || repository.database.prepare(
    "SELECT DISTINCT subject_role AS subjectRole, subject_key AS subjectKey, canonical_key AS canonicalKey FROM memory_state_evidence_observations WHERE agent_id=? AND state_family='preference' AND lifecycle='current' AND json_extract(scope_json, '$.currentRepresentationLayer')='inferred'"
  ).all(agentId);
  const results = [];
  for (const target of selected) repository.transaction(() => {
    const legacy = repository.database.prepare(`SELECT id FROM memory_preference_state_proposals
      WHERE agent_id=? AND subject_role=? AND subject_key=? AND canonical_key=?
        AND review_state IN ('pending','accepted') AND json_extract(metadata_json, '$.accumulatedPreference')=1
        AND json_type(metadata_json, '$.accumulationHash') IS NULL`)
      .all(agentId, target.subjectRole, target.subjectKey, target.canonicalKey)
      .map(({ id }) => repository.getPreferenceStateProposal(agentId, id));
    const invalid = [];
    for (const proposal of legacy) {
      if (proposal.resultMemoryId) {
        const changed = new Set(proposal.evidence.filter(item => {
          const detail = repository.getMemoryDetail(agentId, item.memoryId);
          if (!detail || detail.memory.status !== 'active') return true;
          try {
            return preferenceEvidenceSnapshot(detail, item) !== item.evidenceSnapshotHash;
          } catch (error) {
            if (!(error instanceof PreferenceStateValidationError)) throw error;
            return true;
          }
        }).map(item => item.memoryId));
        if (changed.size) {
          for (const { id } of proposal.metadata.observationHashes || []) {
            const observation = repository.getStateEvidenceObservation(agentId, id);
            if (observation?.lifecycle === 'current' && changed.has(observation.memory_id))
              repository.withdrawStateEvidenceObservation({ agentId, observationId: id });
          }
          invalid.push(proposal.id);
          continue;
        }
        if (proposal.policy_version === policy.version) {
          const evidence = proposal.evidence.map(item => formationEvidence(repository, item.label, {
            ...item, agentId, subjectRole: proposal.subject_role, subjectKey: proposal.subject_key, eventTime: item.label.eventTime,
          }));
          try {
            const preview = simulatePreferenceFormation({ subjectRole: proposal.subject_role, subjectKey: proposal.subject_key,
              canonicalKey: proposal.canonical_key, evidence, policy, timeZone: repository.timeZone });
            const level = LEVELS[preview.status] || (['conflicting-evidence', 'behavioral-opposition'].includes(preview.status) ? 'no_conclusion' : '');
            if (level !== proposal.proposed_level) invalid.push(proposal.id);
          } catch (error) {
            if (!(error instanceof PreferenceStateValidationError)) throw error;
            invalid.push(proposal.id);
          }
        }
        continue;
      }
      if (proposal.metadata.preferenceApplication || proposal.review_state !== 'pending') continue;
      const previews = repository.database.prepare(`SELECT id FROM memory_nodes WHERE agent_id=? AND layer='provisional'
        AND status<>'deleted' AND json_extract(metadata_json, '$.preferenceProposalId')=?`).all(agentId, proposal.id);
      for (const { id } of previews) repository.setMemoryDeleted({ agentId, memoryId: id,
        actor: 'preference-accumulation', reason: 'Recompute the stored preference from its current evidence.' });
      repository.database.prepare(`UPDATE memory_preference_state_proposals
        SET metadata_json=json_set(metadata_json, '$.preferenceApplication', json(?)) WHERE agent_id=? AND id=?`)
        .run(JSON.stringify({ invalidated: true }), agentId, proposal.id);
    }
    invalidatePreferenceStateEvidence(repository, { agentId, proposalIds: invalid });
    const observations = repository.listStateEvidenceObservations(agentId, {
      stateFamily: 'preference', subjectRole: target.subjectRole, subjectKey: target.subjectKey,
      canonicalKey: target.canonicalKey, limit: 1000,
    });
    const worlds = [];
    for (const observation of observations) {
      materializePreferenceEvidenceMemory(repository, observation);
      if (!worlds.some(world => memoryWorldsCompatible(world, observation.world, { allowRealSpaces: true }))) worlds.push(observation.world);
    }
    for (const world of worlds) {
      const first = observations.find(item => memoryWorldsCompatible(world, item.world, { allowRealSpaces: true }));
      const requestId = first?.payload?.analysisRequest?.id;
      const request = requestId ? repository.getStateAnalysisRequest(agentId, requestId) : null;
      // Evidence and stale-version cleanup can commit even when this world's conclusion cannot.
      results.push(tryAccumulate(repository, { ...target, agentId, world,
        subjectLabel: request?.metadata?.subjectName || target.subjectKey }, policy));
    }
  });
  return results;
}
