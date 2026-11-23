import { createHash } from 'node:crypto';
import { executionEventSourceView } from './event-source-execution.mjs';
import { modelCalendarFields } from './calendar-time.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sorted = rows => rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const memoryFields = ['id', 'kind', 'layer', 'status', 'title', 'content', 'subject_role', 'subject_key',
  'reality', 'world_id', 'world_frame', 'temporal_state', 'representation_layer', 'state_family', 'state_phase'];

export function isCurrentEvidenceSource(memory, source) {
  return memory?.status === 'active' && source?.lifecycle === 'active';
}

export const reportedStateEvidenceAvailable = alias =>
  `COALESCE(json_extract(${alias}.metadata_json, '$.reportedStateEvidenceUnavailable'), 0) = 0`;

/** Semantic evidence versions, independent of indexing and access statistics.
 * Mutation revisions distinguish edit/restore cycles even when text returns to A. */
export function readMemoryInput(repository, agentId, memoryIds, { fields = [] } = {}) {
  const view = executionEventSourceView(repository, agentId);
  const ids = [...new Set(memoryIds.map(id => String(id || '').trim()).filter(Boolean))].sort();
  const memories = ids.map(id => {
    const memory = repository.getMemory(id);
    // Summary owners validate the full member set before reading a container.
    if (!memory || memory.agent_id !== agentId
      || (view && !view.memoryIds.has(id) && !['topic', 'episode'].includes(memory.kind))) return { id, fingerprint: '' };
    const sources = repository.listMemorySources(id).filter(source => !view || view.sourceIds.has(source.id));
    return { id, fingerprint: hash({
      revision: Number(memory.metadata?.organizationRevision || 0),
      memory: [...memoryFields, ...fields].map(key => memory[key]),
      calendar: modelCalendarFields(memory, ['eventDate', 'eventStart', 'eventEnd', 'knownAt'], sources),
      roles: sorted(repository.listMemoryRoles(id).map(role => [role.role, role.actor_role, role.actor_key, Boolean(role.is_primary)])),
      entities: sorted(repository.listMemoryEntities(id).map(entity => [entity.id, entity.kind, entity.canonical_name, entity.link_role])),
      sources: sorted(sources.map(source => [source.id, source.source_kind, source.content, source.speaker, source.lifecycle,
        modelCalendarFields(source, ['occurredAt', 'knownAt', 'recordedAt'])])),
    }) };
  });
  return { version: 1, memories, hash: hash(memories) };
}
