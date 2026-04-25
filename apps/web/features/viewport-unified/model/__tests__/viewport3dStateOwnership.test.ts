import { describe, expect, it } from "vitest";

import {
  getViewport3DStateOwnership,
  VIEWPORT_3D_STATE_OWNERSHIP,
} from "../viewport3dStateOwnership";

describe("VIEWPORT_3D_STATE_OWNERSHIP", () => {
  it("keeps display state on the resource-first display contract", () => {
    for (const state of [
      "active_quantity",
      "view_mode",
      "field_component",
      "vector_density",
      "slice_layer_mode",
      "colormap_contrast",
    ]) {
      expect(getViewport3DStateOwnership(state)).toMatchObject({
        owner: "display-resource",
        persistence: "runtime-session",
        backendContract: "PATCH /display",
        changesPhysics: false,
      });
    }
  });

  it("keeps render-only, legend, and camera state out of backend physics contracts", () => {
    for (const state of [
      "fem_render_mode",
      "fem_layer_visibility",
      "fem_arrows_visibility",
      "fdm_glyph_voxel_topography",
      "legend_visibility",
      "camera_projection_navigation_preset",
    ]) {
      const ownership = getViewport3DStateOwnership(state);
      expect(ownership?.backendContract).toBeNull();
      expect(ownership?.changesPhysics).toBe(false);
    }
  });

  it("has unique state keys", () => {
    const states = VIEWPORT_3D_STATE_OWNERSHIP.map((entry) => entry.state);
    expect(new Set(states).size).toBe(states.length);
  });
});
