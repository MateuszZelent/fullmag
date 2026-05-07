import { describe, expect, it, vi } from "vitest";

import {
  canExecuteRibbonCommand,
  executeRibbonCommand,
  visualizationPatchFromRibbonCommand,
  type RibbonCommandContext,
} from "../command-registry";

function context(overrides: Partial<RibbonCommandContext> = {}): RibbonCommandContext {
  return {
    selectedObjectId: "obj-1",
    builderEnabled: true,
    onViewChange: vi.fn(),
    ...overrides,
  };
}

describe("ribbon viewport commands", () => {
  it("dispatches mesh transition and optimization through distinct callbacks", () => {
    const onOpenMeshTransitionSettings = vi.fn();
    const onOpenMeshOptimizationSettings = vi.fn();
    const onOpenMeshSizeSettings = vi.fn();
    const onOpenMeshQuality = vi.fn();
    const ctx = context({
      isFemBackend: true,
      onOpenMeshTransitionSettings,
      onOpenMeshOptimizationSettings,
      onOpenMeshSizeSettings,
      onOpenMeshQuality,
    });

    expect(canExecuteRibbonCommand(ctx, { id: "mesh.open-transition" })).toBe(true);
    expect(canExecuteRibbonCommand(ctx, { id: "mesh.open-optimization" })).toBe(true);
    executeRibbonCommand(ctx, { id: "mesh.open-transition" });
    executeRibbonCommand(ctx, { id: "mesh.open-optimization" });

    expect(onOpenMeshTransitionSettings).toHaveBeenCalledTimes(1);
    expect(onOpenMeshOptimizationSettings).toHaveBeenCalledTimes(1);
    expect(onOpenMeshSizeSettings).not.toHaveBeenCalled();
    expect(onOpenMeshQuality).not.toHaveBeenCalled();
  });

  it("keeps component changes independent from vector visibility", () => {
    const onSetPreviewComponent = vi.fn();
    const onSetMeshShowArrows = vi.fn();
    const ctx = context({ onSetPreviewComponent, onSetMeshShowArrows });

    expect(canExecuteRibbonCommand(ctx, { id: "viewport.set-component", component: "3D" })).toBe(true);
    executeRibbonCommand(ctx, { id: "viewport.set-component", component: "3D" });

    expect(onSetPreviewComponent).toHaveBeenCalledWith("3D");
    expect(onSetMeshShowArrows).not.toHaveBeenCalled();
  });

  it("dispatches viewport fit-all through the camera fit callback", () => {
    const onRequestViewportCameraFit = vi.fn();
    const ctx = context({ onRequestViewportCameraFit });

    expect(canExecuteRibbonCommand(ctx, { id: "viewport.fit-all" })).toBe(true);
    executeRibbonCommand(ctx, { id: "viewport.fit-all" });

    expect(onRequestViewportCameraFit).toHaveBeenCalledTimes(1);
  });

  it("maps view ribbon quantity controls to visualization state patches", () => {
    expect(
      visualizationPatchFromRibbonCommand({
        id: "viewport.set-quantity",
        quantityId: "h_eff",
      }),
    ).toEqual({
      quantity: {
        active_quantity_id: "h_eff",
      },
    });

    expect(
      visualizationPatchFromRibbonCommand({
        id: "viewport.set-component",
        component: "x",
      }),
    ).toEqual({
      view_mode: "2d",
      quantity: {
        field_component: "x",
      },
    });

    expect(
      visualizationPatchFromRibbonCommand({
        id: "viewport.set-component",
        component: "3D",
      }),
    ).toEqual({
      view_mode: "3d",
    });
  });

  it("maps vector and sampling controls to visualization state patches", () => {
    expect(
      visualizationPatchFromRibbonCommand({
        id: "viewport.toggle-vectors",
        visible: true,
      }),
    ).toEqual({
      layers: {
        vectors: {
          visible: true,
        },
      },
    });

    expect(
      visualizationPatchFromRibbonCommand({
        id: "viewport.set-vector-max-points",
        maxPoints: 4096,
      }),
    ).toEqual({
      sampling: {
        max_points: 4096,
      },
    });

    expect(
      visualizationPatchFromRibbonCommand({
        id: "viewport.set-vector-style",
        patch: {
          colorMode: "magnitude",
          monoColor: "#ff3366",
          alpha: 0.5,
          lengthScale: 1.25,
          thickness: 2,
          domain: "airbox_only",
          ferromagnetVisibility: "ghost",
        },
      }),
    ).toEqual({
      layers: {
        vectors: {
          domain: "airbox_only",
        },
      },
      vector_style: {
        color_mode: "magnitude",
        mono_color: "#ff3366",
        alpha: 0.5,
        length_scale: 1.25,
        thickness: 2,
        ferromagnet_visibility: "ghost",
      },
    });
  });

  it("prefers canonical visualization patch callback when available", () => {
    const onPatchVisualizationState = vi.fn();
    const onSetMeshShowArrows = vi.fn();
    const ctx = context({ onPatchVisualizationState, onSetMeshShowArrows });

    expect(
      canExecuteRibbonCommand(ctx, {
        id: "viewport.toggle-vectors",
        visible: true,
      }),
    ).toBe(true);
    executeRibbonCommand(ctx, {
      id: "viewport.toggle-vectors",
      visible: true,
    });

    expect(onPatchVisualizationState).toHaveBeenCalledWith({
      layers: {
        vectors: {
          visible: true,
        },
      },
    });
    expect(onSetMeshShowArrows).not.toHaveBeenCalled();
  });

  it("maps 2D slice toolbar commands to canonical visualization slice patches", () => {
    expect(visualizationPatchFromRibbonCommand({
      id: "viewport.set-slice-axis",
      axis: "y",
    })).toEqual({ slice: { axis: "y" } });
    expect(visualizationPatchFromRibbonCommand({
      id: "viewport.set-slice-component",
      component: "z",
    })).toEqual({
      view_mode: "2d",
      slice: { component: "z" },
      quantity: { field_component: "z" },
    });
    expect(visualizationPatchFromRibbonCommand({
      id: "viewport.set-slice-mode",
      mode: "all_layers",
    })).toEqual({ slice: { mode: "all_layers" }, slice_mode: "all" });
    expect(visualizationPatchFromRibbonCommand({
      id: "viewport.set-slice-airbox-vectors",
      visible: true,
    })).toEqual({
      slice: {
        show_airbox_vectors: true,
      },
    });
    expect(visualizationPatchFromRibbonCommand({
      id: "viewport.set-slice-projection-reduction",
      reduction: "rms",
    })).toEqual({ slice: { projection_reduction: "rms" } });
  });

  it("dispatches slice toolbar through visualization state when canonical patching is available", () => {
    const onPatchVisualizationState = vi.fn();
    const onSetSlice2DToolbar = vi.fn();
    const ctx = context({ onPatchVisualizationState, onSetSlice2DToolbar });

    executeRibbonCommand(ctx, {
      id: "viewport.set-slice-airbox-render-mode",
      renderMode: "points",
    });

    expect(onPatchVisualizationState).toHaveBeenCalledWith({
      slice: { airbox_render_mode: "points" },
    });
    expect(onSetSlice2DToolbar).not.toHaveBeenCalled();
  });

  it("keeps FEM clip axis synchronized with canonical slice axis patches", () => {
    const onPatchVisualizationState = vi.fn();
    const onSetSlice2DToolbar = vi.fn();
    const ctx = context({
      isFemBackend: true,
      onPatchVisualizationState,
      onSetSlice2DToolbar,
    });

    executeRibbonCommand(ctx, {
      id: "viewport.set-slice-axis",
      axis: "y",
    });

    expect(onPatchVisualizationState).toHaveBeenCalledWith({
      slice: { axis: "y" },
      clip: { axis: "y" },
    });
    expect(onSetSlice2DToolbar).not.toHaveBeenCalled();
  });

  it("does not change global FEM clip state from slice position patches", () => {
    const onPatchVisualizationState = vi.fn();
    const onSetSlice2DToolbar = vi.fn();
    const ctx = context({
      isFemBackend: true,
      onPatchVisualizationState,
      onSetSlice2DToolbar,
    });

    executeRibbonCommand(ctx, {
      id: "viewport.set-slice-position",
      positionPercent: 35,
    });

    expect(onPatchVisualizationState).toHaveBeenCalledWith({
      slice: { position_percent: 35 },
    });
    expect(onSetSlice2DToolbar).not.toHaveBeenCalled();
  });

  it("keeps projection controls local to the 2D slice toolbar", () => {
    const onSetSlice2DToolbar = vi.fn();
    const ctx = context({ onSetSlice2DToolbar });

    executeRibbonCommand(ctx, {
      id: "viewport.set-slice-projection-reduction",
      reduction: "thickness_integral",
    });
    executeRibbonCommand(ctx, {
      id: "viewport.set-slice-projection-air-zero",
      enabled: true,
    });

    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(1, {
      projectionReduction: "thickness_integral",
    });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(2, {
      projectionIncludeAirAsZero: true,
    });
  });

  it("keeps vector color changes independent from vector visibility", () => {
    const onSetFemArrowStyle = vi.fn();
    const onSetMeshShowArrows = vi.fn();
    const ctx = context({ onSetFemArrowStyle, onSetMeshShowArrows });

    executeRibbonCommand(ctx, {
      id: "viewport.set-vector-style",
      patch: { colorMode: "magnitude" },
    });

    expect(onSetFemArrowStyle).toHaveBeenCalledWith({ colorMode: "magnitude" });
    expect(onSetMeshShowArrows).not.toHaveBeenCalled();
  });

  it("changes vector visibility only through the explicit vector toggle command", () => {
    const onSetMeshShowArrows = vi.fn();
    const ctx = context({ onSetMeshShowArrows });

    executeRibbonCommand(ctx, { id: "viewport.toggle-vectors", visible: false });

    expect(onSetMeshShowArrows).toHaveBeenCalledWith(false);
  });

  it("keeps quantity shader visibility independent from vector visibility", () => {
    const onSetQuantityShaderVisible = vi.fn();
    const onSetMeshShowArrows = vi.fn();
    const ctx = context({ onSetQuantityShaderVisible, onSetMeshShowArrows });

    executeRibbonCommand(ctx, { id: "viewport.toggle-quantity-shader", visible: false });

    expect(onSetQuantityShaderVisible).toHaveBeenCalledWith(false);
    expect(onSetMeshShowArrows).not.toHaveBeenCalled();
  });

  it("dispatches magnetic texture visibility through its own explicit command", () => {
    const onSetMagneticTextureVisible = vi.fn();
    const onSetQuantityShaderVisible = vi.fn();
    const ctx = context({ onSetMagneticTextureVisible, onSetQuantityShaderVisible });

    executeRibbonCommand(ctx, { id: "viewport.toggle-magnetic-texture", visible: false });

    expect(onSetMagneticTextureVisible).toHaveBeenCalledWith(false);
    expect(onSetQuantityShaderVisible).not.toHaveBeenCalled();
  });

  it("dispatches primitive visibility separately from magnetic texture visibility", () => {
    const onSetPrimitiveVisible = vi.fn();
    const onSetMagneticTextureVisible = vi.fn();
    const ctx = context({ onSetPrimitiveVisible, onSetMagneticTextureVisible });

    expect(canExecuteRibbonCommand(ctx, { id: "viewport.toggle-primitives", visible: false })).toBe(true);
    executeRibbonCommand(ctx, { id: "viewport.toggle-primitives", visible: false });

    expect(onSetPrimitiveVisible).toHaveBeenCalledWith(false);
    expect(onSetMagneticTextureVisible).not.toHaveBeenCalled();
  });

  it("passes airbox render options through without touching global mesh render mode", () => {
    const onSetAirboxDisplay = vi.fn();
    const onSetMeshRenderMode = vi.fn();
    const ctx = context({ onSetAirboxDisplay, onSetMeshRenderMode });

    executeRibbonCommand(ctx, {
      id: "viewport.set-airbox-display",
      patch: { renderMode: "points", vectors: true },
    });

    expect(onSetAirboxDisplay).toHaveBeenCalledWith({ renderMode: "points", vectors: true });
    expect(onSetMeshRenderMode).not.toHaveBeenCalled();
  });

  it("routes airbox display through the transactional handler even when canonical patching is available", () => {
    const onPatchVisualizationState = vi.fn();
    const onSetAirboxDisplay = vi.fn();
    const ctx = context({ onPatchVisualizationState, onSetAirboxDisplay });

    executeRibbonCommand(ctx, {
      id: "viewport.set-airbox-display",
      patch: { points: true },
    });

    expect(onSetAirboxDisplay).toHaveBeenCalledWith({ points: true });
    expect(onPatchVisualizationState).not.toHaveBeenCalled();
  });

  it("maps airbox display controls to independent visualization sublayers", () => {
    expect(
      visualizationPatchFromRibbonCommand({
        id: "viewport.set-airbox-display",
        patch: {
          visible: true,
          shaded: true,
          wireframe: true,
          points: true,
          vectors: true,
          opacity: 0.24,
        },
      }),
    ).toEqual({
      layers: {
        airbox: {
          visible: true,
          opacity: 0.24,
          surface: { visible: true },
          wireframe: { visible: true },
          points: { visible: true },
          vectors: { visible: true, domain: "airbox_only" },
        },
      },
    });
  });

  it("maps airbox render mode presets to canonical sublayer presets", () => {
    expect(
      visualizationPatchFromRibbonCommand({
        id: "viewport.set-airbox-display",
        patch: { renderMode: "points" },
      }),
    ).toEqual({
      layers: {
        airbox: {
          surface: { visible: false },
          wireframe: { visible: false },
          points: { visible: true },
        },
      },
    });
  });

  it("dispatches global mesh render mode changes for texture mesh display controls", () => {
    const onSetMeshRenderMode = vi.fn();
    const ctx = context({ onSetMeshRenderMode });

    executeRibbonCommand(ctx, {
      id: "viewport.set-global-render-mode",
      renderMode: "points",
    });

    expect(onSetMeshRenderMode).toHaveBeenCalledWith("points");
  });

  it("dispatches selected render mode changes for object override", () => {
    const onSetSelectedObjectRenderMode = vi.fn();
    const ctx = context({ onSetSelectedObjectRenderMode });

    executeRibbonCommand(ctx, {
      id: "viewport.set-selected-render-mode",
      renderMode: "wireframe",
    });

    expect(onSetSelectedObjectRenderMode).toHaveBeenCalledWith("wireframe");
  });

  it("dispatches selected texture visibility changes for object override", () => {
    const onSetSelectedObjectTextureVisible = vi.fn();
    const ctx = context({ onSetSelectedObjectTextureVisible });

    executeRibbonCommand(ctx, {
      id: "viewport.toggle-selected-texture",
      visible: false,
    });

    expect(onSetSelectedObjectTextureVisible).toHaveBeenCalledWith(false);
  });

  it("requires an override callback for selected render override commands", () => {
    expect(
      canExecuteRibbonCommand(context({ onSetSelectedObjectRenderMode: vi.fn() }), {
        id: "viewport.set-selected-render-mode",
        renderMode: "wireframe",
      }),
    ).toBe(true);
    expect(
      canExecuteRibbonCommand(context({ onSetSelectedObjectRenderMode: undefined }), {
        id: "viewport.set-selected-render-mode",
        renderMode: "inherit",
      }),
    ).toBe(false);
  });

  it("dispatches selected display override clear through callback", () => {
    const onClearSelectedDisplayOverrides = vi.fn();
    const ctx = context({ onClearSelectedDisplayOverrides });

    executeRibbonCommand(ctx, { id: "viewport.clear-selected-display-overrides" });

    expect(onClearSelectedDisplayOverrides).toHaveBeenCalledTimes(1);
  });

  it("hides selected clear when no selected override callback exists", () => {
    expect(canExecuteRibbonCommand(context({ onClearSelectedDisplayOverrides: undefined }), { id: "viewport.clear-selected-display-overrides" })).toBe(false);
  });

  it("dispatches object view mode through its own explicit command", () => {
    const onSetObjectViewMode = vi.fn();
    const onSetSelectedObjectRenderMode = vi.fn();
    const ctx = context({ onSetObjectViewMode, onSetSelectedObjectRenderMode });

    executeRibbonCommand(ctx, { id: "viewport.set-object-view", mode: "isolate" });

    expect(onSetObjectViewMode).toHaveBeenCalledWith("isolate");
    expect(onSetSelectedObjectRenderMode).not.toHaveBeenCalled();
  });

  it("requires an object-view callback for context isolate ribbon commands", () => {
    expect(
      canExecuteRibbonCommand(context({ onSetObjectViewMode: vi.fn() }), {
        id: "viewport.set-object-view",
        mode: "context",
      }),
    ).toBe(true);
    expect(
      canExecuteRibbonCommand(context({ onSetObjectViewMode: undefined }), {
        id: "viewport.set-object-view",
        mode: "isolate",
      }),
    ).toBe(false);
  });

  it("dispatches 2D slice toolbar commands through the slice callback", () => {
    const onSetSlice2DToolbar = vi.fn();
    const ctx = context({ onSetSlice2DToolbar });

    executeRibbonCommand(ctx, { id: "viewport.set-slice-axis", axis: "x" });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-component", component: "z" });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-mode", mode: "slab" });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-position", positionPercent: 42 });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-airbox", visible: true });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-airbox-render-mode", renderMode: "points" });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-airbox-vectors", visible: true });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-render-mode", renderMode: "mesh-overlay" });

    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(1, { axis: "x" });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(2, { component: "z" });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(3, { mode: "slab" });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(4, { positionPercent: 42 });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(5, { showAirbox: true });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(6, { airboxRenderMode: "points" });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(7, {
      showAirboxVectors: true,
    });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(8, {
      renderMode: "mesh-overlay",
      showMesh: true,
      showVectors: false,
    });
  });

  it("requires the 2D slice callback for slice commands", () => {
    expect(
      canExecuteRibbonCommand(context({ onSetSlice2DToolbar: undefined }), {
        id: "viewport.set-slice-mesh",
        visible: true,
      }),
    ).toBe(false);
    expect(
      canExecuteRibbonCommand(context({ onSetSlice2DToolbar: vi.fn() }), {
        id: "viewport.set-slice-mesh",
        visible: true,
      }),
    ).toBe(true);
  });

  it("dispatches workspace panel restore through the dedicated callback", () => {
    const onRestoreWorkspacePanel = vi.fn();
    const ctx = context({ onRestoreWorkspacePanel });

    expect(
      canExecuteRibbonCommand(ctx, {
        id: "workspace.restore-panel",
        panel: "explorer",
      }),
    ).toBe(true);

    executeRibbonCommand(ctx, {
      id: "workspace.restore-panel",
      panel: "telemetry",
    });

    expect(onRestoreWorkspacePanel).toHaveBeenCalledWith("telemetry");
  });

  it("dispatches workspace panel hide through the dedicated callback", () => {
    const onHideWorkspacePanel = vi.fn();
    const ctx = context({ onHideWorkspacePanel });

    expect(
      canExecuteRibbonCommand(ctx, {
        id: "workspace.hide-panel",
        panel: "inspector",
      }),
    ).toBe(true);

    executeRibbonCommand(ctx, {
      id: "workspace.hide-panel",
      panel: "explorer",
    });

    expect(onHideWorkspacePanel).toHaveBeenCalledWith("explorer");
  });
});
