import { createHash } from 'node:crypto';
const clean = value => String(value ?? '').trim();
export const extractionParticipantNameKey = value => clean(value).normalize('NFKC').toLowerCase().replace(/’/gu, "'");

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
    const record = records.get(key) || { actorRole, actorKey, name: '', aliases: [] };
    if (!record.name) record.name = clean(name);
    record.aliases = [...new Set([...record.aliases, clean(name), ...aliases.map(clean)].filter(Boolean))];
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
  for (const [index, participant] of participants.entries()) {
    participant.name ||= '未命名人物';
    participant.ref = `P${index + 1}`;
    participant.displayName = participant.name;
  }
  return participants;
}

export function resolveExtractionParticipant(name, participants = []) {
  const selected = extractionParticipantNameKey(name);
  if (!selected) return { status: 'unknown' };
  const matches = participants.filter(participant => [participant.name, ...(participant.aliases || [])]
    .some(alias => extractionParticipantNameKey(alias) === selected));
  return matches.length === 1 ? { status: 'known', participant: matches[0] }
    : { status: matches.length ? 'ambiguous' : 'unknown', matches };
}

export function resolveExtractionSpeaker(message, participants) {
  const actorKey = message.eventSource?.sender.id || message.speakerIdentity?.actorKey;
  const matches = actorKey ? participants.filter(participant => participant.actorKey === actorKey)
    : participants.filter(participant => participant.actorRole === (message.role === 'assistant' ? 'agent' : 'user')
      && (!message.speaker || [participant.name, ...participant.aliases].includes(message.speaker)));
  return matches.length === 1 ? matches[0]
    : matches.find(participant => participant.actorRole === message.speakerIdentity?.actorRole);
}

/** Resolve only an unbound reference. Fixed keys are checked against the
 * captured host identities; display names cannot override them. */
export function resolveExtractionActor({ ref, role, key, name, status }, identity = {}) {
  const participants = identity.participants || [];
  if (ref) {
    const person = participants.find(person => person.ref === ref);
    if (!person) throw new Error(`未知人物引用：${ref}。`);
    return { role: person.actorRole, key: person.actorKey, name: person.name, status: 'bound' };
  }
  if (role === 'world' || role === 'unknown') return { role, key: '', name: clean(name), status: 'scope' };
  if (role === 'shared') return { role, key: clean(key) || (!identity.eventSourceIdentity && identity.primaryUserId
    ? `shared:${identity.companionId || identity.agentId}:${identity.primaryUserId}` : ''), name: clean(name), status: 'scope' };
  if (clean(key)) {
    const known = participants.find(person => person.actorRole === role && person.actorKey === key);
    const provisional = role === 'other' && (/^(?:unresolved-person-|entity:)/u.test(key));
    if (identity.eventSourceIdentity && !known && !provisional) return { role, key: '', name: clean(name), status: 'conflict' };
    return { role, key: clean(key), name: clean(name) || known?.name || '', status: status || 'bound' };
  }
  if (status === 'entity') return { role: role || 'other', key: '', name: clean(name), status };
  if (status === 'ambiguous' || status === 'conflict') return { role: role || 'other', key: '', name: clean(name), status };
  if (status !== 'unresolved') {
    const resolved = resolveExtractionParticipant(name, participants);
    if (resolved.status === 'known') {
      const person = resolved.participant;
      return role && role !== person.actorRole
        ? { role, key: '', name: clean(name), status: 'conflict' }
        : { role: person.actorRole, key: person.actorKey, name: clean(name) || person.name, status: 'bound' };
    }
    if (resolved.status === 'ambiguous') return { role: role || 'other', key: '', name: clean(name), status: 'ambiguous' };
  }
  const selectedRole = role || 'other';
  if (!identity.eventSourceIdentity && ['user', 'agent'].includes(selectedRole)) {
    return { role: selectedRole, key: clean(selectedRole === 'user' ? identity.primaryUserId ?? 'user' : identity.companionId || identity.agentId), name: clean(name), status: 'bound' };
  }
  const actorKey = selectedRole === 'other' && clean(name) && identity.unresolvedActorScope
    ? 'unresolved-person-' + createHash('sha256').update([identity.agentId, identity.unresolvedActorScope, extractionParticipantNameKey(name)].map(clean).join('\u001f')).digest('hex').slice(0, 24) : '';
  return { role: selectedRole, key: actorKey, name: clean(name), status: 'unresolved' };
}
