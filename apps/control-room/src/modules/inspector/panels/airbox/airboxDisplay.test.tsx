import { describe, expect, it } from "vitest";

import { airboxEffectiveLengthUnit } from "./airboxDisplay.model";

describe("Airbox display boundary", () => {
  it("shows SI units for effective physical lengths only", () => {
    expect(airboxEffectiveLengthUnit("airbox_hmax")).toBe("m");
    expect(airboxEffectiveLengthUnit("airbox_hmin")).toBe("m");
    expect(airboxEffectiveLengthUnit("padding")).toBe("m");
    expect(airboxEffectiveLengthUnit("size")).toBe("m");
    expect(airboxEffectiveLengthUnit("center")).toBe("m");
    expect(airboxEffectiveLengthUnit("airbox_growth_rate")).toBeUndefined();
    expect(airboxEffectiveLengthUnit("mode")).toBeUndefined();
  });
});
