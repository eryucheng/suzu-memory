import { materializePreferenceStateProposal, proposePreferenceState, resolvePreferenceStateProposal } from '@suzu-memory/core';
import { simulatePreferenceFormation } from './preference-simulator.mjs';
import { stateAnalysisBudgetError } from './request-budget.mjs';

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
  return repository.transaction(() => accumulate(repository, request, policy));
}

function accumulate(repository, request, policy) {
  const observations = repository.listStateEvidenceObservations(request.agent_id, {
    stateFamily: 'preference', subjectRole: request.subject_role, subjectKey: request.subject_key,
    canonicalKey: request.canonical_key, lifecycles: ['current'], limit: 1000,
  });
  if (observations.length >= 1000) throw stateAnalysisBudgetError('Preference accumulation reaches the complete 1000-observation limit.');
  const behavioral = observations.filter(item => item.scope?.currentRepresentationLayer === 'inferred'
    && !item.signal.startsWith('explicit_'));
  const usable = behavioral.filter(item => item.qualification === 'qualified' && item.payload?.legacySimulation
    && repository.getMemory(item.memory_id)?.status === 'active');
  // Each source memory contributes once, even when more than one request analyzed it.
  const byMemory = new Map();
  for (const item of usable) if (!byMemory.has(item.memory_id)) byMemory.set(item.memory_id, item);
  const selected = [...byMemory.values()].sort((a, b) => a.memory_id.localeCompare(b.memory_id));
  if (!selected.length) return { status: 'accumulating', reason: 'no-qualified-behavior', proposal: null };
  const scopes = new Set(selected.map(item => normalize(item.payload.objectGrounding?.matchedLabel)));
  if (scopes.size !== 1 || scopes.has('') || selected.some(item => item.payload.timeScope?.scopeKind === 'unknown')) {
    return { status: 'review-required', reason: 'preference-object-scope-needs-resolution', proposal: null };
  }
  const contexts = new Set(selected.filter(item => item.payload.timeScope?.scopeKind === 'context_only')
    .map(item => normalize(item.payload.timeScope?.contextLabel)));
  if (contexts.size > 1 || contexts.has('') || (contexts.size && selected.some(item => item.payload.timeScope?.scopeKind !== 'context_only'))) {
    return { status: 'review-required', reason: 'preference-context-scope-needs-resolution', proposal: null };
  }
  const evidence = selected.map(item => ({ ...item.payload.legacySimulation,
    memoryId: item.memory_id, sourceIds: item.sourceIds, subjectRole: request.subject_role,
    subjectKey: request.subject_key, evidenceGroupId: item.evidence_group_id, contextId: item.context_id,
    eventTime: item.observed_at, confidence: item.confidence, signal: item.signal }));
  const preview = simulatePreferenceFormation({ subjectRole: request.subject_role, subjectKey: request.subject_key,
    canonicalKey: request.canonical_key, evidence, policy, timeZone: repository.timeZone });
  let proposedLevel = LEVELS[preview.status];
  const current = repository.getCurrentCanonicalMemory({ agentId: request.agent_id, subjectRole: request.subject_role,
    subjectKey: request.subject_key, canonicalKey: request.canonical_key, stateFamily: 'preference', representationLayer: 'inferred' });
  if (['conflicting-evidence', 'behavioral-opposition'].includes(preview.status)) {
    proposedLevel = current?.metadata?.preferenceStateLevel || 'no_conclusion';
  }
  if (!proposedLevel) return { status: 'accumulating', reason: preview.status, preview, proposal: null };
  const observationHashes = selected.map(item => ({ id: item.id, hash: item.observation_hash }));
  if (current?.metadata?.preferencePolicyVersion === policy.version
    && JSON.stringify(current.metadata.observationHashes) === JSON.stringify(observationHashes)) {
    return { status: 'already-reviewed', preview, proposal: null };
  }
  const scopeLabel = contexts.size ? selected.find(item => item.payload.timeScope?.scopeKind === 'context_only').payload.timeScope.contextLabel : '';
  const proposal = proposePreferenceState(repository, {
    agentId: request.agent_id, subjectRole: request.subject_role, subjectKey: request.subject_key,
    canonicalKey: request.canonical_key, subjectLabel: request.metadata?.subjectName || request.subject_key,
    objectLabel: selected[0].payload.objectGrounding.matchedLabel, scopeLabel,
    scope: { kind: contexts.size ? 'context_only' : 'exact_object', label: selected[0].payload.objectGrounding.matchedLabel, context: scopeLabel },
    proposedLevel, policyVersion: policy.version, previewStatus: preview.status, evidence,
    metrics: { supportScore: preview.supportScore, oppositionScore: preview.oppositionScore,
      independentSupport: preview.independentSupport, distinctSupportDays: preview.distinctSupportDays,
      distinctSupportContexts: preview.distinctSupportContexts, choiceEvidenceCount: preview.choiceEvidenceCount },
    rationale: preview.reasons.join('; '), provenance: 'accumulated-preference-evidence-v1',
    metadata: { accumulatedPreference: true, observationIds: selected.map(item => item.id),
      observationHashes },
  });
  const pending = repository.listPreferenceStateProposals(request.agent_id, { canonicalKey: request.canonical_key, reviewStates: ['pending'], limit: 500 });
  for (const previous of pending) {
    if (previous.id !== proposal.id && previous.metadata?.accumulatedPreference
      && previous.subject_role === request.subject_role && previous.subject_key === request.subject_key) {
      resolvePreferenceStateProposal(repository, { agentId: request.agent_id, proposalId: previous.id,
        action: 'dismiss', resolvedBy: 'preference-accumulation', note: 'Replaced by an updated evidence accumulation.' });
    }
  }
  const materialized = materializePreferenceStateProposal(repository, { agentId: request.agent_id, proposalId: proposal.id });
  return { status: proposal.review_state === 'pending' ? 'proposal-pending' : 'already-reviewed',
    preview, proposal, memory: materialized.memory };
}
