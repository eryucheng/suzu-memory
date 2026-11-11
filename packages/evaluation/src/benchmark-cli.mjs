#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { runMemoryBenchmark, loadMemoryBenchmarkDataset } from './benchmark.mjs';
import { createMemoryBenchmarkProgress, openMemoryBenchmarkProgress } from './benchmark-progress.mjs';

export function memoryBenchmarkUsage() {
  return `suzu-memory-benchmark --dataset <dataset.json> --config <memory.json> --output <run-directory>
  [--concurrency 3] [--maximum-searches 6] [--recent-turns 0]
  [--modes memory,no-memory,full-history] [--grader <grader.mjs>]
  [--resume] [--progress | --open-progress] [--allow-no-search]

记忆组默认强制作答前检索。--allow-no-search 显式允许模型不检索。
默认按参考答案精确评分；开放题通过 --grader 接入题库自身的评分规则。
--progress 提供本地进度地址；--open-progress 同时打开进度窗口。
--resume 复用同目录内已完成的答案、记忆库与相同参数，避免重复调用模型。`;
}

export async function runMemoryBenchmarkCli({ args = process.argv.slice(2), stdout = process.stdout,
  environment = process.env, signal, fetchImpl, complete } = {}) {
  const values = {}, switches = new Set(['resume', 'progress', 'open-progress', 'allow-no-search', 'help']);
  const options = new Set(['dataset', 'config', 'output', 'concurrency', 'maximum-searches', 'recent-turns', 'modes', 'grader']);
  for (let index = 0; index < args.length; index++) {
    const key = args[index] === '-h' ? 'help' : args[index].replace(/^--/u, '');
    if (switches.has(key)) values[key] = true;
    else if (options.has(key) && args[index + 1] && !args[index + 1].startsWith('--')) values[key] = args[++index];
    else throw new Error(`Unknown or incomplete option: ${args[index]}`);
  }
  if (values.help) { stdout.write(memoryBenchmarkUsage() + '\n'); return null; }
  for (const key of ['dataset', 'config', 'output']) if (!values[key]) throw new Error(`Missing --${key}.\n${memoryBenchmarkUsage()}`);
  const dataset = loadMemoryBenchmarkDataset(path.resolve(values.dataset));
  const graderPath = values.grader && path.resolve(values.grader);
  const grader = graderPath ? await import(pathToFileURL(graderPath).href) : null;
  if (grader && typeof grader.grade !== 'function') throw new Error('Grader module must export grade.');
  let progress;
  try {
    if (values.progress || values['open-progress']) {
      progress = await createMemoryBenchmarkProgress(); stdout.write(`进度：${progress.url}\n`);
      if (values['open-progress']) openMemoryBenchmarkProgress(progress.url);
    }
    const result = await runMemoryBenchmark({ dataset, config: path.resolve(values.config), outputDirectory: path.resolve(values.output),
      modes: values.modes ? values.modes.split(',') : ['memory'], concurrency: values.concurrency === undefined ? 3 : Number(values.concurrency),
      maximumSearches: values['maximum-searches'] === undefined ? 6 : Number(values['maximum-searches']),
      recentTurns: values['recent-turns'] === undefined ? 0 : Number(values['recent-turns']),
      resume: Boolean(values.resume), requireSearch: !values['allow-no-search'],
      ...(grader ? { grade: grader.grade, graderId: createHash('sha256').update(fs.readFileSync(graderPath)).digest('hex') } : {}),
      environment, signal, fetchImpl, complete, onProgress: event => {
        progress?.update(event);
        if (event.event?.type === 'question' || event.event?.type === 'finished') {
          stdout.write(`${event.summary.finished}/${event.total} · ${event.event.type === 'finished' ? event.status : `${event.event.sampleId}/${event.event.questionId} ${event.event.mode}: ${event.event.status}`}\n`);
        }
      } });
    stdout.write(`报告：${path.join(path.resolve(values.output), 'report.json')}\n`);
    return result;
  } finally { await progress?.close(); }
}

export async function memoryBenchmarkMain() {
  const controller = new AbortController(), stop = () => controller.abort(new Error('Benchmark stopped by user.'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    const result = await runMemoryBenchmarkCli({ signal: controller.signal });
    if (result && (result.status !== 'completed' || result.summary.failures || result.summary.excluded)) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await memoryBenchmarkMain();
