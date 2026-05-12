import { describe, expect, it } from "vitest";

import { resolveViewportFrameloop } from "../viewportFrameloopPolicy";

describe("resolveViewportFrameloop", () => {
  it("pauses hidden or explicitly paused viewports", () => {
    expect(resolveViewportFrameloop({ hidden: true, renderMode: "always" })).toBe("never");
    expect(resolveViewportFrameloop({ hidden: false, renderMode: "paused" })).toBe("never");
  });

  it("uses always for active interactions or an always diagnostic override", () => {
    expect(resolveViewportFrameloop({ hidden: false, renderMode: "always" })).toBe("always");
    expect(
      resolveViewportFrameloop({
        hidden: false,
        renderMode: "demand",
        forcedFrameloopMode: "always",
      }),
    ).toBe("always");
  });

  it("uses never for the diagnostic override unless hidden was already handled", () => {
    expect(
      resolveViewportFrameloop({
        hidden: false,
        renderMode: "demand",
        forcedFrameloopMode: "never",
      }),
    ).toBe("never");
  });

  it("defaults visible viewports to demand rendering", () => {
    expect(resolveViewportFrameloop({ hidden: false })).toBe("demand");
  });
});
