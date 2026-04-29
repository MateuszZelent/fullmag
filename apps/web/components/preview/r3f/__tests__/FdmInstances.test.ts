import { describe, expect, it } from "vitest";
import { resolveFdmMaterialOpacity } from "../FdmInstances";

describe("resolveFdmMaterialOpacity", () => {
  it("combines voxel opacity with scene opacity for voxel mode", () => {
    expect(
      resolveFdmMaterialOpacity({
        mode: "voxel",
        voxelOpacity: 0.5,
        sceneOpacityMultiplier: 0.8,
      }),
    ).toEqual({
      effectiveOpacity: 0.4,
      transparent: true,
    });
  });

  it("uses only scene opacity for vector glyph modes", () => {
    expect(
      resolveFdmMaterialOpacity({
        mode: "glyph",
        voxelOpacity: 0.25,
        sceneOpacityMultiplier: 1,
      }),
    ).toEqual({
      effectiveOpacity: 1,
      transparent: false,
    });
  });

  it("uses geometry preview opacity when vectors are absent", () => {
    expect(
      resolveFdmMaterialOpacity({
        mode: "voxel",
        voxelOpacity: 0.2,
        sceneOpacityMultiplier: 0.5,
        geometryPreviewOpacity: 0.85,
      }),
    ).toEqual({
      effectiveOpacity: 0.425,
      transparent: true,
    });
  });
});
