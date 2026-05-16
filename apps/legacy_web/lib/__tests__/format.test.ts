import { describe, expect, it } from "vitest";

import { displayUnitPolicy, fmtSI, normalizeUnitLabel } from "../format";

describe("format", () => {
  it("keeps dimensionless values unitless", () => {
    expect(displayUnitPolicy("m", "dimensionless").displayUnit).toBe("");
    expect(fmtSI(0.125, "dimensionless", "m")).toBe("0.125");
  });

  it("formats rates as s^-1 without malformed prefixes", () => {
    expect(normalizeUnitLabel("1/s")).toBe("s^-1");
    expect(fmtSI(2.5e6, "1/s", "max_dm_dt")).toBe("2.50 Ms^-1");
    expect(fmtSI(2.5e-3, "1/s", "max_dm_dt")).toBe("2.50 ms^-1");
  });

  it("normalizes compound units without appending bogus prefixes", () => {
    expect(normalizeUnitLabel("J/m³")).toBe("J/m^3");
    expect(fmtSI(1.25e3, "J/m^3", "eden_total")).toBe("1.25 kJ/m^3");
  });
});
