import { enqueueMemoryMaintenanceTasks, MAINTENANCE_TASK_TYPES, executionEventSourceView, eventSourceMaterial, modelCalendarFields,
  readOrganizationInput, assertOrganizationInputCurrent, OrganizationInputChangedError, OrganizationCandidateError,
  expectedStructureSummary, structureSummaryMatches, structureSummaryNeedsRefresh, withModelReferences } from '@suzu-memory/core';
import { STRUCTURE_SUMMARY_INSTRUCTIONS, MEMORY_STRUCTURE_SUMMARY_SCHEMA, parseStructureSummary } from './prompt.mjs';
import { assertGenerationRequestBudget } from './generation-input.mjs';
import { isMemoryBudgetError } from './budgeted-parts.mjs';

const systemPrompt = STRUCTURE_SUMMARY_INSTRUCTIONS;

export { structureSummaryNeedsRefresh };

function summarySnapshot(repository, agentId, memoryId, extraMemberIds = [], kind = '') {
  const container = memoryId ? repository.getMemory(memoryId) : { kind };
  if (!container || (memoryId && (container.agent_id !== agentId || container.status !== 'active'))
    || !['topic', 'episode'].includes(container.kind)) throw new Error('Summary requires an active structure container.');
  const members = memoryId ? repository.listContainerMembers({ agentId, containerId: memoryId, containerKind: container.kind,
    relation: container.kind === 'topic' ? 'supports_topic' : 'part_of_episode',
    statuses: ['active', 'superseded', 'disputed', 'archived'] }) : [];
  const byId = new Map(members.map(memory => [memory.id, memory]));
  for (const id of extraMemberIds) {
    const memory = repository.getMemory(id);
    if (!memory || memory.agent_id !== agentId) throw new Error('Summary member must belong to the same Agent.');
    byId.set(id, memory);
  }
  const all = [...byId.values()];
  if (!all.length) throw new OrganizationCandidateError('No surviving evidence remains for this structure summary; human review is required.');
  if (all.some(memory => ['topic', 'episode'].includes(memory.kind)
    && structureSummaryNeedsRefresh(repository, agentId, memory.id))) {
    throw Object.assign(new Error('A member summary is awaiting refresh or review; do not summarize its outdated text.'),
      { code: 'MEMORY_STRUCTURE_DEPENDENCY_PENDING', category: 'dependency-pending' });
  }
  const view = executionEventSourceView(repository, agentId);
  if (view && all.some(memory => !view.allows(memory))) throw new Error('Complete summary members are outside the current source scope.');
  return { container, members: all, inputVersion: readOrganizationInput(repository, agentId, [container.id, ...all.map(memory => memory.id)].filter(Boolean)) };
}

const summaryMember = (repository, memory) => ({ kind: memory.kind, title: memory.title, content: memory.content,
  ...modelCalendarFields(memory, ['eventDate', 'eventStart', 'eventEnd'], repository.listMemorySources(memory.id)) });

/** A plan summarizes each final membership once. Each result has its own
 * checkpoint; a malformed or failed sibling does not discard valid summaries. */
export async function generatePlannedStructureSummaries({ repository, agentId, groups, generator,
  maximumRequestCharacters = 80_000, onGeneration = async () => {}, onSummary }) {
  const prepare = group => {
    const snapshot = summarySnapshot(repository, agentId, group.targetMemoryId || '', group.memberIds, group.kind);
    return { group, snapshot, assertCurrent() {
      const current = summarySnapshot(repository, agentId, group.targetMemoryId || '', group.memberIds, group.kind);
      assertOrganizationInputCurrent(repository, agentId, snapshot.inputVersion);
      if (current.inputVersion.hash !== snapshot.inputVersion.hash) throw new OrganizationInputChangedError('Structure membership changed during summary generation.');
    } };
  };
  const send = async jobs => {
    if (!jobs.length) return;
    const single = jobs.length === 1;
    const members = new Map(jobs.flatMap(job => job.snapshot.members.map(memory => [memory.id, memory])));
    const keys = jobs.map((_, index) => `group${index + 1}`);
    let request = { schemaName: single ? 'memory-structure-summary-v1' : 'memory-structure-summary-batch-v1',
      schema: single ? MEMORY_STRUCTURE_SUMMARY_SCHEMA : { type: 'object', additionalProperties: false,
        required: keys, properties: Object.fromEntries(keys.map(key => [key, MEMORY_STRUCTURE_SUMMARY_SCHEMA])) },
      systemPrompt: single ? systemPrompt : `${systemPrompt}\n分别为 groups 中每个分组生成概述，按其 key 返回。每组只使用其 memberIds 对应的 memories。`,
      input: JSON.stringify(single ? { kind: jobs[0].group.kind,
        members: jobs[0].snapshot.members.map(memory => summaryMember(repository, memory)) }
        : { groups: jobs.map((job, index) => ({ key: keys[index], kind: job.group.kind, memberIds: job.snapshot.members.map(memory => memory.id) })),
          memories: [...members.values()].map(memory => ({ id: memory.id, ...summaryMember(repository, memory) })) }),
      sourceMaterial: eventSourceMaterial(repository, agentId, [...members.keys()]),
    };
    if (!single) request = withModelReferences(request, { material: JSON.parse(request.input), fields: new Set(['id', 'memberIds']) });
    const split = () => Promise.resolve().then(async () => {
      const middle = Math.ceil(jobs.length / 2);
      // Complete both independent halves even when one needs a later retry.
      let failure;
      for (const half of [jobs.slice(0, middle), jobs.slice(middle)]) try { await send(half); } catch (error) { failure ||= error; }
      if (failure) throw failure;
    });
    try { assertGenerationRequestBudget(request, maximumRequestCharacters, generator); }
    catch (error) { if (jobs.length > 1 && isMemoryBudgetError(error)) return split(); throw error; }
    let generation;
    try { generation = await generator(request); }
    catch (error) {
      await onGeneration(error);
      if (jobs.length > 1 && ['MAX_TOKENS', 'MEMORY_OUTPUT_LIMIT'].includes(error.code)) return split();
      throw error;
    }
    await onGeneration(generation);
    let failure;
    for (const [index, job] of jobs.entries()) {
      try {
        const summary = parseStructureSummary(single ? generation.output : generation.output?.[keys[index]]);
        job.assertCurrent();
        await onSummary(job.group, summary);
      } catch (error) { failure ||= error; }
    }
    if (failure) throw failure;
  };
  await send(groups.map(prepare));
}

/** The same summarizer handles combined attachments and changed membership sets. */
export async function generateStructureSummary({ repository, agentId, memoryId, extraMemberIds = [], generator,
  onGeneration = async () => {} }) {
  const snapshot = summarySnapshot(repository, agentId, memoryId, extraMemberIds);
  const sourceMaterial = eventSourceMaterial(repository, agentId, snapshot.members.map(member => member.id));
  const request = { schemaName: 'memory-structure-summary-v1', schema: MEMORY_STRUCTURE_SUMMARY_SCHEMA, systemPrompt,
    ...(sourceMaterial ? { sourceMaterial } : {}),
    input: JSON.stringify({ kind: snapshot.container.kind,
      members: snapshot.members.map(memory => summaryMember(repository, memory)) }) };
  generator.assertRequestBudget?.(request);
  let generation;
  try { generation = await generator(request); }
  catch (error) { await onGeneration(error); throw error; }
  await onGeneration(generation);
  const output = parseStructureSummary(generation?.output);
  const assertCurrent = () => {
    const current = summarySnapshot(repository, agentId, memoryId, extraMemberIds);
    assertOrganizationInputCurrent(repository, agentId, snapshot.inputVersion);
    if (current.inputVersion.hash !== snapshot.inputVersion.hash) throw new OrganizationInputChangedError('Structure membership changed during summary generation.');
  };
  return { ...output, assertCurrent, sourceMemoryIds: snapshot.members.map(member => member.id) };
}

export async function refreshStructureSummary({ repository, agentId, memoryId, expectedSummary, generator,
  recordUsage = async () => {} }) {
  const current = repository.getMemory(memoryId);
  if (!current || current.status !== 'active') return { status: 'skipped', reason: 'container-not-active' };
  if (expectedSummary && !structureSummaryMatches(current, expectedSummary)) {
    return { status: 'skipped', reason: 'summary-already-replaced' };
  }
  const original = expectedStructureSummary(current);
  const summary = await generateStructureSummary({ repository, agentId, memoryId, generator, onGeneration: recordUsage });
  return repository.transaction(() => {
    if (!structureSummaryMatches(repository.getMemory(memoryId), original)) {
      return { status: 'skipped', reason: 'summary-already-replaced' };
    }
    summary.assertCurrent();
    const memory = repository.updateStructureSummary({ agentId, memoryId, title: summary.title,
      content: summary.content, proposalId: current.metadata.structureSummaryProposalId || '',
      sourceMemoryIds: summary.sourceMemoryIds,
      reason: 'Refresh summary from current structure members.' });
    enqueueMemoryMaintenanceTasks({ repository, agentId, memoryIds: [memoryId],
      taskTypes: [MAINTENANCE_TASK_TYPES.memoryEmbedding] });
    return { status: 'completed', memoryId: memory.id };
  });
}
