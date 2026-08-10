import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const RHELM_CONTRACT_VERSION = "rhelm-current-dataset-v1";
export const RHELM_MEMORY_FORMAT_VERSION = "rhelm-source-memory-v1";
export const RHELM_CHUNKING_VERSION = "whitespace-token-500-overlap-50-v1";

const QA_FILENAME_PATTERN = /^low_score_qa_(.+)_all_validated\.jsonl$/u;
const CONVERSATION_FILENAME_PATTERN = /^conversation_(\d{4})_(\d{2})_(\d{2})\.json$/u;
const EMAIL_FILENAME_PATTERN = /^(\d+)_email_(\d{4})_(\d{2})_(\d{2})\.txt$/u;
const ATTACHMENT_FILENAME_PATTERN = /^(\d+)_.+\.(?:md|html?)$/iu;
const ISO_DATE_PATTERN = /\b(\d{4})-(\d{2})-(\d{2})\b/u;
const MONTH_DATE_PATTERN = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(\d{4})\b/iu;
const MONTHS = new Map([
  ["january", 1], ["february", 2], ["march", 3], ["april", 4],
  ["may", 5], ["june", 6], ["july", 7], ["august", 8],
  ["september", 9], ["october", 10], ["november", 11], ["december", 12],
]);
const DATA_DIRECTORIES = ["attachments", "conversations", "emails", "QA_final"];

function clean(value) {
  return String(value ?? "").trim();
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
}

function stableHash(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function sortedFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sortedFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function validateCalendarDate(year, month, day, label) {
  const timestamp = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const result = new Date(timestamp);
  if (
    result.getUTCFullYear() !== Number(year)
    || result.getUTCMonth() !== Number(month) - 1
    || result.getUTCDate() !== Number(day)
  ) {
    throw new Error(`${label} 不是有效日历日期：${year}-${month}-${day}。`);
  }
  return result;
}

export function parseRhelmDate(value, label = "RHELM 日期", { endOfDay = false } = {}) {
  const normalized = clean(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);
  if (!match) throw new Error(`${label} 格式无效：${normalized || "<empty>"}。`);
  const date = validateCalendarDate(match[1], match[2], match[3], label);
  if (endOfDay) date.setUTCHours(23, 59, 59, 999);
  return date;
}

export function parseRhelmTimestamp(value, label = "RHELM 时间") {
  const normalized = clean(value);
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u.exec(normalized);
  if (!match) throw new Error(`${label} 格式无效：${normalized || "<empty>"}。`);
  const date = validateCalendarDate(match[1], match[2], match[3], label);
  date.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6]), 0);
  if (
    date.getUTCHours() !== Number(match[4])
    || date.getUTCMinutes() !== Number(match[5])
    || date.getUTCSeconds() !== Number(match[6])
  ) {
    throw new Error(`${label} 不是有效时间：${normalized}。`);
  }
  return date;
}

export function rhelmDatasetTreeSha256(datasetRoot) {
  const normalizedRoot = path.resolve(clean(datasetRoot));
  const hash = createHash("sha256");
  for (const directory of DATA_DIRECTORIES) {
    const directoryPath = path.join(normalizedRoot, directory);
    if (!fs.existsSync(directoryPath)) throw new Error(`RHELM 缺少目录：${directoryPath}`);
    for (const filePath of sortedFiles(directoryPath)) {
      const relativePath = path.relative(normalizedRoot, filePath).replaceAll(path.sep, "/");
      hash.update(relativePath, "utf8");
      hash.update("\0", "utf8");
      hash.update(createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"), "utf8");
      hash.update("\n", "utf8");
    }
  }
  return hash.digest("hex");
}

export function rhelmPersonaFromQaFilename(filename) {
  const match = QA_FILENAME_PATTERN.exec(path.basename(clean(filename)));
  if (!match) throw new Error(`RHELM QA 文件名不符合契约：${filename}。`);
  return match[1];
}

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${error.message}`);
  }
}

function readJsonl(filePath, label) {
  return fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "").split(/\r?\n/u)
    .map((line) => line.trim()).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`${label} 第 ${index + 1} 行不是有效 JSON：${error.message}`);
      }
    });
}

function decodeHtmlEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&#(\d+);/gu, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/giu, (_, digits) => String.fromCodePoint(Number.parseInt(digits, 16)));
}

export function rhelmDocumentText(raw, extension = "") {
  const input = String(raw ?? "");
  if (!/^\.html?$/iu.test(extension)) return input.trim();
  return decodeHtmlEntities(input
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

export function inferRhelmDocumentDate(text, label = "RHELM 文档") {
  const normalized = clean(text);
  const iso = ISO_DATE_PATTERN.exec(normalized);
  if (iso) return validateCalendarDate(iso[1], iso[2], iso[3], label);
  const named = MONTH_DATE_PATTERN.exec(normalized);
  if (named) {
    return validateCalendarDate(
      named[3],
      String(MONTHS.get(named[1].toLowerCase())).padStart(2, "0"),
      String(named[2]).padStart(2, "0"),
      label,
    );
  }
  throw new Error(`${label} 缺少可验证的文档内日期。`);
}

export function chunkRhelmExternalText(text, { size = 500, overlap = 50 } = {}) {
  const chunkSize = Math.max(1, Math.trunc(Number(size) || 500));
  const chunkOverlap = Math.max(0, Math.min(chunkSize - 1, Math.trunc(Number(overlap) || 0)));
  const tokens = clean(text).split(/\s+/u).filter(Boolean);
  if (!tokens.length) return [];
  const step = chunkSize - chunkOverlap;
  const chunks = [];
  for (let start = 0; start < tokens.length; start += step) {
    const selected = tokens.slice(start, start + chunkSize);
    if (!selected.length) break;
    chunks.push({
      ordinal: chunks.length,
      startToken: start,
      endToken: start + selected.length,
      content: selected.join(" "),
    });
    if (start + selected.length >= tokens.length) break;
  }
  return chunks;
}

export function parseRhelmEvidenceReference(value, label = "RHELM supporting_evidence") {
  const normalized = clean(value);
  let match = /^(\d{4}-\d{2}-\d{2}):([\d,\s]+)$/u.exec(normalized);
  if (match) {
    parseRhelmDate(match[1], label);
    const turns = [...new Set(match[2].split(",").map((entry) => clean(entry)).filter(Boolean))];
    if (!turns.length || turns.some((turn) => !/^\d+$/u.test(turn))) {
      throw new Error(`${label} 的对话轮次无效：${normalized}。`);
    }
    return turns.map((turn) => `conversation:${match[1]}:${Number(turn)}`);
  }
  match = /^Emails_(\d{4}-\d{2}-\d{2})(?::|$)/iu.exec(normalized);
  if (match) {
    parseRhelmDate(match[1], label);
    return [`email:${match[1]}`];
  }
  match = /^([^:]+\.(?:md|html?))(?::|$)/iu.exec(normalized);
  if (match) return [`attachment:${match[1]}`];
  throw new Error(`${label} 格式未知：${normalized || "<empty>"}。`);
}

function normalizeQuestion(entry, index, persona) {
  const label = `RHELM ${persona} QA[${index}]`;
  assertObject(entry, label);
  const id = clean(entry.id);
  const question = clean(entry.question);
  const answer = clean(entry.answer);
  const questionType = clean(entry.question_type);
  if (!id || !question || !answer || !questionType) throw new Error(`${label} 缺少必填字段。`);
  if (!Array.isArray(entry.supporting_evidence) || !entry.supporting_evidence.length) {
    throw new Error(`${label}.supporting_evidence 必须是非空数组。`);
  }
  if (entry.characteristics !== null && !Array.isArray(entry.characteristics)) {
    throw new Error(`${label}.characteristics 必须是数组或 null。`);
  }
  const evidenceReferences = entry.supporting_evidence.map(clean).filter(Boolean);
  const evidenceSourceIds = [...new Set(evidenceReferences.flatMap((reference) => (
    parseRhelmEvidenceReference(reference, `${label}.supporting_evidence`)
  )))];
  return {
    id,
    persona,
    question,
    answer,
    questionType,
    questionDate: parseRhelmDate(entry.question_date, `${label}.question_date`, { endOfDay: true }),
    originalQuestionDate: clean(entry.question_date),
    evidenceReferences,
    evidenceSourceIds,
    characteristics: [...new Set((entry.characteristics || []).map(clean).filter(Boolean))],
    characteristicsMissing: entry.characteristics === null,
  };
}

function loadPersonaQuestions(datasetRoot, persona, qaPath) {
  const seen = new Set();
  return readJsonl(qaPath, `RHELM ${persona} QA`).map((entry, index) => {
    const question = normalizeQuestion(entry, index, persona);
    if (seen.has(question.id)) throw new Error(`RHELM ${persona} 存在重复问题 ID：${question.id}。`);
    seen.add(question.id);
    return question;
  }).sort((left, right) => (
    left.questionDate - right.questionDate || left.id.localeCompare(right.id)
  ));
}

function loadConversationSources(datasetRoot, persona) {
  const directory = path.join(datasetRoot, "conversations", persona);
  if (!fs.existsSync(directory)) throw new Error(`RHELM 缺少人物对话目录：${directory}`);
  const sources = [];
  for (const filePath of sortedFiles(directory)) {
    const filename = path.basename(filePath);
    const filenameMatch = CONVERSATION_FILENAME_PATTERN.exec(filename);
    if (!filenameMatch) throw new Error(`RHELM 对话文件名不符合契约：${filename}。`);
    const document = readJson(filePath, `RHELM 对话 ${filename}`);
    assertObject(document, `RHELM 对话 ${filename}`);
    if (clean(document.character) !== persona) throw new Error(`RHELM 对话人物不匹配：${filename}。`);
    const expectedDate = `${filenameMatch[1]}-${filenameMatch[2]}-${filenameMatch[3]}`;
    if (clean(document.date) !== expectedDate) throw new Error(`RHELM 对话文件日期不匹配：${filename}。`);
    if (!Array.isArray(document.conversation)) throw new Error(`RHELM 对话内容不是数组：${filename}。`);
    for (const [index, turn] of document.conversation.entries()) {
      assertObject(turn, `RHELM ${filename} turn[${index}]`);
      const turnNumber = Number(turn.turn);
      if (!Number.isInteger(turnNumber) || turnNumber < 1) throw new Error(`RHELM ${filename} 轮次无效。`);
      const timestamp = parseRhelmTimestamp(turn.timestamp, `RHELM ${filename} turn ${turnNumber}`);
      if (timestamp.toISOString().slice(0, 10) !== expectedDate) {
        throw new Error(`RHELM ${filename} turn ${turnNumber} 时间越出文件日期。`);
      }
      const user = clean(turn.user);
      const assistant = clean(turn.assistant);
      if (!user && !assistant) throw new Error(`RHELM ${filename} turn ${turnNumber} 内容为空。`);
      sources.push({
        sourceId: `conversation:${expectedDate}:${turnNumber}`,
        sourceType: "conversation",
        sourceDate: timestamp,
        sourceFile: filename,
        title: `Conversation ${expectedDate}, turn ${turnNumber}`,
        content: [user && `User: ${user}`, assistant && `Assistant: ${assistant}`].filter(Boolean).join("\n"),
        chunkOrdinal: 0,
        chunkCount: 1,
      });
    }
  }
  return sources;
}

function emailDateMaps(datasetRoot, persona) {
  const directory = path.join(datasetRoot, "emails", persona);
  if (!fs.existsSync(directory)) throw new Error(`RHELM 缺少人物邮件目录：${directory}`);
  const byPrefix = new Map();
  const sources = [];
  for (const filePath of sortedFiles(directory)) {
    const filename = path.basename(filePath);
    const match = EMAIL_FILENAME_PATTERN.exec(filename);
    if (!match) throw new Error(`RHELM 邮件文件名不符合契约：${filename}。`);
    const dateText = `${match[2]}-${match[3]}-${match[4]}`;
    const sourceDate = parseRhelmDate(dateText, `RHELM 邮件 ${filename}`);
    if (byPrefix.has(match[1])) throw new Error(`RHELM ${persona} 存在重复邮件序号：${match[1]}。`);
    byPrefix.set(match[1], sourceDate);
    sources.push({
      sourceId: `email:${dateText}`,
      sourceType: "email",
      sourceDate,
      sourceFile: filename,
      title: `Emails ${dateText}`,
      documentText: fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "").trim(),
    });
  }
  return { byPrefix, sources };
}

function loadAttachmentSources(datasetRoot, persona, emailDates) {
  const directory = path.join(datasetRoot, "attachments", persona);
  if (!fs.existsSync(directory)) throw new Error(`RHELM 缺少人物附件目录：${directory}`);
  const sources = [];
  for (const filePath of sortedFiles(directory)) {
    const filename = path.basename(filePath);
    const match = ATTACHMENT_FILENAME_PATTERN.exec(filename);
    if (!match) throw new Error(`RHELM 附件文件名不符合契约：${filename}。`);
    const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
    const documentText = rhelmDocumentText(raw, path.extname(filename));
    const mappedDate = emailDates.get(match[1]);
    const sourceDate = mappedDate || inferRhelmDocumentDate(
      documentText,
      `RHELM 附件 ${persona}/${filename}`,
    );
    sources.push({
      sourceId: `attachment:${filename}`,
      sourceType: "attachment",
      sourceDate,
      sourceFile: filename,
      title: `Attachment ${filename}`,
      documentText,
      dateProvenance: mappedDate ? "matching-email-prefix" : "document-content",
    });
  }
  return sources;
}

function expandExternalSources(sources, chunking) {
  return sources.flatMap((source) => {
    const chunks = chunkRhelmExternalText(source.documentText, chunking);
    if (!chunks.length) throw new Error(`RHELM 外部来源内容为空：${source.sourceFile}。`);
    return chunks.map((chunk) => ({
      ...source,
      documentText: undefined,
      content: chunk.content,
      chunkOrdinal: chunk.ordinal,
      chunkCount: chunks.length,
      startToken: chunk.startToken,
      endToken: chunk.endToken,
    }));
  });
}

export function loadRhelmDataset(datasetRoot, { chunkSize = 500, chunkOverlap = 50 } = {}) {
  const normalizedRoot = path.resolve(clean(datasetRoot));
  const qaDirectory = path.join(normalizedRoot, "QA_final");
  if (!fs.existsSync(qaDirectory)) throw new Error(`RHELM 缺少 QA_final：${qaDirectory}`);
  const personas = [];
  for (const qaPath of sortedFiles(qaDirectory)) {
    const persona = rhelmPersonaFromQaFilename(qaPath);
    const questions = loadPersonaQuestions(normalizedRoot, persona, qaPath);
    const conversationSources = loadConversationSources(normalizedRoot, persona);
    const emails = emailDateMaps(normalizedRoot, persona);
    const attachmentSources = loadAttachmentSources(normalizedRoot, persona, emails.byPrefix);
    const sources = [
      ...conversationSources,
      ...expandExternalSources([...emails.sources, ...attachmentSources], {
        size: chunkSize,
        overlap: chunkOverlap,
      }),
    ].sort((left, right) => (
      left.sourceDate - right.sourceDate
      || left.sourceId.localeCompare(right.sourceId)
      || left.chunkOrdinal - right.chunkOrdinal
    ));
    const availableSourceIds = new Set(sources.map((source) => source.sourceId));
    for (const question of questions) {
      question.futureEvidenceSourceIds = [];
      for (const sourceId of question.evidenceSourceIds) {
        if (!availableSourceIds.has(sourceId)) {
          throw new Error(`RHELM ${persona}/${question.id} 的证据不存在：${sourceId}。`);
        }
        const earliest = sources.find((source) => source.sourceId === sourceId)?.sourceDate;
        if (earliest && earliest > question.questionDate) {
          question.futureEvidenceSourceIds.push(sourceId);
        }
      }
      question.temporallyValid = question.futureEvidenceSourceIds.length === 0;
    }
    personas.push({ persona, qaPath, questions, sources });
  }
  if (!personas.length) throw new Error("RHELM 没有 QA 文件。");
  return {
    datasetRoot: normalizedRoot,
    chunking: {
      unit: "whitespace-token",
      size: Math.max(1, Math.trunc(Number(chunkSize) || 500)),
      overlap: Math.max(0, Math.trunc(Number(chunkOverlap) || 0)),
      version: RHELM_CHUNKING_VERSION,
      officialTokenizerClaimed: false,
    },
    personas,
  };
}

export function rhelmAgentId(persona, datasetSha256 = "") {
  return `rhelm-${stableHash(`${datasetSha256}\0${persona}`).slice(0, 24)}`;
}

export function rhelmMemoryId(persona, source, datasetSha256 = "") {
  return `rhelm-${stableHash(`${datasetSha256}\0${persona}\0${source.sourceId}\0${source.chunkOrdinal}`).slice(0, 32)}`;
}

export function buildRhelmSourceMemory({ persona, source, datasetSha256 = "" } = {}) {
  if (!persona || !source) throw new Error("构造 RHELM 记忆需要 persona 和 source。 ");
  const dateText = source.sourceDate.toISOString().slice(0, 10);
  return {
    id: rhelmMemoryId(persona, source, datasetSha256),
    agentId: rhelmAgentId(persona, datasetSha256),
    kind: "event",
    layer: "episodic",
    title: source.title,
    content: source.content,
    subjectRole: "shared",
    subjectKey: "shared",
    reality: "fictional",
    evidenceMode: "imported",
    temporalState: "historical",
    eventDate: dateText,
    eventStart: source.sourceDate.toISOString(),
    knownAt: source.sourceDate.toISOString(),
    recordedAt: source.sourceDate.toISOString(),
    confidence: 1,
    importance: 0.5,
    metadata: {
      benchmark: "RHELM",
      sourceId: source.sourceId,
      sourceType: source.sourceType,
      sourceFile: source.sourceFile,
      chunkOrdinal: source.chunkOrdinal,
      chunkCount: source.chunkCount,
      dateProvenance: source.dateProvenance || "source-timestamp",
      formatVersion: RHELM_MEMORY_FORMAT_VERSION,
    },
  };
}

export function createRhelmPersonaPlan(personaData, datasetSha256 = "") {
  const memories = personaData.sources.map((source) => buildRhelmSourceMemory({
    persona: personaData.persona,
    source,
    datasetSha256,
  }));
  return {
    persona: personaData.persona,
    agentId: rhelmAgentId(personaData.persona, datasetSha256),
    questions: personaData.questions,
    sources: personaData.sources,
    memories,
    memoryIdToSourceId: new Map(memories.map((memory, index) => (
      [memory.id, personaData.sources[index].sourceId]
    ))),
    memoryIdToSourceDate: new Map(memories.map((memory, index) => (
      [memory.id, personaData.sources[index].sourceDate]
    ))),
  };
}
