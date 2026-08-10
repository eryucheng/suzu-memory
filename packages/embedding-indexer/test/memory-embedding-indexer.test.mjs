import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";

import {
  assessMemoryRetrievalContextNeed,
  assessMemoryRetrievalContextCriticNeed,
  buildMemoryEmbeddingDocument,
  generateMemoryRetrievalContexts,
  syncMemoryEmbeddings,
} from "../src/index.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-memory-indexer-"));
  const database = openMemoryDatabase(path.join(root, "memory.db"));
  const repository = new MemoryRepository(database);
  repository.upsertMemory({
    id: "relationship-state",
    agentId: "agent-test",
    kind: "relationship",
    layer: "relational",
    title: "双方是恋人关系",
    content: "用户明确把 Agent 当成恋人。",
    subjectRole: "user",
    subjectKey: "user",
    stateFamily: "relationship",
    statePhase: "active",
    temporalState: "current",
    reality: "real",
  });
  repository.upsertMemory({
    id: "museum-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆之行",
    content: "用户周六去了科技馆。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-11",
    reality: "real",
  });
  repository.upsertMemory({
    id: "raw-utterance",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "这是需要进入独立情景证据索引的原话。",
    subjectRole: "user",
    subjectKey: "user",
  });
  return { root, database, repository };
}

function fakeProvider({ dimensions = 3, fail = false } = {}) {
  const calls = [];
  const provider = async (text) => {
    const response = await provider.embedMany([text]);
    return { ...response, vector: response.vectors[0] };
  };
  provider.model = "text-embedding-v4";
  provider.dimensions = dimensions;
  provider.embedMany = async (texts) => {
    calls.push([...texts]);
    if (fail) throw new Error("provider failed");
    return {
      model: provider.model,
      vectors: texts.map((text, index) => Float32Array.from(
        Array.from({ length: dimensions }, (_, dimension) => text.length + index + dimension + 1),
      )),
      usage: { prompt_tokens: texts.length * 10, total_tokens: texts.length * 10 },
      requestId: `request-${calls.length}`,
      metadata: { provider: "fake" },
    };
  };
  provider.calls = calls;
  return provider;
}

function fakeContextGenerators({
  approved = true,
  context = "这条记忆回答用户的大学教育背景和就读学校。",
  queryTerms = ["大学", "教育背景", "读的哪里", "就读学校"],
} = {}) {
  const calls = [];
  const generator = async (request) => {
    calls.push(request);
    if (request.schemaName === "memory_retrieval_context_proposal_v1") {
      return {
        output: {
          context,
          queryTerms,
        },
        model: "fake-context-model",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        requestId: "proposal-request",
        durationMs: 12,
        metadata: { provider: "fake" },
      };
    }
    if (request.schemaName === "memory_retrieval_context_critic_v1") {
      return {
        output: approved
          ? { approved: true, issues: [] }
          : { approved: false, issues: ["提案引入了源记忆没有的事实。"] },
        model: "fake-critic-model",
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        requestId: "critic-request",
        durationMs: 8,
        metadata: { provider: "fake" },
      };
    }
    throw new Error(`unexpected schema ${request.schemaName}`);
  };
  generator.calls = calls;
  return generator;
}

test("selects only memories whose own text is too short or starts with an unresolved reference", () => {
  assert.deepEqual(
    assessMemoryRetrievalContextNeed({
      title: "矿大教育经历",
      content: "其实我上的是矿大",
    }).reasons,
    ["short-content"],
  );
  assert.deepEqual(
    assessMemoryRetrievalContextNeed({
      title: "后续处理",
      content: "这件事后来经过几轮讨论才确定了最终处理方式，并保留了完整证据和当时双方确认过的时间记录。",
    }).reasons,
    ["leading-reference"],
  );
  assert.equal(
    assessMemoryRetrievalContextNeed({
      title: "科技馆机器人展",
      content: "用户在 2026 年 7 月 11 日去了上海科技馆，并依次参观了机器人展、航天展和自然历史展区。",
    }).needed,
    false,
  );
});

test("uses an independent critic only for subject, world, state, time, negation, or reference risks", () => {
  assert.equal(assessMemoryRetrievalContextCriticNeed({
    content: "用户明确说自己上的是矿大。",
    subjectRole: "user",
    reality: "real",
  }, { reasons: ["short-content"] }).needed, false);
  assert.deepEqual(assessMemoryRetrievalContextCriticNeed({
    content: "这件事后来没有继续。",
    subjectRole: "user",
    reality: "real",
    eventDate: "2026-07-11",
  }, { reasons: ["leading-reference"] }).reasons, [
    "unresolved-reference",
    "time-boundary",
    "negation-boundary",
  ]);
});

test("builds deterministic text from semantic fields without metadata noise", () => {
  const text = buildMemoryEmbeddingDocument({
    id: "memory-1",
    kind: "relationship",
    title: "关系",
    content: "用户把 Agent 当成恋人。",
    subject_role: "user",
    subject_key: "user",
    reality: "real",
    metadata: { privateNoise: "不应进入向量" },
  });
  assert.match(text, /记忆类型：relationship/u);
  assert.match(text, /主体角色：user/u);
  assert.doesNotMatch(text, /privateNoise|不应进入向量/u);
});

test("indexes structured memories and raw evidence, reuses hashes, and reindexes a changed node", async () => {
  const { database, repository } = fixture();
  const provider = fakeProvider();
  const first = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
  });
  assert.equal(first.added, 3);
  assert.equal(first.excludedByKind, 0);
  assert.equal(provider.calls.length, 1);
  assert.match(provider.calls.flat().join("\n"), /独立情景证据索引/u);

  const second = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
  });
  assert.equal(second.added, 0);
  assert.equal(second.reused, 3);
  assert.equal(provider.calls.length, 1);

  repository.editMemoryManually({
    agentId: "agent-test",
    memoryId: "museum-event",
    patch: { content: "用户周六去了科技馆并参观机器人展。" },
    reason: "test",
  });
  const third = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
  });
  assert.equal(third.added, 1);
  assert.equal(third.reused, 2);
  assert.equal(provider.calls.length, 2);
  assert.match(provider.calls.at(-1)[0], /机器人展/u);
  database.close();
});

test("adds the adjacent exchange to an utterance embedding without changing the stored utterance", async () => {
  const { database, repository } = fixture();
  repository.upsertMemory({
    id: "raw-utterance-reply",
    agentId: "agent-test",
    kind: "utterance",
    layer: "evidence",
    content: "Agent 回应了这段独立情景证据。",
    subjectRole: "agent",
    subjectKey: "agent-test",
    eventStart: "2026-08-06T04:01:00.000Z",
    metadata: { speaker: "Agent" },
  });
  repository.upsertEdge({
    agentId: "agent-test",
    fromMemoryId: "raw-utterance",
    toMemoryId: "raw-utterance-reply",
    relation: "followed_by",
    direction: "directed",
    weight: 1,
    confidence: 1,
  });
  const provider = fakeProvider();
  const result = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    memoryIds: ["raw-utterance"],
  });
  assert.equal(result.added, 1);
  assert.equal(provider.calls.length, 1);
  assert.match(provider.calls[0][0], /独立情景证据索引/u);
  assert.match(provider.calls[0][0], /Agent 回应了这段独立情景证据/u);
  assert.equal(repository.getMemory("raw-utterance").content, "这是需要进入独立情景证据索引的原话。");
  database.close();
});

test("indexes only still-pending provisional impressions when explicitly queued", async () => {
  const { database, repository } = fixture();
  repository.upsertMemory({
    id: "provisional-memory",
    agentId: "agent-test",
    kind: "fact",
    layer: "provisional",
    content: "Agent 猜测用户喜欢参观科技馆。",
    subjectRole: "user",
    subjectKey: "user",
    evidenceMode: "inferred",
    status: "archived",
    metadata: { provisional: true, epistemicStatus: "agent_impression" },
  });
  const decision = repository.recordIngestionDecision({
    agentId: "agent-test",
    batchId: "batch-provisional-index",
    candidateIndex: 0,
    decision: "review",
    resultStatus: "review",
    reasonCodes: ["user-memory-without-user-source"],
    candidate: { kind: "fact", content: "用户喜欢参观科技馆。" },
    provisionalMemoryId: "provisional-memory",
  });
  const provider = fakeProvider();
  const indexed = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    memoryIds: ["provisional-memory"],
  });
  assert.equal(indexed.totalProvisional, 1);
  assert.equal(indexed.added, 1);
  assert.deepEqual(
    repository.listEmbeddings("agent-test", provider.model, { includeArchived: true })
      .map((item) => item.memory_id),
    ["provisional-memory"],
  );
  repository.resolveIngestionDecision({
    agentId: "agent-test",
    decisionId: decision.id,
    resolution: "dismissed",
  });
  const afterDismissal = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    memoryIds: ["provisional-memory"],
  });
  assert.equal(afterDismissal.totalProvisional, 0);
  assert.equal(afterDismissal.totalEligible, 0);
  database.close();
});

test("records API usage and leaves existing vectors intact when a rebuild fails", async () => {
  const { root, database, repository } = fixture();
  const ledgerPath = path.join(root, "usage-events.jsonl");
  const provider = fakeProvider();
  await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    ledgerPath,
  });
  const events = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.equal(events.length, 1);
  assert.equal(events[0].feature, "memory-index-embedding");

  const before = repository.listEmbeddings("agent-test", provider.model);
  const failed = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: fakeProvider({ fail: true }),
    force: true,
    maxRetries: 0,
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.failed, 3);
  const after = repository.listEmbeddings("agent-test", provider.model);
  assert.deepEqual(
    after.map((item) => [item.memory_id, item.content_hash]).sort(),
    before.map((item) => [item.memory_id, item.content_hash]).sort(),
  );
  database.close();
});

test("does not write a batch when vector dimensions are inconsistent", async () => {
  const { database, repository } = fixture();
  const provider = fakeProvider({ dimensions: 4 });
  const result = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    dimensions: 3,
  });
  assert.equal(result.status, "error");
  assert.equal(repository.listEmbeddings("agent-test", provider.model).length, 0);
  database.close();
});

test("stores critic-approved retrieval context separately and sends it to FTS and embeddings", async () => {
  const { root, database, repository } = fixture();
  repository.upsertMemory({
    id: "education-fact",
    agentId: "agent-test",
    kind: "fact",
    layer: "semantic",
    title: "矿大教育经历",
    content: "用户明确说自己上的是矿大。",
    subjectRole: "user",
    subjectKey: "user",
    reality: "real",
  });
  assert.equal(repository.search("agent-test", "大学教育").length, 0);

  const generator = fakeContextGenerators();
  const ledgerPath = path.join(root, "context-usage.jsonl");
  const generated = await generateMemoryRetrievalContexts({
    repository,
    agentId: "agent-test",
    proposer: generator,
    critic: generator,
    memoryIds: ["education-fact"],
    ledgerPath,
  });
  assert.equal(generated.added, 1);
  assert.equal(generated.rejected, 0);
  assert.equal(generator.calls.length, 1);
  assert.equal(generated.criticCalls, 0);
  assert.equal(generated.locallyApproved, 1);
  assert.equal(repository.getMemory("education-fact").content, "用户明确说自己上的是矿大。");
  assert.equal(repository.search("agent-test", "大学教育")[0].id, "education-fact");
  assert.equal(repository.search("agent-test", "大学")[0].id, "education-fact");

  const provider = fakeProvider();
  const indexed = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    memoryIds: ["education-fact"],
  });
  assert.equal(indexed.added, 1);
  const embeddedText = provider.calls.flat().join("\n");
  assert.match(embeddedText, /检索上下文：这条记忆回答用户的大学教育背景和就读学校/u);
  assert.match(embeddedText, /常见查询表达：大学；教育背景；读的哪里；就读学校/u);

  const usage = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/u).map(JSON.parse);
  assert.deepEqual(usage.map((item) => item.feature), [
    "memory-retrieval-context-proposal",
  ]);

  const replay = await generateMemoryRetrievalContexts({
    repository,
    agentId: "agent-test",
    proposer: generator,
    critic: generator,
    memoryIds: ["education-fact"],
  });
  assert.equal(replay.reused, 1);
  assert.equal(replay.pending, 0);
  assert.equal(generator.calls.length, 1);
  database.close();
});

test("skips self-contained memories without calling either context model", async () => {
  const { database, repository } = fixture();
  repository.upsertMemory({
    id: "self-contained-event",
    agentId: "agent-test",
    kind: "event",
    layer: "episodic",
    title: "科技馆机器人展",
    content: "用户在 2026 年 7 月 11 日去了上海科技馆，并依次参观了机器人展、航天展和自然历史展区。",
    subjectRole: "user",
    subjectKey: "user",
    eventDate: "2026-07-11",
    reality: "real",
  });
  const shouldNotRun = async () => {
    throw new Error("自包含记忆不应调用检索上下文模型。");
  };
  const generated = await generateMemoryRetrievalContexts({
    repository,
    agentId: "agent-test",
    proposer: shouldNotRun,
    critic: shouldNotRun,
    memoryIds: ["self-contained-event"],
  });
  assert.equal(generated.status, "ready");
  assert.equal(generated.totalEligible, 1);
  assert.equal(generated.selected, 0);
  assert.equal(generated.skipped, 1);
  assert.equal(generated.pending, 0);
  assert.equal(generated.added, 0);
  assert.deepEqual(generated.selectionReasons, {});
  database.close();
});

test("does not store a rejected retrieval context", async () => {
  const { database, repository } = fixture();
  const generator = fakeContextGenerators({ approved: false });
  const generated = await generateMemoryRetrievalContexts({
    repository,
    agentId: "agent-test",
    proposer: generator,
    critic: generator,
    memoryIds: ["museum-event"],
  });
  assert.equal(generated.added, 0);
  assert.equal(generated.rejected, 1);
  assert.equal(repository.getCurrentMemoryRetrievalContext("museum-event"), null);
  assert.equal(repository.listMemoryRetrievalContexts({
    agentId: "agent-test",
    memoryId: "museum-event",
  }).length, 0);
  database.close();
});

test("rejects generator output that only resembles but does not satisfy the fixed schema", async () => {
  const { database, repository } = fixture();
  const malformed = async ({ schemaName }) => ({
    output: schemaName === "memory_retrieval_context_proposal_v1"
      ? { context: "这段文字长度足够但 queryTerms 不是数组。", queryTerms: "科技馆" }
      : { approved: true, issues: [] },
    model: "fake-malformed-model",
    usage: {},
  });
  const generated = await generateMemoryRetrievalContexts({
    repository,
    agentId: "agent-test",
    proposer: malformed,
    critic: malformed,
    memoryIds: ["museum-event"],
  });
  assert.equal(generated.status, "error");
  assert.equal(generated.failed, 1);
  assert.match(generated.results[0].error, /固定 Schema/u);
  assert.equal(repository.getCurrentMemoryRetrievalContext("museum-event"), null);
  database.close();
});

test("stales retrieval context after source memory changes and then reindexes without it", async () => {
  const { database, repository } = fixture();
  const generator = fakeContextGenerators({
    context: "这条记忆回答用户去科技馆的日期和参观经历。",
    queryTerms: ["科技馆", "哪天去的", "参观经历"],
  });
  await generateMemoryRetrievalContexts({
    repository,
    agentId: "agent-test",
    proposer: generator,
    critic: generator,
    memoryIds: ["museum-event"],
  });
  const provider = fakeProvider();
  await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    memoryIds: ["museum-event"],
  });
  assert.match(provider.calls.at(-1)[0], /去科技馆的日期/u);

  repository.editMemoryManually({
    agentId: "agent-test",
    memoryId: "museum-event",
    patch: { content: "用户周日去了科技馆。" },
    reason: "correct event day",
  });
  assert.equal(repository.getCurrentMemoryRetrievalContext("museum-event"), null);
  const reindexed = await syncMemoryEmbeddings({
    repository,
    agentId: "agent-test",
    embeddingProvider: provider,
    memoryIds: ["museum-event"],
  });
  assert.equal(reindexed.added, 1);
  assert.doesNotMatch(provider.calls.at(-1)[0], /去科技馆的日期/u);
  assert.match(provider.calls.at(-1)[0], /用户周日去了科技馆/u);
  database.close();
});
