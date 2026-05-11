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
      fieldVector.pointCount === vertexCount &&
      fieldVector.pointCount > 0 &&
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
  if (!colorBuffer) {
    if (geometry.hasAttribute("color")) {
      geometry.deleteAttribute("color");
    }
    return false;
  }

  const existing = geometry.getAttribute("color");
  if (
    colorBuffer.colors.length === vertexCount * 3 &&
    existing instanceof BufferAttribute &&
    existing.itemSize === 3 &&
    existing.count === vertexCount &&
    existing.array instanceof Float32Array
  ) {
    existing.array.set(colorBuffer.colors);
    existing.needsUpdate = true;
    return true;
  }

  if (colorBuffer.colors.length !== vertexCount * 3) {
    if (geometry.hasAttribute("color")) {
      geometry.deleteAttribute("color");
    }
    return false;
  }

  geometry.setAttribute("color", new BufferAttribute(colorBuffer.colors, 3));
  return true;
}
