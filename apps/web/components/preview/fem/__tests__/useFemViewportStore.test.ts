import { afterEach, describe, expect, it } from "vitest";

import {
  femViewportZustandStore,
  femViewportStoreReducer,
  INITIAL_FEM_VIEWPORT_STORE_STATE,
  resetFemViewportZustandStoreForTests,
  type FemViewportStoreAction,
} from "../useFemViewportStore";

function reduce(action: FemViewportStoreAction) {
  return femViewportStoreReducer(INITIAL_FEM_VIEWPORT_STORE_STATE, action);
}

describe("femViewportStoreReducer", () => {
  afterEach(() => {
    resetFemViewportZustandStoreForTests();
  });

  it("updates draw mode without mutating clip or vector state", () => {
    const base = {
      ...INITIAL_FEM_VIEWPORT_STORE_STATE,
      view: {
        ...INITIAL_FEM_VIEWPORT_STORE_STATE.view,
        renderMode: "surface",
        clip: {
          ...INITIAL_FEM_VIEWPORT_STORE_STATE.view.clip,
          enabled: true,
          axis: "z" as const,
          position: 37,
          flip: true,
        },
        arrowsVisible: true,
        vectorDomainFilter: "full_domain" as const,
        shrinkFactor: 0.42,
      },
    };

    const next = femViewportStoreReducer(base, {
      type: "setRenderMode",
      value: "wireframe",
    });

    expect(next.view.renderMode).toBe("wireframe");
    expect(next.view.clip).toEqual(base.view.clip);
    expect(next.view.arrowsVisible).toBe(true);
    expect(next.view.vectorDomainFilter).toBe("full_domain");
    expect(next.view.shrinkFactor).toBe(0.42);
  });

  it("stores clip state updates independently", () => {
    const withEnabled = reduce({ type: "setClipEnabled", value: true });
    const withAxis = femViewportStoreReducer(withEnabled, {
      type: "setClipAxis",
      value: "y",
    });
    const withPosition = femViewportStoreReducer(withAxis, {
      type: "setClipPosition",
      value: 61,
    });
    const withFlip = femViewportStoreReducer(withPosition, {
      type: "setClipFlip",
      value: true,
    });

    expect(withFlip.view.clip).toEqual({
      enabled: true,
      axis: "y",
      position: 61,
      flip: true,
    });
  });

  it("stores vector visibility and runtime counts independently", () => {
    const withVectors = reduce({ type: "setArrowsVisible", value: true });
    const withCount = femViewportStoreReducer(withVectors, {
      type: "setSampledArrowCount",
      value: 512,
    });

    expect(withCount.view.arrowsVisible).toBe(true);
    expect(withCount.runtime.sampledArrowCount).toBe(512);
    expect(withCount.view.renderMode).toBe(INITIAL_FEM_VIEWPORT_STORE_STATE.view.renderMode);
  });

  it("toggles legend state without disturbing draw mode", () => {
    const withLegend = reduce({ type: "setLegendOpen", value: true });

    expect(withLegend.view.legendOpen).toBe(true);
    expect(withLegend.view.renderMode).toBe(INITIAL_FEM_VIEWPORT_STORE_STATE.view.renderMode);
  });

  it("resets selection without touching viewport display state", () => {
    const base = {
      ...INITIAL_FEM_VIEWPORT_STORE_STATE,
      view: {
        ...INITIAL_FEM_VIEWPORT_STORE_STATE.view,
        renderMode: "points" as const,
        legendOpen: true,
      },
      selection: {
        selectedFaceIndices: [1, 4, 8],
        hoveredFaceIndex: 8,
      },
    };

    const next = femViewportStoreReducer(base, { type: "resetSelection" });

    expect(next.selection).toEqual({
      selectedFaceIndices: [],
      hoveredFaceIndex: null,
    });
    expect(next.view.renderMode).toBe("points");
    expect(next.view.legendOpen).toBe(true);
  });

  it("keeps the zustand viewport state outside component mount lifetime", () => {
    const dispatch = femViewportZustandStore.getState().dispatch;

    dispatch({ type: "setRenderMode", value: "points" });
    dispatch({ type: "setClipEnabled", value: true });
    dispatch({ type: "setClipPosition", value: 72 });

    const snapshot = femViewportZustandStore.getState().state;
    expect(snapshot.view.renderMode).toBe("points");
    expect(snapshot.view.clip).toMatchObject({
      enabled: true,
      position: 72,
    });
  });

  it("batches multiple store actions into one state update", () => {
    femViewportZustandStore.getState().dispatchMany([
      { type: "setArrowColorMode", value: "x" },
      { type: "setToolbarArrowColorField", value: "x" },
    ]);

    const snapshot = femViewportZustandStore.getState().state;
    expect(snapshot.view.arrowColorMode).toBe("x");
    expect(snapshot.toolbar.arrowColorField).toBe("x");
  });

  it("hydrates initial values only once so remounts do not wipe user state", () => {
    const store = femViewportZustandStore.getState();
    store.hydrateInitial({
      view: {
        ...INITIAL_FEM_VIEWPORT_STORE_STATE.view,
        renderMode: "wireframe",
      },
    });
    store.dispatch({ type: "setRenderMode", value: "points" });
    store.hydrateInitial({
      view: {
        ...INITIAL_FEM_VIEWPORT_STORE_STATE.view,
        renderMode: "surface",
      },
    });

    expect(femViewportZustandStore.getState().state.view.renderMode).toBe("points");
  });
});
