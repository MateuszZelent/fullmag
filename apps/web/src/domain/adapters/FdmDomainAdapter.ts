/**
 * FDM domain adapter.
 * Builds cell-center positions from structured grid metadata.
 */

import type { DomainMeta } from "../../api/types";
import type {
  SpatialDomainAdapter,
  Bounds3,
  RenderGeometry,
  DomainInfo,
} from "./SpatialDomainAdapter";

export class FdmDomainAdapter implements SpatialDomainAdapter {
  readonly kind = "fdm" as const;
  readonly generationId: number;
  readonly pointCount: number;

  private meta: DomainMeta;
  private cachedPositions: Float32Array | null = null;

  constructor(meta: DomainMeta) {
    if (meta.discretization !== "fdm") {
      throw new Error(`FdmDomainAdapter requires fdm domain, got ${meta.discretization}`);
    }
    this.meta = meta;
    this.generationId = meta.generation_id;
    this.pointCount = meta.counts.point_count;
  }

  getBounds(): Bounds3 {
    return {
      min: [...this.meta.bounds.min],
      max: [...this.meta.bounds.max],
    };
  }

  getPositions(): Float32Array {
    if (this.cachedPositions) return this.cachedPositions;

    const grid = this.meta.structured_grid;
    if (!grid) {
      throw new Error("FDM domain missing structured_grid descriptor");
    }

    const [nx, ny, nz] = grid.shape;
    const [ox, oy, oz] = grid.origin;
    const [dx, dy, dz] = grid.spacing;
    const count = nx * ny * nz;
    const positions = new Float32Array(count * 3);

    let idx = 0;
    for (let iz = 0; iz < nz; iz++) {
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          positions[idx++] = ox + (ix + 0.5) * dx;
          positions[idx++] = oy + (iy + 0.5) * dy;
          positions[idx++] = oz + (iz + 0.5) * dz;
        }
      }
    }

    this.cachedPositions = positions;
    return positions;
  }

  getIndices(): Uint32Array | null {
    // FDM has no explicit topology
    return null;
  }

  getRenderGeometry(): RenderGeometry {
    const positions = this.getPositions();
    return {
      positions,
      indices: null,
      normals: null,
      cellCount: this.pointCount,
      vertexCount: this.pointCount,
    };
  }

  getDomainInfo(): DomainInfo {
    return {
      discretization: "fdm",
      dimension: 3,
      pointCount: this.pointCount,
      cellCount: this.pointCount,
      gridShape: this.meta.structured_grid
        ? [...this.meta.structured_grid.shape]
        : undefined,
    };
  }
}
