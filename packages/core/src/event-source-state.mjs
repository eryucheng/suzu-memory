import { eventSourceError, normalizeEventSourceScope, sourceHash, sourceSnapshot } from './event-source-contract.mjs';

export function guardSourceEpoch(database, assertExecution = () => {}) {
  const epoch = database.prepare("SELECT value FROM memory_meta WHERE key='event-source-epoch'");
  const current = () => Number(epoch.get()?.value || 0);
  let observed = current();
  const assert = () => { assertExecution(); if (current() !== observed) throw eventSourceError('EVENT_SOURCE_EPOCH_CHANGED', 'Source cleanup invalidated this repository execution.'); };
  const write = sql => /\b(?:INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP)\s/iu.test(sql);
  const guarded = new Proxy(database, { get(target, key) {
    if (key === 'prepare') return sql => {
      const statement = target.prepare(sql);
      if (!write(sql)) return statement;
      return new Proxy(statement, { get(item, method) {
        if (['run', 'get', 'all', 'iterate'].includes(method)) return (...args) => { assert(); return item[method](...args); };
        const value = item[method]; return typeof value === 'function' ? value.bind(item) : value;
      } });
    };
    if (key === 'exec') return sql => { if (write(sql)) assert(); return target.exec(sql); };
    const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  return { database: guarded, assert, refresh: () => { observed = current(); }, current,
    checkpoint: () => observed, restore: value => { observed = value; } };
}

const stateRow = (repository, scope) => repository.database.prepare(
  'SELECT * FROM memory_event_source_scopes WHERE agent_id=? AND owner=?').get(scope.agentId, scope.owner);
export function eventSourceState(repository, { agentId, owner }) {
  const row = stateRow(repository, { agentId, owner });
  return { agentId, owner, clears: JSON.parse(row?.clears_json || '[]'),
    consumedThroughSequence: row?.consumed_through_sequence || 0, revision: row?.revision || 0,
    ...(row?.experience_scope_json ? { experienceScope: JSON.parse(row.experience_scope_json),consumedThroughExperienceSequence: row.consumed_through_experience_sequence } : {}) };
}
export function assertEventSourceScope(repository, value, agentId) {
  const scope = normalizeEventSourceScope(value, agentId);
  const state = eventSourceState(repository, scope);
  if (scope.version===2 || state.experienceScope) {
    const fence = state.experienceScope;
    if (scope.version!==2 || (fence && (fence.agentGeneration!==scope.agentGeneration || fence.contentRevision>scope.contentRevision
      || fence.clearedThroughExperienceSequence>scope.clearedThroughExperienceSequence))) {
      throw eventSourceError('EVENT_SOURCE_SCOPE_STALE','The experience source scope predates its committed fence.');
    }
    return scope;
  }
  if (state.clears.some(clear => !scope.clears.some(item => item.spaceId === clear.spaceId && item.throughSequence >= clear.throughSequence))) {
    throw eventSourceError('EVENT_SOURCE_SCOPE_STALE', 'The requested source scope predates a committed cleanup fence.');
  }
  return scope;
}
export function advanceEventSourceEpoch(repository) {
  repository.database.prepare(`INSERT INTO memory_meta(key,value) VALUES('event-source-epoch','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT)`).run();
  repository.sourceEpoch.refresh();
}
export function observeEventSourceScope(repository, value, agentId) {
  const scope = assertEventSourceScope(repository, value, agentId);
  const state = eventSourceState(repository, scope);
  if (scope.version===2) {
    const fence = state.experienceScope,changed = !fence || fence.contentRevision!==scope.contentRevision || fence.clearedThroughExperienceSequence!==scope.clearedThroughExperienceSequence;
    repository.database.prepare(`INSERT INTO memory_event_source_scopes(agent_id,owner,clears_json,revision,experience_scope_json)
      VALUES(?,?,'[]',?,?) ON CONFLICT(agent_id,owner) DO UPDATE SET experience_scope_json=excluded.experience_scope_json,revision=excluded.revision`)
      .run(agentId,scope.owner,state.revision+Number(changed),JSON.stringify(scope));
    if (changed) advanceEventSourceEpoch(repository);
    return scope;
  }
  const changed = sourceHash(state.clears) !== sourceHash(scope.clears);
  repository.database.prepare(`INSERT INTO memory_event_source_scopes(agent_id,owner,clears_json,revision)
    VALUES(?,?,?,?) ON CONFLICT(agent_id,owner) DO UPDATE SET clears_json=excluded.clears_json, revision=excluded.revision`)
    .run(agentId, scope.owner, JSON.stringify(scope.clears), state.revision + Number(changed));
  if (changed) {
    advanceEventSourceEpoch(repository);
  }
  return scope;
}
export function recordEventSourceConsumption(repository, scope) {
  if (scope.version===2) {
    repository.database.prepare(`UPDATE memory_event_source_scopes SET consumed_through_experience_sequence=MAX(consumed_through_experience_sequence,?)
      WHERE agent_id=? AND owner=?`).run(scope.experienceUpperBound,scope.agentId,scope.owner);
    return eventSourceState(repository,scope);
  }
  repository.database.prepare(`UPDATE memory_event_source_scopes SET consumed_through_sequence=MAX(consumed_through_sequence,?)
    WHERE agent_id=? AND owner=?`).run(scope.eventUpperBound, scope.agentId, scope.owner);
  return eventSourceState(repository, scope);
}
export function getEventSourceCleanup(repository, agentId, id) {
  const row = repository.database.prepare('SELECT * FROM memory_event_source_cleanups WHERE agent_id=? AND id=?').get(agentId, id);
  return row ? { id: row.id, agentId, owner: row.owner, requestHash: row.request_hash, scope: JSON.parse(row.scope_json),
    phase: row.phase, result: JSON.parse(row.result_json), complete: row.phase === 'complete' } : null;
}
export function beginEventSourceCleanup(repository, { agentId, id, scope: value }) {
  if (typeof id !== 'string' || !id.trim()) throw eventSourceError('EVENT_SOURCE_INVALID', 'Cleanup requires a stable id.');
  const scope = normalizeEventSourceScope(value, agentId);
  const requestHash = sourceHash(scope);
  return repository.transaction(() => {
    const previous = getEventSourceCleanup(repository, agentId, id);
    if (previous) {
      if (previous.requestHash !== requestHash) throw eventSourceError('EVENT_SOURCE_CLEANUP_CONFLICT', 'Cleanup id refers to another scope.');
      return previous;
    }
    observeEventSourceScope(repository, scope, agentId);
    advanceEventSourceEpoch(repository);
    const timestamp = new Date().toISOString();
    repository.database.prepare(`INSERT INTO memory_event_source_cleanups
      (id,agent_id,owner,request_hash,scope_json,phase,created_at,updated_at) VALUES(?,?,?,?,?,'fenced',?,?)`)
      .run(id, agentId, scope.owner, requestHash, JSON.stringify(scope), timestamp, timestamp);
    return getEventSourceCleanup(repository, agentId, id);
  });
}
export function advanceEventSourceCleanup(repository, agentId, id, phase, result = {}) {
  repository.database.prepare('UPDATE memory_event_source_cleanups SET phase=?,result_json=?,updated_at=? WHERE agent_id=? AND id=?')
    .run(phase, JSON.stringify(sourceSnapshot(result)), new Date().toISOString(), agentId, id);
  return getEventSourceCleanup(repository, agentId, id);
}
