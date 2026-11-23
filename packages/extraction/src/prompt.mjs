import { createHash } from 'node:crypto';
import {
  ENTITY_KINDS,
  DIRECT_INGESTION_MEMORY_KINDS,
  STATE_IDENTITY_FIELDS,
  RELATIONSHIP_DIMENSIONS,
  DEFAULT_MEMORY_TIME_ZONE,
  EVIDENCE_MODES,
  MEMORY_ACTOR_ROLES,
  MEMORY_KIND_DEFINITIONS,
  MEMORY_STATE_FAMILIES,
  MEMORY_STATE_FAMILY_DEFINITIONS,
  REALITY_STATES,
  REVISION_ACTIONS,
  TEMPORAL_STATES,
  entityNameKey,
  isMemoryKindAllowedForStateFamily,
  isStatefulMemoryKind,
  timestampInTimeZone,
} from "@suzu-memory/core";
import { buildExtractionParticipants, resolveExtractionActor, resolveExtractionSpeaker } from './participant-identity.mjs';
import { normalizeExtractionTime } from './temporal-evidence.mjs';
import { decodeExtractionModelOutput, formatExtractionEvidence, EXTRACTION_MODEL_EVIDENCE, EXTRACTION_MODEL_DATE } from './evidence-references.mjs';

const GENERATED_ACTOR_ROLES = MEMORY_ACTOR_ROLES.filter(role => !['subject', 'speaker'].includes(role));
const GENERATED_EVIDENCE_MODES = EVIDENCE_MODES.filter(mode => ['explicit', 'observed', 'inferred'].includes(mode));
const objectSchema = properties => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties) });
const text = { type: 'string', minLength: 1 };
const stateKey = { ...text, description: '按状态的维度、对象和适用范围命名的简短稳定键。' };
const stateLabel = { ...text, description: '概括这项人物信息的简短命题。' };
const memoryContentDescription = '沿用原话的事实表述，使用人物名称写简洁且可独立理解的正文';
const score = { type: 'number', minimum: 0, maximum: 1 };
const person = { type: 'object', anyOf: [
  objectSchema({ ref: { type: 'string', pattern: '^[PE][1-9][0-9]*$' } }),
  objectSchema({ name: text }),
] };
const objectTarget = { type: 'object', anyOf: [...person.anyOf, objectSchema({ world: text })] };
const subject = { type: 'object', anyOf: [...person.anyOf, objectSchema({
  scope: { type: 'string', enum: ['shared', 'world', 'unknown'] }, name: { type: 'string' },
})], description: '已知人物使用 P 引用，新声明人物使用 E 引用；共同经历、世界与无法确定的主体使用 scope。' };
const TARGET_PROPERTIES = {
  identity: {
    identityField: { type: 'string', enum: STATE_IDENTITY_FIELDS,
      description: '主体本人的身份维度；relationship_status 表示婚恋状态。' },
    fieldCardinality: { type: 'string', enum: ['single', 'multi_item', 'sequence'],
      description: 'single=同一时间和范围内单值，婚恋状态使用此值；multi_item=可同时成立多项；sequence=按时间排列的经历。' },
  },
  belief: { object: objectTarget },
  relationship: { counterpart: person, dimension: { type: 'string', enum: RELATIONSHIP_DIMENSIONS } },
  affective_association: { trigger: objectTarget },
};
// The core ontology owns legal kind/family combinations. The wire category
// selects one combination; storage identity remains with state matching.
const CATEGORIES = Object.fromEntries([
  ...DIRECT_INGESTION_MEMORY_KINDS.filter(kind => !isStatefulMemoryKind(kind))
    .map(kind => [kind, { kind, stateFamily: 'not_applicable' }]),
  ...MEMORY_STATE_FAMILIES.flatMap(stateFamily => DIRECT_INGESTION_MEMORY_KINDS
    .filter(kind => isMemoryKindAllowedForStateFamily(kind, stateFamily))
    .map(kind => [stateFamily === 'goal' ? kind : stateFamily, { kind, stateFamily }])),
]);
const categoryField = categories => ({ type: 'string', enum: categories,
  description: categories.map(category => `${category}=${category === 'event' ? '需后续沿用的决定、约定、方案或持续事项的新进展，以及原话明确讲述的独立经历或已发生的具体变化'
    : category === 'reflection' ? MEMORY_KIND_DEFINITIONS.reflection.description : category === 'plan' ? '未来打算'
      : category === 'commitment' ? '已答应的责任' : category === 'open_loop' ? '尚待跟进的事项'
        : category === 'habit' ? '原文明示频率或条件的重复行为规律'
          : category === 'disposition' ? '明确自述或跨情境的多次行为支持的稳定倾向'
        : MEMORY_STATE_FAMILY_DEFINITIONS[CATEGORIES[category].stateFamily].description}`).join('；') });
const classificationBranches = [
  objectSchema({ category: categoryField(['event']) }),
  objectSchema({ category: categoryField(['reflection']), key: { type: 'string', description: '同一反思的稳定键；新反思可留空。' } }),
  ...Object.entries(TARGET_PROPERTIES).map(([category, properties]) => objectSchema({
    category: categoryField([category]), key: stateKey, label: stateLabel, target: objectSchema(properties),
  })),
  objectSchema({ category: categoryField(Object.keys(CATEGORIES).filter(category =>
    isStatefulMemoryKind(CATEGORIES[category].kind) && !TARGET_PROPERTIES[category])), key: stateKey, label: stateLabel }),
];

function clean(value) {
  return String(value ?? "").trim();
}

export function normalizeExtractionLanguage(value) {
  const normalized = clean(value).toLowerCase();
  if (["zh", "zh-cn", "chinese", "中文", "汉语"].includes(normalized)) return "zh";
  if (["en", "en-us", "en-gb", "english", "英语"].includes(normalized)) return "en";
  if (["mixed", "bilingual", "双语", "中英混合"].includes(normalized)) return "mixed";
  if (normalized === 'unknown') return 'unknown';
  return "";
}

/** Set a default for a complete text using Han characters and English words. */
export function detectExtractionLanguage(value) {
  const text = String(value || "");
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const latin = (text.match(/[A-Za-z]+/gu) || []).length;
  if (!han && !latin) return "unknown";
  if (!han) return "en";
  if (!latin) return "zh";
  const smallerShare = Math.min(han, latin) / (han + latin);
  // Treat substantial text in both scripts as mixed.
  return smallerShare >= 0.25 ? "mixed" : han > latin ? "zh" : "en";
}

export function extractionContextLanguage(records, textOf = record => record.text, languageOf = record => record.outputLanguage) {
  const languages = new Set();
  const unlabelled = [];
  for (const record of records) {
    const language = normalizeExtractionLanguage(languageOf(record));
    if (language) {
      if (language !== 'unknown') languages.add(language);
    } else {
      unlabelled.push(textOf(record));
    }
  }
  if (unlabelled.length) {
    const language = detectExtractionLanguage(unlabelled.join('\n'));
    if (language !== 'unknown') languages.add(language);
  }
  return languages.size > 1 ? 'mixed' : [...languages][0] || 'unknown';
}

function archiveWindowLanguage(window, messages) {
  const declared = normalizeExtractionLanguage(
    window?.sourceLanguage || window?.outputLanguage || window?.language,
  );
  if (declared && declared !== 'unknown') return declared;
  return extractionContextLanguage(messages, message => message.text,
    message => normalizeExtractionLanguage(message.sourceLanguage) === 'unknown' ? '' : message.sourceLanguage);
}

function roleLabel(role, language) {
  if (language === "en") return role === "assistant" ? "Agent" : "User";
  if (language === "mixed") return role === "assistant" ? "agent" : "user";
  return role === "assistant" ? "我" : "对方";
}

const OUTPUT_LANGUAGE_NAMES = new Map([
  ['zh', '中文'],
  ['en', 'English'],
]);

export function extractionOutputLanguage(language) {
  const name = OUTPUT_LANGUAGE_NAMES.get(language);
  return name ? `沿用直接证据的语言，语种不清时用${name}` : '沿用直接证据的语言';
}

export function assignMemoryRefs(messages = [], start = 1) {
  return messages.map((message, index) => ({
    ...message,
    memoryRef: `M${String(start + index).padStart(4, "0")}`,
  }));
}

function formatMessages(messages, {
  includeRefs = false,
  language = "unknown",
  participants = [],
  timeZone = DEFAULT_MEMORY_TIME_ZONE,
  evidenceReferences,
} = {}) {
  const modelLines = [];
  const input = messages.map((message) => {
    const source = message.eventSource;
    const participant = resolveExtractionSpeaker(message, participants);
    const context = source ? { spaceId: source.spaceId, spaceKind: source.topology?.spaceKind || source.topology?.kind } : null;
    const header = `${includeRefs ? `[${message.memoryRef}] ` : ""}[${timestampInTimeZone(message.timestamp, timeZone) || message.timestamp || ""}] ${
      message.worldFrame ? `[world=${message.worldFrame}:${message.worldId || "primary"}] ` : ""
    }${language === "mixed" && message.sourceLanguage && message.sourceLanguage !== "unknown"
      ? `[source-language=${message.sourceLanguage}] ` : ""
    }${context ? `[来源 ${JSON.stringify(context)}] ` : ""}${participant ? `${participant.ref} ${participant.displayName}` : source?.sender.name || roleLabel(message.role, language)}${
      source && message.knownAt && message.knownAt !== message.occurredAt ? ` [获知时间=${timestampInTimeZone(message.knownAt, timeZone) || message.knownAt}]` : ''
    }：`;
    if (evidenceReferences) modelLines.push(header + formatExtractionEvidence(String(message.text), message.memoryRef, evidenceReferences));
    return header + message.text;
  }).join("\n\n");
  return { input, modelInput: modelLines.join("\n\n") };
}

export const EXTRACTION_ENTITY_SCHEMA = objectSchema({
  ref: { type: 'string', pattern: '^E[1-9][0-9]*$' }, kind: { type: 'string', enum: ENTITY_KINDS }, name: text,
  aliases: { type: 'array', items: text, description: '原文明确提供的其他名称。' },
});
const entityArray = { type: ['array', 'null'], items: EXTRACTION_ENTITY_SCHEMA,
  description: '本批可持续指代的人物、地点、组织、物品等；同一对象声明一次，记忆用 E 编号引用。' };

export const LONG_TERM_EXTRACTION_SCHEMA = Object.freeze({ ...objectSchema({
  entities: entityArray,
  causalExcerpts: { type: ['array', 'null'], items: objectSchema({
    sourceRef: { type: 'string', pattern: '^M[0-9]{4}$' },
    start: { type: 'string', minLength: 1 }, end: { type: 'string', minLength: 1 },
  }) },
  memories: { type: 'array', description: '本批新增记忆。保留已确定的事项结果、实际进展、明确约定、人物事实和可独立追溯的经历。没有符合条件的信息时返回空数组。', items: { ...objectSchema({
    title: { type: 'string', description: '简短具体的标题。' },
    content: { ...text, description: `${memoryContentDescription}；文字字段遵循窗口指定的输出语言。` },
    classification: { type: 'object', description: '按 category 对应的分支填写类型、稳定键、命题和目标对象。', anyOf: classificationBranches },
    entityRefs: { type: ['array', 'null'], items: { type: 'string', pattern: '^E[1-9][0-9]*$' }, description: '本条明确涉及的实体编号。' },
    subject,
    actors: { type: 'array', description: '有直接证据的人物角色；无法确定的条目省略。', items: objectSchema({
      role: { type: 'string', enum: GENERATED_ACTOR_ROLES,
        description: 'experiencer=经历者；observer=直接观察者；participant=行动或决策参与者；belief_holder=观念持有者；preference_holder=偏好持有者。' },
      person, confidence: score,
    }) },
    reality: { type: 'string', enum: REALITY_STATES },
    evidenceMode: { type: 'string', enum: GENERATED_EVIDENCE_MODES,
      description: 'explicit=原文明示的事实、感受、看法或计划；observed=直接观察结果；inferred=基于证据的可撤销推断。' },
    temporalState: { type: 'string', enum: TEMPORAL_STATES },
    revisionAction: { type: 'string', enum: REVISION_ACTIONS },
    time: { type: ['object', 'null'], anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: [], properties: {
      date: { type: ['string', 'null'], description: '原文已确定到日的事发日期 YYYY-MM-DD；仅知年份或月份时为 null。' },
      start: { type: ['string', 'null'], description: '原文已确定的发生时刻，带 UTC 偏移的 ISO 8601；仅知日期或更粗精度时为 null。' },
      end: { type: ['string', 'null'], description: '原文已确定的结束时刻，带 UTC 偏移的 ISO 8601；仅知日期或更粗精度时为 null。' },
    } }], description: '未知为 null；已知时填写日期或时刻，省略未知部分。' },
    confidence: { ...score, description: '证据可靠程度。' },
    importance: { ...score, description: '对记忆拥有者的重要程度。' },
    sourceRefs: { type: 'array', minItems: 1, description: '支持内容的全部正文消息编号。',
      items: { type: 'string', pattern: '^M[0-9]{4}$' } },
  }), required: ['title', 'content', 'classification', 'subject', 'actors', 'reality', 'evidenceMode', 'temporalState', 'revisionAction', 'time', 'confidence', 'importance', 'sourceRefs'] } },
}), required: ['memories'] });

// Property order guides generation while the host validates the registered schema.
const modelExtractionSchema = structuredClone(LONG_TERM_EXTRACTION_SCHEMA);
const modelMemories = modelExtractionSchema.properties.memories;
modelMemories.items.properties.content.description = `${memoryContentDescription}。`;
const modelClassification = modelMemories.items.properties.classification;
modelClassification.description += ` key 为状态键。${stateKey.description} label 为命题。${stateLabel.description}`;
const modelClassificationBranches = modelClassification.anyOf;
const modelEventCategory = modelClassificationBranches.find(branch => branch.properties.category.enum.includes('event'))
  .properties.category;
modelEventCategory.description = modelEventCategory.description.replace('决定、约定、方案', '决定、方案');
for (const branch of modelClassificationBranches) {
  if (!Object.hasOwn(branch.properties, 'label')) continue;
  const { category, key: { description: _keyDescription, ...key },
    label: { description: _labelDescription, ...label }, ...remaining } = branch.properties;
  branch.properties = { category, label, key, ...remaining };
}
export const LONG_TERM_EXTRACTION_MODEL_SCHEMA = Object.freeze(modelExtractionSchema);

const initialModelSchema = structuredClone(LONG_TERM_EXTRACTION_MODEL_SCHEMA);
const initialModelItem = initialModelSchema.properties.memories.items;
const { classification, subject: modelSubject, sourceRefs: _sourceRefs, ...memoryFields } = initialModelItem.properties;
const time = {
  description: '只有事发日时用日期字符串，有时刻时用原有对象，未知时为 null。',
  anyOf: [EXTRACTION_MODEL_DATE, ...memoryFields.time.anyOf],
};
initialModelItem.properties = {
  classification,
  subject: modelSubject,
  evidence: EXTRACTION_MODEL_EVIDENCE,
  ...memoryFields,
  revisionAction: {
    type: ['string', 'null'],
    enum: [...REVISION_ACTIONS, null],
    description: '仅未取消的新增事件可省略或填 null。其余填实际动作。',
  },
  time,
};
initialModelItem.required = initialModelItem.required.filter(field => field !== 'revisionAction')
  .map(field => field === 'sourceRefs' ? 'evidence' : field);

export function buildLongTermExtractionRequest({ systemPrompt, ...source }) {
  const built = buildLongTermExtractionInput(source);
  return { built, request: {
    input: built.input,
    modelInput: built.modelInput,
    systemPrompt,
    schema: LONG_TERM_EXTRACTION_SCHEMA,
    modelSchema: initialModelSchema,
    schemaName: 'long-term-memory-extraction-v4',
    decodeOutput: output => decodeExtractionModelOutput(output, built.evidenceReferences, TARGET_PROPERTIES),
  } };
}

export function buildLongTermExtractionInput({
  messages = [],
  previousContextMessages = [],
  continuationGuidanceMessages = [],
  archiveWindows = [],
  outputLanguage,
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
      outputLanguage,
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
    const windowMessages = window.messages || [];
    const language = archiveWindowLanguage(window, windowMessages);
    const standardized = assignMemoryRefs(windowMessages, nextRef).map((message) => ({
      ...message,
      sourceLanguage: normalizeExtractionLanguage(message.sourceLanguage) || undefined,
      outputLanguage: language,
      archiveWindowId,
      archiveContinuityId,
      archiveWindowLabel: `W${String(index + 1).padStart(4, "0")}`,
    }));
    nextRef += standardized.length;
    return {
      id: archiveWindowId,
      continuityId: archiveContinuityId,
      label: `W${String(index + 1).padStart(4, "0")}`,
      sourceLanguage: language,
      messages: standardized,
      previousContextMessages: [...(window.previousContextMessages || [])],
      continuationGuidanceMessages: [...(window.continuationGuidanceMessages || [])],
    };
  });
  const standardized = standardizedWindows.flatMap((window) => window.messages);
  const allMessages = standardizedWindows.flatMap(window => [...window.previousContextMessages, ...window.messages, ...window.continuationGuidanceMessages]);
  const participants = buildExtractionParticipants(allMessages, { companionName: memoryOwner, primaryUserName: userName, ...identity });
  const owner = participants.find(participant => participant.actorRole === 'agent');
  const evidenceReferences = new Map();
  const language = standardizedWindows[0].sourceLanguage;
  const sameLanguage = standardizedWindows.every(window => window.sourceLanguage === language);
  const windowDefaults = standardizedWindows.flatMap(({ label, sourceLanguage }) => {
    const name = OUTPUT_LANGUAGE_NAMES.get(sourceLanguage);
    return name ? [`${label} ${name}`] : [];
  });
  const languageInstruction = !sameLanguage && windowDefaults.length
    ? `沿用直接证据的语言，语种不清时按窗口默认（${windowDefaults.join('，')}）`
    : extractionOutputLanguage(sameLanguage ? language : 'mixed');
  const parts = [
    `【输出语言：${languageInstruction}】`,
    `记忆拥有者：${owner ? `${owner.ref} ${owner.displayName}` : memoryOwner}`,
    `时间基准时区：${timeZone}。消息时间按该时区显示并带 UTC 偏移；相对日期以对应消息的当地日期为准。`,
    '【人物表】',
    JSON.stringify(participants.map(({ ref, displayName }) => ({ ref, name: displayName }))),
  ];
  for (const window of standardizedWindows) {
    const { input: previousContext } = formatMessages(window.previousContextMessages, {
      timeZone,
      language: window.sourceLanguage,
      participants,
    });
    const conversation = formatMessages(window.messages, {
      timeZone,
      includeRefs: true,
      language: window.sourceLanguage,
      participants,
      evidenceReferences,
    });
    const { input: continuationGuidance } = formatMessages(window.continuationGuidanceMessages, {
      timeZone,
      language: window.sourceLanguage,
      participants,
    });
    if (standardizedWindows.length > 1 || window.id) {
      parts.push("", `【语义归档窗口 ${window.label}】`);
    }
    if (previousContext) {
      parts.push(
        "",
        "【只读的前文衔接】",
        "",
        previousContext,
      );
    }
    if (conversation.input) {
      parts.push("", "【待提取记忆的对话正文】", "", conversation);
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
  const render = field => `${parts.map(part => typeof part === 'string' ? part : part[field]).join("\n").trim()}\n`;
  return {
    input: render('input'),
    modelInput: render('modelInput'),
    evidenceReferences,
    messages: standardized,
    archiveWindows: standardizedWindows,
    previousContextMessages: standardizedWindows.flatMap(
      (window) => window.previousContextMessages,
    ),
    continuationGuidanceMessages: standardizedWindows.flatMap(
      (window) => window.continuationGuidanceMessages,
    ),
    participants,
    timeZone,
  };
}

function stripCodeFence(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return clean(fenced?.[1] || text);
}

function exactFields(value, required, optional, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 必须是对象。`);
  const missing = required.filter(key => !Object.hasOwn(value, key));
  const unexpected = Object.keys(value).filter(key => !required.includes(key) && !optional.includes(key));
  if (missing.length || unexpected.length) throw new Error(`${path} 字段不符合约定；缺少：${missing.join(', ') || '无'}；不适用：${unexpected.join(', ') || '无'}。`);
}

function validatePerson(value, path, { scope = false, world = false } = {}) {
  exactFields(value, [], ['ref', 'name', ...(scope ? ['scope'] : []), ...(world ? ['world'] : [])], path);
  if (Object.hasOwn(value, 'ref') && Object.keys(value).length === 1 && typeof value.ref === 'string' && /^[PE][1-9][0-9]*$/u.test(value.ref)) return;
  if (Object.hasOwn(value, 'name') && Object.keys(value).length === 1 && typeof value.name === 'string' && clean(value.name)) return;
  if (world && Object.keys(value).length === 1 && typeof value.world === 'string' && clean(value.world)) return;
  if (scope && Object.keys(value).sort().join() === 'name,scope'
    && ['shared', 'world', 'unknown'].includes(value.scope) && typeof value.name === 'string') return;
  throw new Error(`${path} 必须是人物引用、原文名称${scope ? '或明确的主体范围' : ''}${world ? '或世界对象' : ''}。`);
}

export function checkExtractionSourceRefs(sourceRefs, findMessage) {
  const missingRefs = [];
  const windows = new Set();
  for (const ref of sourceRefs) {
    const message = findMessage(ref);
    if (message) windows.add(clean(message.archiveWindowId));
    else missingRefs.push(ref);
  }
  if (missingRefs.length) return { reason: 'unknown-source-ref', missingRefs };
  if (windows.size > 1) return { reason: 'cross-window-evidence' };
  return null;
}

function decodeExtractionOutput(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(stripCodeFence(value)); }
  catch (error) { throw new Error(`长期记忆提取模型输出不是有效 JSON：${error.message}`); }
}

/** Parse the model contract. Identity references are resolved at normalization. */
export function parseGeneratedLongTermExtraction(value, context = {}) {
  return parseExtractionCandidates(decodeExtractionOutput(value), context).parsed;
}

function parseExtractionCandidates(parsed, context, { failures, normalize = false, entityBindings } = {}) {
  const { messages, timeZone, allowTimeEvidence = false, evidenceReferences } = context;
  parsed = decodeExtractionModelOutput(parsed, evidenceReferences, TARGET_PROPERTIES);
  let validationError;
  try {
    exactFields(parsed, ['memories'], ['entities', 'causalExcerpts'], '长期记忆提取模型输出');
  } catch (error) {
    if (!failures || !Array.isArray(parsed?.memories)) throw error;
    validationError = error;
  }
  if (!Array.isArray(parsed.memories)) throw new Error('memories 必须是数组。');
  const { byRef: entityByRef, errors: entityErrors, tableError } = extractionEntityTable(parsed.entities, entityBindings, Boolean(failures));
  const getEntity = ref => {
    const entity = entityByRef.get(ref);
    const issue = entityErrors.get(ref) || (!entity && tableError);
    if (issue) throw issue;
    return entity;
  };
  const normalizeMemory = normalize ? extractionMemoryNormalizer(context, entityByRef) : null;
  const messagesByRef = messages ? new Map(messages.map(message => [message.memoryRef, message])) : null;
  const properties = LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.properties;
  const optionalFields = ['entityRefs', 'time', ...(allowTimeEvidence ? ['timeEvidence'] : [])];
  const requiredFields = Object.keys(properties).filter(key => !optionalFields.includes(key));
  const parseMemory = (candidate, index) => {
    const path = `memories[${index}]`;
    if (evidenceReferences && candidate && Object.hasOwn(candidate, 'evidence')) {
      throw new Error(`${path}.evidence 的主证据或补充证据编号不符合本批正文。`);
    }
    exactFields(candidate, requiredFields, optionalFields, path);
    for (const field of ['title', 'content']) {
      if (typeof candidate[field] !== 'string' || (field === 'content' && !clean(candidate[field]))) throw new Error(`${path}.${field} 无效。`);
    }
    for (const field of ['reality', 'evidenceMode', 'temporalState', 'revisionAction']) {
      if (!properties[field].enum.includes(candidate[field])) throw new Error(`${path}.${field} 无效。`);
    }
    const classification = candidate.classification;
    if (!classification || typeof classification.category !== 'string' || !Object.hasOwn(CATEGORIES, classification.category)) throw new Error(`${path}.classification.category 无效。`);
    const { kind, stateFamily } = CATEGORIES[classification.category];
    const required = ['category', ...(kind === 'reflection' ? ['key'] : isStatefulMemoryKind(kind) ? ['key', 'label'] : []),
      ...(TARGET_PROPERTIES[stateFamily] ? ['target'] : [])];
    exactFields(classification, required, [], `${path}.classification`);
    for (const field of ['key', 'label'].filter(key => required.includes(key))) {
      if (typeof classification[field] !== 'string' || (kind !== 'reflection' && !clean(classification[field]))) throw new Error(`${path}.classification.${field} 不能为空。`);
    }
    if (TARGET_PROPERTIES[stateFamily]) {
      const targetPath = `${path}.classification.target`;
      exactFields(classification.target, Object.keys(TARGET_PROPERTIES[stateFamily]), [], targetPath);
      for (const [field, schema] of Object.entries(TARGET_PROPERTIES[stateFamily])) {
        const entry = classification.target[field];
        if (schema.anyOf) validatePerson(entry, `${targetPath}.${field}`, { world: field !== 'counterpart' });
        else if (!schema.enum.includes(entry)) throw new Error(`${targetPath}.${field} 无效。`);
      }
    }
    validatePerson(candidate.subject, `${path}.subject`, { scope: true });
    if (!Array.isArray(candidate.actors)) throw new Error(`${path}.actors 必须是数组。`);
    for (const [actorIndex, actor] of candidate.actors.entries()) {
      const actorPath = `${path}.actors[${actorIndex}]`;
      exactFields(actor, ['role', 'person', 'confidence'], [], actorPath);
      if (!GENERATED_ACTOR_ROLES.includes(actor.role)) throw new Error(`${actorPath}.role 无效。`);
      validatePerson(actor.person, `${actorPath}.person`);
      if (typeof actor.confidence !== 'number' || !Number.isFinite(actor.confidence) || actor.confidence < 0 || actor.confidence > 1) throw new Error(`${actorPath}.confidence 无效。`);
    }
    if (!Array.isArray(candidate.sourceRefs) || !candidate.sourceRefs.length
      || candidate.sourceRefs.some(ref => typeof ref !== 'string' || !/^M[0-9]{4}$/u.test(ref))) throw new Error(`${path}.sourceRefs 无效。`);
    if (messagesByRef) {
      const issue = checkExtractionSourceRefs(candidate.sourceRefs, ref => messagesByRef.get(ref));
      if (issue?.missingRefs) throw new Error(`${path}.sourceRefs 引用了允许范围之外的消息：${issue.missingRefs.join('、')}。`);
      if (issue) throw new Error(`${path}.sourceRefs 跨归档窗口，每条记忆应引用同一窗口的原话。`);
    }
    for (const field of ['confidence', 'importance']) {
      if (typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field]) || candidate[field] < 0 || candidate[field] > 1) throw new Error(`${path}.${field} 必须在 0 到 1 之间。`);
    }
    const entityRefs = candidate.entityRefs ?? [];
    if (!Array.isArray(entityRefs) || entityRefs.some(ref => typeof ref !== 'string' || !getEntity(ref))) throw new Error(`${path}.entityRefs 无效。`);
    const inspectRef = (entry, personal) => {
      if (!entry?.ref?.startsWith('E')) return;
      const entity = getEntity(entry.ref);
      if (!entity || personal && !['person', 'agent'].includes(entity.kind)) throw new Error(`${path} 的实体引用类型不适用。`);
    };
    inspectRef(candidate.subject, true);
    candidate.actors.forEach(actor => inspectRef(actor.person, true));
    if (classification.target) for (const [key, entry] of Object.entries(classification.target)) inspectRef(entry, key === 'counterpart');
    const time = normalizeExtractionTime(candidate.time, timeZone);
    return { ...candidate, ...(candidate.entityRefs != null ? { entityRefs: [...new Set(entityRefs)] } : {}), title: clean(candidate.title), content: clean(candidate.content), time,
      sourceRefs: [...new Set(candidate.sourceRefs)] };
  };
  const memories = [];
  for (const [index, candidate] of parsed.memories.entries()) {
    try {
      const memory = parseMemory(candidate, index);
      memories.push(normalizeMemory ? normalizeMemory(memory, index) : memory);
    } catch (error) {
      if (!failures) throw error;
      failures.push({ index, candidate, error });
      validationError ??= error;
    }
  }
  return { validationError, parsed: { ...(parsed.entities != null ? { entities: [...entityByRef.values()] } : {}),
    ...(Array.isArray(parsed.causalExcerpts) ? { causalExcerpts: parsed.causalExcerpts } : {}), memories } };
}

function extractionEntityTable(value, bindings = new Map(), inspect = false) {
  const byRef = new Map(bindings);
  const errors = new Map();
  if (value == null) return { byRef, errors };
  if (!Array.isArray(value)) {
    const tableError = new Error('entities 必须是数组。');
    if (!inspect) throw tableError;
    return { byRef, errors, tableError };
  }
  const refs = new Set();
  for (const [index, entity] of value.entries()) {
    const ref = entity?.ref;
    try {
      exactFields(entity, ['ref', 'kind', 'name', 'aliases'], [], `entities[${index}]`);
      if (typeof ref !== 'string' || !/^E[1-9][0-9]*$/u.test(ref) || refs.has(ref) || errors.has(ref)
        || !ENTITY_KINDS.includes(entity.kind) || typeof entity.name !== 'string' || !clean(entity.name)
        || !Array.isArray(entity.aliases) || entity.aliases.some(alias => typeof alias !== 'string' || !clean(alias))) throw new Error(`entities[${index}] 无效。`);
      refs.add(ref);
      const known = bindings.get(ref);
      if (!known) {
        byRef.set(ref, { ...entity, name: clean(entity.name), aliases: [...new Set(entity.aliases.map(clean))] });
      } else {
        if (known.kind !== entity.kind) throw new Error(`Entity ${ref} has type ${known.kind}; use a new reference for a different type.`);
        const names = new Set([known.name, ...known.aliases].map(entityNameKey));
        if ([entity.name, ...entity.aliases].some(name => !names.has(entityNameKey(name)))) {
          throw new Error(`Entity ${ref} is bound to ${known.name}; use a new reference for a different entity.`);
        }
      }
    } catch (error) {
      if (!inspect) throw error;
      errors.set(ref, error);
      if (!bindings.has(ref)) byRef.delete(ref);
    }
  }
  return { byRef, errors };
}

export function parseExtractionEntities(value) {
  return [...extractionEntityTable(value).byRef.values()];
}

export function extractionEntityScope(messages = []) {
  return createHash('sha256').update(JSON.stringify(messages.map(message => message.id || message.memoryRef))).digest('hex').slice(0, 24);
}

export function extractionEntityReferences(candidate) {
  return [...new Set([
    ...(Array.isArray(candidate?.entityRefs) ? candidate.entityRefs : []), candidate?.subject?.ref,
    ...(Array.isArray(candidate?.actors) ? candidate.actors.map(actor => actor?.person?.ref) : []),
    ...Object.values(candidate?.classification?.target || {}).map(value => value?.ref),
  ].filter(ref => typeof ref === 'string' && /^E[1-9][0-9]*$/u.test(ref)))];
}

export function extractionEntityDeclarationsFor(memories, entities, boundRefs) {
  if (entities == null) return [];
  const refs = new Set(memories.flatMap(extractionEntityReferences));
  if (!refs.size) return [];
  return Array.isArray(entities) ? entities.filter(entity => refs.has(entity?.ref) && !boundRefs?.has(entity.ref)) : entities;
}

/** Resolve host references once; keep declared entity references for the local
 * repository transaction that binds persistent entities. */
export function normalizeGeneratedLongTermExtraction(value, context = {}) {
  const { parsed } = parseExtractionCandidates(decodeExtractionOutput(value), context, { normalize: true });
  return { memories: parsed.memories };
}

/** Inspect a batch once, keeping valid candidates and the original failed drafts. */
export function inspectGeneratedLongTermExtraction(value, context = {}, entityBindings) {
  let output;
  try {
    output = decodeExtractionOutput(value);
    const failures = [];
    const { parsed, validationError } = parseExtractionCandidates(output, context, { failures, normalize: true, entityBindings });
    return { output: { memories: parsed.memories }, failures, validationError,
      originalCount: output.memories.length, entities: output.entities, causalExcerpts: parsed.causalExcerpts };
  } catch (validationError) {
    return { validationError, causalExcerpts: output?.causalExcerpts };
  }
}

function extractionMemoryNormalizer(context, declarations) {
  const identityScope = context.entityScope || extractionEntityScope(context.messages);
  function identity(person) {
    if (person.scope) return { role: person.scope, key: '', name: clean(person.name), status: 'scope' };
    if (person.world) return { role: 'world', key: '', name: clean(person.world), status: 'scope' };
    if (person.ref?.startsWith('E')) {
      const entity = declarations.get(person.ref);
      return { role: ['person', 'agent'].includes(entity.kind) ? 'other' : 'world', key: '', name: entity.name, status: 'entity', entity };
    }
    return resolveExtractionActor({ ref: person.ref, name: person.name }, context);
  }
  return (candidate, index) => {
    const { kind, stateFamily } = CATEGORIES[candidate.classification.category];
    const holder = identity(candidate.subject);
    if (kind === 'reflection' && !MEMORY_KIND_DEFINITIONS.reflection.subjectRoles.includes(holder.role)) {
      throw new Error(`memories[${index}].classification.category: reflection 仅适用于记忆拥有者或共同主体的反思。`);
    }
    const target = candidate.classification.target;
    let stateTarget;
    if (stateFamily === 'identity') stateTarget = { ...target };
    else if (target) {
      const prefix = stateFamily === 'belief' ? 'object' : stateFamily === 'relationship' ? 'counterpart' : 'trigger';
      const other = identity(target[prefix]);
      stateTarget = { [`${prefix}Role`]: other.role, [`${prefix}Name`]: other.name, [`${prefix}Key`]: other.key, [`${prefix}IdentityStatus`]: other.status,
        ...(other.entity ? { [`${prefix}EntityRef`]: other.entity.ref } : {}),
        ...(stateFamily === 'relationship' ? { relationshipDimension: target.dimension } : {}) };
    }
    return { kind, title: candidate.title, content: candidate.content,
      subjectRole: holder.role, subjectName: holder.name, subjectKey: holder.key, subjectIdentityStatus: holder.status,
      ...(holder.entity ? { subjectEntityRef: holder.entity.ref } : {}),
      actorRoles: candidate.actors.map(actor => { const person = identity(actor.person);
        return { role: actor.role, actorRole: person.role, actorKey: person.key, actorName: person.name, identityStatus: person.status,
          ...(person.entity ? { entityRef: person.entity.ref } : {}), confidence: actor.confidence }; }),
      ...(declarations.size ? { entityScope: identityScope, entityMentions: extractionEntityReferences(candidate)
        .filter(ref => declarations.has(ref)).map(ref => declarations.get(ref)) } : {}),
      canonicalKey: clean(candidate.classification.key), stateFamily, stateLabel: clean(candidate.classification.label),
      ...(stateTarget ? { stateTarget } : {}),
      reality: candidate.reality, evidenceMode: candidate.evidenceMode, temporalState: candidate.temporalState,
      revisionAction: candidate.revisionAction,
      eventDate: candidate.time?.date || '',
      eventStart: candidate.time?.start ? new Date(candidate.time.start).toISOString() : '',
      eventEnd: candidate.time?.end ? new Date(candidate.time.end).toISOString() : '',
      confidence: candidate.confidence, importance: candidate.importance, sourceRefs: candidate.sourceRefs,
    };
  };
}
