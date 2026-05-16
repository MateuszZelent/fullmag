import { describe, expect, it } from "vitest";

import {
  shouldRenderCanvasVisualActivityProbe,
  shouldRenderVectorSurfaceCanvas,
  shouldRenderViewportWebglCanvas,
} from "../viewportWebglCanvasPolicy";

describe("viewport WebGL canvas policy", () => {
  it("does not render hidden WebGL canvases", () => {
    expect(
      shouldRenderViewportWebglCanvas({
        hidden: true,
        hostReady: true,
        bareCanvas: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderVectorSurfaceCanvas({
        canvasEnabled: true,
        hostReady: true,
        viewportVisible: false,
      }),
    ).toBe(false);
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

  it("does not mount the visual activity readPixels probe when disabled or callbackless", () => {
    expect(
      shouldRenderCanvasVisualActivityProbe({
        enabled: false,
        hasCallback: true,
      }),
    ).toBe(false);
    expect(
      shouldRenderCanvasVisualActivityProbe({
        enabled: true,
        hasCallback: false,
      }),
    ).toBe(false);
    expect(
      shouldRenderCanvasVisualActivityProbe({
        enabled: true,
        hasCallback: true,
      }),
    ).toBe(true);
  });
});
