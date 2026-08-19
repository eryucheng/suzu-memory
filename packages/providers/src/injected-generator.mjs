function clean(value) {
  return String(value ?? "").trim();
}

/**
 * Model calls are owned by the current host runtime.  Offline maintenance
 * helpers must receive that generator explicitly instead of probing or
 * starting a second Agent runtime on their own.
 */
export function createInjectedStructuredGenerator(factory, {
  label = "memory worker",
  model = "",
} = {}) {
  if (typeof factory !== "function") {
    throw new Error(`${clean(label) || "memory worker"} requires an explicitly supplied structured generator.`);
  }
  const generator = factory({ model: clean(model) });
  if (typeof generator !== "function") {
    throw new Error(`${clean(label) || "memory worker"} generator factory must return a function.`);
  }
  return generator;
}
