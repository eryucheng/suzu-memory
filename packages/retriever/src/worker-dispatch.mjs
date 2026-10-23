import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { Worker, isMainThread } from 'node:worker_threads';
import { openMemoryDatabase } from '@suzu-memory/core';
import { retrieveMemories as retrieveInline } from './retriever.mjs';
import { isGenericQuery } from './query.mjs';

const pools = new Map();
const stopping = new Set();
const slots = new Set();
const MAX_WORKERS = 2;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
function available() { for (const wake of [...slots]) wake(); }
const errorValue = error => ({ name: error.name, message: error.message, code: error.code });
let nextId = 0;

async function stop(pool) {
  if (pool.stopping) return pool.stopping;
  if (pools.get(pool.path) === pool) pools.delete(pool.path);
  clearTimeout(pool.timer);
  pool.stopping = pool.worker.terminate();
  stopping.add(pool);
  try { await pool.stopping; }
  finally { stopping.delete(pool); available(); }
}

function idle(pool) {
  if (pool.jobs.size || pool.reservations) return;
  available();
  pool.worker.unref();
  clearTimeout(pool.timer);
  pool.timer = setTimeout(() => { void stop(pool); }, pool.idleTimeoutMs);
  pool.timer.unref();
}

async function acquire(databasePath, signal, idleTimeoutMs) {
  const key = path.resolve(databasePath);
  if (pools.has(key)) { const pool = pools.get(key); pool.reservations++; pool.idleTimeoutMs = idleTimeoutMs; return pool; }
  while (pools.size + stopping.size >= MAX_WORKERS) {
    signal?.throwIfAborted();
    const unused = [...pools.values()].find(pool => !pool.jobs.size && !pool.reservations);
    if (unused) await stop(unused);
    else await new Promise((resolve, reject) => {
      const cleanup = () => { slots.delete(wake); signal?.removeEventListener('abort', abort); };
      const wake = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      slots.add(wake); signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (pools.has(key)) { const pool = pools.get(key); pool.reservations++; pool.idleTimeoutMs = idleTimeoutMs; return pool; }
  }
  signal?.throwIfAborted();
  const worker = new Worker(new URL('./worker-entry.mjs', import.meta.url));
  const pool = { path: key, worker, jobs: new Map(), reservations: 1, timer: null, idleTimeoutMs };
  pools.set(key, pool);
  worker.on('message', async message => {
    const job = pool.jobs.get(message.id);
    if (!job) return;
    if (message.type === 'embedding') {
      try {
        const value = await job.scope(() => job.embeddingProvider(message.text));
        if (pool.jobs.has(message.id)) worker.postMessage({ type: 'embedding-result', callId: message.callId, value });
      } catch (error) {
        if (pool.jobs.has(message.id)) worker.postMessage({ type: 'embedding-result', callId: message.callId, error: errorValue(error) });
      }
    } else if (message.type === 'result') {
      pool.jobs.delete(message.id); job.cleanup();
      if (message.error) job.reject(Object.assign(new Error(message.error.message), message.error));
      else job.resolve(message.value);
      idle(pool);
    }
  });
  const failed = error => {
    if (pools.get(key) === pool) pools.delete(key);
    clearTimeout(pool.timer);
    for (const job of pool.jobs.values()) { job.cleanup(); job.reject(error); }
    pool.jobs.clear();
    available();
  };
  worker.on('error', failed);
  worker.on('exit', code => failed(new Error(`Memory retrieval worker exited (${code}).`)));
  return pool;
}

export async function closeRetrievalWorker(databasePath) {
  const key = path.resolve(databasePath);
  const pool = pools.get(key);
  if (pool && !pool.jobs.size && !pool.reservations) await stop(pool);
  await Promise.all([...stopping].filter(pool => pool.path === key).map(pool => pool.stopping));
}

export async function closeRetrievalWorkers() {
  await Promise.all([...pools.values()].map(stop));
  await Promise.all([...stopping].map(pool => pool.stopping));
}

export async function retrieveMemories(input = {}) {
  const { embeddingProvider, signal, ...serializable } = input;
  signal?.throwIfAborted();
  const options = input.options || {};
  if (isGenericQuery(input.query, options.genericQueries) && !input.anchorMemoryIds?.length) return retrieveInline(input);
  if (!isMainThread || options.execution === 'inline' || !input.databasePath || input.databasePath === ':memory:') return retrieveInline(input);
  if (options.execution !== 'worker') {
    let database;
    try {
      database = openMemoryDatabase(input.databasePath, { readOnly: true });
      const threshold = Math.max(1, Math.trunc(options.workerThreshold ?? 1000));
      if (!database.prepare(`SELECT 1 FROM memory_nodes WHERE agent_id=? AND status IN ('active','superseded','disputed') LIMIT 1 OFFSET ?`)
        .get(input.agentId, threshold - 1)) return retrieveInline(input);
    } catch { return retrieveInline(input); }
    finally { database?.close(); }
  }
  // Unsupported custom option objects use the established inline contract.
  let clone;
  try { clone = structuredClone(serializable); }
  catch (error) { if (error.name === 'DataCloneError') return retrieveInline(input); throw error; }
  const requestedTimeout = Number(options.workerIdleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout < 0 || requestedTimeout > 30 * 60 * 1000) {
    throw new RangeError('workerIdleTimeoutMs must be between 0 and 1800000.');
  }
  const pool = await acquire(input.databasePath, signal, Math.trunc(requestedTimeout));
  pool.reservations--;
  if (signal?.aborted) { idle(pool); signal.throwIfAborted(); }
  clearTimeout(pool.timer); pool.worker.ref();
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const onAbort = () => {
      const job = pool.jobs.get(id);
      if (!job) return;
      pool.jobs.delete(id); job.cleanup(); reject(signal.reason);
      pool.worker.postMessage({ type: 'cancel', id });
      if (!pool.jobs.size && !pool.reservations) void stop(pool);
    };
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    pool.jobs.set(id, { resolve, reject, cleanup, embeddingProvider, scope: AsyncLocalStorage.snapshot() });
    signal?.addEventListener('abort', onAbort, { once: true });
    pool.worker.postMessage({ type: 'retrieve', id, input: clone, embedding: typeof embeddingProvider === 'function' });
    if (signal?.aborted) onAbort();
  });
}
