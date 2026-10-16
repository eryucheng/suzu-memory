import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryService } from '../src/index.mjs';
import { createEventSourceView } from '@suzu-memory/core';

const at = '2026-09-08T03:00:00.000Z';
const agentId = 'agent-import';
const scope = { owner: 'suzu-lives-events', agentId, eventUpperBound: 10, clears: [] };

function fixture() {
  const memory = createMemoryService({
    dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'memory-legacy-source-')),
    agentId, defaults: { ingestion: { maximumEventCharacters: 64 } },
  });
  memory.initialize();
  const record = (id, commitSequence, text) => {
    memory.withRepository(repository => repository.upsertSource({ id, agentId,
      sourceKind: 'conversation', externalId: id, content: text, occurredAt: at, recordedAt: at,
      metadata: { originalSession: 'saved-session' } }));
    return { sourceId: id, event: { occurredAt: at, content: { text }, source: {
      version: 1, owner: scope.owner, recipientAgentId: agentId, eventId: `import:${id}`,
      commitSequence, spaceId: 'direct:import', eventType: 'suzu-memory.source.imported',
      sender: { kind: 'system', id: 'legacy-memory-import' }, topology: { kind: 'space', spaceKind: 'direct' },
    } } };
  };
  const source = id => memory.withRepository(repository => repository.getSource(id), { readOnly: true });
  const inputs = () => memory.withRepository(repository => repository.database.prepare(
    'SELECT id, status, content_json, metadata_json FROM memory_input_events ORDER BY rowid').all(), { readOnly: true });
  return { memory, record, source, inputs };
}

test('legacy evidence preserves ordered fragments, graph links and identities across a replay', () => {
  const f = fixture();
  const records = [f.record('long-source', 1, '周末一起去博物馆，看了机器人展。'.repeat(24)),
    f.record('short-source', 2, '下次去天文台。')];
  f.memory.withRepository(repository => {
    repository.upsertMemory({ id: 'existing-memory', agentId, kind: 'event', layer: 'long_term',
      title: '周末安排', content: records[0].event.content.text, subjectRole: 'user', subjectKey: 'user',
      reality: 'real', evidenceMode: 'explicit', recordedAt: at, status: 'active' });
    repository.linkSource('existing-memory', records[0].sourceId);
  });
  const graph = () => f.memory.withRepository(repository => ({
    nodes: repository.database.prepare('SELECT * FROM memory_nodes ORDER BY id').all(),
    links: repository.database.prepare('SELECT * FROM memory_sources ORDER BY memory_id, source_id').all(),
  }), { readOnly: true });
  const before = graph();
  // An independent owner can use the same Event ID; only this import is adopted.
  const otherOwner = 'another-product';
  const other = f.memory.appendEventSources({ scope: { ...scope, owner: otherOwner }, events: [{
    ...records[0].event, content: { text: '其他来源的正文。' }, source: { ...records[0].event.source, owner: otherOwner },
  }] }).events[0];
  assert.deepEqual(f.memory.adoptLegacySourceEvidence({ scope, records }), { sources: 2 });
  const first = f.inputs();
  for (const record of records) {
    const saved = f.source(record.sourceId);
    assert.equal(saved.metadata.originalSession, 'saved-session');
    const inputs = saved.metadata.inputEventIds.map(id => first.find(input => input.id === id));
    assert.equal(inputs.map(input => JSON.parse(input.content_json).text).join(''), record.event.content.text);
    assert.ok(inputs.every(input => input.status === 'archived'));
    assert.ok(!saved.metadata.inputEventIds.includes(other.id));
  }
  assert.ok(f.source('long-source').metadata.inputEventIds.length > 1);
  assert.equal(first.find(input => input.id === other.id).status, 'pending');
  assert.deepEqual(graph(), before);
  // A replay may repeat an identical requested source in the same call.
  f.memory.adoptLegacySourceEvidence({ scope, records: [...records, records[0]] });
  assert.deepEqual(f.inputs(), first);
  assert.deepEqual(graph(), before);
});

test('mismatched legacy evidence fails before writing inputs', () => {
  const f = fixture(), record = f.record('source', 1, '原始正文。');
  record.event.content.text = '不相同的正文。';
  const before = f.source('source');
  assert.throws(() => f.memory.adoptLegacySourceEvidence({ scope, records: [record] }), { code: 'MEMORY_IMPORT_SOURCE_MISMATCH' });
  assert.deepEqual(f.source('source'), before);
  assert.deepEqual(f.inputs(), []);
});

test('an incomplete imported source rolls back all source associations in the batch', () => {
  const f = fixture();
  const records = [f.record('available', 3, '保留的正文。'), f.record('cleared', 2, '已清除范围里的正文。')];
  const before = records.map(record => f.source(record.sourceId));
  assert.throws(() => f.memory.adoptLegacySourceEvidence({ scope: { ...scope,
    clears: [{ spaceId: 'direct:import', throughSequence: 2 }] }, records }), { code: 'MEMORY_IMPORT_SOURCE_INCOMPLETE' });
  assert.deepEqual(records.map(record => f.source(record.sourceId)), before);
  assert.ok(f.inputs().every(input => input.status === 'pending'));
});

test('conflicting input replays preserve original sources', () => {
  const f = fixture(), record = f.record('source', 1, '原始正文。');
  f.memory.appendEventSources({ scope, events: [{ ...record.event, content: { text: '冲突正文。' } }] });
  const sourceBefore = f.source('source'), inputsBefore = f.inputs();
  assert.throws(() => f.memory.adoptLegacySourceEvidence({ scope, records: [record] }), { code: 'INPUT_EVENT_CONFLICT' });
  assert.deepEqual(f.source('source'), sourceBefore);
  assert.deepEqual(f.inputs(), inputsBefore);
});

test('experience evidence upgrades source coordinates once and retains graph provenance and input fragments', () => {
  const f = fixture(), record = f.record('source', 5, '保留下来的记忆。');
  f.memory.adoptLegacySourceEvidence({ scope, records: [record] });
  f.memory.withRepository(repository => {
    repository.upsertMemory({ id: 'existing-memory', agentId, kind: 'event', layer: 'long_term', title: '记忆', content: record.event.content.text,
      subjectRole: 'user', subjectKey: 'user', reality: 'real', evidenceMode: 'explicit', recordedAt: at, status: 'active' });
    repository.linkSource('existing-memory', record.sourceId);
  });
  const before = f.inputs(), sourceBefore = f.source(record.sourceId);
  const current = { version: 2, owner: scope.owner, agentId, agentGeneration: 1, experienceUpperBound: 2, globalEventUpperBound: 10,
    contentRevision: 0, clearedThroughExperienceSequence: 0 };
  const resolveSource = source => ({ ...source, version: 2, agentGeneration: 1,
    experienceRef: { experienceId: 'seen', experienceSequence: 2, itemIndex: 0, sourceEventId: source.eventId } });
  const result = f.memory.adoptExperienceSourceEvidence({ scope: current, resolveSource, consumedThroughExperienceSequence: 2 });
  assert.equal(result.updated, before.length); assert.equal(result.progress.consumedThroughExperienceSequence, 2);
  assert.deepEqual(f.source(record.sourceId), sourceBefore);
  assert.deepEqual(f.inputs().map(row => [row.id,row.status,row.content_json]), before.map(row => [row.id,row.status,row.content_json]));
  f.memory.withRepository(repository => { assert.ok(createEventSourceView(repository, current, agentId).memoryIds.has('existing-memory')); }, { readOnly: true });
  const upgraded = f.inputs();
  assert.equal(f.memory.adoptExperienceSourceEvidence({ scope: current, resolveSource, consumedThroughExperienceSequence: 2 }).updated, 0);
  assert.deepEqual(f.inputs(), upgraded);
});

test('conflicting experience identities roll back the source rewrite and leave the old scope usable', () => {
  const f = fixture(), record = f.record('source', 5, '原始记忆。');
  f.memory.adoptLegacySourceEvidence({ scope, records: [record] }); const before = f.inputs();
  const current = { version: 2, owner: scope.owner, agentId, agentGeneration: 1, experienceUpperBound: 2, globalEventUpperBound: 10,
    contentRevision: 0, clearedThroughExperienceSequence: 0 };
  assert.throws(() => f.memory.adoptExperienceSourceEvidence({ scope: current, consumedThroughExperienceSequence: 2,
    resolveSource: source => ({ ...source, version: 2, agentGeneration: 1, eventId: 'different',
      experienceRef: { experienceId: 'seen', experienceSequence: 2, itemIndex: 0, sourceEventId: 'different' } }) }), { code: 'MEMORY_IMPORT_SOURCE_MISMATCH' });
  assert.deepEqual(f.inputs(), before);
  assert.equal(f.memory.getEventSourceProgress({ scope }).consumedThroughSequence, 10);
});
