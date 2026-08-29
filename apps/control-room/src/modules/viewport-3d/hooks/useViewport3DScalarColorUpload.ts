"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { BufferAttribute, type BufferGeometry } from "three";

import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import type { Viewport3DGpuUploadChunk } from "../build-engine/gpu/viewport3dGpuUploadTypes";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import type { Viewport3DDirtyReason } from "../viewport3dTypes";
import {
  applyVertexScalarColorBuffer,
  canApplyVertexScalarColorBuffer,
} from "../viewport3dGeometryColors";
import type { ScalarColorBuffer } from "../viewport3dFieldMapping";
import {
  canApplyScalarShaderColorBuffer,
  VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE,
  VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE,
  VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE,
  VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE,
} from "../viewport3dScalarSurfaceShader";

const VIEWPORT_3D_SCALAR_COLOR_UPLOAD_BATCH_SIZE = 8192;
const VIEWPORT_3D_SCALAR_COLOR_UPLOAD_FRAME_BUDGET_MS = 3;

interface Viewport3DScalarColorUploadPlan {
  readonly chunks: readonly Viewport3DGpuUploadChunk[];
  readonly estimatedBytes: number;
  readonly onVisible: () => void;
}

interface Viewport3DScalarShaderUploadSnapshot {
  readonly buffer: ScalarColorBuffer | null;
  readonly geometry: BufferGeometry | null;
  readonly retentionKey: string | null;
  readonly version: number;
}

interface Viewport3DScalarShaderUploadStore {
  readonly getSnapshot: () => Viewport3DScalarShaderUploadSnapshot;
  readonly publish: (
    buffer: ScalarColorBuffer | null,
    geometry: BufferGeometry | null,
    retentionKey: string | null,
  ) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY_VIEWPORT_3D_SCALAR_SHADER_UPLOAD_SNAPSHOT:
  Viewport3DScalarShaderUploadSnapshot = {
    buffer: null,
    geometry: null,
    retentionKey: null,
    version: 0,
  };

interface Viewport3DScalarColorUploadSnapshot {
  readonly buffer: ScalarColorBuffer | null;
  readonly geometry: BufferGeometry | null;
  readonly retentionKey: string | null;
  readonly version: number;
}

interface Viewport3DScalarColorUploadStore {
  readonly getSnapshot: () => Viewport3DScalarColorUploadSnapshot;
  readonly publish: (
    buffer: ScalarColorBuffer | null,
    geometry: BufferGeometry | null,
    retentionKey: string | null,
  ) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY_VIEWPORT_3D_SCALAR_COLOR_UPLOAD_SNAPSHOT:
  Viewport3DScalarColorUploadSnapshot = {
    buffer: null,
    geometry: null,
    retentionKey: null,
    version: 0,
  };

export function canRetainViewport3DScalarUploadBuffer({
  allowRetention,
  buffer,
  geometry,
  requestedGeometry,
  requestedRetentionKey,
  retentionKey,
}: {
  allowRetention: boolean;
  buffer: ScalarColorBuffer | null;
  geometry: BufferGeometry | null;
  requestedGeometry: BufferGeometry;
  requestedRetentionKey: string | null | undefined;
  retentionKey: string | null;
}): boolean {
  return Boolean(
    allowRetention &&
      requestedRetentionKey &&
      buffer &&
      geometry === requestedGeometry &&
      retentionKey === requestedRetentionKey,
  );
}

export function canReuseViewport3DScalarShaderAttributes(
  previous: ScalarColorBuffer | null | undefined,
  next: ScalarColorBuffer | null | undefined,
): boolean {
  return Boolean(
    previous &&
      next &&
      previous.buildKey &&
      previous.buildKey === next.buildKey &&
      previous.scalarValues === next.scalarValues &&
      previous.vectorValues === next.vectorValues &&
      previous.complexRealValues === next.complexRealValues &&
      previous.complexImagValues === next.complexImagValues,
  );
}

function createViewport3DScalarColorUploadStore(): Viewport3DScalarColorUploadStore {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_VIEWPORT_3D_SCALAR_COLOR_UPLOAD_SNAPSHOT;

  function publish(
    buffer: ScalarColorBuffer | null,
    geometry: BufferGeometry | null,
    retentionKey: string | null,
  ): void {
    if (
      snapshot.buffer === buffer &&
      snapshot.geometry === geometry &&
      snapshot.retentionKey === retentionKey
    ) return;
    snapshot = {
      buffer,
      geometry,
      retentionKey,
      version: snapshot.version + 1,
    };
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getSnapshot: () => snapshot,
    publish,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function useViewport3DScalarColorUpload({
  colorBuffer,
  dirtyReason,
  enabled,
  geometry,
  invalidate,
  retentionKey,
  targetRevision,
  tracker,
  uploadKey,
  vertexColorsEnabled,
  vertexCount,
}: {
  colorBuffer: ScalarColorBuffer | null | undefined;
  dirtyReason: Viewport3DDirtyReason;
  enabled: boolean;
  geometry: BufferGeometry | null;
  invalidate: () => void;
  retentionKey?: string | null;
  targetRevision?: string | null;
  tracker: Viewport3DResourceTracker;
  uploadKey: string;
  vertexColorsEnabled: boolean;
  vertexCount: number;
}): ScalarColorBuffer | null {
  const uploadManager = useMemo(
    () =>
      createViewport3DGpuUploadManager({
        policy: {
          targetFrameBudgetMs: VIEWPORT_3D_SCALAR_COLOR_UPLOAD_FRAME_BUDGET_MS,
        },
      }),
    [],
  );
  const store = useMemo(() => createViewport3DScalarColorUploadStore(), []);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  useEffect(() => () => uploadManager.dispose(), [uploadManager]);

  useEffect(() => {
    if (!enabled || !geometry) return;

    const effectiveColorBuffer = vertexColorsEnabled ? colorBuffer : null;
    if (!effectiveColorBuffer) {
      const current = store.getSnapshot();
      if (canRetainViewport3DScalarUploadBuffer({
        allowRetention: vertexColorsEnabled,
        buffer: current.buffer,
        geometry: current.geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: retentionKey,
        retentionKey: current.retentionKey,
      })) {
        return;
      }
      applyVertexScalarColorBuffer(geometry, null, vertexCount);
      store.publish(null, geometry, null);
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
      const current = store.getSnapshot();
      if (canRetainViewport3DScalarUploadBuffer({
        allowRetention: vertexColorsEnabled,
        buffer: current.buffer,
        geometry: current.geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: retentionKey,
        retentionKey: current.retentionKey,
      })) {
        return;
      }
      applyVertexScalarColorBuffer(geometry, null, vertexCount);
      store.publish(null, geometry, null);
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
        store.publish(effectiveColorBuffer, geometry, retentionKey ?? null);
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
    retentionKey,
    store,
    targetRevision,
    tracker,
    uploadKey,
    uploadManager,
    vertexColorsEnabled,
    vertexCount,
  ]);

  return snapshot.geometry === geometry ? snapshot.buffer : null;
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
  const rollback = () => {
    if (!existingAttribute && geometry.getAttribute("color") === attribute) {
      geometry.deleteAttribute("color");
    }
  };

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
      rollback,
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

export function useViewport3DScalarShaderColorUpload({
  colorBuffer,
  dirtyReason,
  enabled,
  geometry,
  invalidate,
  retentionKey,
  targetRevision,
  tracker,
  uploadKey,
  vertexCount,
}: {
  colorBuffer: ScalarColorBuffer | null | undefined;
  dirtyReason: Viewport3DDirtyReason;
  enabled: boolean;
  geometry: BufferGeometry | null;
  invalidate: () => void;
  retentionKey?: string | null;
  targetRevision?: string | null;
  tracker: Viewport3DResourceTracker;
  uploadKey: string;
  vertexCount: number;
}): ScalarColorBuffer | null {
  const uploadManager = useMemo(
    () =>
      createViewport3DGpuUploadManager({
        policy: {
          targetFrameBudgetMs: VIEWPORT_3D_SCALAR_COLOR_UPLOAD_FRAME_BUDGET_MS,
        },
      }),
    [],
  );
  const store = useMemo(() => createViewport3DScalarShaderUploadStore(), []);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  useEffect(() => () => uploadManager.dispose(), [uploadManager]);

  useEffect(() => {
    if (!enabled || !geometry) return;

    if (!colorBuffer) {
      const current = store.getSnapshot();
      if (canRetainViewport3DScalarUploadBuffer({
        allowRetention: true,
        buffer: current.buffer,
        geometry: current.geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: retentionKey,
        retentionKey: current.retentionKey,
      })) {
        return;
      }
      store.publish(null, geometry, null);
      tracker.recordDirtyFrame(dirtyReason);
      invalidate();
      return;
    }

    const current = store.getSnapshot();
    if (
      current.geometry === geometry &&
      canReuseViewport3DScalarShaderAttributes(current.buffer, colorBuffer)
    ) {
      store.publish(colorBuffer, geometry, retentionKey ?? null);
      tracker.recordDirtyFrame(dirtyReason);
      invalidate();
      return;
    }

    const uploadPlan = createViewport3DScalarShaderColorUploadPlan(
      geometry,
      colorBuffer,
      vertexCount,
    );
    if (!uploadPlan) {
      const current = store.getSnapshot();
      if (canRetainViewport3DScalarUploadBuffer({
        allowRetention: true,
        buffer: current.buffer,
        geometry: current.geometry,
        requestedGeometry: geometry,
        requestedRetentionKey: retentionKey,
        retentionKey: current.retentionKey,
      })) {
        return;
      }
      store.publish(null, geometry, null);
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
        store.publish(colorBuffer, geometry, retentionKey ?? null);
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
    retentionKey,
    store,
    targetRevision,
    tracker,
    uploadKey,
    uploadManager,
    vertexCount,
  ]);

  return snapshot.geometry === geometry ? snapshot.buffer : null;
}

export function createViewport3DScalarShaderColorUploadPlan(
  geometry: BufferGeometry,
  colorBuffer: ScalarColorBuffer,
  vertexCount: number,
  batchSize = VIEWPORT_3D_SCALAR_COLOR_UPLOAD_BATCH_SIZE,
): Viewport3DScalarColorUploadPlan | null {
  if (!canApplyScalarShaderColorBuffer(colorBuffer, vertexCount)) return null;

  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const chunks: Viewport3DGpuUploadChunk[] = [];
  const attributes: Array<{
    readonly attribute: BufferAttribute;
    readonly itemSize: number;
    readonly name: string;
    readonly source: Float32Array;
    readonly wasAttached: boolean;
  }> = [];

  addShaderUploadAttribute(
    attributes,
    geometry,
    VIEWPORT_3D_SCALAR_VALUE_ATTRIBUTE,
    colorBuffer.scalarValues,
    1,
    vertexCount,
  );
  addShaderUploadAttribute(
    attributes,
    geometry,
    VIEWPORT_3D_VECTOR_VALUE_ATTRIBUTE,
    colorBuffer.vectorValues,
    3,
    vertexCount,
  );
  addShaderUploadAttribute(
    attributes,
    geometry,
    VIEWPORT_3D_COMPLEX_REAL_VALUE_ATTRIBUTE,
    colorBuffer.complexRealValues,
    3,
    vertexCount,
  );
  addShaderUploadAttribute(
    attributes,
    geometry,
    VIEWPORT_3D_COMPLEX_IMAG_VALUE_ATTRIBUTE,
    colorBuffer.complexImagValues,
    3,
    vertexCount,
  );

  if (attributes.length === 0) return null;

  const rollback = () => {
    for (const entry of attributes) {
      if (
        !entry.wasAttached &&
        geometry.getAttribute(entry.name) === entry.attribute
      ) {
        geometry.deleteAttribute(entry.name);
      }
    }
  };

  for (const entry of attributes) {
    entry.attribute.clearUpdateRanges();
    for (let start = 0; start < vertexCount; start += safeBatchSize) {
      const end = Math.min(start + safeBatchSize, vertexCount);
      chunks.push({
        estimatedBytes:
          (end - start) * entry.itemSize * Float32Array.BYTES_PER_ELEMENT,
        itemCount: end - start,
        upload: () => {
          const target = entry.attribute.array as Float32Array;
          const sourceStart = start * entry.itemSize;
          const sourceEnd = end * entry.itemSize;
          target.set(
            entry.source.subarray(sourceStart, sourceEnd),
            sourceStart,
          );
          entry.attribute.addUpdateRange(sourceStart, sourceEnd - sourceStart);
        },
        rollback,
      });
    }
  }

  return {
    chunks,
    estimatedBytes: attributes.reduce(
      (total, entry) => total + entry.source.byteLength,
      0,
    ),
    onVisible: () => {
      for (const entry of attributes) {
        if (!entry.wasAttached) {
          geometry.setAttribute(entry.name, entry.attribute);
        }
        entry.attribute.needsUpdate = true;
      }
    },
  };
}

function addShaderUploadAttribute(
  attributes: Array<{
    readonly attribute: BufferAttribute;
    readonly itemSize: number;
    readonly name: string;
    readonly source: Float32Array;
    readonly wasAttached: boolean;
  }>,
  geometry: BufferGeometry,
  name: string,
  source: Float32Array | null | undefined,
  itemSize: number,
  vertexCount: number,
): void {
  if (!source || source.length !== vertexCount * itemSize) return;
  const existing = geometry.getAttribute(name);
  const existingAttribute =
    existing instanceof BufferAttribute &&
    existing.itemSize === itemSize &&
    existing.count === vertexCount &&
    existing.array instanceof Float32Array
      ? existing
      : null;
  attributes.push({
    attribute:
      existingAttribute ??
      new BufferAttribute(new Float32Array(vertexCount * itemSize), itemSize),
    itemSize,
    name,
    source,
    wasAttached: Boolean(existingAttribute),
  });
}

function createViewport3DScalarShaderUploadStore():
  Viewport3DScalarShaderUploadStore {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_VIEWPORT_3D_SCALAR_SHADER_UPLOAD_SNAPSHOT;

  function publish(
    buffer: ScalarColorBuffer | null,
    geometry: BufferGeometry | null,
    retentionKey: string | null,
  ): void {
    if (
      snapshot.buffer === buffer &&
      snapshot.geometry === geometry &&
      snapshot.retentionKey === retentionKey
    ) return;
    snapshot = {
      buffer,
      geometry,
      retentionKey,
      version: snapshot.version + 1,
    };
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    getSnapshot: () => snapshot,
    publish,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
