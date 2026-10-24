import { createHash } from "node:crypto";
import fs from "node:fs";

/**
 * ZH-4O is published by the MOOM project. The conversations are role-play
 * transcripts and deliberately do not contain trustworthy calendar
 * timestamps, so this adapter records only a deterministic internal order.
 */
export const ZH4O_CONTRACT_VERSION = "zh4o-moom-official-source-v2";
export const ZH4O_SOURCE_URL = "https://github.com/cows21/MOOM-Roleplay-Dialogue";

const SESSION_PATTERN = /^session_(\d+)$/u;
const CHOICE_PATTERN = /^[A-D]$/u;

function clean(value) {
  return String(value ?? "").trim();
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
}

function stableHash(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function syntheticSequenceDate(sampleOrdinal, sessionOrdinal) {
  // This is not a claimed event date.  It exists solely because the memory
  // protocol requires a stable orderable timestamp for undated source turns.
  return new Date(Date.UTC(2000, 0, 1 + sampleOrdinal * 400 + sessionOrdinal, 12, 0, 0, 0));
}

function normalizeTurn(turn, label, speakers) {
  assertObject(turn, label);
  const speaker = clean(turn.speaker);
  const dialogueId = clean(turn.dia_id);
  const text = clean(turn.text);
  if (!speakers.has(speaker)) throw new Error(`${label}.speaker is not a conversation participant.`);
  if (!dialogueId) throw new Error(`${label}.dia_id must not be empty.`);
  if (!text) throw new Error(`${label}.text must not be empty.`);
  return { speaker, dialogueId, text };
}

function normalizeEvidence(value, label, dialogueIds) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(label + ".evidence must be an array when present.");
  const evidenceDialogueIds = [...new Set(value.map(clean).filter(Boolean))];
  for (const dialogueId of evidenceDialogueIds) {
    if (!dialogueIds.has(dialogueId)) {
      throw new Error(label + ".evidence references unknown dia_id " + dialogueId + ".");
    }
  }
  return evidenceDialogueIds;
}

function normalizeQuestion(question, label, sampleId, ordinal, dialogueIds) {
  assertObject(question, label);
  const text = clean(question.question);
  const answer = clean(question.answer).toUpperCase();
  const categoryNumber = Number(question.category);
  const category = Number.isInteger(categoryNumber) && categoryNumber > 0
    ? categoryNumber
    : null;
  if (!text) throw new Error(`${label}.question must not be empty.`);
  return {
    questionId: `zh4o-${stableHash(`${sampleId}\0${ordinal}\0${text}`).slice(0, 24)}`,
    ordinal,
    category,
    question: text,
    answer,
    answerFormat: CHOICE_PATTERN.test(answer) ? "choice" : "non-choice",
    evidenceDialogueIds: normalizeEvidence(question.evidence, label, dialogueIds),
  };
}

function normalizeConversation(entry, sampleOrdinal) {
  const label = `ZH-4O[${sampleOrdinal}]`;
  assertObject(entry, label);
  const sampleId = clean(entry.sample_id);
  if (!sampleId) throw new Error(`${label}.sample_id must not be empty.`);
  assertObject(entry.conversation, `${label}.conversation`);
  const speakerA = clean(entry.conversation.speaker_a);
  const speakerB = clean(entry.conversation.speaker_b);
  if (!speakerA || !speakerB || speakerA === speakerB) {
    throw new Error(`${label}.conversation must contain two distinct speakers.`);
  }
  const speakers = new Set([speakerA, speakerB]);
  const sourceSessions = Object.entries(entry.conversation)
    .map(([key, value]) => {
      const match = SESSION_PATTERN.exec(key);
      return match && Array.isArray(value) ? { key, ordinal: Number(match[1]), turns: value } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (!sourceSessions.length) throw new Error(`${label}.conversation has no sessions.`);

  const dialogueIds = new Set();
  const sessions = sourceSessions.map((session) => {
    if (!session.turns.length) throw new Error(`${label}.conversation.${session.key} must not be empty.`);
    const turns = session.turns.map((turn, turnOrdinal) => normalizeTurn(
      turn,
      `${label}.conversation.${session.key}[${turnOrdinal}]`,
      speakers,
    ));
    for (const turn of turns) {
      if (dialogueIds.has(turn.dialogueId)) throw new Error(`${label} repeats dia_id ${turn.dialogueId}.`);
      dialogueIds.add(turn.dialogueId);
    }
    const sourceDateText = clean(entry.conversation[`${session.key}_date_time`]);
    return {
      sessionId: session.key,
      ordinal: session.ordinal,
      sourceDateText,
      hasSourceDate: Boolean(sourceDateText),
      // The public ZH-4O release leaves these date fields blank.  Do not
      // mistake this stable sequence time for an asserted real-world date.
      sequenceDate: syntheticSequenceDate(sampleOrdinal, session.ordinal),
      turns,
    };
  });

  if (!Array.isArray(entry.qa) || !entry.qa.length) throw new Error(`${label}.qa must be a non-empty array.`);
  const questions = entry.qa.map((question, questionOrdinal) => normalizeQuestion(
    question,
    `${label}.qa[${questionOrdinal}]`,
    sampleId,
    questionOrdinal,
    dialogueIds,
  ));
  const finalSession = sessions.at(-1);
  const questionDate = new Date(finalSession.sequenceDate.getTime() + finalSession.turns.length + 1);
  return {
    sampleId,
    speakerA,
    speakerB,
    sessions,
    questions,
    questionDate,
  };
}

export function zh4oDatasetSha256(datasetPath) {
  return createHash("sha256").update(fs.readFileSync(datasetPath)).digest("hex");
}

export function zh4oAgentId(sampleId, datasetSha256 = "") {
  return `zh4o-${stableHash(`${datasetSha256}\0${sampleId}`).slice(0, 24)}`;
}

export function validateZh4oDataset(value) {
  if (!Array.isArray(value)) throw new Error("ZH-4O dataset root must be an array.");
  if (!value.length) throw new Error("ZH-4O dataset must not be empty.");
  const sampleIds = new Set();
  return value.map((entry, index) => {
    const normalized = normalizeConversation(entry, index);
    if (sampleIds.has(normalized.sampleId)) throw new Error(`ZH-4O repeats sample_id ${normalized.sampleId}.`);
    sampleIds.add(normalized.sampleId);
    return normalized;
  });
}

export function loadZh4oDataset(datasetPath) {
  const raw = fs.readFileSync(datasetPath, "utf8").replace(/^\uFEFF/u, "");
  try {
    return validateZh4oDataset(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`ZH-4O dataset is not valid JSON: ${error.message}`);
    throw error;
  }
}
