export function stateAnalysisBudgetError(message) {
  return Object.assign(new Error(message), { code: "MEMORY_STATE_ANALYSIS_INPUT_TOO_LARGE" });
}

export function isStateAnalysisBudgetError(error) {
  return error?.code === "MEMORY_STATE_ANALYSIS_INPUT_TOO_LARGE";
}
