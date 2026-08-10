const AUTOMATIC_MEMBERSHIP_PROVENANCE = "deterministic-relationship-membership-v1";
const PRIMARY_USER_AGENT_RELATIONSHIP_SCOPE = "primary-user-agent";

function clean(value) {
  return String(value ?? "").trim();
}

function encodedKey(value) {
  return encodeURIComponent(clean(value).toLocaleLowerCase("en-US"));
}

function actorIdentityKey(role, key) {
  return `${clean(role)}\u001f${clean(key)}`;
}

function relationshipMembershipType(memory) {
  if (memory.state_family === "relationship" || memory.kind === "relationship") {
    return "relationship_state";
  }
  if (memory.state_family === "affective_association") return "affective_association";
  if (memory.kind === "commitment") return "commitment";
  if ((memory.metadata?.inputEventTypes || []).includes("relationship.milestone")) {
    return "milestone";
  }
  return "shared_experience";
}

function isPrimaryUserAgentRelationship(relationship) {
  if (relationship?.metadata?.scope !== PRIMARY_USER_AGENT_RELATIONSHIP_SCOPE
    || relationship.kind !== "dyad" || relationship.members.length !== 2) return false;
  const memberRoles = relationship.members.map((member) => member.member_role).sort();
  return memberRoles[0] === "agent" && memberRoles[1] === "user";
}

export function primaryRelationshipKey({ primaryUserId, companionId }) {
  const user = encodedKey(primaryUserId);
  const companion = encodedKey(companionId);
  if (!user || !companion) throw new Error("Primary relationship key requires both actors.");
  return `primary:user:${user}|agent:${companion}`;
}

export function ensureCompanionRelationshipStructure({
  repository,
  agentId,
  primaryUserId = "user",
  primaryUserName = "User",
  companionId = agentId,
  companionName = "Companion",
  relationshipLabel = "关系",
  worldId = "relationship",
  worldFrame = "relational",
  provenance = "suzu-memory-service-identity",
} = {}) {
  const normalizedAgentId = clean(agentId);
  if (!repository || !normalizedAgentId) {
    throw new Error("Companion relationship structure requires repository and agentId.");
  }
  return repository.transaction(() => {
    const user = repository.ensureActorEntity({
      agentId: normalizedAgentId,
      actorRole: "user",
      actorKey: clean(primaryUserId) || "user",
      displayName: clean(primaryUserName) || "User",
      provenance,
      metadata: { primary: true },
    });
    const companion = repository.ensureActorEntity({
      agentId: normalizedAgentId,
      actorRole: "agent",
      actorKey: clean(companionId) || normalizedAgentId,
      displayName: clean(companionName) || "Companion",
      provenance,
      metadata: { primary: true },
    });
    const relationship = repository.upsertRelationship({
      agentId: normalizedAgentId,
      relationshipKey: primaryRelationshipKey({
        primaryUserId: clean(primaryUserId) || "user",
        companionId: clean(companionId) || normalizedAgentId,
      }),
      kind: "dyad",
      label: clean(relationshipLabel) || "关系",
      worldId: clean(worldId) || "relationship",
      worldFrame: clean(worldFrame) || "relational",
      metadata: {
        primary: true,
        scope: PRIMARY_USER_AGENT_RELATIONSHIP_SCOPE,
        primaryUserActorKey: clean(primaryUserId) || "user",
        companionActorKey: clean(companionId) || normalizedAgentId,
      },
    });
    repository.addRelationshipMember({
      agentId: normalizedAgentId,
      relationshipId: relationship.id,
      entityId: user.entity.id,
      memberRole: "user",
      provenance,
    });
    repository.addRelationshipMember({
      agentId: normalizedAgentId,
      relationshipId: relationship.id,
      entityId: companion.entity.id,
      memberRole: "agent",
      provenance,
    });
    return {
      user: repository.getEntity(normalizedAgentId, user.entity.id),
      companion: repository.getEntity(normalizedAgentId, companion.entity.id),
      relationship: repository.getRelationship(normalizedAgentId, relationship.id),
    };
  });
}

export function syncMemoryRelationshipMemberships({
  repository,
  agentId,
  memoryIds = [],
  relationshipIds = [],
} = {}) {
  const normalizedAgentId = clean(agentId);
  const requestedMemoryIds = [...new Set(memoryIds.map(clean).filter(Boolean))];
  if (!repository || !normalizedAgentId) {
    throw new Error("Relationship membership sync requires repository and agentId.");
  }
  if (!requestedMemoryIds.length) {
    return { status: "skipped", reason: "no-memories", linked: 0, removed: 0 };
  }
  const requestedRelationships = new Set(relationshipIds.map(clean).filter(Boolean));
  const relationships = repository.listRelationships(normalizedAgentId)
    .filter((relationship) => (
      isPrimaryUserAgentRelationship(relationship)
      && (!requestedRelationships.size || requestedRelationships.has(relationship.id))
    ));
  if (!relationships.length) {
    return { status: "skipped", reason: "no-relationships", linked: 0, removed: 0 };
  }

  return repository.transaction(() => {
    let linked = 0;
    let removed = 0;
    const relationshipActors = new Map(relationships.map((relationship) => [
      relationship.id,
      relationship.members.map((member) => ({
        member,
        bindings: repository.listActorEntityBindings(normalizedAgentId, {
          entityId: member.entity_id,
        }),
      })),
    ]));

    for (const memoryId of requestedMemoryIds) {
      const memory = repository.getMemory(memoryId);
      if (!memory || memory.agent_id !== normalizedAgentId) continue;
      const currentMemberships = repository.listMemoryRelationships(memory.id);
      const desired = new Map();
      if (memory.status === "active" && memory.kind !== "utterance") {
        const roles = repository.listMemoryRoles(memory.id);
        const roleIdentities = new Set(roles
          .filter((role) => ["subject", "experiencer", "participant"].includes(role.role))
          .map((role) => actorIdentityKey(role.actor_role, role.actor_key)));
        for (const relationship of relationships) {
          const members = relationshipActors.get(relationship.id) || [];
          const allMembersExplicit = members.length >= 2 && members.every(({ bindings }) => (
            bindings.some((binding) => roleIdentities.has(actorIdentityKey(
              binding.actor_role,
              binding.actor_key,
            )))
          ));
          const primarySharedMemory = relationship.metadata?.primary === true
            && memory.subject_role === "shared"
            && memory.world_id === relationship.world_id;
          if (!allMembersExplicit && !primarySharedMemory) continue;
          const membershipType = relationshipMembershipType(memory);
          desired.set(`${relationship.id}\u001f${membershipType}`, {
            relationship,
            membershipType,
            confidence: allMembersExplicit ? 1 : 0.9,
            basis: allMembersExplicit ? "all-members-explicit" : "primary-shared-subject",
          });
        }
      }

      for (const membership of currentMemberships) {
        if (membership.provenance !== AUTOMATIC_MEMBERSHIP_PROVENANCE) continue;
        if (requestedRelationships.size && !requestedRelationships.has(membership.relationship_id)) {
          continue;
        }
        const key = `${membership.relationship_id}\u001f${membership.membership_type}`;
        if (desired.has(key)) continue;
        removed += repository.unlinkMemoryFromRelationship({
          agentId: normalizedAgentId,
          memoryId: memory.id,
          relationshipId: membership.relationship_id,
          membershipType: membership.membership_type,
          provenance: AUTOMATIC_MEMBERSHIP_PROVENANCE,
        });
      }

      const existingKeys = new Set(currentMemberships.map((membership) => (
        `${membership.relationship_id}\u001f${membership.membership_type}`
      )));
      for (const [key, candidate] of desired) {
        if (existingKeys.has(key)) continue;
        repository.linkMemoryToRelationship({
          agentId: normalizedAgentId,
          memoryId: memory.id,
          relationshipId: candidate.relationship.id,
          membershipType: candidate.membershipType,
          confidence: candidate.confidence,
          provenance: AUTOMATIC_MEMBERSHIP_PROVENANCE,
          metadata: { basis: candidate.basis },
        });
        linked += 1;
      }
    }
    return {
      status: "ready",
      memories: requestedMemoryIds.length,
      relationships: relationships.length,
      linked,
      removed,
      provenance: AUTOMATIC_MEMBERSHIP_PROVENANCE,
    };
  });
}

export {
  AUTOMATIC_MEMBERSHIP_PROVENANCE,
  PRIMARY_USER_AGENT_RELATIONSHIP_SCOPE,
};
