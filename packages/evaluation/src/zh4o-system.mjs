import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { createMemoryService } from "@suzu-memory/service";
import { calculateCost } from "@suzu-memory/usage-ledger";
import {
  createConversationArchiveWindows,
  packConversationArchiveWindows,
} from "@suzu-memory/ingestion";

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
  drainBenchmarkSemanticMaintenance,
  meanBenchmarkValues as mean,
  summarizeBenchmarkEmbeddingUsage as summarizeEmbeddingUsage,
} from "./retrieval-benchmark-utils.mjs";

export const ZH4O_SYSTEM_PROTOCOL_VERSION = "suzu-zh4o-memory-system-v3";
export const ZH4O_EVENT_FORMAT_VERSION = "zh4o-roleplay-conversation-event-v1";
export const ZH4O_ANSWER_SCHEMA_NAME = "zh4o-multiple-choice-answer-v1";
export const ZH4O_ANSWER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["choice"],
  properties: {
    choice: { type: "string", enum: ["A", "B", "C", "D", "E"] },
  },
});

const NON_STRUCTURED_RETRIEVAL_MEMORY_KINDS = new Set(["utterance", "topic_or_episode"]);

function stableHash(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function unique(values) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))];
}

function safeRemoveSqlite(databasePath) {
  for (const selected of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    fs.rmSync(selected, { force: true });
  }
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
    const response = await generator(request);
    records.push({
      phase,
      schemaName: clean(request?.schemaName),
      model: clean(response?.model),
      provider: clean(response?.metadata?.provider),
      usage: { ...(response?.usage || {}) },
    });
    return response;
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
    if (priced.amountCny === null) unknownPrice = true;
    else amountCny += priced.amountCny;
  }
  return {
    requests: records.length,
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
  if (!conversation) throw new Error("构造 ZH-4O 事件计划需要 conversation。");
  const agentId = zh4oAgentId(conversation.sampleId, datasetSha256);
  const primaryUserId = `zh4o-user-${stableHash(conversation.sampleId).slice(0, 16)}`;
  const world = { id: "zh4o-roleplay", frame: "fictional" };
  const eventIdToDialogueId = new Map();
  const sessions = [];
  const events = [];
  for (const session of conversation.sessions) {
    const memoryWindowId = `zh4o-window-${stableHash(
      `${datasetSha256}\0${conversation.sampleId}\0${session.ordinal}`,
    ).slice(0, 24)}`;
    const sessionEvents = [];
    let unitOrdinal = -1;
    for (let turnOrdinal = 0; turnOrdinal < session.turns.length; turnOrdinal += 1) {
      const turn = session.turns[turnOrdinal];
      const content = clean(turn.text);
      if (!content) continue;
      const role = turn.speaker === conversation.speakerA ? "user" : "companion";
      if (role === "user" || unitOrdinal < 0) unitOrdinal += 1;
      const occurredAt = new Date(session.sequenceDate.getTime() + turnOrdinal).toISOString();
      const eventId = `zh4o-event-${stableHash(
        `${datasetSha256}\0${conversation.sampleId}\0${turn.dialogueId}`,
      ).slice(0, 32)}`;
      const actor = role === "user"
        ? { role: "user", id: primaryUserId, name: conversation.speakerA }
        : { role: "companion", id: agentId, name: conversation.speakerB };
      const event = {
        protocolVersion: 1,
        eventId,
        spaceId: agentId,
        eventType: "conversation.turn",
        occurredAt,
        knownAt: occurredAt,
        recordedAt: occurredAt,
        actor,
        participants: [
          { role: "user", id: primaryUserId, name: conversation.speakerA },
          { role: "companion", id: agentId, name: conversation.speakerB },
        ],
        world,
        content: { text: content },
        source: {
          kind: "zh4o-roleplay-conversation",
          locator: `zh4o://event/${stableHash(eventId).slice(0, 24)}`,
        },
        metadata: {
          benchmark: "ZH-4O",
          formatVersion: ZH4O_EVENT_FORMAT_VERSION,
          sourceSessionId: session.sessionId,
          sourceSessionOrdinal: session.ordinal,
          sourceDateText: session.sourceDateText,
          sourceTimeKnown: false,
          scenario: "roleplay",
          timelineOrder: "synthetic-only",
          turnOrdinal,
          memoryWindow: {
            id: memoryWindowId,
            unitId: `${memoryWindowId}:turn:${String(unitOrdinal + 1).padStart(6, "0")}`,
            ordinal: turnOrdinal,
          },
        },
      };
      events.push(event);
      sessionEvents.push(event);
      eventIdToDialogueId.set(eventId, turn.dialogueId);
    }
    sessions.push({
      sessionOrdinal: session.ordinal,
      memoryWindowId,
      events: sessionEvents,
    });
  }
  return { agentId, primaryUserId, world, events, sessions, eventIdToDialogueId };
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

function listAllMemories(service, statuses = ["active"]) {
  const memories = [];
  let offset = 0;
  while (true) {
    const page = service.listMemories({ statuses, limit: 500, offset });
    memories.push(...page.items);
    offset += page.items.length;
    if (!page.items.length || memories.length >= page.total) return memories;
  }
}

function memoryDialogueMap(service, memories, inputEventIdToDialogueId) {
  return new Map(memories.map((memory) => [
    memory.id,
    sourceDialogueIds(service.getMemory(memory.id), inputEventIdToDialogueId),
  ]));
}

async function drainInputEvents(service, options) {
  const batches = [];
  const retryErrors = [];
  for (let index = 0; index < 10_000; index += 1) {
    let result;
    try {
      result = await service.processPendingEvents(options);
    } catch (error) {
      const failure = nonFatalStageError(error);
      retryErrors.push(failure);
      // A normal input-processing failure records an attempt and returns the
      // events to pending.  The next service call either retries the same
      // batch or, after its bounded retry policy is exhausted, archives the
      // raw evidence and routes enrichment to human review.  The benchmark
      // must exercise that lifecycle instead of silently dropping the pack.
      if (failure.code === "INPUT_BATCH_LEASE_LOST" || retryErrors.length >= 3) {
        return {
          batches,
          retryErrors,
          complete: false,
          terminal: {
            status: failure.code === "INPUT_BATCH_LEASE_LOST"
              ? "lease-lost"
              : "retry-limit-reached",
            reason: failure.message,
            error: failure,
          },
        };
      }
      continue;
    }
    if (result.status === "skipped") return {
      batches,
      retryErrors,
      complete: true,
      terminal: result,
    };
    batches.push(result);
    if (result.status !== "processed") {
      return { batches, retryErrors, complete: false, terminal: result };
    }
  }
  return {
    batches,
    retryErrors,
    complete: false,
    terminal: { status: "pass-limit-reached", reason: "input-processing-pass-limit" },
  };
}

async function drainEmbeddingMaintenance(service, embeddingProvider) {
  if (typeof embeddingProvider !== "function") {
    return [{ status: "disabled", reason: "embedding-provider-not-configured", selected: 0 }];
  }
  const passes = [];
  for (let index = 0; index < 100; index += 1) {
    const result = await service.runEmbeddingMaintenance({
      maximumTasks: 100,
      batchSize: 10,
      embeddingProvider,
    });
    passes.push(result);
    if (["empty", "disabled"].includes(result.status)) return passes;
  }
  passes.push({
    status: "pass-limit-reached",
    selected: 0,
    error: "ZH-4O embedding maintenance still had work after 100 bounded passes.",
  });
  return passes;
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
      "只能依据用户提供的召回对话片段作答，不能补充片段外的设定或常识猜测。",
      "题目中已经列出 A 到 E 选项。必须选择且只选择其中一个字母。",
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
  const direct = clean(value).toUpperCase();
  if (/^[A-E]$/u.test(direct)) return direct;
  const match = /(?:答案|选项|choice)?\s*[：:：]?\s*([A-E])(?:\s|$|[。.!！,，])/iu.exec(direct);
  return match ? match[1].toUpperCase() : "";
}

function sampleDatabasePath(workDirectory, agentId) {
  const directory = path.join(workDirectory, "samples");
  fs.mkdirSync(directory, { recursive: true });
  return path.join(directory, `${agentId}.db`);
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
      includedInAnswerContext,
      status: includedInAnswerContext
        ? "included-in-answer-context"
        : candidateRanks.length
          ? "candidate-not-in-answer-context"
          : "not-in-candidate-pool",
    };
  });
  const goldEvidenceRetrievalOutcome = !goldEvidenceDialogueIds.length
    ? "unannotated"
    : recalledGoldEvidenceDialogueIds.length === goldEvidenceDialogueIds.length
      ? "all-gold-in-answer-context"
      : recalledGoldEvidenceDialogueIds.length
        ? "partial-gold-in-answer-context"
        : candidateGoldEvidenceDialogueIds.length
          ? "gold-in-candidate-pool-not-answer-context"
          : "gold-not-in-candidate-pool";
  return {
    goldEvidenceDialogueIds,
    candidateGoldEvidenceDialogueIds,
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

function diagnosticAnswerOutput(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return clean(value) || null;
  }
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

function summarizeRows(rows) {
  const completed = rows.filter((row) => row.status === "completed");
  const failed = rows.filter((row) => row.status === "failed");
  const annotatedEvidenceRows = completed.filter((row) => row.goldEvidenceDialogueIds?.length);
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
  const officialAccuracy = completed.length
    ? completed.reduce((sum, row) => sum + Number(row.correct), 0) / completed.length
    : null;
  const validChoiceRows = completed.filter((row) => row.answerFormat === "choice");
  const validChoiceAccuracy = validChoiceRows.length
    ? validChoiceRows.reduce((sum, row) => sum + Number(row.correct), 0) / validChoiceRows.length
    : null;
  const byCategory = Object.fromEntries([...new Set(completed.map((row) => row.category))]
    .sort((left, right) => left - right)
    .map((category) => {
      const selected = completed.filter((row) => row.category === category);
      const categoryAccuracy = selected.length
        ? selected.reduce((sum, row) => sum + Number(row.correct), 0) / selected.length
        : null;
      return [category, {
        questions: selected.length,
        correct: selected.reduce((sum, row) => sum + Number(row.correct), 0),
        exactChoiceAccuracy: categoryAccuracy,
        exactChoiceAccuracyPercent: categoryAccuracy === null ? null : categoryAccuracy * 100,
      }];
    }));
  return {
    attempted: rows.length,
    completed: completed.length,
    failures: failed.length,
    correct: completed.reduce((sum, row) => sum + Number(row.correct), 0),
    // The upstream scorer includes every non-empty gold value, including the
    // one malformed non-choice value currently published in ZH-4O. Preserve
    // that result for reproducibility, while also exposing the meaningful
    // valid-choice subset for model/system diagnosis.
    officialDatasetAccuracy: officialAccuracy,
    officialDatasetAccuracyPercent: officialAccuracy === null ? null : officialAccuracy * 100,
    validChoiceQuestions: validChoiceRows.length,
    validChoiceCorrect: validChoiceRows.reduce((sum, row) => sum + Number(row.correct), 0),
    exactChoiceAccuracy: validChoiceAccuracy,
    exactChoiceAccuracyPercent: validChoiceAccuracy === null ? null : validChoiceAccuracy * 100,
    byCategory,
    context: {
      meanCharacters: completed.length
        ? mean(completed.map((row) => Number(row.context?.contextCharacters || 0)))
        : null,
      truncated: completed.filter((row) => row.context?.contextTruncated).length,
      empty: completed.filter((row) => !row.context?.usedDialogueIds?.length).length,
    },
    evidenceAudit: {
      annotatedQuestions: annotatedEvidenceRows.length,
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
  return {
    message: clean(error?.message) || "unknown error",
    code: clean(error?.code),
  };
}

/**
 * Full ZH-4O memory-system benchmark.  It deliberately does not use the
 * dataset's observation/session_summary/event_summary/qa.evidence fields:
 * only raw role-play dialogue enters memory before the later QA stage.
 */
export async function runZh4oMemorySystemBenchmark({
  datasetPath,
  workDirectory,
  startSample = 0,
  maximumSamples = Number.MAX_SAFE_INTEGER,
  maximumQuestionsPerSample = Number.MAX_SAFE_INTEGER,
  candidateK = 9,
  maximumContextCharacters = 24_000,
  generator,
  structureGenerator = generator,
  retrievalContextGenerator = generator,
  answerGenerator = generator,
  embeddingProvider = null,
  embeddingRequestIntervalMs = 0,
  maximumEvents = 50,
  maximumContentCharacters = 24_000,
  maximumSemanticPasses = 100,
  codeRevision = {},
  retainSampleDatabases = false,
  resumeSampleDatabases = false,
  onProgress = null,
} = {}) {
  if (typeof generator !== "function") throw new Error("ZH-4O 完整评测需要 generation provider。 ");
  if (typeof answerGenerator !== "function") throw new Error("ZH-4O 完整评测需要 answer generator。 ");
  const normalizedDatasetPath = path.resolve(clean(datasetPath));
  const normalizedWorkDirectory = path.resolve(clean(workDirectory));
  if (!clean(datasetPath) || !fs.existsSync(normalizedDatasetPath)) {
    throw new Error(`ZH-4O 数据集不存在：${normalizedDatasetPath}`);
  }
  if (!clean(workDirectory)) throw new Error("ZH-4O 完整评测需要 workDirectory。 ");
  fs.mkdirSync(normalizedWorkDirectory, { recursive: true });

  const allSamples = loadZh4oDataset(normalizedDatasetPath);
  const datasetSha256 = zh4oDatasetSha256(normalizedDatasetPath);
  const selectedStart = boundedInteger(startSample, 0, { minimum: 0, maximum: allSamples.length });
  const selectedMaximum = boundedInteger(maximumSamples, allSamples.length, {
    minimum: 1,
    maximum: allSamples.length,
  });
  const selectedSamples = allSamples.slice(selectedStart, selectedStart + selectedMaximum);
  if (!selectedSamples.length) throw new Error("ZH-4O 选定范围没有样本。 ");
  const selectedQuestionLimit = boundedInteger(maximumQuestionsPerSample, Number.MAX_SAFE_INTEGER, {
    minimum: 1,
    maximum: Number.MAX_SAFE_INTEGER,
  });
  const selectedCandidateK = boundedInteger(candidateK, 9, { minimum: 1, maximum: 1_000 });
  const selectedContextCharacters = boundedInteger(maximumContextCharacters, 24_000, {
    minimum: 1_000,
    maximum: 1_000_000,
  });
  const selectedMaximumEvents = boundedInteger(maximumEvents, 50, { minimum: 1, maximum: 500 });
  const selectedMaximumContentCharacters = boundedInteger(maximumContentCharacters, 24_000, {
    minimum: 1_000,
    maximum: 1_000_000,
  });

  const generationUsageRecords = [];
  const embeddingUsageRecords = [];
  const embeddingGate = createEmbeddingRequestGate(embeddingRequestIntervalMs);
  const extractionGenerator = captureGenerationUsage(generator, "extraction", generationUsageRecords);
  const semanticStructureGenerator = captureGenerationUsage(
    structureGenerator,
    "semantic-structure",
    generationUsageRecords,
  );
  const semanticContextGenerator = captureGenerationUsage(
    retrievalContextGenerator,
    "semantic-retrieval-context",
    generationUsageRecords,
  );
  const scoredAnswerGenerator = captureGenerationUsage(answerGenerator, "answer", generationUsageRecords);
  const indexEmbeddingProvider = captureEmbeddingUsage(
    embeddingProvider,
    "index",
    embeddingUsageRecords,
    embeddingGate,
  );
  const queryEmbeddingProvider = captureEmbeddingUsage(
    embeddingProvider,
    "query",
    embeddingUsageRecords,
    embeddingGate,
  );

  const startedAt = new Date();
  const startedPerformance = performance.now();
  const results = [];
  const samples = [];
  const retainedDatabases = [];
  for (let sampleIndex = 0; sampleIndex < selectedSamples.length; sampleIndex += 1) {
    const conversation = selectedSamples[sampleIndex];
    const plan = createZh4oEventPlan(conversation, datasetSha256);
    assertZh4oEventsHaveNoGoldLabels({ conversation, plan });
    const databasePath = sampleDatabasePath(normalizedWorkDirectory, plan.agentId);
    const databaseResumed = Boolean(resumeSampleDatabases && fs.existsSync(databasePath));
    const usageLedgerPath = path.join(normalizedWorkDirectory, "usage", `${plan.agentId}.jsonl`);
    fs.mkdirSync(path.dirname(usageLedgerPath), { recursive: true });
    if (!databaseResumed) {
      safeRemoveSqlite(databasePath);
      fs.rmSync(usageLedgerPath, { force: true });
    }
    const service = createMemoryService({
      dataRoot: normalizedWorkDirectory,
      agentId: plan.agentId,
      databasePath,
      usageLedgerPath,
      providers: {
        generator: extractionGenerator,
        structureGenerator: semanticStructureGenerator,
        retrievalContextGenerator: semanticContextGenerator,
        embedding: indexEmbeddingProvider,
      },
      defaults: {
        memoryOwner: conversation.speakerB,
        userName: conversation.speakerA,
        primaryUserId: plan.primaryUserId,
        companionId: plan.agentId,
        relationshipLabel: "relationship",
        ingestion: {
          maximumEventCharacters: Math.min(12_000, selectedMaximumContentCharacters),
          maximumBatchCharacters: selectedMaximumContentCharacters,
        },
      },
    });
    const inputEventIdToDialogueId = new Map();
    const inputBatches = [];
    const processingErrors = [];
    const inputProcessingRetries = [];
    const archiveWindows = plan.sessions.flatMap((sessionPlan) => createConversationArchiveWindows(sessionPlan, {
      maximumEvents: selectedMaximumEvents,
      maximumContentCharacters: selectedMaximumContentCharacters,
    }));
    const archiveWindowPacks = packConversationArchiveWindows(archiveWindows, {
      maximumEvents: selectedMaximumEvents,
      maximumContentCharacters: selectedMaximumContentCharacters,
    });
    for (const pack of archiveWindowPacks) {
      const coreEvents = pack.windows.flatMap((window) => window.coreEvents);
      const appendResult = service.appendEvents(coreEvents);
      for (const [eventId, dialogueId] of internalEventDialogueMap(appendResult, plan.eventIdToDialogueId)) {
        inputEventIdToDialogueId.set(eventId, dialogueId);
      }
      try {
        const processing = await drainInputEvents(service, {
          maximumEvents: Math.max(selectedMaximumEvents, appendResult.events.length),
          maximumContentCharacters: Math.max(selectedMaximumContentCharacters, pack.characters),
          candidateEventIds: appendResult.events.map((event) => event.id),
          archiveWindows: pack.windows.map((window) => ({
            id: window.id,
            continuityId: window.memoryWindowId,
            coreEventIds: window.coreEvents.map((event) => event.eventId),
            previousContextEvents: window.previousContextEvents,
            continuationGuidanceEvents: window.continuationGuidanceEvents,
          })),
          generator: extractionGenerator,
          now: conversation.questionDate,
        });
        inputBatches.push(...processing.batches);
        if (processing.retryErrors.length) {
          inputProcessingRetries.push({
            archiveWindowIds: pack.windows.map((window) => window.id),
            errors: processing.retryErrors,
          });
        }
        if (!processing.complete) processingErrors.push({
          kind: "input-processing-incomplete",
          terminal: processing.terminal,
        });
      } catch (error) {
        processingErrors.push({ kind: "input-processing-error", ...nonFatalStageError(error) });
      }
    }
    let semanticMaintenance = null;
    try {
      semanticMaintenance = await drainBenchmarkSemanticMaintenance({
        service,
        options: {
          generator: extractionGenerator,
          structureGenerator: semanticStructureGenerator,
          retrievalContextGenerator: semanticContextGenerator,
          now: conversation.questionDate,
        },
        maximumPasses: boundedInteger(maximumSemanticPasses, 100, { minimum: 0, maximum: 100_000 }),
      });
    } catch (error) {
      semanticMaintenance = { complete: false, passes: [], failures: { total: 1 }, error: nonFatalStageError(error) };
    }
    let embeddingPasses = [];
    try {
      embeddingPasses = await drainEmbeddingMaintenance(service, indexEmbeddingProvider);
    } catch (error) {
      embeddingPasses = [{ status: "failed", error: nonFatalStageError(error) }];
    }

    const formalStructured = listAllMemories(service, ["active", "superseded", "disputed"])
      .filter((memory) => !NON_STRUCTURED_RETRIEVAL_MEMORY_KINDS.has(memory.kind));
    const provisionalStructured = listAllMemories(service, ["archived"])
      .filter((memory) => (
        memory.layer === "provisional"
        && memory.metadata?.provisional === true
        && memory.metadata?.reviewState === "pending"
        && !NON_STRUCTURED_RETRIEVAL_MEMORY_KINDS.has(memory.kind)
      ));
    const episodicEvidence = listAllMemories(service, ["active"])
      .filter((memory) => memory.kind === "utterance");
    const recallableMemories = [...formalStructured, ...provisionalStructured, ...episodicEvidence];
    const recallableMemoryToDialogueIds = memoryDialogueMap(
      service,
      recallableMemories,
      inputEventIdToDialogueId,
    );
    const sourceTurns = dialogueIndex(conversation);
    const questions = conversation.questions.slice(0, selectedQuestionLimit);
    let sampleQuestionFailures = 0;
    for (let questionIndex = 0; questionIndex < questions.length; questionIndex += 1) {
      const question = questions[questionIndex];
      const retrievalQuery = buildZh4oRetrievalQuery(question);
      const retrievalStarted = performance.now();
      let retrieval;
      let context;
      let candidateDialogueIds = [];
      let evidenceAudit = postHocEvidenceAudit(question, null);
      let retrievalLatencyMs = null;
      let contextAssemblyLatencyMs = null;
      let answerLatencyMs = null;
      let failureStage = "retrieval";
      try {
        retrieval = await service.search(retrievalQuery, {
          now: conversation.questionDate,
          queryPerspective: {
            speakerRole: "user",
            speakerKey: plan.primaryUserId,
            speakerNames: [conversation.speakerA],
            addresseeRole: "agent",
            addresseeKey: plan.agentId,
            addresseeNames: [conversation.speakerB],
          },
          world: plan.world,
          options: {
            maximumCandidates: selectedCandidateK,
            maximumEpisodicCandidates: selectedCandidateK,
            maximumReturnedCandidates: selectedCandidateK,
          },
          embeddingProvider: queryEmbeddingProvider,
          persistTrace: false,
        });
        retrievalLatencyMs = performance.now() - retrievalStarted;
        failureStage = "context-assembly";
        const contextAssemblyStarted = performance.now();
        candidateDialogueIds = (retrieval.candidates || []).map((candidate) => (
          recallableMemoryToDialogueIds.get(candidate.memoryId)
          || sourceDialogueIds(service.getMemory(candidate.memoryId), inputEventIdToDialogueId)
        ));
        context = buildZh4oRetrievedContext({
          conversation,
          dialogueById: sourceTurns,
          candidateDialogueIds,
          candidateLimit: selectedCandidateK,
          maximumContextCharacters: selectedContextCharacters,
        });
        contextAssemblyLatencyMs = performance.now() - contextAssemblyStarted;
        evidenceAudit = postHocEvidenceAudit(question, context, candidateDialogueIds);
        failureStage = "answer";
        const answerStarted = performance.now();
        const answerRequest = buildZh4oAnswerRequest({ question, context: context.context });
        const response = await scoredAnswerGenerator(answerRequest);
        answerLatencyMs = performance.now() - answerStarted;
        const prediction = normalizeChoice(response?.output?.choice ?? response?.output);
        const correct = prediction === question.answer;
        results.push({
          status: "completed",
          sampleId: conversation.sampleId,
          questionId: question.questionId,
          category: question.category,
          retrievalQuery,
          expectedChoice: question.answer,
          answerFormat: question.answerFormat,
          prediction,
          correct,
          candidateCount: retrieval.candidates?.length || 0,
          retrievalStatus: retrieval.status,
          retrievalMode: retrieval.retrievalMode || "",
          vectorStatus: retrieval.vector?.status || "disabled",
          latencyMs: performance.now() - retrievalStarted,
          retrievalLatencyMs,
          contextAssemblyLatencyMs,
          answerLatencyMs,
          context,
          retrievalDiagnostics: diagnosticRetrievalSnapshot(
            retrieval,
            candidateDialogueIds,
            context,
            evidenceAudit,
          ),
          answerDiagnostics: {
            rawOutput: diagnosticAnswerOutput(response?.output),
            model: clean(response?.model),
            provider: clean(response?.metadata?.provider),
            usage: diagnosticAnswerOutput(response?.usage) || {},
          },
          ...evidenceAudit,
        });
      } catch (error) {
        sampleQuestionFailures += 1;
        results.push({
          status: "failed",
          sampleId: conversation.sampleId,
          questionId: question.questionId,
          category: question.category,
          retrievalQuery,
          expectedChoice: question.answer,
          answerFormat: question.answerFormat,
          candidateCount: retrieval?.candidates?.length || 0,
          retrievalStatus: retrieval?.status || "failed",
          latencyMs: performance.now() - retrievalStarted,
          retrievalLatencyMs,
          contextAssemblyLatencyMs,
          answerLatencyMs,
          context: context || null,
          retrievalDiagnostics: retrieval
            ? diagnosticRetrievalSnapshot(
              retrieval,
              candidateDialogueIds,
              context,
              evidenceAudit,
            )
            : null,
          ...evidenceAudit,
          failureStage,
          error: nonFatalStageError(error),
        });
      }
      if (typeof onProgress === "function") {
        onProgress({
          phase: "question",
          sample: sampleIndex + 1,
          samples: selectedSamples.length,
          completed: questionIndex + 1,
          total: questions.length,
          row: results.at(-1),
        });
      }
    }
    const embeddingMaintenanceFailures = embeddingPasses.filter((pass) => (
      ["failed", "partial-failure", "pass-limit-reached"].includes(pass.status)
    ));
    const inputGenerationDegradedBatches = inputBatches.filter((batch) => (
      Boolean(batch.generationDiagnostics?.degraded)
    ));
    samples.push({
      sampleId: conversation.sampleId,
      sessions: conversation.sessions.length,
      inputEvents: plan.events.length,
      archiveWindows: archiveWindows.length,
      archiveWindowPacks: archiveWindowPacks.length,
      inputBatches: inputBatches.length,
      inputProcessingErrors: processingErrors,
      inputProcessingRetries,
      inputGenerationDegradedBatches: inputGenerationDegradedBatches.length,
      databaseLifecycle: databaseResumed ? "resumed" : "created",
      semanticPasses: semanticMaintenance.passes?.length || 0,
      semanticPendingBefore: semanticMaintenance.pendingBefore ?? null,
      semanticPendingAfter: semanticMaintenance.pendingAfter ?? null,
      semanticMaintenanceComplete: Boolean(semanticMaintenance.complete),
      semanticMaintenanceFailures: semanticMaintenance.failures || { total: 0 },
      embeddingPasses: embeddingPasses.length,
      embeddingMaintenanceFailures,
      activeStructuredMemories: formalStructured.filter((memory) => memory.status === "active").length,
      provisionalStructuredMemories: provisionalStructured.length,
      episodicEvidenceMemories: episodicEvidence.length,
      recallableMemories: recallableMemories.length,
      questionFailures: sampleQuestionFailures,
      memorySystemDegraded: processingErrors.length > 0
        || inputGenerationDegradedBatches.length > 0
        || !semanticMaintenance.complete
        || Number(semanticMaintenance.failures?.total || 0) > 0
        || embeddingMaintenanceFailures.length > 0,
    });
    if (retainSampleDatabases) retainedDatabases.push(databasePath);
    else {
      safeRemoveSqlite(databasePath);
      fs.rmSync(usageLedgerPath, { force: true });
    }
  }
  const finishedAt = new Date();
  const summary = summarizeRows(results);
  const latencyValues = results.filter((row) => row.status === "completed").map((row) => row.latencyMs);
  return {
    protocol: {
      name: "ZH-4O complete memory-system multiple-choice evaluation",
      version: ZH4O_SYSTEM_PROTOCOL_VERSION,
      contractVersion: ZH4O_CONTRACT_VERSION,
      task: "memory-system-e2e-multiple-choice",
      qaEvaluated: true,
      sourceDataIngested: "roleplay-conversation-only",
      excludedDatasetFields: ["observation", "session_summary", "event_summary", "qa.answer", "qa.evidence"],
      goldEvidencePolicy: "post-hoc retrieval audit only; never passed to memory input, retrieval, or answer generation",
      messageRolesIngested: ["user", "assistant"],
      answerMetric: "exact-choice-letter",
      upstreamMalformedGoldPolicy: "preserve-and-report-separately",
      officialHarnessReference: {
        project: "MOOM ZH-4O",
        publishedRetrievalSeedTopK: 10,
      },
      comparisonNotice: "This run uses its configured providers and is not a directly comparable reproduction of the paper's Qwen3-8B table.",
    },
    dataset: {
      path: normalizedDatasetPath,
      sha256: datasetSha256,
      totalSamples: allSamples.length,
      totalQuestions: allSamples.reduce((sum, sample) => sum + sample.questions.length, 0),
      selectedStart,
      selectedSamples: selectedSamples.length,
      selectedQuestions: results.length,
      totalNonChoiceGoldQuestions: allSamples.reduce((sum, sample) => (
        sum + sample.questions.filter((question) => question.answerFormat !== "choice").length
      ), 0),
      selectedNonChoiceGoldQuestions: selectedSamples.reduce((sum, sample) => (
        sum + sample.questions.slice(0, selectedQuestionLimit)
          .filter((question) => question.answerFormat !== "choice").length
      ), 0),
    },
    database: {
      workDirectory: normalizedWorkDirectory,
      retention: retainSampleDatabases ? "sample-databases-retained" : "sample-databases-removed",
      sampleDatabases: retainedDatabases,
    },
    run: {
      codeRevision: {
        commit: clean(codeRevision?.commit),
        dirty: typeof codeRevision?.dirty === "boolean" ? codeRevision.dirty : null,
      },
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: performance.now() - startedPerformance,
      candidateK: selectedCandidateK,
      maximumContextCharacters: selectedContextCharacters,
      maximumEvents: selectedMaximumEvents,
      maximumContentCharacters: selectedMaximumContentCharacters,
      generationUsage: summarizeGenerationUsage(generationUsageRecords, finishedAt.toISOString()),
      embeddingEnabled: Boolean(embeddingProvider),
      embeddingRequestIntervalMs: Math.max(0, Math.trunc(Number(embeddingRequestIntervalMs) || 0)),
      embeddingUsage: summarizeEmbeddingUsage(embeddingUsageRecords, finishedAt.toISOString()),
    },
    scores: summary,
    diagnostics: {
      emptyRetrievals: results.filter((row) => row.status === "completed" && row.candidateCount === 0).length,
      failedQuestions: results.filter((row) => row.status === "failed").length,
      failuresByStage: Object.fromEntries(
        [...new Set(results.filter((row) => row.status === "failed").map((row) => (
          clean(row.failureStage) || "unknown"
        )))]
          .sort()
          .map((stage) => [
            stage,
            results.filter((row) => row.status === "failed" && (clean(row.failureStage) || "unknown") === stage).length,
          ]),
      ),
      degradedSamples: samples.filter((sample) => sample.memorySystemDegraded).length,
      meanLatencyMs: mean(latencyValues),
      p50LatencyMs: percentile(latencyValues, 0.5),
      p95LatencyMs: percentile(latencyValues, 0.95),
      maximumLatencyMs: latencyValues.length ? Math.max(...latencyValues) : null,
      meanRetrievalLatencyMs: mean(results
        .filter((row) => Number.isFinite(Number(row.retrievalLatencyMs)))
        .map((row) => Number(row.retrievalLatencyMs))),
      meanContextAssemblyLatencyMs: mean(results
        .filter((row) => Number.isFinite(Number(row.contextAssemblyLatencyMs)))
        .map((row) => Number(row.contextAssemblyLatencyMs))),
      meanAnswerLatencyMs: mean(results
        .filter((row) => Number.isFinite(Number(row.answerLatencyMs)))
        .map((row) => Number(row.answerLatencyMs))),
    },
    samples,
    results,
  };
}
