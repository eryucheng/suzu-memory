import { TEMPORAL_STATES } from '@suzu-memory/core';

const boundaries = /[，,。？！!?；;\n]/u;
const brackets = new Map([['“', '”'], ['「', '」'], ['『', '』'], ['（', '）'], ['(', ')'], ['《', '》'], ['[', ']']]);
const fragmentReference = /^M[0-9]{4}\.[1-9][0-9]*$/u;
const sourceReference = { type: 'string', pattern: '^M[0-9]{4}(?:\\.[1-9][0-9]*)?$' };
const preciseCategories = new Set(['identity', 'habit', 'preference', 'condition']);

export const EXTRACTION_MODEL_EVIDENCE = {
  type: 'array',
  minItems: 1,
  items: sourceReference,
  description: '首项为核心证据，后续为支持同一事项的其他正文消息编号。',
};
export const EXTRACTION_MODEL_DATE = { type: 'string', pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' };
const dateReference = new RegExp(EXTRACTION_MODEL_DATE.pattern, 'u');

function splitEvidenceFragments(text) {
  const fragments = [];
  const closing = [];
  let start = 0;
  let hasText = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === closing.at(-1)) closing.pop();
    else if (brackets.has(char)) closing.push(brackets.get(char));
    const numericComma = char === ',' && /\d/u.test(text[index - 1] || '') && /\d/u.test(text[index + 1] || '');
    if (!closing.length && hasText && boundaries.test(char) && !numericComma && index + 1 < text.length) {
      fragments.push(text.slice(start, index + 1));
      start = index + 1;
      hasText = false;
    } else if (!/\s/u.test(char)) hasText = true;
  }
  if (start < text.length) {
    const tail = text.slice(start);
    if (!tail.trim() && fragments.length) fragments[fragments.length - 1] += tail;
    else fragments.push(tail);
  }
  return fragments;
}

/** Add addresses to the model's view. Stored text retains its original spelling and spacing. */
export function formatExtractionEvidence(text, sourceRef, references) {
  references.set(sourceRef, sourceRef);
  return splitEvidenceFragments(text).map((fragment, index) => {
    const ordinal = index + 1;
    references.set(sourceRef + '.' + ordinal, sourceRef);
    return '〔' + ordinal + '〕' + fragment;
  }).join('');
}

/** Restore canonical fields before domain validation, including for older drafts. */
export function decodeExtractionModelOutput(output, references, targetProperties) {
  if (!Array.isArray(output?.memories)) return output;

  return { ...output, memories: output.memories.map(candidate => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return candidate;
    const implicitAddition = candidate.classification?.category === 'event'
      && TEMPORAL_STATES.includes(candidate.temporalState) && candidate.temporalState !== 'cancelled'
      && (candidate.revisionAction === null || !Object.hasOwn(candidate, 'revisionAction'));
    const decoded = implicitAddition ? { ...candidate, revisionAction: 'add' } : candidate;
    if (!references || !Object.hasOwn(decoded, 'evidence')) return decoded;
    const { evidence, ...rest } = decoded;
    const listed = Array.isArray(evidence);
    const support = Array.isArray(evidence?.support) ? evidence.support : [];
    const supplied = listed ? evidence : [evidence?.primary, ...support];
    const sourceRefs = [...new Set(supplied.flatMap(ref => {
      if (typeof ref !== 'string') return [];
      const sourceRef = references.get(ref) || ref.split('.')[0];
      return references.has(sourceRef) ? [sourceRef] : [];
    }))];
    const validShape = listed ? supplied.length > 0 : evidence && typeof evidence === 'object'
      && Object.keys(evidence).length === 2 && Object.hasOwn(evidence, 'primary')
      && Object.hasOwn(evidence, 'support') && Array.isArray(evidence.support);
    if (!validShape || Object.hasOwn(decoded, 'sourceRefs') || !supplied.every(ref => references.has(ref))
      || (preciseCategories.has(decoded.classification?.category) && !fragmentReference.test(supplied[0]))) {
      // Retain the invalid draft and its known sources for candidate-local repair.
      return { ...decoded, sourceRefs };
    }
    const classification = rest.classification;
    if (classification?.target === null && !Object.hasOwn(targetProperties, classification.category)) {
      const { target: _target, ...fields } = classification;
      rest.classification = fields;
    }
    if (typeof rest.time === 'string' && dateReference.test(rest.time)) rest.time = { date: rest.time };
    return { ...rest, sourceRefs };
  }) };
}
