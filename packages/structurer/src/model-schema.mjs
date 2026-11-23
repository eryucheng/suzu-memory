import { OrganizationCandidateError } from '@suzu-memory/core';

const idSchema = ids => ({ type: 'string', enum: ids });
const withMembers = (schema, ids) => ({ ...schema, items: idSchema(ids) });
const combinedSchemas = new Set(['memory-consolidation-combined-v2', 'memory-organization-decisions-v2']);
const reverseRelationDirection = new Map([
  ['anchor_to_related', 'related_to_anchor'],
  ['related_to_anchor', 'anchor_to_related'],
]);

function structureSelection(material, allIds) {
  const retrospective = material.retrospectiveContext;
  const targets = material.candidateContainers.filter(container => container.addableMemberIds.length
    && (!retrospective || [...container.memberIds, ...container.addableMemberIds]
      .some(id => retrospective.triggerMemoryIds.includes(id))));
  return {
    creations: allIds.length < 2 ? null : {
      firstMemberId: retrospective?.triggerMemoryIds || allIds,
      secondMemberId: retrospective ? [...retrospective.historicalMemoryIds,
        ...(retrospective.includeTriggerPairs ? retrospective.triggerMemoryIds : [])] : allIds,
      additionalMemberIds: allIds,
    },
    attachments: !targets.length ? null : {
      targets: targets.map(container => {
        const needsTrigger = retrospective && !container.memberIds.some(id => retrospective.triggerMemoryIds.includes(id));
        return { targetMemoryId: container.id, firstMemberId: needsTrigger
          ? container.addableMemberIds.filter(id => retrospective.triggerMemoryIds.includes(id)) : container.addableMemberIds };
      }),
      additionalMemberIds: [...new Set(targets.flatMap(container => container.addableMemberIds))],
    },
  };
}

function relationSelection(material, allIds) {
  const context = material.relationContext || (material.retrospectiveContext ? {
    anchorMemoryIds: material.retrospectiveContext.triggerMemoryIds,
    candidateMemoryIds: material.retrospectiveContext.historicalMemoryIds, includeAnchorPairs: false,
  } : null);
  const anchors = context?.anchorMemoryIds || allIds;
  return { relations: { anchorMemoryId: anchors, relatedMemoryId: context ? [...context.candidateMemoryIds,
    ...(context.includeAnchorPairs && anchors.length > 1 ? anchors : [])] : allIds } };
}

export function organizationSelectionScope(schemaName, material) {
  const allIds = [...(material.historicalMaterial?.memories || []), ...material.memories].map(memory => memory.id);
  if (combinedSchemas.has(schemaName)) return { ...structureSelection(material, allIds), ...relationSelection(material, allIds) };
  if (['memory-structure-proposals-v2', 'memory-structure-memberships-v1'].includes(schemaName)) return structureSelection(material, allIds);
  if (schemaName === 'memory-relation-proposals-v2') return relationSelection(material, allIds);
  return null;
}

function structureSchema(schema, scope) {
  const { creations, attachments } = schema.properties;
  const creationProperties = creations.items.properties;
  const attachmentProperties = attachments.items.properties;
  return { ...schema, properties: { ...schema.properties,
    creations: !scope.creations ? { type: 'null' } : { ...creations,
      items: { ...creations.items, properties: { ...creationProperties,
        firstMemberId: idSchema(scope.creations.firstMemberId), secondMemberId: idSchema(scope.creations.secondMemberId),
        additionalMemberIds: withMembers(creationProperties.additionalMemberIds, scope.creations.additionalMemberIds) } } },
    attachments: !scope.attachments ? { type: 'null' } : { ...attachments, items: { ...attachments.items, properties: {
      ...attachmentProperties, selection: { anyOf: scope.attachments.targets.map(target => ({ ...attachmentProperties.selection,
        properties: { targetMemoryId: idSchema([target.targetMemoryId]), firstMemberId: idSchema(target.firstMemberId) } })) },
      additionalMemberIds: withMembers(attachmentProperties.additionalMemberIds, scope.attachments.additionalMemberIds),
    } } },
  } };
}

function relationSchema(schema, { relations }) {
  const proposals = schema.properties.proposals;
  return { ...schema, properties: { ...schema.properties, proposals: { ...proposals,
    items: { ...proposals.items, properties: { ...proposals.items.properties,
      anchorMemoryId: idSchema(relations.anchorMemoryId), relatedMemoryId: idSchema(relations.relatedMemoryId),
    } },
  } } };
}

export function organizationModelSchema(schema, schemaName, scope) {
  if (!scope) return schema;
  if (combinedSchemas.has(schemaName)) return { ...schema, properties: {
    structure: structureSchema(schema.properties.structure, scope),
    relations: relationSchema(schema.properties.relations, scope),
  } };
  return scope.relations ? relationSchema(schema, scope) : structureSchema(schema, scope);
}

function allowedAdditions(ids, allowed) {
  return ids === undefined || (Array.isArray(ids) && ids.every(id => allowed.includes(id)));
}

function invalidSelection(field) {
  return new OrganizationCandidateError(`Organization model selection is outside selectionScope at ${field}.`,
    'MEMORY_ORGANIZATION_INVALID_SELECTION');
}

function structureChecks({ creations, attachments }) {
  return {
    creations: item => {
      if (!creations?.firstMemberId.includes(item.firstMemberId)) throw invalidSelection('creations.firstMemberId');
      if (!creations.secondMemberId.includes(item.secondMemberId)) throw invalidSelection('creations.secondMemberId');
      if (!allowedAdditions(item.additionalMemberIds, creations.additionalMemberIds)) throw invalidSelection('creations.additionalMemberIds');
      return item;
    },
    attachments: item => {
      const target = attachments?.targets.find(target => target.targetMemoryId === item.selection?.targetMemoryId);
      if (!target) throw invalidSelection('attachments.selection.targetMemoryId');
      if (!target.firstMemberId.includes(item.selection?.firstMemberId)) throw invalidSelection('attachments.selection.firstMemberId');
      if (!allowedAdditions(item.additionalMemberIds, attachments.additionalMemberIds)) throw invalidSelection('attachments.additionalMemberIds');
      return item;
    },
  };
}

function relationChecks({ relations }) {
  return { proposals: item => {
    const { anchorMemoryId, relatedMemoryId } = item;
    const anchorAllowed = relations.anchorMemoryId.includes(anchorMemoryId);
    const relatedAllowed = relations.relatedMemoryId.includes(relatedMemoryId);
    if (anchorAllowed && relatedAllowed) return item;
    const direction = reverseRelationDirection.get(item.direction);
    if (direction && relations.anchorMemoryId.includes(relatedMemoryId) && relations.relatedMemoryId.includes(anchorMemoryId)) {
      // Swapping both slots and the direction preserves the same directed edge.
      return { ...item, anchorMemoryId: relatedMemoryId, relatedMemoryId: anchorMemoryId, direction };
    }
    throw invalidSelection(anchorAllowed ? 'proposals.relatedMemoryId' : 'proposals.anchorMemoryId');
  } };
}

function checkSelectionLists(output, checks) {
  const rejections = new Map();
  if (!output || typeof output !== 'object' || Array.isArray(output)) return { output, rejections };
  const checked = { ...output };
  let position = 0;
  for (const [list, check] of Object.entries(checks)) {
    if (!Array.isArray(output[list])) continue;
    checked[list] = output[list].map(item => {
      const index = position++;
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      try { return check(item); }
      catch (error) {
        if (!(error instanceof OrganizationCandidateError)) throw error;
        rejections.set(index, error);
        return null;
      }
    });
  }
  return { output: checked, rejections };
}

function restoreSelectionRejections(decoded, rejections) {
  if (!rejections.size || !Array.isArray(decoded?.proposals)) return decoded;
  return { ...decoded, proposals: decoded.proposals.map((proposal, index) => rejections.get(index) || proposal) };
}

export function decodeOrganizationSelections(output, scope, decode, schemaName) {
  // Check short IDs and named slots before reference restoration or flattening.
  if (combinedSchemas.has(schemaName)) {
    const structure = checkSelectionLists(output?.structure, structureChecks(scope));
    const relations = checkSelectionLists(output?.relations, relationChecks(scope));
    const decoded = decode({ structure: structure.output, relations: relations.output });
    return { structure: restoreSelectionRejections(decoded.structure, structure.rejections),
      relations: restoreSelectionRejections(decoded.relations, relations.rejections) };
  }
  const checked = checkSelectionLists(output, scope.relations ? relationChecks(scope) : structureChecks(scope));
  return restoreSelectionRejections(decode(checked.output), checked.rejections);
}
