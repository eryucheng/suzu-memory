import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { openMemoryDatabase } from "@suzu-memory/core";

import {
  evaluateRhelmEvidenceRanking,
  runRhelmRetrievalBenchmark,
} from "../src/index.mjs";

function writeRetrievalFixture(root) {
  const persona = "Alice_Test";
  for (const directory of ["conversations", "emails", "attachments"]) {
    fs.mkdirSync(path.join(root, directory, persona), { recursive: true });
  }
  fs.mkdirSync(path.join(root, "QA_final"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "QA_final", `low_score_qa_${persona}_all_validated.jsonl`),
    `${JSON.stringify({
      id: "fact-past",
      question: "What happened at the science museum robotics exhibit?",
      answer: "A humanoid robot waved.",
      question_date: "2026-01-02",
      question_type: "fact",
      supporting_evidence: ["2026-01-01:1"],
      characteristics: ["Fact Retrieval"],
    })}\n`,
  );
  for (const [date, turn, user] of [
    ["2026-01-01", 1, "At the science museum robotics exhibit, a humanoid robot waved."],
    ["2026-01-03", 1, "Future science museum robotics exhibit details should not be visible."],
  ]) {
    fs.writeFileSync(
      path.join(root, "conversations", persona, `conversation_${date.replaceAll("-", "_")}.json`),
      JSON.stringify({
        character: persona,
        date,
        profile_file: "profile.json",
        event_file: "event.json",
        conversation: [{
          turn,
          timestamp: `${date}T09:00:00`,
          message_type: "status_update",
          user,
          assistant: "Acknowledged.",
        }],
      }),
    );
  }
  fs.writeFileSync(path.join(root, "emails", persona, "01_email_2026_01_01.txt"), "Lunch note only.");
  fs.writeFileSync(path.join(root, "attachments", persona, "01_notes_task_note.md"), "Date: 2026-01-01\nBicycle maintenance.");
}

test("scores evidence sources at chunk cutoffs without double-crediting duplicate chunks", () => {
  const metrics = evaluateRhelmEvidenceRanking({
    rankedSourceIds: ["source-a", "source-a", "other", "source-b"],
    evidenceSourceIds: ["source-a", "source-b"],
    ks: [2, 4],
  });
  assert.equal(metrics["recall_any@2"], 1);
  assert.equal(metrics["recall_all@2"], 0);
  assert.equal(metrics["source_recall@2"], 0.5);
  assert.equal(metrics["recall_all@4"], 1);
  assert.ok(metrics["ndcg_source@4"] < 1);
});

test("runs the real retriever on an incremental timeline and clears scratch memories", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-rhelm-retrieval-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  writeRetrievalFixture(root);
  const databasePath = path.join(root, "benchmark.db");
  const report = await runRhelmRetrievalBenchmark({
    datasetRoot: root,
    databasePath,
    ks: [1, 5],
  });
  assert.equal(report.protocol.task, "retrieval-only");
  assert.equal(report.protocol.officialQaEvaluated, false);
  assert.equal(report.protocol.goldLabelsStoredInMemory, false);
  assert.equal(report.scores.temporallyCompatible.cases, 1);
  assert.equal(report.scores.temporallyCompatible.metrics["recall_all@1"], 1);
  assert.equal(report.results[0].rankedSourceIds[0], "conversation:2026-01-01:1");
  assert.equal(report.results[0].rankedSourceIds.includes("conversation:2026-01-03:1"), false);

  const database = openMemoryDatabase(databasePath, { readOnly: true });
  try {
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_nodes").get().count, 0);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM memory_embeddings").get().count, 0);
  } finally {
    database.close();
  }
});
