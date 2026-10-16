import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { databaseInfo, MemoryRepository, openMemoryDatabase } from "@suzu-memory/core";

const BACKUP_FORMAT = "suzu-memory-sqlite-backup-v1";

function clean(value) {
  return String(value ?? "").trim();
}

function safeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Backup time must be a valid date.");
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sqlIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function closeDatabase(database) {
  try {
    database.close();
  } catch {
    // A redundant close failure must not hide the primary operation result.
  }
}

function atomicJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function databaseTables(database) {
  return database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all().map((row) => clean(row.name)).filter(Boolean);
}

function tableColumns(database, table) {
  return database.prepare(`PRAGMA table_info(${sqlIdentifier(table)})`).all()
    .map((row) => ({
      name: clean(row.name),
      type: clean(row.type).toUpperCase(),
    }))
    .filter((column) => column.name);
}

function tablesWithColumn(database, columnName) {
  const column = clean(columnName);
  if (!column) return [];
  return databaseTables(database).filter((table) => (
    tableColumns(database, table).some((candidate) => candidate.name === column)
  ));
}

function existingAgentIds(database) {
  const ids = new Set();
  for (const table of tablesWithColumn(database, "agent_id")) {
    for (const row of database.prepare(`
      SELECT DISTINCT ${sqlIdentifier("agent_id")} AS agent_id
      FROM ${sqlIdentifier(table)}
    `).all()) {
      if (clean(row.agent_id)) ids.add(clean(row.agent_id));
    }
  }
  return [...ids].sort();
}

function readManifest(databasePath) {
  const manifestPath = `${databasePath}.manifest.json`;
  if (!fs.existsSync(manifestPath)) return { manifestPath: "", manifest: null };
  try {
    return {
      manifestPath,
      manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8").replace(/^\uFEFF/u, "")),
    };
  } catch (error) {
    const invalid = new Error(`Backup manifest is invalid: ${error.message}`);
    invalid.code = "BACKUP_MANIFEST_INVALID";
    throw invalid;
  }
}

export function inspectDatabaseBackup(databasePath, { verifyManifest = true } = {}) {
  const resolved = path.resolve(clean(databasePath));
  if (!clean(databasePath) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    const error = new Error(`Backup database was not found: ${resolved}`);
    error.code = "BACKUP_NOT_FOUND";
    throw error;
  }
  const digest = sha256(resolved);
  // Importing a live database deliberately ignores any neighbouring backup
  // manifest. A raw runtime DB can legitimately sit beside a stale manifest.
  const { manifestPath, manifest } = verifyManifest
    ? readManifest(resolved)
    : { manifestPath: "", manifest: null };
  if (verifyManifest && manifest) {
    if (manifest.format !== BACKUP_FORMAT || clean(manifest.sha256) !== digest) {
      const error = new Error("Backup manifest does not match the database file.");
      error.code = "BACKUP_HASH_MISMATCH";
      throw error;
    }
  }
  const database = openMemoryDatabase(resolved, { readOnly: true });
  try {
    const integrityRows = database.prepare("PRAGMA quick_check").all();
    const integrity = integrityRows.map((row) => String(Object.values(row)[0] ?? ""));
    if (integrity.length !== 1 || integrity[0].toLowerCase() !== "ok") {
      const error = new Error(`Backup database failed SQLite integrity validation: ${integrity.join("; ")}`);
      error.code = "BACKUP_INTEGRITY_FAILED";
      throw error;
    }
    return {
      status: "valid",
      format: manifest?.format || "sqlite-database",
      databasePath: resolved,
      manifestPath,
      bytes: fs.statSync(resolved).size,
      sha256: digest,
      agentIds: existingAgentIds(database),
      agentId: clean(manifest?.agentId),
      database: databaseInfo(database),
      createdAt: clean(manifest?.createdAt),
    };
  } finally {
    closeDatabase(database);
  }
}

export function createDatabaseBackup({
  databasePath,
  destinationPath,
  agentId,
  overwrite = false,
  now = new Date(),
} = {}) {
  const source = path.resolve(clean(databasePath));
  const destination = path.resolve(clean(destinationPath));
  if (!clean(databasePath) || !fs.existsSync(source)) {
    const error = new Error(`Memory database was not found: ${source}`);
    error.code = "DATABASE_NOT_FOUND";
    throw error;
  }
  if (!clean(destinationPath) || source === destination) {
    throw new Error("Backup destination must be different from the active database.");
  }
  const manifestPath = `${destination}.manifest.json`;
  if (!overwrite && (fs.existsSync(destination) || fs.existsSync(manifestPath))) {
    const error = new Error(`Backup destination already exists: ${destination}`);
    error.code = "BACKUP_EXISTS";
    throw error;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.tmp-${randomUUID()}`;
  const database = openMemoryDatabase(source);
  try {
    const repository = new MemoryRepository(database);
    database.exec("PRAGMA wal_checkpoint(FULL)");
    database.exec(`VACUUM INTO ${sqlString(temporaryPath)}`);
    repository.sourceEpoch.assert();
  } finally {
    closeDatabase(database);
  }
  try {
    const inspected = inspectDatabaseBackup(temporaryPath, { verifyManifest: false });
    const createdAt = (now instanceof Date ? now : new Date(now)).toISOString();
    const manifest = {
      format: BACKUP_FORMAT,
      createdAt,
      agentId: clean(agentId),
      databaseFile: path.basename(destination),
      bytes: inspected.bytes,
      sha256: inspected.sha256,
      database: inspected.database,
    };
    if (overwrite) {
      fs.rmSync(destination, { force: true });
      fs.rmSync(manifestPath, { force: true });
    }
    fs.renameSync(temporaryPath, destination);
    atomicJson(manifestPath, manifest);
    return inspectDatabaseBackup(destination);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function moveIfPresent(from, to, moved) {
  if (!fs.existsSync(from)) return;
  fs.renameSync(from, to);
  moved.push({ from, to });
}

function snapshotDatabaseReadOnly(sourcePath, destinationPath) {
  const sourceDatabase = openMemoryDatabase(sourcePath, { readOnly: true });
  try {
    // VACUUM INTO reads the source's current WAL state while writing only the
    // staged destination. This is safer than copying a live .db file and it
    // never mutates the file the user selected.
    sourceDatabase.exec(`VACUUM INTO ${sqlString(destinationPath)}`);
  } finally {
    closeDatabase(sourceDatabase);
  }
}

function rewriteJsonAgentIdentity(value, sourceAgentId, targetAgentId) {
  if (typeof value === "string") {
    if (value === sourceAgentId) return targetAgentId;
    return value.replaceAll(`agent:${sourceAgentId}`, `agent:${targetAgentId}`);
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteJsonAgentIdentity(item, sourceAgentId, targetAgentId));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      rewriteJsonAgentIdentity(item, sourceAgentId, targetAgentId),
    ]));
  }
  return value;
}

function rewriteJsonColumns(database, table, columns, sourceAgentId, targetAgentId) {
  for (const column of columns.filter((candidate) => candidate.name.endsWith("_json"))) {
    const quotedTable = sqlIdentifier(table);
    const quotedColumn = sqlIdentifier(column.name);
    const rows = database.prepare(`
      SELECT rowid AS row_id, ${quotedColumn} AS value
      FROM ${quotedTable}
      WHERE instr(${quotedColumn}, ?) > 0
    `).all(sourceAgentId);
    const update = database.prepare(`
      UPDATE ${quotedTable} SET ${quotedColumn} = ? WHERE rowid = ?
    `);
    for (const row of rows) {
      try {
        const before = JSON.parse(String(row.value));
        const after = rewriteJsonAgentIdentity(before, sourceAgentId, targetAgentId);
        const serialized = JSON.stringify(after);
        if (serialized !== row.value) update.run(serialized, row.row_id);
      } catch (cause) {
        const error = new Error(`Imported database contains invalid JSON in ${table}.${column.name}.`);
        error.code = "IMPORT_JSON_INVALID";
        error.cause = cause;
        throw error;
      }
    }
  }
}

const AGENT_IDENTITY_COLUMNS = new Set([
  "actor_key",
  "subject_key",
  "proposed_subject_key",
  "relationship_key",
  "canonical_key",
  "target_scope_key",
  "proposed_scope_key",
  "source_locator",
  "space_id",
  "companion_id",
]);

function rewriteAgentIdentityColumns(database, table, columns, sourceAgentId, targetAgentId) {
  const quotedTable = sqlIdentifier(table);
  for (const column of columns) {
    if (!AGENT_IDENTITY_COLUMNS.has(column.name)) continue;
    const quotedColumn = sqlIdentifier(column.name);
    database.prepare(`
      UPDATE ${quotedTable}
      SET ${quotedColumn} = replace(${quotedColumn}, ?, ?)
      WHERE instr(${quotedColumn}, ?) > 0
    `).run(sourceAgentId, targetAgentId, sourceAgentId);
  }
}

function rebindAgentScope(database, { sourceAgentId, targetAgentId }) {
  const source = clean(sourceAgentId);
  const target = clean(targetAgentId);
  if (!source || !target || source === target) return;
  const tables = databaseTables(database).map((table) => ({
    table,
    columns: tableColumns(database, table),
  }));
  database.exec("BEGIN IMMEDIATE");
  try {
    // The database contains many composite foreign keys `(id, agent_id)`.
    // Deferring them lets every scoped table move in one atomic transaction.
    database.exec("PRAGMA defer_foreign_keys = ON");
    for (const { table, columns } of tables) {
      if (!columns.some((column) => column.name === "agent_id")) continue;
      const quotedTable = sqlIdentifier(table);
      const quotedAgentId = sqlIdentifier("agent_id");
      database.prepare(`
        UPDATE ${quotedTable}
        SET ${quotedAgentId} = ?
        WHERE ${quotedAgentId} = ?
      `).run(target, source);
    }
    for (const { table, columns } of tables) {
      rewriteAgentIdentityColumns(database, table, columns, source, target);
      rewriteJsonColumns(database, table, columns, source, target);
    }
    const violations = database.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) {
      const error = new Error("Imported database has invalid cross-table references.");
      error.code = "IMPORT_FOREIGN_KEY_FAILED";
      throw error;
    }
    database.exec("COMMIT");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch { /* no open transaction */ }
    throw error;
  }
}

function replaceActiveDatabase({ target, stagedPath, retiredLabel }) {
  const retiredSuffix = `.${retiredLabel}-${randomUUID()}`;
  const moved = [];
  try {
    moveIfPresent(target, `${target}${retiredSuffix}`, moved);
    moveIfPresent(`${target}-wal`, `${target}${retiredSuffix}-wal`, moved);
    moveIfPresent(`${target}-shm`, `${target}${retiredSuffix}-shm`, moved);
    fs.renameSync(stagedPath, target);
  } catch (error) {
    for (const item of [...moved].reverse()) {
      if (fs.existsSync(item.to) && !fs.existsSync(item.from)) fs.renameSync(item.to, item.from);
    }
    throw error;
  }
  for (const item of moved) fs.rmSync(item.to, { force: true });
}

export function restoreDatabaseBackup({
  databasePath,
  sourcePath,
  agentId,
  backupDirectory,
  now = new Date(),
} = {}) {
  const target = path.resolve(clean(databasePath));
  const source = path.resolve(clean(sourcePath));
  if (!clean(sourcePath) || source === target) {
    throw new Error("Restore source must be different from the active database.");
  }
  const sourceInspection = inspectDatabaseBackup(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stagedPath = path.join(path.dirname(target), `.restore-${randomUUID()}.db`);
  fs.copyFileSync(source, stagedPath);
  let stagedInspection;
  try {
    const stagedDatabase = openMemoryDatabase(stagedPath);
    try {
      stagedDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      stagedDatabase.exec("PRAGMA journal_mode = DELETE");
    } finally {
      closeDatabase(stagedDatabase);
    }
    stagedInspection = inspectDatabaseBackup(stagedPath, { verifyManifest: false });
    const recordedAgentIds = new Set([
      ...stagedInspection.agentIds,
      clean(sourceInspection.agentId),
    ].filter(Boolean));
    if ([...recordedAgentIds].some((id) => id !== clean(agentId))) {
      const error = new Error(
        `Backup belongs to another Agent scope: ${[...recordedAgentIds].join(", ")}`,
      );
      error.code = "BACKUP_AGENT_MISMATCH";
      throw error;
    }

    let safetyBackup = null;
    if (fs.existsSync(target)) {
      const directory = path.resolve(clean(backupDirectory) || path.join(path.dirname(target), "backups"));
      const backupPath = path.join(directory, `pre-restore-${safeTimestamp(now)}.db`);
      safetyBackup = createDatabaseBackup({
        databasePath: target,
        destinationPath: backupPath,
        agentId,
        now,
      });
    }

    replaceActiveDatabase({ target, stagedPath, retiredLabel: "pre-restore" });
    return {
      status: "restored",
      source: sourceInspection,
      restored: inspectDatabaseBackup(target, { verifyManifest: false }),
      safetyBackup,
    };
  } finally {
    fs.rmSync(stagedPath, { force: true });
    fs.rmSync(`${stagedPath}-wal`, { force: true });
    fs.rmSync(`${stagedPath}-shm`, { force: true });
  }
}

export function importDatabaseAsAgent({
  databasePath,
  sourcePath,
  agentId,
  backupDirectory,
  now = new Date(),
} = {}) {
  const target = path.resolve(clean(databasePath));
  const source = path.resolve(clean(sourcePath));
  const targetAgentId = clean(agentId);
  if (!targetAgentId) throw new Error("Import requires a target Agent id.");
  if (!clean(sourcePath) || source === target) {
    throw new Error("Import source must be different from the active database.");
  }
  const sourceInspection = inspectDatabaseBackup(source, { verifyManifest: false });
  if (sourceInspection.agentIds.length === 0) {
    const error = new Error("Imported database does not contain an Agent scope to rebind.");
    error.code = "IMPORT_AGENT_SCOPE_MISSING";
    throw error;
  }
  if (sourceInspection.agentIds.length > 1) {
    const error = new Error(
      `Imported database contains multiple Agent scopes: ${sourceInspection.agentIds.join(", ")}`,
    );
    error.code = "IMPORT_MULTIPLE_AGENT_SCOPES";
    throw error;
  }
  const sourceAgentId = clean(sourceInspection.agentIds[0]);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const stagedPath = path.join(path.dirname(target), `.import-${randomUUID()}.db`);
  try {
    snapshotDatabaseReadOnly(source, stagedPath);
    const stagedDatabase = openMemoryDatabase(stagedPath);
    try {
      rebindAgentScope(stagedDatabase, { sourceAgentId, targetAgentId });
      stagedDatabase.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      stagedDatabase.exec("PRAGMA journal_mode = DELETE");
    } finally {
      closeDatabase(stagedDatabase);
    }
    const imported = inspectDatabaseBackup(stagedPath, { verifyManifest: false });
    if (imported.agentIds.some((id) => id !== targetAgentId)) {
      const error = new Error("Imported database could not be rebound to the target Agent.");
      error.code = "IMPORT_AGENT_REBIND_FAILED";
      throw error;
    }

    let safetyBackup = null;
    if (fs.existsSync(target)) {
      const directory = path.resolve(clean(backupDirectory) || path.join(path.dirname(target), "backups"));
      const backupPath = path.join(directory, `pre-import-${safeTimestamp(now)}.db`);
      safetyBackup = createDatabaseBackup({
        databasePath: target,
        destinationPath: backupPath,
        agentId: targetAgentId,
        now,
      });
    }
    replaceActiveDatabase({ target, stagedPath, retiredLabel: "pre-import" });
    return {
      status: "imported",
      source: sourceInspection,
      imported: inspectDatabaseBackup(target, { verifyManifest: false }),
      reboundAgentId: sourceAgentId,
      targetAgentId,
      safetyBackup,
    };
  } finally {
    fs.rmSync(stagedPath, { force: true });
    fs.rmSync(`${stagedPath}-wal`, { force: true });
    fs.rmSync(`${stagedPath}-shm`, { force: true });
  }
}

export { BACKUP_FORMAT };
