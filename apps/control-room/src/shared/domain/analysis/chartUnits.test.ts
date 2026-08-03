import { describe, expect, it } from "vitest";

import { chartDisplayUnitOptions, resolveChartUnit } from "./chartUnits";

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

  it("offers only compatible display units to chart controls", () => {
    expect(chartDisplayUnitOptions("s")).toEqual(expect.arrayContaining(["s", "ns"]));
    expect(chartDisplayUnitOptions("s")).not.toContain("J");
  });
});
