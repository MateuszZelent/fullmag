import type { BufferGeometry, LineSegments } from "three";

import {
  viewport3DCameraGestureActive,
  type Viewport3DCameraGestureRef,
} from "./layers/viewport3DCameraGesture";

export const VIEWPORT_3D_INTERACTION_WIREFRAME_SEGMENTS = 12_000;

/** Uniform edge sampling keeps the moving preview spread across the whole mesh. */
export function sampleViewport3DWireframeEdges(
  indices: ArrayLike<number> | null | undefined,
  maxSegments = VIEWPORT_3D_INTERACTION_WIREFRAME_SEGMENTS,
): Uint32Array | null {
  if (!indices?.length || indices.length % 2 || !Number.isFinite(maxSegments) || maxSegments < 1) return null;
  const segmentCount = indices.length / 2;
  const count = Math.min(segmentCount, Math.floor(maxSegments));
  if (count === segmentCount && indices instanceof Uint32Array) return indices;
  const sampled = new Uint32Array(count * 2);
  for (let index = 0; index < count; index += 1) {
    const source = (count === 1 ? 0 : Math.round(index * (segmentCount - 1) / (count - 1))) * 2;
    sampled[index * 2] = indices[source];
    sampled[index * 2 + 1] = indices[source + 1];
  }
  return sampled;
}

/** Swap prepared geometries without rebuilding topology on camera frames. */
export function updateViewport3DInteractionWireframe(
  line: LineSegments | null,
  full: BufferGeometry,
  interaction: BufferGeometry | null,
  gesture: Viewport3DCameraGestureRef | null | undefined,
): void {
  if (line) line.geometry = viewport3DCameraGestureActive(gesture) && interaction ? interaction : full;
}
