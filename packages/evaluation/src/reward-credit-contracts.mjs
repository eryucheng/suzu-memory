function clean(value) {
  return String(value ?? "").trim();
}

function objectSchema(required, properties) {
  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required,
    properties,
  });
}

export const REWARD_CREDIT_ANALYZERS = Object.freeze({
  outcome: Object.freeze({
    role: "outcome",
    schemaName: "memory-reward-outcome-v1",
    promptVersion: "memory-reward-outcome-v1",
    promptFile: "reward-outcome-system-prompt.md",
    schema: objectSchema(
      ["outcomeClass", "valence", "evidenceTier", "confidence", "rationale"],
      {
        outcomeClass: {
          type: "string",
          enum: [
            "explicit_help", "successful_outcome", "adoption_pending",
            "social_affect", "correction", "failed_outcome", "no_result", "uncertain",
          ],
        },
        valence: { type: "string", enum: ["positive", "negative", "neutral", "mixed", "uncertain"] },
        evidenceTier: {
          type: "string",
          enum: ["explicit_attribution", "reported_outcome", "externally_verified", "implicit", "none", "uncertain"],
        },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        rationale: { type: "string", minLength: 1 },
      },
    ),
  }),
  target: Object.freeze({
    role: "target",
    schemaName: "memory-reward-target-v1",
    promptVersion: "memory-reward-target-v1",
    promptFile: "reward-target-system-prompt.md",
    schema: objectSchema(
      ["targetType", "targetMemoryIds", "explicitAttribution", "confidence", "rationale"],
      {
        targetType: {
          type: "string",
          enum: [
            "retrieved_memory", "answer_content", "agent_style", "relationship_affect",
            "external_event", "mixed", "uncertain",
          ],
        },
        targetMemoryIds: {
          type: "array",
          uniqueItems: true,
          maxItems: 30,
          items: { type: "string", minLength: 1 },
        },
        explicitAttribution: { type: "boolean" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        rationale: { type: "string", minLength: 1 },
      },
    ),
  }),
  credit: Object.freeze({
    role: "credit",
    schemaName: "memory-reward-credit-v1",
    promptVersion: "memory-reward-credit-v1",
    promptFile: "reward-credit-system-prompt.md",
    schema: objectSchema(["analyses"], {
      analyses: {
        type: "array",
        maxItems: 30,
        items: objectSchema(
          ["memoryId", "contributionClass", "contributionShare", "contextKey", "confidence", "rationale"],
          {
            memoryId: { type: "string", minLength: 1 },
            contributionClass: { type: "string", enum: ["direct", "partial", "none", "uncertain"] },
            contributionShare: { type: "number", minimum: 0, maximum: 1 },
            contextKey: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            rationale: { type: "string", minLength: 1 },
          },
        ),
      },
    }),
  }),
});

function parsedObject(value, label) {
  let parsed = value;
  if (typeof parsed === "string") {
    const text = parsed.replace(/^```(?:json)?\s*|\s*```$/giu, "").trim();
    try { parsed = JSON.parse(text); } catch (error) {
      throw new Error(`${label} output is not valid JSON: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} output must be an object.`);
  }
  return parsed;
}

function exactKeys(value, expected, label) {
  if (Object.keys(value).sort().join("\u001f") !== [...expected].sort().join("\u001f")) {
    throw new Error(`${label} output has an invalid shape.`);
  }
}

function confidence(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`${label} confidence must be between 0 and 1.`);
  }
  return number;
}

function enumValue(value, allowed, label) {
  const normalized = clean(value);
  if (!allowed.includes(normalized)) throw new Error(`${label} has an unknown value: ${normalized || "(empty)"}.`);
  return normalized;
}

export function parseRewardOutcomeGeneration(value) {
  const parsed = parsedObject(value, "Reward outcome");
  exactKeys(parsed, ["outcomeClass", "valence", "evidenceTier", "confidence", "rationale"], "Reward outcome");
  const result = {
    outcomeClass: enumValue(parsed.outcomeClass, [
      "explicit_help", "successful_outcome", "adoption_pending", "social_affect",
      "correction", "failed_outcome", "no_result", "uncertain",
    ], "outcomeClass"),
    valence: enumValue(parsed.valence, ["positive", "negative", "neutral", "mixed", "uncertain"], "valence"),
    evidenceTier: enumValue(parsed.evidenceTier, [
      "explicit_attribution", "reported_outcome", "externally_verified", "implicit", "none", "uncertain",
    ], "evidenceTier"),
    confidence: confidence(parsed.confidence, "Reward outcome"),
    rationale: clean(parsed.rationale),
  };
  if (!result.rationale) throw new Error("Reward outcome rationale is required.");
  return result;
}

export function parseRewardTargetGeneration(value, { allowedMemoryIds = [] } = {}) {
  const parsed = parsedObject(value, "Reward target");
  exactKeys(parsed, ["targetType", "targetMemoryIds", "explicitAttribution", "confidence", "rationale"], "Reward target");
  const allowed = new Set(allowedMemoryIds.map(clean).filter(Boolean));
  const targetMemoryIds = [...new Set(
    (Array.isArray(parsed.targetMemoryIds) ? parsed.targetMemoryIds : []).map(clean).filter(Boolean),
  )];
  if (targetMemoryIds.some((memoryId) => !allowed.has(memoryId))) {
    throw new Error("Reward target referenced a memory outside the used-memory boundary.");
  }
  const result = {
    targetType: enumValue(parsed.targetType, [
      "retrieved_memory", "answer_content", "agent_style", "relationship_affect",
      "external_event", "mixed", "uncertain",
    ], "targetType"),
    targetMemoryIds,
    explicitAttribution: parsed.explicitAttribution === true,
    confidence: confidence(parsed.confidence, "Reward target"),
    rationale: clean(parsed.rationale),
  };
  if (typeof parsed.explicitAttribution !== "boolean" || !result.rationale) {
    throw new Error("Reward target attribution and rationale are required.");
  }
  return result;
}

export function parseRewardCreditGeneration(value, { expectedMemoryIds = [] } = {}) {
  const parsed = parsedObject(value, "Reward credit");
  exactKeys(parsed, ["analyses"], "Reward credit");
  if (!Array.isArray(parsed.analyses)) throw new Error("Reward credit analyses must be an array.");
  const expected = [...new Set(expectedMemoryIds.map(clean).filter(Boolean))].sort();
  const seen = new Set();
  const analyses = parsed.analyses.map((item, index) => {
    const label = `Reward credit analyses[${index}]`;
    const row = parsedObject(item, label);
    exactKeys(row, [
      "memoryId", "contributionClass", "contributionShare", "contextKey", "confidence", "rationale",
    ], label);
    const memoryId = clean(row.memoryId);
    if (!memoryId || seen.has(memoryId)) throw new Error(`${label} has a missing or duplicate memoryId.`);
    seen.add(memoryId);
    const share = Number(row.contributionShare);
    if (!Number.isFinite(share) || share < 0 || share > 1) throw new Error(`${label} has an invalid contributionShare.`);
    const result = {
      memoryId,
      contributionClass: enumValue(row.contributionClass, ["direct", "partial", "none", "uncertain"], `${label}.contributionClass`),
      contributionShare: share,
      contextKey: clean(row.contextKey),
      confidence: confidence(row.confidence, label),
      rationale: clean(row.rationale),
    };
    if (!result.rationale) throw new Error(`${label} rationale is required.`);
    if (["none", "uncertain"].includes(result.contributionClass) && result.contributionShare !== 0) {
      throw new Error(`${label} none or uncertain contribution must have a zero share.`);
    }
    if (["direct", "partial"].includes(result.contributionClass) && result.contributionShare <= 0) {
      throw new Error(`${label} direct or partial contribution must have a positive share.`);
    }
    return result;
  });
  if (analyses.map((item) => item.memoryId).sort().join("\u001f") !== expected.join("\u001f")) {
    throw new Error("Reward credit must classify every used memory exactly once.");
  }
  const totalShare = analyses.reduce((sum, item) => sum + item.contributionShare, 0);
  if (totalShare > 1.000001) throw new Error("Reward credit contribution shares must not exceed 1 in total.");
  return { analyses };
}

export function buildRewardAnalyzerInput({ role, snapshot, outcome = null, target = null } = {}) {
  const input = {
    policy: {
      analyzerRole: clean(role),
      candidateBoundary: "used-memories-only",
      noFeedbackIsUnknown: true,
      positiveAffectIsNotMemoryReward: true,
      temporalOrderIsNotCausation: true,
      noContentConfidenceMutation: true,
    },
    observation: {
      id: clean(snapshot?.observation?.id),
      feedbackText: clean(snapshot?.observation?.feedback_text),
      observedAt: clean(snapshot?.observation?.observed_at),
      externalEvidence: snapshot?.observation?.metadata?.externalEvidence || null,
    },
    priorTurn: {
      query: clean(snapshot?.trace?.query_text),
      recallIntent: clean(snapshot?.trace?.recall_intent),
      assistantResponse: clean(snapshot?.request?.response_text),
    },
    usedMemories: (Array.isArray(snapshot?.memories) ? snapshot.memories : []).map((memory) => ({
      id: clean(memory?.id),
      kind: clean(memory?.kind),
      title: clean(memory?.title),
      content: clean(memory?.content),
      subjectRole: clean(memory?.subject_role),
      subjectKey: clean(memory?.subject_key),
      eventDate: clean(memory?.event_date),
    })),
  };
  if (outcome) input.outcomeAnalysis = outcome;
  if (target) input.targetAnalysis = target;
  return `${JSON.stringify(input)}\n`;
}
