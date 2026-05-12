import { describe, expect, it } from "vitest";
import {
  shouldRenderViewportWebglCanvas,
} from "../ScientificViewportShell";

describe("shouldRenderViewportWebglCanvas", () => {
  it("does not keep a WebGL canvas mounted for hidden viewports", () => {
    expect(
      shouldRenderViewportWebglCanvas({
        hidden: true,
        hostReady: true,
        bareCanvas: false,
      }),
    ).toBe(false);
    expect(
      shouldRenderViewportWebglCanvas({
        hidden: true,
        hostReady: false,
        bareCanvas: true,
      }),
    ).toBe(false);
  });

  it("renders visible canvases only when the event host is ready unless bare shell is forced", () => {
    expect(
      shouldRenderViewportWebglCanvas({
        hidden: false,
        hostReady: false,
        bareCanvas: false,
      }),
    ).toBe(false);
    expect(
      shouldRenderViewportWebglCanvas({
        hidden: false,
        hostReady: false,
        bareCanvas: true,
      }),
    ).toBe(true);
    expect(
      shouldRenderViewportWebglCanvas({
        hidden: false,
        hostReady: true,
        bareCanvas: false,
      }),
    ).toBe(true);
  });
});
