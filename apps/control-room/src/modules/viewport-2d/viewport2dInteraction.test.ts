import { describe, expect, it } from "vitest";

import {
  DEFAULT_VIEWPORT_2D_INTERACTION,
  panViewport2DInteraction,
  resetViewport2DInteraction,
  zoomViewport2DInteraction,
} from "./viewport2dInteraction";

describe("viewport2dInteraction", () => {
  it("zooms in from negative wheel movement and clamps at the maximum scale", () => {
    const zoomed = zoomViewport2DInteraction(
      DEFAULT_VIEWPORT_2D_INTERACTION,
      -100,
    );
    const clamped = zoomViewport2DInteraction({ ...zoomed, scale: 100 }, -100);

    expect(zoomed.scale).toBeGreaterThan(DEFAULT_VIEWPORT_2D_INTERACTION.scale);
    expect(clamped.scale).toBe(16);
  });

  it("zooms out from positive wheel movement and clamps at the minimum scale", () => {
    const zoomed = zoomViewport2DInteraction(
      DEFAULT_VIEWPORT_2D_INTERACTION,
      100,
    );
    const clamped = zoomViewport2DInteraction(
      { ...zoomed, scale: 0.001 },
      100,
    );

    expect(zoomed.scale).toBeLessThan(DEFAULT_VIEWPORT_2D_INTERACTION.scale);
    expect(clamped.scale).toBe(0.25);
  });

  it("converts pointer movement pixels into normalized viewport offsets", () => {
    const panned = panViewport2DInteraction(
      DEFAULT_VIEWPORT_2D_INTERACTION,
      50,
      -25,
      200,
    );

    expect(panned).toEqual({ offsetX: 0.5, offsetY: 0.25, scale: 1 });
  });

  it("resets local interaction to the default fit state", () => {
    expect(resetViewport2DInteraction()).toBe(DEFAULT_VIEWPORT_2D_INTERACTION);
  });
});
