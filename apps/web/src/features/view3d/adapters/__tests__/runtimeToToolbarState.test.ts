import { describe, expect, it } from "vitest";

import { runtimeToViewport3DToolbarState } from "../runtimeToToolbarState";

describe("runtimeToViewport3DToolbarState", () => {
  it("enables controls when runtime has required data and capabilities", () => {
    const state = runtimeToViewport3DToolbarState({
      capabilities: {
        can_render_3d: true,
        can_show_topology: true,
        can_show_structured_grid: true,
        can_show_vectors: true,
        can_show_scalar_history: true,
        algorithms_available: ["rk45"],
      },
      has_topology: true,
      has_field_data: true,
    });

    expect(state).toEqual({
      quantity_enabled: true,
      component_enabled: true,
      clip_enabled: true,
      render_mode_enabled: true,
      reasons: {
        quantity: null,
        component: null,
        clip: null,
        render_mode: null,
      },
    });
  });

  it("returns disabled flags with canonical reasons when prerequisites are missing", () => {
    const state = runtimeToViewport3DToolbarState({
      capabilities: {
        can_render_3d: false,
        can_show_topology: false,
        can_show_structured_grid: false,
        can_show_vectors: false,
        can_show_scalar_history: false,
        algorithms_available: [],
      },
      has_topology: false,
      has_field_data: false,
    });

    expect(state.quantity_enabled).toBe(false);
    expect(state.component_enabled).toBe(false);
    expect(state.clip_enabled).toBe(false);
    expect(state.render_mode_enabled).toBe(false);
    expect(state.reasons).toEqual({
      quantity: "field data unavailable",
      component: "vector components unsupported",
      clip: "topology unavailable",
      render_mode: "3d preview unavailable",
    });
  });
});
