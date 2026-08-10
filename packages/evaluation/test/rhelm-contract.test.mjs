import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertRhelmPlanHasNoGoldLabels,
  chunkRhelmExternalText,
  createRhelmPersonaPlan,
  loadRhelmDataset,
  parseRhelmEvidenceReference,
} from "../src/index.mjs";

function writeSyntheticRhelm(root) {
  const persona = "Alice_Test";
  for (const directory of ["QA_final", "conversations", "emails", "attachments"]) {
    fs.mkdirSync(path.join(root, directory, directory === "QA_final" ? "" : persona), {
      recursive: true,
    });
  }
  const qa = [
    {
      id: "fact-past",
      question: "What happened at the robotics exhibit?",
      answer: "A humanoid robot waved.",
      question_date: "2026-01-02",
      question_type: "fact",
      supporting_evidence: ["2026-01-01:1"],
      characteristics: ["Fact Retrieval"],
    },
    {
      id: "future-inconsistent",
      question: "What was written in the later note?",
      answer: "A future detail.",
      question_date: "2026-01-02",
      question_type: "attachment",
      supporting_evidence: ["02_notes_task_future.md:Detail"],
      characteristics: null,
    },
  ];
  fs.writeFileSync(
    path.join(root, "QA_final", `low_score_qa_${persona}_all_validated.jsonl`),
    `${qa.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  fs.writeFileSync(path.join(root, "conversations", persona, "conversation_2026_01_01.json"), JSON.stringify({
    character: persona,
    date: "2026-01-01",
    profile_file: "profile.json",
    event_file: "event.json",
    conversation: [{
      turn: 1,
      timestamp: "2026-01-01T09:00:00",
      message_type: "status_update",
      user: "At the robotics exhibit, a humanoid robot waved.",
      assistant: "That sounds memorable.",
    }],
  }));
  fs.writeFileSync(
    path.join(root, "emails", persona, "01_email_2026_01_01.txt"),
    "Subject: Museum schedule\nThe museum opens at nine.",
  );
  fs.writeFileSync(
    path.join(root, "emails", persona, "02_email_2026_01_03.txt"),
    "Subject: Future robotics note\nA future robotics exhibit detail.",
  );
  fs.writeFileSync(
    path.join(root, "attachments", persona, "01_notes_task_past.md"),
    "# Museum note\nDate: 2026-01-01\nA calm visit.",
  );
  fs.writeFileSync(
    path.join(root, "attachments", persona, "02_notes_task_future.md"),
    "# Future note\nDate: 2026-01-03\nA future detail.",
  );
  return persona;
}

test("parses conversation, compact-turn, email, and attachment evidence references", () => {
  assert.deepEqual(parseRhelmEvidenceReference("2024-06-26:13,17,18"), [
    "conversation:2024-06-26:13",
    "conversation:2024-06-26:17",
    "conversation:2024-06-26:18",
  ]);
  assert.deepEqual(parseRhelmEvidenceReference("Emails_2024-04-14:Header: Example"), [
    "email:2024-04-14",
  ]);
  assert.deepEqual(parseRhelmEvidenceReference("07_report_task_d8d80e26.md:Section"), [
    "attachment:07_report_task_d8d80e26.md",
  ]);
});

test("uses deterministic fixed whitespace-token chunks with overlap", () => {
  const chunks = chunkRhelmExternalText("one two three four five six", { size: 4, overlap: 2 });
  assert.deepEqual(chunks.map((chunk) => chunk.content), [
    "one two three four",
    "three four five six",
  ]);
});

test("loads a persona timeline, marks inconsistent future evidence, and keeps labels out of memories", (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "suzu-rhelm-contract-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const persona = writeSyntheticRhelm(root);
  const dataset = loadRhelmDataset(root);
  assert.equal(dataset.personas.length, 1);
  assert.equal(dataset.personas[0].persona, persona);
  assert.equal(dataset.personas[0].questions[0].temporallyValid, true);
  assert.equal(dataset.personas[0].questions[1].temporallyValid, false);
  assert.deepEqual(dataset.personas[0].questions[1].futureEvidenceSourceIds, [
    "attachment:02_notes_task_future.md",
  ]);
  const plan = createRhelmPersonaPlan(dataset.personas[0], "dataset-hash");
  assert.equal(assertRhelmPlanHasNoGoldLabels(plan), true);
  const serialized = JSON.stringify(plan.memories);
  assert.doesNotMatch(serialized, /supporting_evidence|question_type|characteristics/iu);
});
