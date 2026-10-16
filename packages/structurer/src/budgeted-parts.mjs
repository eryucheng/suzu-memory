export function memoryBudgetError(message) {
  return Object.assign(new Error(message), { code: "MEMORY_STRUCTURE_INPUT_TOO_LARGE" });
}

export function isMemoryBudgetError(error) {
  return error?.code === "MEMORY_STRUCTURE_INPUT_TOO_LARGE";
}

// Partition complete memories. Retrospective work splits one side at a time,
// retaining the other side so every selected new/old pair is still examined.
export async function runBudgetedMemoryParts({ parts, prepare, execute, checkpoint }) {
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.status === "completed" || part.status === "blocked") continue;
    let prepared;
    try {
      prepared = await prepare(part);
    } catch (error) {
      if (!isMemoryBudgetError(error)) throw error;
      const field = (part.historicalIds?.length || 0) > part.memoryIds.length ? "historicalIds" : "memoryIds";
      const ids = part[field];
      if (ids.length < 2) {
        part.status = "blocked";
        part.error = error.message;
      } else {
        const middle = Math.ceil(ids.length / 2);
        parts.splice(index, 1, ...[ids.slice(0, middle), ids.slice(middle)].map((members, child) => ({
          ...part, id: `${part.id}.${child}`, [field]: members, status: "pending",
        })));
        index -= 1;
      }
      checkpoint();
      continue;
    }
    part.result = await execute(part, prepared);
    part.status = "completed";
    checkpoint();
  }
  return parts;
}
