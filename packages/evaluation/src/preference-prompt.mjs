import {
  PREFERENCE_EVIDENCE_ENUMS,
  PREFERENCE_EVIDENCE_SIGNALS,
  analysisCountLimit,
} from "@suzu-memory/analysis";

function clean(value) {
  return String(value ?? "").trim();
}

const REQUIRED_FIELDS = Object.freeze([
  "memoryId",
  "sourceIds",
  "signal",
  "confidence",
  "agency",
  "constraint",
  "alternatives",
  "instrumentalGoal",
  "opportunityCost",
  "topicInitiation",
  "affectiveExpression",
  "canDecline",
  "rationale",
]);

export const MEMORY_PREFERENCE_EVIDENCE_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["evidence"],
  properties: {
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: REQUIRED_FIELDS,
        properties: {
          memoryId: { type: "string", minLength: 1 },
          sourceIds: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          signal: { type: "string", enum: PREFERENCE_EVIDENCE_SIGNALS },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          agency: { type: "string", enum: PREFERENCE_EVIDENCE_ENUMS.agency },
          constraint: { type: "string", enum: PREFERENCE_EVIDENCE_ENUMS.constraint },
          alternatives: { type: "string", enum: PREFERENCE_EVIDENCE_ENUMS.alternatives },
          instrumentalGoal: {
            type: "string",
            enum: PREFERENCE_EVIDENCE_ENUMS.instrumentalGoal,
          },
          opportunityCost: {
            type: "string",
            enum: PREFERENCE_EVIDENCE_ENUMS.opportunityCost,
          },
          topicInitiation: {
            type: "string",
            enum: PREFERENCE_EVIDENCE_ENUMS.topicInitiation,
          },
          affectiveExpression: {
            type: "string",
            enum: PREFERENCE_EVIDENCE_ENUMS.affectiveExpression,
          },
          canDecline: { type: "boolean" },
          rationale: { type: "string" },
        },
      },
    },
  },
});

export function buildPreferenceEvidenceGenerationInput(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Preference evidence generation requires a snapshot object.");
  }
  return JSON.stringify(snapshot, null, 2);
}

function requireEnum(value, field, allowed) {
  const normalized = clean(value);
  if (!allowed.includes(normalized)) {
    throw new Error(`${field} has an unknown value: ${normalized || "(empty)"}.`);
  }
  return normalized;
}

function normalizeEvidence(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Preference evidence ${index} must be an object.`);
  }
  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      throw new Error(`Preference evidence ${index} is missing ${field}.`);
    }
  }
  if (!Array.isArray(value.sourceIds)) {
    throw new Error(`Preference evidence ${index}.sourceIds must be an array.`);
  }
  const sourceIds = [...new Set(value.sourceIds.map(clean).filter(Boolean))];
  const confidence = Number(value.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error(`Preference evidence ${index}.confidence must be between 0 and 1.`);
  }
  if (typeof value.canDecline !== "boolean") {
    throw new Error(`Preference evidence ${index}.canDecline must be boolean.`);
  }
  return {
    memoryId: clean(value.memoryId),
    sourceIds,
    signal: requireEnum(value.signal, `evidence[${index}].signal`, PREFERENCE_EVIDENCE_SIGNALS),
    confidence,
    agency: requireEnum(value.agency, `evidence[${index}].agency`, PREFERENCE_EVIDENCE_ENUMS.agency),
    constraint: requireEnum(
      value.constraint,
      `evidence[${index}].constraint`,
      PREFERENCE_EVIDENCE_ENUMS.constraint,
    ),
    alternatives: requireEnum(
      value.alternatives,
      `evidence[${index}].alternatives`,
      PREFERENCE_EVIDENCE_ENUMS.alternatives,
    ),
    instrumentalGoal: requireEnum(
      value.instrumentalGoal,
      `evidence[${index}].instrumentalGoal`,
      PREFERENCE_EVIDENCE_ENUMS.instrumentalGoal,
    ),
    opportunityCost: requireEnum(
      value.opportunityCost,
      `evidence[${index}].opportunityCost`,
      PREFERENCE_EVIDENCE_ENUMS.opportunityCost,
    ),
    topicInitiation: requireEnum(
      value.topicInitiation,
      `evidence[${index}].topicInitiation`,
      PREFERENCE_EVIDENCE_ENUMS.topicInitiation,
    ),
    affectiveExpression: requireEnum(
      value.affectiveExpression,
      `evidence[${index}].affectiveExpression`,
      PREFERENCE_EVIDENCE_ENUMS.affectiveExpression,
    ),
    canDecline: value.canDecline,
    rationale: clean(value.rationale),
  };
}

export function parsePreferenceEvidenceGeneration(value, { maximumEvidence = Infinity } = {}) {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^\uFEFF/u, "").trim();
    if (!text) throw new Error("Preference evidence generator returned empty output.");
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Preference evidence generator did not return valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Preference evidence generator output must be an object.");
  }
  if (!Array.isArray(parsed.evidence)) {
    throw new Error("Preference evidence generator output requires an evidence array.");
  }
  const limit = analysisCountLimit(maximumEvidence, 'maximumEvidence');
  if (parsed.evidence.length > limit) {
    throw new Error(`Preference evidence generator returned more than ${limit} items.`);
  }
  return { evidence: parsed.evidence.map(normalizeEvidence) };
}
