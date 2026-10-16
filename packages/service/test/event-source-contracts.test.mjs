import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createMemoryService, validateMemoryExtractionOutput, inspectDatabaseBackup } from '../src/index.mjs';
import { getEventSourceCleanup, openMemoryDatabase, MemoryRepository } from '@suzu-memory/core';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../../core/src/schema.mjs';

const owner = 'product-events';
const timestamp = '2026-09-06T03:00:00.000Z';
const scope = (upper = 20, clears = [], agentId = 'agent-a') => ({ owner, agentId, eventUpperBound: upper, clears });
function event(id, commitSequence, text, spaceId = 'direct-a', sender = { kind: 'local-user', id: 'user-a' }) {
  return { occurredAt: timestamp, content: { text }, source: { version: 1, owner, eventId: id, spaceId,
    commitSequence, eventType: 'message.created', sender, recipientAgentId: 'agent-a',
    topology: spaceId === 'direct-a' ? { kind: 'direct-user-agent-dm', participants: [{ kind: 'local-user', id: 'user-a' }, { kind: 'agent', id: 'agent-a' }] } : { kind: 'space' } } };
}
function fixture(t, defaults = {}) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-event-contract-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const options = { dataRoot, agentId: 'agent-a', defaults: { primaryUserId: 'user-a', userName: 'Alice', memoryOwner: 'A', ...defaults } };
  return { memory: createMemoryService(options), options };
}
const archive = memory => memory.processPendingEvents({ generator: async () => ({ output: { memories: [] }, usage: {} }), runMaintenance: false });

test('scope-only nested executions do not materialize event bodies or evidence', t => {
  const { memory } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: Array.from({ length: 20 }, (_, i) => event(`source-${i}`, i + 1, `Message ${i}`)) });
  const prepare = DatabaseSync.prototype.prepare;
  let materialReads = 0;
  t.mock.method(DatabaseSync.prototype, 'prepare', function (sql) {
    const statement = prepare.call(this, sql);
    if (/\b(?:memory_input_events|source_records|memory_sources|memory_state_analysis_runs|memory_state_evidence_observations)\b/u.test(sql)) {
      return new Proxy(statement, { get(target, key) {
        if (key === 'all') return (...args) => { materialReads++; return target.all(...args); };
        const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
    return statement;
  });
  assert.equal(memory.withRepository(() => memory.withRepository(() => 42), { sourceScope: scope() }), 42);
  assert.equal(materialReads, 0);
});

test('public consumption progress stays scoped and advances only with a committed batch', t => {
  const { memory } = fixture(t);
  assert.equal(memory.getEventSourceProgress({ scope: scope() }).consumedThroughSequence, 0);
  memory.appendEventSources({ scope: scope(3), events: [event('source', 3, 'A valid source.')] });
  assert.equal(memory.getEventSourceProgress({ scope: scope() }).consumedThroughSequence, 3);
  assert.throws(() => memory.appendEventSources({ scope: scope(5), events: [event('future', 6, 'Not yet eligible.')] }), { code: 'EVENT_SOURCE_FUTURE' });
  assert.equal(memory.getEventSourceProgress({ scope: scope() }).consumedThroughSequence, 3);
  assert.throws(() => memory.getEventSourceProgress({ scope: scope(20, [], 'agent-b') }), { code: 'EVENT_SOURCE_AGENT_CONFLICT' });
  memory.eraseEventSources({ id: 'clear-progress', scope: scope(3, [{ spaceId: 'direct-a', throughSequence: 3 }]) });
  assert.throws(() => memory.getEventSourceProgress({ scope: scope() }), { code: 'EVENT_SOURCE_SCOPE_STALE' });
  assert.throws(() => memory.withRepository(() => 42, { sourceScope: scope() }), { code: 'EVENT_SOURCE_SCOPE_STALE' });
});
function dump(memory) {
  return memory.withRepository(repository => {
    const database = repository.database;
    return database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'memory_fts_%'")
      .all().map(({ name }) => JSON.stringify(database.prepare(`SELECT * FROM "${name}"`).all())).join('\n');
  });
}
function node(memory, id, content, sourceIds = []) {
  return memory.withRepository(repository => {
    const result = repository.upsertMemory({ id, agentId: memory.agentId, kind: 'event', layer: 'long_term', title: content, content,
      subjectRole: 'user', subjectKey: 'user-a', recordedAt: timestamp, evidenceMode: 'explicit' });
    for (const sourceId of sourceIds) repository.linkSource(result.id, sourceId);
    return result;
  });
}

test('public Event ingestion preserves actual other-Agent/Space identity, topology and exact receipt', async t => {
  const { memory } = fixture(t);
  const source = event('shared', 3, 'B 说他刚从天文台回来。', 'shared-space', { kind: 'agent', id: 'agent-b', name: 'B' });
  const result = memory.appendEventSources({ scope: scope(), events: [source] });
  assert.equal(result.inserted, 1);
  assert.equal(memory.appendEventSources({ scope: scope(), events: [source] }).reused, 1);
  const row = memory.listInputEvents().items[0];
  assert.equal(row.protocol_version, 2);
  assert.equal(row.actor_role, 'other');
  assert.equal(row.actor_key, 'agent-b');
  assert.deepEqual(row.metadata.eventSource, source.source);
  assert.deepEqual(row.participants, []);
  await archive(memory);
  const utterance = memory.listMemories({ kinds: ['utterance'] }).items[0];
  assert.equal(utterance.subject_role, 'other');
  assert.equal(utterance.subject_key, 'agent-b');
  assert.equal(utterance.metadata.conversationTopology, 'space');
  assert.deepEqual(validateMemoryExtractionOutput({ schemaName: 'long-term-memory-extraction-v2' }, { memories: [] }).memories, []);
  assert.throws(() => memory.appendEventSources({ scope: scope(2), events: [source] }), { code: 'EVENT_SOURCE_FUTURE' });
  assert.throws(() => memory.appendEventSources({ scope: scope(), events: [{ ...source, source: { ...source.source, recipientAgentId: 'agent-b' } }] }), { code: 'EVENT_SOURCE_AGENT_CONFLICT' });
});

test('schema v41 upgrade preserves legacy rows and erases the shipped Lives receipt without invented provenance', async t => {
  const { memory } = fixture(t);
  fs.mkdirSync(path.dirname(memory.paths.databasePath), { recursive: true });
  const previous = new DatabaseSync(memory.paths.databasePath);
  try {
    previous.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL) STRICT;');
    for (const migration of MIGRATIONS.filter(item => item.version <= 41)) {
      previous.exec(migration.sql);
      previous.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version, migration.name, timestamp);
    }
    new MemoryRepository(previous).appendInputEvent({ agentId: 'agent-a', externalId: 'event:legacy', protocolVersion: 1,
      eventType: 'conversation.turn', actorRole: 'user', actorKey: 'user-a', occurredAt: timestamp,
      content: { text: 'LEGACY_ERASE_旧接入口令' }, metadata: { host: { id: 'suzu-lives-events', sessionId: 'agent-a' },
        suzuLives: { agentId: 'agent-a', eventId: 'legacy', spaceId: 'direct-a', commitSequence: 1 } } });
  } finally { previous.close(); }
  memory.initialize();
  assert.equal(memory.listInputEvents().items[0].content.text, 'LEGACY_ERASE_旧接入口令');
  await archive(memory);
  const sourceScope = { ...scope(), owner: 'suzu-lives-events' };
  const hidden = await memory.search('旧接入口令', { sourceScope, persistTrace: false });
  assert.equal(hidden.fragments.length, 0, 'An old incomplete envelope does not become valid v2 evidence through migration.');
  memory.eraseEventSources({ id: 'legacy-clear', scope: { ...sourceScope, clears: [{ spaceId: 'direct-a', throughSequence: 1 }] } });
  assert.ok(!dump(memory).includes('LEGACY_ERASE'));
  assert.equal(memory.info().database.schemaVersion, 44);
});

test('direct provenance with another local user retains the actual counterpart instead of the default identity', async t => {
  const { memory } = fixture(t);
  const input = event('other-local', 1, '另一位用户发来的实际记录。', 'direct-a', { kind: 'local-user', id: 'user-b' });
  input.source.topology.participants[0].id = 'user-b';
  memory.appendEventSources({ scope: scope(), events: [input] });
  await archive(memory);
  memory.withRepository(repository => {
    const roles = repository.database.prepare('SELECT * FROM memory_actor_roles').all();
    assert.ok(roles.some(role => role.role === 'speaker' && role.actor_role === 'other' && role.actor_key === 'user-b'));
    assert.ok(roles.some(role => role.role === 'participant' && role.actor_key === 'agent-a'));
    assert.ok(!roles.some(role => role.actor_key === 'user-a'));
  });
});

test('range erasure removes fragments, revisions, mixed derived snapshots and owned backup bodies while preserving independent sources', async t => {
  const { memory } = fixture(t, { ingestion: { maximumEventCharacters: 64, maximumBatchCharacters: 1000 } });
  const marker = 'ERASE_ME_旧地址紫水晶仓库';
  memory.appendEventSources({ scope: scope(), events: [event('old', 1, marker.repeat(20)), event('safe', 2, 'KEEP_ME_其他空间的蓝色天文台', 'other-space')] });
  await archive(memory);
  const sources = memory.withRepository(repository => repository.database.prepare('SELECT * FROM source_records').all());
  const oldSource = sources.find(row => row.content.includes(marker));
  const safeSource = sources.find(row => row.content.includes('KEEP_ME'));
  assert.ok(oldSource && safeSource);
  const mixed = node(memory, 'mixed-derived', `${marker} 与另一来源混合`, [oldSource.id, safeSource.id]);
  assert.equal(memory.reactivateRecall({ activationId: 'mixed-source-input', memoryIds: [mixed.id], sourceScope: scope() }).applied, 1);
  assert.equal(memory.withRepository((_repository, database) => database.prepare('SELECT COUNT(*) AS n FROM memory_recall_reactivation_receipts').get().n), 1);
  memory.editMemory(mixed.id, { title: `${marker} 的修订标题` });
  memory.reviseEvent(`${owner}:old`, { action: 'retract', revisionId: 'old-input-revision', reason: `${marker} 修订审计` });
  const backup = memory.backupDatabase();
  const cleared = scope(20, [{ spaceId: 'direct-a', throughSequence: 1 }]);
  const job = memory.eraseEventSources({ id: 'clear-1', scope: cleared });
  assert.equal(memory.withRepository((_repository, database) => database.prepare('SELECT COUNT(*) AS n FROM memory_recall_reactivation_receipts').get().n), 0);
  assert.equal(job.complete, true);
  assert.ok(job.result.inputs > 1);
  assert.ok(!dump(memory).includes(marker));
  assert.ok(dump(memory).includes('KEEP_ME'));
  const backupDb = openMemoryDatabase(backup.databasePath, { readOnly: true });
  try { assert.ok(!JSON.stringify(backupDb.prepare('SELECT * FROM memory_input_events').all()).includes(marker)); }
  finally { backupDb.close(); }
  assert.equal(inspectDatabaseBackup(backup.databasePath).status, 'valid');
  assert.deepEqual(memory.eraseEventSources({ id: 'clear-1', scope: cleared }), job);
  assert.throws(() => node(memory, mixed.id, marker), /EVENT_SOURCE_ERASED/u);
  assert.throws(() => memory.restoreMemory(mixed.id), /EVENT_SOURCE_ERASED/u);
  assert.throws(() => memory.appendEventSources({ scope: scope(), events: [] }), { code: 'EVENT_SOURCE_SCOPE_STALE' });
  const replay = memory.appendEventSources({ scope: cleared, events: [event('old', 1, marker.repeat(20))] });
  assert.equal(replay.inserted, 0);
  assert.equal(replay.cleared.length, 1);
  memory.appendEventSources({ scope: cleared, events: [event('new', 4, 'NEW_ME_刚搬到琥珀小屋')] });
  await archive(memory);
  assert.ok(dump(memory).includes('NEW_ME'));
});

test('cleanup preserves another Agent in the same SQLite and independent same-Agent evidence and mutation records', async t => {
  const { memory, options } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: [event('old', 1, 'ERASE_A_ONLY'), event('safe', 3, 'SAFE_A_OTHER_SPACE', 'other-space')] });
  await archive(memory);
  const other = createMemoryService({ ...options, agentId: 'agent-b', databasePath: memory.paths.databasePath });
  other.initialize();
  const otherEvent = event('shared-other-agent', 2, 'SAFE_B_SHARED', 'shared-space', { kind: 'agent', id: 'agent-a' });
  otherEvent.source.recipientAgentId = 'agent-b';
  other.appendEventSources({ scope: scope(20, [], 'agent-b'), events: [otherEvent] });
  await archive(other);
  const safeSource = memory.withRepository(repository => repository.database.prepare("SELECT * FROM source_records WHERE agent_id='agent-a' AND content='SAFE_A_OTHER_SPACE'").get());
  const safe = node(memory, 'untouched-derived', 'SAFE_A_OTHER_SPACE', [safeSource.id]);
  memory.editMemory(safe.id, { title: 'VERIFIED_SAFE_EDIT' });
  const before = memory.withRepository(repository => ({
    otherInputs: repository.database.prepare("SELECT * FROM memory_input_events WHERE agent_id='agent-b'").all(),
    otherSources: repository.database.prepare("SELECT * FROM source_records WHERE agent_id='agent-b'").all(),
    otherNodes: repository.database.prepare("SELECT * FROM memory_nodes WHERE agent_id='agent-b'").all(),
    mutation: repository.database.prepare('SELECT * FROM memory_mutations WHERE memory_id=?').all(safe.id),
  }));
  memory.eraseEventSources({ id: 'a-only', scope: scope(20, [{ spaceId: 'direct-a', throughSequence: 1 }]) });
  memory.withRepository(repository => {
    assert.deepEqual(repository.database.prepare("SELECT * FROM memory_input_events WHERE agent_id='agent-b'").all(), before.otherInputs);
    assert.deepEqual(repository.database.prepare("SELECT * FROM source_records WHERE agent_id='agent-b'").all(), before.otherSources);
    assert.deepEqual(repository.database.prepare("SELECT * FROM memory_nodes WHERE agent_id='agent-b'").all(), before.otherNodes);
    assert.deepEqual(repository.database.prepare('SELECT * FROM memory_mutations WHERE memory_id=?').all(safe.id), before.mutation);
    assert.equal(repository.getMemory(safe.id).content, 'SAFE_A_OTHER_SPACE');
    assert.deepEqual(repository.database.prepare('PRAGMA foreign_key_check').all(), []);
  });
});

test('a clear releases the unaffected member of a real claimed batch for reprocessing', async t => {
  const { memory } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: [event('old', 1, 'BATCH_ERASE'), event('safe', 2, 'BATCH_KEEP', 'other-space')] });
  const claim = memory.withRepository(repository => repository.claimPendingInputEvents(memory.agentId, { maximumEvents: 5 }));
  assert.equal(claim.events.length, 2);
  memory.eraseEventSources({ id: 'batch-clear', scope: scope(20, [{ spaceId: 'direct-a', throughSequence: 1 }]) });
  const pending = memory.listInputEvents().items;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].content.text, 'BATCH_KEEP');
  assert.equal(pending[0].batch_id, '');
  await archive(memory);
  assert.ok(!dump(memory).includes('BATCH_ERASE'));
  assert.ok(dump(memory).includes('BATCH_KEEP'));
});

test('scoped RAG excludes unknown and future candidate/evidence bodies but materializes valid memory', async t => {
  const { memory } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: [event('known', 1, '可验证的天文台之旅是蓝色展馆。'), event('future', 9, 'FUTURE_BODY 天文台之旅秘密')] });
  await archive(memory);
  const records = memory.withRepository(repository => repository.database.prepare('SELECT * FROM source_records').all());
  node(memory, 'safe-event', '可验证的天文台之旅是蓝色展馆。', [records.find(row => row.content.includes('可验证')).id]);
  node(memory, 'unknown-event', 'UNKNOWN_BODY 天文台之旅');
  const result = await memory.search('天文台之旅', { now: timestamp, sourceScope: scope(2), anchors: ['safe-event'], persistTrace: false });
  assert.equal(result.status, 'ready');
  assert.ok(result.context.includes('蓝色展馆'));
  assert.ok(!JSON.stringify(result).includes('FUTURE_BODY'));
  assert.ok(!JSON.stringify(result).includes('UNKNOWN_BODY'));
  assert.deepEqual(result.fragments[0].eventSources.map(source => source.eventId), ['known']);
  const empty = await memory.search('天文台之旅', { now: timestamp, sourceScope: scope(0), persistTrace: false });
  assert.equal(empty.fragments.length, 0);
});

test('committed fence rejects extraction and embedding late writes and lets newer Events proceed', async t => {
  const { memory } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: [event('old', 1, 'LATE_ERASE_旧的雪山口令')] });
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const extraction = memory.processPendingEvents({ generator: async () => { start(); await wait; return { output: { memories: [] }, usage: {} }; } });
  const outcome = extraction.then(value => ({ value }), error => ({ error }));
  await started;
  const cleared = scope(20, [{ spaceId: 'direct-a', throughSequence: 1 }]);
  memory.eraseEventSources({ id: 'clear-live', scope: cleared });
  memory.appendEventSources({ scope: cleared, events: [event('new', 3, 'NEW_LIVE_海边灯塔')] });
  release();
  assert.ok((await outcome).error);
  await archive(memory);
  assert.ok(!dump(memory).includes('LATE_ERASE'));
  assert.ok(dump(memory).includes('NEW_LIVE'));
  let embeddingStart, embeddingRelease;
  const embeddingStarted = new Promise(resolve => { embeddingStart = resolve; });
  const embeddingWait = new Promise(resolve => { embeddingRelease = resolve; });
  const embedding = Object.assign(async () => { embeddingStart(); await embeddingWait; return { model: 'test-vector', vector: [1, 0] }; }, { model: 'test-vector', dimensions: 2 });
  const pending = memory.syncEmbeddings({ embeddingProvider: embedding, maxRetries: 0 }).then(value => ({ value }), error => ({ error }));
  await embeddingStarted;
  memory.eraseEventSources({ id: 'clear-newer', scope: scope(20, [{ spaceId: 'direct-a', throughSequence: 3 }]) });
  embeddingRelease();
  const vectorResult = await pending;
  assert.ok(vectorResult.error || vectorResult.value.failed > 0);
  assert.ok(!dump(memory).includes('NEW_LIVE'));
  assert.equal(memory.withRepository(repository => repository.listEmbeddings(memory.agentId, 'test-vector')).length, 0);
});

test('search crossing a clear cannot persist late provider diagnostic bodies or return stale material', async t => {
  const { memory } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: [event('old', 1, 'LEDGER_ERASE_青柠密码')] });
  await archive(memory);
  fs.mkdirSync(path.dirname(memory.paths.usageLedgerPath), { recursive: true });
  fs.writeFileSync(memory.paths.usageLedgerPath, JSON.stringify({ schemaVersion: 1, id: 'usage-old', timestamp,
    agentId: 'agent-a', model: 'test-model', feature: 'test', usage: { inputTokens: 10 }, units: { inputTokens: 10 }, metadata: { echo: 'LEDGER_ERASE_青柠密码' } }) + '\n');
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const search = memory.search('青柠密码', { now: timestamp, sourceScope: scope(), embeddingProvider: async () => {
    start(); await waiting;
    return { model: 'test-model', vector: [1, 0], usage: { inputTokens: 10 }, metadata: { echo: 'LEDGER_ERASE_青柠密码' } };
  } });
  const rejected = assert.rejects(search, { code: 'EVENT_SOURCE_EPOCH_CHANGED' });
  await started;
  memory.eraseEventSources({ id: 'ledger-clear', scope: scope(20, [{ spaceId: 'direct-a', throughSequence: 1 }]) });
  release();
  await rejected;
  const ledger = fs.readFileSync(memory.paths.usageLedgerPath, 'utf8');
  assert.ok(!ledger.includes('LEDGER_ERASE'));
  const accounting = ledger.trim().split('\n').map(line => JSON.parse(line));
  // A provider that completed after clear may still contribute numeric cost
  // accounting. Neither that record nor the previous one may retain its echo.
  assert.ok(accounting.every(row => Object.keys(row.metadata).length === 0));
  assert.equal(accounting[0].usage.inputTokens, 10);
  assert.ok(!dump(memory).includes('LEDGER_ERASE'));
});

test('candidate and final evidence use one SQLite snapshot while a newer Event is archived concurrently', async t => {
  const { memory } = fixture(t);
  memory.appendEventSources({ scope: scope(2), events: [event('old', 1, 'SNAPSHOT_OLD 我去了雪山博物馆。')] });
  await archive(memory);
  const existing = memory.listMemories().items[0];
  let start, release;
  const started = new Promise(resolve => { start = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  const pending = memory.search('雪山博物馆', { sourceScope: scope(2), persistTrace: false, now: timestamp,
    embeddingProvider: async () => { start(); await waiting; return { model: 'test-vector', vector: [1, 0] }; } });
  await started;
  memory.appendEventSources({ scope: scope(20), events: [event('future', 9, 'SNAPSHOT_FUTURE 雪山博物馆的新细节。')] });
  await archive(memory);
  const source = memory.withRepository(repository => repository.database.prepare("SELECT * FROM source_records WHERE content LIKE 'SNAPSHOT_FUTURE%'").get());
  node(memory, existing.id, 'SNAPSHOT_FUTURE 雪山博物馆的新细节。', [source.id]);
  release();
  const result = await pending;
  assert.ok(result.context.includes('SNAPSHOT_OLD'));
  assert.ok(!JSON.stringify(result).includes('SNAPSHOT_FUTURE'));
  assert.deepEqual(result.fragments[0].eventSources.map(source => source.eventId), ['old']);
  assert.ok(dump(memory).includes('SNAPSHOT_FUTURE'));
});

test('an incomplete managed backup leaves a recoverable file phase and cannot report cleanup complete', async t => {
  const { memory, options } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: [event('old', 1, 'BACKUP_ERASE_BODY')] });
  await archive(memory);
  memory.backupDatabase();
  const incomplete = path.join(memory.paths.backupDirectory, 'interrupted.sqlite');
  fs.writeFileSync(incomplete, 'controlled incomplete backup');
  assert.throws(() => memory.eraseEventSources({ id: 'files-retry', scope: scope(20, [{ spaceId: 'direct-a', throughSequence: 1 }]) }), { code: 'EVENT_SOURCE_CLEANUP_BACKUP' });
  assert.equal(memory.getEventSourceCleanup('files-retry').phase, 'database-cleaned');
  assert.equal(memory.getEventSourceCleanup('files-retry').complete, false);
  fs.unlinkSync(incomplete);
  const restarted = createMemoryService(options);
  restarted.initialize();
  assert.equal(restarted.getEventSourceCleanup('files-retry').complete, true);
  assert.ok(!dump(restarted).includes('BACKUP_ERASE_BODY'));
});

test('cleanup rejects a backup junction before following it and preserves the other directory', async t => {
  const { memory, options } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: [event('old', 1, 'PATH_ERASE_BODY')] });
  const otherDirectory = path.join(options.dataRoot, 'other-directory');
  fs.mkdirSync(otherDirectory);
  fs.writeFileSync(path.join(otherDirectory, 'keep.txt'), 'OTHER_OWNER_KEEP');
  fs.mkdirSync(memory.paths.backupDirectory, { recursive: true });
  const link = path.join(memory.paths.backupDirectory, 'redirect');
  fs.symlinkSync(otherDirectory, link, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.throws(() => memory.eraseEventSources({ id: 'junction-clear', scope: scope(20, [{ spaceId: 'direct-a', throughSequence: 1 }]) }), { code: 'EVENT_SOURCE_CLEANUP_PATH' });
    assert.equal(memory.getEventSourceCleanup('junction-clear').complete, false);
    assert.equal(fs.readFileSync(path.join(otherDirectory, 'keep.txt'), 'utf8'), 'OTHER_OWNER_KEEP');
  } finally {
    if (process.platform === 'win32') fs.rmdirSync(link);
    else fs.unlinkSync(link);
  }
  createMemoryService(options).initialize();
  assert.equal(memory.getEventSourceCleanup('junction-clear').complete, true);
});

for (const stopPhase of ['fenced', 'database-cleaned']) test(`restart resumes real OS interruption after ${stopPhase}`, async t => {
  const { memory, options } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: [event('old', 1, 'PROCESS_ERASE_旧电台'), event('safe', 2, 'PROCESS_KEEP_新电台', 'other-space')] });
  await archive(memory);
  const ready = path.join(options.dataRoot, 'child-ready');
  const child = spawn(process.execPath, [...process.execArgv.filter(arg => arg !== '--test'), fileURLToPath(new URL('./fixtures/event-source-interrupt.mjs', import.meta.url)),
    JSON.stringify({ options, ready, stopPhase, scope: scope(20, [{ spaceId: 'direct-a', throughSequence: 1 }]) })], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let stderr = ''; child.stderr.on('data', data => { stderr += data; });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  for (let attempts = 0; !fs.existsSync(ready); attempts += 1) {
    if (attempts > 300 || child.exitCode !== null) throw new Error(`Child failed to reach ${stopPhase}: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  const restarted = createMemoryService(options);
  restarted.initialize();
  const job = restarted.withRepository(repository => getEventSourceCleanup(repository, restarted.agentId, 'os-interrupt'));
  assert.equal(job.complete, true);
  assert.ok(!dump(restarted).includes('PROCESS_ERASE'));
  assert.ok(dump(restarted).includes('PROCESS_KEEP'));
});
