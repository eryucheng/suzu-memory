import { LONG_TERM_EXTRACTION_SCHEMA, LONG_TERM_EXTRACTION_REPAIR_SCHEMA,
  parseGeneratedExtractionRepair } from '@suzu-memory/extraction';
import { assertEventSourceExecutionCurrent, DEFAULT_MEMORY_TIME_ZONE } from '@suzu-memory/core';

const MAXIMUM_REPAIR_ATTEMPTS = 3;
const clean = value => String(value ?? '').trim();

function extractionRepairLanguageInstruction(messages = []) {
  const references = messages.map(message => ({ ref: clean(message.memoryRef),
    language: clean(message.sourceLanguage).toLowerCase() }))
    .filter(item => item.ref && ['zh', 'en', 'mixed'].includes(item.language));
  if (!references.length) return [];
  return [
    "Preserve each candidate's source language while repairing it.",
    'If every sourceRef is zh, write title, content, and stateLabel in Chinese. If every sourceRef is en, write them in English. Use mixed wording only when the direct sources are mixed.',
    `Source-language map: ${references.map(item => `${item.ref}=${item.language}`).join(', ')}.`,
  ];
}

function repairMessages(state) {
  const available = new Set(state.messages.map(message => message.memoryRef));
  const all = state.candidates.some(item => !Array.isArray(item.candidate?.sourceRefs)
    || !item.candidate.sourceRefs.length || item.candidate.sourceRefs.some(ref => !available.has(ref)));
  const refs = new Set(state.candidates.flatMap(item => item.candidate?.sourceRefs || []));
  return state.messages.filter(message => all || refs.has(message.memoryRef));
}

export async function repairExtractionCandidates({ state, generator, sourceMaterial }) {
  const timeZone = state.timeZone || DEFAULT_MEMORY_TIME_ZONE;
  let pending = state.candidates.map(item => ({ ...item }));
  const repaired = [], rejected = [], failures = [], generations = [];
  let returnedCount = 0, recoveredCount = 0;
  for (let attempt = 0; attempt < MAXIMUM_REPAIR_ATTEMPTS && pending.length; attempt++) {
    const messages = repairMessages({ ...state, candidates: pending });
    const requested = new Map(pending.map(item => [item.index, item]));
    let response;
    try {
      response = await generator({
        input: JSON.stringify({ timeZone, candidates: pending.map(item => {
          const branch = LONG_TERM_EXTRACTION_SCHEMA.properties.memories.items.anyOf
            .find(schema => schema.properties.stateFamily.enum.includes(item.candidate?.stateFamily));
          return { candidateIndex: item.index, candidate: item.candidate,
            ...(Object.hasOwn(item, 'rawOutput') ? { rawOutput: item.rawOutput } : {}),
            validationError: item.reason, ...(branch ? { familyContract: {
              kind: branch.properties.kind, stateTarget: branch.properties.stateTarget ?? false } } : {}) };
        }), sourceMessages: messages.map(message => ({ ref: message.memoryRef,
          speaker: message.speaker, role: message.role, timestamp: message.timestamp, text: message.text })),
        participants: state.participants.map(person => ({ name: person.name, role: person.actorRole })),
        }),
        systemPrompt: [
          'Correct each supplied memory candidate against its validation error and schema. Return one result for every candidateIndex.',
          'Use repaired with the corrected memory, rejected with a reason only when no supported content remains, or pending with a reason when correction remains unresolved.',
          'Preserve supported facts, people and dates. Correct sourceRefs using only sourceMessages that support the memory. Remove an unsupported detail while retaining the supported experience.',
          'Separate independent facts into distinct memories when needed. When candidate is null, recover the memories from rawOutput.',
          'familyContract identifies the selected branch; stateTarget=false means omit that field. Keep kind, stateFamily and retentionReason compatible.',
          'A concrete experience without a state target remains an event or reflection with stateFamily=not_applicable and empty stateLabel/canonicalKey.',
          ...extractionRepairLanguageInstruction(messages),
        ].join('\n'),
        schema: LONG_TERM_EXTRACTION_REPAIR_SCHEMA,
        schemaName: 'long-term-memory-extraction-repair-v3',
        ...(sourceMaterial ? { sourceMaterial } : {}),
      });
      assertEventSourceExecutionCurrent();
      generations.push(response);
      const output = typeof response.output === 'string' ? JSON.parse(response.output) : response.output;
      if (!output || Object.keys(output).join() !== 'results' || !Array.isArray(output.results)) {
        throw new Error('Extraction repair must contain only a results array.');
      }
      returnedCount += output.results.length;
      const counts = new Map();
      for (const result of output.results) counts.set(result?.candidateIndex, (counts.get(result?.candidateIndex) || 0) + 1);
      const resolved = new Set();
      for (const result of output.results) {
        const item = requested.get(result?.candidateIndex);
        if (!item) {
          failures.push({ index: result?.candidateIndex, stage: 'repair', reason: 'Unrequested candidateIndex.' });
          continue;
        }
        try {
          if (counts.get(item.index) !== 1) throw new Error('Duplicate candidateIndex in repair response.');
          const parsed = parseGeneratedExtractionRepair({ results: [result] }, { messages, timeZone }).results[0];
          if (parsed.status === 'pending') throw new Error(parsed.reason);
          if (parsed.status === 'repaired') {
            const refs = new Set(messages.map(message => message.memoryRef));
            if (parsed.memories.some(memory => memory.sourceRefs.some(ref => !refs.has(ref)))) {
              throw new Error('Repair references a source outside the supplied sourceMessages.');
            }
            repaired.push(...parsed.memories);
            recoveredCount++;
          } else rejected.push({ index: item.index, reason: parsed.reason });
          resolved.add(item.index);
        } catch (error) {
          item.reason = clean(error.message);
          failures.push({ index: item.index, stage: 'repair', reason: item.reason });
        }
      }
      pending = pending.filter(item => !resolved.has(item.index));
      for (const item of pending) if (!counts.has(item.index)) {
        item.reason = 'Repair response omitted this candidateIndex.';
        failures.push({ index: item.index, stage: 'repair', reason: item.reason });
      }
    } catch (error) {
      assertEventSourceExecutionCurrent();
      if (!response) generations.push({ usage: error.usage, durationMs: error.durationMs, metadata: error.metadata });
      if (error.code === 'MAX_TOKENS') {
        error.repairGenerations = generations;
        throw error;
      }
      pending = pending.map(item => ({ ...item, reason: clean(error.message) }));
      failures.push({ stage: 'repair', reason: clean(error.message) });
      // Transport providers already apply their own retry policy.
      if (!response) break;
    }
  }
  return { memories: repaired, recoveredCount,
    rejected, failures, returnedCount, generations,
    state: pending.length ? { candidates: pending, messages: repairMessages({ ...state, candidates: pending }),
      participants: state.participants, timeZone } : null };
}
