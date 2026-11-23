import { LONG_TERM_EXTRACTION_REPAIR_SCHEMA, LONG_TERM_EXTRACTION_REPAIR_MODEL_SCHEMA,
  inspectGeneratedLongTermExtraction, extractionEntityScope, extractionEntityDeclarationsFor, resolveExtractionSpeaker,
  parseExtractionRepairResultEnvelope, parseExtractionEntities, extractionOutputLanguage,
  extractionContextLanguage } from '@suzu-memory/extraction';
import { assertEventSourceExecutionCurrent, DEFAULT_MEMORY_TIME_ZONE, sourceCalendarTimeKnown } from '@suzu-memory/core';

const MAXIMUM_REPAIR_ATTEMPTS = 3;
const clean = value => String(value ?? '').trim();

export async function requestExtractionOutput(generator, request) {
  try {
    return { generation: await generator(request) };
  } catch (error) {
    if (error?.code !== 'MEMORY_PROVIDER_INVALID_STRUCTURED_OUTPUT' || !Object.hasOwn(error, 'rawOutput')) throw error;
    const { rawOutput, model, requestId, usage, durationMs, metadata } = error;
    return { generation: { output: rawOutput, model, requestId, usage, durationMs, metadata }, decodeError: error };
  }
}

function memoryDraft(memories, entities) {
  if (entities === undefined || (Array.isArray(entities) && !entities.length)) return { memories };
  return { memories, entities };
}

// Older saved tasks put the candidate directly on the task item.
function repairCandidate(item) {
  const evidenceSourceRefs = item.evidenceSourceRefs ?? item.candidate?.sourceRefs;
  const draft = item.draft ?? (Object.hasOwn(item, 'rawOutput')
    ? { rawOutput: item.rawOutput }
    : memoryDraft([item.candidate], item.entities));
  return {
    index: item.index,
    evidenceSourceRefs: Array.isArray(evidenceSourceRefs) ? evidenceSourceRefs : [],
    draft,
    reason: item.reason,
    ...(item.responseFeedback ? { responseFeedback: item.responseFeedback } : {}),
  };
}

function repairSourceWindows(candidates, messages) {
  const windowByRef = new Map(messages.map(message => [message.memoryRef, clean(message.archiveWindowId)]));
  const allWindows = [...new Set(windowByRef.values())];
  return new Map(candidates.map(item => {
    const windows = [...new Set(item.evidenceSourceRefs.filter(ref => windowByRef.has(ref)).map(ref => windowByRef.get(ref)))];
    // The initial references set the boundary. A draft can change across attempts.
    return [item.index, windows.length ? windows : allWindows];
  }));
}

function nextRepairDraft(item, memories, suppliedEntities, inputEntities) {
  const updates = extractionEntityDeclarationsFor(memories, suppliedEntities);
  if (!Array.isArray(updates)) return memoryDraft(memories, updates);
  const previous = extractionEntityDeclarationsFor(memories, item.draft.entities, inputEntities);
  if (!Array.isArray(previous)) return memoryDraft(memories, updates.length ? updates : previous);
  const suppliedRefs = new Set(updates.map(entity => entity.ref));
  return memoryDraft(memories, [
    ...previous.filter(entity => !suppliedRefs.has(entity.ref)),
    ...updates,
  ]);
}

export function selectCurrentRepairCandidates(state, { evidence, scoped }) {
  const originalRefs = new Set(state.messages.map(message => message.memoryRef));
  const available = [], deferred = [], rejected = [];
  for (const value of state.candidates) {
    const item = repairCandidate(value);
    const original = item.evidenceSourceRefs.filter(ref => originalRefs.has(ref));
    let outsideScope = false;
    const keep = refs => {
      const known = (Array.isArray(refs) ? refs : []).filter(ref => originalRefs.has(ref));
      const required = known.length ? known : original.length ? original : [...originalRefs];
      if (!required.length || required.some(ref => !evidence.has(ref))) return false;
      outsideScope ||= required.some(ref => !scoped.has(ref));
      return true;
    };
    if (Array.isArray(item.draft.memories)) {
      const memories = item.draft.memories.filter(memory => keep(memory?.sourceRefs));
      if (memories.length !== item.draft.memories.length) rejected.push({ index: item.index, reason: 'Original source changed or was withdrawn.' });
      if (!memories.length) continue;
      if (memories.length !== item.draft.memories.length) {
        const entities = extractionEntityDeclarationsFor(memories, item.draft.entities);
        item.draft = { memories, ...(Array.isArray(entities) && !entities.length ? {} : { entities }) };
      }
    } else if (!keep(original)) {
      rejected.push({ index: item.index, reason: 'Original source changed or was withdrawn.' });
      continue;
    }
    item.evidenceSourceRefs = original.filter(ref => evidence.has(ref));
    if (!item.evidenceSourceRefs.length && item.draft.memories) {
      item.evidenceSourceRefs = [...new Set(item.draft.memories.flatMap(memory => memory?.sourceRefs || []))].filter(ref => evidence.has(ref));
    }
    (outsideScope ? deferred : available).push(item);
  }
  return { available, deferred, rejected };
}

export async function repairExtractionCandidates({ state, generator, sourceMaterial, sourceIsCurrent, contextIsCurrent,
  resumeSavedDrafts = false }) {
  const timeZone = state.timeZone || DEFAULT_MEMORY_TIME_ZONE;
  const windowLanguages = new Map([...Map.groupBy(state.messages, message => clean(message.archiveWindowId))]
    .map(([id, messages]) => [id, extractionContextLanguage(messages)]));
  const sources = state.messages.map(message => {
    const outputLanguage = windowLanguages.get(clean(message.archiveWindowId));
    return message.outputLanguage === outputLanguage ? message : { ...message, outputLanguage };
  });
  // Persisted repair tasks may predate participant references. Assign them
  // locally so resuming a task uses the same current model contract.
  const participants = state.participants.map((person, index) => ({ ...person,
    ref: person.ref || `P${index + 1}`, displayName: person.displayName || person.name }));
  const sourceMessage = (message, { includeRef = true, includeWindow = false } = {}) => ({
    ...(includeRef ? { ref: message.memoryRef } : {}),
    ...(includeWindow && message.archiveWindowLabel ? { window: message.archiveWindowLabel } : {}),
    speaker: resolveExtractionSpeaker(message, participants)?.ref || message.speaker,
    timestamp: message.timestamp,
    ...(message.knownAt && message.knownAt !== message.occurredAt
      && sourceCalendarTimeKnown({ ...message, metadata: message.sourceMetadata || message.metadata }) ? { knownAt: message.knownAt } : {}),
    ...(message.worldFrame || message.worldId ? { world: { frame: message.worldFrame || 'unknown', id: message.worldId || 'primary' } } : {}),
    text: message.text,
  });
  const declarations = new Map(parseExtractionEntities(state.entities).map(entity => [entity.ref, entity]));
  const entityScope = state.entityScope || extractionEntityScope(sources);
  const candidates = state.candidates.map(repairCandidate);
  const pending = new Map(candidates.map(item => [item.index, item]));
  const windowsByIndex = repairSourceWindows(candidates, sources);
  const labels = new Map(sources.filter(message => message.archiveWindowLabel)
    .map(message => [clean(message.archiveWindowId), message.archiveWindowLabel]));
  const selectMaterial = items => {
    const windows = new Set(items.flatMap(item => windowsByIndex.get(item.index)));
    return {
      messages: sources.filter(message => windows.has(clean(message.archiveWindowId)) && (!sourceIsCurrent || sourceIsCurrent(message))),
      contextWindows: (state.contextWindows || []).filter(window => windows.has(clean(window.id))).flatMap(window => {
        if (!contextIsCurrent) return [window];
        const previousContextMessages = window.previousContextMessages.filter(contextIsCurrent);
        const continuationGuidanceMessages = window.continuationGuidanceMessages.filter(contextIsCurrent);
        return previousContextMessages.length || continuationGuidanceMessages.length
          ? [{ ...window, previousContextMessages, continuationGuidanceMessages }] : [];
      }),
    };
  };
  const repaired = [], rejected = [], failures = [], requestFailures = [], generations = [];
  const recordCandidateFailure = (item, reason, field = 'responseFeedback') => {
    item[field] = reason;
    failures.push({ index: item.index, stage: 'repair', reason });
  };
  let returnedCount = 0, recoveredCount = 0;
  let sourceInvalidated = false;
  const resolveDraft = item => {
    const { messages } = selectMaterial([item]);
    const { output, failures, validationError } = inspectGeneratedLongTermExtraction(item.draft,
      { messages, timeZone, participants, entityScope, allowTimeEvidence: true }, declarations);
    if (!output) return validationError;
    const { memories } = output;
    const confirmedEntities = memories.flatMap(memory => memory.entityMentions || []);
    for (const entity of confirmedEntities) declarations.set(entity.ref, entity);
    repaired.push(...memories);
    if (validationError) {
      if (memories.length) {
        const unresolved = failures.map(({ candidate }) => candidate);
        const confirmedRefs = new Set(confirmedEntities.map(entity => entity.ref));
        item.draft = memoryDraft(unresolved, extractionEntityDeclarationsFor(unresolved, item.draft.entities, confirmedRefs));
      }
      return validationError;
    }
    recoveredCount++;
    pending.delete(item.index);
  };
  if (resumeSavedDrafts) {
    for (const item of candidates) {
      if (!item.draft.memories?.length) continue;
      const error = resolveDraft(item);
      if (error) item.reason = clean(error.message);
    }
  }
  const groups = pending.size ? [[...pending.values()]] : [];
  for (let attempt = 0; attempt < MAXIMUM_REPAIR_ATTEMPTS && groups.length; attempt++) {
    let current = groups.shift();
    let { messages, contextWindows } = selectMaterial(current);
    if (sourceIsCurrent) {
      const currentRefs = new Set(messages.map(message => message.memoryRef));
      const selection = selectCurrentRepairCandidates({ ...state, candidates: current },
        { evidence: currentRefs, scoped: currentRefs });
      if (selection.rejected.length) {
        sourceInvalidated = true;
        rejected.push(...selection.rejected);
        for (const item of current) pending.delete(item.index);
        for (const item of selection.available) pending.set(item.index, item);
        current = selection.available;
        if (!current.length) continue;
        ({ messages, contextWindows } = selectMaterial(current));
      }
    }
    const material = typeof sourceMaterial === 'function' ? sourceMaterial({ messages, contextWindows }) : sourceMaterial;
    const multipleWindows = new Set(messages.map(message => clean(message.archiveWindowId))).size > 1;
    const requested = new Map(current.map(item => [item.index, item]));
    // Interpret references against the bindings supplied with this request.
    const inputEntities = new Map(declarations);
    let response, decodeError;
    try {
      ({ generation: response, decodeError } = await requestExtractionOutput(generator, {
        input: JSON.stringify({ outputLanguage: extractionOutputLanguage(extractionContextLanguage(messages)),
          timeZone, memoryOwner: participants.find(person => person.actorRole === 'agent')?.ref || '',
          ...(inputEntities.size ? { entities: [...inputEntities.values()] } : {}),
          candidates: current.map(item => {
            const sourceWindows = multipleWindows ? windowsByIndex.get(item.index).map(id => labels.get(id)).filter(Boolean) : [];
            return { candidateIndex: item.index, draft: item.draft,
              ...(sourceWindows.length ? { sourceWindows } : {}), validationError: item.reason,
              ...(item.responseFeedback ? { responseFeedback: item.responseFeedback } : {}) };
          }),
          sourceMessages: messages.map(message => sourceMessage(message, { includeWindow: multipleWindows })),
          ...(contextWindows.length ? { contextWindows: contextWindows.map(window => ({
            ...(multipleWindows ? { window: window.label } : {}),
            previousContextMessages: window.previousContextMessages.map(message => sourceMessage(message, { includeRef: false })),
            continuationGuidanceMessages: window.continuationGuidanceMessages.map(message => sourceMessage(message, { includeRef: false })),
          })) } : {}),
          participants: participants.map(person => ({ ref: person.ref, name: person.displayName })),
        }),
        systemPrompt: [
          '根据 validationError 和 Schema 修复每份草稿。每个 candidateIndex 返回一项结果。',
          '修复成功时用 repaired 返回修好的记忆。仅在没有可保留且有原话依据的记忆时用 rejected 并说明原因。问题仍未解决时用 pending 并说明原因。',
          '只修改解决报错和保持相关字段一致所需的字段。保留有依据的事实、人物和日期，以及原话中的否定、不确定性和适用条件。删除缺乏依据的细节，保留有原话依据的经历。',
          '用 sourceRefs 引用 sourceMessages 中支持本条记忆的原话。',
          ...(multipleWindows ? ['使用候选 sourceWindows 内的原话，每条记忆只引用同一窗口。'] : []),
          '保留本事项在原话中的时间精度。已知哪一天或具体时刻时填写 time，相对时间以所引消息的 timestamp 和 timeZone 为准。只知道范围时正文保留范围，time 置为 null。',
          'draft.memories 是当前待修的一组记忆，draft.entities 是随附的实体声明。需要时将独立事实拆成多条记忆。返回整组修复结果，保留已有的正确字段和所有有依据的拆分条目。',
          ...(current.some(item => Object.hasOwn(item.draft, 'rawOutput')) ? [
            '草稿含有 rawOutput 时，从中恢复可读的候选，并用 sourceMessages 核对。如果 rawOutput 中没有可恢复的候选，只恢复 sourceMessages 能支持且以后需要沿用的事项结论、实际进展和人物事实。',
          ] : []),
          ...(current.some(item => item.responseFeedback) ? ['responseFeedback 补充说明回包问题或待解决点。'] : []),
          '人物表 participants 中的人用 P 编号。沿用输入顶层 entities 中 E 编号与实体的对应关系。不同的实体使用新的 E 编号。修好的记忆使用了草稿中新增或修订的实体声明时，将这些声明放入 entities。entityRefs 列出本条涉及的实体编号。',
          ...(contextWindows.length ? ['使用只读的 contextWindows 理解指代。'] : []),
        ].join('\n'),
        schema: LONG_TERM_EXTRACTION_REPAIR_SCHEMA,
        modelSchema: LONG_TERM_EXTRACTION_REPAIR_MODEL_SCHEMA,
        schemaName: 'long-term-memory-extraction-repair-v5',
        ...(material ? { sourceMaterial: material } : {}),
      }));
    } catch (error) {
      assertEventSourceExecutionCurrent();
      generations.push({ ...(error.model ? { model: error.model, requestId: error.requestId } : {}),
        usage: error.usage, durationMs: error.durationMs, metadata: error.metadata });
      const failure = { stage: 'repair', candidateIndices: current.map(item => item.index), reason: clean(error.message) };
      failures.push(failure);
      requestFailures.push(failure);
      // Transport providers already apply their own retry policy.
      if (error.code !== 'MAX_TOKENS') break;
      if (current.length > 1) {
        const middle = Math.ceil(current.length / 2);
        groups.push(current.slice(0, middle), current.slice(middle));
      }
      continue;
    }

    assertEventSourceExecutionCurrent();
    generations.push(response);
    let output;
    try {
      if (decodeError) throw decodeError;
      output = typeof response.output === 'string' ? JSON.parse(response.output) : response.output;
      if (!output || Object.keys(output).some(key => !['results', 'entities'].includes(key)) || !Array.isArray(output.results)) {
        throw new Error('Extraction repair requires a results array and optional entities.');
      }
    } catch (error) {
      const reason = clean(error.message);
      for (const item of current) item.responseFeedback = reason;
      failures.push({ stage: 'repair', reason });
      groups.push(current);
      continue;
    }
    returnedCount += output.results.length;
    const counts = new Map();
    for (const result of output.results) counts.set(result?.candidateIndex, (counts.get(result?.candidateIndex) || 0) + 1);
    for (const result of output.results) {
      const item = requested.get(result?.candidateIndex);
      if (!item) {
        failures.push({ index: result?.candidateIndex, stage: 'repair', reason: 'Unrequested candidateIndex.' });
        continue;
      }
      if (counts.get(item.index) !== 1) {
        recordCandidateFailure(item, 'Duplicate candidateIndex in repair response.');
        continue;
      }
      let envelope;
      try { envelope = parseExtractionRepairResultEnvelope(result); }
      catch (error) {
        recordCandidateFailure(item, clean(error.message));
        continue;
      }
      if (envelope.status === 'pending') {
        recordCandidateFailure(item, envelope.reason);
        continue;
      }
      if (envelope.status === 'rejected') {
        rejected.push({ index: item.index, reason: envelope.reason });
        pending.delete(item.index);
        continue;
      }
      item.draft = nextRepairDraft(item, envelope.memories, output.entities, inputEntities);
      delete item.responseFeedback;
      const error = resolveDraft(item);
      if (error) recordCandidateFailure(item, clean(error.message), 'reason');
    }
    for (const item of current) if (!counts.has(item.index)) {
      recordCandidateFailure(item, 'Repair response omitted this candidateIndex.');
    }
    const unresolved = current.filter(item => pending.has(item.index));
    if (unresolved.length) groups.push(unresolved);
  }
  const remaining = [...pending.values()];
  const { messages: pendingMessages, contextWindows: pendingContexts } = selectMaterial(remaining);
  return { memories: repaired, recoveredCount,
    rejected, failures, returnedCount, generations, sourceInvalidated,
    state: remaining.length ? { candidates: remaining, entityScope, ...(declarations.size ? { entities: [...declarations.values()] } : {}), messages: pendingMessages,
      ...(pendingContexts.length ? { contextWindows: pendingContexts } : {}),
      ...(requestFailures.length ? { requestFailures } : {}), participants, timeZone } : null };
}
