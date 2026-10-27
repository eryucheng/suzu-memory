import assert from 'node:assert/strict';
import test from 'node:test';
import { questionFailure, runQuestionOperation, mergeUsageSummaries, memoryPreparationDiagnostics, summarizeMemoryPreparation } from '../src/zh4o-execution.mjs';
import { summarizeZh4oRows } from '../src/zh4o-system.mjs';

test('question classification separates transient transport failures, fatal credentials and deterministic assertions', () => {
  for (const error of [
    Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
    Object.assign(new Error('request aborted'), { name: 'AbortError' }),
    new Error('Embedding API 请求失败（HTTP 429）：rate limited'),
    new Error('记忆处理 API 请求失败（503）：unavailable'),
  ]) {
    assert.equal(questionFailure(error).retryable, true);
    assert.equal(questionFailure(error).infrastructure, true);
  }
  for (const error of [new Error('记忆处理 API 请求失败（401）：invalid key'),
    new Error('Embedding API 请求失败（HTTP 429）：insufficient_quota'), new Error('余额不足')]) {
    assert.equal(questionFailure(error).fatal, true);
    assert.equal(questionFailure(error).retryable, false);
  }
  for (const error of [Object.assign(new Error('expected no HTTP 503 failures'), { code: 'ERR_ASSERTION' }),
    Object.assign(new Error('invalid choice'), { code: 'ZH4O_INVALID_CHOICE' }), new Error('invalid response shape')]) {
    assert.equal(questionFailure(error).retryable, false);
    assert.equal(questionFailure(error).infrastructure, false);
  }
});

test('retry budgets account for provider attempts instead of nesting three-by-three requests', async () => {
  let calls = 0, reportedAttempts = 0;
  for (const budget of [2, 3]) {
    calls = 0;
    await assert.rejects(runQuestionOperation(() => {
      calls++;
      throw Object.assign(new Error('unavailable'), { transportAttempts: budget, maximumTransportAttempts: budget,
        diagnostics: { status: 503 } });
    }, { delayMs: 0, onAttempts: count => { reportedAttempts = count; } }), /unavailable/);
    assert.equal(calls, 1);
    assert.equal(reportedAttempts, budget);
  }
  calls = 0;
  const result = await runQuestionOperation(() => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    return { output: { choice: 'A' } };
  }, { delayMs: 0 });
  assert.equal(result.output.choice, 'A');
  assert.equal(calls, 3);
});

test('strict accuracy includes failed questions and excludes sample preparation failures', () => {
  const summary = summarizeZh4oRows([
    { status: 'completed', scoringEligible: true, answerFormat: 'choice', category: 1, correct: true },
    { status: 'failed', scoringEligible: true, answerFormat: 'choice', category: 1 },
    { status: 'completed', scoringEligible: true, answerFormat: 'choice', category: 2, correct: false },
    { status: 'failed', scoringEligible: true, answerFormat: 'non-choice-gold', category: 2 },
    { status: 'excluded', scoringEligible: false, answerFormat: 'choice', category: 1 },
  ]);
  assert.equal(summary.eligibleQuestions, 4);
  assert.equal(summary.failures, 2);
  assert.equal(summary.failureRate, 1 / 2);
  assert.equal(summary.officialDatasetAccuracy, 1 / 4);
  assert.equal(summary.validChoiceQuestions, 3);
  assert.equal(summary.exactChoiceAccuracy, 1 / 3);
  assert.equal(summary.completedChoiceAccuracy, 1 / 2);
  assert.equal(summary.byCategory[1].exactChoiceAccuracy, 1 / 2);
  assert.equal(summary.excluded, 1);
});

test('resumed usage preserves prior costs, failures and provider attribution', () => {
  const previous = { requests: 5, failedRequests: 1, byPhase: { memory: 3, answer: 2 }, bySchema: { answer: 2 },
    models: ['old-model'], providers: ['provider'], usage: { prompt_tokens: 20 }, estimatedCostCny: 1.25 };
  const current = { requests: 2, failedRequests: 0, byPhase: { answer: 2 }, bySchema: { answer: 2 },
    models: ['new-model'], providers: ['provider'], usage: { prompt_tokens: 10, completion_tokens: 2 }, estimatedCostCny: 0.5 };
  const merged = mergeUsageSummaries(previous, current);
  assert.equal(merged.requests, 7);
  assert.equal(merged.failedRequests, 1);
  assert.equal(merged.byPhase.memory, 3);
  assert.equal(merged.byPhase.answer, 4);
  assert.equal(merged.bySchema.answer, 4);
  assert.equal(merged.estimatedCostCny, 1.75);
  assert.deepEqual(merged.models, ['old-model', 'new-model']);
  assert.equal(merged.usage.prompt_tokens, 30);
  assert.equal(previous.requests, 5);
  assert.equal(mergeUsageSummaries({ ...previous, estimatedCostCny: null }, current).estimatedCostCny, null);
});

test('memory quality diagnostics retain counts without classifying quarantine, raw fallback or stalled work as outages', () => {
  const diagnostics = memoryPreparationDiagnostics({
    passes: [{ status: 'completed-with-failures', failures: [{ error: { code: 'INVALID_RESPONSE', message: 'invalid model response' } }],
      input: [{ batches: [{ generationDiagnostics: { degraded: true, unresolvedCandidateCount: 2, candidateValidationIncomplete: true } }] }] }],
    inputEvents: [{ processing_disposition: 'quarantined' }],
    finalProgress: { total: 2, failures: 3 }, expectedEvents: 4, mappedEvents: 3,
  });
  assert.deepEqual(diagnostics, { quarantinedMessages: 1, archiveOnlyBatches: 1, failedMaintenancePasses: 1,
    unresolvedExtractionCandidates: 2, incompleteExtractionBatches: 1,
    pendingWork: 2, failedWork: 3, missingInputEvents: 1, infrastructureFailures: [] });
  assert.equal(summarizeMemoryPreparation([{ memoryDiagnostics: diagnostics }, { memoryDiagnostics: diagnostics }]).quarantinedMessages, 2);
});

for (const error of [
  { message: 'HTTP 503 unavailable' }, { message: 'quota exceeded', status: 402 },
  { message: 'socket closed', code: 'ECONNRESET' }, { message: 'request timed out', name: 'AbortError' },
  { errorMessage: 'HTTP 401 invalid key', errorCode: 'PROVIDER_FAILURE' },
]) test(`preparation reuses infrastructure classification: ${error.code || error.errorCode || error.message}`, () => {
  const diagnostics = memoryPreparationDiagnostics({ passes: [{ maintenance: { semantic: { failures: [{ error }] } } }] });
  assert.equal(diagnostics.infrastructureFailures.length, 1);
  assert.equal(diagnostics.infrastructureFailures[0].infrastructure, true);
});

test('nested maintenance result strings retain infrastructure classification and quarantine counts deduplicate fragments', () => {
  const diagnostics = memoryPreparationDiagnostics({
    passes: [{ maintenance: { semantic: { stateAnalysis: { results: [{ error: 'HTTP 503 unavailable' }] } } } }],
    inputEvents: [1, 2].map(id => ({ id, processing_disposition: 'quarantined',
      metadata: { suzuMemoryFragment: { parentEventId: 'original-message' } } })),
  });
  assert.equal(diagnostics.infrastructureFailures[0].status, 503);
  assert.equal(diagnostics.quarantinedMessages, 1);
});
