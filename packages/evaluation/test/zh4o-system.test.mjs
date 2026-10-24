import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openMemoryDatabase } from "@suzu-memory/core";
import { ChatHostMemoryAdapter } from '@suzu-memory/host-adapter';
import { MemoryService } from '@suzu-memory/service';
import { ZH4O_ANSWER_SCHEMA, ZH4O_ANSWER_SCHEMA_NAME, buildZh4oAnswerRequest,
  createZh4oEventPlan, assertZh4oEventsHaveNoGoldLabels, loadZh4oDataset,
  runZh4oMemorySystemBenchmark, aggregateZh4oReports } from "../src/index.mjs";

function fixture(t, sessions) {
  const base = process.env.SUZU_EVALUATION_TEST_ROOT || path.join(os.tmpdir(), "Codex", "suzu-memory-evaluation-tests");
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, "case-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const datasetPath = path.join(directory, "data.json");
  fs.writeFileSync(datasetPath, JSON.stringify([{ sample_id: "fixture", conversation: {
    speaker_a: "赵齐", speaker_b: "白羽岚",
    ...(sessions || { session_1: [
      { speaker: "白羽岚", dia_id: "S1:0", text: "欢迎，今天想喝什么？" },
      { speaker: "赵齐", dia_id: "S1:1", text: "我最喜欢苹果味汽水。" },
      { speaker: "白羽岚", dia_id: "S1:2", text: "我记住了。" },
      { speaker: "白羽岚", dia_id: "S1:3", text: "以后会准备汽水。" },
      { speaker: "赵齐", dia_id: "S1:4", text: "谢谢你。" },
    ] }),
  }, observation: "PRIVATE_GOLD_MUST_NOT_LEAK", session_summary: "PRIVATE_GOLD_MUST_NOT_LEAK",
  event_summary: "PRIVATE_GOLD_MUST_NOT_LEAK", qa: [
    { question: "赵齐喜欢什么？A 柠檬茶 B 苹果味汽水 C 咖啡 D 牛奶", answer: "B", category: 1, evidence: ["S1:1"] },
    { question: "坏标注诊断？A 甲 B 乙 C 丙 D 丁", answer: "coleção", category: 1, evidence: [] },
  ] }]));
  const config = { agentId: "production", dataRoot: path.join(directory, "production"),
    databasePath: path.join(directory, "production.db"),
    defaults: { relationshipLabel: "configured", ingestion: { maximumCoreCharacters: 12000 },
      retrieval: { maximumReturnedCandidates: 7, maximumContextChars: 4321, timeZone: "Asia/Shanghai" } },
    providers: { generation: { baseUrl: "https://fixture.invalid/v1", model: "configured-model",
      apiKeyEnv: "TEST_MEMORY_KEY", structuredOutputMode: "strict-tool", maxOutputTokens: 1024,
      maximumTransportAttempts: 1, extraBody: { configured_marker: "preserved" } } } };
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body), tool = body.tools?.[0]?.function;
    requests.push({ url: String(url), body, tool });
    const schema = tool.parameters;
    const minimal = value => value.enum ? value.enum[0] : value.type === "object"
      ? Object.fromEntries((value.required || []).map(key => [key, minimal(value.properties[key])]))
      : value.type === "array" ? [] : value.type === "boolean" ? false
      : ["number", "integer"].includes(value.type) ? (value.minimum || 0) : "";
    const output = tool.name === ZH4O_ANSWER_SCHEMA_NAME
      ? { choice: body.messages[1].content.includes("苹果味汽水") && body.messages[1].content.indexOf("苹果味汽水") < body.messages[1].content.indexOf("题目：") ? "B" : "A" }
      : minimal(schema);
    return Response.json({ model: "configured-model", choices: [{ message: { tool_calls: [{
      type: "function", function: { name: tool.name, arguments: JSON.stringify(output) },
    }] } }], usage: { prompt_tokens: 10, completion_tokens: 2 } });
  };
  return { directory, datasetPath, config, requests, fetchImpl,
    options: { datasetPath, config, fetchImpl, environment: { TEST_MEMORY_KEY: "fixture-key" }, workDirectory: path.join(directory, "work") } };
}

function databaseSnapshot(file) {
  const db = openMemoryDatabase(file, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    return JSON.stringify(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().map(row => JSON.stringify(row)).sort()]));
  } finally { db.close(); }
}

function eventExtractionFetch(f) {
  return async (url, options) => {
    const body = JSON.parse(options.body);
    if (String(url).endsWith('/embeddings')) {
      const texts = Array.isArray(body.input) ? body.input : [body.input];
      return Response.json({ model: 'fixture-vectors', data: texts.map((_, index) => ({ index, embedding: [1, 0] })),
        usage: { prompt_tokens: texts.length } });
    }
    const tool = body.tools[0].function;
    if (tool.name !== 'long-term-memory-extraction-v2') return f.fetchImpl(url, options);
    const output = { memories: [{ kind: 'event', title: '赵齐找到金色书签', content: '赵齐在图书馆找到了金色的书签。',
      subjectRole: 'user', subjectName: '赵齐', actorRoles: [], canonicalKey: '', stateFamily: 'not_applicable',
      stateLabel: '', reality: 'real', evidenceMode: 'explicit', temporalState: 'current', revisionAction: 'add',
      retentionReason: 'episodic_event', eventDate: '', eventStart: '', eventEnd: '', confidence: 0.98,
      importance: 0.8, sourceRefs: ['M0001'] }] };
    return Response.json({ model: body.model, choices: [{ message: { tool_calls: [{ type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(output) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };
}

function questionFixture(f, count, intercept = () => undefined) {
  const dataset = JSON.parse(fs.readFileSync(f.datasetPath, 'utf8'));
  const question = dataset[0].qa[0];
  dataset[0].qa = Array.from({ length: count }, (_, index) => ({ ...question,
    question: `第${index + 1}题：${question.question}`, category: index % 2 + 1 }));
  fs.writeFileSync(f.datasetPath, JSON.stringify(dataset));
  f.config.providers.generation.transportRetryDelayMs = 0;
  const calls = [];
  return { calls, options: { ...f.options, control: 'none', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    if (body.tools?.[0]?.function.name === ZH4O_ANSWER_SCHEMA_NAME) {
      const input = body.messages[1].content;
      const ordinal = Number(input.match(/第(\d+)题/u)?.[1]);
      const control = input.startsWith('题目：');
      const call = { ordinal, control, body, attempt: calls.filter(item => item.ordinal === ordinal && item.control === control).length + 1 };
      calls.push(call);
      const response = await intercept(call);
      if (response !== undefined) return response;
    }
    return f.fetchImpl(url, options);
  } } };
}

function answerResponse(choice) {
  return Response.json({ model: 'configured-model', choices: [{ message: { tool_calls: [{ type: 'function',
    function: { name: ZH4O_ANSWER_SCHEMA_NAME, arguments: JSON.stringify({ choice }) } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 } });
}

test('a failed answer is incorrect in strict and category scores without excluding other questions', async t => {
  const f = fixture(t);
  const run = questionFixture(f, 3, ({ ordinal }) => ordinal === 2 ? Response.json({ error: { message: 'temporary' } }, { status: 503 }) : undefined);
  const report = await runZh4oMemorySystemBenchmark(run.options);
  assert.deepEqual(report.results.map(row => row.status), ['completed', 'failed', 'completed']);
  assert.ok(report.results.every(row => row.scoringEligible));
  assert.equal(report.status, 'completed-with-failures');
  assert.equal(report.diagnostics.degradedSamples, 0);
  assert.equal(report.scores.exactChoiceAccuracy, 2 / 3);
  assert.equal(report.scores.completedChoiceAccuracy, 1);
  assert.equal(report.scores.failureRate, 1 / 3);
  assert.equal(report.scores.byCategory[2].exactChoiceAccuracy, 0);
  assert.equal(report.scores.byCategory[2].failures, 1);
  assert.equal(run.calls.filter(call => call.ordinal === 2).length, 3);
  assert.equal(report.results[1].attempts.answer, 3);
  assert.ok(report.results[1].context);
  assert.ok(report.results[1].retrievalDiagnostics);
});

test('temporary answer failures retry to success without changing subsequent questions', async t => {
  const f = fixture(t);
  const run = questionFixture(f, 2, ({ ordinal, attempt }) => ordinal === 1 && attempt < 3
    ? Response.json({ error: { message: 'rate limit' } }, { status: 429 }) : undefined);
  const report = await runZh4oMemorySystemBenchmark(run.options);
  assert.deepEqual(report.results.map(row => row.status), ['completed', 'completed']);
  assert.equal(report.results[0].attempts.answer, 3);
  assert.equal(report.results[1].attempts.answer, 1);
  assert.equal(report.scores.exactChoiceAccuracy, 1);
  assert.equal(report.run.generationUsage.failedRequests, 2);
});

for (const budget of [2, 3]) test(`existing provider transport retries (${budget}) are not multiplied by evaluator retries`, async t => {
  const f = fixture(t);
  const run = questionFixture(f, 2, ({ ordinal }) => ordinal === 1
    ? Response.json({ error: { message: 'temporary' } }, { status: 503 }) : undefined);
  f.config.providers.generation.maximumTransportAttempts = budget;
  const report = await runZh4oMemorySystemBenchmark(run.options);
  assert.equal(run.calls.filter(call => call.ordinal === 1).length, budget);
  assert.equal(report.results[0].attempts.answer, budget);
  assert.equal(report.results[1].status, 'completed');
});

test('an invalid answer choice fails once and preserves its raw output', async t => {
  const f = fixture(t);
  const run = questionFixture(f, 3, ({ ordinal }) => ordinal === 2 ? answerResponse('E') : undefined);
  const report = await runZh4oMemorySystemBenchmark(run.options);
  assert.deepEqual(report.results.map(row => row.status), ['completed', 'failed', 'completed']);
  assert.equal(run.calls.filter(call => call.ordinal === 2).length, 1);
  assert.equal(report.results[1].error.code, 'ZH4O_INVALID_CHOICE');
  assert.equal(report.results[1].answerDiagnostics.rawOutput.choice, 'E');
  assert.equal(report.scores.exactChoiceAccuracy, 2 / 3);
});

test('a context assertion failure is not retried and does not call the answer model', async t => {
  const f = fixture(t), run = questionFixture(f, 3);
  const original = ChatHostMemoryAdapter.prototype.beforeReply;
  let affectedCalls = 0;
  t.mock.method(ChatHostMemoryAdapter.prototype, 'beforeReply', async function (input) {
    const prepared = await original.call(this, input);
    if (input.userText.includes('第2题')) {
      affectedCalls++;
      prepared.memoryContext.content += 'context mismatch';
    }
    return prepared;
  });
  const report = await runZh4oMemorySystemBenchmark(run.options);
  assert.deepEqual(report.results.map(row => row.status), ['completed', 'failed', 'completed']);
  assert.equal(affectedCalls, 1);
  assert.equal(report.results[1].error.code, 'ZH4O_CONTEXT_MISMATCH');
  assert.equal(run.calls.filter(call => call.ordinal === 2).length, 0);
});

test('transient read-only recall failures retry without modifying retained memory', async t => {
  const f = fixture(t), run = questionFixture(f, 3);
  const first = await runZh4oMemorySystemBenchmark(run.options);
  const actualPath = first.database.sampleDatabases[0];
  const before = databaseSnapshot(actualPath);
  const search = MemoryService.prototype.search;
  let calls = 0;
  t.mock.method(MemoryService.prototype, 'search', async function (query, options) {
    if (query.includes('第2题') && ++calls < 3) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    return search.call(this, query, options);
  });
  const report = await runZh4oMemorySystemBenchmark({ ...run.options, retrievalOnly: true });
  assert.equal(calls, 3);
  assert.equal(report.results[1].attempts.retrieval, 3);
  assert.equal(report.scores.exactChoiceAccuracy, 1);
  assert.equal(databaseSnapshot(actualPath), before);
});

test('an exhausted retrieval failure counts only that question as incorrect', async t => {
  const f = fixture(t), run = questionFixture(f, 3);
  const search = MemoryService.prototype.search;
  let affectedCalls = 0;
  t.mock.method(MemoryService.prototype, 'search', async function (query, options) {
    if (query.includes('第2题')) {
      affectedCalls++;
      throw new Error('Embedding API 请求失败（HTTP 503）：unavailable');
    }
    return search.call(this, query, options);
  });
  const report = await runZh4oMemorySystemBenchmark(run.options);
  assert.equal(affectedCalls, 3);
  assert.deepEqual(report.results.map(row => row.status), ['completed', 'failed', 'completed']);
  assert.equal(report.results[1].failureStage, 'retrieval');
  assert.equal(report.results[1].scoringEligible, true);
  assert.equal(run.calls.filter(call => call.ordinal === 2).length, 0);
  assert.equal(report.scores.exactChoiceAccuracy, 2 / 3);
});

test('a failed no-memory control affects only its paired comparison', async t => {
  const f = fixture(t);
  const run = questionFixture(f, 3, ({ ordinal, control }) => ordinal === 2 && control ? answerResponse('E') : undefined);
  const report = await runZh4oMemorySystemBenchmark({ ...run.options, control: 'no-memory' });
  assert.ok(report.results.every(row => row.status === 'completed'));
  assert.equal(report.scores.exactChoiceAccuracy, 1);
  assert.equal(report.status, 'completed');
  assert.equal(report.controls.pairedQuestions, 2);
  assert.equal(report.controls.failedQuestions, 1);
  assert.equal(run.calls.filter(call => call.ordinal === 2 && call.control).length, 1);
});

test('three consecutive same-kind infrastructure failures abort the run with partial scores', async t => {
  const f = fixture(t), run = questionFixture(f, 5, () => Response.json({ error: { message: 'unavailable' } }, { status: 503 }));
  const dataset = JSON.parse(fs.readFileSync(f.datasetPath, 'utf8'));
  dataset.push({ ...dataset[0], sample_id: 'not-started' });
  fs.writeFileSync(f.datasetPath, JSON.stringify(dataset));
  const checkpoints = [];
  const report = await runZh4oMemorySystemBenchmark({ ...run.options, onCheckpoint: value => { checkpoints.push(value); } });
  assert.equal(report.status, 'aborted');
  assert.equal(report.run.abort.reason, 'repeated-infrastructure-error');
  assert.equal(report.run.abort.consecutiveFailures, 3);
  assert.equal(report.results.length, 3);
  assert.equal(report.samples.length, 1);
  assert.equal(report.diagnostics.notRunQuestions, 7);
  assert.equal(report.scores.exactChoiceAccuracy, 0);
  assert.equal(report.diagnostics.degradedSamples, 0);
  assert.equal(run.calls.length, 9);
  assert.equal(checkpoints.at(-1).status, 'aborted');
  assert.equal(checkpoints.at(-1).results.length, 3);
  assert.equal(fs.readdirSync(path.join(f.options.workDirectory, 'samples')).length, 1);
});

test('a successful question resets the consecutive infrastructure failure count', async t => {
  const f = fixture(t), run = questionFixture(f, 6, ({ ordinal }) => [1, 2, 4, 5].includes(ordinal)
    ? Response.json({ error: { message: 'unavailable' } }, { status: 503 }) : undefined);
  const report = await runZh4oMemorySystemBenchmark(run.options);
  assert.equal(report.status, 'completed-with-failures');
  assert.equal(report.results.length, 6);
  assert.equal(report.run.abort, null);
  assert.equal(report.scores.exactChoiceAccuracy, 2 / 6);
});

test('different consecutive infrastructure errors do not count as three identical failures', async t => {
  const f = fixture(t), run = questionFixture(f, 4, ({ ordinal }) => ordinal <= 3
    ? Response.json({ error: { message: 'unavailable' } }, { status: [0, 503, 429, 502][ordinal] }) : undefined);
  const report = await runZh4oMemorySystemBenchmark(run.options);
  assert.equal(report.status, 'completed-with-failures');
  assert.equal(report.results.length, 4);
  assert.equal(report.run.abort, null);
  assert.equal(report.scores.exactChoiceAccuracy, 1 / 4);
});

test('authentication failure aborts promptly and resume preserves prior results, usage and memory', async t => {
  const f = fixture(t), run = questionFixture(f, 4, ({ ordinal }) => ordinal === 2
    ? Response.json({ error: { message: 'invalid key' } }, { status: 401 }) : undefined);
  const aborted = await runZh4oMemorySystemBenchmark(run.options);
  assert.equal(aborted.status, 'aborted');
  assert.equal(aborted.results.length, 2);
  assert.equal(aborted.results[0].correct, true);
  assert.equal(aborted.results[1].error.status, 401);
  assert.equal(run.calls.filter(call => call.ordinal === 2).length, 1);
  const before = databaseSnapshot(aborted.database.sampleDatabases[0]);
  const resumedCalls = [];
  const resumed = await runZh4oMemorySystemBenchmark({ ...run.options, resumeReport: JSON.parse(JSON.stringify(aborted)),
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.tools[0].function.name, ZH4O_ANSWER_SCHEMA_NAME, 'resume must not repeat memory preparation');
      resumedCalls.push(Number(body.messages[1].content.match(/第(\d+)题/u)[1]));
      return f.fetchImpl(url, options);
    } });
  assert.deepEqual(resumedCalls, [3, 4]);
  assert.deepEqual(resumed.results.slice(0, 2), aborted.results);
  assert.equal(resumed.run.resumptions, 1);
  assert.equal(resumed.status, 'completed-with-failures');
  assert.equal(resumed.run.generationUsage.requests, aborted.run.generationUsage.requests + 2);
  assert.equal(resumed.run.generationUsage.failedRequests, aborted.run.generationUsage.failedRequests);
  assert.equal(resumed.scores.exactChoiceAccuracy, 3 / 4);
  assert.equal(resumed.diagnostics.notRunQuestions, 0);
  assert.equal(databaseSnapshot(aborted.database.sampleDatabases[0]), before);
});

test('resume rejects incompatible selections and corrupt duplicate results before provider calls', async t => {
  const f = fixture(t), run = questionFixture(f, 3);
  const aborted = await runZh4oMemorySystemBenchmark({ ...run.options, onProgress() { throw new Error('stop progress'); } });
  const blocked = () => { throw new Error('must not contact provider'); };
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...run.options, fetchImpl: blocked,
    resumeReport: aborted, candidateK: 99 }), /Checkpoint does not match/);
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...run.options, fetchImpl: blocked,
    resumeReport: { ...aborted, results: [...aborted.results, ...aborted.results] } }), /invalid or duplicate question/);
  for (const change of [
    row => { row.scoringEligible = false; },
    row => { row.category = 999; },
    row => { row.control = { status: 'completed', prediction: 'D', correct: true }; },
  ]) {
    const corrupt = structuredClone(aborted);
    change(corrupt.results[0]);
    await assert.rejects(runZh4oMemorySystemBenchmark({ ...run.options, fetchImpl: blocked, resumeReport: corrupt }), /invalid or duplicate question/);
  }
});

test("host import preserves leading assistants, consecutive roles and an unpaired tail without labels", t => {
  const f = fixture(t), [conversation] = loadZh4oDataset(f.datasetPath);
  const plan = createZh4oEventPlan(conversation);
  assert.equal(assertZh4oEventsHaveNoGoldLabels({ conversation, plan }), true);
  assert.deepEqual(plan.events.map(event => event.actor.role), ["companion", "user", "companion", "companion", "user"]);
  assert.equal(plan.events.length, 5);
  assert.equal(plan.world.frame, "fictional");
  assert.ok(plan.events.every(event => event.metadata.sourceTimeKnown === false));
  assert.doesNotMatch(JSON.stringify(plan.events), /PRIVATE_GOLD_MUST_NOT_LEAK|赵齐喜欢什么/);
});

test("configured host pipeline supplies actual memory context, keeps parameters and reports paired controls", async t => {
  const f = fixture(t);
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, includeSourceDiagnostics: true });
  assert.equal(report.diagnostics.degradedSamples, 0, JSON.stringify(report.samples));
  assert.equal(report.results[0].correct, true);
  assert.equal(report.scores.exactChoiceAccuracy, 1);
  assert.equal(report.controls.pairedQuestions, 1);
  assert.equal(report.controls.noMemoryAccuracy, 0);
  assert.equal(report.database.sampleDatabases.length, 1);
  assert.equal(report.samples[0].effectiveDefaults.ingestion.maximumCoreCharacters, 12000);
  assert.equal(report.samples[0].effectiveDefaults.retrieval.maximumReturnedCandidates, 7);
  assert.equal(report.samples[0].effectiveDefaults.retrieval.maximumContextChars, 4321);
  assert.equal(report.samples[0].imported, 5);
  assert.equal(fs.existsSync(f.config.databasePath), false);
  const answers = f.requests.filter(request => request.tool.name === ZH4O_ANSWER_SCHEMA_NAME);
  assert.ok(answers[0].body.messages[1].content.startsWith(report.results[0].context.context));
  assert.doesNotMatch(answers[0].body.messages[1].content, /2000-\d{2}-\d{2}/);
  assert.ok(!answers[0].body.messages[1].content.includes("[召回片段"));
  assert.match(report.results[0].sourceReplayDiagnostic.context, /召回片段/);
  assert.ok(report.results[0].recalledGoldEvidenceDialogueIds.includes("S1:1"));
  assert.ok(f.requests.every(request => request.body.model === "configured-model" && request.body.max_tokens === 1024
    && request.body.configured_marker === "preserved"));
  assert.ok(f.requests.every(request => !JSON.stringify(request.body).includes("PRIVATE_GOLD_MUST_NOT_LEAK")));
  assert.ok(f.requests.filter(request => request.tool.name !== ZH4O_ANSWER_SCHEMA_NAME)
    .every(request => !request.body.messages[1].content.includes("赵齐喜欢什么")));
  assert.deepEqual(ZH4O_ANSWER_SCHEMA.properties.choice.enum, ["A", "B", "C", "D"]);
  assert.doesNotMatch(buildZh4oAnswerRequest({ question: { question: "测试 A 甲 B 乙 C 丙 D 丁" } }).systemPrompt, /A 到 E/);
});

test("retained database reruns only read-only recall and answers without any maintenance or input changes", async t => {
  const f = fixture(t);
  const first = await runZh4oMemorySystemBenchmark(f.options);
  assert.equal(first.diagnostics.degradedSamples, 0, JSON.stringify(first.samples));
  const before = databaseSnapshot(first.database.sampleDatabases[0]);
  f.requests.length = 0;
  const rerun = await runZh4oMemorySystemBenchmark({ ...f.options, retrievalOnly: true });
  assert.equal(rerun.diagnostics.degradedSamples, 0, JSON.stringify(rerun.samples));
  assert.equal(rerun.samples[0].imported, 0);
  assert.equal(rerun.samples[0].maintenanceCalls, 0);
  assert.ok(f.requests.every(request => request.tool.name === ZH4O_ANSWER_SCHEMA_NAME));
  assert.equal(databaseSnapshot(first.database.sampleDatabases[0]), before);
  await assert.rejects(runZh4oMemorySystemBenchmark(f.options), /Sample database exists/);
  assert.equal(databaseSnapshot(first.database.sampleDatabases[0]), before);
});

test('read-only reruns cannot reinitialize identities using changed query configuration', async t => {
  const f = fixture(t);
  const first = await runZh4oMemorySystemBenchmark({ ...f.options, control: 'none' });
  const before = databaseSnapshot(first.database.sampleDatabases[0]);
  const config = structuredClone(f.config);
  config.defaults.relationshipLabel = 'query-only-label';
  config.defaults.defaultWorldId = 'query-only-world';
  const rerun = await runZh4oMemorySystemBenchmark({ ...f.options, config, retrievalOnly: true, control: 'none' });
  assert.equal(rerun.diagnostics.degradedSamples, 0, JSON.stringify(rerun.samples));
  assert.equal(databaseSnapshot(first.database.sampleDatabases[0]), before);
});

for (const field of ['baseUrl', 'type', 'endpoint', 'extraBody']) test(`retained vectors reject a different embedding ${field} before any request`, async t => {
  const f = fixture(t);
  f.config.providers.embedding = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-vectors', dimensions: 2, apiKeyEnv: 'TEST_MEMORY_KEY' };
  const requests = [];
  const base = eventExtractionFetch(f);
  const fetchImpl = (url, options) => { requests.push(String(url)); return base(url, options); };
  const options = { ...f.options, fetchImpl, control: 'none' };
  const first = await runZh4oMemorySystemBenchmark(options);
  assert.equal(first.diagnostics.degradedSamples, 0, JSON.stringify(first.samples));
  const config = structuredClone(f.config);
  config.providers.embedding[field] = { baseUrl: 'https://another.invalid/v1', type: 'dashscope',
    endpoint: 'different-embeddings', extraBody: { task: 'different-space' } }[field];
  requests.length = 0;
  const before = databaseSnapshot(first.database.sampleDatabases[0]);
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...options, config, retrievalOnly: true }), /Retained embedding/);
  assert.deepEqual(requests, []);
  assert.equal(databaseSnapshot(first.database.sampleDatabases[0]), before);
});

test('embedding credential rotation keeps the same index, while disabling vectors permits a different provider', async t => {
  const f = fixture(t);
  f.config.providers.embedding = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-vectors', dimensions: 2, apiKeyEnv: 'TEST_MEMORY_KEY' };
  const options = { ...f.options, fetchImpl: eventExtractionFetch(f), control: 'none' };
  const first = await runZh4oMemorySystemBenchmark(options);
  const before = databaseSnapshot(first.database.sampleDatabases[0]);
  const config = structuredClone(f.config);
  config.providers.embedding.apiKeyEnv = 'ROTATED_KEY';
  config.providers.embedding.timeoutMs = 60_000;
  const rerun = await runZh4oMemorySystemBenchmark({ ...options, config, retrievalOnly: true,
    environment: { TEST_MEMORY_KEY: 'fixture-key', ROTATED_KEY: 'rotated-key' } });
  assert.equal(rerun.diagnostics.degradedSamples, 0, JSON.stringify(rerun.samples));
  config.providers.embedding.baseUrl = 'https://another.invalid/v1';
  const disabled = await runZh4oMemorySystemBenchmark({ ...options, config, retrievalOnly: true, withoutEmbedding: true });
  assert.equal(disabled.diagnostics.degradedSamples, 0, JSON.stringify(disabled.samples));
  assert.equal(databaseSnapshot(first.database.sampleDatabases[0]), before);
});

test("length scheduling waits for a following round and short tails flush through the host", async t => {
  const turns = Array.from({ length: 3 }, (_, n) => [
    { speaker: "赵齐", dia_id: `S1:${n * 2 + 1}`, text: "苹果味汽水".padEnd(400, "甲") },
    { speaker: "白羽岚", dia_id: `S1:${n * 2 + 2}`, text: "回复".padEnd(100, "乙") },
  ]).flat();
  const f = fixture(t, { session_1: turns });
  f.config.defaults.ingestion.maximumCoreCharacters = 1000;
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, control: "none" });
  assert.equal(report.diagnostics.degradedSamples, 0, JSON.stringify(report.samples));
  const processed = report.samples[0].inputBatches.filter(batch => batch.status === "processed");
  assert.equal(processed.length, 2);
  assert.equal(processed[0].eventsProcessed, 4);
  assert.equal(processed[1].eventsProcessed, 2);
  assert.equal(report.samples[0].maintenanceCalls, 3);
  assert.equal(report.samples[0].finalProgress.total, 0);
});

for (const advancing of [true, false]) test(`final drain distinguishes completed work from a stalled queue (advancing=${advancing})`, async t => {
  const f = fixture(t);
  const original = ChatHostMemoryAdapter.prototype.onSessionEnd;
  let calls = 0;
  t.mock.method(ChatHostMemoryAdapter.prototype, 'onSessionEnd', async function (options) {
    const result = await original.call(this, options);
    calls++;
    if (advancing && calls === 7) return result;
    return { ...result, progress: { total: 1, failures: 0,
      pending: { inputEvents: 0, tasks: 1, stateRequests: 0, consolidation: 0 },
      completed: { tasks: advancing ? calls : 0, stateRequests: 0, consolidation: 0 },
      deferred: { tasks: 0 } } };
  });
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, control: 'none', maximumDrainPasses: 10 });
  assert.equal(calls, advancing ? 7 : 4);
  assert.equal(report.diagnostics.degradedSamples, 0);
  assert.ok(report.results.every(row => row.status === 'completed' && row.scoringEligible));
  assert.equal(report.diagnostics.memoryPreparation.pendingWork, advancing ? 0 : 1);
});

test('an interrupted progress callback retains eligible completed answers in an aborted run', async t => {
  const f = fixture(t);
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, control: 'none',
    onProgress() { throw new Error('progress stream closed'); } });
  assert.equal(report.status, 'aborted');
  assert.equal(report.diagnostics.degradedSamples, 0);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, 'completed');
  assert.equal(report.results[0].prediction, 'B');
  assert.ok(report.results[0].answerDiagnostics);
  assert.ok(report.results[0].context);
  assert.ok(report.results.every(row => row.scoringEligible === true));
  assert.equal(report.scores.exactChoiceAccuracy, 1);
  assert.equal(report.diagnostics.notRunQuestions, 1);
  assert.match(report.run.abort.error.message, /progress stream closed/);
  assert.deepEqual(report.samples[0].preparationErrors, []);
});

for (const embedding of [false, true]) test(`nonempty extraction remains scoreable while structure accumulates (embedding=${embedding})`, async t => {
  const f = fixture(t, { session_1: [
    { speaker: '赵齐', dia_id: 'S1:1', text: '我们刚刚在图书馆找到了金色的书签。' },
    { speaker: '白羽岚', dia_id: 'S1:2', text: '我记住你找到金色书签这件事了。' },
  ] });
  if (embedding) f.config.providers.embedding = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-vectors',
    dimensions: 2, apiKeyEnv: 'TEST_MEMORY_KEY' };
  const options = { ...f.options, fetchImpl: eventExtractionFetch(f), control: 'none' };
  const report = await runZh4oMemorySystemBenchmark(options);
  assert.equal(report.diagnostics.degradedSamples, 0, JSON.stringify(report.samples));
  assert.equal(report.samples[0].inputBatches.find(batch => batch.status === 'processed').memoriesStored, 1);
  assert.equal(report.samples[0].finalProgress.total, 0);
  assert.ok(report.samples[0].finalProgress.deferred.tasks >= 1);
  assert.equal(report.samples[0].finalProgress.failures, 0);
  assert.equal(report.results[0].status, 'completed');
  const before = databaseSnapshot(report.database.sampleDatabases[0]);
  const rerun = await runZh4oMemorySystemBenchmark({ ...options, retrievalOnly: true });
  assert.equal(rerun.diagnostics.degradedSamples, 0, JSON.stringify(rerun.samples));
  assert.equal(databaseSnapshot(report.database.sampleDatabases[0]), before);
});

test('truncated recall cannot claim gold source text that appears only in provenance or the question', async t => {
  const f = fixture(t);
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, maximumContextCharacters: 1, control: 'none' });
  const row = report.results[0];
  assert.equal(row.status, 'completed');
  assert.ok(row.context.sourceDialogueIds.includes('S1:1'));
  assert.ok(row.fragmentSourceGoldEvidenceDialogueIds.includes('S1:1'));
  assert.doesNotMatch(row.context.context, /苹果味汽水/);
  assert.ok(row.retrievalQuery.includes('苹果味汽水'));
  assert.equal(row.context.contextTruncated, true);
  assert.deepEqual(row.recalledGoldEvidenceDialogueIds, []);
  assert.equal(row.goldEvidenceQuestionHit, false);
  assert.equal(row.goldEvidenceDiagnostics[0].associatedWithFragment, true);
  assert.equal(row.goldEvidenceDiagnostics[0].includedInAnswerContext, false);
  assert.equal(report.scores.evidenceAudit.questionHits, 0);
  assert.equal(report.scores.evidenceAudit.fragmentSourceQuestionHits, 1);
});

test('retrieval-only reports retain the configuration used to build each sample and refuse a mixed score', async t => {
  const f = fixture(t), [first] = JSON.parse(fs.readFileSync(f.datasetPath, 'utf8'));
  fs.writeFileSync(f.datasetPath, JSON.stringify([first, { ...first, sample_id: 'second' }]));
  const changed = structuredClone(f.config);
  changed.defaults.ingestion.maximumCoreCharacters = 500;
  const options = { ...f.options, maximumSamples: 1, control: 'none' };
  await runZh4oMemorySystemBenchmark(options);
  await runZh4oMemorySystemBenchmark({ ...options, config: changed, startSample: 1 });
  const firstRerun = await runZh4oMemorySystemBenchmark({ ...options, retrievalOnly: true });
  const secondRerun = await runZh4oMemorySystemBenchmark({ ...options, retrievalOnly: true, startSample: 1 });
  assert.equal(firstRerun.run.configSha256, secondRerun.run.configSha256);
  assert.notEqual(firstRerun.samples[0].preparation.configSha256, secondRerun.samples[0].preparation.configSha256);
  assert.throws(() => aggregateZh4oReports([firstRerun, secondRerun]), /original memory preparation configurations/);
});

for (const difference of ['code', 'embedding']) test(`original ${difference} preparation identity survives a common read-only rerun`, async t => {
  const f = fixture(t), [first] = JSON.parse(fs.readFileSync(f.datasetPath, 'utf8'));
  fs.writeFileSync(f.datasetPath, JSON.stringify([first, { ...first, sample_id: 'second' }]));
  f.config.providers.embedding = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-vectors', dimensions: 2, apiKeyEnv: 'TEST_MEMORY_KEY' };
  const options = { ...f.options, fetchImpl: eventExtractionFetch(f), maximumSamples: 1, control: 'none',
    codeRevision: { commit: 'build-A', dirty: false } };
  await runZh4oMemorySystemBenchmark(options);
  await runZh4oMemorySystemBenchmark({ ...options, startSample: 1,
    ...(difference === 'embedding' ? { withoutEmbedding: true } : { codeRevision: { commit: 'build-B', dirty: false } }) });
  const query = { ...options, retrievalOnly: true, withoutEmbedding: true, codeRevision: { commit: 'query-build', dirty: false } };
  const left = await runZh4oMemorySystemBenchmark(query);
  const right = await runZh4oMemorySystemBenchmark({ ...query, startSample: 1 });
  assert.deepEqual(left.run.codeRevision, right.run.codeRevision);
  assert.deepEqual(left.run.overrides, right.run.overrides);
  assert.equal(left.samples[0].preparation.configSha256, right.samples[0].preparation.configSha256);
  assert.notDeepEqual(left.samples[0].preparation, right.samples[0].preparation);
  assert.throws(() => aggregateZh4oReports([left, right]), /original memory preparation configurations/);
});

test('nonempty event continuity receives no synthetic calendar dates at the model boundary', async t => {
  const f = fixture(t, { session_1: [
    { speaker: '赵齐', dia_id: 'S1:1', text: '我们在图书馆找到了金色书签。' },
    { speaker: '白羽岚', dia_id: 'S1:2', text: '这次找到书签的经过我记住了。' },
    { speaker: '赵齐', dia_id: 'S1:3', text: '我们又在阅览室找到了银色书签。' },
    { speaker: '白羽岚', dia_id: 'S1:4', text: '这次是另一枚书签。' },
  ] });
  f.config.providers.embedding = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture-vectors', dimensions: 2, apiKeyEnv: 'TEST_MEMORY_KEY' };
  const base = eventExtractionFetch(f), continuityInputs = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body), tool = body.tools?.[0]?.function;
    if (tool?.name === 'long-term-memory-extraction-v2') {
      const response = await base(url, options), data = await response.json();
      const memories = JSON.parse(data.choices[0].message.tool_calls[0].function.arguments).memories;
      memories.push({ ...memories[0], title: '赵齐找到银色书签', content: '赵齐在阅览室找到了银色书签。', sourceRefs: ['M0003'] });
      data.choices[0].message.tool_calls[0].function.arguments = JSON.stringify({ memories });
      return Response.json(data);
    }
    if (tool?.name !== 'memory-event-continuity-v1') return base(url, options);
    const input = JSON.parse(body.messages[1].content);
    continuityInputs.push(input);
    const output = { matches: input.events.map(({ memoryId }) => ({ memoryId, resolution: 'new',
      candidateId: '', relation: '', evidenceSourceIds: [], rationale: '原文记录了另一件事。' })) };
    return Response.json({ model: body.model, choices: [{ message: { tool_calls: [{ type: 'function',
      function: { name: tool.name, arguments: JSON.stringify(output) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  };
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, fetchImpl, control: 'none' });
  assert.equal(report.diagnostics.degradedSamples, 0, JSON.stringify(report.samples));
  assert.ok(continuityInputs.length > 0);
  for (const input of continuityInputs) {
    assert.doesNotMatch(JSON.stringify(input), /2000-01-02/);
    const memory = input.memories.find(item => item.id === input.events[0].memoryId);
    assert.equal(memory.sourceTimeKnown, false);
    assert.equal(memory.sources[0].occurredAt, null);
  }
});

test("persistent extraction failure retains original input but excludes every question in that sample", async t => {
  const f = fixture(t), fetch = f.fetchImpl;
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, fetchImpl: (url, options) => {
    const tool = JSON.parse(options.body).tools[0].function;
    if (tool.name.includes("extraction")) return Response.json({ error: { message: "temporary" } }, { status: 503 });
    return fetch(url, options);
  } });
  assert.equal(report.diagnostics.degradedSamples, 1);
  assert.equal(report.scores.completed, 0);
  assert.equal(report.scores.exactChoiceAccuracy, null);
  assert.ok(report.results.every(row => row.scoringEligible === false));
  assert.ok(fs.existsSync(report.database.sampleDatabases[0]));
  assert.ok(!f.requests.some(request => request.tool.name === ZH4O_ANSWER_SCHEMA_NAME));
});

for (const stage of ['runSemanticMaintenance', 'runEmbeddingMaintenance']) test(`an application ${stage} failure stays scored and remains in retained diagnostics`, async t => {
  const f = fixture(t);
  const original = MemoryService.prototype[stage];
  t.mock.method(MemoryService.prototype, stage, async function (options) {
    await original.call(this, options);
    throw Object.assign(new Error('injected maintenance storage failure'), { code: 'FIXTURE_MAINTENANCE_FAILURE' });
  });
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, control: 'none' });
  assert.equal(report.samples[0].finalProgress.total, 0);
  assert.equal(report.diagnostics.degradedSamples, 0);
  assert.equal(report.scores.completed, 2);
  assert.ok(report.samples[0].maintenanceFailures.length > 0);
  assert.match(JSON.stringify(report.samples[0].maintenanceFailures), /FIXTURE_MAINTENANCE_FAILURE/);
  assert.ok(f.requests.some(request => request.tool.name === ZH4O_ANSWER_SCHEMA_NAME));
  const plan = createZh4oEventPlan(loadZh4oDataset(f.datasetPath)[0], report.dataset.sha256);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.options.workDirectory, 'samples', plan.agentId, 'benchmark.json'), 'utf8'));
  assert.equal(manifest.degraded, false);
  const failures = JSON.parse(JSON.stringify(report.samples[0].maintenanceFailures));
  assert.deepEqual(manifest.maintenance.failures, failures);
  const rerun = await runZh4oMemorySystemBenchmark({ ...f.options, retrievalOnly: true, control: 'none' });
  assert.equal(rerun.diagnostics.degradedSamples, 0);
  assert.deepEqual(rerun.samples[0].maintenanceFailures, failures);
});

test("preflight rejects missing configured credentials before creating a run or contacting a provider", async t => {
  const f = fixture(t);
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...f.options, environment: {} }), /TEST_MEMORY_KEY/);
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.options.workDirectory), false);
});

test('rebuilding one sample replaces only its database and answers, retaining other samples and total costs', async t => {
  const f = fixture(t);
  const dataset = JSON.parse(fs.readFileSync(f.datasetPath, 'utf8'));
  dataset.push({ ...structuredClone(dataset[0]), sample_id: 'other' });
  fs.writeFileSync(f.datasetPath, JSON.stringify(dataset));
  const options = { ...f.options, control: 'none' };
  const first = await runZh4oMemorySystemBenchmark(options);
  const untouched = first.samples.find(sample => sample.sampleId === 'other');
  const before = databaseSnapshot(untouched.databasePath);
  const original = first.samples.find(sample => sample.sampleId === 'fixture');
  const originalData = databaseSnapshot(original.databasePath);
  const rebuilt = await runZh4oMemorySystemBenchmark({ ...options, resumeReport: first, rebuildSample: 'fixture' });
  assert.equal(rebuilt.results.length, first.results.length);
  assert.deepEqual(rebuilt.results.filter(row => row.sampleId === 'other'), first.results.filter(row => row.sampleId === 'other'));
  assert.deepEqual(rebuilt.samples.find(sample => sample.sampleId === 'other'), untouched);
  assert.equal(databaseSnapshot(untouched.databasePath), before);
  const current = rebuilt.samples.find(sample => sample.sampleId === 'fixture');
  assert.notEqual(current.preparationId, original.preparationId);
  assert.equal(current.rebuildPending, undefined);
  assert.equal(rebuilt.run.rebuilds.length, 1);
  const backup = rebuilt.run.rebuilds[0].backupPath;
  const plan = createZh4oEventPlan(loadZh4oDataset(f.datasetPath)[0], first.dataset.sha256);
  const relativeDatabase = path.relative(path.join(options.workDirectory, 'samples', plan.agentId), original.databasePath);
  assert.equal(databaseSnapshot(path.join(backup, relativeDatabase)), originalData);
  assert.ok(rebuilt.run.generationUsage.requests > first.run.generationUsage.requests);
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...options, resumeReport: first }), /preparation differs/);
});

test('an interrupted rebuild checkpoint clears old answers before moving data and can be retried explicitly', async t => {
  const f = fixture(t), options = { ...f.options, control: 'none' };
  const first = await runZh4oMemorySystemBenchmark(options);
  const before = databaseSnapshot(first.samples[0].databasePath);
  let pending;
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...options, resumeReport: first, rebuildSample: 'fixture',
    onCheckpoint(report) { pending = structuredClone(report); throw new Error('interrupted before moving data'); } }), /interrupted/);
  assert.equal(pending.results.length, 0);
  assert.equal(pending.samples[0].rebuildPending, true);
  assert.equal(databaseSnapshot(first.samples[0].databasePath), before);
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...options, resumeReport: pending }), /unfinished rebuild/);
  const rebuilt = await runZh4oMemorySystemBenchmark({ ...options, resumeReport: pending, rebuildSample: 'fixture' });
  assert.equal(rebuilt.status, 'completed');
  assert.equal(rebuilt.results.length, first.results.length);
  assert.notEqual(rebuilt.samples[0].preparationId, first.samples[0].preparationId);
});

test('rebuild validation rejects unknown IDs and incompatible options before changing retained data', async t => {
  const f = fixture(t), options = { ...f.options, control: 'none' };
  const first = await runZh4oMemorySystemBenchmark(options);
  const before = databaseSnapshot(first.samples[0].databasePath), requests = f.requests.length;
  for (const extra of [{ rebuildSample: '../outside', resumeReport: first }, { rebuildSample: 'fixture' },
    { rebuildSample: 'fixture', resumeReport: first, retrievalOnly: true }]) {
    await assert.rejects(runZh4oMemorySystemBenchmark({ ...options, ...extra }), /Rebuild sample|rebuildSample/);
  }
  assert.equal(f.requests.length, requests);
  assert.equal(databaseSnapshot(first.samples[0].databasePath), before);
});

test('full conversation controls receive every source turn without recall truncation or gold labels', async t => {
  const f = fixture(t, { session_1: [
    { speaker: '赵齐', dia_id: 'S1:1', text: '我喜欢苹果味汽水。' + '甲'.repeat(5000) },
    { speaker: '白羽岚', dia_id: 'S1:2', text: '原文末尾确认。' + '乙'.repeat(1000) },
  ], session_2: [{ speaker: '赵齐', dia_id: 'S2:1', text: '第二次会话的完整尾句。' }] });
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, control: 'both' });
  const controls = f.requests.filter(request => request.tool.name === ZH4O_ANSWER_SCHEMA_NAME
    && request.body.messages[1].content.includes('会话 1：'));
  assert.equal(controls.length, 2);
  const source = loadZh4oDataset(f.datasetPath)[0];
  for (const request of controls) {
    const input = request.body.messages[1].content;
    let cursor = -1;
    for (const turn of source.sessions.flatMap(session => session.turns)) {
      const next = input.indexOf(`${turn.speaker}：${turn.text}`, cursor + 1);
      assert.ok(next > cursor); cursor = next;
    }
    assert.doesNotMatch(input, /PRIVATE_GOLD_MUST_NOT_LEAK|2000-01-0|coleção/);
  }
  assert.ok(report.samples[0].fullContextCharacters > f.config.defaults.retrieval.maximumContextChars);
  assert.equal(report.controls.fullContextQuestions, 1);
  assert.equal(report.controls.fullContextAccuracy, 1);
  assert.equal(report.run.generationUsage.byPhase['full-context-control'], 2);
  assert.ok(report.results.every(row => row.control && row.fullContextControl));
});

test('full-context failures count as incorrect only in that control group', async t => {
  const f = fixture(t);
  const run = questionFixture(f, 2, ({ body, ordinal }) => body.messages[1].content.includes('会话 1：') && ordinal === 1
    ? Response.json({ error: { message: 'temporarily unavailable' } }, { status: 503 }) : undefined);
  const report = await runZh4oMemorySystemBenchmark({ ...run.options, control: 'both' });
  assert.equal(report.scores.exactChoiceAccuracy, 1);
  assert.equal(report.controls.fullContextQuestions, 2);
  assert.equal(report.controls.fullContextFailedQuestions, 1);
  assert.equal(report.controls.fullContextAccuracy, 0.5);
  assert.equal(report.results[0].status, 'completed');
  assert.equal(report.results[0].control.status, 'completed');
  assert.equal(report.results[0].fullContextControl.status, 'failed');
});

test('control groups still answer independently when the main memory answer fails', async t => {
  const f = fixture(t);
  const run = questionFixture(f, 1, ({ control, body }) => answerResponse(
    control || body.messages[1].content.includes('会话 1：') ? 'B' : 'invalid'));
  const report = await runZh4oMemorySystemBenchmark({ ...run.options, control: 'both' });
  assert.equal(report.results[0].status, 'failed');
  assert.equal(report.results[0].control.status, 'completed');
  assert.equal(report.results[0].fullContextControl.status, 'completed');
  assert.equal(report.scores.exactChoiceAccuracy, 0);
  assert.equal(report.controls.noMemoryStrictAccuracy, 1);
  assert.equal(report.controls.fullContextAccuracy, 1);
  assert.equal(report.controls.pairedQuestions, 0);
  assert.equal(report.controls.fullContextPairedQuestions, 0);
});

test('quarantined over-budget input remains in the scored sample and its diagnostic count', async t => {
  const f = fixture(t, { session_1: [{ speaker: '赵齐', dia_id: 'S1:1', text: '苹果味汽水'.padEnd(70000, '甲') }] });
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, control: 'none' });
  assert.equal(report.diagnostics.degradedSamples, 0);
  assert.equal(report.diagnostics.memoryPreparation.quarantinedMessages, 1);
  assert.equal(report.scores.completed, 2);
  assert.ok(report.results.every(row => row.scoringEligible));
});

test('invalid extraction output falls back to raw evidence but remains scored', async t => {
  const f = fixture(t);
  const report = await runZh4oMemorySystemBenchmark({ ...f.options, control: 'none', fetchImpl: (url, options) => {
    const tool = JSON.parse(options.body).tools?.[0]?.function;
    if (!tool?.name.includes('extraction')) return f.fetchImpl(url, options);
    return Response.json({ model: 'configured-model', choices: [{ message: { tool_calls: [{ type: 'function',
      function: { name: tool.name, arguments: JSON.stringify({ memories: 'invalid' }) } }] } }] });
  } });
  assert.equal(report.diagnostics.degradedSamples, 0);
  assert.equal(report.diagnostics.memoryPreparation.archiveOnlyBatches, 2);
  assert.equal(report.scores.completed, 2);
  assert.ok(report.results.every(row => row.scoringEligible));
});

test('single-sample rebuild accepts a damaged manifest and missing database without reusing stale answers', async t => {
  const f = fixture(t), options = { ...f.options, control: 'none' };
  const first = await runZh4oMemorySystemBenchmark(options);
  const plan = createZh4oEventPlan(loadZh4oDataset(f.datasetPath)[0], first.dataset.sha256);
  const manifest = path.join(options.workDirectory, 'samples', plan.agentId, 'benchmark.json');
  fs.writeFileSync(manifest, '{damaged');
  fs.rmSync(first.samples[0].databasePath);
  const rebuilt = await runZh4oMemorySystemBenchmark({ ...options, resumeReport: first, rebuildSample: 'fixture' });
  assert.equal(rebuilt.status, 'completed');
  assert.equal(rebuilt.results.length, first.results.length);
  assert.notEqual(rebuilt.samples[0].preparationId, first.samples[0].preparationId);
});

test('preparation is checkpointed before database initialization or provider calls and an interrupted entry can be rebuilt', async t => {
  const f = fixture(t), options = { ...f.options, control: 'none' };
  let checkpoint;
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...options, onCheckpoint(report) {
    checkpoint = structuredClone(report);
    assert.equal(fs.existsSync(report.samples[0].databasePath), false);
    throw new Error('interrupt before initialization');
  } }), /interrupt before initialization/);
  assert.equal(f.requests.length, 0);
  assert.equal(checkpoint.samples[0].preparationPending, true);
  assert.equal(checkpoint.results.length, 0);
  const rebuilt = await runZh4oMemorySystemBenchmark({ ...options, resumeReport: checkpoint, rebuildSample: 'fixture' });
  assert.equal(rebuilt.status, 'completed');
  assert.equal(rebuilt.results.length, 2);
  assert.equal(rebuilt.samples[0].preparationPending, undefined);
});

test('an unregistered partial sample can be explicitly rebuilt while the completed sample remains unchanged', async t => {
  const f = fixture(t);
  const dataset = JSON.parse(fs.readFileSync(f.datasetPath, 'utf8'));
  dataset.push({ ...structuredClone(dataset[0]), sample_id: 'other' });
  fs.writeFileSync(f.datasetPath, JSON.stringify(dataset));
  const options = { ...f.options, control: 'none' };
  let beforeSecond;
  const full = await runZh4oMemorySystemBenchmark({ ...options, onCheckpoint(report) {
    if (report.samples.length === 1 && report.results.length === 2) beforeSecond = structuredClone(report);
  } });
  const firstData = databaseSnapshot(full.samples[0].databasePath);
  const plan = createZh4oEventPlan(loadZh4oDataset(f.datasetPath)[1], full.dataset.sha256);
  fs.rmSync(path.join(options.workDirectory, 'samples', plan.agentId, 'benchmark.json'));
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...options, resumeReport: beforeSecond }), /Sample database exists/);
  const repaired = await runZh4oMemorySystemBenchmark({ ...options, resumeReport: beforeSecond, rebuildSample: 'other' });
  assert.equal(repaired.status, 'completed');
  assert.equal(repaired.results.length, 4);
  assert.deepEqual(repaired.results.filter(row => row.sampleId === 'fixture'), beforeSecond.results);
  assert.equal(databaseSnapshot(full.samples[0].databasePath), firstData);
  assert.ok(fs.existsSync(repaired.run.rebuilds[0].backupPath));
});

test('a completed database can resume from its earlier preparation checkpoint without importing again', async t => {
  const f = fixture(t), options = { ...f.options, control: 'none' };
  let preparing;
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...options, onCheckpoint(report) {
    if (report.samples[0].preparationPending) preparing = structuredClone(report);
    else throw new Error('interrupt after preparation');
  } }), /interrupt after preparation/);
  assert.ok(preparing);
  const extractionBefore = f.requests.filter(request => request.tool.name.includes('extraction')).length;
  const resumed = await runZh4oMemorySystemBenchmark({ ...options, resumeReport: preparing });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.samples[0].preparationPending, undefined);
  assert.equal(f.requests.filter(request => request.tool.name.includes('extraction')).length, extractionBefore);
});

test('missing code identity fails before creating a benchmark database or contacting a provider', async t => {
  const f = fixture(t);
  await assert.rejects(runZh4oMemorySystemBenchmark({ ...f.options, codeRevision: { commit: '', dirty: null } }), /code identity/);
  assert.equal(fs.existsSync(f.options.workDirectory), false);
  assert.equal(f.requests.length, 0);
});

test("configured embeddings are indexed by normal maintenance and retrieval-only performs query embeddings only", async t => {
  const f = fixture(t), generate = f.fetchImpl;
  f.config.providers.embedding = { baseUrl: "https://fixture.invalid/v1", model: "fixture-vectors", dimensions: 2, apiKeyEnv: "TEST_MEMORY_KEY" };
  const fetchImpl = async (url, options) => {
    if (!String(url).endsWith("/embeddings")) return generate(url, options);
    const body = JSON.parse(options.body), texts = Array.isArray(body.input) ? body.input : [body.input];
    return Response.json({ model: "fixture-vectors", data: texts.map((text, index) => ({ index,
      embedding: String(text).includes("苹果") ? [1, 0] : [0, 1] })), usage: { prompt_tokens: texts.length } });
  };
  const first = await runZh4oMemorySystemBenchmark({ ...f.options, fetchImpl });
  assert.equal(first.diagnostics.degradedSamples, 0, JSON.stringify(first.samples));
  assert.ok(first.run.embeddingUsage.byPhase.memory > 0);
  const before = databaseSnapshot(first.database.sampleDatabases[0]);
  const second = await runZh4oMemorySystemBenchmark({ ...f.options, fetchImpl, retrievalOnly: true });
  assert.equal(second.diagnostics.degradedSamples, 0, JSON.stringify(second.samples));
  assert.equal(second.run.embeddingUsage.byPhase.memory, undefined);
  assert.ok(second.run.embeddingUsage.byPhase.query > 0);
  assert.equal(second.run.embeddingEnabled, true);
  assert.equal(databaseSnapshot(first.database.sampleDatabases[0]), before);
});
