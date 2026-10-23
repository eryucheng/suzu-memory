import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildPreferenceEvidenceSnapshot, simulatePreferenceFormation } from '@suzu-memory/analysis';
import { proposeStructuresForBatch } from '@suzu-memory/structurer';
import { DEFAULT_PREFERENCE_FORMATION_POLICY } from '../../analysis/src/inferred-preference.mjs';
import { canProposeStructure } from '../../structurer/src/policy.mjs';
import { createMemoryService } from '../src/index.mjs';

for (const [timeZone, timestamp, day] of [
  ['Asia/Shanghai', '2026-10-21T23:30:00Z', '2026-10-22'],
  ['America/Los_Angeles', '2026-08-04T03:30:00Z', '2026-08-03'],
]) test(`service timezone reaches episode storage and preference grouping: ${timeZone}`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-calendar-service-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createMemoryService({ dataRoot: root, agentId: 'calendar-agent',
    defaults: { createPrimaryRelationship: false, retrieval: { timeZone } } });
  await service.withRepository(async repository => {
    assert.equal(repository.timeZone, timeZone);
    const source = repository.upsertSource({ agentId: service.agentId, sourceKind: 'conversation',
      externalId: 'local-morning', content: '今天早上讨论过猫咪。', occurredAt: timestamp });
    for (const id of ['morning-a', 'morning-b']) {
      repository.upsertMemory({ id, agentId: service.agentId, kind: 'event', layer: 'episodic',
        content: '早上讨论过猫咪。', subjectRole: 'user', subjectKey: 'user', eventStart: timestamp });
      repository.linkSource(id, source.id, 'evidence');
    }
    repository.upsertMemory({ id: 'episode', agentId: service.agentId, kind: 'episode',
      layer: 'episodic', content: '早上的讨论。' });
    const expanded = repository.expandEpisodeToMemories({ agentId: service.agentId,
      episodeId: 'episode', memoryIds: ['morning-a', 'morning-b'] });
    assert.equal(expanded.event_date, day);
    assert.equal(repository.getMemory('episode').event_date, day, 'The persisted date is local.');
    const snapshot = buildPreferenceEvidenceSnapshot({ repository, agentId: service.agentId,
      subjectRole: 'user', subjectKey: 'user', canonicalKey: 'user:preference:cats', memoryIds: ['morning-a'] });
    assert.equal(snapshot.memories[0].contextId, `day:${day}`);
    const explicit = repository.upsertMemory({ id: 'date-only', agentId: service.agentId, kind: 'event', layer: 'episodic',
      content: '明确日历日期。', eventDate: '2026-10-22' });
    repository.linkSource(explicit.id, source.id, 'evidence');
    const dated = buildPreferenceEvidenceSnapshot({ repository, agentId: service.agentId,
      subjectRole: 'user', subjectKey: 'user', canonicalKey: 'user:preference:cats', memoryIds: [explicit.id] });
    assert.equal(dated.memories[0].contextId, 'day:2026-10-22', 'Date-only labels are not shifted as instants.');
    const structure = await proposeStructuresForBatch({ repository, agentId: service.agentId,
      memoryIds: ['morning-a', 'morning-b'], generator: async () => ({ output: { proposals: [{
        operation: 'create', kind: 'episode', targetMemoryId: '', title: '早上的讨论', content: '早上讨论过猫咪。',
        subjectRole: 'user', subjectKey: 'user', eventDate: null, eventStart: null, eventEnd: null,
        memberIds: ['morning-a', 'morning-b'], actorRoles: [], confidence: 0.95, rationale: '同一场讨论。',
      }] } }) });
    assert.deepEqual(structure.rejected, []);
    assert.equal(structure.proposed.length, 1);
    assert.equal(repository.getMemory(structure.proposed[0].result_memory_id).event_date, day);
    const preview = simulatePreferenceFormation({ timeZone: repository.timeZone,
      subjectRole: 'user', subjectKey: 'user', canonicalKey: 'user:preference:cats',
      policy: DEFAULT_PREFERENCE_FORMATION_POLICY, evidence: [{ memoryId: 'morning-a',
        evidenceGroupId: 'group-a', contextId: `day:${day}`, subjectRole: 'user', subjectKey: 'user',
        eventTime: timestamp, signal: 'explicit_preference', confidence: 0.95 }] });
    assert.equal(preview.evidence[0].day, day);
  });
  assert.equal(service.withRepository(repository => repository.getMemory('episode').event_date, { readOnly: true }), day);
});

test('structure topic evidence counts local dates instead of UTC dates', () => {
  const snapshot = { candidateContainers: [], currentMemories: [
    { id: 'a', knownAt: '2026-10-21T23:30:00Z' },
    { id: 'b', knownAt: '2026-10-22T08:00:00Z' },
  ] };
  assert.equal(canProposeStructure(snapshot, { timeZone: 'Asia/Shanghai' }), false);
  assert.equal(canProposeStructure(snapshot, { timeZone: 'UTC' }), true);
});
