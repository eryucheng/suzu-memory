import { structureGenerationMaterial } from './generation-input.mjs';
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
  const list = fields => ({ type: 'array', maxItems: limit, items: {
    type: 'object', additionalProperties: false,
    required: Object.keys(fields).filter(key => key !== 'operation'),
    properties: Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'operation')),
  } });
  return { ...request,
    systemPrompt: `${request.systemPrompt}\n\n新建分组写入 creations，追加已有分组写入 attachments；两份列表合计最多 ${limit} 条。`,
    modelSchema: { type: 'object', additionalProperties: false, required: ['creations', 'attachments'],
      properties: { creations: list(createFields), attachments: list(attachFields) } },
    decodeModelOutput: output => {
      if (!output || !Array.isArray(output.creations) || !Array.isArray(output.attachments)) {
        throw new Error('Structure model output requires creations and attachments lists.');
      }
      return { proposals: [['creations', 'create'], ['attachments', 'attach']].flatMap(([key, operation]) =>
        output[key].map(item => ({ ...item, operation }))) };
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

export function buildStructureGenerationInput(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Memory structure generation requires a snapshot object.");
  }
  return JSON.stringify(structureGenerationMaterial(snapshot));
}

export function parseStructureGeneration(value, { maximumProposals = DEFAULT_MAXIMUM_PROPOSALS } = {}) {
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
    proposals: parsed.proposals.map((proposal, index) => {
      if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
        throw new Error(`Structure proposal ${index} must be an object.`);
      }
      return {
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
      };
    }),
  };
}
