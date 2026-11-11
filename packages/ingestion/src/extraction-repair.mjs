import { LONG_TERM_EXTRACTION_REPAIR_SCHEMA, normalizeGeneratedLongTermExtraction, extractionEntityScope, resolveExtractionSpeaker,
  parseGeneratedExtractionRepair, parseExtractionEntities } from '@suzu-memory/extraction';
import { assertEventSourceExecutionCurrent, DEFAULT_MEMORY_TIME_ZONE, sourceCalendarTimeKnown } from '@suzu-memory/core';

const MAXIMUM_REPAIR_ATTEMPTS = 3;
const clean = value => String(value ?? '').trim();

function extractionRepairLanguageInstruction(messages = []) {
  const references = messages.map(message => ({ ref: clean(message.memoryRef),
    language: clean(message.sourceLanguage).toLowerCase() }))
    .filter(item => item.ref && ['zh', 'en', 'mixed'].includes(item.language));
  if (!references.length) return [];
  return [
    "Preserve each candidate's source language while repairing it.",
    'If every sourceRef is zh, write title, content, and classification.label in Chinese. If every sourceRef is en, write them in English. Use mixed wording only when the direct sources are mixed.',
    `Source-language map: ${references.map(item => `${item.ref}=${item.language}`).join(', ')}.`,
  ];
}

function repairMessages(state) {
  const byRef = new Map(state.messages.map(message => [message.memoryRef, message]));
  const all = state.candidates.some(item => !Array.isArray(item.candidate?.sourceRefs)
    || !item.candidate.sourceRefs.length || item.candidate.sourceRefs.some(ref => !byRef.has(ref)));
  if (all) return state.messages;
  const windows = new Set(state.candidates.flatMap(item => item.candidate.sourceRefs)
    .map(ref => byRef.get(ref).archiveWindowId || ''));
  return state.messages.filter(message => windows.has(message.archiveWindowId || ''));
}

function repairContextWindows(state, messages) {
  const ids = new Set(messages.map(message => message.archiveWindowId || ''));
  return (state.contextWindows || []).filter(window => ids.has(window.id));
}

export async function repairExtractionCandidates({ state, generator, sourceMaterial }) {
  const timeZone = state.timeZone || DEFAULT_MEMORY_TIME_ZONE;
  // Persisted repair tasks may predate participant references. Assign them
  // locally so resuming a task uses the same current model contract.
  const participants = state.participants.map((person, index) => ({ ...person,
    ref: person.ref || `P${index + 1}`, displayName: person.displayName || person.name }));
  const sourceMessage = (message, includeRef = true) => ({
    ...(includeRef ? { ref: message.memoryRef, ...(message.archiveWindowLabel ? { window: message.archiveWindowLabel } : {}) } : {}),
    speaker: resolveExtractionSpeaker(message, participants)?.ref || message.speaker,
    timestamp: message.timestamp,
    ...(message.knownAt && message.knownAt !== message.occurredAt
      && sourceCalendarTimeKnown({ ...message, metadata: message.sourceMetadata || message.metadata }) ? { knownAt: message.knownAt } : {}),
    ...(message.worldFrame || message.worldId ? { world: { frame: message.worldFrame || 'unknown', id: message.worldId || 'primary' } } : {}),
    text: message.text,
  });
  const declarations = new Map(parseExtractionEntities(state.entities).map(entity => [entity.ref, entity]));
  const entityScope = state.entityScope || extractionEntityScope(state.messages);
  let pending = state.candidates.map(item => ({ ...item }));
  const repaired = [], rejected = [], failures = [], generations = [];
  let returnedCount = 0, recoveredCount = 0;
  for (let attempt = 0; attempt < MAXIMUM_REPAIR_ATTEMPTS && pending.length; attempt++) {
    const messages = repairMessages({ ...state, candidates: pending });
    const contextWindows = repairContextWindows(state, messages);
    const requested = new Map(pending.map(item => [item.index, item]));
    let response;
    try {
      response = await generator({
        input: JSON.stringify({ timeZone, memoryOwner: participants.find(person => person.actorRole === 'agent')?.ref || '',
          ...(declarations.size ? { entities: [...declarations.values()] } : {}),
          candidates: pending.map(item => ({ candidateIndex: item.index, candidate: item.candidate,
            ...(Object.hasOwn(item, 'rawOutput') ? { rawOutput: item.rawOutput } : {}), validationError: item.reason })),
          sourceMessages: messages.map(message => sourceMessage(message)),
          ...(contextWindows.length ? { contextWindows: contextWindows.map(window => ({ window: window.label,
            previousContextMessages: window.previousContextMessages.map(message => sourceMessage(message, false)),
            continuationGuidanceMessages: window.continuationGuidanceMessages.map(message => sourceMessage(message, false)),
          })) } : {}),
          participants: participants.map(person => ({ ref: person.ref, name: person.displayName })),
        }),
        systemPrompt: [
          'Correct each supplied memory candidate against its validation error and schema. Return one result for every candidateIndex.',
          'Use repaired with the corrected memory, rejected with a reason only when no supported content remains, or pending with a reason when correction remains unresolved.',
          'Preserve supported facts, people and dates. Correct sourceRefs using only sourceMessages that support the memory. Remove an unsupported detail while retaining the supported experience.',
          'Separate independent facts into distinct memories when needed. When candidate is null, recover the memories from rawOutput.',
          'Keep known people as P references. Declare other named people, places, organizations, objects, works, animals and concepts once in entities with E references; memories use entityRefs for relevant declarations. Preserve supplied E references for the same objects; use unused E references for new objects. Include the entity table used by repaired memories.',
          'Use the category matching the supported content. A concrete experience is an event; a stated reflection is a reflection.',
          'Resolve references with the read-only contextWindows; sourceRefs identify supporting sourceMessages.',
          ...extractionRepairLanguageInstruction(messages),
        ].join('\n'),
        schema: LONG_TERM_EXTRACTION_REPAIR_SCHEMA,
        schemaName: 'long-term-memory-extraction-repair-v5',
        ...(sourceMaterial ? { sourceMaterial } : {}),
      });
      assertEventSourceExecutionCurrent();
      generations.push(response);
      const output = typeof response.output === 'string' ? JSON.parse(response.output) : response.output;
      if (!output || Object.keys(output).some(key => !['results', 'entities'].includes(key)) || !Array.isArray(output.results)) {
        throw new Error('Extraction repair requires a results array and optional entities.');
      }
      const responseEntities = parseExtractionEntities(output.entities);
      const entities = [...new Map([...declarations, ...responseEntities.map(entity => [entity.ref, entity])]).values()];
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
          const parsed = parseGeneratedExtractionRepair({ entities, results: [result] }, { messages, timeZone }).results[0];
          if (parsed.status === 'pending') throw new Error(parsed.reason);
          if (parsed.status === 'repaired') {
            const refs = new Set(messages.map(message => message.memoryRef));
            if (parsed.memories.some(memory => memory.sourceRefs.some(ref => !refs.has(ref)))) {
              throw new Error('Repair references a source outside the supplied sourceMessages.');
            }
            const memories = normalizeGeneratedLongTermExtraction({ entities, memories: parsed.memories }, { messages, timeZone, participants, entityScope }).memories;
            const usedEntities = memories.flatMap(memory => memory.entityMentions || []);
            for (const entity of usedEntities) {
              const known = declarations.get(entity.ref);
              if (known && known.kind !== entity.kind) {
                throw new Error(`Entity ${entity.ref} has type ${known.kind}; use a new reference for a different type.`);
              }
            }
            for (const entity of usedEntities) declarations.set(entity.ref, entity);
            repaired.push(...memories);
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
      if (!response) generations.push({ ...(error.model ? { model: error.model, requestId: error.requestId } : {}),
        usage: error.usage, durationMs: error.durationMs, metadata: error.metadata });
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
  const pendingMessages = pending.length ? repairMessages({ ...state, candidates: pending }) : [];
  const pendingContexts = repairContextWindows(state, pendingMessages);
  return { memories: repaired, recoveredCount,
    rejected, failures, returnedCount, generations,
    state: pending.length ? { candidates: pending, entityScope, ...(declarations.size ? { entities: [...declarations.values()] } : {}), messages: pendingMessages,
      ...(pendingContexts.length ? { contextWindows: pendingContexts } : {}), participants, timeZone } : null };
}
