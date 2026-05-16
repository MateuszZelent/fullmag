import { describe, expect, it } from "vitest";

import { magnetizationHslColor } from "../magnetizationColor";

describe("magnetizationHslColor", () => {
  it("uses a neutral visible fallback for zero vectors", () => {
    const color = magnetizationHslColor(0, 0, 0);

    expect(color.r).toBeCloseTo(0.6);
    expect(color.g).toBeCloseTo(0.6);
    expect(color.b).toBeCloseTo(0.6);
  });

  it("keeps -Z distinct from a zero vector", () => {
    const color = magnetizationHslColor(0, 0, -1);

    expect(color.r).toBeCloseTo(0);
    expect(color.g).toBeCloseTo(0);
    expect(color.b).toBeCloseTo(0);
  });
});
