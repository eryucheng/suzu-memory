import { createHash } from 'node:crypto';

export const EVENT_SOURCE_VERSION = 1;
export const EVENT_SOURCE_PROTOCOL_VERSION = 2;
export function eventSourceError(code, message) { return Object.assign(new Error(message), { code }); }
export function sourceSnapshot(value) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(sourceSnapshot));
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.freeze(Object.fromEntries(Object.keys(value).sort().map(key => [key, sourceSnapshot(value[key])])));
  }
  throw eventSourceError('EVENT_SOURCE_INVALID', 'Event source materials must be lossless JSON.');
}
export const sourceHash = value => createHash('sha256').update(JSON.stringify(sourceSnapshot(value))).digest('hex');
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw eventSourceError('EVENT_SOURCE_INVALID', `${name} is required.`);
  return value;
};
const sequence = (value, name) => {
  if (!Number.isSafeInteger(value) || value < 0) throw eventSourceError('EVENT_SOURCE_INVALID', `${name} must be a nonnegative integer.`);
  return value;
};
export function normalizeEventSourceScope(value, agentId) {
  const input = sourceSnapshot(value);
  if (!input || Array.isArray(input) || typeof input !== 'object') throw eventSourceError('EVENT_SOURCE_INVALID', 'Source scope must be an object.');
  if (input.agentId !== agentId) throw eventSourceError('EVENT_SOURCE_AGENT_CONFLICT', 'Source scope belongs to another Agent.');
  required(input.owner, 'owner');
  if (input.version===2) {
    for (const key of ['agentGeneration','experienceUpperBound','globalEventUpperBound','clearedThroughExperienceSequence','contentRevision']) sequence(input[key],key);
    if (!input.agentGeneration || input.clearedThroughExperienceSequence>input.experienceUpperBound) throw eventSourceError('EVENT_SOURCE_INVALID','Experience source bounds are inconsistent.');
    return sourceSnapshot({ version: 2,owner: input.owner,agentId,agentGeneration: input.agentGeneration,experienceUpperBound: input.experienceUpperBound,
      globalEventUpperBound: input.globalEventUpperBound,clearedThroughExperienceSequence: input.clearedThroughExperienceSequence,contentRevision: input.contentRevision });
  }
  sequence(input.eventUpperBound, 'eventUpperBound');
  if (!Array.isArray(input.clears)) throw eventSourceError('EVENT_SOURCE_INVALID', 'clears must be an array.');
  const clears = new Map();
  for (const clear of input.clears) {
    required(clear.spaceId, 'clear.spaceId'); sequence(clear.throughSequence, 'clear.throughSequence');
    clears.set(clear.spaceId, Math.max(clears.get(clear.spaceId) || 0, clear.throughSequence));
  }
  return sourceSnapshot({ owner: input.owner, agentId, eventUpperBound: input.eventUpperBound,
    clears: [...clears].sort(([a], [b]) => a.localeCompare(b)).map(([spaceId, throughSequence]) => ({ spaceId, throughSequence })) });
}
export function normalizeEventSource(value, agentId) {
  const input = sourceSnapshot(value);
  if (!input || Array.isArray(input) || typeof input !== 'object') throw eventSourceError('EVENT_SOURCE_INVALID', 'Event source must be an object.');
  if (![EVENT_SOURCE_VERSION,2].includes(input.version) || input.recipientAgentId !== agentId) {
    throw eventSourceError('EVENT_SOURCE_AGENT_CONFLICT', 'The Event must explicitly name this receiving Agent.');
  }
  for (const key of ['owner', 'eventId', 'spaceId', 'eventType']) required(input[key], key);
  if (input.version===2) {
    sequence(input.agentGeneration,'agentGeneration');
    required(input.experienceRef?.experienceId,'experienceRef.experienceId');
    sequence(input.experienceRef?.experienceSequence,'experienceRef.experienceSequence'); sequence(input.experienceRef?.itemIndex,'experienceRef.itemIndex');
    if (!input.agentGeneration || !input.experienceRef.experienceSequence || input.experienceRef.sourceEventId!==input.eventId) {
      throw eventSourceError('EVENT_SOURCE_INVALID','Experience provenance must identify the actual retained source.');
    }
  }
  sequence(input.commitSequence, 'commitSequence');
  if (input.observation !== undefined) {
    required(input.observation.eventId, 'observation.eventId');
    sequence(input.observation.commitSequence, 'observation.commitSequence');
    if (input.observation.commitSequence < input.commitSequence) throw eventSourceError('EVENT_SOURCE_INVALID', 'Observation cannot precede its source Event.');
  }
  if (input.commitSequence === 0) throw eventSourceError('EVENT_SOURCE_INVALID', 'Committed Events start at sequence 1.');
  required(input.sender?.kind, 'sender.kind'); required(input.sender?.id, 'sender.id');
  if (input.recipientAgentIds !== undefined && (!Array.isArray(input.recipientAgentIds) || !input.recipientAgentIds.includes(agentId))) {
    throw eventSourceError('EVENT_SOURCE_AGENT_CONFLICT', 'The Event recipient set must contain this Agent.');
  }
  for (const id of input.recipientAgentIds || []) required(id, 'recipientAgentIds item');
  if (input.topology?.participants !== undefined && !Array.isArray(input.topology.participants)) {
    throw eventSourceError('EVENT_SOURCE_TOPOLOGY_INVALID', 'Topology participants must be explicit identities.');
  }
  for (const participant of input.topology?.participants || []) {
    required(participant.id, 'participant.id'); required(participant.kind, 'participant.kind');
  }
  if (!['direct-user-agent-dm', 'space'].includes(input.topology?.kind)) {
    throw eventSourceError('EVENT_SOURCE_TOPOLOGY_REQUIRED', 'The product must declare the actual Event topology.');
  }
  if (input.topology.kind === 'direct-user-agent-dm') {
    const members = input.topology.participants;
    if (!Array.isArray(members) || members.length !== 2
      || members.filter(member => member.kind === 'agent' && member.id === agentId).length !== 1
      || members.filter(member => member.kind === 'local-user').length !== 1
      || !members.some(member => member.kind === input.sender.kind && member.id === input.sender.id)) {
      throw eventSourceError('EVENT_SOURCE_TOPOLOGY_INVALID', 'Direct topology must prove the actual two participants and sender.');
    }
  }
  return input;
}
export function eventSourceEligible(source, scope) {
  try { normalizeEventSource(source, scope.agentId); } catch { return false; }
  if (scope.version===2) return source.version===2 && source.owner===scope.owner && source.recipientAgentId===scope.agentId
    && source.agentGeneration===scope.agentGeneration && source.experienceRef.experienceSequence>scope.clearedThroughExperienceSequence
    && source.experienceRef.experienceSequence<=scope.experienceUpperBound && source.commitSequence<=scope.globalEventUpperBound
    && (!source.observation || source.observation.commitSequence<=scope.globalEventUpperBound);
  return source?.version === EVENT_SOURCE_VERSION && source.owner === scope.owner
    && source.recipientAgentId === scope.agentId && Number.isSafeInteger(source.commitSequence)
    && source.commitSequence <= scope.eventUpperBound
    && (!source.observation || source.observation.commitSequence <= scope.eventUpperBound)
    && !scope.clears.some(clear => clear.spaceId === source.spaceId && source.commitSequence <= clear.throughSequence);
}
export const eventSourceOf = row => row?.metadata?.eventSource;
