import assert from "node:assert/strict";
import test from "node:test";

import {
  shiftedPowerLawHalfLifeDays,
  shiftedPowerLawRetention,
} from "../src/index.mjs";

test("shifted power-law retention keeps calibrated half-life and a long tail", () => {
  const policy = { scaleDays: 30, decayExponent: 0.5 };
  assert.equal(shiftedPowerLawRetention(0, policy), 1);
  assert.ok(Math.abs(shiftedPowerLawHalfLifeDays(policy) - 90) < 1e-12);
  assert.ok(Math.abs(shiftedPowerLawRetention(90, policy) - 0.5) < 1e-12);
  assert.ok(shiftedPowerLawRetention(365, policy) > 0.25);
});

test("shifted power-law retention rejects invalid curve parameters", () => {
  assert.throws(
    () => shiftedPowerLawRetention(-1, { scaleDays: 30, decayExponent: 0.5 }),
    /elapsedDays/,
  );
  assert.throws(
    () => shiftedPowerLawRetention(1, { scaleDays: 0, decayExponent: 0.5 }),
    /scaleDays/,
  );
  assert.throws(
    () => shiftedPowerLawRetention(1, { scaleDays: 30, decayExponent: 0 }),
    /decayExponent/,
  );
});
