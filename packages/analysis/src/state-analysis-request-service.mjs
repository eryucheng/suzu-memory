import { assertEventSourceExecutionCurrent } from '@suzu-memory/core';
import {
  buildPreferenceEvidenceSnapshot,
} from "./preference-snapshot.mjs";
import { isStateAnalysisTargetComplete } from "@suzu-memory/core";
import { fallbackStateAnalysisToProvisionalReview, resolveExtractedCandidateIdentity } from "@suzu-memory/extraction";
import {
  evaluatePreferenceEvidenceSpecialists,
} from "./preference-specialist-service.mjs";
import {
  PREFERENCE_SPECIALIST_ANALYZERS,
} from "./preference-specialist-contracts.mjs";
import {
  mergePreferenceSpecialistEvidence,
} from "./preference-specialist-merge.mjs";
import {
  reviewReportedPreferenceState,
} from "./reported-preference-review.mjs";
import {
  proposeReportedStateFromReview,
} from "./reported-state-persistence.mjs";
import { evaluateGoalEvidence } from "./goal-service.mjs";
import { GOAL_ANALYZERS } from "./goal-contracts.mjs";
import { reviewReportedGoalState } from "./reported-goal-review.mjs";
import { evaluateValueEvidence } from "./value-service.mjs";
import { VALUE_ANALYZERS } from "./value-contracts.mjs";
import { reviewReportedValueState } from "./reported-value-review.mjs";
import { evaluateCapabilityEvidence } from "./capability-service.mjs";
import { CAPABILITY_ANALYZERS } from "./capability-contracts.mjs";
import { reviewReportedCapabilityState } from "./reported-capability-review.mjs";
import { evaluateSelfConceptEvidence } from "./self-concept-service.mjs";
import { SELF_CONCEPT_ANALYZERS } from "./self-concept-contracts.mjs";
import { reviewReportedSelfConceptState } from "./reported-self-concept-review.mjs";
import { evaluateBehaviorStateEvidence } from "./behavior-state-service.mjs";
import { BEHAVIOR_STATE_ANALYZERS } from "./behavior-state-contracts.mjs";
import { reviewReportedConditionState } from "./reported-condition-review.mjs";
import { reviewReportedHabitState } from "./reported-habit-review.mjs";
import { reviewReportedDispositionState } from "./reported-disposition-review.mjs";
import { evaluateIdentityEvidence } from "./identity-service.mjs";
import { IDENTITY_ANALYZERS } from "./identity-contracts.mjs";
import { reviewReportedIdentityState } from "./reported-identity-review.mjs";
import { evaluateBeliefEvidence } from "./belief-service.mjs";
import { BELIEF_ANALYZERS } from "./belief-contracts.mjs";
import { reviewReportedBeliefState } from "./reported-belief-review.mjs";
import { evaluateRelationshipEvidence } from "./relationship-service.mjs";
import { RELATIONSHIP_ANALYZERS } from "./relationship-contracts.mjs";
import { reviewReportedRelationshipState } from "./reported-relationship-review.mjs";
import { evaluateAffectiveAssociationEvidence } from "./affective-association-service.mjs";
import { AFFECTIVE_ASSOCIATION_ANALYZERS } from "./affective-association-contracts.mjs";
import { reviewReportedAffectiveAssociationState } from "./reported-affective-association-review.mjs";
import { createRelatedAnalyzerBatch } from "./related-analyzer-batch.mjs";
import { isStateAnalysisBudgetError } from "./request-budget.mjs";
import { accumulateInferredPreference, DEFAULT_PREFERENCE_FORMATION_POLICY } from "./inferred-preference.mjs";
import { prepareStateMemoryCandidates } from './state-memory-candidates.mjs';

export const STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION = "state-analysis-request-v3";
export const REPORTED_PREFERENCE_REVIEW_VERSION = "reported-preference-review-v1";
export const REPORTED_STATE_REQUEST_REVIEW_VERSIONS = Object.freeze({
  preference: REPORTED_PREFERENCE_REVIEW_VERSION,
  goal: "reported-goal-review-v1",
  value: "reported-value-review-v1",
  capability: "reported-capability-review-v1",
  self_concept: "reported-self-concept-review-v1",
  condition: "reported-condition-review-v1",
  habit: "reported-habit-review-v1",
  disposition: "reported-disposition-review-v1",
  identity: "reported-identity-review-v1",
  belief: "reported-belief-review-v1",
  relationship: "reported-relationship-review-v1",
  affective_association: "reported-affective-association-review-v1",
});

function clean(value) {
  return String(value ?? "").trim();
}

function exactSet(values) {
  return new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean));
}

function sameMembers(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every((value) => right.has(value));
}

function supportedRequest(request) {
  if (request?.state_family === "preference" && request.representation_layer === "inferred"
    && ["observed", "inferred"].includes(request.evidence_mode)) {
    return isStateAnalysisTargetComplete(request.state_family, request.targetSpec);
  }
  return Boolean(REPORTED_STATE_REQUEST_REVIEW_VERSIONS[request?.state_family])
    && request?.representation_layer === "reported"
    && request.evidence_mode === "explicit"
    && isStateAnalysisTargetComplete(request.state_family, request.targetSpec);
}

function requestAnalyzers(definitions, generator, request, onBudgetExceeded, stateContext = null) {
  return createRelatedAnalyzerBatch({
    definitions,
    generator,
    onBudgetExceeded,
    stateContext,
    onGenerationError: error => { if (error?.code === 'MAX_TOKENS') onBudgetExceeded(error); },
    request: {
      id: request.id,
      processorVersion: STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION,
      attempt: Number(request.metadata?.attemptCount || 0) + 1,
    },
  });
}

function commonEvaluationInput(request, repository, usageLedgerPath, snapshotOptions) {
  return {
    repository,
    agentId: request.agent_id,
    subjectRole: request.subject_role,
    subjectKey: request.subject_key,
    canonicalKey: request.canonical_key,
    memoryIds: request.memoryIds,
    usageLedgerPath,
    snapshotOptions,
  };
}

function subjectLabel(request) {
  return clean(request.metadata?.subjectName) || request.subject_key;
}

function evaluationObservationIds(evaluation, stateFamily) {
  const observations = Array.isArray(evaluation?.observations)
    ? evaluation.observations
    : evaluation?.observations?.[stateFamily] || [];
  return observations.map((observation) => clean(observation?.id)).filter(Boolean);
}

const SIMPLE_REPORTED_REQUEST_ADAPTERS = {
  goal: Object.freeze({
    definitions: GOAL_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateGoalEvidence({
      ...common,
      goalLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedGoalState({
      ...common,
      subjectLabel: subjectLabel(request),
      goalLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  value: Object.freeze({
    definitions: VALUE_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateValueEvidence({
      ...common,
      valueLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedValueState({
      ...common,
      subjectLabel: subjectLabel(request),
      valueLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  capability: Object.freeze({
    definitions: CAPABILITY_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateCapabilityEvidence({
      ...common,
      capabilityLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedCapabilityState({
      ...common,
      subjectLabel: subjectLabel(request),
      capabilityLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  self_concept: Object.freeze({
    definitions: SELF_CONCEPT_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateSelfConceptEvidence({
      ...common,
      selfConceptLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedSelfConceptState({
      ...common,
      subjectLabel: subjectLabel(request),
      selfConceptLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  condition: null,
  habit: null,
  disposition: null,
  identity: Object.freeze({
    definitions: IDENTITY_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateIdentityEvidence({
      ...common,
      subjectLabel: subjectLabel(request),
      identityField: request.targetSpec.identityField,
      identityLabel: request.target_label,
      fieldCardinality: request.targetSpec.fieldCardinality,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedIdentityState({
      ...common,
      subjectLabel: subjectLabel(request),
      identityLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  belief: Object.freeze({
    definitions: BELIEF_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateBeliefEvidence({
      ...common,
      topicLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedBeliefState({
      ...common,
      subjectLabel: subjectLabel(request),
      topicLabel: request.target_label,
      objectRole: request.targetSpec.objectRole,
      objectKey: request.targetSpec.objectKey,
      objectLabel: request.targetSpec.objectLabel,
      snapshotOptions,
    }),
  }),
  relationship: Object.freeze({
    definitions: RELATIONSHIP_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateRelationshipEvidence({
      ...common,
      counterpartRole: request.targetSpec.counterpartRole,
      counterpartKey: request.targetSpec.counterpartKey,
      counterpartLabel: request.targetSpec.counterpartLabel,
      relationshipLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedRelationshipState({
      ...common,
      subjectLabel: subjectLabel(request),
      counterpartRole: request.targetSpec.counterpartRole,
      counterpartKey: request.targetSpec.counterpartKey,
      counterpartLabel: request.targetSpec.counterpartLabel,
      relationshipLabel: request.target_label,
      snapshotOptions,
    }),
  }),
  affective_association: Object.freeze({
    definitions: AFFECTIVE_ASSOCIATION_ANALYZERS,
    evaluate: (common, analyzers, request) => evaluateAffectiveAssociationEvidence({
      ...common,
      triggerRole: request.targetSpec.triggerRole,
      triggerKey: request.targetSpec.triggerKey,
      triggerLabel: request.targetSpec.triggerLabel,
      associationLabel: request.target_label,
      currentRepresentationLayer: "reported",
      analyzers,
    }),
    review: (common, request, snapshotOptions) => reviewReportedAffectiveAssociationState({
      ...common,
      subjectLabel: subjectLabel(request),
      associationLabel: request.target_label,
      snapshotOptions,
    }),
  }),
};

for (const [stateFamily, review] of [
  ["condition", reviewReportedConditionState],
  ["habit", reviewReportedHabitState],
  ["disposition", reviewReportedDispositionState],
]) {
  SIMPLE_REPORTED_REQUEST_ADAPTERS[stateFamily] = Object.freeze({
    definitions: { [stateFamily]: BEHAVIOR_STATE_ANALYZERS[stateFamily] },
    evaluate: (common, analyzers, request) => evaluateBehaviorStateEvidence({
      repository: common.repository,
      agentId: common.agentId,
      subjectRole: common.subjectRole,
      subjectKey: common.subjectKey,
      memoryIds: common.memoryIds,
      usageLedgerPath: common.usageLedgerPath,
      snapshotOptions: common.snapshotOptions,
      targets: {
        [stateFamily]: {
          canonicalKey: request.canonical_key,
          conceptLabel: request.target_label,
          currentRepresentationLayer: "reported",
        },
      },
      analyzers,
    }),
    review: (common, request, snapshotOptions) => review({
      ...common,
      subjectLabel: subjectLabel(request),
      [`${stateFamily}Label`]: request.target_label,
      snapshotOptions,
    }),
  });
}
Object.freeze(SIMPLE_REPORTED_REQUEST_ADAPTERS);

function requestSnapshotOptions(request, snapshotOptions) {
  return {
    ...snapshotOptions,
    allowUtteranceEvidence: true,
    allowedSourceIds: request.sourceIds,
    analysisRequestId: request.id,
  };
}

function validatePreflight(request, snapshot) {
  const visibleMemoryIds = exactSet(snapshot.memories.map((memory) => memory.id));
  const visibleSourceIds = exactSet(snapshot.sourceRecords.map((source) => source.id));
  if (!sameMembers(visibleMemoryIds, exactSet(request.memoryIds))) {
    return "request-memory-became-ineligible";
  }
  if (!sameMembers(visibleSourceIds, exactSet(request.sourceIds))) {
    return "request-source-boundary-mismatch";
  }
  if (request.state_family === "identity" && snapshot.memories.some(memory => (
    memory.kind === "utterance"
    && !(memory.subjectRole === request.subject_role && memory.subjectKey === request.subject_key)
    && !memory.actorRoles.some(role => ["subject", "speaker", "participant"].includes(role.role)
      && role.actorRole === request.subject_role && role.actorKey === request.subject_key)
  ))) {
    // A third-party target is an extraction hypothesis, not the utterance's speaker.
    // Resolve its name with the same host identities and evidence scope as extraction.
    const name = clean(request.metadata?.subjectName);
    const identity = resolveExtractedCandidateIdentity({
      subjectRole: request.subject_role, subjectName: name, actorRoles: [],
    }, request.agent_id, request.metadata?.actorIdentity || {});
    if (!name || identity.subjectKey !== request.subject_key) {
      return "request-subject-identity-mismatch";
    }
  }
  return "";
}

function fallbackRequest(repository, request, reason) {
  const fallback = fallbackStateAnalysisToProvisionalReview({
    repository,
    request,
    reason,
  });
  return {
    status: "provisional-review",
    reason,
    request: fallback.request,
    evaluation: null,
    merged: null,
    review: null,
    proposal: null,
    provisional: fallback.provisional,
    ingestionDecision: fallback.decision,
  };
}

function retryOrFallbackRequest(repository, request, reason, details = {}) {
  const recorded = repository.recordStateAnalysisRequestFailure({
    agentId: request.agent_id,
    requestId: request.id,
    errorMessage: reason,
    errorDetails: details,
    maxAttempts: details.errorCode === 'MAX_TOKENS' ? 1 : 3,
  });
  if (!recorded.exhausted) {
    return {
      status: "retry-pending",
      reason,
      request: recorded.request,
      evaluation: null,
      merged: null,
      review: null,
      proposal: null,
      attemptCount: recorded.attemptCount,
      maxAttempts: recorded.maxAttempts,
      failure: recorded.failure,
    };
  }
  const fallback = fallbackRequest(repository, recorded.request, reason);
  return {
    ...fallback,
    attemptCount: recorded.attemptCount,
    maxAttempts: recorded.maxAttempts,
    failure: recorded.failure,
  };
}

async function processStateAnalysisRequestInternal({
  repository,
  embeddingProvider,
  agentId,
  requestId,
  generator,
  usageLedgerPath = "",
  snapshotOptions = {},
  reviewVersion = "",
  preferencePolicy = DEFAULT_PREFERENCE_FORMATION_POLICY,
} = {}) {
  if (!repository) throw new Error("State analysis request processing requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedRequestId = clean(requestId);
  if (!normalizedAgentId || !normalizedRequestId) {
    throw new Error("State analysis request processing requires agentId and requestId.");
  }
  const request = repository.getStateAnalysisRequest(normalizedAgentId, normalizedRequestId);
  if (!request) throw new Error("State analysis request was not found.");
  if (request.status !== "pending") {
    return {
      status: "already-resolved",
      reason: request.status,
      request,
      evaluation: null,
      merged: null,
      review: null,
      proposal: null,
    };
  }
  if (!supportedRequest(request)) {
    return {
      status: "unsupported",
      reason: `${request.state_family}:${request.representation_layer}`,
      request,
      evaluation: null,
      merged: null,
      review: null,
      proposal: null,
    };
  }
  if (typeof generator !== "function") {
    throw new Error("State analysis request processing requires a generator.");
  }
  if (request.subject_role === "shared") {
    return fallbackRequest(repository, request, "reported-state-family-requires-individual-subject");
  }

  const boundedSnapshotOptions = requestSnapshotOptions(request, snapshotOptions);
  const preflight = buildPreferenceEvidenceSnapshot({
    repository,
    agentId: normalizedAgentId,
    subjectRole: request.subject_role,
    subjectKey: request.subject_key,
    canonicalKey: request.canonical_key,
    memoryIds: request.memoryIds,
    ...boundedSnapshotOptions,
  });
  const boundaryProblem = validatePreflight(request, preflight);
  if (boundaryProblem) return fallbackRequest(repository, request, boundaryProblem);
  const stateContext = await prepareStateMemoryCandidates({ repository, request, embeddingProvider, usageLedgerPath });
  if (stateContext) boundedSnapshotOptions.prepareStateSnapshot = snapshot => stateContext.attach(snapshot);

  let evaluation;
  let merged;
  let review;
  let inferredPreference = null;
  let budgetError = null;
  const onBudgetExceeded = error => { budgetError = error; };
  if (request.state_family === "preference") {
    const analyzers = requestAnalyzers(PREFERENCE_SPECIALIST_ANALYZERS, generator, request, onBudgetExceeded, stateContext);
    evaluation = await evaluatePreferenceEvidenceSpecialists({
      repository,
      agentId: normalizedAgentId,
      subjectRole: request.subject_role,
      subjectKey: request.subject_key,
      canonicalKey: request.canonical_key,
      objectLabel: request.target_label,
      memoryIds: request.memoryIds,
      analyzers,
      usageLedgerPath,
      snapshotOptions: boundedSnapshotOptions,
    });
    if (stateContext?.ambiguous && evaluation.status !== 'incomplete') {
      return { ...fallbackRequest(repository, request, 'state-identity-needs-human-resolution'), evaluation };
    }
    if (evaluation.status !== "incomplete") {
      merged = mergePreferenceSpecialistEvidence(repository, {
        evaluation,
        analysisRequest: request,
        policy: preferencePolicy,
      });
      inferredPreference = accumulateInferredPreference({ repository, request, policy: preferencePolicy });
      if (request.representation_layer === "inferred") {
        if (inferredPreference.status === "review-required") {
          return { ...fallbackRequest(repository, request, inferredPreference.reason), evaluation, merged, inferredPreference };
        }
        const resolved = repository.resolveStateAnalysisRequest({ agentId: normalizedAgentId, requestId: request.id,
          status: "completed", analysisBatchId: evaluation.batchId,
          metadata: { outcome: inferredPreference.status, preferenceProposalId: inferredPreference.proposal?.id || "" } });
        return { status: inferredPreference.status === "proposal-pending" ? "proposal-pending" : "completed-without-proposal",
          request: resolved, evaluation, merged, inferredPreference, preferenceProposal: inferredPreference.proposal, proposal: null };
      }
      review = reviewReportedPreferenceState({
        repository,
        agentId: normalizedAgentId,
        subjectRole: request.subject_role,
        subjectKey: request.subject_key,
        canonicalKey: request.canonical_key,
        subjectLabel: subjectLabel(request),
        objectLabel: request.target_label,
      });
    }
  } else {
    const adapter = SIMPLE_REPORTED_REQUEST_ADAPTERS[request.state_family];
    const common = commonEvaluationInput(
      request,
      repository,
      usageLedgerPath,
      boundedSnapshotOptions,
    );
    evaluation = await adapter.evaluate(
      common,
      requestAnalyzers(adapter.definitions, generator, request, onBudgetExceeded, stateContext),
      request,
    );
    if (stateContext?.ambiguous && evaluation.status !== 'incomplete') {
      return { ...fallbackRequest(repository, request, 'state-identity-needs-human-resolution'), evaluation };
    }
    if (evaluation.status !== "incomplete") {
      const observationIds = evaluationObservationIds(evaluation, request.state_family);
      merged = {
        observations: Array.isArray(evaluation.observations)
          ? evaluation.observations
          : evaluation.observations?.[request.state_family] || [],
        previews: evaluation.actionPreviews || [],
      };
      review = observationIds.length
        ? adapter.review({
          repository,
          agentId: normalizedAgentId,
          subjectRole: request.subject_role,
          subjectKey: request.subject_key,
          canonicalKey: request.canonical_key,
        }, request, {
          ...snapshotOptions,
          analysisRequestId: request.id,
          analysisRequestObservationIds: observationIds,
        })
        : {
          status: "skipped",
          reason: "no-state-evidence-observations",
          representationLayer: "reported",
          automaticStateWriteAllowed: false,
        };
    }
  }
  if (evaluation.status === "incomplete") {
    if (budgetError?.code === 'MAX_TOKENS') return { ...retryOrFallbackRequest(repository, request, budgetError.message, {
      stage: 'specialist-analysis', stateFamily: request.state_family, errorCode: budgetError.code,
      failedRoles: evaluation.failedRoles || [], analysisBatchId: clean(evaluation.batchId),
      providerDiagnostics: budgetError.diagnostics || {},
    }), evaluation };
    if (budgetError) return { ...fallbackRequest(repository, request, budgetError.message), evaluation };
    const retry = retryOrFallbackRequest(repository, request, evaluation.reason, {
      stage: "specialist-analysis",
      stateFamily: request.state_family,
      failedRoles: Array.isArray(evaluation.failedRoles) ? evaluation.failedRoles : [],
      analysisBatchId: clean(evaluation.batchId),
    });
    return { ...retry, evaluation };
  }

  const resolvedReviewVersion = clean(reviewVersion)
    || REPORTED_STATE_REQUEST_REVIEW_VERSIONS[request.state_family];
  if (review.status !== "ready") {
    if (request.state_family === "preference" && inferredPreference
      && inferredPreference.status !== "review-required"
      && merged.observations.some(item => item.scope?.currentRepresentationLayer === "inferred")
      && !merged.observations.some(item => item.signal.startsWith("explicit_"))) {
      const resolved = repository.resolveStateAnalysisRequest({ agentId: normalizedAgentId, requestId: request.id,
        status: "completed", analysisBatchId: evaluation.batchId,
        metadata: { outcome: inferredPreference.status, preferenceProposalId: inferredPreference.proposal?.id || "" } });
      return { status: inferredPreference.status === "proposal-pending" ? "proposal-pending" : "completed-without-proposal",
        request: resolved, evaluation, merged, review, inferredPreference, preferenceProposal: inferredPreference.proposal, proposal: null };
    }
    const fallback = fallbackRequest(repository, request, clean(review.reason) || "state-analysis-review-rejected");
    return { ...fallback, evaluation, merged, review };
  }
  // The stored narrative must not depend on whether vector matching was enabled.
  const semanticMemory = stateContext?.draft
    || repository.materializeStateAnalysisMemory(normalizedAgentId, request.id);
  const proposalResult = review.status === "ready"
    ? proposeReportedStateFromReview({
      repository,
      reviewResult: review,
      reviewVersion: resolvedReviewVersion,
      batchId: evaluation.batchId,
      metadata: {
        stateAnalysisRequestId: request.id,
        semanticMemoryId: semanticMemory?.id || '',
        ...(semanticMemory ? { semanticMemorySnapshot: { title: semanticMemory.title, content: semanticMemory.content } } : {}),
        processorVersion: STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION,
      },
    })
    : { status: "skipped", reason: review.reason, proposal: null };
  const resolved = repository.resolveStateAnalysisRequest({
    agentId: normalizedAgentId,
    requestId: request.id,
    status: "completed",
    analysisBatchId: evaluation.batchId,
    metadata: {
      processorVersion: STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION,
      outcome: proposalResult.status === "pending" ? "proposal-pending" : "no-proposal",
      reviewStatus: review.status,
      reviewReason: clean(review.reason),
      proposalId: clean(proposalResult.proposal?.id),
    },
  });
  return {
    status: proposalResult.status === "pending" ? "proposal-pending" : "completed-without-proposal",
    reason: clean(proposalResult.reason),
    request: resolved,
    evaluation,
    merged,
    review,
    proposal: proposalResult.proposal,
    inferredPreference,
    preferenceProposal: inferredPreference?.proposal || null,
  };
}

export async function processStateAnalysisRequest(options = {}) {
  try {
    return await processStateAnalysisRequestInternal(options);
  } catch (error) {
    assertEventSourceExecutionCurrent();
    if (!isStateAnalysisBudgetError(error)) throw error;
    const request = options.repository.getStateAnalysisRequest(options.agentId, options.requestId);
    return fallbackRequest(options.repository, request, error.message);
  }
}

export async function processPendingStateAnalysisRequests({
  repository,
  embeddingProvider,
  agentId,
  generator,
  maxRequests,
  usageLedgerPath = "",
  snapshotOptions = {},
  reviewVersion = "",
  preferencePolicy = DEFAULT_PREFERENCE_FORMATION_POLICY,
} = {}) {
  if (!repository) throw new Error("State analysis batch processing requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedMaximum = Number(maxRequests);
  if (!normalizedAgentId) {
    throw new Error("State analysis batch processing requires agentId.");
  }
  if (!Number.isInteger(normalizedMaximum) || normalizedMaximum < 1 || normalizedMaximum > 500) {
    throw new Error("State analysis batch processing requires maxRequests between 1 and 500.");
  }
  if (typeof generator !== "function") {
    throw new Error("State analysis batch processing requires a generator.");
  }

  const requests = repository.listStateAnalysisRequests(normalizedAgentId, {
    statuses: ["pending"],
    stateFamilies: Object.keys(REPORTED_STATE_REQUEST_REVIEW_VERSIONS),
    limit: 500,
  }).filter(supportedRequest).slice(0, normalizedMaximum);
  const results = [];
  for (const request of requests) {
    const attempts = [];
    let result = null;
    do {
      try {
        result = await processStateAnalysisRequest({
          repository,
          embeddingProvider,
          agentId: normalizedAgentId,
          requestId: request.id,
          generator,
          usageLedgerPath,
          snapshotOptions,
          reviewVersion,
          preferencePolicy,
        });
      } catch (error) {
        assertEventSourceExecutionCurrent();
        if (['EVENT_SOURCE_TASK_DEFERRED', 'EVENT_SOURCE_MATERIAL_INELIGIBLE'].includes(error.code)) {
          result = { status: 'deferred', reason: error.message, request };
          break;
        }
        const reason = clean(error?.message) || "state-analysis-request-failed";
        try {
          result = retryOrFallbackRequest(repository, request, reason, {
            stage: "state-analysis-request",
            stateFamily: request.state_family,
            errorCode: clean(error?.code),
            errorName: clean(error?.name),
            providerDiagnostics: error?.diagnostics || {},
          });
        } catch (fallbackError) {
          result = {
            status: "retryable-failure",
            reason: clean(fallbackError?.message) || reason,
            request: repository.getStateAnalysisRequest(normalizedAgentId, request.id),
            evaluation: null,
            merged: null,
            review: null,
            proposal: null,
          };
        }
      }
      attempts.push({
        status: result.status,
        reason: clean(result.reason),
        attemptCount: Number(result.attemptCount || result.request?.metadata?.attemptCount || 0),
        failure: result.failure || null,
      });
    } while (result.status === "retry-pending");
    results.push({
      ...result,
      automaticRetries: Math.max(0, attempts.length - 1),
      attempts,
    });
  }

  const counts = Object.fromEntries([
    "proposal-pending",
    "completed-without-proposal",
    "provisional-review",
    "retry-pending",
    "retryable-failure",
    "blocked",
    "already-resolved",
  ].map((status) => [status, results.filter((result) => result.status === status).length]));
  const unsuccessful = counts["retryable-failure"] + counts.blocked;
  return {
    status: results.length === 0
      ? "empty"
      : unsuccessful > 0
        ? "partial-failure"
        : "completed",
    processorVersion: STATE_ANALYSIS_REQUEST_PROCESSOR_VERSION,
    agentId: normalizedAgentId,
    maxRequests: normalizedMaximum,
    selected: requests.length,
    automaticRetries: results.reduce((sum, result) => sum + result.automaticRetries, 0),
    retriesScheduled: counts["retry-pending"],
    sentToReview: counts["provisional-review"],
    counts,
    results,
  };
}
