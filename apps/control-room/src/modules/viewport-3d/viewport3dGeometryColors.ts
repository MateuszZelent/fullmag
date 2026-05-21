import { BufferAttribute, BufferGeometry } from "three";

import type { DecodedFieldVector } from "@/kernel/api/codecs";

import {
  buildVertexScalarColors,
  fieldTransformNeedsChunking,
  VIEWPORT_3D_SYNC_COLOR_POINT_LIMIT,
  type ScalarColorBuffer,
} from "./viewport3dFieldMapping";

export function canApplyVertexScalarColors(
  fieldVector: DecodedFieldVector | null | undefined,
  vertexCount: number,
  maxSynchronousPoints = VIEWPORT_3D_SYNC_COLOR_POINT_LIMIT,
): boolean {
  return Boolean(
    fieldVector &&
      fieldVector.pointCount > 0 &&
      fieldVector.pointCount <= vertexCount &&
      !fieldTransformNeedsChunking(
        fieldVector.pointCount,
        maxSynchronousPoints,
      ),
  );
}

export function applyVertexScalarColors(
  geometry: BufferGeometry,
  fieldVector: DecodedFieldVector | null | undefined,
  vertexCount: number,
): boolean {
  const colorBuffer = buildVertexScalarColors(fieldVector, vertexCount);

  return applyVertexScalarColorBuffer(geometry, colorBuffer, vertexCount);
}

export function canApplyVertexScalarColorBuffer(
  colorBuffer: ScalarColorBuffer | null | undefined,
  vertexCount: number,
): boolean {
  return Boolean(colorBuffer && colorBuffer.colors.length === vertexCount * 3);
}

export function applyVertexScalarColorBuffer(
  geometry: BufferGeometry,
  colorBuffer: ScalarColorBuffer | null | undefined,
  vertexCount: number,
): boolean {
  const existing = geometry.getAttribute("color");
  const hasCompatibleBuffer =
    existing instanceof BufferAttribute &&
    existing.itemSize === 3 &&
    existing.count === vertexCount &&
    existing.array instanceof Float32Array;

  if (!colorBuffer) {
    // Leave a compatible buffer intact — its data is still valid or will be
    // overwritten in the next effect cycle.  The material's `vertexColors`
    // flag controls whether the buffer is sampled, so preserved data is never
    // visible when vertex colours are disabled.  Zero-filling the buffer here
    // caused the surface to flash black when toggling the Surface pass off and
    // on: React rendered with `vertexColors=true` (effect not yet run) while
    // the buffer contained zeros.
    if (!hasCompatibleBuffer && geometry.hasAttribute("color")) {
      // Buffer size does not match the current topology: stale data from a
      // previous mesh.  Remove it.
      geometry.deleteAttribute("color");
    }
    return false;
  }

  if (colorBuffer.colors.length !== vertexCount * 3) {
    return false;
  }

  if (hasCompatibleBuffer) {
    (existing.array as Float32Array).set(colorBuffer.colors);
    existing.needsUpdate = true;
    return true;
  }

  // First-time allocation creates a persistent buffer that will be reused.
  geometry.setAttribute("color", new BufferAttribute(colorBuffer.colors, 3));
  return true;
}
