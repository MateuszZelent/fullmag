import {
  BufferAttribute,
  BufferGeometry,
} from "three";

import {
  resolveNodeSelectionCount,
  resolveNodeSelectionIndex,
  type Viewport3DNodeSelection,
} from "./viewport3dRenderModel";
import { attachViewport3DSharedTopologyPosition } from "./viewport3dSharedTopologyPositions";

export interface Viewport3DPointPositionSource {
  nodeCount: number;
  positions: ArrayLike<number>;
}

export interface Viewport3DIndexedPointSelection {
  nodeCount?: number;
  node_count?: number;
  nodeIndices?: ArrayLike<number>;
  node_indices?: ArrayLike<number>;
  nodeStart?: number;
  node_start?: number;
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

export function createViewport3DIndexedPointGeometry(
  source: Viewport3DPointPositionSource,
  selection: Viewport3DIndexedPointSelection | null | undefined,
): BufferGeometry | null {
  const pointCount = resolveIndexedPointSelectionCount(selection, source);
  if (pointCount <= 0) return null;

  const geometry = new BufferGeometry();
  attachViewport3DSharedTopologyPosition(
    geometry,
    ensureFloat32PositionArray(source.positions),
  );

  const explicitIndices = selection?.nodeIndices ?? selection?.node_indices;
  if (explicitIndices?.length) {
    geometry.setIndex(new BufferAttribute(ensureUint32IndexArray(explicitIndices), 1));
  } else {
    geometry.setDrawRange(resolveIndexedPointSelectionStart(selection), pointCount);
  }

  return geometry;
}

function ensureFloat32PositionArray(positions: ArrayLike<number>): Float32Array {
  return positions instanceof Float32Array
    ? positions
    : Float32Array.from(positions);
}

function ensureUint32IndexArray(indices: ArrayLike<number>): Uint32Array {
  return indices instanceof Uint32Array ? indices : Uint32Array.from(indices);
}

function resolveIndexedPointSelectionCount(
  selection: Viewport3DIndexedPointSelection | null | undefined,
  topology: Pick<Viewport3DPointPositionSource, "nodeCount">,
): number {
  if (selection?.nodeIndices?.length) return selection.nodeIndices.length;
  if (selection?.node_indices?.length) return selection.node_indices.length;

  const start = resolveIndexedPointSelectionStart(selection);
  if (start >= topology.nodeCount) return 0;

  const rawCount = selection?.nodeCount ?? selection?.node_count;
  const count =
    rawCount === undefined || (rawCount <= 0 && start > 0)
      ? topology.nodeCount - start
      : Math.max(0, Math.floor(rawCount));
  return Math.min(count, topology.nodeCount - start);
}

function resolveIndexedPointSelectionStart(
  selection: Viewport3DIndexedPointSelection | null | undefined,
): number {
  return Math.max(
    0,
    Math.floor(selection?.nodeStart ?? selection?.node_start ?? 0),
  );
}
