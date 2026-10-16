import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MemoryRepository, openMemoryDatabase, beginEventSourceCleanup, cleanEventSourceDatabase,
  advanceEventSourceCleanup, eventSourceState, getEventSourceCleanup, eventSourceError } from '@suzu-memory/core';

function ownedPath(memory, target) {
  const base = path.resolve(memory.paths.agentRoot);
  const resolved = path.resolve(target);
  const inside = candidate => { const relative = path.relative(base, candidate); return relative && !relative.startsWith('..') && !path.isAbsolute(relative); };
  if (!inside(resolved)) throw eventSourceError('EVENT_SOURCE_CLEANUP_PATH', 'Cleanup paths must be inside this Agent data root.');
  // Inspect every existing ancestor, including the configured data root. A
  // junction beneath an otherwise valid root must never redirect owner cleanup.
  for (let current = resolved;; current = path.dirname(current)) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stat && (stat.isSymbolicLink() || path.relative(current, fs.realpathSync(current)))) {
      throw eventSourceError('EVENT_SOURCE_CLEANUP_PATH', 'Cleanup cannot follow linked or redirected paths.');
    }
    if (path.dirname(current) === current) break;
  }
  return resolved;
}
function managedFiles(memory, directory) {
  const result = [];
  const visit = target => {
    ownedPath(memory, target);
    if (!fs.existsSync(target)) return;
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) for (const name of fs.readdirSync(target)) visit(path.join(target, name));
    else if (stat.isFile()) result.push(target);
    else throw eventSourceError('EVENT_SOURCE_CLEANUP_PATH', 'Unsupported file in Memory backup storage.');
  };
  visit(directory);
  return result;
}
function scrubAccounting(memory) {
  const target = ownedPath(memory, memory.paths.usageLedgerPath);
  if (!fs.existsSync(target)) return;
  const lines = fs.readFileSync(target, 'utf8').split(/\r?\n/u).filter(Boolean).map(line => {
    let event;
    try { event = JSON.parse(line); } catch { throw eventSourceError('EVENT_SOURCE_CLEANUP_LEDGER', 'Cannot safely attribute a malformed usage ledger record.'); }
    if (event.agentId !== memory.agentId) return line;
    const numeric = value => Object.fromEntries(Object.entries(value || {}).filter(([, item]) => typeof item === 'number' && Number.isFinite(item)));
    return JSON.stringify({ schemaVersion: event.schemaVersion, id: event.id, timestamp: event.timestamp, agentId: event.agentId,
      provider: event.provider, model: event.model, source: event.source, feature: event.feature, requestId: event.requestId,
      usage: numeric(event.usage), units: numeric(event.units), metadata: {} });
  });
  const temporary = ownedPath(memory, `${target}.source-cleanup`);
  fs.writeFileSync(temporary, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  fs.renameSync(temporary, target);
}
function scrubBackup(memory, target, job) {
  const descriptor = fs.openSync(target, 'r');
  const header = Buffer.alloc(16);
  try { fs.readSync(descriptor, header, 0, 16, 0); } finally { fs.closeSync(descriptor); }
  if (header.toString('utf8') !== 'SQLite format 3\0') {
    if (/\.manifest\.json(?:\.source-cleanup|\.tmp-[\da-f-]+)?$/u.test(target)) {
      const manifest = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (manifest.format === 'suzu-memory-sqlite-backup-v1') return false;
    }
    if (/-(?:wal|shm)$/u.test(target) && fs.existsSync(target.replace(/-(?:wal|shm)$/u, ''))) return false;
    throw eventSourceError('EVENT_SOURCE_CLEANUP_BACKUP', 'An unrecognized or incomplete managed backup prevents cleanup completion.');
  }
  const database = openMemoryDatabase(target);
  try {
    const repository = new MemoryRepository(database);
    const prior = getEventSourceCleanup(repository, memory.agentId, job.id);
    const state = eventSourceState(repository, { agentId: memory.agentId, owner: job.owner });
    const scope = prior?.scope || (job.scope.version===2 ? { ...job.scope,
      experienceUpperBound: Math.max(job.scope.experienceUpperBound,state.experienceScope?.experienceUpperBound || 0),
      globalEventUpperBound: Math.max(job.scope.globalEventUpperBound,state.experienceScope?.globalEventUpperBound || 0),
      contentRevision: Math.max(job.scope.contentRevision,state.experienceScope?.contentRevision || 0),
      clearedThroughExperienceSequence: Math.max(job.scope.clearedThroughExperienceSequence,state.experienceScope?.clearedThroughExperienceSequence || 0) }
      : { ...job.scope,clears: [...job.scope.clears,...state.clears] });
    beginEventSourceCleanup(repository, { agentId: memory.agentId, id: job.id, scope });
    const cleaned = cleanEventSourceDatabase(repository, { agentId: memory.agentId, id: job.id });
    advanceEventSourceCleanup(repository, memory.agentId, job.id, 'complete', cleaned.result);
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { database.close(); }
  const manifestPath = ownedPath(memory, `${target}.manifest.json`);
  if (fs.existsSync(manifestPath)) {
    const priorManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const manifest = Object.fromEntries(['format', 'createdAt', 'agentId', 'databaseFile', 'database']
      .map(key => [key, priorManifest[key]]));
    manifest.bytes = fs.statSync(target).size;
    manifest.sha256 = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    const temporary = ownedPath(memory, `${manifestPath}.source-cleanup`);
    fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, manifestPath);
  }
  return true;
}
function finish(memory, repository, job, onProgress = () => {}) {
  if (job.complete) return job;
  job = cleanEventSourceDatabase(repository, { agentId: memory.agentId, id: job.id });
  onProgress(job);
  const files = managedFiles(memory, memory.paths.backupDirectory);
  const databaseDirectory = path.dirname(memory.paths.databasePath);
  const databaseName = path.basename(memory.paths.databasePath);
  for (const name of fs.readdirSync(databaseDirectory)) {
    if ((/^\.(?:restore|import)-.+\.db$/u.test(name) || name.startsWith(`${databaseName}.pre-restore-`)
      || name.startsWith(`${databaseName}.pre-import-`)) && !/-(?:wal|shm)$/u.test(name)) {
      files.push(ownedPath(memory, path.join(databaseDirectory, name)));
    }
  }
  let backups = 0;
  for (const target of files) if (fs.existsSync(target) && scrubBackup(memory, target, job)) backups += 1;
  const cache = ownedPath(memory, memory.paths.visualizationCachePath);
  if (fs.existsSync(cache)) fs.unlinkSync(cache);
  scrubAccounting(memory);
  job = advanceEventSourceCleanup(repository, memory.agentId, job.id, 'complete', { ...job.result, backups });
  onProgress(job);
  return job;
}

export function eraseMemoryEventSources(memory, { id, scope, onProgress = () => {} } = {}) {
  ownedPath(memory, memory.paths.databasePath);
  return memory.withRepository(repository => {
    const job = beginEventSourceCleanup(repository, { agentId: memory.agentId, id, scope });
    onProgress(job);
    return finish(memory, repository, job, onProgress);
  });
}
export function recoverMemoryEventSourceCleanups(memory, repository) {
  const rows = repository.database.prepare(`SELECT id,scope_json FROM memory_event_source_cleanups
    WHERE agent_id=? AND phase<>'complete' ORDER BY created_at,id`).all(memory.agentId);
  if (rows.length) ownedPath(memory, memory.paths.databasePath);
  return rows.map(row => finish(memory, repository,
    beginEventSourceCleanup(repository, { agentId: memory.agentId, id: row.id, scope: JSON.parse(row.scope_json) })));
}
