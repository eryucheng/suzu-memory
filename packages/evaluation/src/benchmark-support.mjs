import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AsyncResource } from 'node:async_hooks';
import { benchmarkInteger } from './benchmark-contract.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function createBenchmarkLimiter(concurrency, onChange = () => {}) {
  const maximum = benchmarkInteger(concurrency, 3, 'concurrency');
  let active = 0;
  const queue = [];
  const publish = () => onChange({ active, queued: queue.length, maximum });
  const pump = () => {
    while (active < maximum && queue.length) {
      const job = queue.shift();
      job.signal?.removeEventListener('abort', job.cancel);
      active++;
      publish();
      Promise.resolve().then(() => { job.signal?.throwIfAborted(); return job.operation(); })
        .then(job.resolve, job.reject).finally(() => { active--; publish(); pump(); });
    }
  };
  return (operation, { signal } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const job = { operation: AsyncResource.bind(operation, 'memory-benchmark-limiter'), resolve, reject, signal };
    job.cancel = () => {
      const index = queue.indexOf(job);
      if (index !== -1) { queue.splice(index, 1); reject(signal.reason); publish(); }
    };
    signal?.addEventListener('abort', job.cancel, { once: true });
    queue.push(job);
    pump();
  });
}

export async function mapBenchmarkConcurrent(items, concurrency, operation) {
  let next = 0;
  const results = new Array(items.length);
  const settled = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await operation(items[index], index); }
  }));
  const failed = settled.find(item => item.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

export function benchmarkImplementationHash() {
  const packages = fileURLToPath(new URL('../../', import.meta.url));
  const hash = createHash('sha256');
  const names = ['analysis', 'config', 'core', 'embedding-indexer', 'evaluation', 'extraction', 'host-adapter',
    'ingestion', 'maintenance', 'providers', 'retriever', 'runtime', 'service', 'structurer', 'usage-ledger', 'visualization'];
  for (const name of names) {
    const root = path.join(packages, name);
    for (const file of fs.readdirSync(root, { recursive: true }).filter(file => /^(?:src[\\/]|resources[\\/]|package\.json$)/u.test(file)).sort()) {
      const full = path.join(root, file);
      if (fs.statSync(full).isFile()) hash.update(`${name}/${file.replaceAll('\\', '/')}\0`).update(fs.readFileSync(full));
    }
  }
  return hash.digest('hex');
}

export function benchmarkRedactor(config, environment) {
  const secrets = new Set();
  for (const provider of Object.values(config.providers || {})) {
    if (!provider) continue;
    for (const value of [provider.apiKey, environment[provider.apiKeyEnv], ...Object.values(provider.extraHeaders || {})]) {
      if (typeof value === 'string' && value) secrets.add(value);
    }
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return value => JSON.parse(JSON.stringify(value), (_key, item) => typeof item === 'string'
    ? ordered.reduce((text, secret) => text.split(secret).join('[REDACTED]'), item) : item);
}

export function summarizeMemoryBenchmark(rows, total) {
  const scored = rows.filter(row => ['completed', 'failed'].includes(row.status));
  const summary = { total, finished: rows.length, pending: total - rows.length,
    completed: rows.filter(row => row.status === 'completed').length,
    failures: rows.filter(row => row.status === 'failed').length,
    excluded: rows.filter(row => row.status === 'excluded').length,
    correct: scored.filter(row => row.grade?.correct === true).length, scored: scored.length,
    accuracy: scored.length ? scored.filter(row => row.grade?.correct === true).length / scored.length : null,
    searches: rows.reduce((sum, row) => sum + (row.search?.searches || 0), 0) };
  return { ...summary, byMode: Object.fromEntries([...new Set(rows.map(row => row.mode))].map(mode => {
    const subset = scored.filter(row => row.mode === mode);
    return [mode, { total: rows.filter(row => row.mode === mode).length, scored: subset.length,
      correct: subset.filter(row => row.grade?.correct === true).length,
      failures: subset.filter(row => row.status === 'failed').length,
      accuracy: subset.length ? subset.filter(row => row.grade?.correct === true).length / subset.length : null }];
  })) };
}
