import { createHash } from "node:crypto";
import { enqueueMemoryMaintenanceTasks, MAINTENANCE_TASK_TYPES } from './maintenance-tasks.mjs';
import { OrganizationCandidateError, OrganizationInputChangedError } from './organization-error.mjs';
import { readOrganizationInput, assertOrganizationInputCurrent, organizationInputIsCurrent } from './organization-input.mjs';
import { expectedStructureSummary, structureSummaryMaterial, readStructureSummaryMaterial } from './structure-provenance.mjs';
import { enqueueStructureSummaryRefresh } from './organization-invalidation.mjs';

import {
  MEMORY_ACTOR_ROLES,
  SUBJECT_ROLES,
  memoryWorldsCompatible,
} from "./ontology.mjs";

function clean(value) {
  return String(value ?? "").trim();
}

function bounded(value, fallback, minimum = 0, maximum = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function validIsoDate(value) {
  const text = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) return false;
  const parsed = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text;
}

function validTimestamp(value) {
  return Number.isFinite(Date.parse(clean(value)));
}

function normalizeActorRoles(values) {
  const roles = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const role = clean(value?.role);
    const actorRole = clean(value?.actorRole ?? value?.actor_role);
    const actorKey = clean(value?.actorKey ?? value?.actor_key);
    if (!MEMORY_ACTOR_ROLES.includes(role)) {
      throw new OrganizationCandidateError(`Unknown memory actor role: ${role || "(empty)"}.`);
    }
    if (!SUBJECT_ROLES.includes(actorRole)) {
      throw new OrganizationCandidateError(`Unknown actor identity role: ${actorRole || "(empty)"}.`);
    }
    if (!["world", "unknown"].includes(actorRole) && !actorKey) {
      throw new OrganizationCandidateError("Memory actor role requires actorKey.");
    }
    const key = `${role}\u001f${actorRole}\u001f${actorKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    roles.push({
      role,
      actorRole,
      actorKey,
      isPrimary: Boolean(value?.isPrimary ?? value?.is_primary),
      confidence: bounded(value?.confidence, 1),
      provenance: clean(value?.provenance),
      metadata: value?.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
        ? value.metadata
        : {},
    });
  }
  return roles.sort((left, right) => (
    left.role.localeCompare(right.role)
    || left.actorRole.localeCompare(right.actorRole)
    || left.actorKey.localeCompare(right.actorKey)
  ));
}

function validateMembers(repository, {
  agentId,
  kind,
  memberIds,
  minimum = 2,
  targetMemoryId = "",
}) {
  const ids = [...new Set(
    (Array.isArray(memberIds) ? memberIds : []).map(clean).filter(Boolean),
  )];
  if (ids.length < minimum) {
    throw new OrganizationCandidateError(`A structure proposal requires at least ${minimum} distinct member${minimum === 1 ? "" : "s"}.`);
  }
  if (clean(targetMemoryId) && ids.includes(clean(targetMemoryId))) {
    throw new OrganizationCandidateError("A structure target cannot also be one of its members.");
  }
  const members = ids.map((id) => repository.getMemory(id));
  if (members.some((memory) => !memory || memory.agent_id !== agentId)) {
    throw new OrganizationCandidateError("Every proposed member must exist for the same Agent.");
  }
  if (members.some((memory) => memory.status === "deleted")) {
    throw new OrganizationCandidateError("Deleted memories cannot become structure proposal members.");
  }
  if (
    kind === "episode"
    && members.some((memory) => ["episode", "topic", "topic_or_episode"].includes(memory.kind))
  ) {
    throw new OrganizationCandidateError("An episode proposal can contain only concrete memories.");
  }
  if (
    kind === "topic"
    && members.some((memory) => ["topic", "topic_or_episode"].includes(memory.kind))
  ) {
    throw new OrganizationCandidateError("A topic proposal cannot contain another topic.");
  }
  return members;
}

function existingMembershipIds(repository, { agentId, kind, targetMemoryId }) {
  if (!clean(targetMemoryId)) return new Set();
  const statuses = ["active", "superseded", "disputed", "archived"];
  const members = kind === "episode"
    ? repository.listEpisodeMembers({ agentId, episodeId: targetMemoryId, statuses })
    : repository.listTopicMembers({ agentId, topicId: targetMemoryId, statuses });
  return new Set(members.map((memory) => memory.id));
}

function structureScope(members, target = null) {
  const origin = target || members[0];
  if (members.some(member => !memoryWorldsCompatible(origin, member))) {
    throw new OrganizationCandidateError("Structure members and target must share their reality and world scope.");
  }
  return { reality: origin.reality, worldId: origin.world_id, worldFrame: origin.world_frame };
}

// Organizing existing information does not make it newly learned. A container
// becomes knowable when its latest member does; recorded_at tracks storage.
export function structureKnownAt(members) {
  const times = members.map(member => [member.known_at, member.recorded_at]
    .map(value => Date.parse(value || '')).find(Number.isFinite));
  return times.length && times.every(Number.isFinite)
    ? new Date(Math.max(...times)).toISOString() : null;
}

function validateAttachTarget(repository, { agentId, kind, targetMemoryId }) {
  const target = repository.getMemory(clean(targetMemoryId));
  if (!target || target.agent_id !== agentId) {
    throw new OrganizationCandidateError("Attach proposal target must exist for the same Agent.");
  }
  if (target.status !== "active" || target.kind !== kind) {
    throw new OrganizationCandidateError(`Attach proposal target must be an active ${kind} node.`);
  }
  return target;
}

function normalizeProposal(repository, input = {}, { requireSummary = true } = {}) {
  if (!repository) throw new Error("Structure proposal requires a repository.");
  const agentId = clean(input.agentId);
  const operation = clean(input.operation) || "create";
  const targetMemoryId = clean(input.targetMemoryId ?? input.target_memory_id);
  const kind = clean(input.kind);
  if (!agentId || !["create", "attach"].includes(operation) || !["episode", "topic"].includes(kind)) {
    throw new OrganizationCandidateError("Structure proposal requires agentId, create/attach operation, and episode/topic kind.");
  }
  if (operation === "create" && targetMemoryId) {
    throw new OrganizationCandidateError("Create proposal cannot reference an existing target.");
  }
  if (operation === "attach" && !targetMemoryId) {
    throw new OrganizationCandidateError("Attach proposal requires targetMemoryId.");
  }

  if (input.expectedInput) assertOrganizationInputCurrent(repository, agentId, input.expectedInput);
  const target = operation === "attach"
    ? validateAttachTarget(repository, { agentId, kind, targetMemoryId })
    : null;
  let memberIds = [...new Set(
    (Array.isArray(input.memberIds) ? input.memberIds : []).map(clean).filter(Boolean),
  )];
  const members = validateMembers(repository, {
    agentId,
    kind,
    memberIds,
    minimum: operation === "attach" ? 1 : 2,
    targetMemoryId,
  });
  structureScope(members, target);
  let existing = new Set();
  if (target) {
    if (input.expectedTarget && (target.title !== input.expectedTarget.title || target.content !== input.expectedTarget.content)) {
      throw new OrganizationInputChangedError('Structure target summary changed after generation; regenerate from its current summary.');
    }
    existing = existingMembershipIds(repository, { agentId, kind, targetMemoryId });
    if (input.expectedTarget?.memberIds && (existing.size !== input.expectedTarget.memberIds.length
      || input.expectedTarget.memberIds.some(id => !existing.has(id)))) {
      throw new OrganizationInputChangedError('Structure target members changed after generation; regenerate from its current members.');
    }
    memberIds = memberIds.filter((id) => !existing.has(id));
    if (!memberIds.length) {
      throw new OrganizationCandidateError("Attach proposal must add at least one new member.", 'MEMORY_STRUCTURE_NO_NEW_MEMBERS');
    }
  }
  const content = clean(input.content) || target?.content || '';
  const title = clean(input.title) || target?.title || '';
  const summaryChange = target && (title !== target.title || content !== target.content) ? {
    structureSummaryBefore: { title: target.title, content: target.content,
      material: readStructureSummaryMaterial(repository, target),
      proposalId: target.metadata?.structureSummaryProposalId || '' },
  } : {};
  const subjectRole = target ? target.subject_role : clean(input.subjectRole) || "unknown";
  const subjectKey = target ? target.subject_key : clean(input.subjectKey);
  const eventDate = target ? clean(target.event_date) : clean(input.eventDate);
  const eventStart = target ? clean(target.event_start) : clean(input.eventStart);
  const eventEnd = target ? clean(target.event_end) : clean(input.eventEnd);
  const actorRoles = target
    ? normalizeActorRoles(repository.listMemoryRoles(target.id))
    : normalizeActorRoles(input.actorRoles);
  const primarySubjects = actorRoles.filter(actor => actor.role === 'subject' && actor.isPrimary);
  if (primarySubjects.length > 1 || primarySubjects.some(actor => actor.actorRole !== subjectRole || actor.actorKey !== subjectKey)) {
    throw new OrganizationCandidateError('A primary subject in actorRoles must match subjectRole and subjectKey.', 'MEMORY_STRUCTURE_INVALID_SUBJECT');
  }
  if (requireSummary && !content) throw new OrganizationCandidateError("Structure proposal content cannot be empty.");
  if (!SUBJECT_ROLES.includes(subjectRole)) {
    throw new OrganizationCandidateError(`Unknown structure subject role: ${subjectRole}.`);
  }
  if (!["world", "unknown"].includes(subjectRole) && !subjectKey) {
    throw new OrganizationCandidateError("Structure proposal subject requires subjectKey.");
  }
  if (kind === "episode") {
    if (eventDate && !validIsoDate(eventDate)) {
      throw new OrganizationCandidateError("Episode proposal eventDate must be a valid YYYY-MM-DD date.");
    }
    if (eventStart && !validTimestamp(eventStart)) {
      throw new OrganizationCandidateError("Episode proposal eventStart must be a valid timestamp.");
    }
    if (eventEnd && !validTimestamp(eventEnd)) {
      throw new OrganizationCandidateError("Episode proposal eventEnd must be a valid timestamp.");
    }
    if (eventEnd && !eventStart) {
      throw new OrganizationCandidateError("Episode proposal eventEnd requires eventStart.");
    }
    if (eventStart && eventEnd && Date.parse(eventEnd) < Date.parse(eventStart)) {
      throw new OrganizationCandidateError("Episode proposal eventEnd cannot be before eventStart.");
    }
  } else if (eventDate || eventStart || eventEnd) {
    throw new OrganizationCandidateError("Topic proposal cannot carry event time.");
  }
  return {
    agentId,
    batchId: clean(input.batchId),
    operation,
    targetMemoryId: target?.id || "",
    kind,
    title,
    content,
    subjectRole,
    subjectKey,
    eventDate: eventDate || null,
    eventStart: eventStart || null,
    eventEnd: eventEnd || null,
    memberIds,
    actorRoles,
    confidence: bounded(input.confidence, 0.5),
    rationale: clean(input.rationale),
    provenance: clean(input.provenance) || "structure-proposal-v1",
    metadata: { ...(input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : {}),
      ...summaryChange, organizationInput: readOrganizationInput(repository, agentId, [...memberIds, ...existing]) },
    createdAt: clean(input.createdAt) || new Date().toISOString(),
  };
}

function proposalHash(candidate) {
  return createHash("sha256").update(JSON.stringify({
    operation: candidate.operation,
    targetMemoryId: candidate.targetMemoryId,
    kind: candidate.kind,
    title: candidate.title,
    content: candidate.content,
    subjectRole: candidate.subjectRole,
    subjectKey: candidate.subjectKey,
    eventDate: candidate.eventDate,
    eventStart: candidate.eventStart,
    eventEnd: candidate.eventEnd,
    memberIds: [...candidate.memberIds].sort(),
    actorRoles: candidate.actorRoles.map((actor) => ({
      role: actor.role,
      actorRole: actor.actorRole,
      actorKey: actor.actorKey,
      isPrimary: actor.isPrimary,
    })),
    inputHash: candidate.metadata.organizationInput.hash,
  })).digest("hex");
}

function findWithdrawnStructure(repository, candidate) {
  return repository.database.prepare(`SELECT id FROM memory_structure_proposals
    WHERE agent_id=? AND operation=? AND target_memory_id IS ? AND kind=? AND subject_role=? AND subject_key=?
      AND review_state='dismissed' AND resolved_by NOT LIKE 'system:%'
      AND (json_extract(metadata_json, '$.organizationInput.hash')=?
        OR json_type(metadata_json, '$.organizationInput') IS NULL)
      AND json_array_length(member_ids_json)=? AND NOT EXISTS (
        SELECT 1 FROM json_each(member_ids_json) member WHERE member.value NOT IN (SELECT value FROM json_each(?)))
    ORDER BY resolved_at DESC, id LIMIT 1`).get(candidate.agentId, candidate.operation, candidate.targetMemoryId || null,
    candidate.kind, candidate.subjectRole, candidate.subjectKey, candidate.metadata.organizationInput.hash,
    candidate.memberIds.length, JSON.stringify(candidate.memberIds));
}

function pendingStructureMetadata(proposal) {
  const { organizationInput, structureSummaryBefore, ...metadata } = proposal.metadata;
  return {
    ...metadata,
    structureProposalId: proposal.id,
    structureProposalProvenance: proposal.provenance,
    structureReviewState: "pending",
    structureSummaryMaterial: structureSummaryMaterial(proposal.title, proposal.content, proposal.memberIds, organizationInput),
  };
}

function pendingMembershipMetadata(proposal) {
  return {
    structureProposalId: proposal.id,
    structureReviewState: "pending",
  };
}

function linkProposalMember(repository, {
  agentId,
  proposal,
  memoryId,
  containerId,
  metadata,
}) {
  const linkOptions = {
    agentId,
    memoryId,
    confidence: proposal.confidence,
    provenance: proposal.provenance,
    metadata,
  };
  return proposal.kind === "episode"
    ? repository.linkMemoryToEpisode({ ...linkOptions, episodeId: containerId })
    : repository.linkMemoryToTopic({ ...linkOptions, topicId: containerId });
}

function proposalMembers(repository, { agentId, kind, memoryId }) {
  return kind === "episode"
    ? repository.listEpisodeMembers({ agentId, episodeId: memoryId })
    : repository.listTopicMembers({ agentId, topicId: memoryId });
}

function proposalResultMemory(repository, proposal) {
  const memory = repository.getMemory(proposal.result_memory_id);
  if (!memory || memory.agent_id !== proposal.agent_id || memory.kind !== proposal.kind) {
    throw new Error("Structure proposal points to an invalid result memory.");
  }
  if (memory.status === "deleted") {
    throw new Error("Structure proposal result memory was deleted before review.");
  }
  return memory;
}

export function materializeMemoryStructureProposal(repository, {
  agentId,
  proposalId,
} = {}) {
  if (!repository) throw new Error("Materializing a structure proposal requires a repository.");
  const normalizedAgentId = clean(agentId);
  const proposal = repository.getStructureProposal(normalizedAgentId, proposalId);
  if (!proposal) throw new Error("Structure proposal does not exist for this Agent.");
  if (proposal.review_state !== "pending") {
    throw new Error(`Only a pending structure proposal can be materialized; it is ${proposal.review_state}.`);
  }
  // A completed legacy write already has a result and owned membership. A
  // proposal that has never been applied still needs its original input version.
  if (!proposal.result_memory_id || proposal.metadata.organizationInput) {
    assertOrganizationInputCurrent(repository, normalizedAgentId, proposal.metadata.organizationInput);
  }
  const target = proposal.operation === "attach"
    ? validateAttachTarget(repository, {
      agentId: normalizedAgentId,
      kind: proposal.kind,
      targetMemoryId: proposal.targetMemoryId,
    })
    : null;
  const members = validateMembers(repository, {
    agentId: normalizedAgentId,
    kind: proposal.kind,
    memberIds: proposal.memberIds,
    minimum: proposal.operation === "attach" ? 1 : 2,
    targetMemoryId: proposal.targetMemoryId,
  });
  const scope = structureScope(members, target);
  if (proposal.result_memory_id) {
    const memory = proposalResultMemory(repository, proposal);
    structureScope(members, memory);
    if (!proposal.metadata.organizationInput) {
      const ownsResult = proposal.operation === 'attach' ? proposal.targetMemoryId === memory.id
        : memory.metadata?.structureProposalId === proposal.id;
      const linked = existingMembershipIds(repository, { agentId: normalizedAgentId, kind: proposal.kind, targetMemoryId: memory.id });
      if (!ownsResult || memory.status !== 'active' || members.some(member => !linked.has(member.id))) {
        throw new OrganizationInputChangedError('The legacy structure result and its membership can no longer be verified.');
      }
    }
    return {
      status: "already-materialized",
      proposal,
      memory,
      addedMemberIds: [],
      members: proposalMembers(repository, {
        agentId: normalizedAgentId,
        kind: proposal.kind,
        memoryId: memory.id,
      }),
    };
  }

  return repository.transaction(() => {
    const withdrawn = findWithdrawnStructure(repository, { ...proposal, agentId: normalizedAgentId,
      subjectRole: proposal.subject_role, subjectKey: proposal.subject_key });
    if (withdrawn) return { status: 'withdrawn', memory: null, addedMemberIds: [], members: [],
      proposal: repository.resolveStructureProposal({ agentId: normalizedAgentId, proposalId: proposal.id,
        resolution: 'dismissed', resolvedBy: 'system:structure-recovery', note: `Grouping was withdrawn as ${withdrawn.id}.` }) };
    const summaryBefore = proposal.metadata.structureSummaryBefore;
    if (target && summaryBefore && (target.title !== summaryBefore.title || target.content !== summaryBefore.content)) {
      throw new OrganizationInputChangedError('Structure target summary changed before this attachment could be applied.');
    }
    const knownAt = structureKnownAt(members);
    if (!knownAt) throw new OrganizationCandidateError('Structure members require a valid known or recorded time.');
    const common = {
      ...scope,
      agentId: normalizedAgentId,
      title: proposal.title,
      content: proposal.content,
      subjectRole: proposal.subject_role,
      subjectKey: proposal.subject_key,
      actorRoles: proposal.actorRoles,
      confidence: proposal.confidence,
      evidenceMode: "inferred",
      knownAt,
      metadata: pendingStructureMetadata(proposal),
    };
    let memory = target || (proposal.kind === "episode"
      ? repository.upsertEpisode({
        ...common,
        eventDate: proposal.event_date,
        eventStart: proposal.event_start,
        eventEnd: proposal.event_end,
      })
      : repository.upsertTopic(common));
    const existing = target
      ? existingMembershipIds(repository, {
        agentId: normalizedAgentId,
        kind: proposal.kind,
        targetMemoryId: target.id,
      })
      : new Set();
    const addedMemberIds = [];
    for (const member of members) {
      if (existing.has(member.id)) continue;
      linkProposalMember(repository, {
        agentId: normalizedAgentId,
        proposal,
        memoryId: member.id,
        containerId: memory.id,
        metadata: pendingMembershipMetadata(proposal),
      });
      addedMemberIds.push(member.id);
    }
    if (target && proposal.kind === "episode") {
      memory = repository.expandEpisodeToMemories({
        agentId: normalizedAgentId,
        episodeId: target.id,
        memoryIds: members.map((member) => member.id),
      });
    }
    if (target) {
      const allMembers = repository.listContainerMembers({
        agentId: normalizedAgentId, containerKind: proposal.kind, containerId: target.id,
        relation: proposal.kind === 'episode' ? 'part_of_episode' : 'supports_topic',
        statuses: ['active', 'superseded', 'disputed', 'archived'],
      });
      const attachedKnownAt = structureKnownAt(allMembers);
      if (!attachedKnownAt) throw new OrganizationCandidateError('Structure members require a valid known or recorded time.');
      if (Date.parse(target.known_at) !== Date.parse(attachedKnownAt)) {
        repository.database.prepare(`UPDATE memory_nodes SET known_at = ?, updated_at = ?
          WHERE agent_id = ? AND id = ?`).run(attachedKnownAt, new Date().toISOString(), normalizedAgentId, target.id);
      }
    }
    if (target && summaryBefore) {
      memory = repository.updateStructureSummary({ agentId: normalizedAgentId, memoryId: target.id,
        title: proposal.title, content: proposal.content, proposalId: proposal.id, reason: proposal.rationale });
    }
    const pending = repository.setPendingStructureProposalResult({
      agentId: normalizedAgentId,
      proposalId: proposal.id,
      resultMemoryId: memory.id,
    });
    enqueueMemoryMaintenanceTasks({
      repository,
      agentId: normalizedAgentId,
      batchId: proposal.batch_id || proposal.id,
      memoryIds: [memory.id],
      taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding],
    });
    return {
      status: "materialized-pending-review",
      proposal: pending,
      memory: repository.getMemory(memory.id),
      addedMemberIds,
      members: proposalMembers(repository, {
        agentId: normalizedAgentId,
        kind: proposal.kind,
        memoryId: memory.id,
      }),
    };
  });
}

export function materializePendingMemoryStructureProposals(repository, {
  agentId,
  limit = 100,
} = {}) {
  if (!repository) throw new Error("Materializing pending structure proposals requires a repository.");
  const normalizedAgentId = clean(agentId);
  if (!normalizedAgentId) throw new Error("Materializing pending structure proposals requires agentId.");
  const materialized = [];
  const skipped = [];
  const retired = [];
  const failed = [];
  const size = Math.min(500, Math.max(1, Math.trunc(Number(limit) || 100)));
  const page = repository.database.prepare(`SELECT id FROM memory_structure_proposals
    WHERE agent_id = ? AND review_state = 'pending' AND result_memory_id IS NULL AND id > ?
    ORDER BY id LIMIT ?`);
  let cursor = '';
  for (;;) {
    const proposals = page.all(normalizedAgentId, cursor, size);
    if (!proposals.length) break;
    for (const { id } of proposals) {
      cursor = id;
      try {
        const result = materializeMemoryStructureProposal(repository, { agentId: normalizedAgentId, proposalId: id });
        if (result.status === 'already-materialized') skipped.push(result);
        else if (result.status === 'withdrawn') retired.push(result);
        else materialized.push(result);
      } catch (error) {
        failed.push({ proposalId: id, error: error.message });
      }
    }
  }
  return {
    total: materialized.length + skipped.length + retired.length + failed.length,
    materialized,
    skipped,
    retired,
    failed,
  };
}

// Membership planning uses the same semantic boundary as persistence, before
// purchasing a summary. No proposal or temporary container is written here.
export function validateStructureMembership(repository, input) {
  const candidate = normalizeProposal(repository, input, { requireSummary: false });
  if (findWithdrawnStructure(repository, candidate)) {
    throw new OrganizationCandidateError('This structure grouping was withdrawn for the same evidence.', 'MEMORY_STRUCTURE_WITHDRAWN');
  }
  return candidate;
}

export function proposeMemoryStructure(repository, input = {}) {
  return repository.transaction(() => {
    const candidate = normalizeProposal(repository, input);
    const withdrawn = findWithdrawnStructure(repository, candidate);
    if (withdrawn) return { ...repository.getStructureProposal(candidate.agentId, withdrawn.id), wasInserted: false };
    const hash = proposalHash(candidate);
    const id = clean(input.id) || `structure-proposal-${createHash("sha256")
      .update(`${candidate.agentId}\u001f${hash}`).digest("hex").slice(0, 24)}`;
    const proposal = repository.recordStructureProposal({
      ...candidate,
      id,
      proposalHash: hash,
    });
    if (!proposal.wasInserted) return proposal;
    const materialized = materializeMemoryStructureProposal(repository, {
      agentId: candidate.agentId,
      proposalId: proposal.id,
    });
    return {
      ...materialized.proposal,
      wasInserted: true,
      materialization: materialized.status,
    };
  });
}

function restoreStructureSummary(repository, memory, dismissedId) {
  const ownerId = memory.metadata?.structureSummaryProposalId;
  if (!ownerId || memory.status !== 'active') return null;
  let owner = repository.getStructureProposal(memory.agent_id, ownerId);
  // Preserve subsequent edits made outside this proposal's summary chain.
  const generatedHash = createHash('sha256').update(JSON.stringify([memory.title, memory.content])).digest('hex');
  if (!owner || ((owner.title !== memory.title || owner.content !== memory.content)
    && memory.metadata.structureSummaryHash !== generatedHash)) return null;
  const members = existingMembershipIds(repository, { agentId: memory.agent_id, kind: memory.kind, targetMemoryId: memory.id });
  const seen = new Set(), versions = [];
  let restored = { title: memory.title, content: memory.content, proposalId: ownerId };
  while (owner && !seen.has(owner.id)) {
    seen.add(owner.id);
    const before = owner.metadata.structureSummaryBefore;
    if (!before) return null;
    versions.push(owner);
    restored = { title: before.title, content: before.content, proposalId: '', material: before.material || null };
    const previous = before.proposalId ? repository.getStructureProposal(memory.agent_id, before.proposalId) : null;
    if (!previous || previous.title !== before.title || previous.content !== before.content) break;
    owner = previous;
  }
  const replayed = new Set();
  for (const version of versions.reverse()) {
    const input = version.metadata.organizationInput;
    if (version.id === dismissedId || version.review_state === 'dismissed'
      || !organizationInputIsCurrent(repository, memory.agent_id, input)
      || input.memories.some(item => !members.has(item.id))) break;
    restored = { title: version.title, content: version.content, proposalId: version.id,
      material: structureSummaryMaterial(version.title, version.content, input.memories.map(item => item.id), input) };
    replayed.add(version.id);
  }
  if (restored.proposalId === ownerId) return null;
  if (restored.material && (!organizationInputIsCurrent(repository, memory.agent_id, restored.material.inputVersion)
    || restored.material.memoryIds.some(id => !members.has(id)))) {
    enqueueStructureSummaryRefresh(repository, memory.agent_id, memory);
    return memory;
  }
  const needsRefresh = versions.some(version => version.id !== dismissedId && version.review_state !== 'dismissed'
    && !replayed.has(version.id) && version.memberIds.some(id => members.has(id)));
  const result = repository.updateStructureSummary({ agentId: memory.agent_id, memoryId: memory.id,
    title: restored.title, content: restored.content, proposalId: ownerId,
    sourceMemoryIds: restored.material?.memoryIds || null,
    reason: 'Structure attachment dismissed.' });
  if (needsRefresh) repository.enqueueMaintenanceTask({ agentId: memory.agent_id, lane: 'semantic',
    taskType: MAINTENANCE_TASK_TYPES.structureSummary,
    payload: { batchId: dismissedId, memoryIds: [memory.id],
      expectedSummary: expectedStructureSummary(result) } });
  else enqueueMemoryMaintenanceTasks({ repository, agentId: memory.agent_id, batchId: dismissedId,
    memoryIds: [memory.id], taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding] });
  return result;
}

function withdrawStructureCreation(repository, proposal, memory, actor, reason) {
  if (!memory || memory.status !== 'active' || memory.metadata?.manuallyEdited
    || memory.metadata?.structureProposalId !== proposal.id) return null;
  const agentId = memory.agent_id;
  const remaining = repository.listContainerMembers({ agentId, containerId: memory.id, containerKind: memory.kind,
    relation: memory.kind === 'topic' ? 'supports_topic' : 'part_of_episode',
    statuses: ['active', 'superseded', 'disputed', 'archived'] });
  const material = readStructureSummaryMaterial(repository, memory);
  const ownsSummary = !memory.metadata?.structureSummaryProposalId
    && memory.title === proposal.title && memory.content === proposal.content;
  if (!remaining.length) {
    if (ownsSummary) return repository.setMemoryDeleted({ agentId, memoryId: memory.id, actor, reason });
    // A later generated summary with no surviving members can no longer serve as evidence.
    if (material?.memoryIds.length) return repository.updateMemoryStatus(memory.id, 'archived');
    return null;
  }
  const ids = new Set(remaining.map(member => member.id));
  if (!ownsSummary && (!material || material.memoryIds.every(id => ids.has(id)))) return null;

  // Retain the container and independent membership. Immediately use existing
  // evidence in place of the old summary while its normal refresh is pending.
  const [first] = remaining;
  const result = repository.updateStructureSummary({ agentId, memoryId: memory.id, title: first.title,
    content: first.content, sourceMemoryIds: [first.id], actor, reason });
  if (remaining.length > 1) repository.enqueueMaintenanceTask({ agentId, lane: 'semantic', taskType: MAINTENANCE_TASK_TYPES.structureSummary,
    payload: { batchId: proposal.id, memoryIds: [memory.id], expectedSummary: expectedStructureSummary(result),
      invalidatesSummary: false } });
  enqueueMemoryMaintenanceTasks({ repository, agentId, batchId: proposal.id, memoryIds: [memory.id],
    taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding] });
  return result;
}

function withdrawStructureResult(repository, proposal, actor, reason) {
  const original = proposal.result_memory_id ? repository.getMemory(proposal.result_memory_id) : null;
  if (original && (original.agent_id !== proposal.agent_id || original.kind !== proposal.kind)) {
    throw new Error('Structure proposal points to an invalid result memory.');
  }
  const removedMemberships = proposal.result_memory_id ? repository.removeStructureProposalMemberships({
    agentId: proposal.agent_id, proposalId: proposal.id,
  }) : 0;
  const memory = proposal.operation === 'create' ? withdrawStructureCreation(repository, proposal, original, actor, reason)
    : original ? restoreStructureSummary(repository, original, proposal.id) : null;
  return { memory, removedMemberships };
}

export function resolveMemoryStructureProposal(repository, {
  agentId,
  proposalId,
  action,
  resolvedBy = "human",
  note = "",
} = {}) {
  if (!repository) throw new Error("Resolving a structure proposal requires a repository.");
  const normalizedAgentId = clean(agentId);
  const normalizedAction = clean(action);
  const proposal = repository.getStructureProposal(normalizedAgentId, proposalId);
  if (!proposal) throw new Error("Structure proposal does not exist for this Agent.");
  const withdrawing = normalizedAction === 'dismiss' && proposal.review_state === 'accepted' && proposal.result_memory_id;
  if (proposal.review_state !== "pending" && !withdrawing) {
    throw new Error(`Structure proposal is already ${proposal.review_state}.`);
  }
  if (!["accept", "dismiss"].includes(normalizedAction)) {
    throw new Error(`Unknown structure proposal action: ${normalizedAction || "(empty)"}.`);
  }
  if (normalizedAction === "dismiss") {
    return repository.transaction(() => {
      const result = withdrawStructureResult(repository, proposal, resolvedBy,
        clean(note) || 'Structure proposal was dismissed during review.');
      return {
        status: "dismissed",
        proposal: repository.resolveStructureProposal({
          agentId: normalizedAgentId,
          proposalId: proposal.id,
          resolution: "dismissed",
          resolvedBy,
          note,
        }),
        ...result,
        members: [],
      };
    });
  }

  const materialized = materializeMemoryStructureProposal(repository, {
    agentId: normalizedAgentId,
    proposalId: proposal.id,
  });
  if (materialized.status === 'withdrawn') {
    throw new OrganizationCandidateError('This structure grouping was withdrawn for the same evidence.', 'MEMORY_STRUCTURE_WITHDRAWN');
  }
  return repository.transaction(() => {
    let memory = materialized.memory;
    const reviewedAt = new Date().toISOString();
    if (proposal.operation === "create") {
      memory = repository.updateMemoryMetadata({
        agentId: normalizedAgentId,
        memoryId: memory.id,
        metadata: {
          ...memory.metadata,
          structureReviewState: "accepted",
          structureReviewedBy: clean(resolvedBy) || "human",
          structureReviewedAt: reviewedAt,
        },
        actor: resolvedBy,
        reason: clean(note) || "Structure proposal accepted during review.",
      });
    }
    repository.updateStructureProposalMembershipReviewState({
      agentId: normalizedAgentId,
      proposalId: proposal.id,
      reviewState: "accepted",
      reviewedBy: resolvedBy,
      reviewedAt,
    });
    const resolved = repository.resolveStructureProposal({
      agentId: normalizedAgentId,
      proposalId: proposal.id,
      resolution: "accepted",
      resultMemoryId: memory.id,
      resolvedBy,
      note,
    });
    return {
      status: "accepted",
      proposal: resolved,
      memory: repository.getMemory(memory.id),
      addedMemberIds: proposal.memberIds,
      members: proposalMembers(repository, {
        agentId: normalizedAgentId,
        kind: proposal.kind,
        memoryId: memory.id,
      }),
    };
  });
}
