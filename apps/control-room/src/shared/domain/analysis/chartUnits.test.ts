import { describe, expect, it } from "vitest";

import { chartDisplayUnitOptions, chartUnitsCompatible, resolveChartUnit } from "./chartUnits";

describe("resolveChartUnit", () => {
  it("resolves canonical dimensionless units without an SI display prefix", () => {
    expect(resolveChartUnit("1")).toMatchObject({
      canonicalUnit: "1",
      dimension: "dimensionless",
      scaleToCanonical: 1,
    });
    expect(resolveChartUnit("")).toMatchObject({
      canonicalUnit: "1",
      dimension: "dimensionless",
      scaleToCanonical: 1,
    });
  });

  it.each(["constructor", "toString", "hasOwnProperty", "__proto__"])(
    "does not resolve inherited object property %s as a chart unit",
    (unit) => {
      expect(resolveChartUnit(unit)).toBeNull();
    },
  );

  it("still resolves registered SI units after rejecting inherited keys", () => {
    expect(resolveChartUnit("rad")).toMatchObject({
      canonicalUnit: "rad",
      dimension: "phase",
      scaleToCanonical: 1,
      unit: "rad",
    });
  });

  it("keeps magnetic induction units compatible with each other and separate from field strength", () => {
    expect(resolveChartUnit("T")).toMatchObject({ dimension: "magnetic_induction", scaleToCanonical: 1 });
    expect(resolveChartUnit("mT")).toMatchObject({ canonicalUnit: "T", scaleToCanonical: 1e-3 });
    expect(chartDisplayUnitOptions("T")).toEqual(expect.arrayContaining(["T", "mT"]));
    expect(chartUnitsCompatible("T", "mT")).toBe(true);
    expect(chartUnitsCompatible("T", "A/m")).toBe(false);
  });

  it("offers only compatible display units to chart controls", () => {
    expect(chartDisplayUnitOptions("s")).toEqual(expect.arrayContaining(["s", "ns"]));
    expect(chartDisplayUnitOptions("s")).not.toContain("J");
  });
});
