import { enqueueMemoryMaintenanceTasks, MAINTENANCE_TASK_TYPES, executionEventSourceView, modelCalendarFields } from '@suzu-memory/core';
import { STRUCTURE_SUMMARY_INSTRUCTIONS, MEMORY_STRUCTURE_SUMMARY_SCHEMA, parseStructureSummary } from './prompt.mjs';

const systemPrompt = STRUCTURE_SUMMARY_INSTRUCTIONS;
const versions = memories => JSON.stringify(memories.map(memory => [memory.id, memory.title, memory.content,
  memory.updated_at]).sort(([a], [b]) => a.localeCompare(b)));

export function structureSummaryNeedsRefresh(repository, agentId, memoryId) {
  return Boolean(repository.database.prepare(`SELECT 1 FROM memory_maintenance_tasks task
    JOIN memory_nodes node ON node.agent_id = task.agent_id AND node.id = ?
    WHERE task.agent_id = ? AND task.lane = 'semantic' AND task.task_type = 'structure-summary'
      AND task.status IN ('pending', 'running', 'failed')
      AND json_extract(task.payload_json, '$.memoryIds[0]') = node.id
      AND json_extract(task.payload_json, '$.expectedSummary.title') = node.title
      AND json_extract(task.payload_json, '$.expectedSummary.content') = node.content LIMIT 1`).get(memoryId, agentId));
}

function summarySnapshot(repository, agentId, memoryId, extraMemberIds = []) {
  const container = repository.getMemory(memoryId);
  if (!container || container.agent_id !== agentId || container.status !== 'active'
    || !['topic', 'episode'].includes(container.kind)) throw new Error('Summary requires an active structure container.');
  const members = repository.listContainerMembers({ agentId, containerId: memoryId, containerKind: container.kind,
    relation: container.kind === 'topic' ? 'supports_topic' : 'part_of_episode',
    statuses: ['active', 'superseded', 'disputed', 'archived'] });
  const byId = new Map(members.map(memory => [memory.id, memory]));
  for (const id of extraMemberIds) {
    const memory = repository.getMemory(id);
    if (!memory || memory.agent_id !== agentId) throw new Error('Summary member must belong to the same Agent.');
    byId.set(id, memory);
  }
  const all = [...byId.values()];
  const view = executionEventSourceView(repository, agentId);
  if (view && all.some(memory => !view.allows(memory))) throw new Error('Complete summary members are outside the current source scope.');
  return { container, members: all, version: versions([container, ...all]) };
}

/** The same summarizer handles combined attachments and changed membership sets. */
export async function generateStructureSummary({ repository, agentId, memoryId, extraMemberIds = [], generator,
  onGeneration = async () => {} }) {
  const snapshot = summarySnapshot(repository, agentId, memoryId, extraMemberIds);
  const request = { schemaName: 'memory-structure-summary-v1', schema: MEMORY_STRUCTURE_SUMMARY_SCHEMA, systemPrompt,
    input: JSON.stringify({ kind: snapshot.container.kind,
      members: snapshot.members.map(memory => ({ kind: memory.kind, title: memory.title, content: memory.content,
        ...modelCalendarFields(memory, ['eventDate', 'eventStart', 'eventEnd'], repository.listMemorySources(memory.id)) })) }) };
  generator.assertRequestBudget?.(request);
  let generation;
  try { generation = await generator(request); }
  catch (error) { await onGeneration(error); throw error; }
  await onGeneration(generation);
  const output = parseStructureSummary(generation?.output);
  const assertCurrent = () => {
    if (summarySnapshot(repository, agentId, memoryId, extraMemberIds).version !== snapshot.version) {
      throw Object.assign(new Error('Structure members changed during summary generation.'), { code: 'MEMORY_STRUCTURE_STALE' });
    }
  };
  return { ...output, assertCurrent };
}

export async function refreshStructureSummary({ repository, agentId, memoryId, expectedSummary, generator,
  recordUsage = async () => {} }) {
  const current = repository.getMemory(memoryId);
  if (!current || current.status !== 'active') return { status: 'skipped', reason: 'container-not-active' };
  if (expectedSummary && (current.title !== expectedSummary.title || current.content !== expectedSummary.content)) {
    return { status: 'skipped', reason: 'summary-already-replaced' };
  }
  const summary = await generateStructureSummary({ repository, agentId, memoryId, generator, onGeneration: recordUsage });
  return repository.transaction(() => {
    summary.assertCurrent();
    const memory = repository.updateStructureSummary({ agentId, memoryId, title: summary.title,
      content: summary.content, proposalId: current.metadata.structureSummaryProposalId || '',
      reason: 'Refresh summary from current structure members.' });
    enqueueMemoryMaintenanceTasks({ repository, agentId, memoryIds: [memoryId],
      taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding] });
    return { status: 'completed', memoryId: memory.id };
  });
}
