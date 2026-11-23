import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const modelProvenance = 'event-continuity-v1';
const humanProvenance = 'event-continuity-human-v1';
const provenance = [modelProvenance, humanProvenance];

export function restoreEventContinuityEdges(repository) {
  const affected = repository.database.prepare(`
    SELECT origin.agent_id, origin.id, target.id AS target_id,
      json_extract(origin.metadata_json, '$.eventContinuity') AS decision,
      COALESCE(json_extract(origin.metadata_json, '$.eventContinuityRevision'), 0) AS revision
    FROM memory_nodes origin
    JOIN memory_nodes target ON target.agent_id = origin.agent_id AND target.id <> origin.id
      AND target.id = json_extract(origin.metadata_json, '$.eventContinuity.targetMemoryId')
    LEFT JOIN memory_edges edge ON edge.agent_id = origin.agent_id
      AND edge.from_memory_id = origin.id AND edge.to_memory_id = target.id AND edge.relation = 'same_thread'
    WHERE json_extract(origin.metadata_json, '$.eventContinuity.resolution') = 'matched'
      AND origin.kind = 'event' AND target.kind = 'event'
      AND origin.status IN ('active', 'superseded') AND target.status IN ('active', 'superseded')
      AND origin.layer <> 'provisional' AND target.layer <> 'provisional'
      AND origin.canonical_key <> '' AND origin.canonical_key = target.canonical_key
      AND origin.canonical_key = json_extract(origin.metadata_json, '$.eventIdentityKey')
      AND target.canonical_key = json_extract(target.metadata_json, '$.eventIdentityKey')
      AND memory_worlds_compatible(origin.reality, origin.world_id, origin.world_frame,
        target.reality, target.world_id, target.world_frame) = 1
      AND (edge.id IS NULL OR edge.provenance = 'association-builder-v1')
  `).all();
  const readSources = repository.database.prepare(`
    SELECT link.memory_id, source.id
    FROM memory_sources link JOIN source_records source ON source.id = link.source_id
    WHERE link.memory_id IN (?, ?) AND source.agent_id = ? AND source.lifecycle = 'active'
  `);
  const acceptedReview = repository.database.prepare(`
    SELECT 1 FROM memory_maintenance_tasks review
    WHERE review.agent_id = ? AND review.task_type = 'event-continuity-review' AND review.review_state = 'accepted'
      AND json_extract(review.payload_json, '$.memoryId') = ?
      AND json_extract(review.result_json, '$.contentHash') = ?
      AND COALESCE(json_extract(review.payload_json, '$.revision'), 0) = ?
      AND ? IN (SELECT value FROM json_each(review.payload_json, '$.candidateIds'))
    LIMIT 1
  `);
  for (const row of affected) {
    const { evidenceSourceIds, rationale, contentHash } = JSON.parse(row.decision);
    if (!Array.isArray(evidenceSourceIds) || !evidenceSourceIds.length) continue;
    const evidence = new Set(evidenceSourceIds);
    const links = readSources.all(row.id, row.target_id, row.agent_id).filter(source => evidence.has(source.id));
    if (new Set(links.map(source => source.memory_id)).size !== 2
      || new Set(links.map(source => source.id)).size !== evidence.size) continue;

    const reviewed = acceptedReview.get(row.agent_id, row.id, contentHash || '', row.revision, row.target_id);
    repository.upsertEdge({
      agentId: row.agent_id, fromMemoryId: row.id, toMemoryId: row.target_id, relation: 'same_thread',
      direction: 'directed', weight: 1, confidence: 1, provenance: reviewed ? humanProvenance : modelProvenance,
      metadata: { evidenceSourceIds, rationale },
    });
  }
}

export function eventContinuityFingerprint(repository, agentId, memoryId) {
  const detail = repository.getMemoryDetail(agentId, memoryId);
  if (!detail) return '';
  const memory = detail.memory;
  return hash([
    ...['id', 'kind', 'layer', 'status', 'title', 'content', 'subject_role', 'subject_key', 'reality', 'world_id',
      'world_frame', 'event_date', 'event_start', 'event_end', 'known_at', 'temporal_state'].map(key => memory[key]),
    detail.roles.map(role => [role.role, role.actor_role, role.actor_key]).sort(),
    detail.sources.map(source => [source.id, source.content, source.occurred_at, source.lifecycle]).sort(),
  ]);
}

// Use the existing durable maintenance store; the analysis is complete and its
// uncertain identity decision awaits review, so it must never be claimed again.
export function recordEventContinuityReview(repository, { agentId, memoryId, candidateIds, rationale, contentHash, diagnostics }) {
  const memoryIds = [...new Set([memoryId, ...candidateIds])];
  const fingerprints = Object.fromEntries(memoryIds.map(id => [id, eventContinuityFingerprint(repository, agentId, id)]));
  const revision = Number(repository.getMemory(memoryId)?.metadata?.eventContinuityRevision || 0);
  const task = repository.enqueueMaintenanceTask({ agentId, lane: 'semantic', taskType: 'event-continuity-review',
    payload: { memoryIds, memoryId, candidateIds, fingerprints, revision }, maxAttempts: 1 });
  if (task.wasInserted) repository.database.prepare(`UPDATE memory_maintenance_tasks SET status = 'completed',
    review_state = 'pending', result_json = ?, completed_at = updated_at WHERE agent_id = ? AND id = ?`)
    .run(JSON.stringify({ rationale, contentHash, ...(diagnostics ? { diagnostics } : {}) }), agentId, task.id);
  return repository.getMaintenanceTask(agentId, task.id);
}

export function resolveEventContinuityReview(repository, { agentId, taskId, action, candidateMemoryId = '', actor = 'human', reason = '' }) {
  return repository.transaction(() => {
    const task = repository.getMaintenanceTask(agentId, taskId);
    if (!task || task.task_type !== 'event-continuity-review' || task.review_state !== 'pending') throw new Error('Event continuity is not awaiting review.');
    if (!['accept', 'dismiss'].includes(action)) throw new Error('Unknown event continuity review action.');
    const { memoryId, candidateIds, fingerprints } = task.payload;
    let memory = repository.getMemory(memoryId);
    if (action === 'accept') {
      if (!candidateIds.includes(candidateMemoryId)) throw new Error('Choose an event from the reviewed candidates.');
      for (const id of [memoryId, candidateMemoryId]) {
        if (!fingerprints[id] || fingerprints[id] !== eventContinuityFingerprint(repository, agentId, id)) {
          throw new Error('Event review evidence changed; refresh the association before accepting.');
        }
      }
      const evidenceSourceIds = [...new Set([memoryId, candidateMemoryId].flatMap(id => {
        const detail = repository.getMemoryDetail(agentId, id);
        if (!detail.sources.length || detail.sources.some(source => source.lifecycle !== 'active')) throw new Error('Event review needs active evidence at both endpoints.');
        return detail.sources.map(source => source.id);
      }))];
      memory = repository.bindEventContinuity({ agentId, memoryId, resolution: 'matched', candidateId: candidateMemoryId,
        relation: 'same_thread', contentHash: task.result.contentHash, rationale: reason || task.result.rationale,
        candidateIds, evidenceSourceIds, provenance: humanProvenance });
    } else if (memory && fingerprints[memoryId] === eventContinuityFingerprint(repository, agentId, memoryId)
      && memory.metadata?.eventContinuity?.resolution === 'ambiguous') {
      memory = repository.bindEventContinuity({ agentId, memoryId, resolution: 'new', contentHash: task.result.contentHash,
        rationale: reason || '人工选择保持事件独立。', candidateIds });
    }
    repository.database.prepare(`UPDATE memory_maintenance_tasks SET review_state = ?, reviewed_by = ?, review_note = ?,
      reviewed_at = ?, updated_at = ? WHERE agent_id = ? AND id = ? AND review_state = 'pending'`)
      .run(action === 'accept' ? 'accepted' : 'dismissed', actor, reason, new Date().toISOString(), new Date().toISOString(), agentId, task.id);
    return { status: action === 'accept' ? 'accepted' : 'dismissed', memory, task: repository.getMaintenanceTask(agentId, task.id) };
  });
}

export function invalidateEventContinuity(repository, { agentId, memoryId, sourceIds, reason = '事件材料已修改，原关联判断失效。' }) {
  const memory = repository.getMemory(memoryId);
  if (!memory || memory.agent_id !== agentId) return [];
  return repository.transaction(() => {
    const changedSources = sourceIds && new Set(sourceIds);
    const affectedEvidence = evidence => !changedSources || memory.status === 'deleted'
      || !evidence?.length || evidence.some(id => changedSources.has(id));
    const edges = repository.database.prepare(`SELECT * FROM memory_edges WHERE agent_id = ?
      AND provenance IN (?, ?) AND (from_memory_id = ? OR to_memory_id = ?)`)
      .all(agentId, ...provenance, memoryId, memoryId)
      .filter(edge => affectedEvidence(JSON.parse(edge.metadata_json).evidenceSourceIds));
    const affected = new Set(edges.map(edge => edge.from_memory_id));
    if (affectedEvidence(memory.metadata?.eventContinuity?.evidenceSourceIds)) affected.add(memoryId);
    const reviews = repository.database.prepare(`SELECT payload_json FROM memory_maintenance_tasks
      WHERE agent_id = ? AND task_type = 'event-continuity-review' AND review_state = 'pending'
        AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.memoryIds') WHERE value = ?)`)
      .all(agentId, memoryId);
    for (const review of reviews) affected.add(JSON.parse(review.payload_json).memoryId);
    if (!affected.size) return [];
    const group = memory.metadata?.eventIdentityKey
      ? repository.database.prepare(`SELECT id FROM memory_nodes WHERE agent_id = ?
          AND json_extract(metadata_json, '$.eventIdentityKey') = ? ORDER BY rowid`).all(agentId, memory.metadata.eventIdentityKey).map(row => row.id)
      : [memoryId];
    repository.database.prepare(`DELETE FROM memory_edges WHERE agent_id = ?
      AND id IN (SELECT value FROM json_each(?))`).run(agentId, JSON.stringify(edges.map(edge => edge.id)));
    const remaining = repository.database.prepare(`SELECT from_memory_id, to_memory_id FROM memory_edges WHERE agent_id = ?
      AND provenance IN (?, ?) AND relation = 'same_thread'`).all(agentId, ...provenance);
    const unvisited = new Set(group);
    for (const root of group) {
      if (!unvisited.has(root)) continue;
      const component = [root]; unvisited.delete(root);
      for (let index = 0; index < component.length; index++) for (const edge of remaining) {
        const next = edge.from_memory_id === component[index] ? edge.to_memory_id : edge.to_memory_id === component[index] ? edge.from_memory_id : null;
        if (unvisited.delete(next)) component.push(next);
      }
      const key = `event-${createHash('sha256').update(['event', agentId, root].join('\u001f')).digest('hex').slice(0, 24)}`;
      for (const id of component) {
        const node = repository.getMemory(id);
        const metadata = { ...node.metadata, eventIdentityKey: key };
        const timestamp = new Date(Math.max(Date.now(), Date.parse(node.updated_at) + 1)).toISOString();
        repository.database.prepare('UPDATE memory_nodes SET canonical_key = ?, metadata_json = ?, updated_at = ? WHERE agent_id = ? AND id = ?')
          .run(key, JSON.stringify(metadata), timestamp, agentId, id);
        repository.syncSearch(id);
      }
    }
    // An ambiguous decision has no edge yet, so its owner can be outside the
    // edited event's identity component. It still needs fresh candidate analysis.
    for (const id of affected) {
      const node = repository.getMemory(id);
      if (!node || node.agent_id !== agentId) continue;
      const metadata = { ...node.metadata, eventContinuityRevision: Number(node.metadata?.eventContinuityRevision || 0) + 1 };
      delete metadata.eventContinuity;
      const timestamp = new Date(Math.max(Date.now(), Date.parse(node.updated_at) + 1)).toISOString();
      repository.database.prepare('UPDATE memory_nodes SET metadata_json = ?, updated_at = ? WHERE agent_id = ? AND id = ?')
        .run(JSON.stringify(metadata), timestamp, agentId, id);
    }
    repository.database.prepare(`UPDATE memory_maintenance_tasks SET review_state = 'dismissed', reviewed_by = 'system:memory-invalidation',
      review_note = ?, reviewed_at = ?, updated_at = ?
      WHERE agent_id = ? AND task_type = 'event-continuity-review' AND review_state = 'pending'
        AND EXISTS (SELECT 1 FROM json_each(payload_json, '$.memoryIds') WHERE value = ?)`)
      .run(reason, new Date().toISOString(), new Date().toISOString(), agentId, memoryId);
    return [...affected];
  });
}
