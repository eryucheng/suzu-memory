import { createHash } from 'node:crypto';
import {
  ENTITY_KINDS,
  DIRECT_INGESTION_MEMORY_KINDS,
  STATE_IDENTITY_FIELDS,
  RELATIONSHIP_DIMENSIONS,
  DEFAULT_MEMORY_TIME_ZONE,
  EVIDENCE_MODES,
  MEMORY_ACTOR_ROLES,
  MEMORY_STATE_FAMILIES,
  MEMORY_STATE_FAMILY_DEFINITIONS,
  REALITY_STATES,
  REVISION_ACTIONS,
  TEMPORAL_STATES,
  isMemoryKindAllowedForStateFamily,
  isStatefulMemoryKind,
  timestampInTimeZone,
} from "@suzu-memory/core";
import { buildExtractionParticipants, resolveExtractionActor, resolveExtractionSpeaker } from './participant-identity.mjs';
import { createExtractionTimeValidator } from './temporal-evidence.mjs';

const GENERATED_ACTOR_ROLES = MEMORY_ACTOR_ROLES.filter(role => !['subject', 'speaker'].includes(role));
const GENERATED_EVIDENCE_MODES = EVIDENCE_MODES.filter(mode => ['explicit', 'observed', 'inferred'].includes(mode));
const objectSchema = properties => ({ type: 'object', additionalProperties: false,
  properties, required: Object.keys(properties) });
const text = { type: 'string', minLength: 1 };
const stateKey = { ...text, description: '按状态的维度、对象和适用范围命名的简短稳定键。' };
const stateLabel = { ...text, description: '可独立更新的状态命题或对象标签。' };
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
  description: categories.map(category => `${category}=${category === 'event' ? '具体经历'
    : category === 'reflection' ? '已经表达的反思' : category === 'plan' ? '未来打算'
      : category === 'commitment' ? '已答应的责任' : category === 'open_loop' ? '尚待跟进的事项'
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

function normalizeExtractionLanguage(value) {
  const normalized = clean(value).toLowerCase();
  if (["zh", "zh-cn", "chinese", "中文", "汉语"].includes(normalized)) return "zh";
  if (["en", "en-us", "en-gb", "english", "英语"].includes(normalized)) return "en";
  if (["mixed", "bilingual", "双语", "中英混合"].includes(normalized)) return "mixed";
  return "";
}

/** Infer the Chinese/English output policy from Han and Latin letter counts. */
export function detectExtractionLanguage(value) {
  const text = String(value || "");
  const han = (text.match(/\p{Script=Han}/gu) || []).length;
  const latin = (text.match(/[A-Za-z]/gu) || []).length;
  if (!han && !latin) return "unknown";
  if (!han) return "en";
  if (!latin) return "zh";
  const smallerShare = Math.min(han, latin) / (han + latin);
  // Treat substantial text in both scripts as mixed.
  return smallerShare >= 0.25 ? "mixed" : han > latin ? "zh" : "en";
}

function archiveWindowLanguage(window, messages) {
  const declared = normalizeExtractionLanguage(
    window?.sourceLanguage || window?.outputLanguage || window?.language,
  );
  if (declared) return declared;
  const languages = new Set(messages.map(message => message.sourceLanguage)
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
    return ["【本窗口输出语言：逐候选跟随直接证据】"];
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
  language = "unknown",
  participants = [],
  timeZone = DEFAULT_MEMORY_TIME_ZONE,
} = {}) {
  return messages.map((message) => {
    const source = message.eventSource;
    const participant = resolveExtractionSpeaker(message, participants);
    const context = source ? { spaceId: source.spaceId, spaceKind: source.topology?.spaceKind || source.topology?.kind } : null;
    return `${includeRefs ? `[${message.memoryRef}] ` : ""}[${timestampInTimeZone(message.timestamp, timeZone) || message.timestamp || ""}] ${
      message.worldFrame ? `[world=${message.worldFrame}:${message.worldId || "primary"}] ` : ""
    }${language === "mixed" && message.sourceLanguage && message.sourceLanguage !== "unknown"
      ? `[source-language=${message.sourceLanguage}] ` : ""
    }${context ? `[来源 ${JSON.stringify(context)}] ` : ""}${participant ? `${participant.ref} ${participant.displayName}` : source?.sender.name || roleLabel(message.role, language)}${
      source && message.knownAt && message.knownAt !== message.occurredAt ? ` [获知时间=${timestampInTimeZone(message.knownAt, timeZone) || message.knownAt}]` : ''
    }：${message.text}`;
  }).join("\n\n");
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
  memories: { type: 'array', description: '本批记忆候选；没有时返回空数组。', items: { ...objectSchema({
    title: { type: 'string', description: '简短具体的标题。' },
    content: { ...text, description: '可独立理解的正文；文字字段遵循窗口指定的输出语言。' },
    classification: { type: 'object', anyOf: classificationBranches },
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
      date: { type: ['string', 'null'], description: '已知事发日 YYYY-MM-DD。' },
      start: { type: ['string', 'null'], description: '已知发生时刻，带 UTC 偏移的 ISO 8601。' },
      end: { type: ['string', 'null'], description: '已知结束时刻，带 UTC 偏移的 ISO 8601。' },
    } }], description: '未知为 null；已知时填写日期或时刻，省略未知部分。' },
    confidence: { ...score, description: '证据可靠程度。' },
    importance: { ...score, description: '对记忆拥有者的重要程度。' },
    sourceRefs: { type: 'array', minItems: 1, description: '支持内容的全部正文消息编号。',
      items: { type: 'string', pattern: '^M[0-9]{4}$' } },
  }), required: ['title', 'content', 'classification', 'subject', 'actors', 'reality', 'evidenceMode', 'temporalState', 'revisionAction', 'time', 'confidence', 'importance', 'sourceRefs'] } },
}), required: ['memories'] });

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
      sourceLanguage: archiveWindowLanguage(window, standardized),
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
    `记忆拥有者：${owner ? `${owner.ref} ${owner.displayName}` : memoryOwner}`,
    `时间基准时区：${timeZone}。消息时间按该时区显示并带 UTC 偏移；相对日期以对应消息的当地日期为准。`,
    '【人物表】',
    JSON.stringify(participants.map(({ ref, displayName }) => ({ ref, name: displayName }))),
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
    timeZone,
  };
}

function stripCodeFence(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return clean(fenced?.[1] || text);
}

function validCalendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
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

/** Parse the model contract. Identity references are resolved only at the
 * ingestion boundary, where the batch's authoritative participant table lives. */
export function parseGeneratedLongTermExtraction(value, { messages, timeZone } = {}) {
  let parsed = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(stripCodeFence(value)); }
    catch (error) { throw new Error(`长期记忆提取模型输出不是有效 JSON：${error.message}`); }
  }
  exactFields(parsed, ['memories'], ['entities', 'causalExcerpts'], '长期记忆提取模型输出');
  const entities = parseExtractionEntities(parsed.entities ?? []);
  const entityByRef = new Map(entities.map(entity => [entity.ref, entity]));
  if (!Array.isArray(parsed.memories)) throw new Error('memories 必须是数组。');
  const validateTime = createExtractionTimeValidator(messages || [], timeZone);
  const properties = LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.properties;
  return { ...(parsed.entities != null ? { entities } : {}),
    ...(Array.isArray(parsed.causalExcerpts) ? { causalExcerpts: parsed.causalExcerpts } : {}),
    memories: parsed.memories.map((candidate, index) => {
    const path = `memories[${index}]`;
    exactFields(candidate, Object.keys(properties).filter(key => key !== 'entityRefs'), ['entityRefs'], path);
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
    let time = candidate.time;
    if (time !== null) {
      exactFields(time, [], ['date', 'start', 'end'], `${path}.time`);
      if (Object.values(time).some(entry => entry !== null && typeof entry !== 'string')) throw new Error(`${path}.time 字段必须是已知日期、时刻或 null。`);
      time = Object.fromEntries(Object.entries(time).map(([field, value]) => [field, clean(value) || null]));
      if (time.date && !validCalendarDate(time.date)) throw new Error(`${path}.time.date 必须是有效 YYYY-MM-DD。`);
      for (const field of ['start', 'end']) if (time[field] && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(time[field])
        || !validCalendarDate(time[field].slice(0, 10)) || !Number.isFinite(new Date(time[field]).getTime()))) {
        throw new Error(`${path}.time.${field} 必须是带 UTC 偏移的有效 ISO 8601 时间。`);
      }
      if (time.start && time.end && new Date(time.end) < new Date(time.start)) throw new Error(`${path}.time.end 不能早于 start。`);
      if (!Object.values(time).some(Boolean)) time = null;
    }
    if (!Array.isArray(candidate.sourceRefs) || !candidate.sourceRefs.length
      || candidate.sourceRefs.some(ref => typeof ref !== 'string' || !/^M[0-9]{4}$/u.test(ref))) throw new Error(`${path}.sourceRefs 无效。`);
    for (const field of ['confidence', 'importance']) {
      if (typeof candidate[field] !== 'number' || !Number.isFinite(candidate[field]) || candidate[field] < 0 || candidate[field] > 1) throw new Error(`${path}.${field} 必须在 0 到 1 之间。`);
    }
    const entityRefs = candidate.entityRefs ?? [];
    if (!Array.isArray(entityRefs) || entityRefs.some(ref => typeof ref !== 'string' || !entityByRef.has(ref))) throw new Error(`${path}.entityRefs 无效。`);
    const inspectRef = (entry, personal) => {
      if (!entry?.ref?.startsWith('E')) return;
      const entity = entityByRef.get(entry.ref);
      if (!entity || personal && !['person', 'agent'].includes(entity.kind)) throw new Error(`${path} 的实体引用类型不适用。`);
    };
    inspectRef(candidate.subject, true);
    candidate.actors.forEach(actor => inspectRef(actor.person, true));
    if (classification.target) for (const [key, entry] of Object.entries(classification.target)) inspectRef(entry, key === 'counterpart');
    const normalized = { ...candidate, ...(candidate.entityRefs != null ? { entityRefs: [...new Set(entityRefs)] } : {}), title: clean(candidate.title), content: clean(candidate.content), time,
      sourceRefs: [...new Set(candidate.sourceRefs)] };
    validateTime({ ...normalized, kind, eventDate: time?.date || '', eventStart: time?.start || '', eventEnd: time?.end || '' });
    return normalized;
  }) };
}

export function parseExtractionEntities(value = []) {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('entities 必须是数组。');
  const refs = new Set();
  return value.map((entity, index) => {
    exactFields(entity, ['ref', 'kind', 'name', 'aliases'], [], `entities[${index}]`);
    if (typeof entity.ref !== 'string' || !/^E[1-9][0-9]*$/u.test(entity.ref) || refs.has(entity.ref)
      || !ENTITY_KINDS.includes(entity.kind) || typeof entity.name !== 'string' || !clean(entity.name)
      || !Array.isArray(entity.aliases) || entity.aliases.some(alias => typeof alias !== 'string' || !clean(alias))) throw new Error(`entities[${index}] 无效。`);
    refs.add(entity.ref);
    return { ...entity, name: clean(entity.name), aliases: [...new Set(entity.aliases.map(clean))] };
  });
}

export function extractionEntityScope(messages = []) {
  return createHash('sha256').update(JSON.stringify(messages.map(message => message.id || message.memoryRef))).digest('hex').slice(0, 24);
}

/** Resolve host references once; keep declared entity references for the local
 * repository transaction that binds persistent entities. */
export function normalizeGeneratedLongTermExtraction(value, context = {}) {
  const parsed = parseGeneratedLongTermExtraction(value, context);
  const declarations = new Map((parsed.entities || []).map(entity => [entity.ref, entity]));
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
  return { memories: parsed.memories.map(candidate => {
    const { kind, stateFamily } = CATEGORIES[candidate.classification.category];
    const holder = identity(candidate.subject);
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
      ...(declarations.size ? { entityScope: identityScope, entityMentions: [...new Set([...(candidate.entityRefs || []), candidate.subject.ref, ...candidate.actors.map(actor => actor.person.ref),
        ...Object.values(candidate.classification.target || {}).map(value => value?.ref)].filter(ref => declarations.has(ref)))].map(ref => declarations.get(ref)) } : {}),
      canonicalKey: clean(candidate.classification.key), stateFamily, stateLabel: clean(candidate.classification.label),
      ...(stateTarget ? { stateTarget } : {}),
      reality: candidate.reality, evidenceMode: candidate.evidenceMode, temporalState: candidate.temporalState,
      revisionAction: candidate.revisionAction,
      eventDate: candidate.time?.date || '',
      eventStart: candidate.time?.start ? new Date(candidate.time.start).toISOString() : '',
      eventEnd: candidate.time?.end ? new Date(candidate.time.end).toISOString() : '',
      confidence: candidate.confidence, importance: candidate.importance, sourceRefs: candidate.sourceRefs,
    };
  }) };
}
