import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createMemoryServiceFromConfig, loadMemoryConfig, normalizeMemoryConfig, validateMemoryProviderConfig } from "@suzu-memory/config";
import { createChatHostMemoryAdapter, buildConversationTurnEvents } from "@suzu-memory/host-adapter";
import { calculateCost } from "@suzu-memory/usage-ledger";
import { readEvaluationCodeRevision, evaluationPreparationKey } from './code-revision.mjs';
import { questionFailure, runQuestionOperation, mergeUsageSummaries } from './zh4o-execution.mjs';


import {
  ZH4O_CONTRACT_VERSION,
  loadZh4oDataset,
  zh4oAgentId,
  zh4oDatasetSha256,
} from "./zh4o-contract.mjs";
import {
  benchmarkPercentile as percentile,
  boundedBenchmarkInteger as boundedInteger,
  captureBenchmarkEmbeddingUsage as captureEmbeddingUsage,
  cleanBenchmarkValue as clean,
  createEmbeddingRequestGate,
  meanBenchmarkValues as mean,
  summarizeBenchmarkEmbeddingUsage as summarizeEmbeddingUsage,
} from "./retrieval-benchmark-utils.mjs";

export const ZH4O_SYSTEM_PROTOCOL_VERSION = "suzu-zh4o-memory-system-v6";
export const ZH4O_EVENT_FORMAT_VERSION = "zh4o-host-conversation-event-v2";
export const ZH4O_ANSWER_SCHEMA_NAME = "zh4o-multiple-choice-answer-v2";
export const ZH4O_ANSWER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["choice"],
  properties: {
    choice: { type: "string", enum: ["A", "B", "C", "D"] },
  },
});

function stableHash(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function copyGeneratorCapabilities(source, target) {
  for (const key of ["supportsCombinedStateAnalysis", "supportsCombinedConsolidation"]) {
    if (Object.hasOwn(source, key)) target[key] = source[key];
  }
  return target;
}

function captureGenerationUsage(generator, phase, records) {
  if (typeof generator !== "function") return null;
  const wrapped = async (request) => {
    let response;
    try { response = await generator(request); return response; }
    finally {
      records.push({ phase, schemaName: clean(request?.schemaName), failed: !response,
        model: clean(response?.model), provider: clean(response?.metadata?.provider), usage: { ...(response?.usage || {}) } });
    }
  };
  return copyGeneratorCapabilities(generator, wrapped);
}

function summarizeGenerationUsage(records, timestamp) {
  const numericUsage = {};
  let amountCny = 0;
  let unknownPrice = false;
  for (const record of records) {
    for (const [key, value] of Object.entries(record.usage || {})) {
      if (Number.isFinite(Number(value))) numericUsage[key] = (numericUsage[key] || 0) + Number(value);
    }
    const priced = calculateCost({ model: record.model, timestamp, usage: record.usage });
    if (priced.amountCny === null || record.failed) unknownPrice = true;
    else amountCny += priced.amountCny;
  }
  return {
    requests: records.length,
    failedRequests: records.filter(record => record.failed).length,
    requestUnit: "generator-invocations; provider transport retries are not separate invocations",
    byPhase: Object.fromEntries(unique(records.map((record) => record.phase)).map((phase) => [
      phase,
      records.filter((record) => record.phase === phase).length,
    ])),
    bySchema: Object.fromEntries(unique(records.map((record) => record.schemaName)).map((schema) => [
      schema,
      records.filter((record) => record.schemaName === schema).length,
    ])),
    models: unique(records.map((record) => record.model)),
    providers: unique(records.map((record) => record.provider)),
    usage: numericUsage,
    estimatedCostCny: unknownPrice ? null : amountCny,
    pricingStatus: unknownPrice ? "partly-or-fully-unknown" : records.length ? "estimated" : "not-used",
  };
}

/**
 * ZH-4O is explicitly role-play data. The core ontology represents that with
 * a fictional world frame plus a distinct role-play world id. The generated
 * sequence timestamp is an ordering device only; it must never be shown to
 * the answering model as a real-world date.
 */
export function createZh4oEventPlan(conversation, datasetSha256 = "") {
  const agentId = zh4oAgentId(conversation.sampleId, datasetSha256);
  const primaryUserId = `zh4o-user-${stableHash(conversation.sampleId).slice(0, 16)}`;
  const world = { id: "zh4o-roleplay", frame: "fictional" };
  const identity = { spaceId: agentId, primaryUserId, primaryUserName: conversation.speakerA,
    companionId: agentId, companionName: conversation.speakerB,
    defaultWorldId: world.id, defaultWorldFrame: world.frame };
  const sessions = [], events = [], eventIdToDialogueId = new Map();
  for (const session of conversation.sessions) {
    const replies = [];
    for (let index = 0; index < session.turns.length;) {
      const first = session.turns[index], selected = [first];
      if (first.speaker === conversation.speakerA && session.turns[index + 1]?.speaker === conversation.speakerB) {
        selected.push(session.turns[index + 1]);
      }
      const message = (turn, offset) => ({ id: turn.dialogueId, text: turn.text,
        occurredAt: new Date(session.sequenceDate.getTime() + index + offset).toISOString(),
        metadata: { zh4oDialogueId: turn.dialogueId, sourceSessionOrdinal: session.ordinal,
          sourceTimeKnown: false, timelineOrder: "synthetic-only" } });
      const reply = { sessionId: session.sessionId, turnId: `${session.sessionId}:${index}`,
        world, metadata: { benchmark: "ZH-4O", formatVersion: ZH4O_EVENT_FORMAT_VERSION,
          sourceTimeKnown: false, timelineOrder: "synthetic-only" },
        ...(first.speaker === conversation.speakerA ? { userMessage: message(first, 0) }
          : { assistantMessage: message(first, 0) }),
        ...(selected.length === 2 ? { assistantMessage: message(selected[1], 1) } : {}) };
      reply.recordedAt = reply.assistantMessage?.occurredAt || reply.userMessage.occurredAt;
      replies.push(reply);
      const built = buildConversationTurnEvents({ ...reply, identity, hostId: "zh4o", sourceKind: "zh4o-roleplay-conversation" });
      for (const event of built) { events.push(event); eventIdToDialogueId.set(event.eventId, event.metadata.zh4oDialogueId); }
      index += selected.length;
    }
    sessions.push({ sessionId: session.sessionId, replies });
  }
  return { agentId, primaryUserId, world, identity, sessions, events, eventIdToDialogueId };
}

export function assertZh4oEventsHaveNoGoldLabels({ conversation, plan } = {}) {
  const serialized = JSON.stringify(plan?.events || []);
  if (/"qa"\s*:|"answer"\s*:|"observation"\s*:|"session_summary"\s*:|"event_summary"\s*:/u.test(serialized)) {
    throw new Error("ZH-4O 输入事件包含题目、答案或公开评测辅助标签。");
  }
  for (const question of conversation?.questions || []) {
    if (question.question && serialized.includes(question.question)) {
      throw new Error("ZH-4O 输入事件泄漏了评测题目。");
    }
  }
  return true;
}

function internalEventDialogueMap(appendResult, eventIdToDialogueId) {
  const result = new Map();
  for (const event of appendResult?.events || []) {
    const fragmentParent = clean(event.metadata?.suzuMemoryFragment?.parentEventId);
    const externalId = clean(event.external_id);
    const dialogueId = eventIdToDialogueId.get(fragmentParent || externalId);
    if (dialogueId) result.set(event.id, dialogueId);
  }
  return result;
}

function sourceDialogueIds(detail, inputEventIdToDialogueId) {
  const dialogueIds = [];
  for (const source of detail?.sources || []) {
    const inputIds = Array.isArray(source.metadata?.inputEventIds)
      ? source.metadata.inputEventIds
      : [source.metadata?.inputEventId];
    for (const inputId of inputIds) {
      const dialogueId = inputEventIdToDialogueId.get(clean(inputId));
      if (dialogueId) dialogueIds.push(dialogueId);
    }
  }
  return unique(dialogueIds);
}

function dialogueIndex(conversation) {
  const result = new Map();
  for (const session of conversation.sessions) {
    for (const turn of session.turns) {
      result.set(turn.dialogueId, {
        ...turn,
        sessionId: session.sessionId,
        sessionOrdinal: session.ordinal,
      });
    }
  }
  return result;
}

function safeCandidateBlocks(candidateDialogueIds, candidateLimit) {
  return (Array.isArray(candidateDialogueIds) ? candidateDialogueIds : [])
    .slice(0, candidateLimit)
    .map((ids) => unique(ids))
    .filter((ids) => ids.length);
}

/**
 * ZH-4O's official MOOM harness retrieves with the serialized question as it
 * appears in the dataset, including its A/B/C/D choices. This is deliberately
 * scoped to the benchmark adapter: real host retrieval still uses the user's
 * original message. The answer key and gold evidence remain evaluation-only.
 */
export function buildZh4oRetrievalQuery(question) {
  const text = clean(typeof question === "object" ? question?.question : question);
  if (!text) throw new Error("ZH-4O 检索需要题目。");
  return text;
}

/**
 * Formats only source turns attached to recalled memories.  In particular, it
 * never passes the synthetic sequence timestamp to the answer model.
 */
export function buildZh4oRetrievedContext({
  conversation,
  dialogueById,
  candidateDialogueIds,
  candidateLimit = 10,
  maximumContextCharacters = 24_000,
} = {}) {
  const maximumCharacters = boundedInteger(maximumContextCharacters, 24_000, {
    minimum: 1_000,
    maximum: 1_000_000,
  });
  const selectedLimit = boundedInteger(candidateLimit, 10, { minimum: 1, maximum: 1_000 });
  const preamble = [
    `角色扮演对话参与者：${clean(conversation?.speakerA) || "用户"} 与 ${clean(conversation?.speakerB) || "陪伴者"}。`,
    "以下是按相关性排序的召回对话片段，可能不完整；不要把未出现的信息当作事实。",
  ].join("\n");
  const usedDialogueIds = new Set();
  const sections = [preamble];
  const candidateBlocks = [];
  let characters = preamble.length;
  let usedCandidates = 0;
  let truncated = false;
  const blocks = safeCandidateBlocks(candidateDialogueIds, selectedLimit);
  for (let index = 0; index < blocks.length; index += 1) {
    const sourceDialogueIds = blocks[index];
    if (truncated) {
      candidateBlocks.push({
        rank: index + 1,
        sourceDialogueIds,
        emittedDialogueIds: [],
        status: "not-considered-after-context-budget",
      });
      continue;
    }
    const availableTurns = sourceDialogueIds
      .map((dialogueId) => ({ dialogueId, turn: dialogueById?.get(dialogueId) }))
      .filter((item) => item.turn);
    const turns = availableTurns.filter(({ dialogueId }) => !usedDialogueIds.has(dialogueId));
    if (!turns.length) {
      candidateBlocks.push({
        rank: index + 1,
        sourceDialogueIds,
        emittedDialogueIds: [],
        status: availableTurns.length ? "duplicate-dialogue" : "source-dialogue-unavailable",
      });
      continue;
    }
    const block = [
      `[召回片段 ${index + 1}]`,
      ...turns.map(({ dialogueId, turn }) => (
        `[${dialogueId}] ${turn.speaker}：${clean(turn.text)}`
      )),
    ].join("\n");
    if (characters + block.length + 2 > maximumCharacters) {
      candidateBlocks.push({
        rank: index + 1,
        sourceDialogueIds,
        emittedDialogueIds: turns.map(({ dialogueId }) => dialogueId),
        status: "omitted-context-budget",
      });
      truncated = true;
      continue;
    }
    sections.push(block);
    characters += block.length + 2;
    usedCandidates += 1;
    for (const { dialogueId } of turns) usedDialogueIds.add(dialogueId);
    candidateBlocks.push({
      rank: index + 1,
      sourceDialogueIds,
      emittedDialogueIds: turns.map(({ dialogueId }) => dialogueId),
      status: "included",
    });
  }
  return {
    context: sections.join("\n\n"),
    candidateLimit: selectedLimit,
    rankedCandidateCount: blocks.length,
    usedCandidateCount: usedCandidates,
    usedDialogueIds: [...usedDialogueIds],
    candidateBlocks,
    contextCharacters: characters,
    contextTruncated: truncated,
  };
}

export function buildZh4oAnswerRequest({ question, context } = {}) {
  const questionText = clean(question?.question);
  if (!questionText) throw new Error("ZH-4O 作答需要题目。 ");
  return {
    systemPrompt: [
      "你正在回答一题中文角色扮演长期记忆单选题。",
      "依据提供的记忆材料回答题目；材料缺失时仍需从题目给出的选项中选择一个。",
      "题目中已经列出 A 到 D 选项。必须选择且只选择其中一个字母。",
      "不要解释、不要复述题目、不要输出思考过程。",
    ].join("\n"),
    input: [
      clean(context),
      `题目：\n${questionText}`,
    ].filter(Boolean).join("\n\n"),
    schema: ZH4O_ANSWER_SCHEMA,
    schemaName: ZH4O_ANSWER_SCHEMA_NAME,
  };
}

function normalizeChoice(value) {
  const choice = clean(value).toUpperCase();
  return /^[A-D]$/u.test(choice) ? choice : "";
}

function postHocEvidenceAudit(question, context, candidateDialogueIds = []) {
  const goldEvidenceDialogueIds = Array.isArray(question?.evidenceDialogueIds)
    ? [...question.evidenceDialogueIds]
    : [];
  const candidateRanksByDialogueId = new Map();
  for (let index = 0; index < candidateDialogueIds.length; index += 1) {
    for (const dialogueId of unique(candidateDialogueIds[index])) {
      const ranks = candidateRanksByDialogueId.get(dialogueId) || [];
      ranks.push(index + 1);
      candidateRanksByDialogueId.set(dialogueId, ranks);
    }
  }
  const contextBlocks = Array.isArray(context?.candidateBlocks) ? context.candidateBlocks : [];
  const usedDialogueIds = new Set(context?.usedDialogueIds || []);
  const fragmentSources = new Set(context?.sourceDialogueIds || []);
  const fragmentSourceGoldEvidenceDialogueIds = goldEvidenceDialogueIds.filter(id => fragmentSources.has(id));
  const candidateGoldEvidenceDialogueIds = goldEvidenceDialogueIds.filter((dialogueId) => (
    candidateRanksByDialogueId.has(dialogueId)
  ));
  const recalledGoldEvidenceDialogueIds = goldEvidenceDialogueIds.filter((dialogueId) => (
    usedDialogueIds.has(dialogueId)
  ));
  const goldEvidenceDiagnostics = goldEvidenceDialogueIds.map((dialogueId) => {
    const candidateRanks = [...(candidateRanksByDialogueId.get(dialogueId) || [])];
    const contextCandidateRanks = contextBlocks
      .filter((block) => block.status === "included" && block.emittedDialogueIds.includes(dialogueId))
      .map((block) => block.rank);
    const includedInAnswerContext = usedDialogueIds.has(dialogueId);
    return {
      dialogueId,
      candidateRanks,
      contextCandidateRanks,
      associatedWithFragment: fragmentSources.has(dialogueId),
      includedInAnswerContext,
      status: includedInAnswerContext
        ? "verbatim-in-answer-context"
        : fragmentSources.has(dialogueId)
          ? "fragment-source-without-verbatim-text"
          : candidateRanks.length
            ? "candidate-not-in-answer-context"
            : "not-in-candidate-pool",
    };
  });
  const goldEvidenceRetrievalOutcome = !goldEvidenceDialogueIds.length
    ? "unannotated"
    : recalledGoldEvidenceDialogueIds.length === goldEvidenceDialogueIds.length
      ? "all-gold-verbatim-in-answer-context"
      : recalledGoldEvidenceDialogueIds.length
        ? "partial-gold-verbatim-in-answer-context"
        : candidateGoldEvidenceDialogueIds.length
          ? "gold-in-candidate-pool-not-answer-context"
          : "gold-not-in-candidate-pool";
  return {
    goldEvidenceDialogueIds,
    candidateGoldEvidenceDialogueIds,
    fragmentSourceGoldEvidenceDialogueIds,
    recalledGoldEvidenceDialogueIds,
    candidateGoldEvidenceQuestionHit: goldEvidenceDialogueIds.length
      ? candidateGoldEvidenceDialogueIds.length > 0
      : null,
    candidateGoldEvidenceTurnRecall: goldEvidenceDialogueIds.length
      ? candidateGoldEvidenceDialogueIds.length / goldEvidenceDialogueIds.length
      : null,
    goldEvidenceQuestionHit: goldEvidenceDialogueIds.length
      ? recalledGoldEvidenceDialogueIds.length > 0
      : null,
    goldEvidenceTurnRecall: goldEvidenceDialogueIds.length
      ? recalledGoldEvidenceDialogueIds.length / goldEvidenceDialogueIds.length
      : null,
    goldEvidenceRetrievalOutcome,
    goldEvidenceDiagnostics,
  };
}

function diagnosticCandidateRows(retrieval, candidateDialogueIds, context, goldEvidenceDialogueIds) {
  const contextBlocksByRank = new Map((context?.candidateBlocks || []).map((block) => [
    Number(block.rank),
    block,
  ]));
  const goldEvidence = new Set(goldEvidenceDialogueIds || []);
  return (retrieval?.candidates || []).map((candidate, index) => {
    const rank = index + 1;
    const sourceDialogueIds = unique(candidateDialogueIds[index]);
    const contextBlock = contextBlocksByRank.get(rank) || null;
    return {
      rank,
      memoryId: clean(candidate.memoryId),
      matchedMemoryId: clean(candidate.matchedMemoryId),
      kind: clean(candidate.kind),
      retrievalLane: clean(candidate.retrievalLane),
      laneRank: Number.isFinite(Number(candidate.laneRank)) ? Number(candidate.laneRank) : null,
      admission: clean(candidate.admission),
      score: Number(candidate.score || 0),
      lexicalScore: Number(candidate.lexicalScore || 0),
      lexicalOverlap: Number(candidate.lexicalOverlap || 0),
      exactPhrase: Boolean(candidate.exactPhrase),
      bm25Score: Number(candidate.bm25Score || 0),
      bm25MatchedQueryCount: Number(candidate.bm25MatchedQueryCount || 0),
      vectorSimilarity: Number.isFinite(Number(candidate.vectorSimilarity))
        ? Number(candidate.vectorSimilarity)
        : null,
      entityScore: Number(candidate.entityScore || 0),
      routes: (candidate.routeMatches || []).map((route) => ({
        route: clean(route.route),
        strength: clean(route.strength),
        independentlyAdmissible: Boolean(route.independentlyAdmissible),
        rawScore: Number.isFinite(Number(route.rawScore)) ? Number(route.rawScore) : null,
        normalizedScore: Number.isFinite(Number(route.normalizedScore))
          ? Number(route.normalizedScore)
          : null,
      })),
      sourceDialogueIds,
      goldEvidenceDialogueIds: sourceDialogueIds.filter((dialogueId) => goldEvidence.has(dialogueId)),
      contextAssembly: contextBlock ? {
        status: clean(contextBlock.status),
        emittedDialogueIds: [...(contextBlock.emittedDialogueIds || [])],
        associatedDialogueIds: [...(contextBlock.associatedDialogueIds || [])],
      } : {
        status: "not-provided",
        emittedDialogueIds: [],
      },
    };
  });
}

function diagnosticRetrievalSnapshot(retrieval, candidateDialogueIds, context, evidenceAudit) {
  const vector = retrieval?.vector || {};
  return {
    searchedMemories: Number(retrieval?.searchedMemories || 0),
    recallIntent: clean(retrieval?.recallIntent),
    chainIntent: retrieval?.chainIntent || null,
    temporal: retrieval?.temporal || null,
    vector: {
      status: clean(vector.status) || "disabled",
      model: clean(vector.model),
      indexedMemories: Number(vector.indexedMemories || 0),
      dimensions: Number(vector.dimensions || 0),
      querySource: clean(vector.querySource),
      warning: clean(vector.warning),
    },
    bm25: {
      status: clean(retrieval?.bm25?.status),
      audit: retrieval?.bm25?.audit || {},
    },
    seedRouting: retrieval?.seedRouting || null,
    rankedCandidates: diagnosticCandidateRows(
      retrieval,
      candidateDialogueIds,
      context,
      evidenceAudit.goldEvidenceDialogueIds,
    ),
    goldEvidence: {
      outcome: evidenceAudit.goldEvidenceRetrievalOutcome,
      candidates: evidenceAudit.goldEvidenceDiagnostics,
    },
  };
}

export function summarizeZh4oRows(rows) {
  const completed = rows.filter((row) => row.status === "completed" && row.scoringEligible !== false);
  const failed = rows.filter((row) => row.status === "failed" && row.scoringEligible !== false);
  const eligible = [...completed, ...failed];
  const annotatedEvidenceRows = eligible.filter((row) => row.goldEvidenceDialogueIds?.length);
  const goldEvidenceTurns = annotatedEvidenceRows.reduce(
    (sum, row) => sum + row.goldEvidenceDialogueIds.length,
    0,
  );
  const recalledGoldEvidenceTurns = annotatedEvidenceRows.reduce(
    (sum, row) => sum + row.recalledGoldEvidenceDialogueIds.length,
    0,
  );
  const evidenceQuestionHits = annotatedEvidenceRows.reduce(
    (sum, row) => sum + Number(Boolean(row.goldEvidenceQuestionHit)),
    0,
  );
  const candidateEvidenceQuestionHits = annotatedEvidenceRows.reduce(
    (sum, row) => sum + Number(Boolean(row.candidateGoldEvidenceQuestionHit)),
    0,
  );
  const candidateGoldEvidenceTurns = annotatedEvidenceRows.reduce(
    (sum, row) => sum + (row.candidateGoldEvidenceDialogueIds?.length || 0),
    0,
  );
  const evidenceOutcomeCounts = Object.fromEntries(
    [...new Set(rows.map((row) => clean(row.goldEvidenceRetrievalOutcome) || "not-recorded"))]
      .sort()
      .map((outcome) => [
        outcome,
        rows.filter((row) => (clean(row.goldEvidenceRetrievalOutcome) || "not-recorded") === outcome).length,
      ]),
  );
  const correctWithGoldInContext = annotatedEvidenceRows.filter((row) => (
    row.goldEvidenceQuestionHit && row.correct
  )).length;
  const incorrectWithGoldInContext = annotatedEvidenceRows.filter((row) => (
    row.goldEvidenceQuestionHit && !row.correct
  )).length;
  const officialAccuracy = eligible.length
    ? completed.reduce((sum, row) => sum + Number(row.correct), 0) / eligible.length
    : null;
  const validChoiceRows = eligible.filter((row) => row.answerFormat === "choice");
  const completedChoiceRows = completed.filter((row) => row.answerFormat === "choice");
  const isCorrect = row => row.status === 'completed' && Boolean(row.correct);
  const validChoiceAccuracy = validChoiceRows.length
    ? validChoiceRows.filter(isCorrect).length / validChoiceRows.length
    : null;
  const byCategory = Object.fromEntries([...new Set(validChoiceRows.map((row) => row.category))]
    .sort((left, right) => left - right)
    .map((category) => {
      const selected = validChoiceRows.filter((row) => row.category === category);
      const categoryAccuracy = selected.length
        ? selected.filter(isCorrect).length / selected.length
        : null;
      return [category, {
        questions: selected.length,
        correct: selected.filter(isCorrect).length,
        failures: selected.filter(row => row.status === 'failed').length,
        exactChoiceAccuracy: categoryAccuracy,
        exactChoiceAccuracyPercent: categoryAccuracy === null ? null : categoryAccuracy * 100,
      }];
    }));
  return {
    attempted: rows.length,
    completed: completed.length,
    failures: failed.length,
    eligibleQuestions: eligible.length,
    failureRate: eligible.length ? failed.length / eligible.length : null,
    excluded: rows.filter(row => row.status === "excluded" || row.scoringEligible === false).length,
    correct: completed.reduce((sum, row) => sum + Number(row.correct), 0),
    officialDatasetAccuracy: officialAccuracy,
    officialDatasetAccuracyPercent: officialAccuracy === null ? null : officialAccuracy * 100,
    validChoiceQuestions: validChoiceRows.length,
    validChoiceCorrect: validChoiceRows.filter(isCorrect).length,
    validChoiceCompletedQuestions: completedChoiceRows.length,
    validChoiceFailures: validChoiceRows.filter(row => row.status === 'failed').length,
    completedChoiceAccuracy: completedChoiceRows.length
      ? completedChoiceRows.filter(isCorrect).length / completedChoiceRows.length : null,
    exactChoiceAccuracy: validChoiceAccuracy,
    exactChoiceAccuracyPercent: validChoiceAccuracy === null ? null : validChoiceAccuracy * 100,
    byCategory,
    context: {
      meanCharacters: completed.length
        ? mean(completed.map((row) => Number(row.context?.contextCharacters || 0)))
        : null,
      truncated: completed.filter((row) => row.context?.contextTruncated).length,
      empty: completed.filter((row) => !row.context?.recallCharacters).length,
    },
    evidenceAudit: {
      policy: "verbatim source-text presence in the emitted recall; not a measure of semantic summary coverage",
      annotatedQuestions: annotatedEvidenceRows.length,
      fragmentSourceQuestionHits: annotatedEvidenceRows.filter(row => row.fragmentSourceGoldEvidenceDialogueIds?.length).length,
      fragmentSourceGoldEvidenceTurns: annotatedEvidenceRows.reduce((sum, row) => sum + (row.fragmentSourceGoldEvidenceDialogueIds?.length || 0), 0),
      candidatePoolQuestionHits: candidateEvidenceQuestionHits,
      candidatePoolQuestionHitRate: annotatedEvidenceRows.length
        ? candidateEvidenceQuestionHits / annotatedEvidenceRows.length
        : null,
      questionHits: evidenceQuestionHits,
      questionHitRate: annotatedEvidenceRows.length
        ? evidenceQuestionHits / annotatedEvidenceRows.length
        : null,
      goldEvidenceTurns,
      candidatePoolGoldEvidenceTurns: candidateGoldEvidenceTurns,
      candidatePoolTurnRecall: goldEvidenceTurns
        ? candidateGoldEvidenceTurns / goldEvidenceTurns
        : null,
      recalledGoldEvidenceTurns,
      turnRecall: goldEvidenceTurns
        ? recalledGoldEvidenceTurns / goldEvidenceTurns
        : null,
      contextAssemblyLossQuestions: annotatedEvidenceRows.filter((row) => (
        row.goldEvidenceRetrievalOutcome === "gold-in-candidate-pool-not-answer-context"
      )).length,
      outcomes: evidenceOutcomeCounts,
      answerCorrectWithGoldInContext: correctWithGoldInContext,
      answerIncorrectWithGoldInContext: incorrectWithGoldInContext,
    },
  };
}

function nonFatalStageError(error) {
  return questionFailure(error);
}


function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
  return value;
}

export function summarizeZh4oControls(results, mode) {
  const paired = results.filter(row => row.scoringEligible && row.status === "completed"
    && row.control?.status === "completed" && row.answerFormat === "choice");
  return { mode, pairedQuestions: paired.length,
    failedQuestions: results.filter(row => row.scoringEligible && row.control?.status === 'failed').length,
    memoryAccuracy: paired.length ? mean(paired.map(row => Number(row.correct))) : null,
    noMemoryAccuracy: paired.length ? mean(paired.map(row => Number(row.control.correct))) : null,
    memoryOnlyCorrect: paired.filter(row => row.correct && !row.control.correct).length,
    controlOnlyCorrect: paired.filter(row => !row.correct && row.control.correct).length };
}

function inputRows(service) {
  const rows = [];
  for (let offset = 0;; offset += 500) {
    const page = service.listInputEvents({ statuses: [], offset, limit: 500 });
    rows.push(...page.items);
    if (offset + page.items.length >= page.total || !page.items.length) return rows;
  }
}

function materializedContext(retrieval, dialogueIdsFor, dialogueById) {
  const context = String(retrieval.context || "");
  const recallText = (retrieval.fragments || []).map(fragment => String(fragment.text || ""))
    .filter(text => text && context.includes(text)).join("\n");
  const ids = new Set((retrieval.fragments || []).flatMap(fragment => [
    fragment.memoryId, ...(fragment.memoryIds || []), ...(fragment.evidenceIds || []),
  ]).filter(Boolean));
  const sourceDialogueIds = unique([...ids].flatMap(dialogueIdsFor));
  const usedDialogueIds = sourceDialogueIds.filter(id => {
    const text = dialogueById.get(id)?.text;
    return text && recallText.includes(text);
  });
  const visible = new Set(usedDialogueIds);
  const candidateBlocks = (retrieval.candidates || []).map((candidate, index) => {
    const associatedDialogueIds = ids.has(candidate.memoryId) ? dialogueIdsFor(candidate.memoryId) : [];
    const emittedDialogueIds = associatedDialogueIds.filter(id => visible.has(id));
    return { rank: index + 1, status: emittedDialogueIds.length ? "included"
      : associatedDialogueIds.length ? "fragment-source-only" : "not-materialized",
      associatedDialogueIds, emittedDialogueIds };
  });
  const budget = retrieval.trace?.metadata?.outputBudget;
  return { context, contextCharacters: context.length, recallCharacters: recallText.length,
    contextTruncated: Boolean(budget?.sectionTruncationApplied || budget?.safetyTruncationApplied),
    usedDialogueIds, sourceDialogueIds, candidateBlocks,
    provenancePolicy: "sourceDialogueIds are fragment associations; usedDialogueIds require full verbatim source text in the emitted recall" };
}

function embeddingIndexIdentity(provider) {
  if (!provider) return null;
  const { type, baseUrl, model, dimensions, extraBody, extraHeaders } = provider;
  return { model, dimensions, requestConfigSha256: stableHash(JSON.stringify({
    type, baseUrl, endpoint: provider.endpoint || 'embeddings', model, dimensions, extraBody, extraHeaders,
  })) };
}

/** Replay through the configured public service and host lifecycle. No QA labels enter ingestion. */
export async function runZh4oMemorySystemBenchmark({
  datasetPath, workDirectory, config, environment = process.env, fetchImpl = globalThis.fetch,
  startSample = 0, maximumSamples = Number.MAX_SAFE_INTEGER, maximumQuestionsPerSample = Number.MAX_SAFE_INTEGER,
  candidateK, maximumContextCharacters, maximumDrainPasses = 1000, embeddingRequestIntervalMs = 0,
  withoutEmbedding = false, retrievalOnly = false, control = "no-memory", includeSourceDiagnostics = false,
  codeRevision = readEvaluationCodeRevision(), onProgress = null, onCheckpoint = null, resumeReport = null,
} = {}) {
  if (!config) throw new Error("ZH-4O requires the real Memory config.");
  const normalizedConfig = typeof config === "string" ? loadMemoryConfig(config) : normalizeMemoryConfig(config);
  validateMemoryProviderConfig(normalizedConfig, { environment, requireGeneration: true, embedding: !withoutEmbedding });
  if (!datasetPath || !fs.existsSync(datasetPath)) throw new Error("ZH-4O dataset does not exist.");
  if (!workDirectory) throw new Error("ZH-4O requires a dedicated work directory.");
  if (!["no-memory", "none"].includes(control)) throw new Error("control must be no-memory or none.");
  positiveInteger(maximumDrainPasses, "maximumDrainPasses");
  if (candidateK !== undefined) positiveInteger(candidateK, "candidateK");
  if (maximumContextCharacters !== undefined) positiveInteger(maximumContextCharacters, "maximumContextCharacters");
  const allSamples = loadZh4oDataset(datasetPath), datasetSha256 = zh4oDatasetSha256(datasetPath);
  const selectedStart = Number(startSample);
  if (!Number.isSafeInteger(selectedStart) || selectedStart < 0) throw new Error("Invalid sample start.");
  positiveInteger(maximumSamples, "maximumSamples"); positiveInteger(maximumQuestionsPerSample, "maximumQuestionsPerSample");
  const selectedSamples = allSamples.slice(selectedStart, selectedStart + maximumSamples);
  if (!selectedSamples.length) throw new Error("No samples selected.");
  const work = path.resolve(workDirectory);
  const preparation = { configSha256: stableHash(JSON.stringify(normalizedConfig)),
    codeRevision: { ...codeRevision }, withoutEmbedding: Boolean(withoutEmbedding) };
  evaluationPreparationKey(preparation);
  const questionsById = new Map(selectedSamples.flatMap(sample => sample.questions.slice(0, maximumQuestionsPerSample)
    .map(question => [question.questionId, { ...question, sampleId: sample.sampleId }])));
  const identity = stableHash(JSON.stringify({ datasetSha256, work, preparation, retrievalOnly, control,
    candidateK, maximumContextCharacters, maximumDrainPasses, embeddingRequestIntervalMs, includeSourceDiagnostics,
    questions: [...questionsById.keys()] }));
  if (resumeReport && (resumeReport.protocol?.version !== ZH4O_SYSTEM_PROTOCOL_VERSION
    || resumeReport.run?.identity !== identity || !Array.isArray(resumeReport.results) || !Array.isArray(resumeReport.samples))) {
    throw new Error('Checkpoint does not match this dataset, selection, work directory, configuration or code.');
  }
  const previousSamples = new Map();
  const previousQuestions = new Set();
  for (const sample of resumeReport?.samples || []) {
    if (!selectedSamples.some(selected => selected.sampleId === sample.sampleId) || previousSamples.has(sample.sampleId)) {
      throw new Error('Checkpoint has unknown or duplicate samples.');
    }
    evaluationPreparationKey(sample.preparation);
    previousSamples.set(sample.sampleId, structuredClone(sample));
  }
  for (const row of resumeReport?.results || []) {
    const question = questionsById.get(row.questionId);
    if (!question || row.sampleId !== question.sampleId || !previousSamples.has(row.sampleId)
      || previousQuestions.has(row.questionId) || !['completed', 'failed', 'excluded'].includes(row.status)
      || row.answerFormat !== question.answerFormat || row.expectedChoice !== question.answer || row.category !== question.category
      || row.scoringEligible !== (row.status !== 'excluded' && !previousSamples.get(row.sampleId).memorySystemDegraded)
      || (row.status === 'completed' && (!normalizeChoice(row.prediction) || row.correct !== (row.prediction === question.answer)))
      || (row.control?.status === 'completed' && (!normalizeChoice(row.control.prediction)
        || row.control.correct !== (row.control.prediction === question.answer)))) {
      throw new Error('Checkpoint has invalid or duplicate question results.');
    }
    previousQuestions.add(row.questionId);
  }
  const preparedSamples = selectedSamples.map(conversation => {
    const plan = createZh4oEventPlan(conversation, datasetSha256);
    assertZh4oEventsHaveNoGoldLabels({ conversation, plan });
    const sampleRoot = path.join(work, "samples", plan.agentId), manifestPath = path.join(sampleRoot, "benchmark.json");
    const reuse = retrievalOnly || Boolean(resumeReport && fs.existsSync(manifestPath));
    const service = createMemoryServiceFromConfig(normalizedConfig, { environment, fetchImpl,
      overrides: { dataRoot: sampleRoot, agentId: plan.agentId, readOnly: reuse,
        defaults: { memoryOwner: conversation.speakerB, userName: conversation.speakerA,
          primaryUserId: plan.primaryUserId, companionId: plan.agentId } } });
    let saved = null;
    if (reuse) {
      if (!fs.existsSync(service.paths.databasePath) || !fs.existsSync(manifestPath)) throw new Error("No retained sample database/manifest; import the sample first.");
      saved = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (saved.protocol !== ZH4O_SYSTEM_PROTOCOL_VERSION || saved.datasetSha256 !== datasetSha256 || saved.sampleId !== conversation.sampleId) {
        throw new Error("Retained database does not match this dataset and evaluation protocol.");
      }
      evaluationPreparationKey(saved.preparation);
      if (previousSamples.has(conversation.sampleId)
        && (evaluationPreparationKey(previousSamples.get(conversation.sampleId).preparation) !== evaluationPreparationKey(saved.preparation)
          || previousSamples.get(conversation.sampleId).databasePath !== service.paths.databasePath
          || (saved.degraded && !previousSamples.get(conversation.sampleId).memorySystemDegraded))) {
        throw new Error('Checkpoint memory preparation differs from the retained database.');
      }
      if (!withoutEmbedding && JSON.stringify(saved.embedding) !== JSON.stringify(embeddingIndexIdentity(normalizedConfig.providers.embedding))) {
        throw new Error("Retained embedding configuration differs; retrieval-only cannot rebuild the index.");
      }
    } else if (previousSamples.has(conversation.sampleId) || fs.existsSync(service.paths.databasePath) || fs.existsSync(manifestPath)) {
      throw new Error("Sample database exists; use a new work directory or --retrieval-only.");
    }
    return { conversation, plan, sampleRoot, manifestPath, service, saved, reuse };
  });
  fs.mkdirSync(work, { recursive: true });
  const startedAt = resumeReport?.run.startedAt || new Date().toISOString(), started = performance.now();
  const results = structuredClone(resumeReport?.results || []), samples = [...previousSamples.values()];
  const generationUsageRecords = [], embeddingUsageRecords = [];
  const embeddingGate = createEmbeddingRequestGate(embeddingRequestIntervalMs);
  const retryDelayMs = Math.max(0, Number(normalizedConfig.providers.generation.transportRetryDelayMs ?? 500));
  let abort = null, failureStreak = { key: '', count: 0 };
  function reportSnapshot(running = false) {
    const scoredRows = results.filter(row => row.scoringEligible && row.status === 'completed');
    const finishedAt = new Date().toISOString();
    const degradedSamples = samples.filter(sample => sample.memorySystemDegraded).length;
    const failedQuestions = results.filter(row => row.status === 'failed').length;
    return { status: abort ? 'aborted' : running ? 'running' : degradedSamples ? 'incomplete'
      : failedQuestions ? 'completed-with-failures' : 'completed',
      protocol: { name: 'ZH-4O configured host lifecycle', version: ZH4O_SYSTEM_PROTOCOL_VERSION,
        contractVersion: ZH4O_CONTRACT_VERSION, qaEvaluated: true, task: 'memory-system-e2e-multiple-choice',
        sourceDataIngested: 'roleplay-conversation-only', messageRolesIngested: ['user', 'assistant'],
        excludedDatasetFields: ['observation', 'session_summary', 'event_summary', 'qa.answer', 'qa.evidence'],
        answerContext: 'beforeReply.memoryContext.content', recallReadOnly: true,
        sourceReplayPolicy: 'diagnostic-only', scheduling: 'configured-character-threshold-plus-following-round; session-end-flush',
        evidencePolicy: 'post-hoc fragment-source associations and verified verbatim source text in the emitted recall; semantic summary coverage is not inferred',
        qualityScorePolicy: 'A-D gold only; question failures count as incorrect; malformed gold retained in the reference all-gold metric',
        questionFailurePolicy: 'count provider transport attempts toward an evaluator retry budget of three; retain failed questions; abort on fatal or three consecutive same-stage infrastructure failures',
        comparisonNotice: "Provider/config-specific host replay; not a reproduction of a paper's model settings or a measurement of interactive chat latency.",
        degradedSamplePolicy: 'memory-preparation-failures-excluded-from-all-quality-scores' },
      dataset: { path: path.resolve(datasetPath), sha256: datasetSha256, totalSamples: allSamples.length,
        selectedStart, selectedSamples: selectedSamples.length, selectedQuestions: questionsById.size,
        selectedNonChoiceGoldQuestions: [...questionsById.values()].filter(question => question.answerFormat !== 'choice').length },
      database: { workDirectory: work, retention: 'sample-databases-retained', sampleDatabases: samples.map(sample => sample.databasePath) },
      run: { identity, codeRevision, startedAt, finishedAt, durationMs: Number(resumeReport?.run.durationMs || 0) + performance.now() - started,
        retrievalOnly, overrides: { candidateK, maximumContextCharacters, withoutEmbedding },
        control, maximumDrainPasses, configSha256: preparation.configSha256,
        resumptions: Number(resumeReport?.run.resumptions || 0) + Number(Boolean(resumeReport)), abort,
        embeddingEnabled: !withoutEmbedding && Boolean(normalizedConfig.providers.embedding),
        generationUsage: mergeUsageSummaries(resumeReport?.run.generationUsage, summarizeGenerationUsage(generationUsageRecords, finishedAt)),
        embeddingUsage: mergeUsageSummaries(resumeReport?.run.embeddingUsage, summarizeEmbeddingUsage(embeddingUsageRecords, finishedAt)) },
      scores: summarizeZh4oRows(results), controls: summarizeZh4oControls(results, control),
      diagnostics: { degradedSamples, failedQuestions, notRunQuestions: questionsById.size - results.length,
        meanLatencyMs: mean(scoredRows.map(row => row.latencyMs)),
        p50LatencyMs: percentile(scoredRows.map(row => row.latencyMs), 0.5),
        p95LatencyMs: percentile(scoredRows.map(row => row.latencyMs), 0.95) },
      samples: structuredClone(samples), results: structuredClone(results) };
  }
  const checkpoint = async () => { if (onCheckpoint) await onCheckpoint(reportSnapshot(true)); };
  for (const { conversation, plan, sampleRoot, manifestPath, service, saved, reuse } of preparedSamples) {
    if (abort) break;
    const questions = conversation.questions.slice(0, maximumQuestionsPerSample);
    if (questions.every(question => previousQuestions.has(question.questionId))) continue;
    let phase = "memory";
    const configured = service.providers;
    service.providers = Object.freeze({
      ...configured,
      generator: captureGenerationUsage(configured.generator, "memory", generationUsageRecords),
      structureGenerator: captureGenerationUsage(configured.structureGenerator, "structure", generationUsageRecords),
      retrievalContextGenerator: captureGenerationUsage(configured.retrievalContextGenerator, "retrieval-context", generationUsageRecords),
      embedding: withoutEmbedding ? null : captureEmbeddingUsage(configured.embedding, () => phase, embeddingUsageRecords, embeddingGate),
    });
    const answer = captureGenerationUsage(configured.generator, "answer", generationUsageRecords);
    const controlAnswer = captureGenerationUsage(configured.generator, "control", generationUsageRecords);
    const adapter = createChatHostMemoryAdapter({ memory: service, hostId: "zh4o", identity: plan.identity,
      sourceKind: "zh4o-roleplay-conversation", archiveMode: "length" });
    const sample = previousSamples.get(conversation.sampleId) || { sampleId: conversation.sampleId,
      inputEvents: plan.events.length, imported: 0, memorySystemDegraded: false, preparationErrors: [],
      maintenanceCalls: 0, maintenanceFailures: [], inputBatches: [], effectiveDefaults: service.defaults,
      preparation: saved?.preparation || preparation, databasePath: service.paths.databasePath };
    if (!previousSamples.has(conversation.sampleId)) samples.push(sample);
    const passes = [], preparationErrors = sample.preparationErrors;
    let memoryPrepared = false;
    let finalProgress = null, degraded = false, imported = 0, maintenanceFailures = [];
    try {
      if (reuse) {
        degraded = saved.degraded === true;
        maintenanceFailures = saved.maintenance?.failures || [];
        finalProgress = await adapter.pendingWork();
      } else {
        service.initialize();
        for (const session of plan.sessions) {
          let pendingCharacters = 0;
          for (const reply of session.replies) {
            const appended = await adapter.afterReply(reply);
            imported += appended.archive.inserted;
            pendingCharacters += appended.events.reduce((sum, event) => sum + event.content.text.length, 0);
            if (pendingCharacters < service.defaults.ingestion.maximumCoreCharacters) continue;
            const pass = await adapter.onIdle({ sessionId: session.sessionId, now: conversation.questionDate });
            passes.push(pass);
            const pending = service.listInputEvents({ statuses: ["pending"], hostId: "zh4o", sessionId: session.sessionId, limit: 500 });
            pendingCharacters = pending.items.reduce((sum, row) => sum + String(row.content?.text || "").length, 0);
          }
        }
        let stagnant = 0, previous = "";
        for (let n = 0; n < maximumDrainPasses; n++) {
          const pass = await adapter.onSessionEnd({ now: conversation.questionDate });
          passes.push(pass); finalProgress = pass.progress;
          if (finalProgress?.total === 0) break;
          const fingerprint = JSON.stringify(finalProgress);
          stagnant = fingerprint === previous ? stagnant + 1 : 0; previous = fingerprint;
          if (stagnant >= 3) break;
        }
        maintenanceFailures = passes.filter(pass => pass.failures?.length
          || ['failed', 'partial-failure', 'completed-with-failures', 'degraded'].includes(pass.status))
          .map(pass => ({ status: pass.status, failures: pass.failures || [], maintenance: pass.maintenance }));
        degraded = !finalProgress || finalProgress.total > 0 || finalProgress.failures > 0 || maintenanceFailures.length > 0
          || passes.some(pass => pass.input?.some(input => input.batches?.some(batch =>
            batch.status === "quarantined" || batch.generationDiagnostics?.degraded)));
        fs.mkdirSync(sampleRoot, { recursive: true });
        fs.writeFileSync(manifestPath, JSON.stringify({ protocol: ZH4O_SYSTEM_PROTOCOL_VERSION, datasetSha256,
          sampleId: conversation.sampleId, degraded, defaults: service.defaults,
          preparation,
          embedding: withoutEmbedding ? null : embeddingIndexIdentity(normalizedConfig.providers.embedding),
          maintenance: { finalProgress, passes: passes.length, failures: maintenanceFailures } }, null, 2));
      }
      degraded ||= !finalProgress || finalProgress.total > 0 || finalProgress.failures > 0;
      const stored = inputRows(service);
      const inputMap = internalEventDialogueMap({ events: stored }, plan.eventIdToDialogueId);
      if (inputMap.size !== stored.length || unique([...inputMap.values()]).length !== plan.events.length) {
        throw new Error("Retained input provenance is incomplete; sample cannot be scored.");
      }
      Object.assign(sample, { imported: reuse ? sample.imported : imported, memorySystemDegraded: degraded,
        finalProgress, maintenanceCalls: reuse ? sample.maintenanceCalls : passes.length, maintenanceFailures,
        inputBatches: reuse ? sample.inputBatches : passes.flatMap(pass => pass.input || []).flatMap(input => input.batches || []) });
      memoryPrepared = true;
      const sources = new Map();
      const dialogueIdsFor = id => {
        if (!sources.has(id)) sources.set(id, sourceDialogueIds(service.getMemory(id), inputMap));
        return sources.get(id);
      };
      const dialogueById = dialogueIndex(conversation);
      phase = "query";
      await checkpoint();
      for (const question of questions) {
        if (previousQuestions.has(question.questionId)) continue;
        const row = { sampleId: conversation.sampleId, questionId: question.questionId, category: question.category,
          expectedChoice: question.answer, answerFormat: question.answerFormat,
          retrievalQuery: buildZh4oRetrievalQuery(question), scoringEligible: !degraded,
          ...postHocEvidenceAudit(question, null), attempts: {} };
        const questionStarted = performance.now();
        let questionStage = 'retrieval';
        if (degraded) Object.assign(row, { status: "excluded", reason: "memory-preparation-degraded" });
        else try {
          const options = {};
          if (candidateK !== undefined) options.maximumReturnedCandidates = candidateK;
          if (maximumContextCharacters !== undefined) options.maximumContextChars = maximumContextCharacters;
          const prepared = await runQuestionOperation(async () => {
            const prepared = await adapter.beforeReply({ sessionId: "evaluation", turnId: question.questionId,
              userText: row.retrievalQuery, userOccurredAt: conversation.questionDate, world: plan.world,
              recall: { enabled: true, readOnly: true, options } });
            if (prepared.status === 'degraded') throw Object.assign(new Error(prepared.memoryDiagnostics?.message || 'Read-only recall degraded.'),
              { code: prepared.memoryDiagnostics?.code, name: prepared.memoryDiagnostics?.name || 'Error' });
            if (prepared.retrieval.vector?.warning) throw new Error(prepared.retrieval.vector.warning);
            return prepared;
          }, { delayMs: retryDelayMs, onAttempts: attempts => { row.attempts.retrieval = attempts; } });
          row.retrievalLatencyMs = performance.now() - questionStarted;
          const retrieval = prepared.retrieval;
          questionStage = 'context';
          const candidateDialogueIds = (retrieval.candidates || []).map(candidate => dialogueIdsFor(candidate.memoryId));
          const context = materializedContext(retrieval, dialogueIdsFor, dialogueById);
          if (context.context !== prepared.memoryContext.content) throw Object.assign(new Error('Host context differs from retrieval context.'),
            { code: 'ZH4O_CONTEXT_MISMATCH' });
          const audit = postHocEvidenceAudit(question, context, candidateDialogueIds);
          Object.assign(row, { candidateCount: retrieval.candidates?.length || 0, retrievalStatus: retrieval.status,
            retrievalMode: retrieval.retrievalMode, vectorStatus: retrieval.vector?.status || 'disabled', context, ...audit,
            retrievalDiagnostics: diagnosticRetrievalSnapshot(retrieval, candidateDialogueIds, context, audit) });
          if (includeSourceDiagnostics) row.sourceReplayDiagnostic = buildZh4oRetrievedContext({ conversation,
            dialogueById, candidateDialogueIds });
          questionStage = 'answer';
          const answerStarted = performance.now();
          let response;
          try {
            response = await runQuestionOperation(() => answer(buildZh4oAnswerRequest({ question, context: prepared.memoryContext.content })),
              { delayMs: retryDelayMs, onAttempts: attempts => { row.attempts.answer = attempts; } });
          } finally { row.answerLatencyMs = performance.now() - answerStarted; }
          row.answerDiagnostics = { rawOutput: response.output, model: response.model, usage: response.usage };
          const prediction = normalizeChoice(response?.output?.choice);
          if (!prediction) throw Object.assign(new Error('Answer must be exactly A, B, C or D.'), { code: 'ZH4O_INVALID_CHOICE' });
          Object.assign(row, { status: 'completed', prediction, correct: prediction === question.answer });
          if (control === "no-memory") {
            try {
              const baseline = await runQuestionOperation(() => controlAnswer(buildZh4oAnswerRequest({ question, context: '' })),
                { delayMs: retryDelayMs, onAttempts: attempts => { row.attempts.control = attempts; } });
              const choice = normalizeChoice(baseline?.output?.choice);
              if (!choice) throw Object.assign(new Error('Control answer must be exactly A, B, C or D.'), { code: 'ZH4O_INVALID_CHOICE' });
              row.control = { prediction: choice, correct: choice === question.answer, status: 'completed' };
            } catch (error) { row.control = { status: "failed", error: nonFatalStageError(error) }; }
          }
        } catch (error) {
          Object.assign(row, { status: 'failed', correct: false, failureStage: questionStage, error: nonFatalStageError(error) });
        }
        row.latencyMs = performance.now() - questionStarted;
        results.push(row);
        if (row.status === 'failed' && row.error.infrastructure) {
          const key = `${row.failureStage}:${row.error.kind}`;
          failureStreak = { key, count: failureStreak.key === key ? failureStreak.count + 1 : 1 };
          if (row.error.fatal || failureStreak.count >= 3) abort = {
            reason: row.error.fatal ? 'fatal-infrastructure-error' : 'repeated-infrastructure-error',
            sampleId: row.sampleId, questionId: row.questionId, stage: row.failureStage,
            consecutiveFailures: failureStreak.count, error: row.error };
        } else failureStreak = { key: '', count: 0 };
        if (onProgress) await onProgress({ phase: 'question', completed: results.filter(item => item.sampleId === conversation.sampleId).length,
          total: questions.length, sampleId: conversation.sampleId, row });
        await checkpoint();
        if (abort) break;
      }
    } catch (error) {
      if (memoryPrepared) abort ||= { reason: 'evaluation-interrupted', sampleId: conversation.sampleId, error: nonFatalStageError(error) };
      else {
        degraded = true; preparationErrors.push(nonFatalStageError(error));
        sample.memorySystemDegraded = true;
        for (const question of questions) {
          if (results.some(row => row.questionId === question.questionId)) continue;
          results.push({ status: 'excluded', scoringEligible: false, sampleId: conversation.sampleId, questionId: question.questionId,
            expectedChoice: question.answer, answerFormat: question.answerFormat, category: question.category, reason: 'sample-preparation-failed' });
        }
      }
    } finally {
      if (degraded) results.filter(row => row.sampleId === conversation.sampleId).forEach(row => { row.scoringEligible = false; });
      try { await service.close(); }
      catch (error) { abort ||= { reason: 'sample-close-failed', sampleId: conversation.sampleId, error: nonFatalStageError(error) }; }
    }
    if (!memoryPrepared) Object.assign(sample, { imported, finalProgress, maintenanceCalls: passes.length, maintenanceFailures,
      inputBatches: passes.flatMap(pass => pass.input || []).flatMap(input => input.batches || []) });
    await checkpoint();
  }
  return reportSnapshot();
}
