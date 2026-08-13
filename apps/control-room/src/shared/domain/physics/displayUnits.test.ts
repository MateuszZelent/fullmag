import { describe, expect, it } from "vitest";

import {
  displayUnitItemsForSourceUnit,
  formatValueWithDisplayUnit,
  resolveDisplayUnitConversion,
} from "./displayUnits";

describe("displayUnits", () => {
  it("offers common magnetic field display units for A/m colorbar values", () => {
    expect(displayUnitItemsForSourceUnit("A/m").map((item) => item.value)).toEqual([
      "A/m",
      "kA/m",
      "MA/m",
      "T",
      "mT",
    ]);
    expect(formatValueWithDisplayUnit(1_000_000, "A/m", "MA/m")).toBe("1 MA/m");
    expect(formatValueWithDisplayUnit(1_000_000, "A/m", "mT")).toBe("1257 mT");
  });

  it("offers common derived energy and material units without changing unitless data", () => {
    expect(formatValueWithDisplayUnit(1.5e-11, "J/m", "pJ/m")).toBe("15 pJ/m");
    expect(formatValueWithDisplayUnit(0.002, "J/m²", "mJ/m²")).toBe("2 mJ/m²");
    expect(formatValueWithDisplayUnit(2_000_000, "J/m³", "MJ/m³")).toBe(
      "2 MJ/m³",
    );
    expect(displayUnitItemsForSourceUnit("1")).toEqual([
      { label: "dimensionless", value: "1" },
    ]);
    expect(formatValueWithDisplayUnit(0.25, "1", "T")).toBe("0.25");
  });

  it("keeps every normalized canonical unit identity-compatible without inventing alternatives", () => {
    for (const unit of ["m", "Pa", "V", "rad", "dimensionless"]) {
      expect(resolveDisplayUnitConversion(` ${unit} `, unit)).toEqual({
        compatible: true,
        factor: 1,
        unit,
      });
    }
    expect(resolveDisplayUnitConversion("Pa", "V")).toEqual({
      compatible: false,
      factor: 1,
      unit: "Pa",
    });
    expect(displayUnitItemsForSourceUnit("Pa")).toEqual([]);
  });
});
