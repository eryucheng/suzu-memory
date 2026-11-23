import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { readOrganizationInput, assertOrganizationInputCurrent, proposeMemoryStructure,
  OrganizationInputChangedError, OrganizationCandidateError, eventSourceMaterial, modelCalendarFields,
  validateStructureMembership } from '@suzu-memory/core';
import { buildStructureSnapshot } from './snapshot.mjs';
import { canProposeStructure, enforceStructureCandidatePolicy, deriveEpisodeBoundary } from './policy.mjs';
import { MEMORY_STRUCTURE_MEMBERSHIP_SCHEMA, parseStructureGeneration, proposalSchemaForLimit,
  withStructureModelOutput, buildStructureGenerationInput, DEFAULT_MAXIMUM_PROPOSALS } from './prompt.mjs';
import { withGenerationReferences, assertGenerationRequestBudget, STRUCTURE_REQUEST_CHARACTERS } from './generation-input.mjs';
import { organizationRejection } from './rejection.mjs';
import { recordUsage } from './service.mjs';
import { generatePlannedStructureSummaries } from './summary-service.mjs';

const unique = values => [...new Set(values.filter(Boolean))];
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const prompt = fs.readFileSync(new URL('../resources/membership-system-prompt.md', import.meta.url), 'utf8').trim();

function plannedContainer(repository, group) {
  const memory = repository.getMemory(group.memberIds[0]);
  return { id: group.id, kind: group.kind, title: group.title, content: group.rationale,
    subjectRole: group.subjectRole, subjectKey: group.subjectKey, actorRoles: group.actorRoles,
    reality: memory.reality, worldId: memory.world_id, worldFrame: memory.world_frame,
    eventDate: group.eventDate, eventStart: group.eventStart, eventEnd: group.eventEnd,
    layer: 'provisional', planned: true, memberIds: group.memberIds, memberCount: group.memberIds.length };
}

export function prepareStructureMemberships({ repository, agentId, memoryIds, batchId, structurePlans,
  nearbyContainerIds = [], snapshotOptions = {}, generator, maximumProposals = DEFAULT_MAXIMUM_PROPOSALS,
  maximumRequestCharacters = STRUCTURE_REQUEST_CHARACTERS }) {
  const snapshot = buildStructureSnapshot({ repository, agentId, memoryIds, batchId, nearbyContainerIds,
    maxSnapshotChars: Infinity, ...snapshotOptions });
  const originals = snapshot.candidateContainers;
  const plans = structurePlans.filter(group => !group.proposalId);
  for (const group of plans) assertOrganizationInputCurrent(repository, agentId, group.inputVersion);
  const virtual = plans.filter(group => !group.targetMemoryId).map(group => plannedContainer(repository, group));
  const expanded = originals.map(container => {
    const group = plans.find(group => group.targetMemoryId === container.id);
    if (!group) return container;
    const memberIds = unique([...container.memberIds, ...group.memberIds]);
    return { ...container, memberIds, memberCount: memberIds.length };
  });
  // Earlier decisions are available to later parts without materializing a
  // temporary container or generating a summary of an unfinished member set.
  snapshot.candidateContainers = [...virtual, ...expanded];
  const dependencies = unique([...snapshot.currentMemories.map(memory => memory.id),
    ...originals.flatMap(container => [container.id, ...container.memberIds]), ...plans.flatMap(group => group.memberIds)]);
  const inputVersion = readOrganizationInput(repository, agentId, dependencies);
  snapshot.sourceMaterial = eventSourceMaterial(repository, agentId, dependencies);
  if (!maximumProposals || !canProposeStructure(snapshot)) return { snapshot, inputVersion, request: null };
  const request = withGenerationReferences(withStructureModelOutput({ schemaName: 'memory-structure-memberships-v1',
    schema: proposalSchemaForLimit(MEMORY_STRUCTURE_MEMBERSHIP_SCHEMA, maximumProposals), systemPrompt: prompt,
    input: buildStructureGenerationInput(snapshot), ...(snapshot.sourceMaterial ? { sourceMaterial: snapshot.sourceMaterial } : {}) }),
    { selectionInBody: true });
  assertGenerationRequestBudget(request, maximumRequestCharacters, generator);
  return { snapshot, inputVersion, request };
}

export async function stageStructureMemberships({ repository, agentId, batchId, generator, preparedGeneration,
  structurePlans, candidatePolicy, checkpoint, usageLedgerPath = '', maximumProposals = DEFAULT_MAXIMUM_PROPOSALS }) {
  const { snapshot, request, inputVersion } = preparedGeneration;
  const warnings = [], rejected = [], plannedIds = [];
  if (!request) return { status: 'skipped', plannedIds, proposed: [], duplicates: [], rejected, warnings };
  assertOrganizationInputCurrent(repository, agentId, inputVersion);
  const account = generation => recordUsage({ generation, usageLedgerPath, agentId, batchId, warnings, feature: 'memory-organization-membership' });
  let generation;
  try { generation = await generator(request); } catch (error) { await account(error); throw error; }
  const usageRecorded = await account(generation);
  assertOrganizationInputCurrent(repository, agentId, inputVersion);
  const parsed = parseStructureGeneration(generation.output, { maximumProposals, onRejected: ({ index, error }) => {
    rejected.push(organizationRejection(error instanceof OrganizationCandidateError ? error : new OrganizationCandidateError(error.message),
      { index, inputVersion, generation }));
  } });
  const returnedCount = parsed.proposals.length + rejected.length;
  for (const [index, item] of parsed.proposals.entries()) {
    try {
      const candidate = enforceStructureCandidatePolicy(item, snapshot, { timeZone: repository.timeZone,
        ...candidatePolicy, requireSummary: false });
      let group = candidate.operation === 'attach'
        ? structurePlans.find(group => group.id === candidate.targetMemoryId || group.targetMemoryId === candidate.targetMemoryId) : null;
      if (candidate.operation === 'create') {
        if (!candidate.title) throw new OrganizationCandidateError('A new membership group requires a descriptive title.');
        const id = `planned-structure-${fingerprint([batchId, candidate.kind, candidate.title, candidate.subjectRole,
          candidate.subjectKey, [...candidate.memberIds].sort()])}`;
        group = structurePlans.find(group => group.id === id);
        if (!group) {
          group = { ...candidate, id, targetMemoryId: '', memberIds: [], contributionIds: [] };
        }
      } else if (!group) {
        const target = snapshot.candidateContainers.find(container => container.id === candidate.targetMemoryId);
        group = { ...candidate, id: target.id, title: target.title, kind: target.kind,
          subjectRole: target.subjectRole, subjectKey: target.subjectKey, actorRoles: target.actorRoles,
          memberIds: [], contributionIds: [] };
      }
      const next = unique([...group.memberIds, ...candidate.memberIds]);
      const times = group.operation === 'create' && group.kind === 'episode' ? deriveEpisodeBoundary(next.map(id =>
        modelCalendarFields(repository.getMemory(id), ['eventDate', 'eventStart', 'eventEnd'], repository.listMemorySources(id))), repository.timeZone) : {};
      validateStructureMembership(repository, { ...group, ...times, agentId, memberIds: next });
      if (!structurePlans.includes(group)) structurePlans.push(group);
      Object.assign(group, times);
      if (next.length !== group.memberIds.length) delete group.summary;
      group.memberIds = next;
      group.confidence = Math.min(Number(group.confidence ?? 0.5), Number(candidate.confidence ?? 0.5));
      group.contributionIds = unique([...group.contributionIds, batchId]);
      const target = group.targetMemoryId ? repository.getMemory(group.targetMemoryId) : null;
      const existing = target ? repository.listContainerMembers({ agentId, containerId: target.id, containerKind: target.kind,
        relation: target.kind === 'topic' ? 'supports_topic' : 'part_of_episode', statuses: ['active','superseded','disputed','archived'] }) : [];
      group.inputVersion = readOrganizationInput(repository, agentId, unique([target?.id, ...next, ...existing.map(memory => memory.id)]));
      group.generatorModel = generation.model || '';
      group.generatorRequestId = generation.requestId || '';
      plannedIds.push(group.id);
    } catch (error) { rejected.push(organizationRejection(error, { index, candidate: item, inputVersion, generation })); }
  }
  checkpoint();
  return { status: rejected.some(item => item.retryable) ? 'partial-failure'
    : returnedCount === maximumProposals ? 'capacity-reached' : 'planned',
    plannedIds: unique(plannedIds), proposed: [], duplicates: [], rejected, warnings, usageRecorded };
}

export async function finalizeStructurePlans({ repository, agentId, runId, structurePlans, generator,
  checkpoint, usageLedgerPath = '', maximumRequestCharacters }) {
  const warnings = [], rejected = [], proposed = [], duplicates = [];
  const pending = structurePlans.filter(group => !group.proposalId);
  for (const group of pending) {
    assertOrganizationInputCurrent(repository, agentId, group.inputVersion);
    validateStructureMembership(repository, { ...group, agentId });
  }
  let summaryFailure;
  try {
    await generatePlannedStructureSummaries({ repository, agentId,
      groups: pending.filter(group => !group.summary), generator, maximumRequestCharacters,
      onGeneration: generation => recordUsage({ generation, usageLedgerPath, agentId, batchId: `${runId}:summaries`, warnings,
        feature: 'memory-structure-summary' }),
      onSummary(group, summary) {
        assertOrganizationInputCurrent(repository, agentId, group.inputVersion);
        group.summary = summary;
        checkpoint();
      } });
  } catch (error) { summaryFailure = error; }
  // A successful summary can be committed even if another summary needs retry.
  for (const group of pending.filter(group => group.summary)) {
    try {
      assertOrganizationInputCurrent(repository, agentId, group.inputVersion);
      const proposal = repository.transaction(() => {
        const result = proposeMemoryStructure(repository, { ...group, ...group.summary,
          id: `structure-proposal-${fingerprint([runId, group.id])}`,
          expectedInput: group.inputVersion, agentId, batchId: `${runId}:final`, provenance: 'memory-structurer-v1',
          metadata: { organizationPlanId: runId, groupingPlanId: group.id,
            generatorModel: group.generatorModel, generatorRequestId: group.generatorRequestId } });
        group.proposalId = result.id;
        group.resultMemoryId = result.result_memory_id;
        checkpoint();
        return result;
      });
      (proposal.wasInserted ? proposed : duplicates).push(proposal);
    } catch (error) {
      delete group.proposalId;
      delete group.resultMemoryId;
      if (error instanceof OrganizationInputChangedError) throw error;
      rejected.push(organizationRejection(error, { candidate: group, inputVersion: group.inputVersion }));
      throw error;
    }
  }
  if (summaryFailure) throw summaryFailure;
  return { status: proposed.length ? 'proposed' : 'no-valid-proposals', proposed, duplicates, rejected, warnings };
}
