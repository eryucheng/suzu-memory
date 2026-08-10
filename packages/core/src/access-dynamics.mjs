export const ACCESS_DECAY_MODEL = "shifted-power-law";

function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`${label} must be greater than 0.`);
  }
  return number;
}

export function shiftedPowerLawRetention(elapsedDays, {
  scaleDays,
  decayExponent,
} = {}) {
  const elapsed = Number(elapsedDays);
  if (!Number.isFinite(elapsed) || elapsed < 0) {
    throw new Error("elapsedDays must be a non-negative finite number.");
  }
  const scale = positive(scaleDays, "scaleDays");
  const exponent = positive(decayExponent, "decayExponent");
  return (1 + elapsed / scale) ** (-exponent);
}

export function shiftedPowerLawHalfLifeDays({
  scaleDays,
  decayExponent,
} = {}) {
  const scale = positive(scaleDays, "scaleDays");
  const exponent = positive(decayExponent, "decayExponent");
  return scale * ((2 ** (1 / exponent)) - 1);
}
