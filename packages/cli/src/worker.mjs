function clean(value) {
  return String(value ?? "").trim();
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const numeric = Math.trunc(Number(value));
  if (!Number.isFinite(numeric) || numeric < minimum || numeric > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return numeric;
}

function diagnostic(error) {
  return {
    code: clean(error?.code) || "WORKER_CYCLE_FAILURE",
    name: clean(error?.name) || "Error",
    message: clean(error?.message) || "Unknown worker cycle failure.",
  };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cycleHasFailure(result) {
  return ["failed", "completed-with-failures"].includes(clean(result?.status));
}

/**
 * Explicit maintenance worker for direct SDK/HTTP ingestion deployments.
 * It deliberately does not start from the HTTP server itself: operators can
 * run one cycle from a scheduler, or opt into a foreground loop themselves.
 */
export async function runMemoryWorker({
  service,
  maintenanceOptions = {},
  once = true,
  intervalMs = 15_000,
  maximumCycles = 0,
  sleep = wait,
  onCycle = null,
} = {}) {
  if (!service || typeof service.runMaintenance !== "function") {
    throw new Error("runMemoryWorker requires a service with runMaintenance().");
  }
  if (typeof sleep !== "function") throw new Error("runMemoryWorker sleep must be a function.");
  if (onCycle !== null && typeof onCycle !== "function") {
    throw new Error("runMemoryWorker onCycle must be a function when provided.");
  }
  const interval = boundedInteger(intervalMs, 15_000, 1_000, 86_400_000, "intervalMs");
  const maximum = boundedInteger(maximumCycles, 0, 0, 1_000_000, "maximumCycles");
  const cycles = [];
  let cycle = 0;
  while (true) {
    cycle += 1;
    let result;
    try {
      result = await service.runMaintenance(maintenanceOptions);
    } catch (error) {
      result = { status: "failed", error: diagnostic(error) };
    }
    const entry = { cycle, completedAt: new Date().toISOString(), result };
    cycles.push(entry);
    if (cycles.length > 100) cycles.shift();
    if (onCycle) await onCycle(entry);
    if (once || (maximum > 0 && cycle >= maximum)) break;
    await sleep(interval);
  }
  return {
    status: cycles.some((item) => cycleHasFailure(item.result))
      ? "completed-with-failures"
      : "completed",
    mode: once ? "once" : "continuous",
    cyclesCompleted: cycle,
    cycles,
  };
}
