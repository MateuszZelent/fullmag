"use client";

import { useEffect, useMemo } from "react";
import { BufferAttribute, type BufferGeometry } from "three";

import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import type { Viewport3DGpuUploadChunk } from "../build-engine/gpu/viewport3dGpuUploadTypes";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import {
  applyVertexScalarColorBuffer,
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";

const VIEWPORT_3D_SCALAR_COLOR_UPLOAD_BATCH_SIZE = 8192;
const VIEWPORT_3D_SCALAR_COLOR_UPLOAD_FRAME_BUDGET_MS = 3;

interface Viewport3DScalarColorUploadPlan {
  readonly chunks: readonly Viewport3DGpuUploadChunk[];
  readonly estimatedBytes: number;
  readonly onVisible: () => void;
}

export function useViewport3DScalarColorUpload({
  colorBuffer,
  dirtyReason,
  enabled,
  geometry,
  invalidate,
  targetRevision,
  tracker,
  uploadKey,
  vertexColorsEnabled,
  vertexCount,
}: {
  colorBuffer: ScalarColorBuffer | null | undefined;
  dirtyReason: string;
  enabled: boolean;
  geometry: BufferGeometry | null;
  invalidate: () => void;
  targetRevision?: string | null;
  tracker: Viewport3DResourceTracker;
  uploadKey: string;
  vertexColorsEnabled: boolean;
  vertexCount: number;
}): void {
  const uploadManager = useMemo(
    () =>
      createViewport3DGpuUploadManager({
        policy: {
          targetFrameBudgetMs: VIEWPORT_3D_SCALAR_COLOR_UPLOAD_FRAME_BUDGET_MS,
        },
      }),
    [],
  );

  useEffect(() => () => uploadManager.dispose(), [uploadManager]);

  useEffect(() => {
    if (!enabled || !geometry) return;

    const effectiveColorBuffer = vertexColorsEnabled ? colorBuffer : null;
    if (!effectiveColorBuffer) {
      applyVertexScalarColorBuffer(geometry, null, vertexCount);
      tracker.recordDirtyFrame(dirtyReason);
      invalidate();
      return;
    }

    const uploadPlan = createViewport3DScalarColorUploadPlan(
      geometry,
      effectiveColorBuffer,
      vertexCount,
    );
    if (!uploadPlan) {
      applyVertexScalarColorBuffer(geometry, null, vertexCount);
      tracker.recordDirtyFrame(dirtyReason);
      invalidate();
      return;
    }

    const abortController = new AbortController();
    uploadManager.enqueue({
      chunks: uploadPlan.chunks,
      estimatedBytes: uploadPlan.estimatedBytes,
      key: `${uploadKey}:${vertexCount}:${uploadPlan.estimatedBytes}`,
      lane: "field-color",
      onVisible: () => {
        uploadPlan.onVisible();
        tracker.recordDirtyFrame(dirtyReason);
        invalidate();
      },
      signal: abortController.signal,
      targetRevision: targetRevision ?? null,
    });

    return () => {
      abortController.abort();
    };
  }, [
    colorBuffer,
    dirtyReason,
    enabled,
    geometry,
    invalidate,
    targetRevision,
    tracker,
    uploadKey,
    uploadManager,
    vertexColorsEnabled,
    vertexCount,
  ]);
}

export function createViewport3DScalarColorUploadPlan(
  geometry: BufferGeometry,
  colorBuffer: ScalarColorBuffer,
  vertexCount: number,
  batchSize = VIEWPORT_3D_SCALAR_COLOR_UPLOAD_BATCH_SIZE,
): Viewport3DScalarColorUploadPlan | null {
  if (!canApplyVertexScalarColorBuffer(colorBuffer, vertexCount)) return null;

  const existing = geometry.getAttribute("color");
  const existingAttribute =
    existing instanceof BufferAttribute &&
    existing.itemSize === 3 &&
    existing.count === vertexCount &&
    existing.array instanceof Float32Array
      ? existing
      : null;
  const attribute =
    existingAttribute ??
    new BufferAttribute(new Float32Array(vertexCount * 3), 3);
  const target = attribute.array as Float32Array;
  const source = colorBuffer.colors;
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const chunks: Viewport3DGpuUploadChunk[] = [];

  attribute.clearUpdateRanges();
  for (let start = 0; start < vertexCount; start += safeBatchSize) {
    const end = Math.min(start + safeBatchSize, vertexCount);
    chunks.push({
      estimatedBytes: (end - start) * 3 * Float32Array.BYTES_PER_ELEMENT,
      itemCount: end - start,
      upload: () => {
        target.set(source.subarray(start * 3, end * 3), start * 3);
        attribute.addUpdateRange(start * 3, (end - start) * 3);
      },
    });
  }

  return {
    chunks,
    estimatedBytes: source.byteLength,
    onVisible: () => {
      if (!existingAttribute) {
        geometry.setAttribute("color", attribute);
      }
      attribute.needsUpdate = true;
    },
  };
}
