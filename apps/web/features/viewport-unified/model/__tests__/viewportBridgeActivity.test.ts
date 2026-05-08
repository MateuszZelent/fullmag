import { describe, expect, it } from "vitest";

import { resolveViewportBridgeActivity } from "../viewportBridgeActivity";

describe("resolveViewportBridgeActivity", () => {
  it("disables heavy data paths when bridge is inactive", () => {
    expect(
      resolveViewportBridgeActivity({
        active: false,
        viewportMode: "3D",
        showArrows: true,
        showQuantity: true,
        showMagneticTexture: true,
        selectedQuantity: "m",
        sliceApiFeatureEnabled: true,
        sliceTopologyReady: true,
      }),
    ).toEqual({
      data3DActive: false,
      glyphVectorDataNeeded: false,
      shaderFieldDataNeeded: false,
      slice2DActive: false,
    });
  });

  it("keeps 3D vector and shader paths off in 2D mode", () => {
    expect(
      resolveViewportBridgeActivity({
        active: true,
        viewportMode: "2D",
        showArrows: true,
        showQuantity: true,
        showMagneticTexture: true,
        selectedQuantity: "m",
        sliceApiFeatureEnabled: true,
        sliceTopologyReady: true,
      }),
    ).toMatchObject({
      data3DActive: false,
      glyphVectorDataNeeded: false,
      shaderFieldDataNeeded: false,
      slice2DActive: true,
    });
  });

  it("keeps 2D slice path off in 3D mode", () => {
    expect(
      resolveViewportBridgeActivity({
        active: true,
        viewportMode: "3D",
        showArrows: false,
        showQuantity: false,
        showMagneticTexture: false,
        selectedQuantity: "m",
        sliceApiFeatureEnabled: true,
        sliceTopologyReady: true,
      }),
    ).toMatchObject({
      data3DActive: true,
      glyphVectorDataNeeded: false,
      shaderFieldDataNeeded: false,
      slice2DActive: false,
    });
  });

  it("enables glyph and shader vector data for arrows in Mesh mode", () => {
    expect(
      resolveViewportBridgeActivity({
        active: true,
        viewportMode: "Mesh",
        showArrows: true,
        showQuantity: false,
        showMagneticTexture: false,
        selectedQuantity: "m",
        sliceApiFeatureEnabled: true,
        sliceTopologyReady: true,
      }),
    ).toMatchObject({
      data3DActive: true,
      glyphVectorDataNeeded: true,
      shaderFieldDataNeeded: true,
      slice2DActive: false,
    });
  });

  it("uses magnetic texture shader data only for magnetization quantity", () => {
    expect(
      resolveViewportBridgeActivity({
        active: true,
        viewportMode: "3D",
        showArrows: false,
        showQuantity: false,
        showMagneticTexture: true,
        selectedQuantity: "m",
        sliceApiFeatureEnabled: false,
        sliceTopologyReady: true,
      }).shaderFieldDataNeeded,
    ).toBe(true);

    expect(
      resolveViewportBridgeActivity({
        active: true,
        viewportMode: "3D",
        showArrows: false,
        showQuantity: false,
        showMagneticTexture: true,
        selectedQuantity: "H",
        sliceApiFeatureEnabled: false,
        sliceTopologyReady: true,
      }).shaderFieldDataNeeded,
    ).toBe(false);
  });

  it("keeps Analyze mode dormant for viewport data", () => {
    expect(
      resolveViewportBridgeActivity({
        active: true,
        viewportMode: "Analyze",
        showArrows: true,
        showQuantity: true,
        showMagneticTexture: true,
        selectedQuantity: "m",
        sliceApiFeatureEnabled: true,
        sliceTopologyReady: true,
      }),
    ).toMatchObject({
      data3DActive: false,
      glyphVectorDataNeeded: false,
      shaderFieldDataNeeded: false,
      slice2DActive: false,
    });
  });
});
