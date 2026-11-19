import { describe, expect, it } from "vitest";

import { EXPORT_3D_INACTIVE_REGION_ID } from "./export3dTypes";
import {
  buildSurfaceFeatureEdgePositions,
  computeFdmCellCentersM,
  extractVoxelExteriorShell,
} from "./export3dVoxelShell";

describe("export3dVoxelShell", () => {
  it("extracts 6 outward-wound faces for a single voxel cell", () => {
    const shell = extractVoxelExteriorShell({
      gridShape: [1, 1, 1],
      cellSizeM: [10e-9, 20e-9, 5e-9],
      originM: [-5e-9, -10e-9, 0],
    });

    expect(shell.activeCellCount).toBe(1);
    expect(shell.faceCount).toBe(6);
    expect(shell.vertexCount).toBe(24);
    expect(shell.triangleCount).toBe(12);
    expect(Array.from(shell.vertexCellIndices).every((c) => c === 0)).toBe(true);
    expect(shell.boundsMinM[0]).toBeCloseTo(-5e-9, 14);
    expect(shell.boundsMaxM[0]).toBeCloseTo(5e-9, 14);
    expect(shell.boundsMinM[1]).toBeCloseTo(-10e-9, 14);
    expect(shell.boundsMaxM[1]).toBeCloseTo(10e-9, 14);

    // Every triangle's geometric cross-product normal must agree with stored outward normal.
    for (let t = 0; t < shell.triangleCount; t += 1) {
      const i0 = shell.indices[t * 3]!;
      const i1 = shell.indices[t * 3 + 1]!;
      const i2 = shell.indices[t * 3 + 2]!;
      const ax = shell.positionsM[i0 * 3]!;
      const ay = shell.positionsM[i0 * 3 + 1]!;
      const az = shell.positionsM[i0 * 3 + 2]!;
      const abx = shell.positionsM[i1 * 3]! - ax;
      const aby = shell.positionsM[i1 * 3 + 1]! - ay;
      const abz = shell.positionsM[i1 * 3 + 2]! - az;
      const acx = shell.positionsM[i2 * 3]! - ax;
      const acy = shell.positionsM[i2 * 3 + 1]! - ay;
      const acz = shell.positionsM[i2 * 3 + 2]! - az;
      const cx = aby * acz - abz * acy;
      const cy = abz * acx - abx * acz;
      const cz = abx * acy - aby * acx;
      const nx = shell.normals[i0 * 3]!;
      const ny = shell.normals[i0 * 3 + 1]!;
      const nz = shell.normals[i0 * 3 + 2]!;
      expect(cx * nx + cy * ny + cz * nz).toBeGreaterThan(0);
    }
  });

  it("culls interior faces on dense lattices and exposes internal voids from activeMask/regionIds", () => {
    const dense = extractVoxelExteriorShell({
      gridShape: [2, 2, 2],
      cellSizeM: [1e-9, 1e-9, 1e-9],
    });
    expect(dense.activeCellCount).toBe(8);
    expect(dense.faceCount).toBe(24);
    expect(dense.triangleCount).toBe(48);

    // 3x3x1 ring with center cell (index 4) inactive -> 8 active cells,
    // top/bottom = 16 faces, outer perimeter = 12 faces, inner hole = 4 faces -> 32 faces.
    const ringMask = new Uint8Array([1, 1, 1, 1, 0, 1, 1, 1, 1]);
    const ring = extractVoxelExteriorShell({
      gridShape: [3, 3, 1],
      cellSizeM: [2e-9, 2e-9, 2e-9],
      activeMask: ringMask,
    });
    expect(ring.activeCellCount).toBe(8);
    expect(ring.faceCount).toBe(32);
    expect(Array.from(ring.vertexCellIndices)).not.toContain(4);

    // Verify regionIds inactive sentinel produces identical shell.
    const regionIds = new Uint32Array([0, 1, 1, 0, EXPORT_3D_INACTIVE_REGION_ID, 2, 2, 0, 1]);
    const ringByRegion = extractVoxelExteriorShell({
      gridShape: [3, 3, 1],
      cellSizeM: [2e-9, 2e-9, 2e-9],
      regionIds,
    });
    expect(ringByRegion.faceCount).toBe(32);
    expect(ringByRegion.activeCellCount).toBe(8);
  });

  it("handles empty masks, computes cell centers, and strips coplanar diagonals from wireframe edges", () => {
    const empty = extractVoxelExteriorShell({
      gridShape: [2, 2, 1],
      cellSizeM: [1e-9, 1e-9, 1e-9],
      activeMask: [0, 0, 0, 0],
    });
    expect(empty.faceCount).toBe(0);
    expect(empty.vertexCount).toBe(0);

    const centers = computeFdmCellCentersM(
      [2, 1, 1],
      [10e-9, 10e-9, 10e-9],
      [0, 0, 0],
    );
    expect(centers[0]).toBeCloseTo(5e-9, 14);
    expect(centers[3]).toBeCloseTo(15e-9, 14);

    const cube = extractVoxelExteriorShell({
      gridShape: [1, 1, 1],
      cellSizeM: [1, 1, 1],
    });
    const featureEdges = buildSurfaceFeatureEdgePositions(
      cube.positionsM,
      cube.indices,
    );
    // Single cube has 12 sharp feature edges (6 floats per segment) -> 72 floats; diagonals excluded.
    expect(featureEdges.length).toBe(12 * 6);
  });

  it("throws explicit RangeError on invalid grid dimensions or mismatched mask lengths", () => {
    expect(() =>
      extractVoxelExteriorShell({
        gridShape: [0, 2, 2],
        cellSizeM: [1, 1, 1],
      }),
    ).toThrow(RangeError);
    expect(() =>
      extractVoxelExteriorShell({
        gridShape: [2, 2, 1],
        cellSizeM: [1, 1, 1],
        activeMask: [1, 1],
      }),
    ).toThrow(RangeError);
  });
});
