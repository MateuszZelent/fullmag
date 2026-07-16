import { describe, expect, it } from "vitest";

import {
  AUTO_SINC_NYQUIST_GUARD_FACTOR,
  resolveAutoSincSampling,
} from "./autoSampling";

describe("resolveAutoSincSampling", () => {
  it("resolves 5 GHz with the canonical 30 percent guard", () => {
    expect(resolveAutoSincSampling({ cutoffHz: [3e9, 5e9] })).toEqual({
      maximumCutoffHz: 5e9,
      nyquistGuardFactor: 1.3,
      samplePeriodS: 1 / 13e9,
      samplingFrequencyHz: 13e9,
      status: "ready",
      targetNyquistHz: 6.5e9,
    });
    expect(AUTO_SINC_NYQUIST_GUARD_FACTOR).toBe(1.3);
  });

  it("fails closed without an active finite positive sinc cutoff", () => {
    expect(resolveAutoSincSampling({ cutoffHz: [] })).toEqual({
      reason: "No active sinc drive with a finite positive cutoff applies to this Run.",
      status: "unresolved",
    });
    expect(resolveAutoSincSampling({ cutoffHz: [0, Number.NaN] }).status).toBe(
      "unresolved",
    );
  });
});
