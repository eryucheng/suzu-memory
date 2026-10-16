const clean = value => String(value ?? '').trim();
const folded = value => clean(value).normalize('NFKC').toLocaleLowerCase('zh-CN');

/** Host identities, not conversational guesses. Product inputs never add an
 * absent primary user; legacy two-party inputs retain their declared actors. */
export function buildExtractionParticipants(messages, identity = {}) {
  const records = new Map();
  const product = messages.some(message => message.eventSource);
  const ownerId = clean(identity.companionId || identity.agentId
    || messages.find(message => message.eventSource)?.eventSource.recipientAgentId || (!product ? 'agent' : ''));
  function add(actorRole, actorKey, name, aliases = []) {
    if (!actorKey || !['user', 'agent', 'other'].includes(actorRole)) return;
    const key = `${actorRole}\u001f${actorKey}`;
    const record = records.get(key) || { actorRole, actorKey, name: clean(name) || '未命名人物', aliases: [] };
    record.aliases = [...new Set([...record.aliases, clean(name), ...aliases.map(clean), actorKey].filter(Boolean))];
    records.set(key, record);
  }
  add('agent', ownerId, identity.companionName || identity.memoryOwner);
  for (const message of messages) {
    if (message.eventSource) {
      const source = message.eventSource;
      for (const actor of [source.sender, ...(source.topology?.participants || [])]) {
        const role = actor.kind === 'agent' && actor.id === ownerId ? 'agent'
          : actor.kind === 'local-user' && actor.id === identity.primaryUserId ? 'user'
            : ['system', 'world', 'unknown'].includes(actor.kind) ? '' : 'other';
        const configuredName = role === 'agent' ? identity.companionName : role === 'user' ? identity.primaryUserName : '';
        add(role, actor.id, actor.name || configuredName, [configuredName]);
      }
    } else {
      const role = message.role === 'assistant' ? 'agent' : message.role === 'user' ? 'user' : '';
      add(role, role === 'agent' ? ownerId : clean(identity.primaryUserId ?? 'user'),
        message.speaker || (role === 'agent' ? identity.companionName : identity.primaryUserName));
    }
  }
  if (!product) {
    add('agent', ownerId, identity.companionName);
    add('user', clean(identity.primaryUserId), identity.primaryUserName);
  }
  const participants = [...records.values()];
  const names = participants.map(participant => folded(participant.name));
  for (const participant of participants) {
    if (names.filter(name => name === folded(participant.name)).length > 1) {
      participant.name = `${participant.name} [${participant.actorRole}:${participant.actorKey}]`;
    }
  }
  return participants;
}

export function resolveExtractionParticipant(name, participants = []) {
  const selected = folded(name);
  if (!selected) return { status: 'unknown' };
  const matches = participants.filter(participant => [participant.name, participant.actorKey, ...participant.aliases]
    .some(alias => folded(alias) === selected));
  return matches.length === 1 ? { status: 'known', participant: matches[0] }
    : { status: matches.length ? 'ambiguous' : 'unknown', matches };
}

export function normalizeExtractionParticipantRoles(output, participants) {
  const corrections = [];
  function roleFor(name, role, candidateIndex, field) {
    const resolved = resolveExtractionParticipant(name, participants);
    if (resolved.status !== 'known' || resolved.participant.actorRole === role) return role;
    corrections.push({ candidateIndex, field });
    return resolved.participant.actorRole;
  }
  const memories = output.memories.map((candidate, index) => {
    const stateTarget = { ...candidate.stateTarget };
    for (const prefix of ['object', 'counterpart', 'trigger']) {
      if (!Object.hasOwn(stateTarget, `${prefix}Role`)) continue;
      stateTarget[`${prefix}Role`] = roleFor(stateTarget[`${prefix}Name`], stateTarget[`${prefix}Role`], index, `stateTarget.${prefix}Role`);
    }
    return { ...candidate, ...(candidate.stateTarget ? { stateTarget } : {}),
      subjectRole: roleFor(candidate.subjectName, candidate.subjectRole, index, 'subjectRole'),
      actorRoles: candidate.actorRoles.map((actor, actorIndex) => ({ ...actor,
        actorRole: roleFor(actor.actorName, actor.actorRole, index, `actorRoles[${actorIndex}].actorRole`),
      })),
    };
  });
  return { output: { memories }, corrections };
}
