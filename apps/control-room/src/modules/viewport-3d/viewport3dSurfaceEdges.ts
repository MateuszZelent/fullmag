import { BufferAttribute, BufferGeometry } from "three";

import { buildSurfaceEdgeIndices } from "./viewport3dTopologyIndexModel";

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
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indexArray, 1));
  return geometry;
}

export function buildSurfaceEdgeGeometryFromBufferGeometry(
  source: BufferGeometry,
): BufferGeometry | null {
  const position = source.getAttribute("position");
  if (!(position instanceof BufferAttribute) || position.itemSize !== 3) {
    return null;
  }

  const sourceIndex = source.getIndex();
  const surfaceIndices = sourceIndex?.array ?? sequentialIndices(position.count);
  const edgeIndices = buildSurfaceEdgeIndices(surfaceIndices);
  if (!edgeIndices) return null;

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", position.clone());
  geometry.setIndex(new BufferAttribute(edgeIndices, 1));
  return geometry;
}
function sequentialIndices(count: number): Uint32Array {
  const indices = new Uint32Array(count);
  for (let index = 0; index < count; index += 1) {
    indices[index] = index;
  }
  return indices;
}
