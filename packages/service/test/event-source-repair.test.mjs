import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryService, inspectDatabaseBackup } from '@suzu-memory/service';
import { openMemoryDatabase, stateScopeKeyFromScope } from '@suzu-memory/core';

const at = '2026-09-06T04:00:00.000Z';
const scope = (upper = 20, clears = []) => ({ owner: 'repair-events', agentId: 'agent-a', eventUpperBound: upper, clears });
function event(id, sequence, content, spaceId = 'retained-space') {
  return { occurredAt: at, content: { text: content }, source: { version: 1, owner: 'repair-events',
    eventId: id, commitSequence: sequence, spaceId, eventType: 'message.created',
    recipientAgentId: 'agent-a', sender: { kind: 'local-user', id: 'user-a' }, topology: { kind: 'space' } } };
}
function fixture(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-source-repair-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const options = { dataRoot, agentId: 'agent-a', defaults: { primaryUserId: 'user-a', userName: 'Alice', memoryOwner: 'A' } };
  return { memory: createMemoryService(options), options };
}
const archive = memory => memory.processPendingEvents({ generator: async () => ({ output: { memories: [] }, usage: {} }), runMaintenance: false });
const commonState = { agentId: 'agent-a', kind: 'preference', layer: 'semantic', subjectRole: 'user', subjectKey: 'user-a',
  canonicalKey: 'user:preference:fish', representationLayer: 'reported', stateFamily: 'preference', statePhase: 'active',
  temporalState: 'current', evidenceMode: 'explicit', knownAt: at, validFrom: at, recordedAt: at };
const stateKey = kind => kind === 'root' ? 'root' : stateScopeKeyFromScope({ kind: 'subcategory', label: '生鱼' });
function state(repository, id, kind, content, source) {
  repository.upsertMemory({ ...commonState, id, stateScopeKey: stateKey(kind), content });
  if (source) repository.linkSource(id, source.id);
}
function link(repository, exception, root) {
  repository.upsertEdge({ agentId: 'agent-a', fromMemoryId: exception, toMemoryId: root, relation: 'scoped_exception_to',
    direction: 'directed', weight: 1, confidence: 1, provenance: 'accepted-reported-state-proposal-v1' });
}
const sources = memory => memory.withRepository(repository => repository.database.prepare('SELECT * FROM source_records').all());

for (const primaryKind of ['root', 'exception']) for (const excluded of ['future', 'cleared', 'unknown']) {
  test(`scoped state ${primaryKind} preserves its body and excludes a ${excluded} completion`, async t => {
    const { memory } = fixture(t);
    memory.appendEventSources({ scope: scope(), events: [event('valid', 2, '用户喜欢鱼类食物。'), event('restricted', 9, '限制来源。', 'cleared-space')] });
    await archive(memory);
    const rows = sources(memory);
    memory.withRepository(repository => {
      state(repository, 'valid-primary', primaryKind, 'VALID_PRIMARY_用户喜欢鱼类食物。', rows.find(row => row.content === '用户喜欢鱼类食物。'));
      state(repository, 'restricted-related', primaryKind === 'root' ? 'exception' : 'root', 'RESTRICTED_COMPLETION_用户不喜欢生鱼。',
        excluded === 'unknown' ? null : rows.find(row => row.content === '限制来源。'));
      link(repository, primaryKind === 'root' ? 'restricted-related' : 'valid-primary', primaryKind === 'root' ? 'valid-primary' : 'restricted-related');
    });
    const selectedScope = excluded === 'future' ? scope(3) : excluded === 'cleared' ? scope(20, [{ spaceId: 'cleared-space', throughSequence: 9 }]) : scope();
    const result = await memory.search('喜欢鱼类食物', { sourceScope: selectedScope, anchors: ['valid-primary'], now: at, persistTrace: false });
    t.diagnostic(JSON.stringify({ primaryKind, excluded, scope: selectedScope, result }));
    assert.ok(result.context.includes('VALID_PRIMARY'));
    assert.ok(!JSON.stringify(result).includes('RESTRICTED_COMPLETION'));
    assert.deepEqual(result.graph.selectedMemoryIds, ['valid-primary']);
    assert.equal(result.graph.scopeCompletion, null);
    assert.deepEqual(result.fragments[0].eventSources.map(source => source.eventId), ['valid']);
  });
}

for (const primaryKind of ['root', 'exception']) {
  test(`scoped state ${primaryKind} still materializes an independently eligible completion`, async t => {
    const { memory } = fixture(t);
    memory.appendEventSources({ scope: scope(), events: [event('root-source', 2, '用户喜欢鱼类食物。'), event('exception-source', 3, '用户不喜欢生鱼。')] });
    await archive(memory);
    const rows = sources(memory);
    memory.withRepository(repository => {
      state(repository, 'valid-root', 'root', 'VALID_ROOT_用户喜欢鱼类食物。', rows.find(row => row.content === '用户喜欢鱼类食物。'));
      state(repository, 'valid-exception', 'exception', 'VALID_EXCEPTION_用户不喜欢生鱼。', rows.find(row => row.content === '用户不喜欢生鱼。'));
      link(repository, 'valid-exception', 'valid-root');
    });
    const result = await memory.search('喜欢鱼类食物', { sourceScope: scope(), anchors: [`valid-${primaryKind}`], now: at, persistTrace: false });
    assert.ok(result.context.includes('VALID_ROOT') && result.context.includes('VALID_EXCEPTION'));
    assert.deepEqual(new Set(result.graph.selectedMemoryIds), new Set(['valid-root', 'valid-exception']));
    assert.deepEqual(new Set(result.fragments[0].eventSources.map(source => source.eventId)), new Set(['root-source', 'exception-source']));
  });
}

test('exception completion selects the eligible root after a newer unknown root', async t => {
  const { memory } = fixture(t);
  memory.appendEventSources({ scope: scope(), events: [event('known', 2, '用户喜欢鱼类食物。')] });
  await archive(memory);
  const source = sources(memory)[0];
  memory.withRepository(repository => {
    state(repository, 'exception', 'exception', 'VALID_EXCEPTION_用户不喜欢生鱼。', source);
    state(repository, 'valid-root', 'root', 'VALID_ROOT_用户喜欢鱼类食物。', source);
    state(repository, 'unknown-root', 'root', 'UNKNOWN_ROOT_用户喜欢秘密鱼类。');
    link(repository, 'exception', 'valid-root');
    link(repository, 'exception', 'unknown-root');
    repository.database.prepare('UPDATE memory_nodes SET updated_at=? WHERE id=?').run('2026-09-07T04:00:00Z', 'unknown-root');
  });
  const result = await memory.search('喜欢鱼类食物', { sourceScope: scope(), anchors: ['exception'], now: at, persistTrace: false });
  t.diagnostic(JSON.stringify(result));
  assert.ok(result.context.includes('VALID_ROOT') && result.context.includes('VALID_EXCEPTION'));
  assert.ok(!JSON.stringify(result).includes('UNKNOWN_ROOT'));
  assert.deepEqual(result.graph.selectedMemoryIds, ['exception', 'valid-root']);
});

test('analysis FK closure erases parent bodies and dependent observations in live and managed backup databases', async t => {
  const { memory, options } = fixture(t);
  const marker = 'ERASE_ANALYSIS_BODY_旧紫色口令';
  memory.appendEventSources({ scope: scope(), events: [event('old', 1, marker, 'cleared-space'), event('safe', 2, 'KEEP_ANALYSIS_独立天文台')] });
  await archive(memory);
  memory.withRepository(repository => {
    const evidence = repository.database.prepare(`SELECT source.id AS sourceId, link.memory_id AS memoryId, source.content
      FROM source_records source JOIN memory_sources link ON link.source_id=source.id`).all();
    const old = evidence.find(row => row.content === marker), safe = evidence.find(row => row.content.startsWith('KEEP_ANALYSIS'));
    for (const [name, inputs, body] of [['mixed', [old, safe], marker], ['independent', [safe], 'KEEP_ANALYSIS_独立分析']]) {
      const run = repository.recordStateAnalysisRun({ id: `${name}-run`, agentId: 'agent-a', stateFamily: 'preference', analyzerRole: 'evidence-review',
        subjectRole: 'user', subjectKey: 'user-a', canonicalKey: `preference:${name}`, promptVersion: '1', schemaVersion: '1',
        inputHash: `input-${name}`, status: 'completed', memoryIds: inputs.map(row => row.memoryId), sourceIds: inputs.map(row => row.sourceId),
        output: { explanation: body }, createdAt: at });
      assert.equal(run.batch_id, '');
      // This observation has only valid direct evidence. Its body also depends
      // on the mixed analysis through the real observation -> run join table.
      repository.recordStateEvidenceObservation({ id: `${name}-observation`, agentId: 'agent-a', stateFamily: 'preference',
        subjectRole: 'user', subjectKey: 'user-a', canonicalKey: `preference:${name}`, memoryId: safe.memoryId,
        evidenceGroupId: `group-${name}`, signal: 'preference', claimedDirection: 'support', effectiveDirection: 'support',
        qualification: 'qualified', payloadSchemaVersion: '1', payload: { explanation: body },
        sourceIds: [safe.sourceId], analysisRunIds: [run.id], observedAt: at, createdAt: at });
    }
  });
  const backup = memory.backupDatabase();
  const cleared = scope(20, [{ spaceId: 'cleared-space', throughSequence: 1 }]);
  const job = memory.eraseEventSources({ id: 'analysis-clear', scope: cleared });
  assert.equal(job.complete, true);
  assert.equal(job.result.backups, 1);
  for (const databasePath of [memory.paths.databasePath, backup.databasePath]) {
    const database = openMemoryDatabase(databasePath, { readOnly: true });
    try {
      const runs = database.prepare('SELECT * FROM memory_state_analysis_runs').all();
      const observations = database.prepare('SELECT * FROM memory_state_evidence_observations').all();
      t.diagnostic(JSON.stringify({ databasePath, runs, observations }));
      assert.deepEqual(runs.map(row => row.id), ['independent-run']);
      assert.deepEqual(observations.map(row => row.id), ['independent-observation']);
      assert.ok(!JSON.stringify({ runs, observations }).includes(marker));
      assert.ok(JSON.stringify({ runs, observations }).includes('KEEP_ANALYSIS'));
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { database.close(); }
  }
  assert.equal(inspectDatabaseBackup(backup.databasePath).status, 'valid');
  const restarted = createMemoryService(options);
  restarted.initialize();
  assert.deepEqual(restarted.getEventSourceCleanup(job.id), job);
  assert.deepEqual(restarted.eraseEventSources({ id: job.id, scope: cleared }), job);
});
