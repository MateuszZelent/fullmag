import { describe, expect, it } from "vitest";

import { computeArrowRenderState } from "../arrowRenderState";

describe("computeArrowRenderState", () => {
  it("treats requested=false as an explicit user-disabled state", () => {
    const result = computeArrowRenderState({
      requested: false,
      layerEnabled: true,
      missingMagneticMask: false,
      visibleNodeCount: 128,
      hasFieldData: true,
    });

    expect(result.visible).toBe(false);
    expect(result.reason).toBe("requested_off");
  });

  it("renders arrows when request is on and runtime gates pass", () => {
    const result = computeArrowRenderState({
      requested: true,
      layerEnabled: true,
      missingMagneticMask: false,
      visibleNodeCount: 128,
      hasFieldData: true,
    });

    expect(result.visible).toBe(true);
    expect(result.reason).toBeNull();
  });

  it("reports missing_field when field data disappears after the user requested arrows", () => {
    const result = computeArrowRenderState({
      requested: true,
      layerEnabled: true,
      missingMagneticMask: false,
      visibleNodeCount: 128,
      hasFieldData: false,
    });

    expect(result.visible).toBe(false);
    expect(result.reason).toBe("missing_field");
  });
});
