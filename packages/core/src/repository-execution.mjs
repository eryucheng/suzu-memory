import { AsyncLocalStorage } from 'node:async_hooks';

const guards = new AsyncLocalStorage();

/** A task's ownership and material checks also cover writes inside shared
 * domain services. Unrelated executions on the same repository stay independent. */
export async function withRepositoryWriteGuard(repository, assertCurrent, callback) {
  const guard = { repository, assertCurrent, active: true };
  return guards.run([...(guards.getStore() || []), guard], async () => {
    try { assertCurrent(); return await callback(); }
    finally { guard.active = false; }
  });
}

export function assertRepositoryWriteCurrent(repository) {
  for (const guard of guards.getStore() || []) {
    if (!guard.active || guard.checking || guard.repository !== repository) continue;
    guard.checking = true;
    try { guard.assertCurrent(); }
    finally { guard.checking = false; }
  }
}
