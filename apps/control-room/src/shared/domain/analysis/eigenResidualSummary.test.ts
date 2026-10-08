import { describe, expect, it } from "vitest";

import { buildEigenResidualSummary } from "./eigenResidualSummary";

describe("buildEigenResidualSummary", () => {
  it("falls back to an explicit spectrum relative L2 when the detail mode is absent", () => {
    expect(buildEigenResidualSummary(null, 6e-5, 2e-9)).toEqual({
      absoluteL2: null,
      relativeL2: 2e-9,
      reportedSpectrumResidual: 6e-5,
      scope: "Not available",
    });
  });

  it("preserves mode residual priority and block scope over spectrum fallbacks", () => {
    expect(buildEigenResidualSummary({
      block_residuals: { scope: "native_descriptor" },
      residual_absolute_l2: 3e-7,
      residual_norm: 8e-7,
      residual_relative_l2: 4e-9,
    }, 6e-5, 2e-9)).toEqual({
      absoluteL2: 3e-7,
      relativeL2: 4e-9,
      reportedSpectrumResidual: 6e-5,
      scope: "Full native descriptor",
    });
  });

  it("keeps legacy residual_norm as absolute L2 and does not treat it as relative", () => {
    expect(buildEigenResidualSummary({ residual_norm: 8e-7 }, 6e-5)).toEqual({
      absoluteL2: 8e-7,
      relativeL2: null,
      reportedSpectrumResidual: 6e-5,
      scope: "Not available",
    });
  });

  it.each([null, Number.NaN, Number.POSITIVE_INFINITY, -1, "2e-9"])(
    "does not expose a missing or invalid spectrum relative L2 (%s)",
    (spectrumRelativeL2) => {
      expect(buildEigenResidualSummary(null, 6e-5, spectrumRelativeL2).relativeL2)
        .toBeNull();
    },
  );

  it("preserves zero as a valid relative L2 value", () => {
    expect(buildEigenResidualSummary(null, null, 0).relativeL2).toBe(0);
  });
});
