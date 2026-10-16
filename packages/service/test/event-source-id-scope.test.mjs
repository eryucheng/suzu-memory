import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryService, inspectDatabaseBackup } from '@suzu-memory/service';
import { openMemoryDatabase } from '@suzu-memory/core';

const at = '2026-09-06T04:00:00.000Z';
test('cleanup keeps SQL and JSON references in their table namespace across live and backup closure', async t => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-id-scope-'));
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }));
  const options = { dataRoot, agentId: 'agent-a', defaults: { primaryUserId: 'user-a', userName: 'Alice', memoryOwner: 'A' } };
  const memory = createMemoryService(options);
  const scope = { owner: 'id-scope-contract', agentId: 'agent-a', eventUpperBound: 2, clears: [] };
  const oldBody = 'ERASE_NAMESPACED_旧分析正文', safeBody = 'KEEP_NAMESPACED_独立天文台';
  memory.appendEventSources({ scope, events: [['old', 1, oldBody], ['safe', 2, safeBody]].map(([id, sequence, text]) => ({
    occurredAt: at, content: { text }, source: { version: 1, owner: scope.owner, recipientAgentId: 'agent-a',
      eventId: id, spaceId: id, commitSequence: sequence, eventType: 'message.created',
      sender: { kind: 'local-user', id: 'user-a' }, topology: { kind: 'space' } },
  })) });
  await memory.processPendingEvents({ generator: async () => ({ output: { memories: [] }, usage: {} }), runMaintenance: false });
  const sharedId = 'local-record-17';
  let before, old, safe;
  memory.withRepository(repository => {
    const links = repository.database.prepare(`SELECT source.id AS sourceId, source.content, link.memory_id AS memoryId
      FROM source_records source JOIN memory_sources link ON link.source_id=source.id`).all();
    old = links.find(row => row.content === oldBody);
    safe = links.find(row => row.content === safeBody);
    // Public memory IDs may also equal an analysis ID or an erased source ID.
    // A trace's selectedIds still refer specifically to memory_nodes.
    for (const id of [sharedId, old.sourceId]) {
      repository.upsertMemory({ id, agentId: 'agent-a', kind: 'event', layer: 'long_term', content: safeBody,
        subjectRole: 'user', subjectKey: 'user-a', recordedAt: at, evidenceMode: 'explicit' });
      repository.linkSource(id, safe.sourceId);
    }
    for (const [id, input, body] of [[sharedId, old, oldBody], ['erased-trace', safe, safeBody]]) {
      repository.recordStateAnalysisRun({ id, agentId: 'agent-a', stateFamily: 'preference', analyzerRole: 'evidence-review',
        batchId: id === 'erased-trace' ? sharedId : '', requestId: old.sourceId,
        subjectRole: 'user', subjectKey: 'user-a', canonicalKey: 'preference:scope', promptVersion: '1', schemaVersion: '1',
        inputHash: `input:${id}`, status: 'completed', memoryIds: [input.memoryId], sourceIds: [input.sourceId],
        output: { explanation: body }, createdAt: at });
    }
    // The analysis_run_id FK targets the retained analysis, despite its ID
    // equalling the separate trace that really does depend on the old source.
    repository.recordStateEvidenceObservation({ id: old.sourceId, agentId: 'agent-a', stateFamily: 'preference',
      subjectRole: 'user', subjectKey: 'user-a', canonicalKey: 'preference:scope', memoryId: safe.memoryId,
      evidenceGroupId: 'independent-group', signal: 'preference', claimedDirection: 'support', effectiveDirection: 'support',
      qualification: 'qualified', payloadSchemaVersion: '1', payload: { explanation: safeBody }, sourceIds: [safe.sourceId],
      analysisRunIds: ['erased-trace'], observedAt: at, createdAt: at });
    const trace = (id, selectedIds, metadata = {}) => repository.recordRetrievalTrace({ id, agentId: 'agent-a', queryText: safeBody,
      resultStatus: 'ready', seedIds: selectedIds, selectedIds, metadata, createdAt: at });
    trace(sharedId, [sharedId]);
    trace('source-namespace-trace', [old.sourceId]);
    trace('literal-id-trace', [safe.memoryId], { explanation: old.sourceId, providerRequestId: sharedId });
    trace('erased-trace', [old.memoryId]);
    trace('erased-nested-memory-trace', [safe.memoryId], { graph: { selectedIds: [old.memoryId] } });
    trace('erased-analysis-snapshot-trace', [safe.memoryId], { snapshot: { analysisRunIds: [sharedId] } });
    repository.recordRetrievalFeedback({ id: sharedId, agentId: 'agent-a', traceId: sharedId,
      signal: 'used', targetMemoryIds: [sharedId], note: safeBody, createdAt: at });
    repository.recordRetrievalFeedback({ id: 'erased-feedback', agentId: 'agent-a', traceId: 'erased-trace',
      signal: 'used', targetMemoryIds: [old.memoryId], note: oldBody, createdAt: at });
    before = read(repository.database);
  });
  const backup = memory.backupDatabase();
  const cleared = { ...scope, clears: [{ spaceId: 'old', throughSequence: 1 }] };
  const job = memory.eraseEventSources({ id: 'namespace-clear', scope: cleared });
  assert.equal(job.complete, true);
  assert.equal(job.result.backups, 1);
  const retainedTraceIds = [sharedId, 'source-namespace-trace', 'literal-id-trace'];
  for (const [label, file] of [['live', memory.paths.databasePath], ['backup', backup.databasePath]]) {
    const database = openMemoryDatabase(file, { readOnly: true });
    try {
      const after = read(database);
      t.diagnostic(JSON.stringify({ label, before, after }));
      assert.deepEqual(after.traces, before.traces.filter(row => retainedTraceIds.includes(row.id)));
      assert.deepEqual(after.feedback, before.feedback.filter(row => row.id === sharedId));
      assert.deepEqual(after.analyses, before.analyses.filter(row => row.id === 'erased-trace'));
      assert.deepEqual(after.observations, before.observations);
      assert.equal(after.analyses.length, 1);
      assert.equal(after.observations.length, 1);
      assert.ok(!JSON.stringify(after).includes(oldBody));
      assert.ok(after.sources.some(row => row.id === safe.sourceId && row.content === safeBody));
      assert.equal(database.prepare('SELECT content FROM memory_nodes WHERE id=?').get(sharedId).content, safeBody);
      assert.equal(database.prepare('SELECT content FROM memory_nodes WHERE id=?').get(old.sourceId).content, safeBody);
      assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { database.close(); }
  }
  assert.equal(inspectDatabaseBackup(backup.databasePath).status, 'valid');
  const restarted = createMemoryService(options);
  restarted.initialize();
  assert.deepEqual(restarted.eraseEventSources({ id: job.id, scope: cleared }), job);
});

function read(database) {
  const rows = table => database.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
  return { analyses: rows('memory_state_analysis_runs'), observations: rows('memory_state_evidence_observations'),
    traces: rows('memory_retrieval_traces'), feedback: rows('memory_retrieval_feedback'), sources: rows('source_records') };
}
