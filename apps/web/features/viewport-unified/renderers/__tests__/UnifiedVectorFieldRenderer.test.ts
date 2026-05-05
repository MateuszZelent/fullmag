import { describe, expect, it } from "vitest";

import { shouldRenderVectorSurfaceCanvas } from "../UnifiedVectorFieldRenderer";

describe("shouldRenderVectorSurfaceCanvas", () => {
  it("does not keep a VectorSurface WebGL canvas mounted when hidden", () => {
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: true,
        hostReady: true,
        viewportVisible: false,
      }),
    ).toBe(false);
  });

  it("renders only when the canvas feature, event host, and visible viewport are all active", () => {
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: false,
        hostReady: true,
        viewportVisible: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: true,
        hostReady: false,
        viewportVisible: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: true,
        hostReady: true,
        viewportVisible: true,
      }),
    ).toBe(true);
  });
});
