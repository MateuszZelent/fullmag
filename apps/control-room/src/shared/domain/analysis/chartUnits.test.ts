import { describe, expect, it } from "vitest";

import { resolveChartUnit } from "./chartUnits";

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
});
