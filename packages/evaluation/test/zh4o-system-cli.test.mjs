import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  memoryZh4oSystemUsage,
  runMemoryZh4oSystemCli,
} from "../src/zh4o-system-cli.mjs";

function outputSink() {
  let value = "";
  return {
    stream: { write(chunk) { value += chunk; } },
    value() { return value; },
  };
}

function fixture(t) {
  const base = path.join(os.tmpdir(), "Codex", "zh4o-cli-tests");
  fs.mkdirSync(base, { recursive: true });
  const directory = fs.mkdtempSync(path.join(base, "case-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dataset = path.join(directory, "dataset.json"), config = path.join(directory, "config.json");
  fs.writeFileSync(dataset, JSON.stringify([{ sample_id: "cli", conversation: { speaker_a: "甲", speaker_b: "乙",
    session_1: [{ speaker: "乙", dia_id: "S1:1", text: "开始。" }] },
    qa: [{ question: "选哪项？A 甲 B 乙 C 丙 D 丁", answer: "A", category: 1 }] }]));
  fs.writeFileSync(config, JSON.stringify({ agentId: "original", defaults: { ingestion: { maximumCoreCharacters: 4321 },
    retrieval: { maximumReturnedCandidates: 6 } }, providers: { generation: {
      baseUrl: "https://not-contacted.invalid", model: "from-real-config", apiKeyEnv: "BENCHMARK_KEY" } } }));
  const output = outputSink(), runDirectory = path.join(directory, "run");
  const liveArgs = ["--dataset", dataset, "--config", config, "--work-dir", runDirectory];
  const simulatedRun = { args: liveArgs, environment: { BENCHMARK_KEY: "fixture" },
    stdout: output.stream, stderr: output.stream,
    fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body);
      return Response.json({ model: "from-real-config", choices: [{ message: {
        content: body.messages[0].content.includes("A 到 D") ? '{"choice":"A"}' : '{"memories":[]}',
      } }], usage: {} });
    } };
  return { directory, dataset, config, output, runDirectory, liveArgs, simulatedRun };
}

test("dry-run checks the actual config and required credentials without creating data or exposing secrets", async t => {
  const { output, runDirectory, liveArgs, simulatedRun } = fixture(t);
  const args = [...liveArgs, '--dry-run'];
  const result = await runMemoryZh4oSystemCli({ args, stdout: output.stream,
    environment: { BENCHMARK_KEY: "must-not-print-this" }, fetchImpl: () => { throw new Error("network call"); } });
  assert.equal(result.ingestion.maximumCoreCharacters, 4321);
  assert.equal(result.retrieval.maximumReturnedCandidates, 6);
  assert.equal(result.generationModel, "from-real-config");
  assert.equal(result.answerRequests, 2);
  assert.equal(fs.existsSync(runDirectory), false);
  assert.doesNotMatch(output.value(), /must-not-print-this/);
  await assert.rejects(runMemoryZh4oSystemCli({ args, environment: {}, stdout: output.stream }), /BENCHMARK_KEY/);
  await runMemoryZh4oSystemCli(simulatedRun);
  const original = fs.readFileSync(path.join(runDirectory, "report.json"), "utf8");
  await runMemoryZh4oSystemCli({ ...simulatedRun, args: [...liveArgs, "--retrieval-only"] });
  assert.equal(fs.readFileSync(path.join(runDirectory, "report.json"), "utf8"), original);
  assert.equal(fs.readdirSync(runDirectory).filter(name => /^report\.retrieval-\d+\.json$/u.test(name)).length, 1);
});

test('invalid report destinations are rejected before model calls or sample database creation', async t => {
  const { directory, dataset, runDirectory, liveArgs, simulatedRun } = fixture(t);
  let blockedRequests = 0;
  for (const destination of [directory, path.join(dataset, 'report.json')]) {
    await assert.rejects(runMemoryZh4oSystemCli({ ...simulatedRun,
      args: [...liveArgs, '--output', destination],
      fetchImpl() { blockedRequests++; throw new Error('must reject output before contacting provider'); } }), /directory|report|EISDIR|EEXIST/i);
  }
  assert.equal(blockedRequests, 0);
  assert.equal(fs.existsSync(runDirectory), false);
});

test('an existing report survives until replacement, and a refused run cleans its reservation', async t => {
  const { directory, liveArgs, simulatedRun } = fixture(t);
  const destination = path.join(directory, 'existing.json');
  fs.writeFileSync(destination, 'previous report');
  const options = { ...simulatedRun, args: [...liveArgs, '--output', destination],
    fetchImpl(url, request) {
      assert.equal(fs.readFileSync(destination, 'utf8'), 'previous report');
      return simulatedRun.fetchImpl(url, request);
    } };
  const report = await runMemoryZh4oSystemCli(options);
  const saved = fs.readFileSync(destination, 'utf8');
  assert.deepEqual(JSON.parse(saved), JSON.parse(JSON.stringify(report)));
  await assert.rejects(runMemoryZh4oSystemCli(options), /Sample database exists/);
  assert.equal(fs.readFileSync(destination, 'utf8'), saved);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.pending')), []);
});

test('a destination replacement failure preserves both the previous report and the complete new report', async t => {
  const { directory, liveArgs, simulatedRun } = fixture(t);
  const destination = path.join(directory, 'existing.json');
  fs.writeFileSync(destination, 'previous report');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === destination) throw Object.assign(new Error('destination locked'), { code: 'EPERM' });
    return rename(source, target);
  });
  await assert.rejects(runMemoryZh4oSystemCli({ ...simulatedRun, args: [...liveArgs, '--output', destination] }), /complete report is retained/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'previous report');
  const retained = fs.readdirSync(directory).filter(name => name.endsWith('.pending'));
  assert.equal(retained.length, 1);
  const report = JSON.parse(fs.readFileSync(path.join(directory, retained[0]), 'utf8'));
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0].status, 'completed');
});

test('a checkpoint replacement failure retains the previous report and the last fully written progress', async t => {
  const { directory, dataset, liveArgs, simulatedRun } = fixture(t);
  const data = JSON.parse(fs.readFileSync(dataset, 'utf8'));
  data[0].qa.push({ ...data[0].qa[0], question: '另一题？A 甲 B 乙 C 丙 D 丁' });
  fs.writeFileSync(dataset, JSON.stringify(data));
  const destination = path.join(directory, 'existing.json');
  fs.writeFileSync(destination, 'previous report');
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target.endsWith('.pending') && JSON.parse(fs.readFileSync(source, 'utf8')).results.length >= 2) {
      throw Object.assign(new Error('disk full while checkpointing'), { code: 'ENOSPC' });
    }
    return rename(source, target);
  });
  await assert.rejects(runMemoryZh4oSystemCli({ ...simulatedRun,
    args: [...liveArgs, '--output', destination, '--no-control'] }), /last complete checkpoint is retained/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'previous report');
  const retained = fs.readdirSync(directory).filter(name => name.endsWith('.pending'));
  assert.equal(retained.length, 1);
  const checkpoint = JSON.parse(fs.readFileSync(path.join(directory, retained[0]), 'utf8'));
  assert.equal(checkpoint.status, 'running');
  assert.equal(checkpoint.results.length, 1);
  assert.equal(checkpoint.results[0].status, 'completed');
  assert.equal(checkpoint.diagnostics.notRunQuestions, 1);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.endsWith('.writing')), []);
});

test('the CLI saves an aborted report, exits unsuccessfully and resumes remaining questions', t => {
  const { directory, dataset, config, liveArgs, runDirectory } = fixture(t);
  const data = JSON.parse(fs.readFileSync(dataset, 'utf8'));
  data[0].qa = Array.from({ length: 3 }, (_, index) => ({ ...data[0].qa[0],
    question: `第${index + 1}题：选哪项？A 甲 B 乙 C 丙 D 丁` }));
  fs.writeFileSync(dataset, JSON.stringify(data));
  const preload = path.join(directory, 'fetch-fixture.mjs');
  fs.writeFileSync(preload, `
    globalThis.fetch = async (_url, request) => {
      const body = JSON.parse(request.body);
      const answer = body.messages[0].content.includes('A 到 D');
      if (answer && process.env.SUZU_TEST_AUTH_FAILURE === '1' && body.messages[1].content.includes('第2题')) {
        return Response.json({ error: { message: 'invalid key' } }, { status: 401 });
      }
      return Response.json({ model: body.model, choices: [{ message: {
        content: answer ? '{"choice":"A"}' : '{"memories":[]}'
      } }], usage: { prompt_tokens: 1 } });
    };
  `);
  const cli = path.resolve(import.meta.dirname, '../src/zh4o-system-cli.mjs');
  const args = ['--import', pathToFileURL(preload).href, cli, ...liveArgs, '--no-control'];
  const invoke = (extra, failure) => spawnSync(process.execPath, [...args, ...extra], { encoding: 'utf8',
    env: { ...process.env, BENCHMARK_KEY: 'fixture', SUZU_TEST_AUTH_FAILURE: failure },
    windowsHide: true, timeout: 30000 });
  const first = invoke([], '1');
  assert.equal(first.status, 1, first.stderr);
  assert.equal(JSON.parse(first.stdout).status, 'aborted');
  const reportPath = path.join(runDirectory, 'report.json');
  const aborted = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(aborted.results.length, 2);
  assert.equal(aborted.results[1].error.status, 401);
  const second = invoke(['--resume', reportPath], '0');
  assert.equal(second.status, 1, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, 'completed-with-failures');
  const resumed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(resumed.results.length, 3);
  assert.deepEqual(resumed.results.slice(0, 2), aborted.results);
  assert.equal(resumed.scores.exactChoiceAccuracy, 2 / 3);
  assert.equal(resumed.run.generationUsage.requests, aborted.run.generationUsage.requests + 1);
  assert.equal(resumed.run.resumptions, 1);
  assert.deepEqual(fs.readdirSync(runDirectory).filter(name => name.endsWith('.pending') || name.endsWith('.writing')), []);
  assert.ok(fs.existsSync(config));
});

test("removed extraction tuning switches fail explicitly instead of recreating a benchmark pipeline", async () => {
  await assert.rejects(runMemoryZh4oSystemCli({ args: ["--maximum-events", "50"] }), /不支持选项/);
});

test('CLI full-context controls and single-sample rebuild use the same retained run', async t => {
  const f = fixture(t);
  const args = [...f.liveArgs, '--full-context-control'];
  const dry = await runMemoryZh4oSystemCli({ ...f.simulatedRun, args: [...args, '--dry-run'] });
  assert.equal(dry.answerRequests, 3);
  assert.equal(dry.control, 'both');
  const first = await runMemoryZh4oSystemCli({ ...f.simulatedRun, args });
  assert.equal(first.results[0].fullContextControl.status, 'completed');
  const rebuilt = await runMemoryZh4oSystemCli({ ...f.simulatedRun,
    args: [...args, '--resume', path.join(f.runDirectory, 'report.json'), '--rebuild-sample', 'cli'] });
  assert.equal(rebuilt.results.length, 1);
  assert.notEqual(rebuilt.samples[0].preparationId, first.samples[0].preparationId);
  assert.equal(rebuilt.results[0].fullContextControl.status, 'completed');
  assert.equal(rebuilt.run.rebuilds.length, 1);
});

test('CLI refuses rebuild without resume and conflicting control flags before creating data', async t => {
  const f = fixture(t);
  for (const extra of [['--rebuild-sample', 'cli'], ['--full-context-control', '--no-control'],
    ['--resume', 'not-read.json', '--rebuild-sample', 'cli', '--retrieval-only']]) {
    await assert.rejects(runMemoryZh4oSystemCli({ ...f.simulatedRun, args: [...f.liveArgs, ...extra] }), /cannot be combined|requires --resume/);
  }
  assert.equal(fs.existsSync(f.runDirectory), false);
});

for (const argument of ["--help", "-h"]) {
  test(`ZH-4O CLI ${argument} returns usage without requiring a dataset`, async () => {
    const output = outputSink();
    const result = await runMemoryZh4oSystemCli({
      args: [argument],
      stdout: output.stream,
    });
    assert.equal(result.status, "help");
    assert.equal(result.usage, memoryZh4oSystemUsage());
    assert.match(output.value(), /--dataset <zh4o-data\.json>/u);
  });
}
