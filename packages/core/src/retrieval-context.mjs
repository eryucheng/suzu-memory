import { createHash } from "node:crypto";

function clean(value) {
  return String(value ?? "").trim();
}

function field(memory, snakeName, camelName = snakeName) {
  return memory?.[snakeName] ?? memory?.[camelName] ?? null;
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]),
  );
}

export function buildMemoryRetrievalContextSource(memory = {}) {
  return {
    schemaVersion: 1,
    memoryId: clean(field(memory, "id")),
    kind: clean(field(memory, "kind")),
    layer: clean(field(memory, "layer")),
    title: clean(field(memory, "title")),
    content: clean(field(memory, "content")),
    subjectRole: clean(field(memory, "subject_role", "subjectRole")),
    subjectKey: clean(field(memory, "subject_key", "subjectKey")),
    canonicalKey: clean(field(memory, "canonical_key", "canonicalKey")),
    stateFamily: clean(field(memory, "state_family", "stateFamily")),
    statePhase: clean(field(memory, "state_phase", "statePhase")),
    representationLayer: clean(field(memory, "representation_layer", "representationLayer")),
    stateScopeKey: clean(field(memory, "state_scope_key", "stateScopeKey")),
    temporalState: clean(field(memory, "temporal_state", "temporalState")),
    eventDate: clean(field(memory, "event_date", "eventDate")),
    eventStart: clean(field(memory, "event_start", "eventStart")),
    eventEnd: clean(field(memory, "event_end", "eventEnd")),
    knownAt: clean(field(memory, "known_at", "knownAt")),
    validFrom: clean(field(memory, "valid_from", "validFrom")),
    validTo: clean(field(memory, "valid_to", "validTo")),
    reality: clean(field(memory, "reality")),
    perspective: clean(field(memory, "perspective")),
    evidenceMode: clean(field(memory, "evidence_mode", "evidenceMode")),
    status: clean(field(memory, "status")),
  };
}

export function memoryRetrievalContextSourceHash(memory = {}) {
  const source = buildMemoryRetrievalContextSource(memory);
  return createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue(source)))
    .digest("hex");
}
