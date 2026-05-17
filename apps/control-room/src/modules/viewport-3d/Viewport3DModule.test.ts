import { describe, expect, it } from "vitest";

import { resolveViewport3DMeshQualityLegend } from "./Viewport3DModule";

describe("resolveViewport3DMeshQualityLegend", () => {
  it("describes the active mesh quality metric and range", () => {
    expect(
      resolveViewport3DMeshQualityLegend(true, "sicn", {
        max: 0.92,
        min: 0.17,
      }),
    ).toBe("Mesh quality SICN 0.17 to 0.92");
  });

  it("stays hidden when the overlay is inactive or the range is missing", () => {
    expect(resolveViewport3DMeshQualityLegend(false, "gamma", { max: 1, min: 0 }))
      .toBeNull();
    expect(resolveViewport3DMeshQualityLegend(true, "gamma", null)).toBeNull();
  });
});
