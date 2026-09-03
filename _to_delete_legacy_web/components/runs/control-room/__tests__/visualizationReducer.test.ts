import { describe, expect, it } from "vitest";

import {
  applyVisualizationAction,
  NO_INVALIDATION,
  type SliceState,
} from "../visualizationReducer";

const BASE_STATE: SliceState = {
  visible: true,
  layer: 0,
  mode: "single",
  airboxVisible: false,
  renderMode: "heatmap",
  sync2D3D: false,
};

describe("applyVisualizationAction", () => {
  // ── airbox.setVisible2D ─────────────────────────────────────────────────────

  it("airbox.setVisible2D true → airboxVisible becomes true", () => {
    const { state } = applyVisualizationAction(BASE_STATE, {
      type: "airbox.setVisible2D",
      visible: true,
    });
    expect(state.airboxVisible).toBe(true);
  });

  it("airbox.setVisible2D false → airboxVisible becomes false", () => {
    const initial: SliceState = { ...BASE_STATE, airboxVisible: true };
    const { state } = applyVisualizationAction(initial, {
      type: "airbox.setVisible2D",
      visible: false,
    });
    expect(state.airboxVisible).toBe(false);
  });

  it("airbox.setVisible2D returns NO_INVALIDATION — no 3D geometry rebuild", () => {
    const { invalidation } = applyVisualizationAction(BASE_STATE, {
      type: "airbox.setVisible2D",
      visible: true,
    });
    expect(invalidation).toEqual(NO_INVALIDATION);
    // Explicit assertions: the flags that guard expensive 3D work must be false.
    expect(invalidation.topology).toBe(false);
    expect(invalidation.surfaceGeometry).toBe(false);
    expect(invalidation.edgeGeometry).toBe(false);
    expect(invalidation.pointGeometry).toBe(false);
    expect(invalidation.vectorSampling).toBe(false);
    expect(invalidation.vectorMatrices).toBe(false);
  });

  it("airbox.setVisible2D does not mutate other SliceState fields", () => {
    const { state } = applyVisualizationAction(BASE_STATE, {
      type: "airbox.setVisible2D",
      visible: true,
    });
    expect(state.visible).toBe(BASE_STATE.visible);
    expect(state.layer).toBe(BASE_STATE.layer);
    expect(state.mode).toBe(BASE_STATE.mode);
    expect(state.renderMode).toBe(BASE_STATE.renderMode);
    expect(state.sync2D3D).toBe(BASE_STATE.sync2D3D);
  });

  // ── slice.patch ─────────────────────────────────────────────────────────────

  it("slice.patch updates matching fields", () => {
    const { state } = applyVisualizationAction(BASE_STATE, {
      type: "slice.patch",
      patch: { renderMode: "vectors", layer: 3 },
    });
    expect(state.renderMode).toBe("vectors");
    expect(state.layer).toBe(3);
  });

  it("slice.patch returns NO_INVALIDATION", () => {
    const { invalidation } = applyVisualizationAction(BASE_STATE, {
      type: "slice.patch",
      patch: { visible: false },
    });
    expect(invalidation).toEqual(NO_INVALIDATION);
  });

  // ── Unknown / 3D-only actions ───────────────────────────────────────────────

  it("airbox.setVisible3D returns unchanged state with NO_INVALIDATION", () => {
    const { state, invalidation } = applyVisualizationAction(BASE_STATE, {
      type: "airbox.setVisible3D",
      visible: true,
    });
    expect(state).toBe(BASE_STATE);
    expect(invalidation).toEqual(NO_INVALIDATION);
  });

  it("vectors.setVisible returns unchanged state with NO_INVALIDATION", () => {
    const { state, invalidation } = applyVisualizationAction(BASE_STATE, {
      type: "vectors.setVisible",
      layer: "magnetic",
      visible: true,
    });
    expect(state).toBe(BASE_STATE);
    expect(invalidation).toEqual(NO_INVALIDATION);
  });
});
