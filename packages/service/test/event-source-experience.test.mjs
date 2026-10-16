import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryService, inspectDatabaseBackup } from '../src/index.mjs';
import { openMemoryDatabase } from '@suzu-memory/core';

const owner = 'partitioned-product';
const scope = (experienceUpperBound,globalEventUpperBound,clearedThroughExperienceSequence = 0,contentRevision = 0) => ({
  version: 2,owner,agentId: 'agent-a',agentGeneration: 1,experienceUpperBound,globalEventUpperBound,clearedThroughExperienceSequence,contentRevision,
});
const event = (id,experienceSequence,commitSequence,observation) => ({ occurredAt: '2026-10-06T00:00:00.000Z',content: { text: id },
  source: { version: 2,owner,eventId: id,recipientAgentId: 'agent-a',agentGeneration: 1,spaceId: observation ? 'group-a' : 'direct-a',
    eventType: 'message.created',commitSequence,sender: { kind: 'local-user',id: 'user-a' },topology: { kind: 'space' },
    experienceRef: { experienceId: `experience-${experienceSequence}`,experienceSequence,itemIndex: 0,sourceEventId: id },
    ...(observation ? { observation } : {}) } });
function fixture(t) {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(),'memory-experience-'));
  return createMemoryService({ dataRoot,agentId: 'agent-a',defaults: { primaryUserId: 'user-a',userName: 'User',memoryOwner: 'A' } });
}

test('experience consumption advances independently of global sequence and admits an old message on its new observation',t => {
  const memory = fixture(t),first = scope(1,1000);
  assert.equal(memory.appendEventSources({ scope: first,events: [event('direct-new',1,1000)] }).inserted,1);
  const next = scope(2,2000),observed = event('group-old',2,10,{ eventId: 'observed-now',commitSequence: 2000 });
  assert.equal(memory.appendEventSources({ scope: next,events: [observed] }).inserted,1);
  assert.equal(memory.appendEventSources({ scope: next,events: [observed] }).reused,1);
  const progress = memory.getEventSourceProgress({ scope: next });
  assert.equal(progress.consumedThroughExperienceSequence,2);assert.equal(progress.consumedThroughSequence,0);
  assert.deepEqual(memory.listInputEvents().items.map(row => row.metadata.eventSource.eventId).sort(),['direct-new','group-old']);
  assert.throws(() => memory.appendEventSources({ scope: next,events: [event('future',3,2000)] }),{ code: 'EVENT_SOURCE_FUTURE' });
});

test('experience clear persists the fence, preserves later input, and scrubs managed backups by the owning experience cutoff',async t => {
  const memory = fixture(t),before = scope(2,2000);
  const old = { ...event('old-source',1,1000),content: { text: 'old-private-marker' } },later = { ...event('later-source',2,2000),content: { text: 'later-private-marker' } };
  memory.appendEventSources({ scope: before,events: [old,later] });
  const backup = memory.backupDatabase(),cleared = scope(2,2001,1,1);
  const result = await memory.eraseEventSources({ id: 'clear-first-experience',scope: cleared });
  assert.equal(result.complete,true);
  assert.throws(() => memory.getEventSourceProgress({ scope: before }),{ code: 'EVENT_SOURCE_SCOPE_STALE' });
  assert.equal(memory.appendEventSources({ scope: cleared,events: [old] }).inserted,0);
  const rows = memory.listInputEvents({ limit: 100 }).items;
  assert.ok(!JSON.stringify(rows).includes('old-private-marker'));assert.ok(JSON.stringify(rows).includes('later-private-marker'));
  const db = openMemoryDatabase(backup.databasePath,{ readOnly: true });
  try {
    const saved = JSON.stringify(db.prepare('SELECT * FROM memory_input_events').all());
    assert.ok(!saved.includes('old-private-marker'));assert.ok(saved.includes('later-private-marker'));
  } finally { db.close(); }
  assert.equal(inspectDatabaseBackup(backup.databasePath).status,'valid');
  assert.equal(memory.getEventSourceProgress({ scope: cleared }).consumedThroughExperienceSequence,2);
});
