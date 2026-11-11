import http from 'node:http';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

/** Read queue counters and the running organization checkpoint, without loading conversation history. */
export function readMemoryBenchmarkPreparation(memory) {
  const status = memory.maintenanceStatus({ limit: 1 });
  const inputEvents = memory.listInputEvents({ statuses: ['pending', 'processing'], limit: 1 }).total;
  const consolidation = status.consolidationRuns?.running ? memory.withRepository((repository, database) => {
    const row = database.prepare(`WITH running AS (
      SELECT id, metadata_json FROM memory_consolidation_runs
      WHERE agent_id = ? AND status = 'running' LIMIT 1)
      SELECT SUM(CASE WHEN part.key IS NOT NULL AND json_extract(part.value, '$.status') != 'partitioned' THEN 1 ELSE 0 END) AS total,
        SUM(CASE WHEN json_extract(part.value, '$.status') = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN json_extract(part.value, '$.status') = 'blocked' THEN 1 ELSE 0 END) AS blocked
      FROM running LEFT JOIN json_each(running.metadata_json, '$.organizationProgress.parts') part
      GROUP BY running.id`).get(memory.agentId);
    return row ? { total: row.total, completed: row.completed, blocked: row.blocked } : null;
  }, { readOnly: true }) : null;
  return { observedAt: new Date().toISOString(), ...status.work,
    ...(consolidation ? { operation: 'memory-consolidation-combined-v1' } : {}),
    pending: { inputEvents, ...status.work.pending }, consolidation };
}

/** Local, token-gated viewer. SSE updates never reload the page. */
export async function createMemoryBenchmarkProgress({ initial = null } = {}) {
  const token = randomBytes(24).toString('hex'), clients = new Set();
  let latest = initial;
  const page = fs.readFileSync(new URL('./benchmark-progress.html', import.meta.url));
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (request.headers.host !== `127.0.0.1:${server.address()?.port}` || url.searchParams.get('token') !== token) {
      response.writeHead(403).end('Forbidden'); return;
    }
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    if (url.pathname === '/') { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(page); return; }
    if (url.pathname !== '/events') { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
    response.write(': connected\n\n');
    clients.add(response);
    if (latest) response.write(`data: ${JSON.stringify(latest)}\n\n`);
    request.on('close', () => clients.delete(response));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/?token=${token}`, port,
    update(value) {
      latest = value;
      for (const client of clients) {
        // A suspended viewer must not accumulate an unbounded stream buffer.
        if (!client.write(`data: ${JSON.stringify(value)}\n\n`)) { client.end(); clients.delete(client); }
      }
    },
    async close() {
      for (const client of clients) client.end();
      clients.clear();
      await new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeIdleConnections();
      });
    },
  };
}

/** Call only after the user explicitly selects --open-progress. */
export function openMemoryBenchmarkProgress(url) {
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); child.unref();
}
