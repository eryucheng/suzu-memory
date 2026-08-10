import {
  DIRECT_INGESTION_MEMORY_KINDS,
  EVIDENCE_MODES,
  MEMORY_ACTOR_ROLES,
  MEMORY_STATE_FAMILIES,
  REALITY_STATES,
  REVISION_ACTIONS,
  SUBJECT_ROLES,
  TEMPORAL_STATES,
  isMemoryKindAllowedForStateFamily,
  isStatefulMemoryKind,
} from "@suzu-memory/core";

export const RETENTION_REASONS = Object.freeze([
  "identity",
  "episodic_event",
  "significant_event",
  "state_change",
  "relationship",
  "commitment",
  "open_loop",
  "explicit_belief",
  "explicit_preference",
  "agent_reflection",
]);

const RETENTION_KINDS = Object.freeze({
  identity: Object.freeze(["fact"]),
  episodic_event: Object.freeze(["event"]),
  significant_event: Object.freeze(["event"]),
  state_change: Object.freeze(["fact", "belief_state", "preference", "relationship"]),
  relationship: Object.freeze(["relationship"]),
  commitment: Object.freeze(["commitment"]),
  open_loop: Object.freeze(["plan", "open_loop"]),
  explicit_belief: Object.freeze(["belief_state"]),
  explicit_preference: Object.freeze(["preference"]),
  agent_reflection: Object.freeze(["reflection"]),
});

export function isRetentionReasonCompatible(kind, retentionReason) {
  return Boolean(RETENTION_KINDS[retentionReason]?.includes(kind));
}

const GENERATED_ACTOR_ROLES = MEMORY_ACTOR_ROLES.filter((role) => ![
  "subject",
  "speaker",
].includes(role));

const GENERATED_ACTOR_IDENTITIES = SUBJECT_ROLES.filter((role) => [
  "user",
  "agent",
  "other",
].includes(role));

const GENERATED_EVIDENCE_MODES = EVIDENCE_MODES.filter((mode) => [
  "explicit",
  "observed",
  "inferred",
].includes(mode));

const GENERATED_IDENTITY_FIELDS = Object.freeze([
  "name", "alias", "birth_date", "birth_year", "age", "gender", "pronouns",
  "occupation", "employer", "education", "residence", "hometown", "nationality",
  "biography", "other",
]);
const GENERATED_TARGET_ROLES = Object.freeze(["not_applicable", "user", "agent", "other", "world"]);
const TARGET_SPEC_FAMILIES = new Set([
  "identity", "belief", "relationship", "affective_association",
]);

function normalizedGeneratedStateTarget(candidate, index) {
  const value = candidate?.stateTarget;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`memories[${index}].stateTarget 必须是对象。`);
  }
  const expected = [
    "counterpartName", "counterpartRole", "direction", "fieldCardinality",
    "identityField", "objectName", "objectRole", "triggerName", "triggerRole", "type",
  ];
  const keys = Object.keys(value).sort();
  if (keys.length !== expected.length || keys.some((key, keyIndex) => key !== expected[keyIndex])) {
    throw new Error(`memories[${index}].stateTarget 字段不符合约定。`);
  }
  const normalized = {
    type: clean(value.type),
    identityField: clean(value.identityField),
    fieldCardinality: clean(value.fieldCardinality),
    objectRole: clean(value.objectRole),
    objectName: clean(value.objectName),
    counterpartRole: clean(value.counterpartRole),
    counterpartName: clean(value.counterpartName),
    direction: clean(value.direction),
    triggerRole: clean(value.triggerRole),
    triggerName: clean(value.triggerName),
  };
  const empty = {
    identityField: "not_applicable",
    fieldCardinality: "not_applicable",
    objectRole: "not_applicable",
    objectName: "",
    counterpartRole: "not_applicable",
    counterpartName: "",
    direction: "not_applicable",
    triggerRole: "not_applicable",
    triggerName: "",
  };
  const hasEmptyOtherFields = (except) => Object.entries(empty).every(([key, expectedValue]) => (
    except.has(key) || normalized[key] === expectedValue
  ));
  if (!TARGET_SPEC_FAMILIES.has(candidate.stateFamily)) {
    if (normalized.type !== "none" || !hasEmptyOtherFields(new Set())) {
      throw new Error(`memories[${index}].stateTarget 不适用于 ${candidate.stateFamily}。`);
    }
    return normalized;
  }
  if (normalized.type !== candidate.stateFamily) {
    throw new Error(`memories[${index}].stateTarget.type 与 stateFamily 不一致。`);
  }
  if (candidate.stateFamily === "identity") {
    if (!GENERATED_IDENTITY_FIELDS.includes(normalized.identityField)
      || !["single", "multi_item", "sequence"].includes(normalized.fieldCardinality)
      || !hasEmptyOtherFields(new Set(["identityField", "fieldCardinality"]))) {
      throw new Error(`memories[${index}].stateTarget 身份目标不完整。`);
    }
  } else if (candidate.stateFamily === "belief") {
    if (!["user", "agent", "other", "world"].includes(normalized.objectRole)
      || !normalized.objectName
      || !hasEmptyOtherFields(new Set(["objectRole", "objectName"]))) {
      throw new Error(
        `memories[${index}].stateTarget 观念对象不完整，实际为 ${JSON.stringify(normalized).slice(0, 500)}。`,
      );
    }
  } else if (candidate.stateFamily === "relationship") {
    if (!["user", "agent", "other"].includes(normalized.counterpartRole)
      || !normalized.counterpartName
      || normalized.direction !== "holder_to_counterpart"
      || !hasEmptyOtherFields(new Set(["counterpartRole", "counterpartName", "direction"]))) {
      throw new Error(`memories[${index}].stateTarget 关系对象不完整。`);
    }
  } else if (candidate.stateFamily === "affective_association") {
    if (!["user", "agent", "other"].includes(normalized.triggerRole)
      || !normalized.triggerName
      || !hasEmptyOtherFields(new Set(["triggerRole", "triggerName"]))) {
      throw new Error(`memories[${index}].stateTarget 情绪触发对象不完整。`);
    }
  }
  return normalized;
}

function clean(value) {
  return String(value ?? "").trim();
}

const EXTRACTION_LANGUAGES = new Set(["zh", "en", "mixed", "unknown"]);

function normalizeExtractionLanguage(value) {
  const normalized = clean(value).toLowerCase();
  if (["zh", "zh-cn", "chinese", "中文", "汉语"].includes(normalized)) return "zh";
  if (["en", "en-us", "en-gb", "english", "英语"].includes(normalized)) return "en";
  if (["mixed", "bilingual", "双语", "中英混合"].includes(normalized)) return "mixed";
  return "";
}

/**
 * Detects only the language policy relevant to this product's current
 * Chinese/English contract. It deliberately ignores punctuation, digits, and
 * names, so a Chinese sentence mentioning "AI" remains Chinese rather than
 * being unnecessarily treated as mixed.
 */
export function detectExtractionLanguage(value) {
  const text = String(value || "");
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const latin = (text.match(/[A-Za-z]/gu) || []).length;
  if (!han && !latin) return "unknown";
  if (!han) return "en";
  if (!latin) return "zh";
  const smallerShare = Math.min(han, latin) / (han + latin);
  // Keep short embedded terms such as "AI" inside a Chinese window, while
  // recognising genuinely bilingual sentences as mixed rather than forcing
  // them into either output language.
  return smallerShare >= 0.25 ? "mixed" : han > latin ? "zh" : "en";
}

function archiveWindowLanguage(window) {
  const declared = normalizeExtractionLanguage(
    window?.sourceLanguage || window?.outputLanguage || window?.language,
  );
  if (declared) return declared;
  return detectExtractionLanguage((window?.messages || [])
    .map((message) => String(message?.text || ""))
    .join("\n"));
}

function roleLabel(role, language) {
  if (language === "en") return role === "assistant" ? "Agent" : "User";
  if (language === "mixed") return role === "assistant" ? "agent" : "user";
  return role === "assistant" ? "我" : "对方";
}

function languageInstruction(language) {
  if (language === "en") {
    return [
      "【本窗口结构化输出语言 / Output language: English】",
      "Every candidate whose sourceRefs only cite this window's M references must be written in English for its title, content, and stateLabel. Do not translate English evidence into Chinese.",
    ];
  }
  if (language === "mixed") {
    return [
      "【本窗口结构化输出语言 / Output language: source-led mixed】",
      "本窗口含中英文直接证据。每条候选应使用其 sourceRefs 所支持事实的主要语言：中文证据写中文，英文证据写英文；只有同一事实的直接证据本身确实混用两种语言时才可混用。不要为了统一风格翻译整段证据。",
    ];
  }
  if (language === "unknown") {
    return [
      "【本窗口结构化输出语言】",
      "无法可靠判断窗口语言时，保持直接证据的原始语言；不要自行翻译。",
    ];
  }
  return [
    "【本窗口结构化输出语言】",
    "所有只引用本窗口 M 编号的候选，其 title、content 和 stateLabel 必须用中文撰写。不要把中文证据翻译成英文。",
  ];
}

export function assignMemoryRefs(messages = [], start = 1) {
  return messages.map((message, index) => ({
    ...message,
    memoryRef: `M${String(start + index).padStart(4, "0")}`,
  }));
}

function formatMessages(messages, {
  includeRefs = false,
  limit = Number.POSITIVE_INFINITY,
  language = "unknown",
} = {}) {
  return messages.slice(0, limit).map((message) => (
    `${includeRefs ? `[${message.memoryRef}] ` : ""}[${message.timestamp || ""}] ${
      message.worldFrame ? `[world=${message.worldFrame}:${message.worldId || "primary"}] ` : ""
    }${language === "mixed" && message.sourceLanguage && message.sourceLanguage !== "unknown"
      ? `[source-language=${message.sourceLanguage}] ` : ""
    }${message.logicalEvent?.complete && Number(message.logicalEvent.fragmentCount) > 1
      ? `[同一原始事件已完整重组，共${message.logicalEvent.fragmentCount}段] `
      : ""
    }${roleLabel(message.role, language)}：${message.text}`
  )).join("\n\n");
}

export const LONG_TERM_EXTRACTION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    memories: {
      type: "array",
      description: "本批真实对话中值得长期检索的结构化记忆；没有时返回空数组。",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: {
            type: "string",
            enum: DIRECT_INGESTION_MEMORY_KINDS,
          },
          title: { type: "string" },
          content: { type: "string" },
          subjectRole: {
            type: "string",
            enum: SUBJECT_ROLES,
            description: "必须遵守输入中的已知身份映射：记忆拥有者为 agent，对方为 user；第三方为 other。无法从直接证据确定主体时使用 unknown，不得猜测。",
          },
          subjectName: { type: "string" },
          actorRoles: {
            type: "array",
            description: "只填写直接证据明确支持的人物角色；不确定时留空数组。",
            maxItems: 8,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                role: { type: "string", enum: GENERATED_ACTOR_ROLES },
                actorRole: { type: "string", enum: GENERATED_ACTOR_IDENTITIES },
                actorName: { type: "string" },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["role", "actorRole", "actorName", "confidence"],
            },
          },
          canonicalKey: {
            type: "string",
            description: "同一可变事实使用同一个简短稳定键；事件和反思可为空字符串。",
          },
          stateFamily: {
            type: "string",
            enum: ["not_applicable", ...MEMORY_STATE_FAMILIES],
            description: "人物状态候选必须指定要进入的专职分析家族；事件和反思使用 not_applicable。",
          },
          stateLabel: {
            type: "string",
            description: "人物状态的可读目标标签；事件和反思使用空字符串。",
          },
          stateTarget: {
            type: "object",
            additionalProperties: false,
            description: "仅 identity、belief、relationship、affective_association 填写对应目标，其余字段使用 not_applicable 或空字符串。",
            properties: {
              type: {
                type: "string",
                enum: ["none", "identity", "belief", "relationship", "affective_association"],
              },
              identityField: { type: "string", enum: ["not_applicable", ...GENERATED_IDENTITY_FIELDS] },
              fieldCardinality: { type: "string", enum: ["not_applicable", "single", "multi_item", "sequence"] },
              objectRole: { type: "string", enum: GENERATED_TARGET_ROLES },
              objectName: { type: "string" },
              counterpartRole: { type: "string", enum: GENERATED_TARGET_ROLES },
              counterpartName: { type: "string" },
              direction: { type: "string", enum: ["not_applicable", "holder_to_counterpart"] },
              triggerRole: { type: "string", enum: GENERATED_TARGET_ROLES },
              triggerName: { type: "string" },
            },
            required: [
              "type", "identityField", "fieldCardinality", "objectRole", "objectName",
              "counterpartRole", "counterpartName", "direction", "triggerRole", "triggerName",
            ],
          },
          reality: { type: "string", enum: REALITY_STATES },
          evidenceMode: {
            type: "string",
            enum: GENERATED_EVIDENCE_MODES,
            description: "explicit=候选主体在引用原话中明确表达；observed=引用内容直接记录可观察事实但不是主体自述；inferred=超出原话表述的可撤销推断。不得输出 manual 或 imported。",
          },
          temporalState: { type: "string", enum: TEMPORAL_STATES },
          revisionAction: { type: "string", enum: REVISION_ACTIONS },
          retentionReason: { type: "string", enum: RETENTION_REASONS },
          eventDate: {
            type: "string",
            description: "有效 YYYY-MM-DD；无法可靠确定时为空字符串。",
          },
          eventStart: {
            type: "string",
            description: "有直接证据的 ISO 8601 发生时间；只能确定日期或无法确定时为空字符串。",
          },
          eventEnd: {
            type: "string",
            description: "有直接证据的 ISO 8601 结束时间；未结束或无法确定时为空字符串。",
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          importance: { type: "number", minimum: 0, maximum: 1 },
          sourceRefs: {
            type: "array",
            minItems: 1,
            items: { type: "string", pattern: "^M[0-9]{4}$" },
          },
        },
        required: [
          "kind",
          "title",
          "content",
          "subjectRole",
          "subjectName",
          "actorRoles",
          "canonicalKey",
          "stateFamily",
          "stateLabel",
          "stateTarget",
          "reality",
          "evidenceMode",
          "temporalState",
          "revisionAction",
          "retentionReason",
          "eventDate",
          "eventStart",
          "eventEnd",
          "confidence",
          "importance",
          "sourceRefs",
        ],
      },
    },
  },
  required: ["memories"],
});

export function buildLongTermExtractionInput({
  messages = [],
  previousContextMessages = [],
  continuationGuidanceMessages = [],
  archiveWindows = [],
  memoryOwner = "记忆拥有者",
  userName = "对方",
}) {
  const sourceWindows = Array.isArray(archiveWindows) && archiveWindows.length
    ? archiveWindows
    : [{
      id: "",
      messages,
      previousContextMessages,
      continuationGuidanceMessages,
    }];
  let nextRef = 1;
  const observedWindowIds = new Set();
  const standardizedWindows = sourceWindows.map((window, index) => {
    const archiveWindowId = clean(window.id)
      || (sourceWindows.length > 1 ? `archive-window-${index + 1}` : "");
    if (observedWindowIds.has(archiveWindowId)) {
      throw new Error(`Duplicate archive window id: ${archiveWindowId || "(empty)"}.`);
    }
    observedWindowIds.add(archiveWindowId);
    const archiveContinuityId = clean(window.continuityId) || archiveWindowId;
    const sourceLanguage = archiveWindowLanguage(window);
    const standardized = assignMemoryRefs(window.messages || [], nextRef).map((message) => ({
      ...message,
      sourceLanguage: normalizeExtractionLanguage(message.sourceLanguage)
        || detectExtractionLanguage(message.text),
      archiveWindowId,
      archiveContinuityId,
      archiveWindowLabel: `W${String(index + 1).padStart(4, "0")}`,
    }));
    nextRef += standardized.length;
    return {
      id: archiveWindowId,
      continuityId: archiveContinuityId,
      label: `W${String(index + 1).padStart(4, "0")}`,
      sourceLanguage,
      messages: standardized,
      previousContextMessages: [...(window.previousContextMessages || [])],
      continuationGuidanceMessages: [...(window.continuationGuidanceMessages || [])],
    };
  });
  const standardized = standardizedWindows.flatMap((window) => window.messages);
  const parts = [
    `记忆拥有者：${memoryOwner}`,
    `对方名字：${userName}`,
    `已知身份映射：${memoryOwner}=agent，${userName}=user；该映射同样适用于 subjectRole、actorRoles 和 stateTarget 中具名人物的角色字段。`,
  ];
  for (const window of standardizedWindows) {
    const previousContext = formatMessages(window.previousContextMessages, {
      language: window.sourceLanguage,
    });
    const conversation = formatMessages(window.messages, {
      includeRefs: true,
      language: window.sourceLanguage,
    });
    const continuationGuidance = formatMessages(window.continuationGuidanceMessages, {
      language: window.sourceLanguage,
    });
    if (standardizedWindows.length > 1 || window.id) {
      parts.push("", `【语义归档窗口 ${window.label}】`);
    }
    parts.push("", ...languageInstruction(window.sourceLanguage));
    if (previousContext) {
      parts.push(
        "",
        "【只读的前文衔接】",
        "以下内容已经归档，只用于理解指代、承接和事件边界；它们没有 M 编号，不能再次成为候选或证据。",
        "",
        previousContext,
      );
    }
    if (conversation) {
      parts.push("", "【待提取的标准事件】", "", conversation);
    }
    if (continuationGuidance) {
      parts.push(
        "",
        "【只读的后文衔接】",
        "以下内容尚不属于本次归档，只用于判断事情是否仍在继续；它们没有 M 编号，不能提前写成事实或证据。",
        "",
        continuationGuidance,
      );
    }
  }
  return {
    input: `${parts.join("\n").trim()}\n`,
    messages: standardized,
    archiveWindows: standardizedWindows,
    previousContextMessages: standardizedWindows.flatMap(
      (window) => window.previousContextMessages,
    ),
    continuationGuidanceMessages: standardizedWindows.flatMap(
      (window) => window.continuationGuidanceMessages,
    ),
  };
}

function stripCodeFence(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return clean(fenced?.[1] || text);
}

export function sanitizeNarrativePunctuation(value) {
  return String(value || "")
    .replace(/\s*[—–]+\s*/gu, "，")
    .replace(/，{2,}/gu, "，")
    .replace(/([。！？])，/gu, "$1")
    .replace(/，([。！？])/gu, "$1");
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function parseGeneratedLongTermExtraction(value) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(stripCodeFence(value));
    } catch (error) {
      throw new Error(`长期记忆提取模型输出不是有效 JSON：${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("长期记忆提取模型输出必须是 JSON 对象。");
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 1 || keys[0] !== "memories") {
    throw new Error("长期记忆提取模型输出只能包含 memories。");
  }
  if (!Array.isArray(parsed.memories)) throw new Error("memories 必须是数组。");
  const allowedKinds = new Set(LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.properties.kind.enum);
  const allowedRoles = new Set(LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.properties.subjectRole.enum);
  const allowedReality = new Set(LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.properties.reality.enum);
  const allowedEvidence = new Set(LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.properties.evidenceMode.enum);
  const allowedTemporal = new Set(LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.properties.temporalState.enum);
  const allowedRevision = new Set(REVISION_ACTIONS);
  const allowedRetentionReasons = new Set(RETENTION_REASONS);
  const allowedStateFamilies = new Set(["not_applicable", ...MEMORY_STATE_FAMILIES]);
  const allowedActorRoles = new Set(GENERATED_ACTOR_ROLES);
  const allowedActorIdentities = new Set(GENERATED_ACTOR_IDENTITIES);
  const expectedKeys = [
    "actorRoles",
    "canonicalKey",
    "confidence",
    "content",
    "eventDate",
    "eventEnd",
    "eventStart",
    "evidenceMode",
    "importance",
    "kind",
    "reality",
    "retentionReason",
    "revisionAction",
    "sourceRefs",
    "stateFamily",
    "stateLabel",
    "stateTarget",
    "subjectName",
    "subjectRole",
    "temporalState",
    "title",
  ];
  const memories = parsed.memories.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`memories[${index}] 必须是对象。`);
    }
    const candidateKeys = Object.keys(candidate).sort();
    if (
      candidateKeys.length !== expectedKeys.length
      || candidateKeys.some((key, keyIndex) => key !== expectedKeys[keyIndex])
    ) throw new Error(`memories[${index}] 字段不符合约定。`);
    for (const field of ["kind", "content", "subjectRole", "reality", "evidenceMode", "temporalState", "revisionAction"]) {
      if (!clean(candidate[field])) throw new Error(`memories[${index}].${field} 不能为空。`);
    }
    if (!allowedKinds.has(candidate.kind)) throw new Error(`memories[${index}].kind 无效。`);
    if (!allowedRoles.has(candidate.subjectRole)) throw new Error(`memories[${index}].subjectRole 无效。`);
    if (!allowedReality.has(candidate.reality)) throw new Error(`memories[${index}].reality 无效。`);
    if (!allowedEvidence.has(candidate.evidenceMode)) throw new Error(`memories[${index}].evidenceMode 无效。`);
    if (!allowedTemporal.has(candidate.temporalState)) throw new Error(`memories[${index}].temporalState 无效。`);
    if (!allowedRevision.has(candidate.revisionAction)) throw new Error(`memories[${index}].revisionAction 无效。`);
    if (!allowedRetentionReasons.has(candidate.retentionReason)) {
      throw new Error(`memories[${index}].retentionReason 无效。`);
    }
    if (!allowedStateFamilies.has(candidate.stateFamily)) {
      throw new Error(`memories[${index}].stateFamily 无效。`);
    }
    const stateful = isStatefulMemoryKind(candidate.kind);
    const stateLabel = sanitizeNarrativePunctuation(candidate.stateLabel).trim();
    const stateTarget = normalizedGeneratedStateTarget(candidate, index);
    if (stateful) {
      if (!clean(candidate.canonicalKey)) {
        throw new Error(`memories[${index}].canonicalKey 不能为空。`);
      }
      if (!MEMORY_STATE_FAMILIES.includes(candidate.stateFamily)
        || !isMemoryKindAllowedForStateFamily(candidate.kind, candidate.stateFamily)) {
        throw new Error(`memories[${index}] 的 kind 与 stateFamily 不兼容。`);
      }
      if (!stateLabel) throw new Error(`memories[${index}].stateLabel 不能为空。`);
    } else if (candidate.stateFamily !== "not_applicable" || stateLabel) {
      throw new Error(`memories[${index}] 的非状态候选不能携带状态分析目标。`);
    }
    const eventDate = clean(candidate.eventDate);
    if (eventDate && !validCalendarDate(eventDate)) {
      throw new Error(
        `memories[${index}].eventDate 必须为空或有效的 YYYY-MM-DD，实际为 ${JSON.stringify(eventDate.slice(0, 80))}。`,
      );
    }
    const normalizeEventTimestamp = (field) => {
      const text = clean(candidate[field]);
      if (!text) return "";
      const date = new Date(text);
      if (!Number.isFinite(date.getTime())) {
        throw new Error(`memories[${index}].${field} 必须为空或有效 ISO 8601 时间。`);
      }
      return date.toISOString();
    };
    const eventStart = normalizeEventTimestamp("eventStart");
    const eventEnd = normalizeEventTimestamp("eventEnd");
    if (eventStart && eventEnd && eventEnd < eventStart) {
      throw new Error(`memories[${index}].eventEnd 不能早于 eventStart。`);
    }
    if (!Array.isArray(candidate.actorRoles) || candidate.actorRoles.length > 8) {
      throw new Error(`memories[${index}].actorRoles 必须是最多 8 项的数组。`);
    }
    const actorRoles = candidate.actorRoles.map((actor, actorIndex) => {
      if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
        throw new Error(`memories[${index}].actorRoles[${actorIndex}] 必须是对象。`);
      }
      const actorKeys = Object.keys(actor).sort();
      const expectedActorKeys = ["actorName", "actorRole", "confidence", "role"];
      if (
        actorKeys.length !== expectedActorKeys.length
        || actorKeys.some((key, keyIndex) => key !== expectedActorKeys[keyIndex])
      ) throw new Error(`memories[${index}].actorRoles[${actorIndex}] 字段不符合约定。`);
      if (!allowedActorRoles.has(actor.role)) {
        throw new Error(`memories[${index}].actorRoles[${actorIndex}].role 无效。`);
      }
      if (!allowedActorIdentities.has(actor.actorRole)) {
        throw new Error(`memories[${index}].actorRoles[${actorIndex}].actorRole 无效。`);
      }
      const actorName = clean(actor.actorName);
      if (actor.actorRole === "other" && !actorName) {
        throw new Error(`memories[${index}].actorRoles[${actorIndex}].actorName 不能为空。`);
      }
      const confidence = Number(actor.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error(`memories[${index}].actorRoles[${actorIndex}].confidence 必须在 0 到 1 之间。`);
      }
      return {
        role: actor.role,
        actorRole: actor.actorRole,
        actorName,
        confidence,
      };
    });
    if (
      !Array.isArray(candidate.sourceRefs)
      || !candidate.sourceRefs.length
      || candidate.sourceRefs.some((ref) => !/^M\d{4}$/u.test(String(ref)))
    ) throw new Error(`memories[${index}].sourceRefs 无效。`);
    for (const field of ["confidence", "importance"]) {
      const number = Number(candidate[field]);
      if (!Number.isFinite(number) || number < 0 || number > 1) {
        throw new Error(`memories[${index}].${field} 必须在 0 到 1 之间。`);
      }
    }
    return {
      ...candidate,
      title: sanitizeNarrativePunctuation(candidate.title).trim(),
      content: sanitizeNarrativePunctuation(candidate.content).trim(),
      subjectName: clean(candidate.subjectName),
      canonicalKey: clean(candidate.canonicalKey),
      stateFamily: candidate.stateFamily,
      stateLabel,
      stateTarget,
      actorRoles,
      eventDate,
      eventStart,
      eventEnd,
      sourceRefs: [...new Set(candidate.sourceRefs.map(String))],
      confidence: Number(candidate.confidence),
      importance: Number(candidate.importance),
    };
  });
  return {
    memories,
  };
}
