import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = import.meta.dirname;
const read = name => fs.readFileSync(path.join(root, name));
const json = name => JSON.parse(read(name));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = bytes => bytes.toString('utf8').replaceAll('\r\n', '\n');
const args = process.argv.slice(2), options = {};
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--source-root', '--dataset'].includes(args[i]) && args[i + 1], 'Use --source-root <repository> and/or --dataset <locomo10.json>.');
  assert.ok(!Object.hasOwn(options, args[i]), 'Duplicate argument.');
  options[args[i]] = args[i + 1];
}

const expectedFiles = ['README.md', 'summary.json', 'settings.json', 'samples.json', 'questions.jsonl',
  'dataset-source.json', 'source-manifest.json', 'answer-prompt.md', 'judge-prompt.md', 'tool-instruction.md', 'verify.mjs',
  'controls.json', 'controls-questions.jsonl'];
const checksums = new Map();
for (const line of read('SHA256SUMS').toString('utf8').trim().split('\n')) {
  const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9_.-]+)$/u.exec(line);
  assert.ok(match && !checksums.has(match[2]), 'Invalid checksum manifest.');
  checksums.set(match[2], match[1]);
  assert.equal(sha256(read(match[2])), match[1], 'Checksum: ' + match[2]);
}
assert.deepEqual([...checksums.keys()].sort(), expectedFiles.toSorted());
assert.deepEqual(fs.readdirSync(root).sort(), [...expectedFiles, 'SHA256SUMS'].sort(), 'Unexpected public file.');

const summary = json('summary.json'), settings = json('settings.json'), samples = json('samples.json');
const source = json('source-manifest.json'), datasetSource = json('dataset-source.json');
const rows = read('questions.jsonl').toString('utf8').trim().split('\n').map(line => JSON.parse(line));
const ids = new Set(), sampleIds = new Set(samples.map(sample => sample.sampleId));
assert.equal(summary.schemaVersion, 1);
assert.equal(settings.schemaVersion, 1);
assert.equal(sampleIds.size, samples.length);
assert.equal(summary.dataset.samples, samples.length);
assert.equal(summary.dataset.questions, rows.length);
assert.deepEqual(summary.dataset.includedCategories, [1, 2, 3, 4]);
assert.deepEqual(settings.scoring.includedCategories, [1, 2, 3, 4]);
assert.deepEqual(datasetSource.includedCategories, [1, 2, 3, 4]);
assert.deepEqual(datasetSource.excludedCategories, [5]);
assert.equal(settings.scoring.aggregation, 'Question-level micro average');
assert.equal(settings.scoring.executionFailuresCountAsWrong, true);
assert.equal(settings.retrieval.readOnly, true);
assert.equal(sha256(read('answer-prompt.md')), settings.reader.promptSha256);
assert.equal(sha256(read('judge-prompt.md')), settings.judge.promptSha256);

const nonnegative = value => assert.ok(Number.isSafeInteger(value) && value >= 0, 'Expected a nonnegative integer.');
const correct = row => row.status === 'completed' && row.judge.label === 'CORRECT';
for (const row of rows) {
  assert.ok(sampleIds.has(row.sampleId), 'Unknown sample.');
  nonnegative(row.questionIndex);
  const id = row.sampleId + ':' + row.questionIndex;
  assert.ok(!ids.has(id), 'Duplicate question: ' + id); ids.add(id);
  assert.ok([1, 2, 3, 4].includes(row.category));
  assert.ok(['completed', 'failed'].includes(row.status));
  for (const key of ['question', 'goldAnswer', 'prediction']) assert.equal(typeof row[key], 'string');
  if (row.status === 'completed') assert.ok(['CORRECT', 'WRONG'].includes(row.judge.label));
  for (const value of Object.values(row.reader)) nonnegative(value);
  for (const key of ['toolCalls', 'searches', 'disclosedMemories', 'disclosedCharacters']) nonnegative(row.retrieval[key]);
  assert.ok(row.retrieval.searches <= row.retrieval.toolCalls);
  assert.ok(row.retrieval.toolCalls <= settings.retrieval.maximumSearches);
  for (const response of row.retrieval.responses) {
    nonnegative(response.memories); nonnegative(response.characters);
    assert.ok(response.memories <= settings.retrieval.maximumContextMemories, 'Per-search memory limit.');
    assert.ok(response.characters <= settings.retrieval.maximumContextChars, 'Per-search character limit.');
  }
  assert.equal(row.retrieval.disclosedMemories, row.retrieval.responses.reduce((sum, response) => sum + response.memories, 0));
  assert.equal(row.retrieval.disclosedCharacters, row.retrieval.responses.reduce((sum, response) => sum + response.characters, 0));
}
const countCorrect = selected => selected.filter(correct).length;
const countFailed = selected => selected.filter(row => row.status === 'failed').length;
assert.equal(summary.result.correct, countCorrect(rows));
assert.equal(summary.result.failed, countFailed(rows));
assert.equal(summary.result.judged, rows.filter(row => ['CORRECT', 'WRONG'].includes(row.judge.label)).length);
assert.equal(summary.result.accuracy, countCorrect(rows) / rows.length);
for (const id of [1, 2, 3, 4]) {
  const selected = rows.filter(row => row.category === id), published = summary.byCategory[id];
  assert.equal(published.questions, selected.length);
  assert.equal(published.correct, countCorrect(selected));
  assert.equal(published.accuracy, countCorrect(selected) / selected.length);
}
for (const sample of samples) {
  const selected = rows.filter(row => row.sampleId === sample.sampleId);
  assert.equal(sample.questions, selected.length);
  assert.equal(sample.correct, countCorrect(selected));
  assert.equal(sample.failed, countFailed(selected));
  assert.equal(sample.accuracy, countCorrect(selected) / selected.length);
  for (const id of [1, 2, 3, 4]) {
    const category = selected.filter(row => row.category === id);
    assert.equal(sample.byCategory[id].questions, category.length);
    assert.equal(sample.byCategory[id].correct, countCorrect(category));
  }
}
for (const key of Object.keys(summary.preparation)) {
  assert.equal(summary.preparation[key], samples.reduce((sum, sample) => sum + sample.preparation[key], 0));
}
for (const key of ['inputTokens', 'outputTokens', 'requests']) {
  assert.equal(summary.readerUsage[key], rows.reduce((sum, row) => sum + row.reader[key], 0));
}
assert.equal(summary.readerUsage.meanInputTokensPerQuestion, summary.readerUsage.inputTokens / rows.length);
assert.equal(summary.readerUsage.meanOutputTokensPerQuestion, summary.readerUsage.outputTokens / rows.length);
assert.equal(summary.retrievalUsage.searches, rows.reduce((sum, row) => sum + row.retrieval.searches, 0));
assert.equal(summary.retrievalUsage.meanDisclosedMemoriesPerQuestion, rows.reduce((sum, row) => sum + row.retrieval.disclosedMemories, 0) / rows.length);
assert.equal(summary.retrievalUsage.meanDisclosedCharactersPerQuestion, rows.reduce((sum, row) => sum + row.retrieval.disclosedCharacters, 0) / rows.length);
assert.equal(summary.completeness.failedQuestions, countFailed(rows));
assert.equal(summary.completeness.excludedSamples, 0);
assert.equal(summary.completeness.unrunQuestions, 0);
assert.equal(settings.scoring.allSamplesIncluded, true);
assert.equal(source.algorithm, 'sha256-path-nul-lf-normalized-v1');
assert.equal(summary.code.algorithm, source.algorithm);
assert.equal(summary.code.sha256, source.sha256);
assert.equal(summary.code.files, source.files.length);

// Matched controls answer the same questions directly with the same answer and judge templates.
const controls = json('controls.json'), controlGroups = ['noHistory', 'fullDialogue'];
const controlRows = read('controls-questions.jsonl').toString('utf8').trim().split('\n').map(line => JSON.parse(line));
const memoryRows = new Map(rows.map(row => [row.sampleId + ':' + row.questionIndex, row])), controlIds = new Set();
const controlCorrect = (row, group) => row[group].status === 'completed' && row[group].judge.label === 'CORRECT';
assert.equal(controls.schemaVersion, 1);
assert.equal(controls.policy.requestsPerQuestion, 1);
assert.equal(controls.policy.model, settings.generation.model);
assert.equal(controls.policy.answerPromptSha256, settings.reader.promptSha256);
assert.equal(controls.policy.judgePromptSha256, settings.judge.promptSha256);
assert.equal(controls.policy.datasetSha256, datasetSource.sha256);
assert.equal(controlRows.length, rows.length);
for (const row of controlRows) {
  const id = row.sampleId + ':' + row.questionIndex, memory = memoryRows.get(id);
  assert.ok(memory && !controlIds.has(id), 'Unknown or duplicate control question: ' + id); controlIds.add(id);
  assert.equal(row.category, memory.category);
  for (const group of controlGroups) {
    const result = row[group];
    assert.ok(['completed', 'failed'].includes(result.status));
    assert.equal(typeof result.prediction, 'string');
    if (result.status === 'completed') assert.ok(['CORRECT', 'WRONG'].includes(result.judge.label));
    for (const value of Object.values(result.reader)) nonnegative(value);
    assert.equal(result.reader.requests, 1, 'Controls answer with one request.');
    assert.ok(result.reader.cachedInputTokens <= result.reader.inputTokens);
  }
}
for (const group of controlGroups) {
  const published = controls.groups[group], selectedCorrect = selected => selected.filter(row => controlCorrect(row, group)).length;
  assert.equal(published.questions, controlRows.length);
  assert.equal(published.correct, selectedCorrect(controlRows));
  assert.equal(published.failed, controlRows.filter(row => row[group].status === 'failed').length);
  assert.equal(published.accuracy, published.correct / controlRows.length);
  for (const key of ['requests', 'inputTokens', 'outputTokens', 'cachedInputTokens']) {
    assert.equal(published[key], controlRows.reduce((sum, row) => sum + row[group].reader[key], 0));
  }
  for (const id of [1, 2, 3, 4]) {
    const selected = controlRows.filter(row => row.category === id);
    assert.deepEqual(controls.byCategory[id][group], { questions: selected.length, correct: selectedCorrect(selected) });
  }
  assert.deepEqual(controls.bySample.map(sample => sample.sampleId), samples.map(sample => sample.sampleId));
  for (const sample of controls.bySample) {
    const selected = controlRows.filter(row => row.sampleId === sample.sampleId);
    assert.deepEqual(sample[group], { questions: selected.length, correct: selectedCorrect(selected) });
  }
  const paired = { bothCorrect: 0, memoryOnlyCorrect: 0, controlOnlyCorrect: 0, bothWrong: 0 };
  for (const row of controlRows) {
    const memory = correct(memoryRows.get(row.sampleId + ':' + row.questionIndex)), control = controlCorrect(row, group);
    paired[memory && control ? 'bothCorrect' : memory ? 'memoryOnlyCorrect' : control ? 'controlOnlyCorrect' : 'bothWrong']++;
  }
  assert.deepEqual(controls.paired[group], paired);
}

let sourceChecked = false, datasetChecked = false;
if (options['--source-root']) {
  const sourceRoot = path.resolve(options['--source-root']), digest = createHash('sha256'), seen = new Set();
  for (const file of source.files) {
    assert.ok(/^(?:packages\/|scripts\/|package(?:-lock)?\.json$)/u.test(file.path));
    const absolute = path.resolve(sourceRoot, file.path);
    assert.ok(absolute.startsWith(sourceRoot + path.sep), 'Source path must stay inside the repository.');
    assert.ok(!seen.has(file.path)); seen.add(file.path);
    const bytes = canonical(fs.readFileSync(absolute));
    assert.equal(sha256(bytes), file.sha256, 'Evaluated source: ' + file.path);
    digest.update('\0').update(file.path).update('\0').update(bytes);
  }
  assert.equal(digest.digest('hex'), source.sha256, 'Evaluated source fingerprint.');
  sourceChecked = true;
}
if (options['--dataset']) {
  const bytes = fs.readFileSync(path.resolve(options['--dataset']));
  assert.equal(sha256(bytes), datasetSource.sha256, 'Dataset SHA-256.');
  const dataset = JSON.parse(bytes);
  assert.equal(dataset.length, samples.length);
  let expectedQuestions = 0, excluded = 0;
  for (const sample of samples) {
    const original = dataset[sample.sampleIndex];
    assert.ok(original);
    assert.equal(original.sample_id, sample.sampleId);
    const expected = original.qa.map((qa, index) => ({ qa, index })).filter(({ qa }) => qa.category !== 5);
    assert.deepEqual(rows.filter(row => row.sampleId === sample.sampleId).map(row => row.questionIndex), expected.map(({ index }) => index));
    expectedQuestions += expected.length;
    excluded += original.qa.filter(qa => qa.category === 5).length;
  }
  assert.equal(expectedQuestions, rows.length);
  assert.equal(excluded, datasetSource.excludedQuestions);
  for (const row of rows) {
    const sample = samples.find(sample => sample.sampleId === row.sampleId), qa = dataset[sample.sampleIndex].qa[row.questionIndex];
    assert.equal(row.question, qa.question); assert.equal(row.goldAnswer, String(qa.answer)); assert.equal(row.category, qa.category);
  }
  datasetChecked = true;
}
console.log(JSON.stringify({ status: 'verified', samples: samples.length, questions: rows.length,
  correct: summary.result.correct, failed: summary.result.failed, accuracy: summary.result.accuracy,
  readerInputTokens: summary.readerUsage.inputTokens,
  controls: Object.fromEntries(controlGroups.map(group => [group, controls.groups[group].accuracy])),
  sourceChecked, datasetChecked, modelCalls: 0 }, null, 2));
