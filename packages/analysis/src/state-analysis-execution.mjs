import { createHash, randomUUID } from 'node:crypto';
import { assertEventSourceExecutionCurrent, readMemoryInput, withRepositoryWriteGuard } from '@suzu-memory/core';

export const isStateAnalysisExecutionObsolete = error =>
  ['STATE_ANALYSIS_LEASE_LOST', 'STATE_ANALYSIS_INPUT_CHANGED'].includes(error?.code);

function guardedProvider(provider, assertCurrent) {
  if (typeof provider !== 'function') return provider;
  const invoke = async (call, receiver, args) => {
    assertCurrent();
    const generation = await Reflect.apply(call, receiver, args);
    try { assertCurrent(); }
    catch (error) {
      // The provider already did the work. Retain its receipt even though its
      // answer can no longer be committed to the evidence store.
      for (const key of ['usage', 'model', 'requestId', 'durationMs', 'metadata', 'usageReceipts']) {
        if (generation?.[key] !== undefined) error[key] = generation[key];
      }
      throw error;
    }
    return generation;
  };
  return new Proxy(provider, {
    apply: (target, receiver, args) => invoke(target, receiver, args),
    get: (target, key) => key === 'embedMany' && typeof target[key] === 'function'
      ? (...args) => invoke(target[key], target, args) : target[key],
  });
}

async function runClaimed(options, workerId, callback) {
  const { repository, agentId, requestId } = options;
  const request = repository.getStateAnalysisRequest(agentId, requestId);
  const lease = { agentId, requestId, workerId };
  try {
    const read = memoryIds => readMemoryInput(repository, agentId, memoryIds, {
      fields: ['canonical_key', 'state_scope_key', 'valid_from', 'valid_to', 'evidence_mode'],
    });
    const input = read(request.memoryIds);
    let comparison = null;
    const assertCurrent = () => {
      assertEventSourceExecutionCurrent();
      repository.assertStateAnalysisRequestLease(lease);
      if (read(request.memoryIds).hash !== input.hash
        || (comparison && read(comparison.memories.map(item => item.id)).hash !== comparison.hash)) throw Object.assign(
        new Error('State analysis evidence changed while the request was running.'), { code: 'STATE_ANALYSIS_INPUT_CHANGED' });
    };
    return await withRepositoryWriteGuard(repository, assertCurrent, () => callback({ ...options,
      analysisExecution: {
        assertCurrent,
        track: memoryIds => {
          assertCurrent();
          const ids = [...new Set([...(comparison?.memories || []).map(item => item.id), ...memoryIds.filter(Boolean)])];
          if (!comparison || ids.length !== comparison.memories.length) comparison = read(ids);
        },
        finishAnalysis: () => { assertCurrent(); comparison = null; },
        firstStage: (call, snapshot) => {
          assertCurrent();
          // Matching establishes this key itself. The captured extraction key
          // identifies the same work before and after that binding is saved.
          const material = call.schemaName === 'memory-state-match-analysis-v1'
            ? { ...snapshot, target: { ...snapshot.target,
              canonicalKey: request.metadata.originalCanonicalKey || request.canonical_key } } : snapshot;
          const contractHash = createHash('sha256').update(JSON.stringify([
            request.input_hash, material, call.schemaName, call.schema, call.systemPrompt,
            call.sourceMaterial?.sourceScope, input.hash, comparison?.hash,
          ])).digest('hex');
          const previous = repository.getStateAnalysisRequest(agentId, requestId).metadata.firstStage;
          return {
            generation: previous?.version === 1 && previous.contractHash === contractHash
              ? { ...previous.generation, usage: null, costAmount: 0,
                metadata: { ...previous.generation.metadata, firstStageReplayed: true } } : null,
            save: generation => {
              assertCurrent();
              repository.saveStateAnalysisFirstStage({ ...lease, checkpoint: {
                version: 1, contractHash,
                memoryIds: [...new Set([...request.memoryIds, ...(comparison?.memories || []).map(item => item.id)])],
                sourceIds: request.sourceIds,
                generation: { output: generation.output, model: generation.model, requestId: generation.requestId,
                  durationMs: generation.durationMs, metadata: generation.metadata, usage: null, costAmount: 0 },
              } });
            },
          };
        },
      },
      generator: guardedProvider(options.generator, assertCurrent),
      embeddingProvider: guardedProvider(options.embeddingProvider, assertCurrent) }));
  } catch (error) {
    assertEventSourceExecutionCurrent();
    if (!isStateAnalysisExecutionObsolete(error)) throw error;
    return { status: 'deferred', reason: error.code, request: repository.getStateAnalysisRequest(agentId, requestId), proposal: null };
  }
}

// All members settle before releasing any ownership. Each continuation has its
// own write guard; an obsolete member cannot invalidate an unrelated sibling.
export async function withStateAnalysisExecutions(options, requestIds, callback) {
  const { repository, agentId, leaseSeconds = 900 } = options;
  if (!repository) throw new Error('State analysis request processing requires a repository.');
  const workerId = randomUUID();
  const claimed = repository.claimStateAnalysisRequests({ agentId, requestIds, workerId, leaseSeconds });
  if (!claimed) return requestIds.map(requestId => ({ status: 'fulfilled', value: {
    status: 'deferred', reason: 'state-analysis-already-processing',
    request: repository.getStateAnalysisRequest(agentId, requestId), proposal: null,
  } }));
  try {
    return await Promise.allSettled(requestIds.map(requestId => runClaimed({ ...options, requestId }, workerId, callback)));
  } finally {
    // Source cancellation leaves recovery to its fence; a replacement worker's
    // lease must survive late cleanup by this worker.
    try {
      assertEventSourceExecutionCurrent();
      for (const requestId of requestIds) repository.releaseStateAnalysisRequest({ agentId, requestId, workerId });
    } catch (error) {
      if (!['AbortError', 'TimeoutError'].includes(error.name) && !String(error.code || '').startsWith('EVENT_SOURCE_')) throw error;
    }
  }
}

export async function withStateAnalysisExecution(options, callback) {
  if (!options.repository) throw new Error('State analysis request processing requires a repository.');
  const request = options.repository.getStateAnalysisRequest(options.agentId, options.requestId);
  if (!request || request.status !== 'pending') return callback(options);
  const [result] = await withStateAnalysisExecutions(options, [options.requestId], callback);
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
