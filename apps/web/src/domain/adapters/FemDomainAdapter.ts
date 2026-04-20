/**
 * FEM domain adapter.
 * Wraps decoded topology with Float32 positions for rendering.
 */

import type { DomainMeta } from "../../api/types";
import type { DecodedTopology } from "../../api/codecs/types";
import type {
  SpatialDomainAdapter,
  Bounds3,
  RenderGeometry,
  DomainInfo,
} from "./SpatialDomainAdapter";

export class FemDomainAdapter implements SpatialDomainAdapter {
  readonly kind = "fem" as const;
  readonly generationId: number;
  readonly pointCount: number;

  private meta: DomainMeta;
  private topology: DecodedTopology;
  private cachedPositions: Float32Array | null = null;
  private cachedNormals: Float32Array | null = null;

  constructor(meta: DomainMeta, topology: DecodedTopology) {
    if (meta.discretization !== "fem") {
      throw new Error(`FemDomainAdapter requires fem domain, got ${meta.discretization}`);
    }
    this.meta = meta;
    this.topology = topology;
    this.generationId = meta.generation_id;
    this.pointCount = meta.counts.nodes ?? topology.nodeCount;
  }

  getBounds(): Bounds3 {
    return {
      min: [...this.meta.bounds.min],
      max: [...this.meta.bounds.max],
    };
  }

  getPositions(): Float32Array {
    if (this.cachedPositions) return this.cachedPositions;

    const src = this.topology.positions;
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) {
      out[i] = src[i];
    }
    this.cachedPositions = out;
    return out;
  }

  getIndices(): Uint32Array | null {
    return this.topology.boundaryFaces;
  }

  getRenderGeometry(): RenderGeometry {
    const positions = this.getPositions();
    const indices = this.topology.boundaryFaces;
    const normals = this.computeNormals(positions, indices);
    return {
      positions,
      indices,
      normals,
      cellCount: this.topology.elementCount,
      vertexCount: this.pointCount,
    };
  }

  getDomainInfo(): DomainInfo {
    return {
      discretization: "fem",
      dimension: 3,
      pointCount: this.pointCount,
      cellCount: this.topology.elementCount,
      elementCount: this.topology.elementCount,
    };
  }

  private computeNormals(
    positions: Float32Array,
    indices: Uint32Array,
  ): Float32Array {
    if (this.cachedNormals) return this.cachedNormals;

    const normals = new Float32Array(positions.length);

    // Accumulate face normals per vertex (triangle faces: 3 indices each)
    for (let i = 0; i < indices.length; i += 3) {
      const i0 = indices[i];
      const i1 = indices[i + 1];
      const i2 = indices[i + 2];

      const ax = positions[i1 * 3] - positions[i0 * 3];
      const ay = positions[i1 * 3 + 1] - positions[i0 * 3 + 1];
      const az = positions[i1 * 3 + 2] - positions[i0 * 3 + 2];

      const bx = positions[i2 * 3] - positions[i0 * 3];
      const by = positions[i2 * 3 + 1] - positions[i0 * 3 + 1];
      const bz = positions[i2 * 3 + 2] - positions[i0 * 3 + 2];

      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;

      for (const vi of [i0, i1, i2]) {
        normals[vi * 3] += nx;
        normals[vi * 3 + 1] += ny;
        normals[vi * 3 + 2] += nz;
      }
    }

    // Normalize
    for (let i = 0; i < normals.length; i += 3) {
      const nx = normals[i];
      const ny = normals[i + 1];
      const nz = normals[i + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 1e-12) {
        normals[i] /= len;
        normals[i + 1] /= len;
        normals[i + 2] /= len;
      }
    }

    this.cachedNormals = normals;
    return normals;
  }
}
