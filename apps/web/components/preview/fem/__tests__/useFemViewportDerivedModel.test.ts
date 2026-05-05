import { describe, expect, it } from "vitest";

import {
  shouldFlagMissingExactScopeSegment,
  shouldWarnMissingMagneticMask,
} from "../useFemViewportDerivedModel";

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

describe("shouldFlagMissingExactScopeSegment", () => {
  it("does not flag bounds-backed geometry that is not part of the current FEM mesh yet", () => {
    expect(
      shouldFlagMissingExactScopeSegment({
        selectedObjectId: "ring",
        selectedObjectOverlayFidelity: "bounds-backed",
        nElements: 128,
        hasExactScopeSegment: false,
      }),
    ).toBe(false);
  });

  it("flags mesh-backed selections that have no exact FEM segment", () => {
    expect(
      shouldFlagMissingExactScopeSegment({
        selectedObjectId: "ring",
        selectedObjectOverlayFidelity: "mesh-backed",
        nElements: 128,
        hasExactScopeSegment: false,
      }),
    ).toBe(true);
  });
});
