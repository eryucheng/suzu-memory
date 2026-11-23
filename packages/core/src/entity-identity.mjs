export const ENTITY_KINDS = Object.freeze(['person', 'agent', 'place', 'organization', 'object', 'work', 'animal', 'concept']);
export const normalizedEntityName = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
export const entityNameKey = value => normalizedEntityName(value).toLocaleLowerCase('zh-CN');
export const entityNameKeys = entity => [...new Set([entity.canonical_name ?? entity.canonicalName, ...(entity.aliases || [])].map(entityNameKey).filter(Boolean))];

export const entityLabelKey = value => normalizedEntityName(value).toLowerCase().replace(/’/gu, "'");

export function entityLabelOccurs(text, label) {
  if (!label) return false;
  const startsWithWord = /^[\p{Script=Latin}\p{N}_]/u.test(label);
  const endsWithWord = /[\p{Script=Latin}\p{N}_]$/u.test(label);
  const wordCharacter = /[\p{Script=Latin}\p{N}_]/u;
  for (let index = text.indexOf(label); index >= 0; index = text.indexOf(label, index + 1)) {
    const before = text[index - 1] || '';
    const after = text[index + label.length] || '';
    if ((!startsWithWord || !wordCharacter.test(before)) && (!endsWithWord || !wordCharacter.test(after))) return true;
  }
  return false;
}
