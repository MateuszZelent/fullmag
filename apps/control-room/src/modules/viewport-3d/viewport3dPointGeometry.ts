import {
  BufferAttribute,
  BufferGeometry,
} from "three";

import {
  resolveNodeSelectionCount,
  resolveNodeSelectionIndex,
  type Viewport3DNodeSelection,
} from "./viewport3dRenderModel";

export interface Viewport3DPointPositionSource {
  nodeCount: number;
  positions: ArrayLike<number>;
}

export function buildViewport3DPointPositions(
  source: Viewport3DPointPositionSource,
  selection: Viewport3DNodeSelection | null | undefined,
): Float32Array | null {
  const pointCount = resolveNodeSelectionCount(selection, source);
  if (pointCount <= 0) return null;

  const positions = new Float32Array(pointCount * 3);
  let written = 0;
  for (let offset = 0; offset < pointCount; offset += 1) {
    const nodeIndex = resolveNodeSelectionIndex(selection, offset);
    if (
      nodeIndex === null ||
      nodeIndex < 0 ||
      nodeIndex >= source.nodeCount
    ) {
      continue;
    }

    const sourceOffset = nodeIndex * 3;
    const targetOffset = written * 3;
    positions[targetOffset] = source.positions[sourceOffset] ?? 0;
    positions[targetOffset + 1] = source.positions[sourceOffset + 1] ?? 0;
    positions[targetOffset + 2] = source.positions[sourceOffset + 2] ?? 0;
    written += 1;
  }

  return written === pointCount ? positions : positions.slice(0, written * 3);
}

export function buildViewport3DPointGeometry(
  source: Viewport3DPointPositionSource,
  selection: Viewport3DNodeSelection | null | undefined,
): BufferGeometry | null {
  const positions = buildViewport3DPointPositions(source, selection);
  if (!positions || positions.length === 0) return null;

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  return geometry;
}
