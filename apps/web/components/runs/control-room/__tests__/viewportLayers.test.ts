import { describe, expect, it } from "vitest";

import { deriveFemLayerRenderState } from "../viewportLayers";

describe("deriveFemLayerRenderState", () => {
  it("passes through all layers when toggles are enabled", () => {
    const overlays = [{ id: "obj-1" }];
    const result = deriveFemLayerRenderState({
      layers: {
        showPrimitives: true,
        showMesh: true,
        showMagneticTexture: true,
        showQuantity: true,
      },
      objectOverlays: overlays,
      meshOpacity: 82,
      colorField: "magnitude",
      magneticTextureColorField: "orientation",
      showArrows: true,
    });

    expect(result.objectOverlays).toBe(overlays);
    expect(result.meshOpacity).toBe(82);
    expect(result.magneticColorField).toBe("magnitude");
    expect(result.airColorField).toBe("magnitude");
    expect(result.showArrows).toBe(true);
  });

  it("hides primitives and mesh when their layers are disabled", () => {
    const result = deriveFemLayerRenderState({
      layers: {
        showPrimitives: false,
        showMesh: false,
        showMagneticTexture: true,
        showQuantity: true,
      },
      objectOverlays: [{ id: "obj-1" }],
      meshOpacity: 90,
      colorField: "x",
      magneticTextureColorField: "orientation",
      showArrows: true,
    });

    expect(result.objectOverlays).toEqual([]);
    expect(result.meshOpacity).toBe(0);
    expect(result.magneticColorField).toBe("x");
    expect(result.airColorField).toBe("x");
    expect(result.showArrows).toBe(true);
  });

  it("keeps arrows independent and falls back to magnetic texture when quantity layer is disabled", () => {
    const result = deriveFemLayerRenderState({
      layers: {
        showPrimitives: true,
        showMesh: true,
        showMagneticTexture: true,
        showQuantity: false,
      },
      objectOverlays: [{ id: "obj-1" }],
      meshOpacity: 75,
      colorField: "magnitude",
      magneticTextureColorField: "orientation",
      showArrows: true,
    });

    expect(result.magneticColorField).toBe("orientation");
    expect(result.airColorField).toBe("none");
    expect(result.showArrows).toBe(true);
  });

  it("can fully disable ferromagnet shader coloring when both texture and quantity are hidden", () => {
    const result = deriveFemLayerRenderState({
      layers: {
        showPrimitives: true,
        showMesh: true,
        showMagneticTexture: false,
        showQuantity: false,
      },
      objectOverlays: [{ id: "obj-1" }],
      meshOpacity: 75,
      colorField: "magnitude",
      magneticTextureColorField: "none",
      showArrows: true,
    });

    expect(result.magneticColorField).toBe("none");
    expect(result.airColorField).toBe("none");
    expect(result.showArrows).toBe(true);
  });
});
