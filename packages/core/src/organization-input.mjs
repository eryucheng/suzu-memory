import { createHash } from 'node:crypto';
import { OrganizationInputChangedError } from './organization-error.mjs';
import { readMemoryInput as readOrganizationInput } from './memory-input.mjs';
export { readOrganizationInput };

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const uniqueIds = ids => [...new Set(ids.map(id => String(id || '').trim()).filter(Boolean))].sort();

function snapshot(memories) {
  return { version: 1, memories, hash: hash(memories) };
}

export function selectOrganizationInput(input, memoryIds) {
  const selected = new Set(uniqueIds(memoryIds));
  const memories = input?.memories.filter(memory => selected.has(memory.id)) || [];
  if (memories.length !== selected.size) throw new OrganizationInputChangedError('Organization dependencies are absent from the captured input.');
  return snapshot(memories);
}

export function organizationInputIsCurrent(repository, agentId, input) {
  return Boolean(input?.version === 1 && Array.isArray(input.memories)
    && input.memories.every(memory => memory.fingerprint)
    && readOrganizationInput(repository, agentId, input.memories.map(memory => memory.id)).hash === input.hash);
}

export function assertOrganizationInputCurrent(repository, agentId, input) {
  if (!organizationInputIsCurrent(repository, agentId, input)) throw new OrganizationInputChangedError(
    input ? undefined : 'Organization input has no recorded version; regenerate before accepting its result.');
}
