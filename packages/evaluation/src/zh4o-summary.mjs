import { ZH4O_SYSTEM_PROTOCOL_VERSION, summarizeZh4oRows, summarizeZh4oControls } from "./zh4o-system.mjs";
import { evaluationPreparationKey } from './code-revision.mjs';
import { summarizeMemoryPreparation } from './zh4o-execution.mjs';

export function aggregateZh4oReports(reports) {
  if (!Array.isArray(reports) || !reports.length) throw new Error("At least one report is required.");
  const first = reports[0], samples = [], results = [], seenSamples = new Set(), seenQuestions = new Set();
  const signature = report => JSON.stringify([report.protocol?.version, report.dataset?.sha256,
    report.run?.configSha256, report.run?.overrides, report.run?.control, report.run?.codeRevision]);
  if (first.protocol?.version !== ZH4O_SYSTEM_PROTOCOL_VERSION) throw new Error("Unsupported evaluation protocol.");
  const preparation = first.samples?.[0]?.preparation;
  const expectedPreparation = evaluationPreparationKey(preparation);
  for (const report of reports) {
    if (signature(report) !== signature(first)) throw new Error("Reports have different datasets, configurations, code or protocols; do not merge their scores.");
    for (const sample of report.samples) {
      if (evaluationPreparationKey(sample.preparation) !== expectedPreparation) {
        throw new Error("Reports have different original memory preparation configurations, overrides or code; do not merge their scores.");
      }
      if (seenSamples.has(sample.sampleId)) throw new Error(`Duplicate sample: ${sample.sampleId}`);
      seenSamples.add(sample.sampleId); samples.push(sample);
    }
    for (const row of report.results) {
      if (seenQuestions.has(row.questionId)) throw new Error(`Duplicate question: ${row.questionId}`);
      seenQuestions.add(row.questionId); results.push(row);
    }
  }
  return { protocol: first.protocol, datasetSha256: first.dataset.sha256,
    preparation,
    reports: reports.length, samples: samples.length,
    status: reports.some(report => ['aborted', 'running', 'incomplete'].includes(report.status)
      || Number(report.diagnostics?.notRunQuestions || 0) > 0) ? 'incomplete'
      : samples.some(sample => sample.memorySystemDegraded) ? 'incomplete'
        : results.some(row => row.status === 'failed') ? 'completed-with-failures' : 'completed',
    notRunQuestions: reports.reduce((sum, report) => sum + Number(report.diagnostics?.notRunQuestions || 0), 0),
    degradedSamples: samples.filter(sample => sample.memorySystemDegraded).length,
    memoryPreparation: summarizeMemoryPreparation(samples),
    scores: summarizeZh4oRows(results), controls: summarizeZh4oControls(results, first.run.control) };
}
