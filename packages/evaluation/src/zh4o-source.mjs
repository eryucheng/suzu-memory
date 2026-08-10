import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * The official ZH-4O release is stored as a JSONL transcript plus one QA
 * label file per evaluated conversation. The author's own harness indexes
 * source records 1..28 (zero based), so record 0 is intentionally excluded
 * from the 28 labelled QA conversations.
 */
export const ZH4O_OFFICIAL_SOURCE_REPOSITORY = "https://github.com/cows21/MOOM-Roleplay-Dialogue";
export const ZH4O_OFFICIAL_SOURCE_LAYOUT = Object.freeze({
  dialoguePath: "data/ZH-4O_dataset.jsonl",
  labelDirectory: "label_qa",
  labelFilePattern: /^ZH4O_qa(\d+)\.json$/u,
  sourceRecordStartIndex: 1,
});
export const ZH4O_OFFICIAL_SOURCE_FORMAT_VERSION = "moom-roleplay-dialogue-v1";

function clean(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object.");
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(String(text).replace(/^\uFEFF/u, ""));
  } catch (error) {
    throw new Error(label + " is not valid JSON: " + error.message);
  }
}

function readJsonl(filePath) {
  const raw = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/u, "");
  const rows = [];
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    rows.push(parseJson(line, filePath + " line " + (index + 1)));
  }
  if (!rows.length) throw new Error(filePath + " has no JSONL rows.");
  return { raw, rows };
}

function sourceCommit(sourceRoot) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
  } catch {
    return "";
  }
}

function listLabelFiles(sourceRoot) {
  const labelDirectory = path.join(sourceRoot, ZH4O_OFFICIAL_SOURCE_LAYOUT.labelDirectory);
  if (!fs.existsSync(labelDirectory)) {
    throw new Error("ZH-4O official label directory does not exist: " + labelDirectory);
  }
  const files = fs.readdirSync(labelDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = ZH4O_OFFICIAL_SOURCE_LAYOUT.labelFilePattern.exec(entry.name);
      return match ? {
        fileName: entry.name,
        relativePath: path.posix.join(ZH4O_OFFICIAL_SOURCE_LAYOUT.labelDirectory, entry.name),
        ordinal: Number(match[1]),
        filePath: path.join(labelDirectory, entry.name),
      } : null;
    })
    .filter(Boolean)
    .sort((left, right) => left.ordinal - right.ordinal);
  if (!files.length) throw new Error("No ZH4O_qa*.json files found in " + labelDirectory + ".");
  for (const [index, file] of files.entries()) {
    if (file.ordinal !== index + 1) {
      throw new Error(
        "ZH-4O label files must be continuous from 1; found "
        + file.fileName + " at position " + (index + 1) + ".",
      );
    }
  }
  return files;
}

function normalizeSourceMessage(message, label, participants, ordinal) {
  assertObject(message, label);
  const speaker = clean(message.sender_name);
  const text = clean(message.text);
  if (!speaker) throw new Error(label + ".sender_name must not be empty.");
  if (!participants.has(speaker)) {
    throw new Error(label + ".sender_name is not one of the two source participants.");
  }
  if (!text) throw new Error(label + ".text must not be empty.");
  return {
    speaker,
    dia_id: "D1:" + (ordinal + 1),
    text,
  };
}

function buildConversation(sourceRecord, sourceRecordIndex, labelFile) {
  const sourceLabel = "ZH-4O source record " + sourceRecordIndex;
  assertObject(sourceRecord, sourceLabel);
  assertObject(sourceRecord.role_meta, sourceLabel + ".role_meta");
  const speakerA = clean(sourceRecord.role_meta.user_name);
  const speakerB = clean(sourceRecord.role_meta.primary_bot_name);
  if (!speakerA || !speakerB || speakerA === speakerB) {
    throw new Error(sourceLabel + " must contain two distinct role_meta participants.");
  }
  if (!Array.isArray(sourceRecord.messages) || !sourceRecord.messages.length) {
    throw new Error(sourceLabel + ".messages must be a non-empty array.");
  }
  const participants = new Set([speakerA, speakerB]);
  return {
    sample_id: "zh4o-" + labelFile.ordinal,
    conversation: {
      speaker_a: speakerA,
      speaker_b: speakerB,
      session_1: sourceRecord.messages.map((message, messageIndex) => normalizeSourceMessage(
        message,
        sourceLabel + ".messages[" + messageIndex + "]",
        participants,
        messageIndex,
      )),
    },
  };
}

function buildQuestions(labelFile, sourceRecord, sourceRecordIndex) {
  const raw = fs.readFileSync(labelFile.filePath, "utf8");
  const labels = parseJson(raw, labelFile.relativePath);
  assertObject(labels, labelFile.relativePath);
  const entries = Object.entries(labels)
    .map(([sourceTurnIndexText, value]) => ({
      sourceTurnIndexText,
      sourceTurnIndex: Number(sourceTurnIndexText),
      value,
    }))
    .sort((left, right) => left.sourceTurnIndex - right.sourceTurnIndex);
  if (!entries.length) throw new Error(labelFile.relativePath + " has no QA labels.");
  return {
    raw,
    questions: entries.map((entry, ordinal) => {
      if (!Number.isInteger(entry.sourceTurnIndex) || entry.sourceTurnIndex < 0) {
        throw new Error(labelFile.relativePath + " has invalid turn index " + entry.sourceTurnIndexText + ".");
      }
      if (entry.sourceTurnIndex >= sourceRecord.messages.length) {
        throw new Error(
          labelFile.relativePath + " points to source turn " + entry.sourceTurnIndex
          + ", but source record " + sourceRecordIndex + " has only "
          + sourceRecord.messages.length + " turns.",
        );
      }
      if (!Array.isArray(entry.value) || entry.value.length < 2) {
        throw new Error(labelFile.relativePath + "[" + entry.sourceTurnIndexText + "] must be [question, answer].");
      }
      const question = clean(entry.value[0]);
      const answer = clean(entry.value[1]);
      if (!question || !answer) {
        throw new Error(labelFile.relativePath + "[" + entry.sourceTurnIndexText + "] has an empty question or answer.");
      }
      return {
        question,
        answer,
        evidence: ["D1:" + (entry.sourceTurnIndex + 1)],
        source: {
          label_file: labelFile.relativePath,
          source_record_index: sourceRecordIndex,
          source_turn_index: entry.sourceTurnIndex,
          question_ordinal: ordinal,
        },
      };
    }),
  };
}

/**
 * Builds the local ZH-4O adapter input from an unmodified clone of the
 * official MOOM repository. QA labels and their source-turn evidence stay in
 * the derived dataset for post-hoc evaluation only; callers must never place
 * them in memory-input or answer-generation prompts.
 */
export function buildZh4oDatasetFromMoomSource({ sourceRoot } = {}) {
  const resolvedSourceRoot = path.resolve(clean(sourceRoot));
  if (!resolvedSourceRoot || !fs.existsSync(resolvedSourceRoot)) {
    throw new Error("ZH-4O official source root does not exist: " + (resolvedSourceRoot || "(empty)"));
  }
  const dialoguePath = path.join(resolvedSourceRoot, ZH4O_OFFICIAL_SOURCE_LAYOUT.dialoguePath);
  if (!fs.existsSync(dialoguePath)) {
    throw new Error("ZH-4O official dialogue file does not exist: " + dialoguePath);
  }
  const { raw: rawDialogue, rows: sourceRows } = readJsonl(dialoguePath);
  const labelFiles = listLabelFiles(resolvedSourceRoot);
  const sourceRecordStartIndex = ZH4O_OFFICIAL_SOURCE_LAYOUT.sourceRecordStartIndex;
  if (sourceRows.length !== labelFiles.length + sourceRecordStartIndex) {
    throw new Error(
      "ZH-4O official source has " + sourceRows.length + " records, but "
      + labelFiles.length + " labels require exactly "
      + (labelFiles.length + sourceRecordStartIndex)
      + " records with the documented start offset " + sourceRecordStartIndex + ".",
    );
  }

  const labelHashes = [];
  const dataset = labelFiles.map((labelFile) => {
    const sourceRecordIndex = sourceRecordStartIndex + labelFile.ordinal - 1;
    const sourceRecord = sourceRows[sourceRecordIndex];
    const entry = buildConversation(sourceRecord, sourceRecordIndex, labelFile);
    const { raw: rawLabel, questions } = buildQuestions(labelFile, sourceRecord, sourceRecordIndex);
    labelHashes.push({
      path: labelFile.relativePath,
      sha256: sha256(rawLabel),
      questions: questions.length,
    });
    entry.qa = questions;
    return entry;
  });

  const totalQuestions = dataset.reduce((sum, entry) => sum + entry.qa.length, 0);
  return {
    dataset,
    manifest: {
      formatVersion: ZH4O_OFFICIAL_SOURCE_FORMAT_VERSION,
      officialRepository: ZH4O_OFFICIAL_SOURCE_REPOSITORY,
      officialCommit: sourceCommit(resolvedSourceRoot),
      dialogue: {
        path: ZH4O_OFFICIAL_SOURCE_LAYOUT.dialoguePath,
        sha256: sha256(rawDialogue),
        records: sourceRows.length,
        labelledRecordStartIndex: sourceRecordStartIndex,
        labelledRecords: dataset.length,
      },
      labels: {
        directory: ZH4O_OFFICIAL_SOURCE_LAYOUT.labelDirectory,
        files: labelHashes,
        questions: totalQuestions,
      },
      output: {
        samples: dataset.length,
        questions: totalQuestions,
        evidencePolicy: "official label turn indexes are retained only for post-hoc retrieval audit",
      },
    },
  };
}

export function writeZh4oDatasetFromMoomSource({
  sourceRoot,
  outputPath,
  manifestPath = "",
} = {}) {
  const resolvedOutputPath = path.resolve(clean(outputPath));
  if (!resolvedOutputPath) throw new Error("ZH-4O outputPath must not be empty.");
  const built = buildZh4oDatasetFromMoomSource({ sourceRoot });
  const resolvedManifestPath = clean(manifestPath)
    ? path.resolve(manifestPath)
    : resolvedOutputPath.replace(/\.json$/iu, ".source-manifest.json");
  fs.mkdirSync(path.dirname(resolvedOutputPath), { recursive: true });
  fs.mkdirSync(path.dirname(resolvedManifestPath), { recursive: true });
  fs.writeFileSync(resolvedOutputPath, JSON.stringify(built.dataset, null, 2) + "\n", "utf8");
  fs.writeFileSync(resolvedManifestPath, JSON.stringify(built.manifest, null, 2) + "\n", "utf8");
  return {
    ...built,
    outputPath: resolvedOutputPath,
    manifestPath: resolvedManifestPath,
  };
}
