import fs from "node:fs";
import path from "node:path";
import { resolveExtractedCandidateIdentity, resolveExtractionParticipant } from '@suzu-memory/extraction';

import { inspectDatabaseBackup } from "./database-backup.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function compactMemory(detail) {
  const memory = detail?.memory || detail;
  if (!memory) return null;
  return {
    id: memory.id,
    kind: memory.kind,
    layer: memory.layer,
    title: clean(memory.title),
    content: clean(memory.content),
    subjectRole: clean(memory.subject_role),
    subjectKey: clean(memory.subject_key),
    canonicalKey: clean(memory.canonical_key),
    representationLayer: clean(memory.representation_layer),
    stateFamily: clean(memory.state_family),
    statePhase: clean(memory.state_phase),
    temporalState: clean(memory.temporal_state),
    status: clean(memory.status),
    confidence: Number(memory.confidence || 0),
    importance: Number(memory.importance || 0),
    eventDate: clean(memory.event_date),
    eventStart: clean(memory.event_start),
    eventEnd: clean(memory.event_end),
    validFrom: clean(memory.valid_from),
    validTo: clean(memory.valid_to),
    knownAt: clean(memory.known_at),
    recordedAt: clean(memory.recorded_at),
    updatedAt: clean(memory.updated_at),
  };
}

function evidenceSource(source, extra = {}) {
  if (!source) return null;
  return {
    id: source.id,
    sourceKind: clean(source.source_kind),
    sourceLocator: clean(source.source_locator),
    externalId: clean(source.external_id),
    speaker: clean(source.speaker),
    content: String(source.content ?? ""),
    occurredAt: clean(source.occurred_at),
    knownAt: clean(source.known_at),
    recordedAt: clean(source.recorded_at),
    worldId: clean(source.world_id),
    worldFrame: clean(source.world_frame),
    ...extra,
  };
}

export function consolidationFailureReviewEnvelope(run) {
  if (!run) return null;
  const memoryIds = [...new Set([
    ...(Array.isArray(run.triggerIds) ? run.triggerIds : []),
    ...(Array.isArray(run.candidateIds) ? run.candidateIds : []),
  ].map(clean).filter(Boolean))];
  return {
    ...run,
    maintenanceFailureKind: "consolidation",
    lane: "semantic",
    task_type: "retrospective-consolidation",
    payload: { memoryIds, runId: run.id },
    result: {
      structureProposalIds: Array.isArray(run.structureProposalIds) ? run.structureProposalIds : [],
      relationProposalIds: Array.isArray(run.relationProposalIds) ? run.relationProposalIds : [],
    },
  };
}

function proposalSummary(type, proposal) {
  if (type === 'event-continuity') return {
    type, id: proposal.id, reviewState: proposal.review_state, title: '确认事件关联', statement: proposal.result?.rationale || '',
    confidence: 0, action: '选择关联或保持独立', subjectRole: '', subjectKey: '', batchId: '',
    createdAt: proposal.created_at, updatedAt: proposal.updated_at,
  };
  const draft = proposal?.draft || {};
  const candidate = proposal?.candidate || {};
  const statement = type === "ingestion"
    ? clean(candidate.content || candidate.title)
    : type === "maintenance-failure"
    ? clean(proposal.error_message)
    : type === "reported-state"
    ? clean(draft.content || draft.title || proposal.target_label || proposal.canonical_key)
    : ["structure", "preference-state"].includes(type)
      ? clean(proposal.content || proposal.title)
      : clean(proposal.rationale || `${proposal.from_memory_id} → ${proposal.to_memory_id}`);
  const title = type === "ingestion"
    ? clean(candidate.title || candidate.stateLabel || candidate.kind) || "记忆升级候选"
    : type === "maintenance-failure"
    ? `${clean(proposal.task_type) || "维护任务"}失败`
    : type === "reported-state"
    ? clean(draft.title || proposal.target_label || proposal.canonical_key) || "人物状态候选"
    : ["structure", "preference-state"].includes(type)
      ? clean(proposal.title) || `${proposal.kind || "高层"}候选`
      : "因果关系候选";
  return {
    type,
    id: proposal.id,
    reviewState: clean(proposal.review_state),
    title,
    statement,
    confidence: Number(proposal.confidence || candidate.confidence || 0),
    action: type === "ingestion"
      ? "human-decision"
      : type === "maintenance-failure"
      ? "human-decision"
      : clean(proposal.action || proposal.operation || proposal.transition || proposal.relation),
    subjectRole: clean(proposal.subject_role || candidate.subjectRole),
    subjectKey: clean(proposal.subject_key || candidate.subjectKey),
    batchId: clean(proposal.batch_id),
    createdAt: clean(proposal.created_at),
    updatedAt: clean(proposal.updated_at),
  };
}

export function resolveIngestionReviewInput(repository, agentId, decision, identityBindings = {}) {
  let candidate = decision?.candidate && typeof decision.candidate === "object" ? decision.candidate : {};
  const provisional = clean(decision?.provisional_memory_id)
    ? repository.getMemory(decision.provisional_memory_id) : null;
  const request = repository.listStateAnalysisRequests(agentId, {
    batchId: decision?.batch_id, limit: 500,
  }).find(item => Number(item.candidate_index) === Number(decision?.candidate_index)) || null;
  const identity = candidate.metadata?.actorIdentity || request?.metadata?.actorIdentity || provisional?.metadata?.actorIdentity || {};
  const identityChoices = new Map();
  function selectedPerson(name, role) {
    const resolved = resolveExtractionParticipant(name, identity.participants);
    if (resolved.status !== 'ambiguous') return { name, role };
    const key = JSON.stringify([role, name]);
    const options = resolved.matches.map(person => ({ value: JSON.stringify([person.actorRole, person.actorKey]),
      name: person.name, actorRole: person.actorRole, actorKey: person.actorKey }));
    identityChoices.set(key, { key, name, role, options });
    const selection = clean(identityBindings?.[key]);
    if (!selection) return { name, role };
    const person = options.find(option => option.value === selection);
    if (!person) throw new Error('Selected person is not an identity candidate for this review.');
    return { name: person.name, role: person.actorRole };
  }
  const subject = selectedPerson(candidate.subjectName, candidate.subjectRole);
  const stateTarget = { ...candidate.stateTarget };
  for (const prefix of ['object', 'counterpart', 'trigger']) {
    if (!stateTarget[`${prefix}Role`]) continue;
    const person = selectedPerson(stateTarget[`${prefix}Name`], stateTarget[`${prefix}Role`]);
    stateTarget[`${prefix}Name`] = person.name;
    stateTarget[`${prefix}Role`] = person.role;
  }
  candidate = { ...candidate, subjectName: subject.name, subjectRole: subject.role,
    ...(candidate.stateTarget ? { stateTarget } : {}),
    actorRoles: (candidate.actorRoles || []).map(actor => {
      const person = selectedPerson(actor.actorName, actor.actorRole);
      return { ...actor, actorName: person.name, actorRole: person.role };
    }) };
  for (const key of Object.keys(identityBindings || {})) {
    if (!identityChoices.has(key)) throw new Error('Unknown identity binding for this review.');
  }
  const resolved = resolveExtractedCandidateIdentity(candidate, agentId, identity);
  const subjectRole = clean(candidate.subjectRole || request?.subject_role || provisional?.subject_role);
  const subjectKey = clean(candidate.subjectKey || request?.subject_key || provisional?.subject_key || resolved.subjectKey);
  const storedRoles = provisional ? repository.listMemoryRoles(provisional.id) : [];
  const actorRoles = resolved.actorRoles.map((actor, index) => {
    const original = candidate.actorRoles[index];
    const stored = storedRoles.find(value => value.role === actor.role && value.actor_role === actor.actorRole
      && clean(value.metadata?.actorName) && clean(value.metadata.actorName) === clean(actor.metadata?.actorName));
    const isSubject = actor.actorRole === subjectRole && clean(actor.metadata?.actorName)
      && clean(actor.metadata.actorName) === clean(candidate.subjectName);
    return { ...actor, actorKey: clean(original?.actorKey || stored?.actor_key || (isSubject ? subjectKey : '') || actor.actorKey) };
  });
  for (const observer of storedRoles.filter(role => role.role === 'observer')) {
    if (!actorRoles.some(role => role.role === 'observer' && role.actorRole === observer.actor_role && role.actorKey === observer.actor_key)) {
      actorRoles.push({ role: 'observer', actorRole: observer.actor_role, actorKey: observer.actor_key,
        confidence: observer.confidence, metadata: observer.metadata, provenance: observer.provenance });
    }
  }
  return { request, identityChoices: [...identityChoices.values()], candidate: {
    ...candidate, subjectRole, subjectKey, actorRoles,
    metadata: { ...candidate.metadata, ...(Object.keys(identityBindings || {}).length ? { humanIdentityBindings: identityBindings } : {}) },
    canonicalKey: clean(request?.canonical_key || candidate.canonicalKey || provisional?.canonical_key),
    representationLayer: clean(candidate.representationLayer || request?.representation_layer
      || provisional?.representation_layer) || undefined,
  } };
}

function ingestionReviewDetail(repository, agentId, decision) {
  const { candidate, request, identityChoices } = resolveIngestionReviewInput(repository, agentId, decision);
  const provisional = memoryDetail(repository, agentId, decision.provisional_memory_id);
  const evidence = uniqueEvidence((decision.sourceIds || []).map((sourceId) => (
    evidenceSource(sourceById(repository, agentId, sourceId), { kind: "source" })
  )).filter(Boolean));
  return {
    identityChoices,
    writePreview: {
      kind: clean(candidate.kind),
      title: clean(candidate.title || candidate.stateLabel),
      content: clean(candidate.content),
      stateFamily: clean(candidate.stateFamily),
      subjectRole: clean(candidate.subjectRole),
      subjectKey: clean(candidate.subjectKey),
      canonicalKey: clean(candidate.canonicalKey),
      evidenceMode: clean(candidate.evidenceMode),
      temporalState: clean(candidate.temporalState),
    },
    currentState: null,
    observations: [],
    evidence,
    members: [...(provisional ? [{
      memory: compactMemory(provisional),
      evidence,
    }] : []), ...(request?.metadata?.stateCandidateIds || []).map(id => {
      const detail = memoryDetail(repository, agentId, id);
      return detail ? { memory: compactMemory(detail), evidence: (detail.sources || [])
        .map(source => evidenceSource(source, { kind: 'source', memoryId: id })) } : null;
    }).filter(Boolean)],
    endpoints: null,
    maintenanceFailure: request ? {
      lastError: clean(request.error_message || request.metadata?.lastFailure?.error),
      history: Array.isArray(request.metadata?.failureHistory)
        ? request.metadata.failureHistory
        : [],
    } : null,
    stateAnalysisRequest: request,
  };
}

function maintenanceFailureDetail(repository, agentId, task) {
  const memoryIds = [...new Set(
    (Array.isArray(task.payload?.memoryIds) ? task.payload.memoryIds : []).map(clean).filter(Boolean),
  )];
  const members = memoryIds.map((memoryId) => {
    const detail = memoryDetail(repository, agentId, memoryId);
    return detail ? {
      memory: compactMemory(detail),
      evidence: (detail.sources || []).map((source) => evidenceSource(source, {
        kind: "source",
        memoryId,
      })),
    } : null;
  }).filter(Boolean);
  const inputEventIds = [...new Set(
    (Array.isArray(task.payload?.inputEventIds)
      ? task.payload.inputEventIds
      : Array.isArray(task.payload?.eventIds) ? task.payload.eventIds : [])
      .map(clean)
      .filter(Boolean),
  )];
  const inputEventEvidence = inputEventIds.map((eventId) => {
    const event = repository.getInputEvent(agentId, eventId);
    if (!event) return null;
    return {
      id: event.id,
      kind: "input-event",
      sourceKind: "input-event",
      sourceLocator: clean(event.source?.locator),
      externalId: clean(event.external_id),
      speaker: clean(event.content?.speaker || event.participants?.[0]?.name),
      content: String(event.content?.text ?? ""),
      occurredAt: clean(event.occurred_at),
      knownAt: clean(event.known_at),
      recordedAt: clean(event.recorded_at),
      worldId: clean(event.world_id),
      worldFrame: clean(event.world_frame),
      quarantine: event.metadata?.suzuMemoryProcessing?.quarantine || null,
    };
  }).filter(Boolean);
  const reviewableFailures = (Array.isArray(task.result?.failures) ? task.result.failures : [])
    .filter((failure) => clean(failure?.candidate?.context));
  const firstCandidate = reviewableFailures[0]?.candidate || null;
  const consolidationProposalIds = task.maintenanceFailureKind === "consolidation"
    ? [...new Set([
      ...(Array.isArray(task.result?.structureProposalIds) ? task.result.structureProposalIds : []),
      ...(Array.isArray(task.result?.relationProposalIds) ? task.result.relationProposalIds : []),
    ].map(clean).filter(Boolean))]
    : [];
  return {
    writePreview: {
      kind: clean(task.task_type) === "long-term-extraction"
        ? "long-term-extraction"
        : firstCandidate
        ? "human-reviewed-retrieval-context"
        : inputEventIds.length
          ? "input-event-quarantine"
        : consolidationProposalIds.length
          ? "retrospective-consolidation-partial-output"
          : "maintenance-failure",
      title: clean(task.task_type) || "维护任务",
      content: clean(firstCandidate?.context) || clean(task.error_message) || "未记录失败原因",
      lane: clean(task.lane),
      attempts: `${Number(task.attempt_count || 0)}/${Number(task.max_attempts || 0)}`,
      failedItems: task.maintenanceFailureKind === "consolidation"
        ? 1
        : Array.isArray(task.result?.failures) ? task.result.failures.length : 0,
      partialProposalIds: consolidationProposalIds,
      queryTerms: Array.isArray(firstCandidate?.queryTerms)
        ? firstCandidate.queryTerms.join("；")
        : "",
    },
    currentState: null,
    observations: [],
    evidence: uniqueEvidence([
      ...members.flatMap((item) => item.evidence),
      ...inputEventEvidence,
    ]),
    members,
    endpoints: null,
    reviewableCandidateCount: reviewableFailures.length
      + consolidationProposalIds.length
      + inputEventIds.length,
    maintenanceFailure: {
      lastError: clean(task.error_message),
      history: Array.isArray(task.failureHistory) ? task.failureHistory : [],
      canRetryLongTermExtraction: clean(task.task_type) === "long-term-extraction"
        && task.status === "failed"
        && task.review_state === "pending"
        && inputEventIds.length > 0,
    },
  };
}

function eventContinuityReviewDetail(repository, agentId, task) {
  const current = memoryDetail(repository, agentId, task.payload.memoryId);
  const candidates = task.payload.candidateIds.map(id => memoryDetail(repository, agentId, id)).filter(Boolean);
  return {
    writePreview: { title: current?.memory.title || '事件关联', content: current?.memory.content || '', rationale: task.result.rationale },
    eventContinuity: { candidates: candidates.map(detail => compactMemory(detail)) },
    currentState: null, observations: [], endpoints: null,
    members: candidates.map(detail => ({ memory: compactMemory(detail), evidence: detail.sources.map(source => evidenceSource(source)) })),
    evidence: uniqueEvidence([current, ...candidates].filter(Boolean).flatMap(detail => detail.sources.map(source => evidenceSource(source)))),
  };
}

function memoryDetail(repository, agentId, memoryId) {
  const id = clean(memoryId);
  return id ? repository.getMemoryDetail(agentId, id) : null;
}

function sourceById(repository, agentId, sourceId) {
  const source = repository.getSource(clean(sourceId));
  return source?.agent_id === agentId ? source : null;
}

function uniqueEvidence(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (!item?.id) return false;
    const key = `${item.kind || "source"}:${item.id}:${item.observationId || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function reportedStateDetail(repository, agentId, proposal) {
  const previous = memoryDetail(repository, agentId, proposal.previousMemoryId);
  const pendingId = repository.database.prepare(`SELECT id FROM memory_nodes
    WHERE agent_id = ? AND layer = 'provisional'
      AND json_extract(metadata_json, '$.reportedStateProposalId') = ? LIMIT 1`).get(agentId, proposal.id)?.id;
  const pending = pendingId ? repository.getMemory(pendingId) : null;
  const observations = (proposal.consideredObservationIds || []).map((observationId) => {
    const observation = repository.getStateEvidenceObservation(agentId, observationId);
    if (!observation) return null;
    const memory = memoryDetail(repository, agentId, observation.memory_id);
    const sources = (observation.sourceIds || []).map((sourceId) => (
      evidenceSource(sourceById(repository, agentId, sourceId), {
        kind: "source",
        observationId,
        selected: observationId === proposal.selectedObservationId,
      })
    )).filter(Boolean);
    return {
      id: observation.id,
      selected: observation.id === proposal.selectedObservationId,
      signal: clean(observation.signal),
      direction: clean(observation.effective_direction),
      qualification: clean(observation.qualification),
      confidence: Number(observation.confidence || 0),
      memory: compactMemory(memory),
      sources,
      payload: observation.payload,
    };
  }).filter(Boolean);
  return {
    writePreview: {
      kind: clean(pending?.kind || proposal.draft?.kind),
      title: clean(pending?.title || proposal.draft?.title),
      content: clean(pending?.content || proposal.draft?.content),
      stateFamily: clean(proposal.state_family),
      statePhase: clean(pending?.state_phase || proposal.state_phase),
      temporalState: clean(pending?.temporal_state || proposal.temporal_state),
      subjectRole: clean(proposal.subject_role),
      subjectKey: clean(proposal.subject_key),
      canonicalKey: clean(proposal.canonical_key),
      targetScopeKey: clean(proposal.targetScopeKey),
      proposedScopeKey: clean(proposal.proposedScopeKey),
      action: clean(proposal.action),
    },
    currentState: compactMemory(previous),
    appliedBeforeReview: Boolean(pending?.metadata?.reportedStateTransition),
    observations,
    evidence: uniqueEvidence(observations.flatMap((item) => item.sources)),
    members: [],
    endpoints: null,
  };
}

function structureDetail(repository, agentId, proposal) {
  const members = (proposal.memberIds || []).map((memoryId) => {
    const detail = memoryDetail(repository, agentId, memoryId);
    return detail ? {
      memory: compactMemory(detail),
      evidence: (detail.sources || []).map((source) => evidenceSource(source, {
        kind: "source",
        memoryId,
      })),
    } : null;
  }).filter(Boolean);
  return {
    writePreview: {
      kind: clean(proposal.kind),
      title: clean(proposal.title),
      content: clean(proposal.content),
      subjectRole: clean(proposal.subject_role),
      subjectKey: clean(proposal.subject_key),
      eventDate: clean(proposal.event_date),
      eventStart: clean(proposal.event_start),
      eventEnd: clean(proposal.event_end),
      operation: clean(proposal.operation),
    },
    currentState: compactMemory(memoryDetail(repository, agentId, proposal.targetMemoryId)),
    observations: [],
    evidence: uniqueEvidence(members.flatMap((item) => item.evidence)),
    members,
    endpoints: null,
  };
}

function preferenceDetail(repository, agentId, proposal) {
  const observations = (proposal.evidence || []).map(item => {
    const detail = memoryDetail(repository, agentId, item.memoryId);
    return { id: item.memoryId, signal: item.signal, direction: item.direction, confidence: item.confidence,
      memory: compactMemory(detail), payload: item.label,
      sources: (detail?.sources || []).filter(source => item.sourceIds.includes(source.id))
        .map(source => evidenceSource(source, { kind: "source", memoryId: item.memoryId })) };
  });
  return {
    writePreview: { kind: proposal.proposed_kind, title: proposal.title, content: proposal.content,
      stateFamily: "preference", representationLayer: proposal.representation_layer,
      proposedLevel: proposal.proposed_level, subjectRole: proposal.subject_role, subjectKey: proposal.subject_key,
      canonicalKey: proposal.canonical_key, action: proposal.transition },
    currentState: compactMemory(memoryDetail(repository, agentId, proposal.previousMemoryId)),
    observations, evidence: uniqueEvidence(observations.flatMap(item => item.sources)), members: [], endpoints: null,
  };
}

function relationDetail(repository, agentId, proposal) {
  const from = memoryDetail(repository, agentId, proposal.from_memory_id);
  const to = memoryDetail(repository, agentId, proposal.to_memory_id);
  return {
    writePreview: {
      relation: clean(proposal.relation),
      direction: clean(proposal.direction),
      fromMemoryId: clean(proposal.from_memory_id),
      toMemoryId: clean(proposal.to_memory_id),
      weight: Number(proposal.weight || 0),
      rationale: clean(proposal.rationale),
    },
    currentState: null,
    observations: [],
    evidence: uniqueEvidence((proposal.evidence || []).map((source) => evidenceSource(source, {
      kind: "source",
      endpointCoverage: clean(source.endpointCoverage),
    }))),
    members: [],
    endpoints: {
      from: compactMemory(from),
      to: compactMemory(to),
    },
  };
}

export function buildReviewProposalDetail({ repository, agentId, envelope }) {
  if (!repository || !clean(agentId) || !envelope?.proposal) {
    throw new Error("Review proposal detail requires repository, agentId, and proposal.");
  }
  const type = clean(envelope.type);
  const proposal = envelope.proposal;
  const detail = type === 'event-continuity'
    ? eventContinuityReviewDetail(repository, agentId, proposal)
    : type === "ingestion"
    ? ingestionReviewDetail(repository, agentId, proposal)
    : type === "maintenance-failure"
    ? maintenanceFailureDetail(repository, agentId, proposal)
    : type === "reported-state"
    ? reportedStateDetail(repository, agentId, proposal)
    : type === "preference-state"
    ? preferenceDetail(repository, agentId, proposal)
    : type === "structure"
      ? structureDetail(repository, agentId, proposal)
      : relationDetail(repository, agentId, proposal);
  const canRetryLongTermExtraction = Boolean(detail.maintenanceFailure?.canRetryLongTermExtraction);
  return {
    ...proposalSummary(type, proposal),
    proposal,
    ...detail,
    permissions: {
      canAccept: proposal.review_state === "pending"
        && (type !== "maintenance-failure"
          || (detail.reviewableCandidateCount > 0 && !canRetryLongTermExtraction)),
      canDismiss: proposal.review_state === "pending",
      canRevoke: type === "relation" && proposal.review_state === "accepted",
      canRetryLongTermExtraction,
    },
  };
}

function activeDatabaseHealth(database, databasePath) {
  const rows = database.prepare("PRAGMA quick_check").all();
  const messages = rows.map((row) => String(Object.values(row)[0] ?? ""));
  const valid = messages.length === 1 && messages[0].toLowerCase() === "ok";
  return {
    status: valid ? "valid" : "invalid",
    databasePath,
    bytes: fs.existsSync(databasePath) ? fs.statSync(databasePath).size : 0,
    messages,
  };
}

function latestBackupHealth(backupDirectory, agentId) {
  if (!fs.existsSync(backupDirectory)) {
    return { status: "missing", total: 0, latest: null };
  }
  const files = fs.readdirSync(backupDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".db"))
    .map((entry) => {
      const filePath = path.join(backupDirectory, entry.name);
      return { filePath, modifiedAt: fs.statSync(filePath).mtime.toISOString() };
    })
    .sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  if (!files.length) return { status: "missing", total: 0, latest: null };
  try {
    const inspected = inspectDatabaseBackup(files[0].filePath);
    const expectedAgent = clean(agentId);
    const recordedAgents = new Set([
      clean(inspected.agentId),
      ...(Array.isArray(inspected.agentIds) ? inspected.agentIds.map(clean) : []),
    ].filter(Boolean));
    const agentMatches = !expectedAgent || !recordedAgents.size || [...recordedAgents].every(
      (item) => item === expectedAgent,
    );
    return {
      status: agentMatches ? "valid" : "agent-mismatch",
      total: files.length,
      latest: { ...inspected, modifiedAt: files[0].modifiedAt },
    };
  } catch (error) {
    return {
      status: "invalid",
      total: files.length,
      latest: {
        databasePath: files[0].filePath,
        modifiedAt: files[0].modifiedAt,
        error: error.message,
        code: clean(error.code) || "BACKUP_INSPECTION_FAILED",
      },
    };
  }
}

export function inspectReviewConsoleStorage({
  database,
  databasePath,
  backupDirectory,
  agentId,
}) {
  return {
    activeDatabase: activeDatabaseHealth(database, databasePath),
    backups: latestBackupHealth(backupDirectory, agentId),
  };
}

export function reviewProposalSummary(envelope) {
  return proposalSummary(envelope.type, envelope.proposal);
}
