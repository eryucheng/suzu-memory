import { createTestDirectory, closeAfterTests } from '../../../test/support/suite-resources.mjs';
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryRepository, memoryRetrievalContextSourceHash, openMemoryDatabase, proposeMemoryRelation, resolveMemoryRelationProposal } from "@suzu-memory/core";
import { closeRetrievalWorkers, collectBm25SeedScores, lexicalScore, lexicalTerms, planBm25Queries, retrieveMemories, resolveTemporalQuery } from "../src/index.mjs";
import { fuseCandidateLanes, DEFAULT_RETRIEVAL_OPTIONS } from "../src/retriever.mjs";
import { renderRecallOutput, joinBoundedSections, formatPrimary } from '../src/context-renderer.mjs';

test('default recall keeps long original statements and returns factual metadata without boilerplate', () => {
  assert.equal(DEFAULT_RETRIEVAL_OPTIONS.maximumContextChars, 24_000);
  for (const language of ['zh','en']) {
    const content=(language==='zh'?'林讲述了徒步的具体经历。':'Lin described the hiking experience. ').repeat(120)
      +(language==='zh'?'最后确认没有参加露营。':'Finally, Lin confirmed not attending the camp.');
    const nodes=[{id:'statement',kind:'utterance',content,metadata:{speaker:'Lin'},event_start:'2026-10-20T08:00:00Z'},
      {id:'summary',kind:'event',content:'Lin did not attend the camp.',event_date:'2026-10-20',known_at:'2026-10-21T08:00:00Z',evidence_mode:'inferred'}];
    const output=renderRecallOutput({nodes},DEFAULT_RETRIEVAL_OPTIONS);
    assert.ok(output.context.includes(content));
    assert.ok(output.context.includes('Lin did not attend the camp.'));
    assert.match(output.context,/事件日期：2026-10-20；获知时间：2026-10-21/u);
    assert.match(output.context,/推断：Lin/u);
    assert.doesNotMatch(output.context,/你想起|我记得|已解析|来源性质|状态性质/u);
    assert.equal(output.records.length,2);
    const explicit=renderRecallOutput({nodes}, {...DEFAULT_RETRIEVAL_OPTIONS,maximumMessageChars:200});
    assert.ok(!explicit.context.includes(content));
    assert.ok(explicit.context.includes('Lin did not attend the camp.'));
  }
});

test('compact attribution keeps each statement intact and distinguishes its subject from its source', () => {
  for (const [name, named, firstPerson] of [
    ['林明','林明和米拉参观了博物馆。','我和米拉参观了博物馆。'],
    ['Lin','Lin visited the museum with Mira.','I visited the museum with Mira.'],
    ['Dr. Lin','Yesterday Dr. Lin visited the museum with Mira.','I visited the museum with Mira yesterday.'],
  ]) {
    const base={id:'fact',kind:'event',subject_key:'person',event_date:'2026-10-20',evidence_mode:'explicit'};
    const options={maximumContextChars:4000,timeZone:'UTC',actorNames:new Map([['person',name]])};
    for (const [body, authority, mode, expected] of [
      [named,'subject_firsthand','explicit',`自述：${named}`],
      [`2026-10-20，${named}`,'subject_firsthand','explicit',`自述：2026-10-20，${named}`],
      [firstPerson,'subject_firsthand','explicit',`${name}自述：${firstPerson}`],
      [named,'hearsay','explicit',`转述：${named}`],
      [firstPerson,'model_inference','inferred',`推断（关于${name}）：${firstPerson}`],
      [firstPerson,'unknown','imported',`关于${name}：${firstPerson}`],
    ]) {
      const node={...base,content:body,evidence_mode:mode};
      const rendered=formatPrimary(node,[],{...options,sourceAuthoritiesByMemoryId:new Map([['fact',[authority]]])});
      assert.ok(rendered.endsWith(expected),rendered);
      assert.doesNotMatch(rendered,/人物：|主体本人陈述|主体明确表达/u);
      assert.equal(node.content,body);
      assert.equal(rendered.split(name).length-1,1,rendered);
    }
    const utterance=formatPrimary({...base,kind:'utterance',content:firstPerson,metadata:{speaker:name}},[],options);
    assert.ok(utterance.endsWith(`${name}：${firstPerson}`));
    assert.doesNotMatch(utterance,/自述/u);
  }
  const namedSubstring=formatPrimary({kind:'event',subject_key:'person',content:'Lindsay asked me to hike.',evidence_mode:'inferred'},[],
    {maximumContextChars:4000,actorNames:new Map([['person','Lin']])});
  assert.ok(namedSubstring.endsWith('推断（关于Lin）：Lindsay asked me to hike.'));
});

test('recall budgets retain complete unequal records when they fit and reuse short records spare capacity', () => {
  for (const language of ['zh', 'en']) {
    const options = { maximumContextChars: 1400, maximumMessageChars: 500, timeZone: 'Asia/Shanghai', heading: '', guidance: '' };
    const fact = language === 'zh' ? '猫的名字是小橘。' : 'Her cat is called Miso.';
    const long = (language === 'zh' ? '讨论了出游的计划。' : 'Discussed the travel plans. ').repeat(language === 'zh' ? 38 : 14) + fact;
    const nodes = Array.from({length: 10}, (_, i) => ({ id: `node-${i}`, kind: 'event',
      content: i ? 'Brief fact.' : long, event_date: '2026-10-31' }));
    const complete = renderRecallOutput({nodes}, {...options, maximumContextChars: 10000});
    assert.ok(complete.context.length < options.maximumContextChars);
    const result = renderRecallOutput({nodes}, options);
    assert.equal(result.context, complete.context);
    assert.ok(result.context.includes(fact));
    assert.equal(result.outputBudget.sectionTruncationApplied, false);
    for (const maximum of [1, 24, 100, 500]) {
      const limited = renderRecallOutput({nodes}, {...options, maximumContextChars: maximum});
      assert.ok(limited.context.length <= maximum);
      assert.equal(limited.outputBudget.finalTextChars, limited.text.length);
      for (const record of limited.records) assert.ok(record.text.startsWith(`记忆编号：${record.memoryId}\n`));
    }
  }
  const values = ['x'.repeat(700), 'short', 'y'.repeat(700)];
  const joined = joinBoundedSections(values, 1000);
  assert.equal(joined.length, 1000);
  assert.ok(joined.includes('\nshort\n'));
  const primary = {kind: 'event', content: 'x'.repeat(750) + 'LAST_FACT', event_date: '2026-10-31'};
  const text = formatPrimary(primary, [], {maximumContextChars: 1000});
  assert.ok(text.includes('LAST_FACT'));
});

function temporaryDatabase() {
  const root = createTestDirectory(path.join(os.tmpdir(), "suzu-retriever-"));
  const databasePath = path.join(root, "memory.db");
  const database = closeAfterTests(openMemoryDatabase(databasePath));
  return { root, databasePath, database, repository: new MemoryRepository(database) };
}

test('explicit candidate materialization returns independent readable memories without widening default output', async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const [id, title, content] of [
    ['gallery', '星河美术馆', '用户参观了星河美术馆。'],
    ['restaurant', '星河餐厅', '用户在星河餐厅吃了晚饭。'],
  ]) repository.upsertMemory({ id, agentId: 'agent-test', kind: 'event', layer: 'episodic', title, content,
    eventDate: '2026-10-01', reality: 'real', temporalState: 'historical' });
  database.close();
  const ordinary = await retrieveMemories({ databasePath, agentId: 'agent-test', query: '星河' });
  assert.equal(ordinary.candidates[0].recallContext, undefined);
  assert.equal(ordinary.guidance, '');
  assert.equal(ordinary.context, ordinary.records.map(record => record.text).join('\n\n'));
  const result = await retrieveMemories({ databasePath, agentId: 'agent-test', query: '星河',
    options: { includeCandidateContext: true, maximumReturnedCandidates: 10, heading: '', guidance: '项目历史资料：' } });
  assert.equal(result.context, '项目历史资料：\n\n' + result.records.map(record => record.text).join('\n\n'));
  assert.equal(result.candidates.length, 2);
  for (const candidate of result.candidates) {
    assert.ok(candidate.recallContext.includes(candidate.title));
    assert.match(candidate.recallContext, /2026-10-01/);
    assert.match(candidate.recallContext, /记忆状态：active/);
    assert.ok(candidate.recallContext.length <= 1200);
  }
});

function explicitPlasticityOptions() {
  return {
    enabled: true,
    configurationVersion: "test-retrieval-plasticity-v1",
    memory: {
      neutralValue: 0.5,
      maximumScoreAdjustment: 0.4,
      allowedPolicyVersions: ["test-memory-policy-v1"],
    },
    edge: {
      neutralValue: 0.5,
      maximumMultiplierAdjustment: 1,
      allowedPolicyVersions: ["test-edge-policy-v1"],
    },
  };
}

function explicitAffectiveBiasOptions() {
  return {
    enabled: true,
    configurationVersion: "test-affective-retrieval-v1",
    subjectRole: "user",
    subjectKey: "user",
    currentEmotion: {
      label: "开心",
      valence: "positive",
      intensity: "high",
    },
    matchMode: "exact-label",
    maximumScoreAdjustment: 0.4,
    allowedPolicyVersions: ["human-affective-v1"],
    allowedRepresentationLayers: ["reported"],
  };
}

function seedMuseumMemory(repository) {
  repository.upsertMemory({
    id: "u-user",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "我上周六去了科技馆。",
    subjectRole: "user",
    subjectKey: "user",
    eventStart: "2026-07-11T03:00:00.000Z",
    recordedAt: "2026-07-11T03:00:00.000Z",
    metadata: { speaker: "User" },
  });
  repository.upsertMemory({
    id: "u-agent",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "你还看了机器人展。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    eventStart: "2026-07-11T03:01:00.000Z",
    recordedAt: "2026-07-11T03:01:00.000Z",
    metadata: { speaker: "Agent" },
  });
  repository.upsertMemory({
    id: "event-museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "去科技馆",
    content: "User 上周六去了科技馆并参观机器人展。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-11",
    recordedAt: "2026-07-11T03:02:00.000Z",
    importance: 0.8,
  });
  for (const id of ["u-user", "u-agent"]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: "event-museum",
      toMemoryId: id,
      relation: "supported_by",
      direction: "directed",
      weight: 1,
    });
  }
}

test("world scope gates every retrieval route while an explicit cross-world request can inspect both", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const physical = repository.upsertMemory({
    id: "physical-museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在现实中的科技馆看了火箭展。",
    subjectRole: "user",
    subjectKey: "user",
    worldId: "real-life",
    worldFrame: "physical",
    eventDate: "2026-08-01",
  });
  const fictional = repository.upsertMemory({
    id: "fictional-museum",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "小说里的科技馆也举办了火箭展。",
    subjectRole: "user",
    subjectKey: "user",
    worldId: "novel-city",
    worldFrame: "fictional",
    eventDate: "2026-08-02",
  });
  const hypothetical = repository.upsertMemory({ id: 'hypothetical-museum', agentId: 'agent-test', kind: 'event', layer: 'episodic',
    content: '假如用户在科技馆看了火箭展。', reality: 'hypothetical', worldId: 'real-life', worldFrame: 'physical',
    subjectRole: 'user', subjectKey: 'user', eventDate: '2026-08-03' });
  // Simulate an old bad edge that predates world isolation. The retriever must
  // still refuse to traverse it inside a scoped recall.
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: physical.id,
    toMemoryId: fictional.id,
    relation: "followed_by",
    direction: "directed",
    weight: 1,
  });
  database.close();

  const scoped = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆的火箭展",
    world: { id: "real-life", frame: "physical" },
  });
  assert.equal(scoped.status, "ready");
  assert.ok(scoped.fragments.some((fragment) => fragment.memoryId === physical.id));
  assert.ok(!scoped.fragments.some((fragment) => fragment.memoryId === fictional.id));
  assert.ok(!scoped.graph.selectedMemoryIds.includes(fictional.id));
  assert.ok(!scoped.candidates.some(candidate => candidate.memoryId === hypothetical.id));

  const crossWorld = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆的火箭展",
    world: { id: "real-life", frame: "physical" },
    allowCrossWorld: true,
  });
  assert.ok(crossWorld.candidates.some((candidate) => candidate.memoryId === physical.id));
  assert.ok(crossWorld.candidates.some((candidate) => candidate.memoryId === fictional.id));
  assert.ok(crossWorld.candidates.some((candidate) => candidate.memoryId === hypothetical.id));
  assert.match(crossWorld.context, /\[假设\]/u);
  const imagined = await retrieveMemories({ databasePath, agentId: 'agent-test', query: '科技馆的火箭展',
    world: { id: 'real-life', frame: 'physical', reality: 'hypothetical' } });
  assert.ok(imagined.fragments.some(fragment => fragment.memoryId === hypothetical.id));
  assert.ok(!imagined.candidates.some(candidate => candidate.memoryId === physical.id));
});

test("recalls a pending Agent impression without graph propagation or learning eligibility", async () => {
  const { root, databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "provisional-go-impression",
    agentId: "agent-test",
    kind: "fact",
    layer: "provisional",
    content: "Agent 猜测用户小时候学过围棋。",
    subjectRole: "user",
    subjectKey: "user",
    evidenceMode: "inferred",
    status: "archived",
    importance: 0.7,
    perspective: "agent",
    metadata: {
      provisional: true,
      epistemicStatus: "agent_impression",
      epistemicHolderRole: "agent",
    },
  });
  const decision = repository.recordIngestionDecision({
    agentId: "agent-test",
    batchId: "batch-provisional-retrieval",
    candidateIndex: 0,
    decision: "review",
    resultStatus: "review",
    reasonCodes: ["user-memory-without-user-source"],
    candidate: { kind: "fact", content: "用户小时候学过围棋。" },
    provisionalMemoryId: "provisional-go-impression",
  });
  database.close();

  const recalled = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我小时候学过围棋吗",
    queryPerspective: {
      speakerRole: "user",
      speakerKey: "user",
      addresseeRole: "agent",
      addresseeKey: "agent-test",
    },
  });
  assert.equal(recalled.status, "ready");
  assert.equal(recalled.candidates[0].memoryId, "provisional-go-impression");
  assert.equal(recalled.candidates[0].provisional, true);
  assert.equal(recalled.candidates[0].provisionalReview.reviewDecisionId, decision.id);
  assert.match(recalled.context, /推断[：（]/u);
  assert.ok(recalled.context.includes('Agent 猜测用户小时候学过围棋。'));
  assert.deepEqual(recalled.trace.selectedIds, []);
  assert.deepEqual(recalled.trace.metadata.provisionalMemoryIds, ["provisional-go-impression"]);
  assert.deepEqual(recalled.trace.metadata.recalledMemoryIds, []);
  assert.deepEqual(recalled.graph.edgeIds, []);
  assert.equal(recalled.graph.activationField, null);

  const reopened = closeAfterTests(openMemoryDatabase(databasePath));
  const reopenedRepository = new MemoryRepository(reopened);
  reopenedRepository.resolveIngestionDecision({
    agentId: "agent-test",
    decisionId: decision.id,
    resolution: "dismissed",
    note: "用户纠正了这条印象。",
  });
  reopened.close();
  const afterDismissal = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我小时候学过围棋吗",
  });
  assert.equal(afterDismissal.status, "no-match");
  fs.rmSync(root, { recursive: true, force: true });
});

test("resolves Chinese relative calendar expressions in code", () => {
  const temporal = resolveTemporalQuery(
    "我上周六去干啥了",
    new Date("2026-07-15T12:00:00+08:00"),
    "Asia/Shanghai",
  );
  assert.equal(temporal.matched, true);
  assert.equal(temporal.startDate, "2026-07-11");
});

test("resolves English relative weekdays without an LLM translation step", () => {
  const temporal = resolveTemporalQuery(
    "I received a piece of jewelry last Saturday from whom?",
    new Date("2023-03-09T15:47:00+08:00"),
    "Asia/Shanghai",
  );
  assert.equal(temporal.matched, true);
  assert.equal(temporal.startDate, "2023-03-04");
  assert.equal(temporal.endDate, "2023-03-04");
  assert.equal(temporal.remainingQuery, "I received a piece of jewelry from whom?");
});

test("resolves English relative day offsets and calendar ranges", () => {
  const daysAgo = resolveTemporalQuery(
    "What kitchen appliance did I buy 10 days ago?",
    new Date("2023-03-25T18:26:00+08:00"),
    "Asia/Shanghai",
  );
  assert.equal(daysAgo.precision, 'approximate');
  assert.deepEqual(daysAgo.coreWindow, { startDate: '2023-03-14', endDate: '2023-03-16' });

  const lastWeek = resolveTemporalQuery(
    "Where did I attend the religious activity last week?",
    new Date("2023-04-10T13:35:00+08:00"),
    "Asia/Shanghai",
  );
  assert.deepEqual(
    { kind: lastWeek.kind, startDate: lastWeek.startDate, endDate: lastWeek.endDate },
    { kind: "range", startDate: "2023-04-03", endDate: "2023-04-09" },
  );

  const lastMonth = resolveTemporalQuery(
    "Which pair of shoes did I clean last month?",
    new Date("2023-05-24T09:14:00+08:00"),
    "Asia/Shanghai",
  );
  assert.deepEqual(
    { kind: lastMonth.kind, startDate: lastMonth.startDate, endDate: lastMonth.endDate },
    { kind: "range", startDate: "2023-04-01", endDate: "2023-04-30" },
  );
});

test("resolves English month names as exact dates or month ranges", () => {
  const exact = resolveTemporalQuery(
    "How many days ago did I read the March 15th issue?",
    new Date("2023-04-01T09:00:00+08:00"),
    "Asia/Shanghai",
  );
  assert.equal(exact.startDate, "2023-03-15");

  const range = resolveTemporalQuery(
    "What is the order of the sports events I watched in January?",
    new Date("2023-03-10T09:00:00+08:00"),
    "Asia/Shanghai",
  );
  assert.deepEqual(
    { kind: range.kind, startDate: range.startDate, endDate: range.endDate },
    { kind: "range", startDate: "2023-01-01", endDate: "2023-01-31" },
  );

  const combinedRange = resolveTemporalQuery(
    "Which airline did I fly with the most in March and April?",
    new Date("2023-05-10T09:00:00+08:00"),
    "Asia/Shanghai",
  );
  assert.deepEqual(
    {
      kind: combinedRange.kind,
      startDate: combinedRange.startDate,
      endDate: combinedRange.endDate,
    },
    { kind: "range", startDate: "2023-03-01", endDate: "2023-04-30" },
  );
});

test("does not mistake ordinary English uses of last for a calendar constraint", () => {
  const temporal = resolveTemporalQuery(
    "What was the last thing I said about the museum?",
    new Date("2023-03-25T18:26:00+08:00"),
    "Asia/Shanghai",
  );
  assert.equal(temporal.matched, false);

  const openEnded = resolveTemporalQuery(
    "What is the order of airlines I flew with from earliest to latest before today?",
    new Date("2023-03-02T09:00:00+08:00"),
    "Asia/Shanghai",
  );
  assert.equal(openEnded.matched, false);
});

test("plans a bounded deduplicated BM25 query set", () => {
  const queries = planBm25Queries(
    "你还记得我之前去科技馆看机器人展吗",
    { maximumQueries: 4 },
  );
  assert.ok(queries.length > 0);
  assert.ok(queries.length <= 4);
  assert.equal(new Set(queries.map((item) => item.text)).size, queries.length);
  assert.equal(queries.every((item) => Array.from(item.text).length >= 3), true);
  assert.equal(queries.every((item) => ["core-phrase", "lexical-term"].includes(item.source)), true);
});

test("keeps LIKE fallback out of the BM25 route audit", () => {
  const calls = [];
  const repository = {
    search(_agentId, query, options) {
      calls.push({ query, options });
      return [
        { id: "fts-memory", search_rank: -0.42 },
        { id: "like-memory", search_rank: 0 },
      ];
    },
  };
  const result = collectBm25SeedScores({
    repository,
    agentId: "agent-test",
    query: "记得之前去科技馆吗",
    maximumQueries: 3,
    maximumResultsPerQuery: 7,
  });
  assert.equal(result.status, "ready");
  assert.ok(calls.length > 0 && calls.length <= 3);
  assert.equal(calls.every((call) => call.options.limit === 7), true);
  assert.equal(result.scores.has("fts-memory"), true);
  assert.equal(result.scores.has("like-memory"), false);
  assert.equal(result.audit.ignoredLikeFallbackCount, calls.length);
  assert.equal(result.audit.matches[0].bestSearchRank, -0.42);
});

test("ranks source text and reviewed events without a storage-kind bonus", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
    now: new Date("2026-07-15T12:00:00+08:00"),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.disclosureLevel, "evidence");
  assert.equal(result.fragments.length, 1);
  assert.equal(result.fragments[0].memoryId, "u-user");
  assert.match(result.context, /去了科技馆并参观机器人展/u);
  assert.match(result.context, /User：我上周六去了科技馆/u);
  assert.match(result.context, /Agent：你还看了机器人展/u);
  assert.deepEqual(new Set(result.graph.selectedMemoryIds), new Set(['u-user', 'event-museum', 'u-agent']));
  assert.deepEqual(result.seedRouting.plannedRoutes, ["lexical", "bm25", "entity", "temporal"]);
  assert.deepEqual(result.seedRouting.executedRoutes, ["lexical", "bm25", "entity", "temporal"]);
  assert.equal(result.seedRouting.primaryMemoryId, "u-user");
  assert.equal(result.candidates[0].admission, "independent");
  assert.equal(result.candidates[0].routeMatches[0].route, "lexical");
  assert.deepEqual(result.trace.metadata.seedRouting, result.seedRouting);
  assert.doesNotMatch(JSON.stringify(result.seedRouting), /机器人展/u);
});

test("recalls matched raw evidence without inserting an adjacent acknowledgement", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "lunch-user-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "我昨天午饭吃了番茄牛腩饭。",
    subjectRole: "user",
    subjectKey: "user",
    eventStart: "2026-08-05T04:00:00.000Z",
    metadata: { speaker: "User" },
  });
  repository.upsertMemory({
    id: "lunch-agent-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "番茄牛腩饭听起来挺香。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    eventStart: "2026-08-05T04:01:00.000Z",
    metadata: { speaker: "Agent" },
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "lunch-user-utterance",
    toMemoryId: "lunch-agent-utterance",
    relation: "followed_by",
    direction: "directed",
    weight: 1,
    confidence: 1,
    provenance: "test",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我昨天午饭吃了什么",
    now: new Date("2026-08-06T12:00:00+08:00"),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.retrievalMode, "episodic-lexical");
  assert.equal(result.candidates[0].retrievalLane, "episodic-evidence");
  assert.match(result.context, /User：我昨天午饭吃了番茄牛腩饭/u);
  assert.doesNotMatch(result.context, /Agent：番茄牛腩饭听起来挺香/u);
});

test("ranks structured memories and raw evidence by their fused relevance instead of alternating lanes", () => {
  const ranked = fuseCandidateLanes([
    {
      node: { id: "summary", kind: "event", importance: 0.9, recorded_at: "2026-08-01T00:00:00.000Z" },
      score: 0.4,
    },
  ], [
    {
      node: { id: "evidence-strong", kind: "utterance", importance: 0, recorded_at: "2026-08-01T00:01:00.000Z" },
      score: 0.95,
    },
    {
      node: { id: "evidence-medium", kind: "utterance", importance: 0, recorded_at: "2026-08-01T00:02:00.000Z" },
      score: 0.7,
    },
  ], 3);
  assert.deepEqual(
    ranked.map((candidate) => candidate.node.id),
    ["evidence-strong", "evidence-medium", "summary"],
  );
  assert.equal(ranked[0].retrievalLane, "episodic-evidence");
});

test("lets a stronger raw utterance become the ordinary recall primary", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "lunch-summary",
    agentId: "agent-test",
    kind: "event",
    layer: "semantic",
    title: "午饭",
    content: "用户昨天吃了午饭。",
    subjectRole: "user",
    subjectKey: "user",
    importance: 0.6,
    eventStart: "2026-08-05T04:00:00.000Z",
  });
  repository.upsertMemory({
    id: "lunch-verbatim",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "我昨天午饭吃了番茄牛腩饭。",
    subjectRole: "user",
    subjectKey: "user",
    eventStart: "2026-08-05T04:00:00.000Z",
    metadata: { speaker: "User" },
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我昨天午饭吃了番茄牛腩饭吗",
    now: new Date("2026-08-06T12:00:00+08:00"),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.seedRouting.primaryMemoryId, "lunch-verbatim");
  assert.equal(result.fragments[0].memoryId, "lunch-verbatim");
  assert.equal(result.retrievalMode, "episodic-lexical");
  assert.equal(result.candidates[0].memoryId, "lunch-verbatim");
});

test("relationship questions prefer directly matching evidence over incidental mentions of relationships", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "relationship-state",
    agentId: "agent-test",
    kind: "relationship",
    layer: "semantic",
    title: "用户把 Agent 当成恋人",
    content: "用户明确把 Agent 当成恋人，双方是恋人关系。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user.relationship.agent.lovers",
    representationLayer: "reported",
    stateFamily: "relationship",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-01T00:00:00.000Z",
    importance: 0.8,
  });
  repository.upsertMemory({
    id: "unrelated-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "我把模型关系和工具关系都重新考虑了一遍。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    eventStart: "2026-07-02T00:00:00.000Z",
    recordedAt: "2026-07-02T00:00:00.000Z",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我们是恋人关系吗",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.seedRouting.primaryMemoryId, "relationship-state");
  assert.doesNotMatch(result.context, /模型关系/u);
});

test("labels the actual epistemic source of a non-state memory", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "conversation",
    externalId: "observatory-message",
    occurredAt: "2026-07-01T02:00:00.000Z",
    knownAt: "2026-07-01T02:00:00.000Z",
    recordedAt: "2026-07-01T02:00:00.000Z",
    speaker: "User",
    content: "我七月一日去了天文馆。",
  });
  const memory = repository.upsertMemory({
    id: "observatory-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户七月一日去了天文馆。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "explicit",
    eventDate: "2026-07-01",
    recordedAt: "2026-07-01T02:00:00.000Z",
  });
  repository.linkSource(memory.id, source.id, "evidence", {
    authority: "subject_firsthand",
    sourceTrust: 0.9,
    evidenceStrength: 1,
    provenance: "test",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我七月一日去天文馆吗",
  });
  assert.equal(result.status, "ready");
  assert.match(result.context, /自述：/u);
});

test("recalls imported and manually maintained content without inventing source authority", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "legacy-aquarium-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户以前去过海洋馆。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
    evidenceMode: "imported",
    temporalState: "historical",
    recordedAt: "2026-06-01T02:00:00.000Z",
  });
  repository.upsertMemory({
    id: "manual-garden-event", agentId: "agent-test", kind: "event", layer: "episodic",
    content: "用户以前去过植物园。", subjectRole: "user", subjectKey: "user", reality: "real",
    evidenceMode: "manual", temporalState: "historical", recordedAt: "2026-06-01T02:00:00.000Z",
  });
  database.close();

  for (const place of ["海洋馆", "植物园"]) {
    const result = await retrieveMemories({ databasePath, agentId: "agent-test", query: `记得我以前去${place}吗` });
    assert.equal(result.status, "ready");
    assert.ok(result.context.includes(`用户以前去过${place}。`));
    assert.doesNotMatch(result.context, /自述|参与者陈述|观察记录|推断|转述/u);
  }
});

test("keeps current-state correction visible without hiding evidence for the historical focus", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "historical-fish-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: `Agent 以前觉得鱼很难吃。${"过去状态补充".repeat(40)}`,
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:belief:food:fish",
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "historical",
    status: "superseded",
  });
  repository.upsertMemory({
    id: "current-fish-belief",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: `Agent 现在知道有些鱼很好吃。${"当前状态补充".repeat(40)}`,
    subjectRole: "agent",
    subjectKey: "agent-test",
    canonicalKey: "agent:belief:food:fish",
    representationLayer: "reported",
    stateFamily: "belief",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "historical-fish-evidence",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    evidenceMode: "explicit",
    content: `Agent 当时吃到一道处理失败的鱼菜后明确表达不喜欢。${"证据补充".repeat(40)}`,
    subjectRole: "agent",
    subjectKey: "agent-test",
    eventDate: "2026-07-01",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "historical-fish-belief",
    toMemoryId: "historical-fish-evidence",
    relation: "supported_by",
    direction: "directed",
    weight: 1,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "有什么依据",
    anchorMemoryIds: ["historical-fish-belief"],
    options: { maximumContextChars: 900 },
  });
  assert.equal(result.status, "ready");
  assert.match(result.context, /Agent 现在知道有些鱼很好吃/u);
  assert.match(result.context, /Agent 以前觉得鱼很难吃/u);
  assert.ok(result.records.every(record => result.context.includes(record.memoryId)));
  assert.match(result.context, /处理失败的鱼菜/u);
  assert.equal(result.context.length <= 900, true);
  assert.equal(result.outputBudget.safetyTruncationApplied, false);
  assert.ok(result.records.some(record => record.memoryId === "historical-fish-evidence"));
});

test("keeps scoped exceptions visible without hiding evidence for the broad focus", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const scopeKey = `scope:${"a".repeat(64)}`;
  repository.upsertMemory({
    id: "broad-fish-preference",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户现在总体喜欢吃鱼。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:food:fish",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: "root",
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "fish-preference-exception",
    agentId: "agent-test",
    kind: "preference",
    layer: "semantic",
    content: "用户不喜欢处理不好的腥味鱼。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:food:fish",
    representationLayer: "reported",
    stateFamily: "preference",
    statePhase: "active",
    stateScopeKey: scopeKey,
    temporalState: "current",
  });
  repository.upsertMemory({
    id: "broad-fish-evidence",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户后来主动选择并称赞了两道不同的鱼菜。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-10",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "fish-preference-exception",
    toMemoryId: "broad-fish-preference",
    relation: "scoped_exception_to",
    direction: "directed",
    weight: 1,
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "broad-fish-preference",
    toMemoryId: "broad-fish-evidence",
    relation: "supported_by",
    direction: "directed",
    weight: 1,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "有什么依据",
    anchorMemoryIds: ["broad-fish-preference"],
  });
  assert.equal(result.status, "ready");
  assert.match(result.context, /用户现在总体喜欢吃鱼/u);
  assert.match(result.context, /用户不喜欢处理不好的腥味鱼/u);
  assert.ok(result.records.every(record => result.context.includes(record.memoryId)));
  assert.match(result.context, /主动选择并称赞了两道不同的鱼菜/u);
  assert.ok(result.records.some(record => record.memoryId === "broad-fish-evidence"));
});

test("treats English function words and possessive tails like Chinese stop characters", () => {
  assert.deepEqual(
    lexicalTerms("When did Melanie paint a sunrise?"),
    ["melanie", "paint", "sunrise"],
  );
  assert.deepEqual(
    lexicalTerms("What are John's suspected health problems?"),
    ["john", "suspected", "health", "problems"],
  );
  assert.deepEqual(
    lexicalScore(
      "When did Melanie paint a sunrise?",
      "Melanie went camping with a friend.",
    ).matchedTerms,
    ["melanie"],
  );
  assert.deepEqual(
    lexicalScore(
      "When did Melanie paint a sunrise?",
      "Melanie painted a sunrise last year.",
    ).matchedTerms,
    ["melanie", "paint", "sunrise"],
  );
  assert.deepEqual(
    lexicalScore(
      "When was Sam in the ER?",
      "Sam was in a movie club last weekend.",
    ).matchedTerms,
    ["sam"],
  );
});

test("retrieves an English event by its content words instead of a same-name distraction", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "melanie-camping",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "Melanie went camping with a friend.",
    subjectRole: "unknown",
    subjectKey: "",
    eventStart: "2025-05-01T00:00:00.000Z",
  });
  repository.upsertMemory({
    id: "melanie-sunrise",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "Melanie painted a sunrise last year.",
    subjectRole: "unknown",
    subjectKey: "",
    eventStart: "2025-06-01T00:00:00.000Z",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "When did Melanie paint a sunrise?",
    now: new Date("2026-08-08T12:00:00.000Z"),
  });

  assert.equal(result.status, "ready");
  assert.equal(result.seedRouting.primaryMemoryId, "melanie-sunrise");
  assert.equal(result.fragments[0].memoryId, "melanie-sunrise");
  assert.equal(result.candidates.some((candidate) => candidate.memoryId === "melanie-camping"), false);
});

test("keeps learned state inert until retrieval explicitly adopts it", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();
  const input = {
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
    now: new Date("2026-07-15T12:00:00+08:00"),
  };
  const before = await retrieveMemories(input);
  const writable = closeAfterTests(openMemoryDatabase(databasePath));
  writable.prepare(`
    INSERT INTO memory_accessibility_state (
      memory_id, agent_id, value, policy_version,
      last_observation_window_id, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "event-museum",
    "agent-test",
    0,
    "test-inert-policy",
    "test-inert-window",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
  );
  writable.close();
  const after = await retrieveMemories(input);
  assert.deepEqual(after.trace.seedIds, before.trace.seedIds);
  assert.deepEqual(after.fragments, before.fragments);
  assert.equal(after.context, before.context);
});

test("uses only explicitly enabled and policy-approved accessibility to rerank admitted seeds", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "museum-older",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆机器人展",
    content: "用户去了科技馆机器人展。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-01",
    recordedAt: "2026-07-01T00:00:00.000Z",
  });
  repository.upsertMemory({
    id: "museum-newer",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆机器人展",
    content: "用户去了科技馆机器人展。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-02",
    recordedAt: "2026-07-02T00:00:00.000Z",
  });
  database.prepare(`
    INSERT INTO memory_accessibility_state (
      memory_id, agent_id, value, policy_version,
      last_observation_window_id, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "museum-older",
    "agent-test",
    1,
    "test-memory-policy-v1",
    "test-window",
    "2026-07-03T00:00:00.000Z",
    "2026-07-03T00:00:00.000Z",
    "2026-07-03T00:00:00.000Z",
  );
  database.close();

  const baseline = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆机器人展",
  });
  assert.equal(baseline.fragments[0].memoryId, "museum-newer");

  const learned = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆机器人展",
    options: { plasticity: explicitPlasticityOptions() },
  });
  assert.equal(learned.fragments[0].memoryId, "museum-older");
  assert.equal(learned.candidates[0].accessibility.policyVersion, "test-memory-policy-v1");
  assert.equal(learned.candidates[0].accessibility.scoreAdjustment, 0.4);
  assert.equal(learned.trace.metadata.plasticity.adjustedCandidateCount, 1);
});

test("applies approved relation utility only to the matching intent view", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  for (const [id, content] of [
    ["association-high", "后来一起聊了航天。"],
    ["association-low", "后来一起吃了点心。"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      subjectRole: "shared",
      subjectKey: "shared:agent-test:user",
      eventDate: "2026-07-12",
      recordedAt: "2026-07-12T00:00:00.000Z",
    });
  }
  const high = repository.upsertEdge({
    id: "association-edge-high",
    agentId: "agent-test",
    fromMemoryId: "event-museum",
    toMemoryId: "association-high",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.9,
  });
  const low = repository.upsertEdge({
    id: "association-edge-low",
    agentId: "agent-test",
    fromMemoryId: "event-museum",
    toMemoryId: "association-low",
    relation: "associated_with",
    direction: "undirected",
    weight: 0.9,
  });
  const insert = database.prepare(`
    INSERT INTO memory_edge_relation_utility_state (
      edge_id, agent_id, intent_view, value, policy_version,
      last_observation_window_id, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const [edgeId, value] of [[high.id, 1], [low.id, 0]]) {
    insert.run(
      edgeId,
      "agent-test",
      "associative",
      value,
      "test-edge-policy-v1",
      "test-window",
      "2026-07-15T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
    );
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆还让你想起什么",
    options: {
      maximumChainMemories: 2,
      plasticity: explicitPlasticityOptions(),
    },
  });
  assert.ok(result.graph.selectedMemoryIds.includes("association-high"));
  const step = result.graph.paths.find(path => path.memoryId === "association-high").edges[0];
  assert.equal(step.learnedRelationUtility.policyVersion, "test-edge-policy-v1");
  assert.equal(step.learnedRelationUtility.multiplier, 2);
  assert.equal(step.appliedRelationUtility, 2);
  assert.equal(result.trace.metadata.plasticity.adjustedEdgeTraversalCount, 1);
});

test("rejects incomplete plasticity activation instead of inventing defaults", async () => {
  await assert.rejects(
    () => retrieveMemories({
      databasePath: "not-opened.db",
      agentId: "agent-test",
      query: "科技馆",
      options: {
        plasticity: {
          enabled: true,
          configurationVersion: "incomplete",
          memory: {
            neutralValue: 0.5,
            maximumScoreAdjustment: 0.2,
            allowedPolicyVersions: ["memory-policy"],
          },
        },
      },
    }),
    /必须同时提供 memory 与 edge/u,
  );
});

test("uses explicit affective activation only to rerank already-admitted ordinary seeds", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const [id, content, recordedAt] of [
    ["walk-older", "周末散步计划是在河边走一圈。", "2026-07-11T01:00:00.000Z"],
    ["walk-newer", "周末散步计划是在河边走一圈。", "2026-07-11T02:00:00.000Z"],
    ["museum-unrelated", "用户整理了一份完全不同的旧记录。", "2026-07-10T01:00:00.000Z"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      subjectRole: "user",
      subjectKey: "user",
      eventDate: id === "museum-unrelated" ? "2026-07-10" : "2026-07-11",
      recordedAt,
    });
  }
  const museum = repository.upsertEntity({
    id: "place:science-museum",
    agentId: "agent-test",
    kind: "place",
    canonicalName: "上海科技馆",
    aliases: ["科技馆"],
  });
  for (const memoryId of ["walk-older", "museum-unrelated"]) {
    repository.linkMemoryEntity({ memoryId, entityId: museum.id, role: "location" });
  }
  const affectiveState = repository.upsertMemory({
    id: "reported-museum-happiness",
    agentId: "agent-test",
    kind: "belief_state",
    layer: "semantic",
    content: "用户报告想到科技馆会开心。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:affective:science-museum:happy",
    evidenceMode: "explicit",
    representationLayer: "reported",
    stateFamily: "affective_association",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-11T03:00:00.000Z",
    recordedAt: "2026-07-11T03:00:00.000Z",
    metadata: {
      reportedStateDraft: {
        affectiveClaim: {
          trigger: { role: "other", key: museum.id, label: "科技馆" },
          emotion: { label: "开心", valence: "positive", intensity: "high" },
        },
      },
    },
  });
  repository.recordAffectiveActivationDecision({
    agentId: "agent-test",
    memoryId: affectiveState.id,
    enabled: true,
    policyVersion: "human-affective-v1",
    actor: "human:test",
    reason: "只允许影响已经命中的普通候选排序。",
    createdAt: "2026-07-11T04:00:00.000Z",
  });
  database.close();

  const baseline = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "周末散步计划",
  });
  assert.equal(baseline.fragments[0].memoryId, "walk-newer");
  assert.equal(baseline.trace.metadata.affectiveBias.enabled, false);

  const biased = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "周末散步计划",
    options: { affectiveBias: explicitAffectiveBiasOptions() },
  });
  assert.equal(biased.fragments[0].memoryId, "walk-older");
  assert.equal(biased.candidates[0].affectiveBias.scoreAdjustment, 0.4);
  assert.deepEqual(
    biased.candidates[0].affectiveBias.activationMemoryIds,
    ["reported-museum-happiness"],
  );
  assert.equal(
    biased.candidates.some((candidate) => candidate.memoryId === "museum-unrelated"),
    false,
  );
  assert.equal(biased.trace.metadata.affectiveBias.adjustedCandidateCount, 1);
  assert.equal(JSON.stringify(biased.trace.metadata.affectiveBias).includes("开心"), false);
  assert.equal(JSON.stringify(biased.trace.metadata.affectiveBias).includes("科技馆"), false);

  const temporal = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我上周六干啥了",
    now: new Date("2026-07-15T12:00:00+08:00"),
    options: { affectiveBias: explicitAffectiveBiasOptions() },
  });
  assert.ok(temporal.graph.selectedMemoryIds.includes("walk-newer"));
  assert.ok(temporal.trace.metadata.affectiveBias.adjustedCandidateCount >= 0);
  assert.equal(temporal.candidates.find(candidate => candidate.memoryId === "walk-newer").affectiveBias, null);

  const reopened = closeAfterTests(openMemoryDatabase(databasePath));
  const reopenedRepository = new MemoryRepository(reopened);
  reopenedRepository.recordAffectiveActivationDecision({
    agentId: "agent-test",
    memoryId: affectiveState.id,
    enabled: false,
    policyVersion: "human-affective-v1",
    actor: "human:test",
    reason: "撤销激活权限。",
    createdAt: "2026-07-11T05:00:00.000Z",
  });
  reopened.close();
  const disabled = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "周末散步计划",
    options: { affectiveBias: explicitAffectiveBiasOptions() },
  });
  assert.equal(disabled.fragments[0].memoryId, "walk-newer");
  assert.deepEqual(disabled.trace.metadata.affectiveBias.approvedActivationIds, []);
});

test("rejects incomplete affective bias activation instead of guessing emotion context", async () => {
  await assert.rejects(
    () => retrieveMemories({
      databasePath: "not-opened.db",
      agentId: "agent-test",
      query: "科技馆",
      options: {
        affectiveBias: {
          enabled: true,
          configurationVersion: "incomplete-affective-config",
        },
      },
    }),
    /需要明确的 subjectRole 与 subjectKey/u,
  );
});

test("returns a persistable retrieval trace without writing it by default", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
  });
  assert.equal(result.trace.resultStatus, "ready");
  assert.equal(result.trace.queryText, "记得我之前去科技馆吗");
  assert.ok(result.trace.seedIds.includes("u-user"));
  assert.deepEqual(result.trace.selectedIds, result.graph.selectedMemoryIds);
  assert.equal(result.trace.contextChars, result.context.length);

  const writable = closeAfterTests(openMemoryDatabase(databasePath));
  assert.equal(Number(writable.prepare(`
    SELECT COUNT(*) AS count FROM memory_retrieval_traces
  `).get().count), 0);
  const writableRepository = new MemoryRepository(writable);
  const stored = writableRepository.recordRetrievalTrace(result.trace);
  assert.deepEqual(stored.seedIds, ["u-user", "event-museum"]);
  assert.equal(stored.result_status, "ready");
  assert.deepEqual(stored.metadata.seedRouting, result.seedRouting);
  assert.equal(Number(writable.prepare(`
    SELECT COUNT(*) AS count FROM memory_retrieval_traces
  `).get().count), 1);
  writable.close();
});

test("returns one nearby two-sided exchange when original wording is requested", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  repository.upsertMemory({
    id: "unrelated-wording",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "那句话我已经改过了。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    recordedAt: "2026-07-12T03:00:00.000Z",
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "u-user",
    toMemoryId: "u-agent",
    relation: "followed_by",
    direction: "directed",
    weight: 0.7,
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆那句话我是怎么说的",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.fragments[0].memoryType, "utterance");
  assert.equal(result.disclosureLevel, "evidence");
  assert.match(result.context, /User：我上周六去了科技馆/u);
  assert.match(result.context, /Agent：你还看了机器人展/u);
});

test("anchors a forward chain at the earliest strongly matching event", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const value of [
    {
      id: "voice-start",
      content: "开始调试语音功能，已经能够合成声音。",
      eventStart: "2026-07-23T02:00:00.000Z",
    },
    {
      id: "voice-result",
      content: "语音功能最终只能发送音频文件，暂时停止继续调试。",
      eventStart: "2026-07-23T10:00:00.000Z",
    },
  ]) {
    repository.upsertMemory({
      id: value.id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: value.content,
      eventDate: "2026-07-23",
      eventStart: value.eventStart,
      recordedAt: value.eventStart,
    });
  }
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "voice-start",
    toMemoryId: "voice-result",
    relation: "timeline_next",
    direction: "directed",
    weight: 0.95,
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "语音功能后来怎么样了",
  });
  assert.deepEqual(
    result.graph.selectedMemoryIds,
    ["voice-start", "voice-result"],
  );
});

test("prefers an exact event phrase over a generic first-time mention", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "mutual-like",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "我们第一次明确互相喜欢",
    content: "双方第一次把彼此的喜欢清楚说出来。",
    eventDate: "2026-06-16",
  });
  repository.upsertMemory({
    id: "photo-first",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "第一次展示照片",
    content: "这是第一次给我看他喜欢的照片。",
    eventDate: "2026-07-23",
  });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "第一次明确互相喜欢",
  });
  assert.equal(result.fragments[0].memoryId, "mutual-like");
});

test("allocates the context budget across every selected chain memory before final formatting", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const memories = [
    ["budget-one", "第一节点标记：预算主题。"],
    ["budget-two", "第二节点标记：同一件事的后续片段。"],
    ["budget-three", "第三节点标记：联想到的收尾片段。"],
  ];
  for (const [id, prefix] of memories) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `${prefix}${"这是用于验证分段预算的长内容。".repeat(40)}`,
      recordedAt: "2026-07-20T08:00:00.000Z",
    });
  }
  for (const [fromMemoryId, toMemoryId] of [
    ["budget-one", "budget-two"],
    ["budget-two", "budget-three"],
  ]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId,
      toMemoryId,
      relation: "associated_with",
      direction: "undirected",
      weight: 1,
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "预算主题还让你想起什么",
    options: { maximumContextChars: 900 },
  });
  assert.deepEqual(result.graph.selectedMemoryIds, [
    "budget-one",
    "budget-two",
    "budget-three",
  ]);
  assert.match(result.context, /第一节点标记/u);
  assert.match(result.context, /第二节点标记/u);
  assert.match(result.context, /第三节点标记/u);
  assert.equal(result.context.length <= 900, true);
  assert.equal(result.outputBudget.sectionTruncationApplied, true);
  assert.ok(result.outputBudget.requiredTextChars > result.outputBudget.budgetedTextChars);
  assert.equal(result.outputBudget.safetyTruncationApplied, false);
  assert.deepEqual(result.trace.metadata.outputBudget, result.outputBudget);
});

test("keeps mandatory lifecycle propagation outside the ordinary fanout budget", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "mandatory-hub",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在科技馆完成了一次重要安排。",
    recordedAt: "2026-07-10T08:00:00.000Z",
  });
  repository.upsertMemory({
    id: "mandatory-plan",
    agentId: "agent-test",
    kind: "plan",
    layer: "prospective",
    content: "Agent 曾答应陪用户去科技馆完成这项安排。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  const completionEdge = repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "mandatory-hub",
    toMemoryId: "mandatory-plan",
    relation: "completes",
    direction: "directed",
    weight: 0.9,
  });
  for (let index = 1; index <= 9; index += 1) {
    const id = `mandatory-noise-${index}`;
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `同地点的无关记录 ${index}。`,
      recordedAt: `2026-06-${String(index).padStart(2, "0")}T08:00:00.000Z`,
    });
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: "mandatory-plan",
      toMemoryId: id,
      relation: "shares_entity",
      direction: "undirected",
      weight: 0.9,
    });
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId: "mandatory-hub",
      toMemoryId: id,
      relation: "shares_entity",
      direction: "undirected",
      weight: 0.9,
    });
  }
  database.prepare(`
    INSERT INTO memory_edge_relation_utility_state (
      edge_id, agent_id, intent_view, value, policy_version,
      last_observation_window_id, last_applied_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    completionEdge.id,
    "agent-test",
    "associative",
    0,
    "test-edge-policy-v1",
    "test-window",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
    "2026-07-15T00:00:00.000Z",
  );
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还有相关的吗",
    anchorMemoryIds: ["mandatory-plan"],
    options: { plasticity: explicitPlasticityOptions() },
  });

  assert.deepEqual(result.graph.selectedMemoryIds, ["mandatory-plan", "mandatory-hub"]);
  assert.equal(result.graph.paths.length, 1);
  assert.equal(result.graph.paths[0].edges[0].relation, "completes");
  assert.equal(result.graph.paths[0].edges[0].propagationPolicy, "mandatory");
  assert.equal(result.graph.paths[0].edges[0].fanout, 9);
  assert.equal(result.graph.paths[0].edges[0].fanoutFactor, 1);
  assert.equal(result.graph.paths[0].edges[0].learnedRelationUtility, null);
  assert.equal(
    result.graph.paths[0].edges[0].appliedRelationUtility,
    result.graph.paths[0].edges[0].relationUtility,
  );
  assert.equal(result.trace.metadata.plasticity.adjustedEdgeTraversalCount, 0);
  assert.match(result.context, /曾答应陪用户去科技馆完成这项安排/u);
  assert.doesNotMatch(result.context, /无关记录/u);

  const reverse = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还有相关的吗",
    anchorMemoryIds: ["mandatory-hub"],
  });
  assert.deepEqual(reverse.graph.selectedMemoryIds, ["mandatory-hub"]);
  assert.doesNotMatch(reverse.context, /曾答应陪用户/u);
});

test("uses an entity alias as a seed even when the memory text omits the place name", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const memory = repository.upsertMemory({
    id: "entity-only-seed",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在那里参加了一次很重要的年度活动。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  const entity = repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "上海科技馆",
    aliases: ["科技馆"],
  });
  repository.linkMemoryEntity({ memoryId: memory.id, entityId: entity.id, role: "location" });
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还记得上海科技馆吗",
  });
  assert.equal(result.status, "ready");
  assert.equal(result.retrievalMode, "entity-lexical");
  assert.equal(result.fragments[0].memoryId, memory.id);
  assert.equal(result.matchedEntities[0].entityId, entity.id);
  assert.equal(result.candidates[0].entityScore > 0, true);
  assert.equal(
    result.candidates[0].routeMatches.some((route) => (
      route.route === "entity" && route.independentlyAdmissible
    )),
    true,
  );
  assert.equal(result.seedRouting.routeStatus.entity, "matched");
  assert.match(result.context, /参加了一次很重要的年度活动/u);
});

test("uses a bound actor entity as an entity seed without duplicating a direct entity link", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const actor = repository.ensureActorEntity({
    agentId: "agent-test",
    actorRole: "user",
    actorKey: "caroline",
    displayName: "Caroline",
    provenance: "test",
  });
  const memory = repository.upsertMemory({
    id: "caroline-entity-only-seed",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "She attended an important committee meeting after breakfast.",
    subjectRole: "user",
    subjectKey: "caroline",
    actorRoles: [{
      role: "experiencer",
      actorRole: "user",
      actorKey: "caroline",
      isPrimary: true,
      confidence: 1,
      provenance: "test",
    }],
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  assert.deepEqual(repository.listEntityMemories({
    agentId: "agent-test",
    entityId: actor.entity.id,
  }), []);
  assert.deepEqual(
    [...new Set(repository.listActorEntityMemories({
      agentId: "agent-test",
      entityId: actor.entity.id,
    }).map((item) => item.id))],
    [memory.id],
  );
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "What did Caroline do after breakfast?",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.fragments[0].memoryId, memory.id);
  assert.equal(result.candidates[0].entityScore > 0, true);
  assert.equal(result.matchedEntities[0].entityId, actor.entity.id);
  assert.deepEqual(result.matchedEntities[0].directMemoryIds, []);
  assert.deepEqual(result.matchedEntities[0].actorMemoryIds, [memory.id]);
  assert.equal(result.seedRouting.routeStatus.entity, "matched");
});

test("combines activation from multiple seeds at their shared graph neighbor", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const memory of [
    {
      id: "field-museum",
      kind: "event",
      layer: "episodic",
      content: "用户去了科技馆。",
      recordedAt: "2026-07-11T03:00:00.000Z",
    },
    {
      id: "field-dinner",
      kind: "event",
      layer: "episodic",
      content: "两个人后来吃了晚饭。",
      recordedAt: "2026-07-11T10:00:00.000Z",
    },
  ]) repository.upsertMemory({ agentId: "agent-test", ...memory });
  repository.upsertEpisode({
    id: "field-weekend",
    agentId: "agent-test",
    content: "这是同一次周末出行中的两个片段。",
    eventStart: "2026-07-11T03:00:00.000Z",
    eventEnd: "2026-07-11T12:00:00.000Z",
    recordedAt: "2026-07-12T08:00:00.000Z",
  });
  for (const fromMemoryId of ["field-museum", "field-dinner"]) {
    repository.linkMemoryToEpisode({
      agentId: "agent-test",
      memoryId: fromMemoryId,
      episodeId: "field-weekend",
      weight: 0.9,
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还记得科技馆和那顿晚饭吗",
  });

  assert.deepEqual(result.graph.activationField.seedMemoryIds, [
    "field-museum",
    "field-dinner",
  ]);
  assert.equal(result.graph.selectedMemoryIds[0], 'field-museum');
  assert.deepEqual(new Set(result.graph.selectedMemoryIds), new Set([
    "field-museum",
    "field-dinner",
    "field-weekend",
  ]));
  const topicActivation = result.graph.activationField.selected
    .find((value) => value.memoryId === "field-weekend");
  assert.equal(topicActivation.sourceCount, 2);
  const topicPath = result.graph.paths.find((value) => value.memoryId === "field-weekend");
  assert.equal(topicPath.seedContributions.length, 2);
  assert.equal(topicPath.edges[0].relation, "part_of_episode");
  assert.equal(
    topicActivation.activation > Math.max(
      ...topicPath.seedContributions.map((value) => value.score),
    ),
    true,
  );
  assert.match(result.context, /同一次周末出行中的两个片段/u);
});

test("recalls a shared topic without spilling its high-fanout member list", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "topic-primary",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在科技馆参观了机器人展。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  repository.upsertTopic({
    id: "topic-science-visits",
    agentId: "agent-test",
    content: "这是与科学场馆体验有关的长期主题。",
  });
  repository.linkMemoryToTopic({
    agentId: "agent-test",
    memoryId: "topic-primary",
    topicId: "topic-science-visits",
  });
  for (let index = 1; index <= 9; index += 1) {
    const id = `topic-noise-${index}`;
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content: `主题下的普通活动 ${index}。`,
      recordedAt: `2026-06-${String(index).padStart(2, "0")}T08:00:00.000Z`,
    });
    repository.linkMemoryToTopic({
      agentId: "agent-test",
      memoryId: id,
      topicId: "topic-science-visits",
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆还让你想起什么",
  });

  assert.deepEqual(result.graph.selectedMemoryIds, [
    "topic-primary",
    "topic-science-visits",
  ]);
  assert.equal(result.graph.paths[0].edges[0].relation, "supports_topic");
  assert.equal(result.graph.paths[0].edges[0].propagationPolicy, "conditional");
  assert.match(result.context, /长期主题/u);
  assert.doesNotMatch(result.context, /普通活动/u);
});

test("bounds activation work even when the reachable graph contains a cycle", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (const [id, content] of [
    ["cycle-a", "科技馆里的机器人展。"],
    ["cycle-b", "机器人相关的后续讨论。"],
    ["cycle-c", "另一次相关活动。"],
  ]) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
      recordedAt: "2026-07-01T08:00:00.000Z",
    });
  }
  for (const [fromMemoryId, toMemoryId] of [
    ["cycle-a", "cycle-b"],
    ["cycle-b", "cycle-c"],
    ["cycle-c", "cycle-a"],
  ]) {
    repository.upsertEdge({
      agentId: "agent-test",
      fromMemoryId,
      toMemoryId,
      relation: "associated_with",
      direction: "undirected",
      weight: 0.9,
    });
  }
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "科技馆还让你想起什么",
    options: { maximumActivationWork: 1 },
  });

  assert.equal(result.graph.activationField.processedStates, 1);
  assert.equal(result.graph.activationField.truncated, true);
  assert.equal(result.graph.selectedMemoryIds.length <= 3, true);
});

test("an independently admitted entity match participates in the shared ranking", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const direct = repository.upsertMemory({
    id: "direct-place-memory",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户去了上海科技馆。",
    recordedAt: "2026-07-01T08:00:00.000Z",
  });
  const entityOnly = repository.upsertMemory({
    id: "entity-only-neighbor",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户在那里参加了一次年度活动。",
    recordedAt: "2026-07-02T08:00:00.000Z",
  });
  const entity = repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "上海科技馆",
    aliases: ["科技馆"],
  });
  repository.linkMemoryEntity({ memoryId: direct.id, entityId: entity.id, role: "location" });
  repository.linkMemoryEntity({ memoryId: entityOnly.id, entityId: entity.id, role: "location" });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: direct.id,
    toMemoryId: entityOnly.id,
    relation: "shares_entity",
    direction: "undirected",
    weight: 0.9,
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "还记得上海科技馆吗",
  });

  assert.equal(result.status, "ready");
  assert.equal(result.fragments[0].memoryId, direct.id);
  assert.deepEqual(result.graph.selectedMemoryIds, [direct.id, entityOnly.id]);
  assert.ok(result.candidates.find(value => value.memoryId === direct.id).score
    > result.candidates.find(value => value.memoryId === entityOnly.id).score);
  assert.match(result.context, /年度活动/u);
});

test("bypasses ordinary decay only when subject time entity and content all match", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const precise = repository.upsertMemory({
    id: "precise-old-museum-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "上海科技馆机器人展",
    content: "用户在上海科技馆看了机器人展。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2024-01-06",
    recordedAt: "2024-01-06T12:00:00.000Z",
  });
  repository.upsertMemory({
    id: "text-only-old-museum-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆机器人介绍",
    content: "用户在科技馆看了机器人主题的介绍。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2024-01-06",
    recordedAt: "2024-01-06T13:00:00.000Z",
  });
  const museum = repository.upsertEntity({
    agentId: "agent-test",
    kind: "place",
    canonicalName: "上海科技馆",
    aliases: ["科技馆"],
  });
  repository.linkMemoryEntity({
    memoryId: precise.id,
    entityId: museum.id,
    role: "location",
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "2024年1月6日我在上海科技馆看机器人展的事",
    now: new Date("2026-08-04T12:00:00.000Z"),
    options: {
      maximumReturnedCandidates: 5,
      naturalDecay: {
        enabled: true,
        configurationVersion: "test-natural-decay-v2",
        floor: 0.25,
        scaleDays: 30,
        decayExponent: 0.5,
        maximumScoreReduction: 0.12,
      },
    },
  });

  assert.equal(result.status, "ready");
  const exact = result.candidates.find((candidate) => (
    candidate.memoryId === "precise-old-museum-event"
  ));
  const textOnly = result.candidates.find((candidate) => (
    candidate.memoryId === "text-only-old-museum-event"
  ));
  assert.equal(exact.naturalDecay.bypassed, true);
  assert.equal(exact.naturalDecay.bypassReason, "high-specificity-match");
  assert.deepEqual(exact.naturalDecay.specificity, {
    time: true,
    entity: true,
    content: true,
  });
  assert.equal(exact.naturalDecay.scoreAdjustment, 0);
  assert.equal(textOnly.naturalDecay.bypassed, false);
  assert.ok(textOnly.naturalDecay.scoreAdjustment < 0);
  assert.equal(result.trace.metadata.naturalDecay.bypassedCandidateCount, 1);
});

test("labels inferred long-term state as a revocable inference instead of reported speech", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "inferred-puzzle-selection",
    agentId: "agent-test",
    kind: "derived_hypothesis",
    layer: "semantic",
    content: "用户在空闲时间表现出对解谜游戏的选择倾向。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "user:preference:puzzle-games",
    reality: "real",
    evidenceMode: "inferred",
    representationLayer: "inferred",
    stateFamily: "preference",
    statePhase: "active",
    temporalState: "current",
    validFrom: "2026-07-10T08:00:00.000Z",
    knownAt: "2026-07-10T08:00:00.000Z",
    metadata: { preferenceStateLevel: "selection_tendency" },
  });
  database.close();

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "解谜游戏",
  });
  assert.equal(result.status, "ready");
  assert.match(result.context, /推断[：（]/u);
  assert.match(result.context, /选择倾向/u);
});

test("can use a matching cached vector when lexical terms are weak", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "quiet-place",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    content: "楼顶是用户独处时最常去的秘密基地。",
    subjectRole: "user",
    subjectKey: "user",
    canonicalKey: "place.private-rooftop",
    importance: 0.7,
  });
  repository.upsertEmbedding({
    memoryId: "quiet-place",
    model: "embedding-test",
    vector: [1, 0],
  });
  database.close();
  let embeddedQuery = "";
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我通常去哪里躲清静",
    embeddingProvider: async (queryText) => {
      embeddedQuery = queryText;
      return {
        vector: new Float32Array([1, 0]),
        model: "embedding-test",
        usage: {},
        metadata: {},
      };
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.retrievalMode, "hybrid");
  assert.equal(result.fragments[0].memoryId, "quiet-place");
  assert.equal(result.seedRouting.routeStatus.vector, "matched");
  assert.equal(embeddedQuery, "我通常去哪里躲清静");
  assert.equal(result.vector.queryText, "我通常去哪里躲清静");
  assert.equal(result.vector.querySource, "original");
  assert.equal(
    result.candidates[0].routeMatches.some((route) => (
      route.route === "vector" && route.independentlyAdmissible
    )),
    true,
  );
});

test("requires two weak routes to corroborate instead of adding arbitrary weak scores", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "weak-corroborated",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    content: "用户把旧票根放在蓝色盒子里。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.upsertEmbedding({
    memoryId: "weak-corroborated",
    model: "embedding-test",
    vector: [0.45, Math.sqrt(1 - 0.45 ** 2)],
  });
  database.close();
  const options = {
    minimumLexicalScore: 1,
    strongLexicalScore: 100,
    minimumVectorSimilarity: 0.4,
    strongVectorSimilarity: 0.9,
    // Keep BM25 deliberately below its independent-admission threshold so
    // this test continues to exercise the two-weak-routes case.
    strongBm25Score: 1,
  };
  const lexicalOnly = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "旧票根在哪里",
    options,
  });
  assert.equal(lexicalOnly.status, "no-match");
  assert.equal(lexicalOnly.seedRouting.routeStatus.lexical, "supporting-only");

  const corroborated = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "旧票根在哪里",
    options,
    embeddingProvider: async () => ({
      vector: new Float32Array([1, 0]),
      model: "embedding-test",
      usage: {},
      metadata: {},
    }),
  });
  assert.equal(corroborated.status, "ready");
  assert.equal(corroborated.candidates[0].memoryId, "weak-corroborated");
  assert.equal(corroborated.candidates[0].admission, "corroborated");
  assert.equal(corroborated.seedRouting.routeStatus.lexical, "matched");
  assert.equal(corroborated.seedRouting.routeStatus.vector, "matched");
  assert.deepEqual(
    corroborated.candidates[0].routeMatches.map((route) => route.route),
    ["lexical", "bm25", "vector"],
  );
  assert.equal(
    corroborated.candidates[0].routeMatches
      .filter((route) => ["lexical", "bm25"].includes(route.route))
      .every((route) => route.contribution > 0),
    false,
  );
  assert.equal(
    corroborated.candidates[0].routeMatches.every((route) => !route.independentlyAdmissible),
    true,
  );
});

test("allows strong BM25 text evidence to admit a candidate without a vector", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  repository.upsertMemory({
    id: "bm25-vector-memory",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    content: "用户把旧票根放在蓝色盒子里。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.upsertEmbedding({
    memoryId: "bm25-vector-memory",
    model: "embedding-test",
    vector: [0.45, Math.sqrt(1 - 0.45 ** 2)],
  });
  database.close();
  const options = {
    minimumLexicalScore: 100,
    strongLexicalScore: 100,
    minimumVectorSimilarity: 0.4,
    strongVectorSimilarity: 0.9,
    minimumBm25CorroborationScore: 0.4,
  };
  const textOnly = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "旧票根在哪里",
    options,
  });
  assert.equal(textOnly.status, "ready");
  assert.equal(textOnly.candidates[0].memoryId, "bm25-vector-memory");
  assert.equal(textOnly.candidates[0].admission, "independent");
  assert.equal(textOnly.seedRouting.routeStatus.bm25, "matched");
  assert.equal(
    textOnly.candidates[0].routeMatches
      .find((route) => route.route === "bm25")?.independentlyAdmissible,
    true,
  );
  // This fixture suppresses the n-gram route (its threshold is 100) and has
  // no query vector. A positive final score therefore proves the independently
  // admitted BM25 route retained a scoring contribution without exposing that
  // internal contribution in the public route audit.
  assert.ok(Number(textOnly.candidates[0].score) > 0);
  assert.equal(
    textOnly.candidates[0].routeMatches.some((route) => route.route === "vector"),
    false,
  );

  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "旧票根在哪里",
    options,
    embeddingProvider: async () => ({
      vector: new Float32Array([1, 0]),
      model: "embedding-test",
      usage: {},
      metadata: {},
    }),
  });
  assert.equal(result.status, "ready");
  assert.equal(result.candidates[0].memoryId, "bm25-vector-memory");
  assert.equal(result.candidates[0].admission, "independent");
  assert.equal(result.seedRouting.routeStatus.bm25, "matched");
  assert.equal(result.seedRouting.routeStatus.vector, "matched");
  assert.equal(result.candidates[0].routeMatches.some((route) => route.route === "bm25"), true);
});

test("allows a strong generated retrieval-context BM25 match to admit a candidate", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const memory = repository.upsertMemory({
    id: "contextual-education-memory",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    title: "矿大经历",
    content: "用户明确说自己上的是矿大。",
    subjectRole: "user",
    subjectKey: "user",
  });
  repository.upsertMemoryRetrievalContext({
    agentId: "agent-test",
    memoryId: memory.id,
    policyVersion: "retrieval-context-v1",
    sourceHash: memoryRetrievalContextSourceHash(memory),
    contextText: "这条记忆回答用户的大学教育背景和就读学校。",
    queryTerms: ["我的大学教育背景是什么", "读的哪里"],
    promptVersion: "retrieval-context-v1",
  });
  repository.upsertEmbedding({
    memoryId: memory.id,
    model: "embedding-test",
    vector: [0.45, Math.sqrt(1 - 0.45 ** 2)],
  });
  database.close();
  const options = {
    minimumLexicalScore: 100,
    strongLexicalScore: 100,
    minimumVectorSimilarity: 0.4,
    strongVectorSimilarity: 0.9,
    minimumBm25CorroborationScore: 0.4,
  };
  const textOnly = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我的大学教育背景是什么",
    options,
  });
  assert.equal(textOnly.status, "ready");
  assert.equal(textOnly.seedRouting.routeStatus.bm25, "matched");
  assert.equal(textOnly.seedRouting.bm25Routing.matchedMemoryCount, 1);
  assert.equal(textOnly.seedRouting.directCandidateCount, 1);
  assert.equal(textOnly.candidates[0].admission, "independent");
  assert.equal(
    textOnly.candidates[0].routeMatches
      .find((route) => route.route === "bm25")?.independentlyAdmissible,
    true,
  );

  const corroborated = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "我的大学教育背景是什么",
    options,
    embeddingProvider: async () => ({
      vector: new Float32Array([1, 0]),
      model: "embedding-test",
      usage: {},
      metadata: {},
    }),
  });
  assert.equal(corroborated.status, "ready");
  assert.equal(corroborated.candidates[0].memoryId, memory.id);
  assert.equal(corroborated.candidates[0].admission, "independent");
  assert.equal(corroborated.seedRouting.routeStatus.bm25, "matched");
  assert.equal(
    corroborated.candidates[0].routeMatches
      .find((route) => route.route === "bm25")?.independentlyAdmissible,
    true,
  );
});

test("bounds convergence-only route audit without hiding its total", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  for (let index = 0; index < 15; index += 1) {
    repository.upsertMemory({
      id: `weak-audit-${index}`,
      agentId: "agent-test",
      kind: "fact",
      layer: "semantic",
      content: `蓝色盒子里的普通票根编号${index}。`,
    });
  }
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "蓝色盒子在哪里",
    options: { strongLexicalScore: 100 },
  });
  assert.equal(result.status, "no-match");
  assert.equal(result.seedRouting.directCandidateCount, 0);
  assert.equal(result.seedRouting.convergenceCandidateCount, 15);
  assert.equal(result.seedRouting.candidates.length, 10);
  assert.equal(result.seedRouting.omittedConvergenceCandidateCount, 5);
});

test("falls back to lexical retrieval and retains charged embedding failures", async t => {
  t.after(closeRetrievalWorkers);
  const { root, databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
    embeddingProvider: async () => {
      throw new Error("service offline");
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(result.retrievalMode, "episodic-lexical");
  assert.equal(result.vector.status, "error");
  assert.match(result.vector.warning, /已退回文本检索/u);
  assert.equal(result.fragments[0].memoryId, "u-user");
  assert.equal(result.seedRouting.routeStatus.vector, "error");
  assert.equal(result.seedRouting.routeStatus.lexical, "matched");
  const ledgerPath = path.join(root, 'failed-query-usage.jsonl');
  for (const execution of ['inline', 'worker']) {
    const recalled = await retrieveMemories({
      databasePath, agentId: 'agent-test', query: '记得我之前去科技馆吗', usageLedgerPath: ledgerPath,
      options: { execution },
      embeddingProvider: async () => { throw Object.assign(new Error('Invalid embedding response'), {
        model: 'embedding-test', usage: { prompt_tokens: 17, total_tokens: 17 }, requestId: execution,
      }); },
    });
    assert.equal(recalled.status, 'ready');
    assert.equal(recalled.fragments[0].memoryId, 'u-user');
    assert.equal(recalled.vector.status, 'error');
    assert.equal(recalled.vector.usageRecorded, true, execution);
  }
  const events = fs.readFileSync(ledgerPath, 'utf8').trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(events.map(event => event.requestId), ['inline', 'worker']);
  assert.equal(events.reduce((sum, event) => sum + event.usage.prompt_tokens, 0), 34);
});

test("keeps causes edges inert during ordinary recall", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  seedMuseumMemory(repository);
  repository.upsertMemory({
    id: "unrelated-effect",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "用户后来取消了另一项出门计划。",
    subjectRole: "user",
    subjectKey: "user",
    recordedAt: "2026-07-12T03:00:00.000Z",
  });
  database.close();
  const input = {
    databasePath,
    agentId: "agent-test",
    query: "记得我之前去科技馆吗",
    now: new Date("2026-07-15T12:00:00+08:00"),
  };
  const before = await retrieveMemories(input);
  const writable = closeAfterTests(openMemoryDatabase(databasePath));
  const writableRepository = new MemoryRepository(writable);
  writableRepository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "event-museum",
    toMemoryId: "unrelated-effect",
    relation: "causes",
    direction: "directed",
    weight: 1,
    confidence: 1,
    provenance: "accepted-relation-proposal-v1",
  });
  writable.close();
  const after = await retrieveMemories(input);
  assert.equal(after.context, before.context);
  assert.deepEqual(after.trace.seedIds, before.trace.seedIds);
  assert.deepEqual(after.trace.selectedIds, before.trace.selectedIds);
  assert.deepEqual(after.graph.selectedMemoryIds, before.graph.selectedMemoryIds);
});

test("suppresses weak causes behind a reviewed high-fanout effect", async () => {
  const { databasePath, database, repository } = temporaryDatabase();
  const source = repository.upsertSource({
    agentId: "agent-test",
    sourceKind: "manual-evaluation",
    externalId: "causal-fanout-evidence",
    content: "测试证据明确列出一个主要原因和多个很弱的次要原因。",
  });
  repository.upsertMemory({
    id: "fanout-effect",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    content: "目标任务最终停止。",
  });
  repository.linkSource("fanout-effect", source.id, "evidence");
  const causes = [
    ["fanout-strong-cause", "主要故障直接导致任务停止。", 1],
    ...Array.from({ length: 8 }, (_, index) => [
      `fanout-weak-cause-${index}`,
      `弱相关原因 ${index}。`,
      0.05,
    ]),
  ];
  for (const [id, content, weight] of causes) {
    repository.upsertMemory({
      id,
      agentId: "agent-test",
      kind: "event",
      layer: "episodic",
      content,
    });
    repository.linkSource(id, source.id, "evidence");
    const proposal = proposeMemoryRelation(repository, {
      agentId: "agent-test",
      relation: "causes",
      fromMemoryId: id,
      toMemoryId: "fanout-effect",
      evidenceSourceIds: [source.id],
      weight,
      confidence: 1,
      rationale: "用于验证审核后因果边的扇出预算。",
    });
    resolveMemoryRelationProposal(repository, {
      agentId: "agent-test",
      proposalId: proposal.id,
      action: "accept",
      resolvedBy: "human:test",
    });
  }
  database.close();
  const result = await retrieveMemories({
    databasePath,
    agentId: "agent-test",
    query: "为什么目标任务最终停止",
  });
  assert.deepEqual(result.graph.selectedMemoryIds, [
    "fanout-effect",
    "fanout-strong-cause",
  ]);
  assert.doesNotMatch(result.context, /弱相关原因/u);
});

for (const content of ['用户以前喜欢解谜游戏。', 'The user used to like puzzle games.']) {
  test('recalls a source statement awaiting analysis without labeling it a model impression: ' + content, async t => {
    const fixture = temporaryDatabase();
    const { root, databasePath, database, repository } = fixture;
    t.after(() => {
      const resolved = path.resolve(root);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
      assert.ok(path.basename(resolved).startsWith('suzu-retriever-'));
      fs.rmSync(resolved, { recursive: true, force: true });
    });
    const source = repository.upsertSource({ agentId: 'agent-test', sourceKind: 'conversation', externalId: 'past-like',
      speaker: 'User', content, occurredAt: '2026-07-10T12:00:00Z' });
    repository.upsertMemory({ id: 'past-preference-statement', agentId: 'agent-test', kind: 'preference',
      layer: 'provisional', status: 'archived', content, subjectRole: 'user', subjectKey: 'user',
      stateFamily: 'preference', evidenceMode: 'explicit', representationLayer: 'unspecified', temporalState: 'historical',
      metadata: { provisional: true, epistemicStatus: 'source_record' } });
    repository.linkSource('past-preference-statement', source.id, 'evidence', { authority: 'subject_firsthand' });
    repository.recordIngestionDecision({ agentId: 'agent-test', batchId: 'past-like', candidateIndex: 0,
      decision: 'review', resultStatus: 'review', reasonCodes: ['state-analysis-specialist-fallback'],
      candidate: { kind: 'preference', content }, provisionalMemoryId: 'past-preference-statement' });
    database.close();
    const result = await retrieveMemories({ databasePath, agentId: 'agent-test', query: '解谜游戏 puzzle games',
      options: { includeCandidateContext: true } });
    const recalled = result.candidates.find(candidate => candidate.memoryId === 'past-preference-statement');
    assert.ok(recalled, JSON.stringify(result.candidates));
    assert.match(recalled.recallContext, /自述：/);
    assert.doesNotMatch(recalled.recallContext, /个人印象|基于关联证据的推断/);
    assert.deepEqual(result.trace.selectedIds, []);
  });
}
