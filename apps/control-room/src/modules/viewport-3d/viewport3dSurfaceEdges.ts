import { BufferAttribute, BufferGeometry } from "three";

import { attachViewport3DSharedTopologyPosition } from "./viewport3dSharedTopologyPositions";

export { buildSurfaceEdgeIndices } from "./viewport3dTopologyIndexModel";

export function buildLineIndexGeometry(
  positions: Float32Array,
  lineIndices: ArrayLike<number> | null | undefined,
): BufferGeometry | null {
  if (!lineIndices || lineIndices.length < 2 || lineIndices.length % 2 !== 0) {
    return null;
  }

  const geometry = new BufferGeometry();
  const indexArray =
    lineIndices instanceof Uint8Array ||
    lineIndices instanceof Uint16Array ||
    lineIndices instanceof Uint32Array
      ? lineIndices
      : new Uint32Array(lineIndices);
  attachViewport3DSharedTopologyPosition(geometry, positions);
  geometry.setIndex(new BufferAttribute(indexArray, 1));
  return geometry;
}
