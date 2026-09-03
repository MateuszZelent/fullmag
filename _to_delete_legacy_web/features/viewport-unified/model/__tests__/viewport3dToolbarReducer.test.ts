import { describe, expect, it } from "vitest";

import {
  createViewport3DToolbarState,
  viewport3dToolbarReducer,
} from "../viewport3dToolbarReducer";

describe("viewport3dToolbarReducer", () => {
  it("updates row A state and keeps values clamped", () => {
    const initial = createViewport3DToolbarState();
    const withRenderMode = viewport3dToolbarReducer(initial, {
      type: "setRenderMode",
      value: "shaded+wireframe",
    });
    const withOpacity = viewport3dToolbarReducer(withRenderMode, {
      type: "setOpacity",
      value: 200,
    });
    const withClipPosition = viewport3dToolbarReducer(withOpacity, {
      type: "setClipPosition",
      value: -5,
    });

    expect(withRenderMode.rowA.renderMode).toBe("shaded+wireframe");
    expect(withOpacity.rowA.opacity).toBe(100);
    expect(withClipPosition.rowA.clipPosition).toBe(0);
  });

  it("updates row B interaction/snap/object view", () => {
    const initial = createViewport3DToolbarState();
    const next = viewport3dToolbarReducer(
      viewport3dToolbarReducer(
        viewport3dToolbarReducer(initial, {
          type: "setInteractionMode",
          value: "move",
        }),
        { type: "setSnapEnabled", value: true },
      ),
      { type: "setObjectView", value: "isolate" },
    );

    expect(next.rowB.interactionMode).toBe("move");
    expect(next.rowB.snapEnabled).toBe(true);
    expect(next.rowB.objectView).toBe("isolate");
  });

  it("toggles popovers and flips clip direction", () => {
    const initial = createViewport3DToolbarState({
      rowA: { clipFlip: 1 },
    });
    const withPopover = viewport3dToolbarReducer(initial, {
      type: "togglePopover",
      key: "vectors",
    });
    const flipped = viewport3dToolbarReducer(withPopover, { type: "flipClip" });

    expect(withPopover.popovers.vectors).toBe(true);
    expect(flipped.rowA.clipFlip).toBe(-1);
  });

  it("updates vector glyph visibility independently from quantity visibility", () => {
    const initial = createViewport3DToolbarState();
    const hidden = viewport3dToolbarReducer(initial, {
      type: "setVectorsVisible",
      value: false,
    });
    const visible = viewport3dToolbarReducer(hidden, {
      type: "setVectorsVisible",
      value: true,
    });

    expect(hidden.rowB.vectorsVisible).toBe(false);
    expect(hidden.rowA.showQuantity).toBe(true);
    expect(hidden.rowA.showMagneticTexture).toBe(true);
    expect(visible.rowB.vectorsVisible).toBe(true);
  });

  it("lets magnetic texture visibility change independently from quantity visibility", () => {
    const initial = createViewport3DToolbarState();
    const hiddenTexture = viewport3dToolbarReducer(initial, {
      type: "setLayerVisibility",
      layer: "magneticTexture",
      value: false,
    });

    expect(hiddenTexture.rowA.showMagneticTexture).toBe(false);
    expect(hiddenTexture.rowA.showQuantity).toBe(true);
  });
});
