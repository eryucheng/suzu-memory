import { extractionModelFixture } from '../../../test/support/extraction-fixtures.mjs';
import { createTestDirectory, closeAfterTests } from '../../../test/support/suite-resources.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-memory/core";
import {
  buildIngestionEvaluationInput,
  createLongTermExtractionExecutor,
  createCurrentRetrieverExecutor,
  evaluateIngestionResult,
  loadIngestionEvaluationCases,
  runMemoryIngestionEvaluation,
  runMemoryEvaluation,
  writeEvaluationReport,
} from "../src/index.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function extractionCandidate(overrides = {}) {
  const candidate = {
    kind: "fact",
    title: "测试记忆",
    content: "一条脱敏测试记忆。",
    subjectRole: "user",
    subjectName: "用户",
    actorRoles: [],
    canonicalKey: "",
    reality: "real",
    evidenceMode: "explicit",
    temporalState: "timeless",
    revisionAction: "add",
    eventDate: "",
    eventStart: "",
    eventEnd: "",
    confidence: 0.95,
    importance: 0.7,
    sourceRefs: ["M0001"],
    ...overrides,
  };
  const stateFamily = overrides.stateFamily || {
    fact: "identity",
    preference: "preference",
    commitment: "goal",
    open_loop: "goal",
  }[candidate.kind];
  const stateTarget = overrides.stateTarget || (stateFamily === "identity"
    ? { identityField: "other", fieldCardinality: "multi_item" } : null);
  return {
    ...candidate,
    canonicalKey: candidate.canonicalKey || `test:${stateFamily}:${candidate.kind}`,
    stateFamily: stateFamily || "not_applicable",
    stateLabel: overrides.stateLabel ?? (stateFamily ? candidate.title : ""),
    ...(stateTarget ? { stateTarget } : {}),
  };
}

function publicIngestionOutput(caseId) {
  const episodicEvent = (overrides = {}) => extractionCandidate({
    kind: "event",
    temporalState: "historical",
    eventDate: "2026-07-01",
    eventStart: "2026-07-01T04:00:00.000Z",
    ...overrides,
  });
  const outputs = {
    "one-off-meal-is-not-preference": {
      memories: [episodicEvent({
        title: "中午吃了牛肉面",
        content: "用户中午吃了牛肉面。",
      })],
    },
    "temporary-emotion-is-event-not-disposition": {
      memories: [episodicEvent({
        title: "汇报后感到委屈",
        content: "用户汇报结束后感到委屈，回办公室哭了一会。",
        eventStart: "2026-07-01T12:00:00.000Z",
      })],
    },
    "one-success-is-event-not-capability": {
      memories: [episodicEvent({
        title: "第一次独立修好服务器故障",
        content: "用户第一次独立修好了服务器故障。",
        eventStart: "2026-07-01T13:00:00.000Z",
      })],
    },
    "constrained-behavior-is-event-not-preference": {
      memories: [episodicEvent({
        title: "单位要求连续加班",
        content: "单位这周每天要求用户加班，用户只能留下来。",
        eventStart: "2026-07-01T14:00:00.000Z",
      })],
    },
    "single-conflict-is-event-not-relationship-state": {
      memories: [episodicEvent({
        title: "和姐姐因快递争执",
        content: "用户和姐姐因为快递的事吵了一架。",
        eventStart: "2026-07-01T15:00:00.000Z",
      })],
    },
    "explicit-user-preference": {
      memories: [extractionCandidate({
        kind: "preference",
        title: "喜欢科技展览",
        content: "用户一直喜欢逛科技展览。",
        actorRoles: [{
          role: "preference_holder",
          actorRole: "user",
          actorName: "用户",
          confidence: 1,
        }],
        canonicalKey: "user:preference:technology-exhibition",
      })],
    },
    "agent-guess-is-not-user-fact": { memories: [] },
    "user-biography-does-not-transfer": {
      memories: [extractionCandidate({
        title: "小学学过围棋",
        content: "用户小学时学过两年围棋。",
        temporalState: "historical",
      })],
    },
    "roleplay-is-not-real-history": {
      memories: [episodicEvent({
        title: "共同扮演月球基地故事",
        content: "双方共同扮演了一段在月球基地生活的故事。",
        subjectRole: "shared",
        subjectName: "",
        reality: "roleplay",
        eventDate: "2026-07-05",
        eventStart: "2026-07-05T04:00:00.000Z",
        sourceRefs: ["M0001", "M0002"],
      })],
    },
    "unfinished-event-stays-open": {
      memories: [extractionCandidate({
        kind: "open_loop",
        title: "等待检查结果",
        content: "用户正在等待医院检查结果。",
        actorRoles: [{
          role: "experiencer",
          actorRole: "user",
          actorName: "用户",
          confidence: 1,
        }],
        temporalState: "in_progress",
        eventDate: "2026-07-06",
        eventStart: "2026-07-06T04:00:00.000Z",
      })],
    },
    "shared-commitment-keeps-shared-owner": {
      memories: [extractionCandidate({
        kind: "commitment",
        title: "一起整理照片",
        content: "双方约定周日一起整理照片。",
        subjectRole: "shared",
        subjectName: "",
        actorRoles: [
          { role: "participant", actorRole: "user", actorName: "用户", confidence: 1 },
          { role: "participant", actorRole: "agent", actorName: "Suzu", confidence: 1 },
        ],
        temporalState: "planned",
        sourceRefs: ["M0001", "M0002"],
      })],
    },
  };
  return extractionModelFixture(outputs[caseId]);
}

test("evaluates the current retriever with source ownership and private context omitted", async t => {
  const root = createTestDirectory(path.join(os.tmpdir(), "suzu-memory-evaluation-"));
  const databasePath = path.join(root, "memory.db"), database = closeAfterTests(openMemoryDatabase(databasePath));
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const repository = new MemoryRepository(database);
  repository.upsertMemory({ id: "event-museum", agentId: "agent-test", kind: "event", layer: "episodic",
    content: "我上周六去了科技馆，看了机器人展。", subjectRole: "user", subjectKey: "user" });
  const report = await runMemoryEvaluation({
    cases: [{ id: "museum", query: "科技馆的机器人展", expect: { status: "ready", requiredMemoryIds: ["event-museum"],
      expectedSubjects: [{ memoryId: "event-museum", role: "user", key: "user" }], maximumContextChars: 1400 } }],
    execute: createCurrentRetrieverExecutor({ databasePath, agentId: "agent-test", options: { execution: 'inline' } }),
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  assert.equal(report.summary.failed, 0, JSON.stringify(report.results));
  assert.equal(report.results[0].actual.context, undefined);
  assert.equal(report.summary.externalUsage.requestCount, 0);
});

test("prices only the external requests captured during the current evaluation run", async () => {
  const report = await runMemoryEvaluation({
    cases: [{
      id: "priced-vector-query",
      category: "cost",
      query: "测试向量费用",
      expect: { status: "no-match", emptyContext: true },
    }],
    execute: async () => ({
      status: "no-match",
      context: "",
      candidates: [],
      graph: { selectedMemoryIds: [] },
      evaluationUsage: [{
        timestamp: "2026-08-03T00:00:00.000Z",
        provider: "阿里云百炼",
        model: "text-embedding-v4",
        requestId: "request-evaluation",
        usage: { prompt_tokens: 2000, total_tokens: 2000 },
      }],
    }),
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });

  assert.equal(report.results[0].actual.externalUsage.requestCount, 1);
  assert.equal(report.results[0].actual.externalUsage.amountCny, 0.001);
  assert.equal(report.summary.externalUsage.requestCount, 1);
  assert.equal(report.summary.externalUsage.pricedRequestCount, 1);
  assert.equal(report.summary.externalUsage.unknownPriceRequestCount, 0);
  assert.equal(report.summary.externalUsage.amountCny, 0.001);
  assert.equal(report.summary.externalUsage.byModel["text-embedding-v4"].amountCny, 0.001);
});

test("summarizes candidate ranking, rejection safety, routes, and bounded runtime data", async () => {
  const report = await runMemoryEvaluation({
    cases: [
      {
        id: "ranked-route",
        category: "ranking",
        query: "目标记忆",
        expect: {
          status: "ready",
          primaryMemoryIds: ["memory-target"],
          rankingMemoryIds: ["memory-target"],
          forbiddenMemoryIds: ["memory-wrong-subject"],
        },
      },
      {
        id: "clean-no-match",
        category: "no-match",
        query: "不存在的记忆",
        expect: { status: "no-match", emptyContext: true },
      },
    ],
    execute: async (item) => {
      if (item.id === "clean-no-match") {
        return {
          status: "no-match",
          context: "",
          candidates: [],
          graph: { selectedMemoryIds: [] },
          seedRouting: {
            plannedRoutes: ["lexical", "bm25"],
            executedRoutes: ["lexical", "bm25"],
            routeStatus: { lexical: "no-match", bm25: "no-match" },
          },
        };
      }
      return {
        status: "ready",
        context: "目标记忆",
        candidates: [
          { memoryId: "memory-wrong-subject", routeMatches: [{ route: "lexical" }] },
          {
            memoryId: "memory-target",
            routeMatches: [{ route: "lexical" }, { route: "bm25" }],
          },
          { memoryId: "memory-other", routeMatches: [{ route: "lexical" }] },
        ],
        outputBudget: {
          maximumContextChars: 1400,
          availableTextChars: 1300,
          requiredTextChars: 100,
          budgetedTextChars: 100,
          finalTextChars: 100,
          sectionTruncationApplied: false,
          safetyTruncationApplied: false,
        },
        graph: {
          seedId: "memory-target",
          selectedMemoryIds: ["memory-target", "memory-related"],
          paths: [{
            memoryId: "memory-related",
            score: 0.7,
            sourceCount: 1,
            edges: [{
              edgeId: "edge-related",
              relation: "associated_with",
              propagationPolicy: "budgeted",
              fanout: 4,
              fanoutFactor: 0.5,
            }],
          }],
          activationField: {
            relationView: "associative",
            seedMemoryIds: ["memory-target"],
            processedStates: 4,
            truncated: false,
            selected: [
              { memoryId: "memory-target", activation: 1 },
              { memoryId: "memory-related", activation: 0.7 },
            ],
          },
        },
        seedRouting: {
          plannedRoutes: ["lexical", "bm25", "entity"],
          executedRoutes: ["lexical", "bm25", "entity"],
          routeStatus: { lexical: "matched", bm25: "matched", entity: "no-match" },
        },
      };
    },
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });

  assert.equal(report.schemaVersion, 3);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.results[0].actual.candidateRanking.firstRelevantRank, 2);
  assert.equal(report.results[0].actual.candidateRanking.reciprocalRank, 0.5);
  assert.equal(report.results[0].actual.candidateRanking.recallAt1, 0);
  assert.equal(report.results[0].actual.candidateRanking.recallAt3, 1);
  assert.equal(report.results[0].actual.candidateRanking.ndcgAt5, 0.63093);
  assert.equal(report.results[0].actual.primarySelection.correct, true);
  assert.deepEqual(report.results[0].actual.primaryCandidateRoutes, ["lexical", "bm25"]);
  assert.equal(report.summary.candidateRanking.targetCaseCount, 1);
  assert.equal(report.summary.candidateRanking.meanReciprocalRank, 0.5);
  assert.equal(report.summary.candidateRanking.hitRateAt1, 0);
  assert.equal(report.summary.candidateRanking.hitRateAt3, 1);
  assert.equal(report.summary.primarySelection.targetCaseCount, 1);
  assert.equal(report.summary.primarySelection.accuracy, 1);
  assert.equal(report.summary.rejection.noMatchSuppressionRate, 1);
  assert.deepEqual(report.summary.rejection.falsePositiveNoMatchCaseIds, []);
  assert.equal(report.summary.rejection.forbiddenCandidateEntryRate, 1);
  assert.deepEqual(report.summary.rejection.forbiddenCandidateCaseIds, ["ranked-route"]);
  assert.equal(report.summary.routes.bm25.plannedCases, 2);
  assert.equal(report.summary.routes.bm25.matchedCases, 1);
  assert.equal(report.summary.routes.bm25.noMatchCases, 1);
  assert.equal(report.summary.routes.bm25.primaryCandidateCases, 1);
  assert.equal(report.summary.efficiency.averageCandidateCount, 1.5);
  assert.equal(report.results[0].actual.graphExpansion.pathCount, 1);
  assert.equal(report.results[0].actual.graphExpansion.maximumFanout, 4);
  assert.equal(report.results[0].actual.graphExpansion.minimumFanoutFactor, 0.5);
  assert.equal(report.summary.graphExpansion.eligibleCaseCount, 1);
  assert.equal(report.summary.graphExpansion.truncationRate, 0);
  assert.equal(report.summary.graphExpansion.maximumObservedDepth, 1);
  assert.equal(report.summary.outputBudget.eligibleCaseCount, 1);
  assert.equal(report.summary.outputBudget.sectionTruncationRate, 0);
  assert.equal(report.summary.outputBudget.safetyTruncationRate, 0);
});

test("does not treat multiple acceptable primary alternatives as a complete relevance set", async () => {
  const report = await runMemoryEvaluation({
    cases: [{
      id: "accepted-alternatives",
      category: "ranking",
      query: "哪一个都可以",
      expect: { status: "ready", primaryMemoryIds: ["memory-a", "memory-b"] },
    }],
    execute: async () => ({
      status: "ready",
      context: "命中 B",
      candidates: [{ memoryId: "memory-b" }],
      graph: { seedId: "memory-b", selectedMemoryIds: ["memory-b"] },
    }),
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });
  const ranking = report.results[0].actual.candidateRanking;
  assert.equal(ranking.judgment, "accepted-primary-alternatives");
  assert.equal(ranking.hitAt1, true);
  assert.equal(ranking.completeRelevanceJudgment, false);
  assert.equal(ranking.recallAt5, null);
  assert.equal(ranking.ndcgAt5, null);
  assert.equal(report.summary.candidateRanking.completeJudgmentCaseCount, 0);
  assert.equal(report.summary.primarySelection.accuracy, 1);
});

test("reports an incorrect final primary separately from candidate coverage", async () => {
  const report = await runMemoryEvaluation({
    cases: [{
      id: "wrong-primary",
      category: "ranking",
      query: "目标记忆",
      expect: { status: "ready", primaryMemoryIds: ["memory-target"] },
    }],
    execute: async () => ({
      status: "ready",
      context: "错误主记忆",
      candidates: [
        { memoryId: "memory-target" },
        { memoryId: "memory-wrong" },
      ],
      graph: { seedId: "memory-wrong", selectedMemoryIds: ["memory-wrong"] },
    }),
    now: () => new Date("2026-08-03T00:00:00.000Z"),
  });

  assert.equal(report.summary.failed, 1);
  assert.equal(report.summary.candidateRanking.hitRateAt1, 1);
  assert.equal(report.results[0].actual.primarySelection.correct, false);
  assert.equal(report.summary.primarySelection.accuracy, 0);
  assert.deepEqual(report.summary.primarySelection.incorrectCaseIds, ["wrong-primary"]);
});

test("records a failed expectation as baseline data instead of throwing", async () => {
  const report = await runMemoryEvaluation({
    cases: [{
      id: "expected-miss",
      category: "no-match",
      query: "不存在的事情",
      expect: { status: "no-match", emptyContext: true },
    }],
    execute: async () => ({ status: "ready", context: "错误召回" }),
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  assert.equal(report.summary.failed, 1);
  assert.equal(report.results[0].passed, false);
  assert.deepEqual(
    report.results[0].assertions.filter((item) => !item.passed).map((item) => item.rule),
    ["status", "empty-context"],
  );
});

test("writes private reports atomically and only includes context when requested", async () => {
  const root = createTestDirectory(path.join(os.tmpdir(), "suzu-memory-report-"));
  const report = await runMemoryEvaluation({
    cases: [{
      id: "local-detail",
      category: "direct-fact",
      query: "测试",
      expect: { status: "ready", contextIncludes: ["本机内容"] },
    }],
    execute: async () => ({ status: "ready", context: "本机内容" }),
    includeContext: true,
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  const reportPath = writeEvaluationReport(path.join(root, "report.json"), report);
  const written = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  assert.equal(written.results[0].actual.context, "本机内容");
  assert.equal(fs.readdirSync(root).some((name) => name.endsWith(".tmp")), false);
});

test("runs the sanitized ingestion baseline without an external model", async () => {
  const loaded = loadIngestionEvaluationCases(path.join(
    packageRoot,
    "fixtures",
    "ingestion-cases.json",
  ));
  const report = await runMemoryIngestionEvaluation({
    cases: loaded.cases,
    execute: async (item) => publicIngestionOutput(item.id),
    now: () => new Date("2026-08-01T00:00:00.000Z"),
  });
  assert.equal(report.summary.total, 11);
  assert.equal(report.summary.failed, 0);
  assert.equal(report.summary.passRate, 1);
  assert.equal(report.results[1].actual.memories[0].content, undefined);
  assert.match(report.results[1].actual.memories[0].contentSha256, /^[a-f0-9]{64}$/u);
});

test("detects a user preference fabricated from an Agent guess", () => {
  const loaded = loadIngestionEvaluationCases(path.join(
    packageRoot,
    "fixtures",
    "ingestion-cases.json",
  ));
  const item = loaded.cases.find((entry) => entry.id === "agent-guess-is-not-user-fact");
  const result = evaluateIngestionResult(item, extractionModelFixture({
    memories: [extractionCandidate({
      kind: "preference",
      title: "喜欢科幻",
      content: "用户喜欢科幻。",
      sourceRefs: ["M0002"],
    })],
  }));
  assert.equal(result.passed, false);
  assert.deepEqual(
    result.assertions.filter((assertion) => !assertion.passed).map((assertion) => assertion.rule),
    ["forbidden-memory:0"],
  );
});

test("long-term extraction evaluation input contains no host boundary context", () => {
  const loaded = loadIngestionEvaluationCases(path.join(
    packageRoot,
    "fixtures",
    "ingestion-cases.json",
  ));
  const item = loaded.cases.find((entry) => entry.id === "unfinished-event-stays-open");
  const input = buildIngestionEvaluationInput(item);
  assert.match(input, /正在去医院/u);
  assert.doesNotMatch(input, /刚刚做完检查|切点|衔接参考/u);
});

test("long-term extraction executor uses the production schema contract", async () => {
  let request;
  const execute = createLongTermExtractionExecutor({
    systemPrompt: "只输出结构化记忆。",
    generate: async (value) => {
      request = value;
      return { output: { memories: [] } };
    },
  });
  const output = await execute({
    id: "executor-contract",
    messages: [{ ref: "M0001", role: "user", text: "今天下雨。", timestamp: "2026-08-01" }],
    expect: { maximumMemories: 0 },
  });
  assert.equal(request.schemaName, "long-term-memory-extraction-v4");
  assert.deepEqual(request.schema.required, ["memories"]);
  assert.equal(request.systemPrompt, "只输出结构化记忆。");
  assert.match(request.input, /\[M0001\]/u);
  assert.deepEqual(output, { memories: [] });
});
