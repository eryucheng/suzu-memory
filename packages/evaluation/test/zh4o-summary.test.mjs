import assert from "node:assert/strict";
import test from "node:test";
import { aggregateZh4oReports, ZH4O_SYSTEM_PROTOCOL_VERSION } from "../src/index.mjs";

function report(sampleId, correct, total) {
  return { protocol: { version: ZH4O_SYSTEM_PROTOCOL_VERSION }, dataset: { sha256: "same-dataset" },
    run: { configSha256: "same-config", overrides: {}, control: "no-memory", codeRevision: { commit: "same" } },
    samples: [{ sampleId, memorySystemDegraded: false, preparation: { configSha256: 'original-config',
      codeRevision: { commit: 'build', dirty: false }, withoutEmbedding: false } }], results: Array.from({ length: total }, (_, index) => ({
      questionId: `${sampleId}:${index}`, sampleId, status: "completed", scoringEligible: true,
      answerFormat: "choice", category: 1, correct: index < correct,
      control: { status: "completed", correct: false },
    })) };
}

test("Node aggregation weights individual eligible questions and rejects duplicate or incompatible runs", () => {
  const first = report("first", 2, 2), second = report("second", 0, 8);
  const summary = aggregateZh4oReports([first, second]);
  assert.equal(summary.scores.exactChoiceAccuracy, 0.2);
  assert.equal(summary.controls.pairedQuestions, 10);
  assert.equal(summary.controls.memoryAccuracy, 0.2);
  assert.throws(() => aggregateZh4oReports([first, first]), /Duplicate sample/);
  second.run.configSha256 = "different";
  assert.throws(() => aggregateZh4oReports([first, second]), /different datasets, configurations/);
});

test("aggregation requires one original preparation configuration even after retrieval-only reruns", () => {
  const first = report('first', 1, 1), second = report('second', 1, 1);
  assert.equal(aggregateZh4oReports([first, second]).preparation.configSha256, 'original-config');
  second.samples[0].preparation.configSha256 = 'different-ingestion';
  assert.throws(() => aggregateZh4oReports([first, second]), /original memory preparation configurations/);
  assert.throws(() => aggregateZh4oReports([{ ...first, samples: [...first.samples, ...second.samples] }]), /original memory preparation configurations/);
  delete second.samples[0].preparation.configSha256;
  assert.throws(() => aggregateZh4oReports([first, second]), /Missing original memory preparation/);
  assert.throws(() => aggregateZh4oReports([second]), /Missing original memory preparation/);
});

test('original preparation overrides, code and dirty content remain distinct after a common query rerun', () => {
  for (const change of [
    value => { value.withoutEmbedding = true; },
    value => { value.codeRevision.commit = 'another-build'; },
    value => { value.codeRevision = { commit: 'build', dirty: true, workingTreeHash: 'different-content' }; },
  ]) {
    const first = report('first', 1, 1), second = report('second', 1, 1);
    change(second.samples[0].preparation);
    assert.throws(() => aggregateZh4oReports([first, second]), /original memory preparation configurations/);
  }
  const first = report('first', 1, 1), second = report('second', 1, 1);
  first.samples[0].preparation.codeRevision = { commit: 'build', dirty: true };
  assert.throws(() => aggregateZh4oReports([first, second]), /code identity/);
});

test('aggregation includes question failures in strict accuracy and labels partial runs incomplete', () => {
  const first = report('first', 1, 2), second = report('second', 1, 1);
  first.results[1] = { ...first.results[1], status: 'failed', correct: false };
  first.status = 'aborted';
  first.diagnostics = { notRunQuestions: 3 };
  const summary = aggregateZh4oReports([first, second]);
  assert.equal(summary.status, 'incomplete');
  assert.equal(summary.notRunQuestions, 3);
  assert.equal(summary.scores.exactChoiceAccuracy, 2 / 3);
  assert.equal(summary.scores.completedChoiceAccuracy, 1);
  assert.equal(summary.scores.failures, 1);
  assert.equal(summary.degradedSamples, 0);
});
