import { createHash } from 'node:crypto';
import { entityNameKey, entityNameKeys, memoryWorldsCompatible } from '@suzu-memory/core';
const personal = new Set(['user', 'agent', 'other']);
const idFor = (...parts) => 'entity-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24);

/** Resolve necessary names once and reuse captured reference bindings across
 * retries. Create and use the binder within the caller's repository transaction.
 * Distinct references in one batch retain distinct entity IDs. */
export function createExtractionEntityBinder(repository, agentId, candidates, participants = [], batchId = '') {
  const declarations = candidates.flatMap(candidate => candidate.entityMentions || []);
  const existing = repository.findEntitiesByNames({ agentId, names: declarations.flatMap(entity => [entity.name, ...entity.aliases]) });
  const captured = declarations.length ? repository.listIngestionEntityBindings({ agentId, batchId,
    entityScopes: candidates.map(candidate => candidate.entityScope).filter(Boolean) }) : [];
  const byName = new Map();
  const index = entity => { for (const name of entityNameKeys(entity)) {
    const key = `${entity.kind}\u001f${name}`;
    const entries = byName.get(key) || [];
    if (!entries.some(entry => entry.id === entity.id)) entries.push(entity);
    byName.set(key, entries);
  } };
  [...existing, ...captured.map(binding => binding.entity)].forEach(index);
  const bound = new Map(), reserved = new Map(), actors = new Map();
  for (const { scope, ref, entity } of captured) {
    bound.set(`${scope}:${ref}`, entity);
    const used = reserved.get(scope) || new Set(); used.add(entity.id); reserved.set(scope, used);
  }
  function actorEntity(role, key, name) {
    if (!personal.has(role) || !key || !name) return null;
    const cacheKey = `${role}\u001f${key}`;
    if (actors.has(cacheKey)) return actors.get(cacheKey);
    const participant = participants.find(person => person.actorRole === role && person.actorKey === key);
    const entity = repository.ensureActorEntity({ agentId, actorRole: role, actorKey: key,
      displayName: participant?.name || name, provenance: 'extraction-reference' }).entity;
    actors.set(cacheKey, entity);
    return entity;
  }
  return (candidate, world) => {
    const ordinary = world.reality === 'real' && ['physical', 'relational', 'unknown'].includes(world.world_frame);
    const scope = ordinary ? 'real' : JSON.stringify(world);
    const namespace = JSON.stringify([batchId, candidate.entityScope || '', scope]);
    const used = reserved.get(namespace) || new Set(); reserved.set(namespace, used);
    const refs = new Map();
    for (const mention of candidate.entityMentions || []) {
      const token = `${namespace}:${mention.ref}`;
      let entity = bound.get(token);
      if (!entity) {
        const matches = [...new Map([mention.name, ...mention.aliases].flatMap(name => byName.get(`${mention.kind}\u001f${entityNameKey(name)}`) || [])
          .filter(entity => !used.has(entity.id) && !entity.metadata?.actorKey
            && (entity.metadata?.world ? memoryWorldsCompatible(world, entity.metadata.world, { allowRealSpaces: true }) : ordinary))
          .map(entity => [entity.id, entity])).values()];
        entity = matches.length === 1 ? matches[0] : null;
        entity = repository.upsertEntity({ id: entity?.id || idFor(agentId, token), agentId, kind: mention.kind,
          canonicalName: entity?.canonical_name || mention.name, aliases: [...(entity?.aliases || []), mention.name, ...mention.aliases],
          metadata: { ...(entity?.metadata || {}), world, ...(matches.length > 1 ? { resolution: 'unresolved' } : {}) } });
        bound.set(token, entity); used.add(entity.id); index(entity);
      }
      const names = new Set(entityNameKeys(entity));
      if (entity.kind !== mention.kind || [mention.name, ...mention.aliases].some(name => !names.has(entityNameKey(name)))) {
        entity = repository.upsertEntity({ id: entity.id, agentId, kind: mention.kind, canonicalName: entity.canonical_name,
          aliases: [mention.name, ...mention.aliases] });
        bound.set(token, entity); index(entity);
      }
      refs.set(mention.ref, entity);
    }
    const entities = new Map([...refs.values()].map(entity => [entity.id, entity]));
    function bindPerson(role, key, name, ref) {
      const declared = ref && refs.get(ref);
      if (declared) {
        const actorKey = `entity:${declared.id}`;
        repository.bindActorEntity({ agentId, actorRole: 'other', actorKey, entityId: declared.id, displayName: name, provenance: 'extraction-entity-reference' });
        return { role: 'other', key: actorKey };
      }
      const entity = actorEntity(role, key, name);
      if (entity) entities.set(entity.id, entity);
      return { role, key };
    }
    const subject = bindPerson(candidate.subjectRole, candidate.subjectKey, candidate.subjectName, candidate.subjectEntityRef);
    const actorRoles = candidate.actorRoles.map(actor => {
      const fixed = bindPerson(actor.actorRole, actor.actorKey, actor.actorName || actor.metadata?.actorName, actor.entityRef);
      return { ...actor, actorRole: fixed.role, actorKey: fixed.key };
    });
    const stateTarget = candidate.stateTarget ? { ...candidate.stateTarget } : undefined;
    for (const prefix of ['object', 'counterpart', 'trigger']) {
      if (!stateTarget || !Object.hasOwn(stateTarget, `${prefix}Role`)) continue;
      const entity = refs.get(stateTarget[`${prefix}EntityRef`]);
      if (entity) {
        stateTarget[`${prefix}EntityId`] = entity.id;
        stateTarget[`${prefix}Kind`] = entity.kind;
        if (stateTarget[`${prefix}Role`] !== 'world') {
          const fixed = bindPerson(stateTarget[`${prefix}Role`], stateTarget[`${prefix}Key`], stateTarget[`${prefix}Name`], stateTarget[`${prefix}EntityRef`]);
          stateTarget[`${prefix}Role`] = fixed.role; stateTarget[`${prefix}Key`] = fixed.key;
        }
      } else {
        const fixed = bindPerson(stateTarget[`${prefix}Role`], stateTarget[`${prefix}Key`], stateTarget[`${prefix}Name`]);
        stateTarget[`${prefix}Key`] = fixed.key;
      }
    }
    return { ...candidate, subjectRole: subject.role, subjectKey: subject.key, actorRoles,
      ...(stateTarget ? { stateTarget } : {}), entityIds: [...entities.keys()], entityBindingScope: namespace,
      entityBindings: Object.fromEntries([...refs].map(([ref, entity]) => [ref, entity.id])) };
  };
}
