import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MemoryRepository,
  openMemoryDatabase,
} from "@suzu-memory/core";
import {
  LONG_TERM_EXTRACTION_SCHEMA,
  RETENTION_REASONS,
  archiveLongTermEvidence,
  buildLongTermExtractionInput,
  detectExtractionLanguage,
  isRetentionReasonCompatible,
  loadLongTermExtractionSystemPrompt,
  parseGeneratedLongTermExtraction,
} from "../src/index.mjs";

function temporaryDatabase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-extraction-"));
  const databasePath = path.join(root, "memory.db");
  const database = openMemoryDatabase(databasePath);
  return { root, database, repository: new MemoryRepository(database) };
}

test("long-term extraction schema has no host continuity summary", () => {
  assert.deepEqual(LONG_TERM_EXTRACTION_SCHEMA.required, ["memories"]);
  assert.equal(Object.hasOwn(LONG_TERM_EXTRACTION_SCHEMA.properties, "summary"), false);
  assert.deepEqual(parseGeneratedLongTermExtraction({ memories: [] }), { memories: [] });
  assert.throws(
    () => parseGeneratedLongTermExtraction({ summary: "host-owned", memories: [] }),
    /只能包含 memories/u,
  );
});

test("long-term extraction input only contains submitted standard events", () => {
  const built = buildLongTermExtractionInput({
    memoryOwner: "Companion",
    userName: "User",
    messages: [{
      id: "event-1",
      timestamp: "2026-08-04T00:00:00.000Z",
      role: "user",
      text: "今天去了科技馆。",
      worldFrame: "physical",
      worldId: "primary",
    }],
  });
  assert.equal(built.messages.length, 1);
  assert.equal(built.messages[0].memoryRef, "M0001");
  assert.match(built.input, /【待提取的标准事件】/u);
  assert.doesNotMatch(built.input, /既有记忆摘要|切点|短期上下文/u);
});

test("labels boundary context as read-only and assigns evidence refs only to archive messages", () => {
  const message = (id, role, text) => ({
    id,
    timestamp: "2026-08-04T00:00:00.000Z",
    role,
    text,
    worldFrame: "relational",
    worldId: "relationship",
  });
  const built = buildLongTermExtractionInput({
    memoryOwner: "Companion",
    userName: "User",
    previousContextMessages: [message("previous", "assistant", "之前的问题是什么？")],
    messages: [message("archive", "user", "我今天去了科技馆。")],
    continuationGuidanceMessages: [message("guidance", "user", "这件事还没有讲完。")],
  });
  assert.deepEqual(built.messages.map((item) => item.memoryRef), ["M0001"]);
  assert.equal(built.previousContextMessages[0].memoryRef, undefined);
  assert.equal(built.continuationGuidanceMessages[0].memoryRef, undefined);
  assert.match(built.input, /【只读的前文衔接】[\s\S]*之前的问题是什么/u);
  assert.match(built.input, /【待提取的标准事件】[\s\S]*\[M0001\][\s\S]*我今天去了科技馆/u);
  assert.match(built.input, /【只读的后文衔接】[\s\S]*这件事还没有讲完/u);
  assert.equal((built.input.match(/\[M\d{4}\]/gu) || []).length, 1);
});

test("packs semantic archive windows into one prompt without sharing evidence namespaces", () => {
  const message = (id, text) => ({
    id,
    timestamp: "2026-08-04T00:00:00.000Z",
    role: "user",
    text,
  });
  const built = buildLongTermExtractionInput({
    archiveWindows: [
      { id: "window-a", messages: [message("a", "第一段独立经历。")] },
      { id: "window-b", messages: [message("b", "第二段独立经历。")] },
    ],
  });
  assert.deepEqual(built.messages.map((item) => item.memoryRef), ["M0001", "M0002"]);
  assert.deepEqual(built.messages.map((item) => item.archiveWindowId), ["window-a", "window-b"]);
  assert.match(built.input, /【语义归档窗口 W0001】[\s\S]*\[M0001\][\s\S]*【语义归档窗口 W0002】[\s\S]*\[M0002\]/u);
});

test("keeps Chinese, English, and mixed archive windows in their own output languages", () => {
  const message = (id, role, text) => ({
    id,
    timestamp: "2026-08-04T00:00:00.000Z",
    role,
    text,
  });
  assert.equal(detectExtractionLanguage("今天去科技馆看AI展。"), "zh");
  assert.equal(detectExtractionLanguage("I went to the science museum today."), "en");
  assert.equal(detectExtractionLanguage("今天我和你一起看 a science museum video。"), "mixed");

  const built = buildLongTermExtractionInput({
    archiveWindows: [
      { id: "zh", messages: [message("zh-1", "user", "我今天去了科技馆。")] },
      { id: "en", messages: [message("en-1", "assistant", "I painted a sunrise last year.")] },
      {
        id: "mixed",
        messages: [
          message("mixed-1", "user", "我今天去了科技馆。"),
          message("mixed-2", "assistant", "I loved the science exhibit."),
        ],
      },
    ],
  });
  assert.deepEqual(built.archiveWindows.map((window) => window.sourceLanguage), ["zh", "en", "mixed"]);
  assert.match(built.input, /输出语言】[\s\S]*必须用中文撰写/u);
  assert.match(built.input, /Output language: English[\s\S]*must be written in English/u);
  assert.match(built.input, /Output language: source-led mixed/u);
  assert.match(built.input, /Agent：I painted a sunrise last year/u);
  assert.match(built.input, /\[source-language=zh\] user：我今天去了科技馆/u);
  assert.match(built.input, /\[source-language=en\] agent：I loved the science exhibit/u);
});

test("persists each raw message's detected source language for later audit", () => {
  const { root, database, repository } = temporaryDatabase();
  try {
    const built = buildLongTermExtractionInput({
      archiveWindows: [{
        id: "english-window",
        messages: [{
          id: "english-message",
          timestamp: "2026-08-04T00:00:00.000Z",
          role: "assistant",
          text: "I painted a sunrise last year.",
        }],
      }],
    });
    const archive = archiveLongTermEvidence({
      repository,
      agentId: "agent-test",
      messages: built.messages,
      generatedMemories: [],
      batchId: "batch-language-test",
      recordedAt: "2026-08-04T00:01:00.000Z",
    });
    const utterance = repository.getMemory(archive.utteranceMemoryIds[0]);
    assert.equal(utterance.metadata.sourceLanguage, "en");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps episodic events separate from unsupported stable-state inference", () => {
  assert.equal(RETENTION_REASONS.includes("episodic_event"), true);
  assert.equal(isRetentionReasonCompatible("event", "episodic_event"), true);
  assert.equal(isRetentionReasonCompatible("preference", "episodic_event"), false);
  assert.equal(isRetentionReasonCompatible("belief_state", "episodic_event"), false);

  const prompt = loadLongTermExtractionSystemPrompt();
  assert.match(prompt, /具体经历仍应单独记录为 `event`/u);
  assert.match(prompt, /不能因为高层状态证据不足，就丢掉已经发生的底层事件/u);
  assert.match(prompt, /一次性饮食和瞬时情绪只禁止被误写成稳定状态/u);
  assert.match(prompt, /分别生成事件候选与状态候选/u);
});
