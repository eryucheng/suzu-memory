const person = (role, name) => ['shared', 'world', 'unknown'].includes(role)
  ? { scope: role, name: name || '' }
  : name ? { name } : { ref: role === 'agent' ? 'P1' : 'P2' };

export function extractionModelFixture(output) {
  if (typeof output === 'string') {
    try { return JSON.stringify(extractionModelFixture(JSON.parse(output))); } catch { return output; }
  }
  if (Array.isArray(output)) return output.map(candidate);
  if (!output || typeof output !== 'object') return output;
  if (Array.isArray(output.memories)) return { ...output, memories: output.memories.map(candidate) };
  if (Array.isArray(output.results)) return { ...output, results: output.results.map(result =>
    result.status === 'repaired' ? { ...result, memories: result.memories.map(candidate) } : result) };
  return output;
}

function candidate(value) {
  if (!value || !Object.hasOwn(value, 'kind')) return value;
  const category = value.stateFamily && !['goal', 'not_applicable'].includes(value.stateFamily)
    ? value.stateFamily : value.kind;
  const classification = { category };
  if (value.kind !== 'event') classification.key = value.canonicalKey;
  if (!['event', 'reflection'].includes(value.kind)) classification.label = value.stateLabel;
  if (value.stateTarget) {
    const target = value.stateTarget;
    if (value.stateFamily === 'identity') classification.target = { ...target };
    else {
      const prefix = value.stateFamily === 'belief' ? 'object' : value.stateFamily === 'relationship' ? 'counterpart' : 'trigger';
      classification.target = { [prefix]: target[`${prefix}Role`] === 'world'
        ? { world: target[`${prefix}Name`] } : person(target[`${prefix}Role`], target[`${prefix}Name`]),
        ...(value.stateFamily === 'relationship' ? { dimension: target.relationshipDimension || 'other' } : {}) };
    }
  }
  const result = Object.fromEntries(['title', 'content', 'reality', 'evidenceMode', 'temporalState', 'revisionAction',
    'confidence', 'importance', 'sourceRefs'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  return { ...result, classification, subject: person(value.subjectRole, value.subjectName),
    actors: (value.actorRoles || []).map(actor => ({ role: actor.role, person: person(actor.actorRole, actor.actorName), confidence: actor.confidence })),
    time: value.eventDate || value.eventStart || value.eventEnd ? {
      ...(value.eventDate ? { date: value.eventDate } : {}), ...(value.eventStart ? { start: value.eventStart } : {}),
      ...(value.eventEnd ? { end: value.eventEnd } : {}),
    } : null };
}
