/**
 * Spatial domain adapter interface.
 * Provides a uniform API over FDM (structured grid) and FEM (unstructured mesh) domains.
 */

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

export interface RenderGeometry {
  positions: Float32Array;
  indices: Uint32Array | null;
  normals: Float32Array | null;
  cellCount: number;
  vertexCount: number;
}

export interface DomainInfo {
  discretization: "fdm" | "fem";
  dimension: 3;
  pointCount: number;
  cellCount?: number;
  elementCount?: number;
  gridShape?: [number, number, number];
}

export interface SpatialDomainAdapter {
  readonly kind: "fdm" | "fem";
  readonly generationId: number;
  readonly pointCount: number;
  getBounds(): Bounds3;
  getPositions(): Float32Array;
  getIndices(): Uint32Array | null;
  getRenderGeometry(): RenderGeometry;
  getDomainInfo(): DomainInfo;
}
