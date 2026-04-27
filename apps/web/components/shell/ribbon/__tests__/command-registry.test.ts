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
});
