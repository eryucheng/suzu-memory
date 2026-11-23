import { DEFAULT_MAXIMUM_PROPOSALS, proposalCountLimit, proposalSchemaForLimit } from './prompt.mjs';
import { MEMORY_EXPLANATORY_RELATIONS, OrganizationCandidateError } from '@suzu-memory/core';

function clean(value) {
  return String(value ?? "").trim();
}

const LEGACY_RELATION_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["proposals"],
  properties: {
    proposals: {
      type: "array",
      maxItems: DEFAULT_MAXIMUM_PROPOSALS,
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "relation", "fromMemoryId", "toMemoryId",
          "evidenceSourceIds", "confidence", "rationale",
        ],
        properties: {
          relation: { type: "string", enum: ["causes"] },
          fromMemoryId: { type: "string", minLength: 1 },
          toMemoryId: { type: "string", minLength: 1 },
          evidenceSourceIds: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string", minLength: 1 },
        },
      },
    },
  },
});

export const MEMORY_RELATION_OUTPUT_SCHEMA = Object.freeze({ ...LEGACY_RELATION_OUTPUT_SCHEMA,
  properties: { proposals: { ...LEGACY_RELATION_OUTPUT_SCHEMA.properties.proposals,
    items: { ...LEGACY_RELATION_OUTPUT_SCHEMA.properties.proposals.items,
      properties: { ...LEGACY_RELATION_OUTPUT_SCHEMA.properties.proposals.items.properties,
        relation: { type: 'string', enum: Object.keys(MEMORY_EXPLANATORY_RELATIONS),
          description: 'causes=经历引发结果；reason_for=行动或决定的理由；condition_for=成立或适用条件。方向均从原因、理由或条件指向受影响的记忆。' },
        rationale: { type: 'string', minLength: 1, description: '可独立理解的简短解释，保留解释者及原话的确定程度。' },
        scope: { type: 'string', description: '原话表达的适用时间、对象或场景；未说明时留空。' },
      },
    },
  } },
});

export function relationOutputSchema(maximumProposals, { excerpted = false, version = 2 } = {}) {
  const schema = proposalSchemaForLimit(version === 1 ? LEGACY_RELATION_OUTPUT_SCHEMA : MEMORY_RELATION_OUTPUT_SCHEMA, maximumProposals);
  if (!excerpted) return schema;
  return { ...schema, required: [...schema.required, 'needsFullEvidence'],
    properties: { ...schema.properties, needsFullEvidence: version === 1 ? { type: 'boolean' }
      : { type: 'boolean', description: '需要完整原话才能判断时为 true。' } } };
}

export function withRelationModelOutput(request) {
  const proposals = request.schema.properties.proposals;
  const properties = { ...proposals.items.properties,
    anchorMemoryId: { type: 'string', description: '本轮记忆。' }, relatedMemoryId: { type: 'string', description: '与其建立联系的记忆。' },
    direction: { type: 'string', enum: ['anchor_to_related', 'related_to_anchor'],
      description: 'anchor_to_related=本轮记忆影响关联记忆；related_to_anchor=关联记忆影响本轮记忆。' },
  };
  delete properties.fromMemoryId; delete properties.toMemoryId;
  return { ...request, modelSchema: { ...request.schema, properties: { ...request.schema.properties,
    proposals: { ...proposals, items: { type: 'object', additionalProperties: false,
      required: Object.keys(properties), properties } },
  } }, decodeModelOutput: output => {
    if (!output || !Array.isArray(output.proposals)) throw new Error('Relation model output requires a proposals list.');
    return { ...output, proposals: output.proposals.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
      const { anchorMemoryId, relatedMemoryId, direction, ...fields } = item;
      if (!['anchor_to_related', 'related_to_anchor'].includes(direction)) return fields;
      const forward = direction === 'anchor_to_related';
      return { ...fields, fromMemoryId: forward ? anchorMemoryId : relatedMemoryId,
        toMemoryId: forward ? relatedMemoryId : anchorMemoryId };
    }) };
  } };
}

export function buildRelationGenerationInput(snapshot, { excerpted = false } = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Memory relation generation requires a snapshot object.");
  }
  const { memories, retrospectiveContext } = snapshot;
  const sourceRecords = snapshot.sourceRecords.map(source => {
    const range = excerpted && snapshot.sourceExcerpts?.get(source.id);
    return range ? { ...source, content: source.content.slice(range.start, range.end), excerpt: true } : source;
  });
  return JSON.stringify({ memories, sourceRecords, retrospectiveContext,
    ...(snapshot.relationContext ? { relationContext: snapshot.relationContext } : {}) });
}

export function parseRelationGeneration(value, { maximumProposals = DEFAULT_MAXIMUM_PROPOSALS } = {}) {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Memory relation generator returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Memory relation generator did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Memory relation generator output must be an object.");
  }
  if (!Array.isArray(parsed.proposals)) {
    throw new Error("Memory relation generator output requires a proposals array.");
  }
  const limit = proposalCountLimit(maximumProposals);
  if (parsed.proposals.length > limit) {
    throw new Error(`Memory relation generator returned more than ${limit} proposals.`);
  }
  return {
    ...(Object.hasOwn(parsed, 'needsFullEvidence') ? { needsFullEvidence: parsed.needsFullEvidence } : {}),
    proposals: parsed.proposals.map((proposal, index) => {
      if (proposal instanceof OrganizationCandidateError || !proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
        return proposal;
      }
      return {
        relation: clean(proposal.relation),
        fromMemoryId: clean(proposal.fromMemoryId),
        toMemoryId: clean(proposal.toMemoryId),
        evidenceSourceIds: Array.isArray(proposal.evidenceSourceIds)
          ? [...new Set(proposal.evidenceSourceIds.map(clean).filter(Boolean))]
          : [],
        confidence: proposal.confidence,
        rationale: clean(proposal.rationale),
        ...(Object.hasOwn(proposal, 'scope') ? { scope: proposal.scope } : {}),
      };
    }),
  };
}
