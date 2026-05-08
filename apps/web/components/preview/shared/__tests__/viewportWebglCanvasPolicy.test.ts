import { describe, expect, it } from "vitest";

import {
  shouldRenderVectorSurfaceCanvas,
  shouldRenderViewportWebglCanvas,
} from "../viewportWebglCanvasPolicy";

describe("viewport WebGL canvas policy", () => {
  it("keeps hidden WebGL canvases mounted so frameloop can pause without losing GPU state", () => {
    expect(
      shouldRenderViewportWebglCanvas({
        hidden: true,
        hostReady: true,
        bareCanvas: true,
      }),
    ).toBe(true);
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: true,
        hostReady: true,
        viewportVisible: false,
      }),
    ).toBe(true);
  });

  it("shares the same host readiness gate for shell and vector surface canvases", () => {
    expect(
      shouldRenderViewportWebglCanvas({
        hidden: false,
        hostReady: false,
        bareCanvas: false,
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
