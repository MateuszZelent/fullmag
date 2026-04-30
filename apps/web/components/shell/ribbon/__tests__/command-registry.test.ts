import { describe, expect, it, vi } from "vitest";

import {
  canExecuteRibbonCommand,
  executeRibbonCommand,
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
    executeRibbonCommand(ctx, { id: "viewport.set-slice-mode", mode: "slab" });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-position", positionPercent: 42 });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-airbox", visible: true });
    executeRibbonCommand(ctx, { id: "viewport.set-slice-render-mode", renderMode: "mesh-overlay" });

    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(1, { axis: "x" });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(2, { mode: "slab" });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(3, { positionPercent: 42 });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(4, { showAirbox: true });
    expect(onSetSlice2DToolbar).toHaveBeenNthCalledWith(5, {
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
});
