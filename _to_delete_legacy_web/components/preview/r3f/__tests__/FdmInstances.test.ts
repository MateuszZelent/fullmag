import { describe, expect, it } from "vitest";
import {
  FDM_INSTANCE_ANIMATION_BYTE_BUDGET,
  estimateFdmInstanceAnimationSnapshotBytes,
  resolveFdmGridBounds,
  resolveFdmInstanceLifecycleEvent,
  resolveFdmMaterialOpacity,
  shouldAnimateFdmInstanceBuffers,
} from "../FdmInstances";

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

describe("resolveFdmGridBounds", () => {
  it("clamps isolate bounds to the grid", () => {
    expect(
      resolveFdmGridBounds(
        [8, 6, 4],
        { minIx: -2.1, maxIx: 3.2, minIy: 1.1, maxIy: 99, minIz: 0, maxIz: 2.4 },
      ),
    ).toEqual({
      minIx: 0,
      maxIx: 4,
      minIy: 1,
      maxIy: 5,
      minIz: 0,
      maxIz: 3,
      empty: false,
    });
  });

  it("marks non-overlapping bounds as empty", () => {
    expect(
      resolveFdmGridBounds(
        [8, 6, 4],
        { minIx: 9, maxIx: 10, minIy: 0, maxIy: 1, minIz: 0, maxIz: 1 },
      ).empty,
    ).toBe(true);
  });
});

describe("FDM instance animation budget", () => {
  it("estimates matrix and color snapshot bytes", () => {
    expect(
      estimateFdmInstanceAnimationSnapshotBytes({
        visible: 10,
        includeMatrices: true,
      }),
    ).toBe((10 * 16 + 10 * 3) * Float32Array.BYTES_PER_ELEMENT * 2);
  });

  it("allows stable small instance transitions", () => {
    expect(
      shouldAnimateFdmInstanceBuffers({
        previousVisible: 100,
        visible: 100,
        renderSignatureMatches: true,
        includeMatrices: true,
      }),
    ).toBe(true);
  });

  it("blocks transitions before large snapshots are created", () => {
    expect(
      shouldAnimateFdmInstanceBuffers({
        previousVisible: 1_000_000,
        visible: 1_000_000,
        renderSignatureMatches: true,
        includeMatrices: true,
      }),
    ).toBe(false);
  });

  it("honors explicit byte budgets for color-only patches", () => {
    expect(
      shouldAnimateFdmInstanceBuffers({
        previousVisible: 1_000,
        visible: 1_000,
        renderSignatureMatches: true,
        includeMatrices: false,
        byteBudget: 1,
      }),
    ).toBe(false);
    expect(
      shouldAnimateFdmInstanceBuffers({
        previousVisible: 1_000,
        visible: 1_000,
        renderSignatureMatches: true,
        includeMatrices: false,
        byteBudget: FDM_INSTANCE_ANIMATION_BYTE_BUDGET,
      }),
    ).toBe(true);
  });
});

describe("resolveFdmInstanceLifecycleEvent", () => {
  it("classifies render signature changes as topology rebuilds", () => {
    expect(resolveFdmInstanceLifecycleEvent(null, "voxel:field:1")).toBe("topology_rebuild");
    expect(resolveFdmInstanceLifecycleEvent("voxel:field:1", "voxel:field:2")).toBe(
      "topology_rebuild",
    );
  });

  it("classifies same-signature vector updates as field buffer updates", () => {
    expect(resolveFdmInstanceLifecycleEvent("voxel:field:1", "voxel:field:1")).toBe(
      "field_buffer_update",
    );
  });
});
