import { describe, expect, it } from "vitest";

import { deriveFemLayerRenderState } from "../viewportLayers";

describe("deriveFemLayerRenderState", () => {
  it("passes through all layers when toggles are enabled", () => {
    const overlays = [{ id: "obj-1" }];
    const result = deriveFemLayerRenderState({
      layers: {
        showPrimitives: true,
        showMesh: true,
        showQuantity: true,
      },
      objectOverlays: overlays,
      meshOpacity: 82,
      colorField: "magnitude",
      showArrows: true,
    });

    expect(result.objectOverlays).toBe(overlays);
    expect(result.meshOpacity).toBe(82);
    expect(result.colorField).toBe("magnitude");
    expect(result.showArrows).toBe(true);
  });

  it("hides primitives and mesh when their layers are disabled", () => {
    const result = deriveFemLayerRenderState({
      layers: {
        showPrimitives: false,
        showMesh: false,
        showQuantity: true,
      },
      objectOverlays: [{ id: "obj-1" }],
      meshOpacity: 90,
      colorField: "x",
      showArrows: true,
    });

    expect(result.objectOverlays).toEqual([]);
    expect(result.meshOpacity).toBe(0);
    expect(result.colorField).toBe("x");
    expect(result.showArrows).toBe(true);
  });

  it("keeps arrows independent when quantity layer is disabled", () => {
    const result = deriveFemLayerRenderState({
      layers: {
        showPrimitives: true,
        showMesh: true,
        showQuantity: false,
      },
      objectOverlays: [{ id: "obj-1" }],
      meshOpacity: 75,
      colorField: "magnitude",
      showArrows: true,
    });

    expect(result.colorField).toBe("none");
    expect(result.showArrows).toBe(true);
  });
});
