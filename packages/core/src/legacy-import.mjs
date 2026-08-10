import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

function readJsonLines(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const rows = [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} is not valid JSON: ${error.message}`);
    }
  }
  return rows;
}

function fileFingerprint(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return "";
  const stat = fs.statSync(filePath);
  const hash = createHash("sha256");
  hash.update(path.resolve(filePath).toLowerCase());
  hash.update(String(stat.size));
  hash.update(String(stat.mtimeMs));
  return hash.digest("hex");
}

function stableMemoryId(agentId, kind, externalId) {
  return `mem-${createHash("sha256")
    .update(`${agentId}\u001f${kind}\u001f${externalId}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function timestamp(value, fallback = null) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function finishImportRun(database, runId, values) {
  database.prepare(`
    UPDATE import_runs
    SET status = ?, records_seen = ?, records_added = ?,
        completed_at = ?, error = ?, metadata_json = ?
    WHERE id = ?
  `).run(
    values.status,
    values.recordsSeen,
    values.recordsAdded,
    new Date().toISOString(),
    values.error || "",
    JSON.stringify(values.metadata || {}),
    runId,
  );
}

export function importLegacyMemory({
  repository,
  agentId,
  historyPath,
  eventsPath,
}) {
  if (!repository) throw new Error("importLegacyMemory requires repository.");
  if (!String(agentId || "").trim()) throw new Error("importLegacyMemory requires agentId.");

  const database = repository.database;
  const runId = `import-${randomUUID()}`;
  const startedAt = new Date().toISOString();
  const sourcePath = path.dirname(path.resolve(historyPath || eventsPath));
  const fingerprint = createHash("sha256")
    .update(fileFingerprint(historyPath))
    .update(fileFingerprint(eventsPath))
    .digest("hex");
  database.prepare(`
    INSERT INTO import_runs (
      id, agent_id, importer, source_path, source_fingerprint,
      status, started_at, metadata_json
    ) VALUES (?, ?, 'legacy-jsonl-v1', ?, ?, 'running', ?, '{}')
  `).run(runId, agentId, sourcePath, fingerprint, startedAt);

  try {
    const history = readJsonLines(historyPath);
    const events = readJsonLines(eventsPath);
    let added = 0;
    const sourceByExternalId = new Map();
    const memoryByHistoryId = new Map();
    let previousHistoryMemoryId = "";

    repository.transaction(() => {
      for (const row of history) {
        const externalId = String(row.id || row.source_uuid || "").trim();
        const text = String(row.text || "").trim();
        if (!externalId || !text) continue;
        const before = repository.getSourceByExternalId(
          agentId,
          "legacy-history",
          externalId,
        );
        const source = repository.upsertSource({
          agentId,
          sourceKind: "legacy-history",
          sourceLocator: path.resolve(historyPath),
          externalId,
          occurredAt: timestamp(row.timestamp),
          knownAt: timestamp(row.timestamp),
          recordedAt: timestamp(row.compaction_batch_timestamp, timestamp(row.timestamp, startedAt)),
          speaker: row.speaker || row.role || "",
          content: text,
          metadata: {
            role: row.role || "",
            sourceKind: row.source_kind || "",
            sourceUuid: row.source_uuid || "",
            compactionBatchUuid: row.compaction_batch_uuid || "",
            sourceIndex: row.source_index ?? null,
          },
        });
        sourceByExternalId.set(externalId, source.id);

        const memoryId = stableMemoryId(agentId, "utterance", externalId);
        repository.upsertMemory({
          id: memoryId,
          agentId,
          kind: "utterance",
          layer: "evidence",
          content: text,
          subjectRole: row.role === "assistant" ? "agent" : "user",
          subjectKey: row.role === "assistant" ? agentId : "user",
          reality: "real",
          evidenceMode: "imported",
          temporalState: "historical",
          eventStart: timestamp(row.timestamp),
          knownAt: timestamp(row.timestamp),
          recordedAt: timestamp(row.compaction_batch_timestamp, timestamp(row.timestamp, startedAt)),
          perspective: row.role || "",
          importance: 0.25,
          actorRoles: [{
            role: "speaker",
            actorRole: row.role === "assistant" ? "agent" : "user",
            actorKey: row.role === "assistant" ? agentId : "user",
            isPrimary: true,
            confidence: 1,
            provenance: "legacy-jsonl-v1",
          }],
          metadata: {
            legacyId: externalId,
            speaker: row.speaker || "",
            sourceKind: row.source_kind || "",
          },
        });
        repository.linkSource(memoryId, source.id, "verbatim", {
          authority: "verbatim_record",
          sourceTrust: 1,
          evidenceStrength: 1,
          provenance: "legacy-jsonl-v1",
        });
        if (previousHistoryMemoryId && previousHistoryMemoryId !== memoryId) {
          repository.upsertEdge({
            agentId,
            fromMemoryId: previousHistoryMemoryId,
            toMemoryId: memoryId,
            relation: "followed_by",
            direction: "directed",
            weight: 0.7,
            confidence: 1,
            provenance: "legacy-jsonl-v1",
          });
        }
        previousHistoryMemoryId = memoryId;
        memoryByHistoryId.set(externalId, memoryId);
        if (!before) added += 1;
      }

      for (const row of events) {
        const externalId = String(row.id || "").trim();
        const content = String(row.text || "").trim();
        if (!externalId || !content) continue;
        const memoryId = stableMemoryId(agentId, "event", externalId);
        const existed = repository.getMemory(memoryId);
        repository.upsertMemory({
          id: memoryId,
          agentId,
          kind: row.memory_type || "event",
          layer: "episodic",
          title: row.title || "",
          content,
          // Legacy event cards did not have a reliable subject field. Keep the
          // subject unknown until the new classifier can prove ownership from
          // the linked source messages.
          subjectRole: "unknown",
          subjectKey: "",
          reality: "real",
          evidenceMode: "imported",
          temporalState: "historical",
          eventDate: /^\d{4}-\d{2}-\d{2}$/u.test(String(row.event_date || ""))
            ? row.event_date
            : null,
          eventStart: timestamp(row.source_start_timestamp),
          eventEnd: timestamp(row.source_end_timestamp),
          knownAt: timestamp(row.source_end_timestamp, timestamp(row.source_start_timestamp, startedAt)),
          recordedAt: timestamp(
            row.compaction_batch_timestamp,
            timestamp(row.source_end_timestamp, startedAt),
          ),
          status: row.status === "deleted" ? "deleted" : "active",
          confidence: 0.9,
          importance: 0.65,
          metadata: {
            legacyId: externalId,
            eventDate: row.event_date || "",
            generatorVersion: row.generator_version || "",
            compactionBatchUuid: row.compaction_batch_uuid || "",
          },
        });
        if (!existed) added += 1;

        for (const sourceExternalId of row.source_ids || []) {
          const sourceId = sourceByExternalId.get(String(sourceExternalId));
          const evidenceMemoryId = memoryByHistoryId.get(String(sourceExternalId));
          if (sourceId) repository.linkSource(memoryId, sourceId, "evidence", {
            authority: "legacy_unknown",
            sourceTrust: 0.5,
            evidenceStrength: 1,
            provenance: "legacy-jsonl-v1",
          });
          if (evidenceMemoryId) {
            repository.upsertEdge({
              agentId,
              fromMemoryId: memoryId,
              toMemoryId: evidenceMemoryId,
              relation: "supported_by",
              direction: "directed",
              weight: 1,
              confidence: 1,
              provenance: "legacy-jsonl-v1",
            });
          }
        }
      }
    });

    const result = {
      status: "completed",
      runId,
      historySeen: history.length,
      eventsSeen: events.length,
      recordsAdded: added,
      sourceFingerprint: fingerprint,
    };
    finishImportRun(database, runId, {
      status: "completed",
      recordsSeen: history.length + events.length,
      recordsAdded: added,
      metadata: result,
    });
    return result;
  } catch (error) {
    finishImportRun(database, runId, {
      status: "failed",
      recordsSeen: 0,
      recordsAdded: 0,
      error: error.message,
    });
    throw error;
  }
}
