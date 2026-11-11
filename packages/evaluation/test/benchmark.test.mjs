import { extractionModelFixture } from '../../../test/support/extraction-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createMemoryServiceFromConfig } from '@suzu-memory/config';
import { runMemoryBenchmark as runNativeMemoryBenchmark, normalizeMemoryBenchmarkDataset, createBenchmarkCompletion,
  buildMemoryBenchmarkMessages } from '../src/benchmark.mjs';
import { createMemoryBenchmarkProgress } from '../src/benchmark-progress.mjs';
import { runMemoryBenchmarkCli } from '../src/benchmark-cli.mjs';
import { benchmarkRedactor, createBenchmarkLimiter } from '../src/benchmark-support.mjs';

test('benchmark redaction keeps report types and JSON syntax intact for short or escaped header values', () => {
  const redact = benchmarkRedactor({ providers: { generation: { apiKey: 'secret"\\key',
    extraHeaders: { 'X-Route': '1' } } } }, {});
  const result = redact({ usage: { prompt_tokens: 11 }, success: true, note: 'Credential secret"\\key; route 1', nested: [null, 1] });
  assert.deepEqual(result, { usage: { prompt_tokens: 11 }, success: true,
    note: 'Credential [REDACTED]; route [REDACTED]', nested: [null, 1] });
});

const sha = value => createHash('sha256').update(value).digest('hex');
const now = '2026-10-01T12:00:00.000Z';
const fixture = () => ({ version: 1, name: 'Fixture', answerInstruction: 'Answer A or B.', samples: [{ id: 'first',
  identity: { primaryUserId: 'avery', primaryUserName: 'Avery', companionId: 'robin', companionName: 'Robin' },
  turns: [1, 2, 3].map(n => ({ recordedAt: `2026-10-01T0${n}:00:00.000Z`,
    userMessage: { text: `Cedar picnic ${n}.` }, assistantMessage: { text: `Recorded picnic ${n}.` } })),
  questions: [
    { id: 'q1', question: 'Cedar picnic?', cutoff: 1, now, reference: 'A' },
    { id: 'q2', question: 'Cedar picnic where?', cutoff: 1, now, reference: 'A' },
    { id: 'q3', question: 'Cedar picnic plans?', cutoff: 3, now, reference: 'A' },
  ] }] });
const config = { agentId: 'fixture', providers: { generation: { baseUrl: 'https://generation.test/v1', model: 'fixture-extraction', apiKey: 'fixture-key' } },
  defaults: { retrieval: { maximumContextMemories: 10, maximumContextChars: 2000 } } };
const fixtureFetch = async () => new Response(JSON.stringify({ model: 'fixture-extraction', choices: [{ message: { content: '{"memories":[]}' } }] }));
const runMemoryBenchmark = options => runNativeMemoryBenchmark({ fetchImpl: fixtureFetch, ...options });
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suzu-benchmark-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const searchCall = () => ({ role: 'assistant', content: null, tool_calls: [{ id: 'lookup', type: 'function',
  function: { name: 'suzu_memory_search', arguments: '{"query":"Cedar picnic"}' } }] });
const answer = content => ({ message: { role: 'assistant', content }, usage: { prompt_tokens: 20, completion_tokens: 1 } });

test('checkpoint readers run concurrently without database copies, future history, or gold answers in model input; resume makes no calls', async t => {
  const root = temporary(t), output = path.join(root, 'run'), snapshots = [], ids = [], hashes = new Map();
  let active = 0, peak = 0;
  const dataset = fixture();
  for (const question of dataset.samples[0].questions) question.reference = 'PRIVATE_GOLD';
  const complete = async (messages, options) => {
    assert.ok(!JSON.stringify(messages).includes('PRIVATE_GOLD'));
    const question = messages.at(-1)?.role === 'user';
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 15));
      const state = JSON.parse(fs.readFileSync(path.join(output, 'samples', sha('first'), 'state.json')));
      const memory = createMemoryServiceFromConfig(config, { overrides: {
        dataRoot: path.join(output, 'samples', sha('first'), 'memory'), agentId: 'benchmark', readOnly: true } });
      try {
        const events = memory.listInputEvents({ statuses: [], limit: 100 }).items;
        assert.equal(events.length, state.preparedCutoff * 2);
        assert.equal(memory.defaults.retrieval.maximumContextMemories, 10);
        ids.push(memory.paths.databasePath);
        const hash = sha(fs.readFileSync(memory.paths.databasePath));
        if (hashes.has(state.preparedCutoff)) assert.equal(hash, hashes.get(state.preparedCutoff));
        else hashes.set(state.preparedCutoff, hash);
      } finally { await memory.close(); }
      if (question) { assert.equal(options.toolChoice.function.name, 'suzu_memory_search'); return { message: searchCall() }; }
      return answer('A');
    } finally { active--; }
  };
  const result = await runMemoryBenchmark({ dataset, config, outputDirectory: output, concurrency: 2, complete,
    grade: () => ({ correct: true }), graderId: 'fixture-v1', onProgress: event => snapshots.push(event) });
  assert.equal(result.status, 'completed', JSON.stringify(result.failure));
  assert.equal(result.summary.correct, 3, JSON.stringify(result.rows.map(row => row.failure)));
  assert.equal(peak, 2);
  assert.equal(new Set(ids).size, 1);
  assert.equal(result.rows.reduce((sum, row) => sum + row.search.searches, 0), 3);
  assert.ok(result.rows.every(row => row.search.calls === 1));
  assert.ok(!fs.existsSync(path.join(output, 'snapshots')));
  assert.ok(!fs.existsSync(path.join(output, 'run.lock')));
  assert.ok(snapshots.some(event => event.requests.active === 2));
  assert.ok(snapshots.some(event => event.requests.inFlight.some(request =>
    request.operation === 'long-term-memory-extraction-v4' && Number.isFinite(Date.parse(request.startedAt)))),
  'The viewer must identify the preparation request while it is waiting for the provider.');
  assert.ok(snapshots.some(event => event.active.some(job => job.preparation?.pending.inputEvents > 0)),
    'Imported conversation must not be presented as fully prepared memory.');
  const finalProgress = snapshots.at(-1);
  assert.deepEqual(finalProgress.requests.inFlight, []);
  assert.equal(Object.values(finalProgress.requests.byPhase).reduce((sum, phase) => sum + phase.completed, 0), result.requests.length);
  assert.equal(Object.values(finalProgress.requests.byPhase).reduce((sum, phase) => sum + phase.inputTokens, 0),
    result.requests.reduce((sum, request) => sum + Number(request.usage?.prompt_tokens || 0), 0));
  const resumed = await runMemoryBenchmark({ dataset, config, outputDirectory: output, concurrency: 2, resume: true,
    complete: () => { throw new Error('must not call a model on completed resume'); },
    grade: () => ({ correct: true }), graderId: 'fixture-v1' });
  assert.equal(resumed.summary.correct, 3);
  assert.equal(resumed.requests.length, result.requests.length);
  await assert.rejects(runMemoryBenchmark({ dataset, config, outputDirectory: output, concurrency: 1, resume: true, complete }), /changed/u);
});

test('incremental checkpoints retain extracted memory and send each core source to extraction once', async t => {
  const root = temporary(t), output = path.join(root, 'run'), dataset = fixture(), extracted = [];
  const nativeConfig = { ...config, providers: { generation: { ...config.providers.generation, structuredOutputMode: 'strict-tool' } } };
  dataset.samples[0].questions[1].cutoff = 2;
  dataset.samples[0].questions.push({ ...dataset.samples[0].questions[2], id: 'q4' });
  const report = await runMemoryBenchmark({ dataset, config: nativeConfig, outputDirectory: output,
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body), tool = request.tools?.[0]?.function;
      assert.equal(tool?.name || request.response_format?.json_schema?.name, 'long-term-memory-extraction-v4');
      const sources = [...request.messages.at(-1).content.matchAll(/^\[M\d+\] (.+)$/gmu)].map(match => match[1]);
      assert.ok(sources.length, request.messages.at(-1).content.slice(0, 1600));
      extracted.push(...sources);
      const memories = extracted.length === sources.length ? [{ kind: 'event', title: 'Avery recorded Cedar picnic',
        content: 'Avery recorded Cedar picnic 1.', subjectRole: 'user', subjectName: 'Avery', actorRoles: [],
        canonicalKey: '', stateFamily: 'not_applicable', stateLabel: '', reality: 'real', evidenceMode: 'explicit',
        temporalState: 'current', revisionAction: 'add', eventDate: '', eventStart: '', eventEnd: '', confidence: 0.98, importance: 0.8, sourceRefs: ['M0001'] }] : [];
      const content = JSON.stringify(extractionModelFixture({ memories }));
      return Response.json({ model: request.model, choices: [{ message: { role: 'assistant', content,
        ...(tool ? { tool_calls: [{ type: 'function', function: { name: tool.name, arguments: content } }] } : {}) } }],
      usage: { prompt_tokens: 10, completion_tokens: 10 } });
    }, complete: async messages => messages.at(-1).role === 'tool' ? answer('A') : { message: searchCall() } });
  assert.equal(report.status, 'completed', JSON.stringify(report.failure));
  assert.equal(report.summary.correct, 4, JSON.stringify(report.rows.map(row => row.failure)));
  assert.ok(report.requests.every(row => !row.failure), JSON.stringify(report.requests.filter(row => row.failure).map(row => row.failure.message)));
  assert.equal(extracted.length, 6);
  assert.equal(new Set(extracted).size, 6, 'Previously extracted core sources were sent again.');
  assert.ok(report.rows.every(row => row.retrievals[0].records.some(record => record.text.includes('Cedar picnic 1'))));
  assert.ok(report.requests.filter(row => row.phase === 'maintenance')
    .every(row => row.operation === 'long-term-memory-extraction-v4'));
  assert.ok(!fs.existsSync(path.join(output, 'snapshots')));
  const resumed = await runMemoryBenchmark({ dataset, config: nativeConfig, outputDirectory: output, resume: true,
    fetchImpl: () => { throw new Error('Completed preparation must be reused.'); },
    complete: () => { throw new Error('Completed answers must be reused.'); } });
  assert.equal(resumed.summary.correct, 4);
  assert.equal(resumed.requests.length, report.requests.length);
});

test('grading interruption resumes the saved answer without preparing, retrieving or answering again', async t => {
  for (const mode of ['memory', 'no-memory', 'full-history']) await t.test(mode, async t => {
    const root = temporary(t), output = path.join(root, 'run'), controller = new AbortController(), dataset = fixture();
    dataset.samples[0].questions = dataset.samples[0].questions.slice(0, 1);
    const grade = async ({ answer: value, complete, signal }) => {
      assert.equal(value, 'A');
      const judgment = await complete([{ role: 'user', content: 'Grade the saved answer.' }], { signal });
      return { correct: judgment.message.content === 'correct' };
    };
    const stopped = await runMemoryBenchmark({ dataset, config, outputDirectory: output, modes: [mode],
      grade, graderId: 'resume-grading-v1', signal: controller.signal,
      complete: async messages => {
        if (messages.at(-1).content === 'Grade the saved answer.') {
          controller.abort(new Error('Stopped during grading.')); throw controller.signal.reason;
        }
        return mode === 'memory' && messages.at(-1).role !== 'tool' ? { message: searchCall() } : answer('A');
      } });
    assert.equal(stopped.status, 'aborted');
    assert.equal(stopped.summary.finished, 0);
    const pending = fs.readdirSync(path.join(output, 'responses'));
    assert.equal(pending.length, 1);
    const saved = JSON.parse(fs.readFileSync(path.join(output, 'responses', pending[0]), 'utf8'));
    assert.equal(saved.status, 'answered'); assert.equal(saved.answer, 'A');
    let calls = 0;
    const resumed = await runMemoryBenchmark({ dataset, config, outputDirectory: output, modes: [mode],
      grade, graderId: 'resume-grading-v1', resume: true,
      fetchImpl: () => { throw new Error('Saved answers must not prepare or retrieve again.'); },
      complete: async messages => {
        calls++; assert.equal(messages.at(-1).content, 'Grade the saved answer.'); return answer('correct');
      } });
    assert.equal(resumed.status, 'completed', JSON.stringify(resumed.failure));
    assert.equal(resumed.summary.correct, 1);
    assert.equal(calls, 1);
    assert.equal(resumed.requests.length, stopped.requests.length + 1);
    assert.equal(resumed.requests.at(-1).phase, 'grading');
    assert.equal(resumed.requests.at(-1).operation, 'grading');
    assert.ok(Number.isFinite(Date.parse(resumed.requests.at(-1).at)));
    assert.equal(resumed.rows[0].search?.searches, mode === 'memory' ? 1 : undefined);
    assert.deepEqual(fs.readdirSync(path.join(output, 'responses')), []);
  });
});

test('an unsearched final answer fails only that memory question; controls cannot receive tools', async t => {
  const root = temporary(t), choices = [];
  const dataset = fixture(); dataset.samples[0].questions = dataset.samples[0].questions.slice(0, 1);
  const result = await runMemoryBenchmark({ dataset, config, outputDirectory: path.join(root, 'run'),
    modes: ['memory', 'no-memory', 'full-history'], complete: async (messages, options) => {
      choices.push({ messages, options }); return answer('A');
    } });
  assert.equal(result.summary.failures, 1);
  assert.equal(result.rows.find(row => row.mode === 'memory').failure.code, 'MEMORY_SEARCH_REQUIRED');
  assert.equal(result.rows.find(row => row.mode === 'memory').search.searches, 0);
  assert.equal(result.summary.byMode.memory.accuracy, 0);
  assert.equal(result.summary.byMode['no-memory'].accuracy, 1);
  assert.equal(result.summary.byMode['full-history'].accuracy, 1);
  assert.equal(choices.filter(call => call.options.tools).length, 1);
  assert.equal(choices.find(call => call.messages.length === 2).options.tools, undefined);
});

test('contract rejects future histories and duplicate identities, and never forwards grading metadata to ingestion', () => {
  for (const edit of [
    data => { data.samples[0].questions[0].now = '2026-09-01T00:00:00Z'; },
    data => { data.samples[0].questions[0].cutoff = 4; },
    data => { data.samples[0].turns[0].recordedAt = '2026-10-01T00:00:00'; },
    data => { data.samples[0].questions.push(data.samples[0].questions[0]); },
  ]) { const data = fixture(); edit(data); assert.throws(() => normalizeMemoryBenchmarkDataset(data)); }
  const data = fixture(); data.samples[0].turns[0].metadata = { answer: 'PRIVATE_GOLD' };
  const normalized = normalizeMemoryBenchmarkDataset(data);
  assert.ok(!JSON.stringify(normalized.samples[0].turns).includes('PRIVATE_GOLD'));
  const sample = normalized.samples[0], question = sample.questions[0];
  question.reference = 'UNIQUE_REFERENCE_ONLY_FOR_GRADING';
  for (const mode of ['memory', 'no-memory', 'full-history']) {
    const messages = buildMemoryBenchmarkMessages({ sample, question, mode });
    assert.ok(!JSON.stringify(messages).includes('picnic 2'));
    assert.ok(!JSON.stringify(messages).includes(question.reference));
  }
});

test('completion honors the normalized model settings, uses the shared endpoint, forces first tool choice and cancels retries', async () => {
  const requests = [], connection = { baseUrl: 'https://provider.test/v1/chat/completions', model: 'configured-model',
    apiKey: 'fixture-key', extraHeaders: {}, extraBody: { thinking: { type: 'disabled' }, temperature: 0.4 },
    maxOutputTokens: 24680, timeoutMs: 1000, transportRetryDelayMs: 0 };
  const complete = createBenchmarkCompletion({ providers: { generation: connection } }, { fetchImpl: async (url, request) => {
    assert.equal(url, connection.baseUrl); requests.push(JSON.parse(request.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'A' } }] }));
  } });
  await complete([], { tools: [{ type: 'function', function: { name: 'search' } }], toolChoice: { type: 'function', function: { name: 'search' } } });
  assert.equal(requests[0].model, connection.model); assert.equal(requests[0].max_tokens, 24680);
  assert.deepEqual(requests[0].thinking, { type: 'disabled' }); assert.equal(requests[0].temperature, 0.4);
  assert.equal(requests[0].tool_choice.function.name, 'search');
  const controller = new AbortController(); controller.abort(new Error('user stopped'));
  await assert.rejects(complete([], { signal: controller.signal }), /user stopped/u);
  assert.equal(requests.length, 1);
});

test('limiter caps active requests and immediately drops canceled queued work', async () => {
  const limit = createBenchmarkLimiter(2), controller = new AbortController();
  let active = 0, peak = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const jobs = [1, 2].map(() => limit(async () => { active++; peak = Math.max(peak, active); await gate; active--; }));
  const canceled = limit(() => { throw new Error('queued work started'); }, { signal: controller.signal });
  controller.abort(new Error('canceled')); await assert.rejects(canceled, /canceled/u);
  release(); await Promise.all(jobs); assert.equal(peak, 2); assert.equal(active, 0);
});

test('progress is token-gated, streams changes without page reloads and releases its port', async () => {
  const progress = await createMemoryBenchmarkProgress();
  try {
    assert.equal((await fetch(progress.url.replace(/\?token=.*/u, ''))).status, 403);
    const page = await (await fetch(progress.url)).text();
    assert.match(page, /EventSource/u); assert.ok(!page.includes('location.reload'));
    const stream = await fetch(progress.url.replace('/?', '/events?'));
    const reader = stream.body.getReader();
    await reader.read();
    progress.update({ status: 'completed', summary: { correct: 1 } });
    const update = new TextDecoder().decode((await reader.read()).value);
    assert.match(update, /"correct":1/u); await reader.cancel();
  } finally { await progress.close(); }
  await assert.rejects(fetch(progress.url));
});

test('CLI completes a control run and closes progress service without leaving a lock', async t => {
  const root = temporary(t), file = path.join(root, 'dataset.json'), configuration = path.join(root, 'config.json'), output = [];
  const data = fixture(); data.samples[0].questions = data.samples[0].questions.slice(0, 1);
  fs.writeFileSync(file, JSON.stringify(data)); fs.writeFileSync(configuration, JSON.stringify(config));
  const result = await runMemoryBenchmarkCli({ args: ['--dataset', file, '--config', configuration,
    '--output', path.join(root, 'run'), '--modes', 'no-memory', '--progress'],
    complete: async () => answer('A'), stdout: { write: text => output.push(text) } });
  assert.equal(result.summary.correct, 1);
  const url = output.find(text => text.startsWith('进度：')).trim().slice(3);
  await assert.rejects(fetch(url));
  assert.ok(!fs.existsSync(path.join(root, 'run', 'run.lock')));
});

test('cancellation saves partial usage, leaves the interrupted question pending, and resumes without rebuilding history', async t => {
  const root = temporary(t), output = path.join(root, 'run'), controller = new AbortController();
  const dataset = fixture(); dataset.samples[0].questions = dataset.samples[0].questions.slice(0, 1);
  let first = true;
  const stopped = await runMemoryBenchmark({ dataset, config, outputDirectory: output, signal: controller.signal,
    complete: async () => { if (first) { first = false; controller.abort(new Error('user stopped')); } return { message: searchCall() }; } });
  assert.equal(stopped.status, 'aborted'); assert.equal(stopped.summary.finished, 0); assert.equal(stopped.summary.pending, 1);
  assert.equal(stopped.summary.failures, 0); assert.ok(stopped.requests.length >= 1);
  const stateFile = path.join(output, 'samples', sha('first'), 'state.json');
  const stateBefore = fs.readFileSync(stateFile, 'utf8');
  const resumed = await runMemoryBenchmark({ dataset, config, outputDirectory: output, resume: true,
    complete: async messages => messages.at(-1).role === 'tool' ? answer('A') : { message: searchCall() } });
  assert.equal(resumed.summary.correct, 1); assert.equal(resumed.status, 'completed');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore);
  assert.equal(resumed.requests.length, stopped.requests.length + 2);
});

test('configured vector indexing and query embeddings use the same provider and bounded request transport', async t => {
  const root = temporary(t), dataset = fixture(); dataset.samples[0].questions = dataset.samples[0].questions.slice(0, 2);
  const requests = [];
  const vectorConfig = { ...config, providers: { generation: { baseUrl: 'https://generation.test/v1', model: 'fixture-extraction', apiKey: 'GENERATION_KEY_NOT_EXPORTED' },
    embedding: { baseUrl: 'https://embedding.test/v1', model: 'fixture-vector',
    apiKey: 'DO_NOT_EXPORT_THIS_KEY', dimensions: 3 } } };
  const result = await runMemoryBenchmark({ dataset, config: vectorConfig, outputDirectory: path.join(root, 'run'), concurrency: 2,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      if (body.model === 'fixture-extraction') return new Response(JSON.stringify({ model: body.model,
        choices: [{ message: { content: '{"memories":[]}' } }] }));
      assert.equal(body.model, 'fixture-vector');
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      return new Response(JSON.stringify({ model: body.model,
        data: inputs.map((_, index) => ({ index, embedding: [1, 0, 0] })), usage: { prompt_tokens: 4 } }));
    }, complete: async messages => messages.at(-1).role === 'tool' ? answer('A') : { message: searchCall() } });
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(result.summary.correct, 2, JSON.stringify(result.rows.map(row => row.failure)));
  assert.ok(requests.length >= 2); assert.ok(result.requests.some(request => request.phase === 'query-embedding'), JSON.stringify({ requests: result.requests, vectors: result.rows.map(row => row.retrievals.map(item => item.vector)) }));
  assert.ok(result.rows.every(row => row.retrievals.length === 1));
  assert.ok(result.rows.every(row => row.retrievals[0].vector.status === 'ready'), JSON.stringify(result.rows.map(row => row.retrievals[0].vector)));
  assert.ok(!JSON.stringify(result).includes('DO_NOT_EXPORT_THIS_KEY'));
});

test('invalid grading data fails preflight before writing data or calling models', async t => {
  const root = temporary(t), output = path.join(root, 'run'), dataset = fixture();
  delete dataset.samples[0].questions[0].reference;
  await assert.rejects(runMemoryBenchmark({ dataset, config, outputDirectory: output, complete: () => { throw new Error('must not call'); } }), /reference/u);
  assert.ok(!fs.existsSync(output));
  await assert.rejects(runMemoryBenchmark({ dataset: fixture(), config: { agentId: 'missing-generator' }, outputDirectory: output,
    complete: () => { throw new Error('must not call'); } }), /Generation provider is required/u);
  assert.ok(!fs.existsSync(output));
});

test('concurrent runs cannot overwrite the directory manifest or start a second model call', async t => {
  const root = temporary(t), output = path.join(root, 'run'), dataset = fixture();
  dataset.samples[0].questions = dataset.samples[0].questions.slice(0, 1);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const first = runMemoryBenchmark({ dataset, config, outputDirectory: output, modes: ['no-memory'],
    complete: async () => { entered(); await gate; return answer('A'); } });
  await started;
  try {
    const manifest = fs.readFileSync(path.join(output, 'run.json'), 'utf8');
    await assert.rejects(runMemoryBenchmark({ dataset, config, outputDirectory: output, modes: ['no-memory'], resume: true,
      complete: () => { throw new Error('second run started a model'); } }), /locked/u);
    assert.equal(fs.readFileSync(path.join(output, 'run.json'), 'utf8'), manifest);
  } finally { release(); }
  assert.equal((await first).summary.correct, 1);
  assert.ok(!fs.existsSync(path.join(output, 'run.lock')));
});

test('deep output directories can create and reopen the native SQLite library', async t => {
  const root = temporary(t), output = path.join(root, 'nested-' + 'x'.repeat(65)), dataset = fixture();
  dataset.samples[0].questions = dataset.samples[0].questions.slice(0, 1);
  const report = await runMemoryBenchmark({ dataset, config, outputDirectory: output,
    complete: async messages => messages.at(-1).role === 'tool' ? answer('A') : { message: searchCall() } });
  assert.equal(report.status, 'completed', JSON.stringify(report.failure));
  assert.equal(report.summary.correct, 1, JSON.stringify(report.rows.map(row => row.failure)));
});
