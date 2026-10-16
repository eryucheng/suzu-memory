export const DIRECT_USER_AGENT_DM_TOPOLOGY = "direct-user-agent-dm";

function clean(value) {
  return String(value ?? "").trim();
}

function speakerIdentity(messageRole, {
  agentId = "",
  primaryUserId = "user",
  companionId = "",
} = {}) {
  const userKey = clean(primaryUserId);
  const companionKey = clean(companionId) || clean(agentId);
  if (messageRole === "user" && userKey) return { actorRole: "user", actorKey: userKey };
  if (messageRole === "assistant" && companionKey) {
    return { actorRole: "agent", actorKey: companionKey };
  }
  return null;
}

export function buildArchivedUtteranceIdentity({
  messageRole,
  agentId,
  primaryUserId = "user",
  companionId = "",
  conversationTopology = "",
  actualSpeaker = null,
  actualParticipants = [],
  provenance = "suzu-memory-extraction-v1-utterance",
} = {}) {
  const userKey = clean(primaryUserId);
  const companionKey = clean(companionId) || clean(agentId);
  const speaker = actualSpeaker || speakerIdentity(clean(messageRole), {
    agentId,
    primaryUserId: userKey,
    companionId: companionKey,
  });
  if (!speaker) {
    return {
      subjectRole: "unknown",
      subjectKey: "",
      actorRoles: [],
    };
  }

  const actorRoles = [{
    role: "speaker",
    ...speaker,
    isPrimary: true,
    confidence: 1,
    provenance: clean(provenance),
  }];
  if (
    clean(conversationTopology) === DIRECT_USER_AGENT_DM_TOPOLOGY
    && companionKey
  ) {
    const counterparts = actualSpeaker ? actualParticipants.filter(participant => participant.id !== speaker.actorKey)
      .map(participant => ({ actorRole: participant.role === 'companion' ? 'agent' : participant.role === 'system' ? 'unknown' : participant.role,
        actorKey: participant.id })) : [{ actorRole: speaker.actorRole === 'user' ? 'agent' : 'user',
        actorKey: speaker.actorRole === 'user' ? companionKey : userKey }];
    for (const counterpart of counterparts.filter(actor => clean(actor.actorKey))) actorRoles.push({
      role: "participant",
      ...counterpart,
      isPrimary: false,
      confidence: 1,
      provenance: `${clean(provenance)}-dm-counterpart`,
    });
  }
  return {
    subjectRole: speaker.actorRole,
    subjectKey: speaker.actorKey,
    actorRoles,
  };
}
