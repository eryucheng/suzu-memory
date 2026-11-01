import { analysisCountLimit, parseAnalysisItems } from "./analysis-output.mjs";
function clean(value) {
  return String(value ?? "").trim();
}
const COMMON_REQUIRED = Object.freeze([
  "memoryId",
  "sourceIds",
  "confidence",
  "rationale",
]);

const COMMON_PROPERTIES = Object.freeze({
  memoryId: { type: "string", minLength: 1 },
  sourceIds: {
    type: "array",
    minItems: 1,
    uniqueItems: true,
    items: { type: "string", minLength: 1 },
  },
  confidence: { type: "number", minimum: 0, maximum: 1 },
  rationale: { type: "string", minLength: 1 },
});

function resultSchema(required, properties) {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["analyses"],
    properties: {
      analyses: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [...COMMON_REQUIRED, ...required],
          properties: { ...COMMON_PROPERTIES, ...properties },
        },
      },
    },
  });
}

export const BELIEF_ANALYZERS = Object.freeze({
  propositionGrounding: Object.freeze({
    stateFamily: "belief",
    role: "proposition-grounding",
    schemaName: "memory-belief-proposition-grounding-v1",
    promptVersion: "belief-proposition-grounding-v1",
    promptFile: "belief-proposition-grounding-system-prompt.md",
    schema: resultSchema([
      "targetMatch",
      "claimText",
      "stance",
      "claimKind",
      "quantifier",
    ], {
      targetMatch: {
        type: "string",
        enum: ["exact", "subcategory", "broader_category", "contextual", "none", "unknown"],
      },
      claimText: { type: "string" },
      stance: { type: "string", enum: ["asserts", "denies", "uncertain", "mixed", "no_claim", "unknown"] },
      claimKind: {
        type: "string",
        enum: ["opinion", "interpretation", "expectation", "factual_claim", "value_judgment", "unknown"],
      },
      quantifier: { type: "string", enum: ["universal", "general", "some", "specific", "unknown"] },
    }),
  }),
  holderAttribution: Object.freeze({
    stateFamily: "belief",
    role: "holder-attribution",
    schemaName: "memory-belief-holder-attribution-v1",
    promptVersion: "belief-holder-attribution-v1",
    promptFile: "belief-holder-attribution-system-prompt.md",
    schema: resultSchema(["holderMatch", "attribution"], {
      holderMatch: { type: "string", enum: ["yes", "no", "unknown"] },
      attribution: {
        type: "string",
        enum: [
          "explicit_self_statement", "explicit_reported_statement", "third_party_attribution",
          "agent_inference", "quoted_or_roleplay", "no_holder", "unknown",
        ],
      },
    }),
  }),
  timeRevision: Object.freeze({
    stateFamily: "belief",
    role: "time-revision",
    schemaName: "memory-belief-time-revision-v1",
    promptVersion: "belief-time-revision-v1",
    promptFile: "belief-time-revision-system-prompt.md",
    schema: resultSchema(["stateTime", "revisionCue", "timeReference"], {
      stateTime: { type: "string", enum: ["current", "historical", "future", "timeless", "unknown"] },
      revisionCue: {
        type: "string",
        enum: [
          "maintains", "changed_mind", "revises_scope", "retracts_current",
          "denies_prior_holding", "none", "unknown",
        ],
      },
      timeReference: { type: "string" },
    }),
  }),
  currentRelation: Object.freeze({
    stateFamily: "belief",
    role: "current-relation",
    schemaName: "memory-belief-current-relation-v1",
    promptVersion: "belief-current-relation-v1",
    promptFile: "belief-current-relation-system-prompt.md",
    schema: resultSchema(["currentStatePresent", "relation", "scopeOverlap"], {
      currentStatePresent: { type: "boolean" },
      relation: {
        type: "string",
        enum: [
          "no_current_state", "equivalent", "supports", "narrows", "broadens",
          "partial_exception", "same_scope_conflict", "retracts", "unrelated", "unknown",
        ],
      },
      scopeOverlap: { type: "string", enum: ["exact", "subcategory", "broader", "partial", "none", "unknown"] },
    }),
  }),
});

function requireEnum(value, field, allowed) {
  const normalized = clean(value);
  if (!allowed.includes(normalized)) {
    throw new Error(`${field} has an unknown value: ${normalized || "(empty)"}.`);
  }
  return normalized;
}

function parseCommon(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Belief analysis ${index} must be an object.`);
  }
  const memoryId = clean(value.memoryId);
  const sourceIds = [...new Set(
    (Array.isArray(value.sourceIds) ? value.sourceIds : []).map(clean).filter(Boolean),
  )];
  const confidence = Number(value.confidence);
  const rationale = clean(value.rationale);
  if (!memoryId || !sourceIds.length || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1 || !rationale) {
    throw new Error(`Belief analysis ${index} has an invalid common envelope.`);
  }
  return { memoryId, sourceIds, confidence, rationale };
}

function parseRoleItem(role, value, index) {
  const common = parseCommon(value, index);
  if (role === "proposition-grounding") {
    return {
      ...common,
      targetMatch: requireEnum(value.targetMatch, `analyses[${index}].targetMatch`, [
        "exact", "subcategory", "broader_category", "contextual", "none", "unknown",
      ]),
      claimText: clean(value.claimText),
      stance: requireEnum(value.stance, `analyses[${index}].stance`, [
        "asserts", "denies", "uncertain", "mixed", "no_claim", "unknown",
      ]),
      claimKind: requireEnum(value.claimKind, `analyses[${index}].claimKind`, [
        "opinion", "interpretation", "expectation", "factual_claim", "value_judgment", "unknown",
      ]),
      quantifier: requireEnum(value.quantifier, `analyses[${index}].quantifier`, [
        "universal", "general", "some", "specific", "unknown",
      ]),
    };
  }
  if (role === "holder-attribution") {
    return {
      ...common,
      holderMatch: requireEnum(value.holderMatch, `analyses[${index}].holderMatch`, ["yes", "no", "unknown"]),
      attribution: requireEnum(value.attribution, `analyses[${index}].attribution`, [
        "explicit_self_statement", "explicit_reported_statement", "third_party_attribution",
        "agent_inference", "quoted_or_roleplay", "no_holder", "unknown",
      ]),
    };
  }
  if (role === "time-revision") {
    return {
      ...common,
      stateTime: requireEnum(value.stateTime, `analyses[${index}].stateTime`, [
        "current", "historical", "future", "timeless", "unknown",
      ]),
      revisionCue: requireEnum(value.revisionCue, `analyses[${index}].revisionCue`, [
        "maintains", "changed_mind", "revises_scope", "retracts_current",
        "denies_prior_holding", "none", "unknown",
      ]),
      timeReference: clean(value.timeReference),
    };
  }
  if (role === "current-relation") {
    if (typeof value.currentStatePresent !== "boolean") {
      throw new Error(`analyses[${index}].currentStatePresent must be boolean.`);
    }
    return {
      ...common,
      currentStatePresent: value.currentStatePresent,
      relation: requireEnum(value.relation, `analyses[${index}].relation`, [
        "no_current_state", "equivalent", "supports", "narrows", "broadens",
        "partial_exception", "same_scope_conflict", "retracts", "unrelated", "unknown",
      ]),
      scopeOverlap: requireEnum(value.scopeOverlap, `analyses[${index}].scopeOverlap`, [
        "exact", "subcategory", "broader", "partial", "none", "unknown",
      ]),
    };
  }
  throw new Error(`Unknown belief analyzer role: ${role || "(empty)"}.`);
}

export function parseBeliefGeneration(role, value, { maximumAnalyses = Infinity, onRejected } = {}) {
  if (!Object.values(BELIEF_ANALYZERS).some((definition) => definition.role === role)) {
    throw new Error(`Unknown belief analyzer role: ${clean(role) || "(empty)"}.`);
  }
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Belief analyzer returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Belief analyzer did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || !Array.isArray(parsed.analyses)) {
    throw new Error("Belief analyzer output requires an analyses array.");
  }
  const limit = analysisCountLimit(maximumAnalyses);
  if (parsed.analyses.length > limit) {
    throw new Error(`Belief analyzer returned more than ${limit} analyses.`);
  }
  return { analyses: parseAnalysisItems(parsed.analyses, (item, index) => parseRoleItem(role, item, index), onRejected) };
}

export function buildBeliefGenerationInput(snapshot, definition) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Belief generation requires a snapshot object.");
  }
  if (!definition?.role) throw new Error("Belief generation requires a known analyzer definition.");
  return JSON.stringify(snapshot, null, 2);
}
