import {
  DIRECT_INGESTION_MEMORY_KINDS,
  DEFAULT_MEMORY_TIME_ZONE,
  EVIDENCE_MODES,
  MEMORY_ACTOR_ROLES,
  MEMORY_STATE_FAMILIES,
  MEMORY_STATE_FAMILY_DEFINITIONS,
  REALITY_STATES,
  REVISION_ACTIONS,
  SUBJECT_ROLES,
  TEMPORAL_STATES,
  isMemoryKindAllowedForStateFamily,
  isStatefulMemoryKind,
  timestampInTimeZone,
} from "@suzu-memory/core";
import { buildExtractionParticipants } from './participant-identity.mjs';

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
const personRole = { type: "string", enum: ["user", "agent", "other"] };
const personName = { type: "string", minLength: 1 };
const GENERATED_TARGET_PROPERTIES = Object.freeze({
  identity: {
    identityField: { type: "string", enum: GENERATED_IDENTITY_FIELDS },
    fieldCardinality: { type: "string", enum: ["single", "multi_item", "sequence"] },
  },
  belief: {
    objectRole: { type: "string", enum: ["user", "agent", "other", "world"] },
    objectName: personName,
  },
  relationship: { counterpartRole: personRole, counterpartName: personName },
  affective_association: { triggerRole: personRole, triggerName: personName },
});
const TARGET_SPEC_FAMILIES = new Set(Object.keys(GENERATED_TARGET_PROPERTIES));
const targetAlternatives = [
  ...Object.entries(GENERATED_TARGET_PROPERTIES).map(([family, properties]) => ({
    type: "object",
    properties: {
      stateFamily: { type: "string", enum: [family] },
      stateTarget: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) },
    },
    required: ["stateTarget"],
  })),
  { type: "object", properties: {
    stateFamily: { type: "string", enum: ["not_applicable", ...MEMORY_STATE_FAMILIES.filter(family => !TARGET_SPEC_FAMILIES.has(family))] },
    stateTarget: false,
  } },
];

function normalizedGeneratedStateTarget(candidate, index) {
  const properties = GENERATED_TARGET_PROPERTIES[candidate.stateFamily];
  if (!properties) {
    if (Object.hasOwn(candidate, "stateTarget")) throw new Error(`memories[${index}].stateTarget 不适用于 ${candidate.stateFamily}，应省略。`);
    return undefined;
  }
  const value = candidate.stateTarget;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`memories[${index}].stateTarget 必须是 ${candidate.stateFamily} 的目标对象。`);
  }
  const expected = Object.keys(properties);
  const missing = expected.filter(key => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter(key => !Object.hasOwn(properties, key));
  if (missing.length || unexpected.length) throw new Error(
    `memories[${index}].stateTarget (${candidate.stateFamily}) 字段不符合约定；缺少：${missing.join(", ") || "无"}；不适用：${unexpected.join(", ") || "无"}。`,
  );
  return Object.fromEntries(expected.map(key => {
    const field = properties[key];
    const text = clean(value[key]);
    if (typeof value[key] !== "string" || (field.enum ? !field.enum.includes(text) : !text)) {
      throw new Error(`memories[${index}].stateTarget.${key} 无效。`);
    }
    return [key, text];
  }));
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
  const languages = new Set((window?.messages || []).map(message =>
    normalizeExtractionLanguage(message.sourceLanguage) || detectExtractionLanguage(message.text))
    .filter(language => language !== 'unknown'));
  return languages.size > 1 || languages.has('mixed') ? 'mixed' : [...languages][0] || 'unknown';
}

function roleLabel(role, language) {
  if (language === "en") return role === "assistant" ? "Agent" : "User";
  if (language === "mixed") return role === "assistant" ? "agent" : "user";
  return role === "assistant" ? "我" : "对方";
}

function languageInstruction(language) {
  if (language === "en") {
    return ["【本窗口输出语言：English】"];
  }
  if (language === "mixed") {
    return ["【本窗口输出语言：逐候选跟随直接证据；混合输入不要求混合输出】"];
  }
  if (language === "unknown") {
    return ["【本窗口输出语言：保持原文】"];
  }
  return ["【本窗口输出语言：中文】"];
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
  participants = [],
  timeZone = DEFAULT_MEMORY_TIME_ZONE,
} = {}) {
  return messages.slice(0, limit).map((message) => {
    const source = message.eventSource;
    const matches = source ? participants.filter(participant => participant.actorKey === source.sender.id) : [];
    const participant = matches.length === 1 ? matches[0]
      : matches.find(candidate => candidate.actorRole === message.speakerIdentity?.actorRole);
    const context = source ? { spaceId: source.spaceId, spaceKind: source.topology?.spaceKind || source.topology?.kind } : null;
    return `${includeRefs ? `[${message.memoryRef}] ` : ""}[${timestampInTimeZone(message.timestamp, timeZone) || message.timestamp || ""}] ${
      message.worldFrame ? `[world=${message.worldFrame}:${message.worldId || "primary"}] ` : ""
    }${language === "mixed" && message.sourceLanguage && message.sourceLanguage !== "unknown"
      ? `[source-language=${message.sourceLanguage}] ` : ""
    }${message.logicalEvent?.complete && Number(message.logicalEvent.fragmentCount) > 1
      ? `[同一原始事件已完整重组，共${message.logicalEvent.fragmentCount}段] `
      : ""
    }${context ? `[来源 ${JSON.stringify(context)}] ${participant?.name || source.sender.name || source.sender.kind}` : roleLabel(message.role, language)}${
      source && message.knownAt && message.knownAt !== message.occurredAt ? ` [获知时间=${timestampInTimeZone(message.knownAt, timeZone) || message.knownAt}]` : ''
    }：${message.text}`;
  }).join("\n\n");
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
            description: "使用输入人物表中的角色：agent 为记忆拥有者，user 为实际出现的已知人类用户，other 为其他 Agent 或人物；shared 为多个实际主体的共同事件，unknown 为无法确定。",
          },
          subjectName: { type: "string", description: "已知人物使用人物表中的完整 name；未知人物只用直接证据支持的名称。" },
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
            description: `分析家族含义：${JSON.stringify(Object.fromEntries(
              MEMORY_STATE_FAMILIES.map(family => [family, MEMORY_STATE_FAMILY_DEFINITIONS[family].description]),
            ))}。按 kind 选择兼容的分析家族：${JSON.stringify(Object.fromEntries(
              DIRECT_INGESTION_MEMORY_KINDS.map(kind => [kind, isStatefulMemoryKind(kind)
                ? MEMORY_STATE_FAMILIES.filter(family => isMemoryKindAllowedForStateFamily(kind, family))
                : ['not_applicable']]),
            ))}。`,
          },
          stateLabel: {
            type: "string",
            description: "人物状态的可读目标标签；事件和反思使用空字符串。",
          },
          stateTarget: {
            type: "object",
            description: "按 stateFamily 选择对应的目标分支：identity 为身份字段，belief 为观念对象，relationship 为关系对象，affective_association 为触发对象；其他分类省略 stateTarget。",
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
        anyOf: targetAlternatives,
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
  identity = {},
  timeZone = DEFAULT_MEMORY_TIME_ZONE,
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
  const allMessages = standardizedWindows.flatMap(window => [...window.previousContextMessages, ...window.messages, ...window.continuationGuidanceMessages]);
  const participants = buildExtractionParticipants(allMessages, { companionName: memoryOwner, primaryUserName: userName, ...identity });
  const owner = participants.find(participant => participant.actorRole === 'agent');
  const parts = [
    `记忆拥有者：${owner?.name || memoryOwner}`,
    `时间基准时区：${timeZone}。消息时间按该时区显示并带 UTC 偏移；相对日期以对应消息的当地日期为准。`,
    '记忆以拥有者的经历为中心；标题和正文叙述使用人物完整姓名，包括拥有者。原消息与引语中的人称按实际说话者解释。',
    '【程序提供的人物身份】',
    JSON.stringify(participants.map(({ actorRole, name }) => ({ role: actorRole, name }))),
  ];
  for (const window of standardizedWindows) {
    const previousContext = formatMessages(window.previousContextMessages, {
      timeZone,
      language: window.sourceLanguage,
      participants,
    });
    const conversation = formatMessages(window.messages, {
      timeZone,
      includeRefs: true,
      language: window.sourceLanguage,
      participants,
    });
    const continuationGuidance = formatMessages(window.continuationGuidanceMessages, {
      timeZone,
      language: window.sourceLanguage,
      participants,
    });
    if (standardizedWindows.length > 1 || window.id) {
      parts.push("", `【语义归档窗口 ${window.label}】`);
    }
    parts.push("", ...languageInstruction(window.sourceLanguage));
    if (previousContext) {
      parts.push(
        "",
        "【只读的前文衔接】",
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
    participants,
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

// A null target carries no information for targetless families. Keep real
// target objects and all other fields intact for the normal strict checks.
export function normalizeGeneratedLongTermExtraction(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.memories)) return value;
  return { ...value, memories: value.memories.map(candidate => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)
      || candidate.stateTarget !== null || TARGET_SPEC_FAMILIES.has(candidate.stateFamily)) return candidate;
    const normalized = { ...candidate };
    delete normalized.stateTarget;
    return normalized;
  }) };
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
  parsed = normalizeGeneratedLongTermExtraction(parsed);
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
    "subjectName",
    "subjectRole",
    "temporalState",
    "title",
  ];
  const memories = parsed.memories.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`memories[${index}] 必须是对象。`);
    }
    const expectedCandidateKeys = [...expectedKeys,
      ...(TARGET_SPEC_FAMILIES.has(candidate.stateFamily) ? ["stateTarget"] : []),
    ].sort();
    const candidateKeys = Object.keys(candidate).sort();
    if (
      candidateKeys.length !== expectedCandidateKeys.length
      || candidateKeys.some((key, keyIndex) => key !== expectedCandidateKeys[keyIndex])
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
      ...(stateTarget ? { stateTarget } : {}),
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
