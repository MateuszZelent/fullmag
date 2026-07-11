import { describe, expect, it } from "vitest";

import {
  DEFAULT_RELAX_TORQUE_APM,
  apmFromTesla,
  formatTorquePairFromApm,
  formatTorqueT,
  teslaFromApm,
} from "./torqueUnits";

describe("torqueUnits", () => {
  it("owns the canonical relaxation default in A/m", () => {
    expect(DEFAULT_RELAX_TORQUE_APM).toBe(1e-4);
  });
  it("converts torque residuals between mumax-compatible T and canonical A/m", () => {
    const apm = apmFromTesla(1e-5);

    expect(apm).toBeCloseTo(7.957747154594767, 12);
    expect(teslaFromApm(apm)).toBeCloseTo(1e-5, 18);
  });

  it("formats torque values with explicit units", () => {
    expect(formatTorqueT(1e-5)).toBe("1.000000e-5 T");
    expect(formatTorquePairFromApm(apmFromTesla(1e-5))).toBe(
      "1.000000e-5 T / 7.957747e0 A/m",
    );
  });
});
