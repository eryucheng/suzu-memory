export const DIRECT_USER_AGENT_DM_TOPOLOGY = "direct-user-agent-dm";

function clean(value) {
  return String(value ?? "").trim();
}

function speakerIdentity(messageRole, {
  agentId = "",
  primaryUserId = "",
  companionId = "",
} = {}) {
  const userKey = clean(primaryUserId) || "user";
  const companionKey = clean(companionId) || clean(agentId);
  if (messageRole === "user") return { actorRole: "user", actorKey: userKey };
  if (messageRole === "assistant" && companionKey) {
    return { actorRole: "agent", actorKey: companionKey };
  }
  return null;
}

export function buildArchivedUtteranceIdentity({
  messageRole,
  agentId,
  primaryUserId = "",
  companionId = "",
  conversationTopology = "",
  provenance = "suzu-memory-extraction-v1-utterance",
} = {}) {
  const userKey = clean(primaryUserId) || "user";
  const companionKey = clean(companionId) || clean(agentId);
  const speaker = speakerIdentity(clean(messageRole), {
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
    actorRoles.push({
      role: "participant",
      actorRole: speaker.actorRole === "user" ? "agent" : "user",
      actorKey: speaker.actorRole === "user" ? companionKey : userKey,
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
