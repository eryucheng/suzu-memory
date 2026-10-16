import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ZH4O_ANSWER_SCHEMA_NAME,
  assertZh4oEventsHaveNoGoldLabels,
  buildZh4oAnswerRequest,
  buildZh4oRetrievalQuery,
  buildZh4oRetrievedContext,
  createZh4oEventPlan,
  loadZh4oDataset,
  runZh4oMemorySystemBenchmark,
  zh4oDatasetSha256,
} from "../src/index.mjs";

function writeFixture(directory) {
  const datasetPath = path.join(directory, "zh4o-synthetic.json");
  fs.writeFileSync(datasetPath, JSON.stringify([{
    sample_id: "zh4o-synthetic-1",
    conversation: {
      speaker_a: "赵齐",
      speaker_b: "白羽岚",
      session_1: [
        { speaker: "赵齐", dia_id: "S1:1", text: "我最喜欢苹果味汽水。" },
        { speaker: "白羽岚", dia_id: "S1:2", text: "我记住了，你喜欢苹果味汽水。" },
      ],
      session_2: [
        { speaker: "赵齐", dia_id: "S2:1", text: "今天还喝了一罐苹果味汽水。" },
      ],
    },
    observation: "This must not enter memory.",
    session_summary: "This must not enter memory.",
    event_summary: "This must not enter memory.",
    qa: [{
      question: "赵齐最喜欢什么味道的汽水？A 柠檬 B 苹果 C 葡萄 D 西瓜 E 可乐",
      answer: "B",
      category: 1,
      evidence: ["S1:1"],
    }, {
      question: "这是一条用于覆盖上游坏标注处理的题目。A 甲 B 乙 C 丙 D 丁",
      answer: "COLEÇÃO",
      category: 1,
      evidence: [],
    }],
  }], null, 2), "utf8");
  return datasetPath;
}

function generatedEventCandidate({ content, sourceRef, eventStart }) {
  const hasCalendarTimestamp = /^\d{4}-\d{2}-\d{2}T/u.test(eventStart);
  return {
    kind: "event",
    title: content.slice(0, 80),
    content,
    subjectRole: "user",
    subjectName: "赵齐",
    actorRoles: [{
      role: "experiencer",
      actorRole: "user",
      actorName: "赵齐",
      confidence: 1,
    }],
    canonicalKey: "",
    stateFamily: "not_applicable",
    stateLabel: "",
    reality: "fictional",
    evidenceMode: "explicit",
    temporalState: hasCalendarTimestamp ? "historical" : "timeless",
    revisionAction: "add",
    retentionReason: "significant_event",
    eventDate: hasCalendarTimestamp ? eventStart.slice(0, 10) : "",
    eventStart: hasCalendarTimestamp ? eventStart : "",
    eventEnd: "",
    confidence: 0.95,
    importance: 0.75,
    sourceRefs: [sourceRef],
  };
}

function fixtureGenerator() {
  const generator = async ({ input, schemaName }) => {
    if (schemaName === "long-term-memory-extraction-v2") {
      const memories = [...String(input).matchAll(
        /\[(M\d{4})\] \[([^\]]+)\](?: \[world=[^\]]+\])? 对方：([^\n]+)/gu,
      )].map((match) => generatedEventCandidate({
        sourceRef: match[1],
        eventStart: match[2],
        content: match[3].trim(),
      }));
      return {
        output: { memories },
        model: "deepseek-v4-flash",
        usage: { prompt_cache_miss_tokens: 10, completion_tokens: 2 },
      };
    }
    if (schemaName === ZH4O_ANSWER_SCHEMA_NAME) {
      return {
        output: { choice: "B" },
        model: "deepseek-v4-flash",
        usage: { prompt_cache_miss_tokens: 5, completion_tokens: 1 },
      };
    }
    throw new Error(`Unexpected fixture schema: ${schemaName}`);
  };
  generator.supportsCombinedStateAnalysis = true;
  generator.supportsCombinedConsolidation = true;
  return generator;
}

function fixtureEmbedding() {
  const vector = (text) => (String(text).includes("苹果") ? [1, 0] : [0, 1]);
  const provider = async (text) => ({
    vector: vector(text),
    model: "text-embedding-v4",
    usage: { prompt_tokens: 1, total_tokens: 1 },
  });
  provider.embedMany = async (texts) => ({
    vectors: texts.map(vector),
    model: "text-embedding-v4",
    usage: { prompt_tokens: texts.length, total_tokens: texts.length },
  });
  provider.model = "text-embedding-v4";
  provider.dimensions = 2;
  return provider;
}

test("ZH-4O imports only dialogue as role-play events", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-zh4o-contract-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const datasetPath = writeFixture(directory);
  const [conversation] = loadZh4oDataset(datasetPath);
  const plan = createZh4oEventPlan(conversation, zh4oDatasetSha256(datasetPath));
  assert.equal(plan.world.frame, "fictional");
  assert.equal(plan.events.length, 3);
  assert.equal(plan.sessions.length, 2);
  assert.equal(assertZh4oEventsHaveNoGoldLabels({ conversation, plan }), true);
  const serialized = JSON.stringify(plan.events);
  assert.doesNotMatch(serialized, /This must not enter memory|赵齐最喜欢什么味道/u);
  assert.equal(plan.events[0].metadata.sourceTimeKnown, false);
  assert.deepEqual(conversation.questions[0].evidenceDialogueIds, ["S1:1"]);
});

test("ZH-4O answer prompt and context contain no fake real-world timestamps", () => {
  const context = buildZh4oRetrievedContext({
    conversation: { speakerA: "赵齐", speakerB: "白羽岚" },
    dialogueById: new Map([["S1:1", { speaker: "赵齐", text: "我最喜欢苹果味汽水。" }]]),
    candidateDialogueIds: [["S1:1"]],
  });
  const request = buildZh4oAnswerRequest({
    question: { question: "赵齐最喜欢什么？A 茶 B 汽水 C 咖啡 D 果汁 E 水" },
    context: context.context,
  });
  assert.equal(request.schemaName, ZH4O_ANSWER_SCHEMA_NAME);
  assert.match(request.input, /赵齐/u);
  assert.doesNotMatch(request.input, /2000-01/u);
  assert.match(request.systemPrompt, /只选择其中一个字母/u);
});

test("ZH-4O retrieves with the complete official multiple-choice question", () => {
  assert.equal(
    buildZh4oRetrievalQuery("赵齐和白羽岚一起种植了什么树？A 梧桐树 B 胡杨树 C 松树 D 枫树"),
    "赵齐和白羽岚一起种植了什么树？A 梧桐树 B 胡杨树 C 松树 D 枫树",
  );
  assert.equal(
    buildZh4oRetrievalQuery("Where did they first meet? A Home B School C Park D Cafe"),
    "Where did they first meet? A Home B School C Park D Cafe",
  );
  assert.equal(buildZh4oRetrievalQuery("没有选项的问题"), "没有选项的问题");
});

test("ZH-4O runs dialogue to retrieval to exact multiple-choice scoring", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-zh4o-system-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const datasetPath = writeFixture(directory);
  const generator = fixtureGenerator();
  const report = await runZh4oMemorySystemBenchmark({
    datasetPath,
    workDirectory: path.join(directory, "work"),
    generator,
    structureGenerator: null,
    retrievalContextGenerator: null,
    answerGenerator: generator,
    embeddingProvider: fixtureEmbedding(),
    maximumSemanticPasses: 0,
    retainSampleDatabases: true,
    codeRevision: { commit: "fixture-commit", dirty: false },
  });
  assert.equal(report.protocol.qaEvaluated, true);
  assert.equal(report.protocol.excludedDatasetFields.includes("qa.answer"), true);
  assert.equal(report.dataset.selectedSamples, 1);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].prediction, "B");
  assert.equal(report.results[0].correct, true);
  assert.equal(report.results[1].answerFormat, "non-choice");
  assert.equal(report.results[1].correct, false);
  assert.equal(report.scores.exactChoiceAccuracy, 1);
  assert.equal(report.scores.officialDatasetAccuracy, 0.5);
  assert.equal(report.scores.evidenceAudit.annotatedQuestions, 1);
  assert.equal(report.scores.evidenceAudit.questionHitRate, 1);
  assert.equal(report.scores.evidenceAudit.candidatePoolQuestionHitRate, 1);
  assert.equal(report.scores.evidenceAudit.contextAssemblyLossQuestions, 0);
  assert.deepEqual(report.results[0].goldEvidenceDialogueIds, ["S1:1"]);
  assert.deepEqual(report.results[0].candidateGoldEvidenceDialogueIds, ["S1:1"]);
  assert.deepEqual(report.results[0].recalledGoldEvidenceDialogueIds, ["S1:1"]);
  assert.equal(report.results[0].goldEvidenceRetrievalOutcome, "all-gold-in-answer-context");
  assert.equal(report.results[0].retrievalDiagnostics.rankedCandidates[0].rank, 1);
  assert.equal(
    report.results[0].retrievalDiagnostics.rankedCandidates[0].sourceDialogueIds.includes("S1:1"),
    true,
  );
  assert.equal(
    report.results[0].retrievalDiagnostics.goldEvidence.candidates[0].includedInAnswerContext,
    true,
  );
  assert.deepEqual(report.results[0].answerDiagnostics.rawOutput, { choice: "B" });
  assert.equal(Number.isFinite(report.results[0].retrievalLatencyMs), true);
  assert.equal(Number.isFinite(report.results[0].answerLatencyMs), true);
  assert.equal(report.results[0].context.candidateBlocks[0].status, "included");
  assert.doesNotThrow(() => JSON.stringify(report));
  assert.equal(report.dataset.selectedNonChoiceGoldQuestions, 1);
  assert.equal(report.run.candidateK, 9);
  assert.equal(report.database.sampleDatabases.length, 1);
});

test("ZH-4O retries a transient extraction failure before evaluating the sample", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-zh4o-retry-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const datasetPath = writeFixture(directory);
  const baseGenerator = fixtureGenerator();
  let extractionFailures = 0;
  const generator = async (request) => {
    if (request.schemaName === "long-term-memory-extraction-v2" && extractionFailures < 2) {
      extractionFailures += 1;
      const error = new Error("Temporary structured extraction failure.");
      error.code = "MEMORY_GENERATION_INVALID_OUTPUT";
      throw error;
    }
    return baseGenerator(request);
  };
  generator.supportsCombinedStateAnalysis = true;
  generator.supportsCombinedConsolidation = true;

  const report = await runZh4oMemorySystemBenchmark({
    datasetPath,
    workDirectory: path.join(directory, "work"),
    generator,
    structureGenerator: null,
    retrievalContextGenerator: null,
    answerGenerator: generator,
    embeddingProvider: fixtureEmbedding(),
    maximumSemanticPasses: 0,
  });

  assert.equal(extractionFailures, 2);
  assert.equal(report.samples[0].inputProcessingErrors.length, 0);
  assert.equal(report.samples[0].inputProcessingRetries.length, 1);
  assert.equal(report.samples[0].inputProcessingRetries[0].errors.length, 2);
  assert.equal(report.samples[0].inputGenerationDegradedBatches, 0);
  assert.equal(report.results[0].correct, true);
});

test("ZH-4O preserves raw evidence when extraction exhausts its retry budget", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-zh4o-fallback-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const datasetPath = writeFixture(directory);
  const baseGenerator = fixtureGenerator();
  let extractionFailures = 0;
  const generator = async (request) => {
    if (request.schemaName === "long-term-memory-extraction-v2") {
      extractionFailures += 1;
      const error = new Error("Persistent structured extraction failure.");
      error.code = "MEMORY_GENERATION_INVALID_OUTPUT";
      throw error;
    }
    return baseGenerator(request);
  };
  generator.supportsCombinedStateAnalysis = true;
  generator.supportsCombinedConsolidation = true;

  const report = await runZh4oMemorySystemBenchmark({
    datasetPath,
    workDirectory: path.join(directory, "work"),
    generator,
    structureGenerator: null,
    retrievalContextGenerator: null,
    answerGenerator: generator,
    embeddingProvider: fixtureEmbedding(),
    maximumSemanticPasses: 0,
  });

  assert.equal(extractionFailures, 3);
  assert.equal(report.samples[0].inputProcessingErrors.length, 0);
  assert.equal(report.samples[0].inputProcessingRetries[0].errors.length, 2);
  assert.equal(report.samples[0].inputGenerationDegradedBatches, 1);
  assert.equal(report.samples[0].episodicEvidenceMemories, 3);
  assert.equal(report.samples[0].memorySystemDegraded, true);
  assert.equal(report.results[0].correct, true);
});
