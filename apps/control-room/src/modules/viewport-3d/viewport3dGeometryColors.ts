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
      // Field may cover a subset of topology nodes (e.g. magnetic domain only).
      // Allow partial coverage: pointCount <= vertexCount.
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
    // When the existing buffer matches the current topology, zero-fill it
    // instead of deleting it.  The material's `vertexColors` flag controls
    // whether the buffer is actually sampled — this avoids intermediate blank
    // frames during HSL→monochrome transitions.
    if (hasCompatibleBuffer) {
      (existing.array as Float32Array).fill(0);
      existing.needsUpdate = true;
    } else if (geometry.hasAttribute("color")) {
      // Buffer size doesn't match the current topology — stale data from a
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

  // First-time allocation — create a persistent buffer that will be reused.
  geometry.setAttribute("color", new BufferAttribute(colorBuffer.colors, 3));
  return true;
}
