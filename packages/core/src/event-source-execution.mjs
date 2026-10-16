import { AsyncLocalStorage } from 'node:async_hooks';
import { createEventSourceView } from './event-source-view.mjs';
import { assertEventSourceScope } from './event-source-state.mjs';
import { normalizeEventSourceScope, eventSourceError, sourceSnapshot } from './event-source-contract.mjs';
const executions = new AsyncLocalStorage();
export const currentEventSourceExecution = () => {
  const execution = executions.getStore();
  return execution?.active ? execution : undefined;
};
export function withEventSourceExecution(repository, callback, { sourceScope = null, signal = null } = {}) {
  const sourceScoped = Boolean(repository.database.prepare('SELECT 1 FROM memory_event_source_scopes LIMIT 1').get());
  const parent = currentEventSourceExecution();
  const scope = sourceScope ? normalizeEventSourceScope(sourceScope, sourceScope.agentId) : parent?.sourceScope || null;
  const abortSignal = signal && parent?.signal ? AbortSignal.any([signal, parent.signal]) : signal || parent?.signal;
  const assertCurrent = () => { abortSignal?.throwIfAborted(); repository.sourceEpoch.assert(); };
  assertCurrent();
  if (scope) {
    assertEventSourceScope(repository, scope, scope.agentId);
    assertCurrent();
  }
  const execution = { repository, assertCurrent, sourceScoped, sourceScope: scope, signal: abortSignal, active: true };
  return executions.run(execution, () => {
    try {
      const result = callback();
      if (result && typeof result.then === 'function') return Promise.resolve(result).finally(() => { execution.active = false; });
      execution.active = false;
      return result;
    } catch (error) { execution.active = false; throw error; }
  });
}

/** A fresh view is made at each owner material/claim boundary. It uses the
 * same fixed scope while including already committed in-scope derivatives. */
export function executionEventSourceView(repository, agentId) {
  const execution = currentEventSourceExecution();
  execution?.assertCurrent();
  if (!execution?.sourceScope) return null;
  if (execution.sourceScope.agentId !== agentId) {
    throw eventSourceError('EVENT_SOURCE_AGENT_CONFLICT', 'Execution scope belongs to another Memory Agent.');
  }
  return createEventSourceView(repository, execution.sourceScope, agentId);
}

export function assertEventSourceExecutionCurrent() {
  currentEventSourceExecution()?.assertCurrent();
}

export function eventSourceMaterial(repository, agentId, memoryIds = [], sourceIds = [], inputEventIds = []) {
  const view = executionEventSourceView(repository, agentId);
  if (!view) return null;
  const ids = [...new Set(memoryIds.filter(Boolean))].sort();
  const sources = [...new Set(sourceIds.filter(Boolean))].sort();
  const inputs = [...new Set(inputEventIds.filter(Boolean))].sort();
  if (ids.some(id => !view.memoryIds.has(id)) || sources.some(id => !view.sourceIds.has(id)) || inputs.some(id => !view.inputIds.has(id))) {
    throw eventSourceError('EVENT_SOURCE_MATERIAL_INELIGIBLE', 'Model material includes an ineligible Memory source.');
  }
  const events = [...new Map([...view.sourcesFor(ids), ...view.sourcesForSourceIds(sources), ...view.sourcesForInputIds(inputs)]
    .map(source => [source.eventId, source])).values()].sort((a, b) => a.commitSequence - b.commitSequence);
  return sourceSnapshot({ version: 1, sourceScope: view.scope, memoryIds: ids, sourceIds: sources, inputEventIds: inputs, eventSources: events });
}

export function mergeEventSourceMaterials(materials) {
  const selected = materials.filter(Boolean);
  if (!selected.length) return null;
  const scope = selected[0].sourceScope;
  if (selected.some(item => JSON.stringify(item.sourceScope) !== JSON.stringify(scope))) {
    throw eventSourceError('EVENT_SOURCE_MATERIAL_CONFLICT', 'Combined tasks must retain the same source scope.');
  }
  return sourceSnapshot({ version: 1, sourceScope: scope,
    memoryIds: [...new Set(selected.flatMap(item => item.memoryIds))].sort(),
    sourceIds: [...new Set(selected.flatMap(item => item.sourceIds))].sort(),
    inputEventIds: [...new Set(selected.flatMap(item => item.inputEventIds || []))].sort(),
    eventSources: [...new Map(selected.flatMap(item => item.eventSources).map(source => [source.eventId, source])).values()]
      .sort((a, b) => a.commitSequence - b.commitSequence) });
}
