import { structureGenerationMaterial } from './generation-input.mjs';
import { OrganizationCandidateError } from '@suzu-memory/core';
import fs from 'node:fs';

export const STRUCTURE_SUMMARY_INSTRUCTIONS = fs.readFileSync(
  new URL('../resources/summary-system-prompt.md', import.meta.url), 'utf8').trim();

export const MEMORY_STRUCTURE_SUMMARY_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['title', 'content'],
  properties: { title: { type: 'string', minLength: 1 }, content: { type: 'string', minLength: 1 } },
});

export function parseStructureSummary(output) {
  if (typeof output === 'string') output = JSON.parse(output);
  if (!output || typeof output.title !== 'string' || !output.title.trim()
    || typeof output.content !== 'string' || !output.content.trim()) throw new Error('Structure summary requires title and content.');
  return { title: output.title.trim(), content: output.content.trim() };
}

function clean(value) {
  return String(value ?? "").trim();
}

export const DEFAULT_MAXIMUM_PROPOSALS = 20;

export function proposalCountLimit(value = DEFAULT_MAXIMUM_PROPOSALS) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('maximumProposals must be a non-negative safe integer.');
  }
  return value;
}

export function proposalSchemaForLimit(schema, maximumProposals = DEFAULT_MAXIMUM_PROPOSALS) {
  return { ...schema, properties: { ...schema.properties,
    proposals: { ...schema.properties.proposals, maxItems: proposalCountLimit(maximumProposals) },
  } };
}

const actorRoleSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["role", "actorRole", "actorKey", "isPrimary", "confidence"],
  properties: {
    role: {
      type: "string",
      enum: [
        "subject", "experiencer", "speaker", "observer",
        "participant", "belief_holder", "preference_holder",
      ],
    },
    actorRole: {
      type: "string",
      enum: ["user", "agent", "shared", "other", "world", "unknown"],
    },
    actorKey: { type: "string" },
    isPrimary: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
});

const summaryFields = {
  title: { type: 'string' },
  content: { type: 'string', minLength: 1, description: '重新归纳分组的整体含义，合并重复经过，保留关键类别、人物归属及重要变化。' },
  memberIds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
  confidence: { type: 'number', minimum: 0, maximum: 1 },
  rationale: { type: 'string', description: '简述成员之间的实际联系及归组依据。' },
};
const createFields = {
  operation: { type: 'string', enum: ['create'] },
  kind: { type: 'string', enum: ['episode', 'topic'] },
  ...summaryFields,
  memberIds: { ...summaryFields.memberIds, minItems: 2 },
  subjectRole: { type: 'string', enum: ['user', 'agent', 'shared', 'other', 'world', 'unknown'] },
  subjectKey: { type: 'string' },
  actorRoles: { type: 'array', items: actorRoleSchema },
};
const attachFields = {
  operation: { type: 'string', enum: ['attach'] },
  targetMemoryId: { type: 'string', minLength: 1 },
  ...summaryFields,
};

// The model uses two uniform lists. Application consumers retain one proposal contract.
export function withStructureModelOutput(request) {
  const limit = request.schema.properties.proposals.maxItems;
  const variants = request.schema.properties.proposals.items.anyOf;
  const createTemplate = variants.find(item => item.properties.operation.enum.includes('create')).properties;
  const attachTemplate = variants.find(item => item.properties.operation.enum.includes('attach')).properties;
  // Required scalar references do not depend on provider support for minItems.
  const memberFields = { firstMemberId: { type: 'string' },
    additionalMemberIds: { type: 'array', items: { type: 'string' } } };
  const creationFields = { ...createTemplate, ...memberFields, secondMemberId: { type: 'string' } };
  const attachmentFields = { ...attachTemplate, additionalMemberIds: memberFields.additionalMemberIds,
    selection: { type: 'object', additionalProperties: false, required: ['targetMemoryId', 'firstMemberId'],
      properties: { targetMemoryId: attachFields.targetMemoryId, firstMemberId: memberFields.firstMemberId } } };
  delete creationFields.memberIds; delete attachmentFields.memberIds;
  delete attachmentFields.targetMemoryId;
  const list = fields => ({ type: 'array', maxItems: limit, items: {
    type: 'object', additionalProperties: false,
    required: Object.keys(fields).filter(key => key !== 'operation'),
    properties: Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'operation')),
  } });
  const selectionInstructions = request.schemaName === 'memory-structure-memberships-v1'
    ? '每个字段只选 selectionScope 对应列表中的 ID。同一提案内成员不得重复。追加的 targetMemoryId 和 firstMemberId 必须来自同一个 targets 条目。没有额外成员时补充列表为空。选择表中为 null 的类别返回空列表。'
    : '每个字段只选 Schema 给出的 ID，不重复引用。没有额外成员时补充列表为空。Schema 为 null 的类别没有可执行操作，返回 null。';
  return { ...request,
    systemPrompt: `${request.systemPrompt}\n\n新建分组写入 creations，追加已有分组写入 attachments；两份列表合计最多 ${limit} 条。`
      + '\ncreations 用 firstMemberId 和 secondMemberId 选择两个不同的必要成员，其余成员放入 additionalMemberIds。attachments 的 selection 同时选择 targetMemoryId 和一个必需的新增成员 firstMemberId；additionalMemberIds 填写其余相关新增成员，排除目标已拥有的成员。'
      + selectionInstructions,
    modelSchema: { type: 'object', additionalProperties: false, required: ['creations', 'attachments'],
      properties: { creations: list(creationFields), attachments: list(attachmentFields) } },
    decodeModelOutput: output => {
      if (!output || !['creations', 'attachments'].every(key => output[key] === null || Array.isArray(output[key]))) {
        throw new Error('Structure model output requires creations and attachments lists.');
      }
      return { proposals: [['creations', 'create'], ['attachments', 'attach']].flatMap(([key, operation]) =>
        (output[key] || []).map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
          const { selection, firstMemberId, secondMemberId, additionalMemberIds, ...fields } = item;
          if (additionalMemberIds !== undefined && !Array.isArray(additionalMemberIds)) return { ...fields, operation, memberIds: [] };
          return { ...fields, ...(operation === 'attach' ? { targetMemoryId: selection?.targetMemoryId } : {}),
            operation, memberIds: [...new Set([operation === 'attach' ? selection?.firstMemberId : firstMemberId,
            ...(operation === 'create' ? [secondMemberId] : []), ...(additionalMemberIds || [])].filter(Boolean))] };
        })) };
    },
  };
}

export const MEMORY_STRUCTURE_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: DEFAULT_MAXIMUM_PROPOSALS,
      items: { anyOf: [createFields, attachFields].map(properties => ({
        type: 'object', additionalProperties: false, required: Object.keys(properties), properties,
      })) },
    },
  },
});

// Membership decisions have their own contract. Summaries belong to the final
// member set, so a staged decision never fabricates an intermediate summary.
export const MEMORY_STRUCTURE_MEMBERSHIP_SCHEMA = Object.freeze({ ...MEMORY_STRUCTURE_OUTPUT_SCHEMA,
  properties: { proposals: { ...MEMORY_STRUCTURE_OUTPUT_SCHEMA.properties.proposals,
    items: { anyOf: [createFields, attachFields].map(fields => {
      const properties = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'content'
        && !(fields === attachFields && key === 'title')));
      return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
    }) },
  } },
});

export function buildStructureGenerationInput(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Memory structure generation requires a snapshot object.");
  }
  return JSON.stringify(structureGenerationMaterial(snapshot));
}

export function parseStructureGeneration(value, { maximumProposals = DEFAULT_MAXIMUM_PROPOSALS, onRejected } = {}) {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Memory structure generator returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Memory structure generator did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Memory structure generator output must be an object.");
  }
  if (!Array.isArray(parsed.proposals)) {
    throw new Error("Memory structure generator output requires a proposals array.");
  }
  const limit = proposalCountLimit(maximumProposals);
  if (parsed.proposals.length > limit) {
    throw Object.assign(new Error(`Memory structure generator returned more than ${limit} proposals.`),
      { code: 'MEMORY_STRUCTURE_OUTPUT_FULL' });
  }
  return {
    proposals: parsed.proposals.flatMap((proposal, index) => {
      if (proposal instanceof OrganizationCandidateError || !proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
        const error = proposal instanceof OrganizationCandidateError ? proposal : new Error(`Structure proposal ${index} must be an object.`);
        if (!onRejected) throw error;
        onRejected({ index, error });
        return [];
      }
      return [{
        operation: clean(proposal.operation),
        targetMemoryId: clean(proposal.targetMemoryId),
        kind: clean(proposal.kind),
        title: clean(proposal.title),
        content: clean(proposal.content),
        subjectRole: clean(proposal.subjectRole) || "unknown",
        subjectKey: clean(proposal.subjectKey),
        eventDate: clean(proposal.eventDate) || null,
        eventStart: clean(proposal.eventStart) || null,
        eventEnd: clean(proposal.eventEnd) || null,
        memberIds: Array.isArray(proposal.memberIds) ? proposal.memberIds.map(clean).filter(Boolean) : [],
        actorRoles: Array.isArray(proposal.actorRoles) ? proposal.actorRoles : [],
        confidence: proposal.confidence,
        rationale: clean(proposal.rationale),
      }];
    }),
  };
}
