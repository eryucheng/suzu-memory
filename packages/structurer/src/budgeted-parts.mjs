export function memoryBudgetError(message) {
  return Object.assign(new Error(message), { code: "MEMORY_STRUCTURE_INPUT_TOO_LARGE" });
}

export function isMemoryBudgetError(error) {
  return error?.code === "MEMORY_STRUCTURE_INPUT_TOO_LARGE";
}

export function blockedMemoryPartsError(parts, message) {
  const blocked = parts.filter(part => part.status === 'blocked');
  if (!blocked.length) return null;
  return Object.assign(new Error(message), { code: blocked[0].errorCode || 'MEMORY_STRUCTURE_INPUT_TOO_LARGE',
    diagnostics: blocked[0].providerDiagnostics || {} });
}

// Partition complete memories. Retrospective work splits one side at a time,
// retaining the other side so every selected new/old pair is still examined.
export async function runBudgetedMemoryParts({ parts, prepare, execute, checkpoint, onSplit = () => {} }) {
  const split = (part, index, error) => {
    const historical = part.historicalIds || [];
    const field = historical.length > part.memoryIds.length ? 'historicalIds' : 'memoryIds';
    const ids = part[field];
    if (ids.length < 2) {
      part.status = 'blocked'; part.error = error.message; part.errorCode = error.code;
      if (error.diagnostics) part.providerDiagnostics = error.diagnostics;
      checkpoint(); return false;
    }
    const middle = Math.ceil(ids.length / 2);
    const children = [ids.slice(0, middle), ids.slice(middle)].map((members, child) => {
      const { result, error, ...base } = part;
      return { ...base, id: `${part.id}.${child}`, [field]: members, status: 'pending' };
    });
    onSplit(part, children);
    part.status = 'partitioned'; part.error = error.message;
    parts.splice(index + 1, 0, ...children); checkpoint(); return true;
  };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (['completed', 'blocked', 'partitioned'].includes(part.status)) continue;
    let prepared;
    try {
      prepared = await prepare(part);
    } catch (error) {
      if (!isMemoryBudgetError(error)) throw error;
      split(part, index, error);
      continue;
    }
    try { part.result = await execute(part, prepared); }
    catch (error) {
      if (!['MAX_TOKENS', 'MEMORY_OUTPUT_LIMIT', 'MEMORY_STRUCTURE_OUTPUT_FULL'].includes(error?.code)) throw error;
      split(part, index, error);
      continue;
    }
    if (part.result?.status === 'partial-failure') {
      checkpoint();
      throw Object.assign(new Error('Organization contains rejected work; it remains pending for retry.'),
        { code: 'MEMORY_STRUCTURE_PARTIAL_FAILURE' });
    }
    if (part.result?.status === 'capacity-reached') {
      const error = Object.assign(new Error('Organization output reached its proposal capacity; remaining work requires smaller parts.'),
        { code: 'MEMORY_STRUCTURE_OUTPUT_FULL' });
      split(part, index, error);
      continue;
    }
    part.status = "completed";
    checkpoint();
  }
  return parts;
}
