import fs from 'node:fs';

export const MEMORY_BENCHMARK_VERSION = 'suzu-memory-benchmark-v1';
const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} must be a nonempty string.`);
  return value.trim();
};
export function benchmarkInteger(value, fallback, label, minimum = 1) {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < minimum) throw new RangeError(`${label} must be an integer >= ${minimum}.`);
  return number;
}
function time(value, label) {
  const text = required(value, label);
  // A time zone prevents the machine's local zone from changing the protocol.
  if (!/T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new TypeError(`${label} must be an ISO timestamp with a time zone.`);
  }
  return new Date(text).toISOString();
}
function unique(items, label) {
  if (new Set(items.map(item => item.id)).size !== items.length) throw new Error(`Duplicate ${label} id.`);
}
function message(value, label, recordedAt) {
  if (value == null) return undefined;
  return { text: required(value.text, `${label}.text`),
    occurredAt: time(value.occurredAt ?? recordedAt, `${label}.occurredAt`),
    knownAt: time(value.knownAt ?? value.occurredAt ?? recordedAt, `${label}.knownAt`) };
}

/** Only the explicitly selected conversation fields reach the ingestion adapter. */
export function normalizeMemoryBenchmarkDataset(input) {
  if (input?.version !== 1 || !Array.isArray(input.samples) || !input.samples.length) {
    throw new TypeError('Dataset requires version: 1 and nonempty samples.');
  }
  const samples = input.samples.map(sample => {
    const id = required(sample.id, 'sample.id');
    const identity = Object.fromEntries(['primaryUserId', 'primaryUserName', 'companionId', 'companionName']
      .map(key => [key, required(sample.identity?.[key], `${id}.identity.${key}`)]));
    if (identity.primaryUserId === identity.companionId) throw new Error(`${id}: participant ids must differ.`);
    const world = { id: required(sample.world?.id ?? 'relationship', 'world.id'),
      frame: required(sample.world?.frame ?? 'relational', 'world.frame') };
    if (!Array.isArray(sample.turns) || !Array.isArray(sample.questions) || !sample.questions.length) {
      throw new TypeError(`${id}: turns and nonempty questions are required.`);
    }
    let previousTime = -Infinity;
    const turnKeys = new Set();
    const turns = sample.turns.map((turn, index) => {
      const recordedAt = time(turn.recordedAt, `${id}.turns[${index}].recordedAt`);
      if (Date.parse(recordedAt) < previousTime) throw new Error(`${id}: turns must be chronological.`);
      previousTime = Date.parse(recordedAt);
      const sessionId = required(turn.sessionId ?? id, 'turn.sessionId');
      const turnId = required(turn.turnId ?? String(index + 1), 'turn.turnId');
      const key = JSON.stringify([sessionId, turnId]);
      if (turnKeys.has(key)) throw new Error(`${id}: duplicate turn within a session.`);
      turnKeys.add(key);
      const userMessage = message(turn.userMessage, 'userMessage', recordedAt);
      const assistantMessage = message(turn.assistantMessage, 'assistantMessage', recordedAt);
      if (!userMessage && !assistantMessage) throw new Error(`${id}: turn has no messages.`);
      for (const item of [userMessage, assistantMessage].filter(Boolean)) {
        if (Date.parse(item.occurredAt) > previousTime || Date.parse(item.knownAt) > previousTime) {
          throw new Error(`${id}: message time is later than its recordedAt.`);
        }
      }
      return { sessionId, turnId, recordedAt, userMessage, assistantMessage, world };
    });
    const questions = sample.questions.map(question => {
      const cutoff = benchmarkInteger(question.cutoff, turns.length, 'question.cutoff', 0);
      if (cutoff > turns.length) throw new Error(`${id}: cutoff exceeds the available turns.`);
      const now = time(question.now, 'question.now');
      if (cutoff && Date.parse(turns[cutoff - 1].recordedAt) > Date.parse(now)) {
        throw new Error(`${id}: question history contains future messages.`);
      }
      return { id: required(question.id, 'question.id'), question: required(question.question, 'question.question'),
        cutoff, now, reference: structuredClone(question.reference ?? null), category: question.category ?? null };
    });
    unique(questions, 'question');
    return { id, identity, world, turns, questions };
  });
  unique(samples, 'sample');
  return { version: 1, name: required(input.name, 'dataset.name'),
    answerInstruction: typeof input.answerInstruction === 'string' ? input.answerInstruction.trim() : '', samples };
}

export function loadMemoryBenchmarkDataset(file) {
  return normalizeMemoryBenchmarkDataset(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')));
}

export function gradeExactBenchmarkAnswer({ answer, reference }) {
  const alternatives = Array.isArray(reference) ? reference : [reference];
  if (!alternatives.length || alternatives.some(item => typeof item !== 'string')) {
    throw new TypeError('Exact grading requires a string reference or an array of accepted strings.');
  }
  const normalize = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  return { correct: alternatives.some(item => normalize(item) === normalize(answer)) };
}
