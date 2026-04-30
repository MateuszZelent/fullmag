import { describe, expect, it } from "vitest";

import { shouldWarnMissingMagneticMask } from "../useFemViewportDerivedModel";

describe("shouldWarnMissingMagneticMask", () => {
  it("does not warn when magnetic texture coloring and vectors are disabled", () => {
    expect(
      shouldWarnMissingMagneticMask({
        quantityDomain: "magnetic_only",
        activeMaskLength: null,
        nNodes: 128,
        hasMeshParts: false,
        magneticSegmentCount: 0,
        field: "none",
        showArrowsRequested: false,
      }),
    ).toBe(false);
  });

  it("does not warn when shared-domain segmentation can scope magnetic content", () => {
    expect(
      shouldWarnMissingMagneticMask({
        quantityDomain: "magnetic_only",
        activeMaskLength: null,
        nNodes: 128,
        hasMeshParts: false,
        magneticSegmentCount: 1,
        field: "orientation",
        showArrowsRequested: false,
      }),
    ).toBe(false);
  });

  it("warns only for active magnetic-only display without mask or segmentation", () => {
    expect(
      shouldWarnMissingMagneticMask({
        quantityDomain: "magnetic_only",
        activeMaskLength: null,
        nNodes: 128,
        hasMeshParts: false,
        magneticSegmentCount: 0,
        field: "orientation",
        showArrowsRequested: false,
      }),
    ).toBe(true);
  });
});
