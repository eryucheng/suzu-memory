import { createHash } from "node:crypto";
import fs from "node:fs";

function clean(value) {
  return String(value ?? "").trim();
}

function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function readJsonLines(filePath) {
  const rows = [];
  for (const [index, raw] of fs.readFileSync(filePath, "utf8").split(/\r?\n/u).entries()) {
    const line = raw.trim().replace(/^\uFEFF/u, "");
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} 不是有效 JSON：${error.message}`);
    }
  }
  return rows;
}

function stableMemoryId(agentId, kind, externalId) {
  return `mem-${sha256(`${agentId}\u001f${kind}\u001f${externalId}`).slice(0, 24)}`;
}

function buildTurns(messages, maxTurnGapHours) {
  const turns = [];
  let current = [];
  let hasUser = false;
  let hasAssistant = false;
  let lastTimestamp = Number.NaN;
  const maxGapMs = Math.max(0, Number(maxTurnGapHours || 0)) * 60 * 60 * 1000;
  const flush = () => {
    if (current.length) turns.push(current);
    current = [];
    hasUser = false;
    hasAssistant = false;
    lastTimestamp = Number.NaN;
  };
  for (const message of messages) {
    const timestamp = Date.parse(message.timestamp || "");
    if (
      current.length
      && maxGapMs > 0
      && Number.isFinite(timestamp)
      && Number.isFinite(lastTimestamp)
      && (timestamp < lastTimestamp || timestamp - lastTimestamp > maxGapMs)
    ) flush();
    if (message.role === "user" && hasUser && hasAssistant) flush();
    current.push(message);
    if (message.role === "user") hasUser = true;
    if (message.role === "assistant") hasAssistant = true;
    if (Number.isFinite(timestamp)) lastTimestamp = timestamp;
  }
  flush();
  return turns;
}

function legacyTurnId(messages) {
  return sha256(messages.map((message) => (
    message.id || `${message.timestamp || ""}:${message.role}:${message.text}`
  )).join("\n"));
}

function decodeFloat32(value, dimensions) {
  const buffer = Buffer.from(value, "base64");
  if (buffer.byteLength !== dimensions * 4) {
    throw new Error(`向量字节数 ${buffer.byteLength} 与维度 ${dimensions} 不一致。`);
  }
  const result = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) {
    result[index] = buffer.readFloatLE(index * 4);
  }
  return result;
}

function averageNormalized(vectors) {
  if (!vectors.length) return new Float32Array();
  const result = new Float32Array(vectors[0].length);
  for (const vector of vectors) {
    if (vector.length !== result.length) throw new Error("同一记忆单元的向量维度不一致。");
    for (let index = 0; index < vector.length; index += 1) result[index] += vector[index];
  }
  let norm = 0;
  for (const value of result) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < result.length; index += 1) result[index] /= norm;
  }
  return result;
}

export function importLegacyEmbeddings({
  repository,
  agentId,
  historyPath,
  eventsPath = "",
  embeddingsPath,
  maxTurnGapHours = 2,
}) {
  if (!repository) throw new Error("importLegacyEmbeddings requires repository.");
  if (!clean(agentId)) throw new Error("importLegacyEmbeddings requires agentId.");
  const indexRows = readJsonLines(embeddingsPath);
  const meta = indexRows.find((row) => row.type === "meta");
  if (!meta?.model || !Number(meta.dimensions)) {
    throw new Error("旧向量索引缺少 model 或 dimensions 元信息。");
  }
  const dimensions = Number(meta.dimensions);
  const vectorsByTurn = new Map();
  const hashesByTurn = new Map();
  for (const row of indexRows) {
    if (row.type !== "chunk" || !row.turnId || !row.vector) continue;
    const values = vectorsByTurn.get(row.turnId) || [];
    values.push(decodeFloat32(row.vector, dimensions));
    vectorsByTurn.set(row.turnId, values);
    const hashes = hashesByTurn.get(row.turnId) || [];
    hashes.push(clean(row.textHash));
    hashesByTurn.set(row.turnId, hashes);
  }

  const history = readJsonLines(historyPath).filter((row) => row.id && row.text);
  const events = eventsPath && fs.existsSync(eventsPath)
    ? readJsonLines(eventsPath).filter((row) => row.id && row.text)
    : [];
  const assignments = [];
  for (const turn of buildTurns(history, maxTurnGapHours)) {
    const turnId = legacyTurnId(turn);
    for (const message of turn) {
      assignments.push({
        turnId,
        memoryId: stableMemoryId(agentId, "utterance", message.id),
      });
    }
  }
  for (const event of events) {
    assignments.push({
      turnId: legacyTurnId([{ id: event.id }]),
      memoryId: stableMemoryId(agentId, "event", event.id),
    });
  }

  let imported = 0;
  let missingMemory = 0;
  let missingVector = 0;
  repository.transaction(() => {
    for (const assignment of assignments) {
      const chunks = vectorsByTurn.get(assignment.turnId);
      if (!chunks?.length) {
        missingVector += 1;
        continue;
      }
      if (!repository.getMemory(assignment.memoryId)) {
        missingMemory += 1;
        continue;
      }
      repository.upsertEmbedding({
        memoryId: assignment.memoryId,
        model: meta.model,
        vector: averageNormalized(chunks),
        contentHash: sha256((hashesByTurn.get(assignment.turnId) || []).join("\n")),
      });
      imported += 1;
    }
  });
  return {
    status: "completed",
    model: meta.model,
    dimensions,
    indexedChunks: [...vectorsByTurn.values()].reduce((sum, rows) => sum + rows.length, 0),
    indexedTurns: vectorsByTurn.size,
    assignments: assignments.length,
    imported,
    missingMemory,
    missingVector,
  };
}
