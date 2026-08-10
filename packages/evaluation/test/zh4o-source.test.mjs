import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildZh4oDatasetFromMoomSource,
  loadZh4oDataset,
  writeZh4oDatasetFromMoomSource,
} from "../src/index.mjs";

function sourceRecord({ user, agent, messages }) {
  return {
    messages: messages.map(([sender_name, text]) => ({ sender_name, text, flag: sender_name === user ? "U" : "G" })),
    role_meta: {
      user_name: user,
      primary_bot_name: agent,
    },
  };
}

function writeOfficialFixture(directory) {
  const sourceRoot = path.join(directory, "MOOM-Roleplay-Dialogue");
  fs.mkdirSync(path.join(sourceRoot, "data"), { recursive: true });
  fs.mkdirSync(path.join(sourceRoot, "label_qa"), { recursive: true });
  const ignoredRecord = sourceRecord({
    user: "未标注用户",
    agent: "未标注陪伴者",
    messages: [["未标注陪伴者", "这条官方首记录不参与 QA。"]],
  });
  const labelledRecord = sourceRecord({
    user: "赵齐",
    agent: "白羽岚",
    messages: [
      ["赵齐", "我最喜欢苹果味汽水。"],
      ["白羽岚", "我记住了，你喜欢苹果味汽水。"],
    ],
  });
  fs.writeFileSync(
    path.join(sourceRoot, "data", "ZH-4O_dataset.jsonl"),
    JSON.stringify(ignoredRecord) + "\n" + JSON.stringify(labelledRecord) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(sourceRoot, "label_qa", "ZH4O_qa1.json"),
    JSON.stringify({
      1: ["赵齐最喜欢什么味道的汽水？A 苹果 B 柠檬 C 葡萄 D 西瓜", "A"],
    }),
    "utf8",
  );
  return sourceRoot;
}

test("ZH-4O source builder follows the official offset and retains post-hoc evidence", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-zh4o-source-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sourceRoot = writeOfficialFixture(directory);
  const built = buildZh4oDatasetFromMoomSource({ sourceRoot });
  assert.equal(built.dataset.length, 1);
  assert.equal(built.manifest.dialogue.records, 2);
  assert.equal(built.manifest.dialogue.labelledRecordStartIndex, 1);
  assert.equal(built.manifest.labels.questions, 1);
  assert.equal(built.dataset[0].conversation.speaker_a, "赵齐");
  assert.equal(built.dataset[0].conversation.session_1[1].dia_id, "D1:2");
  assert.deepEqual(built.dataset[0].qa[0].evidence, ["D1:2"]);
  assert.equal(built.dataset[0].qa[0].source.source_turn_index, 1);

  const outputPath = path.join(directory, "derived.json");
  const result = writeZh4oDatasetFromMoomSource({ sourceRoot, outputPath });
  assert.equal(fs.existsSync(result.outputPath), true);
  assert.equal(fs.existsSync(result.manifestPath), true);
  const [normalized] = loadZh4oDataset(outputPath);
  assert.deepEqual(normalized.questions[0].evidenceDialogueIds, ["D1:2"]);
  assert.equal(normalized.questions[0].category, null);
});
