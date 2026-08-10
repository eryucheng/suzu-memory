import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { databaseInfo, openMemoryDatabase } from "@suzu-memory/core";

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

function existingAgentIds(database) {
  const tableNames = new Set(database.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map((row) => row.name));
  const candidates = [
    "entities",
    "relationships",
    "memory_nodes",
    "memory_input_events",
  ].filter((table) => tableNames.has(table));
  const ids = new Set();
  for (const table of candidates) {
    for (const row of database.prepare(`SELECT DISTINCT agent_id FROM ${table}`).all()) {
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
  const { manifestPath, manifest } = readManifest(resolved);
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
    database.exec("PRAGMA wal_checkpoint(FULL)");
    database.exec(`VACUUM INTO ${sqlString(temporaryPath)}`);
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

    const retiredSuffix = `.pre-restore-${randomUUID()}`;
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

export { BACKUP_FORMAT };
