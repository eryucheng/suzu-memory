export const ENTITY_KINDS = Object.freeze(['person', 'agent', 'place', 'organization', 'object', 'work', 'animal', 'concept']);
export const normalizedEntityName = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
export const entityNameKey = value => normalizedEntityName(value).toLocaleLowerCase('zh-CN');
export const entityNameKeys = entity => [...new Set([entity.canonical_name ?? entity.canonicalName, ...(entity.aliases || [])].map(entityNameKey).filter(Boolean))];
