"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { BufferAttribute, DynamicDrawUsage, type BufferGeometry } from "three";

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

export interface Viewport3DScalarColorUploadResult {
  readonly buffer: ScalarColorBuffer | null;
  readonly fresh: boolean;
}

interface Viewport3DScalarShaderUploadSnapshot {
  readonly buffer: ScalarColorBuffer | null;
  readonly fresh: boolean;
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
    fresh?: boolean,
  ) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY_VIEWPORT_3D_SCALAR_SHADER_UPLOAD_SNAPSHOT:
  Viewport3DScalarShaderUploadSnapshot = {
    buffer: null,
    fresh: false,
    geometry: null,
    retentionKey: null,
    version: 0,
  };

interface Viewport3DScalarColorUploadSnapshot {
  readonly buffer: ScalarColorBuffer | null;
  readonly fresh: boolean;
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
    fresh?: boolean,
  ) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY_VIEWPORT_3D_SCALAR_COLOR_UPLOAD_SNAPSHOT:
  Viewport3DScalarColorUploadSnapshot = {
    buffer: null,
    fresh: false,
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

export function isViewport3DScalarUploadSnapshotCurrent({
  requestedGeometry,
  requestedRetentionKey,
  snapshotGeometry,
  snapshotRetentionKey,
}: {
  requestedGeometry: BufferGeometry | null;
  requestedRetentionKey: string | null | undefined;
  snapshotGeometry: BufferGeometry | null;
  snapshotRetentionKey: string | null;
}): boolean {
  return (
    snapshotGeometry === requestedGeometry &&
    snapshotRetentionKey === (requestedRetentionKey ?? null)
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

export function createViewport3DScalarColorUploadStore(): Viewport3DScalarColorUploadStore {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_VIEWPORT_3D_SCALAR_COLOR_UPLOAD_SNAPSHOT;

  function publish(
    buffer: ScalarColorBuffer | null,
    geometry: BufferGeometry | null,
    retentionKey: string | null,
    fresh = true,
  ): void {
    if (
      snapshot.buffer === buffer &&
      snapshot.fresh === fresh &&
      snapshot.geometry === geometry &&
      snapshot.retentionKey === retentionKey
    ) return;
    snapshot = {
      buffer,
      fresh,
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
}): Viewport3DScalarColorUploadResult {
  const store = useMemo(() => createViewport3DScalarColorUploadStore(), []);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

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
        store.publish(current.buffer, geometry, current.retentionKey, false);
        return;
      }
      if (current.buffer) {
        tracker.recordRetentionRejection(
          current.geometry !== geometry ? "geometry" : "retention-key",
        );
      }
      applyVertexScalarColorBuffer(geometry, null, vertexCount);
      store.publish(null, geometry, null, false);
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
        store.publish(current.buffer, geometry, current.retentionKey, false);
        return;
      }
      if (current.buffer) {
        tracker.recordRetentionRejection(
          current.geometry !== geometry ? "geometry" : "retention-key",
        );
      }
      applyVertexScalarColorBuffer(geometry, null, vertexCount);
      store.publish(null, geometry, null, false);
      tracker.recordDirtyFrame(dirtyReason);
      invalidate();
      return;
    }

    // Keep the manager inside the effect lifetime. React StrictMode intentionally
    // runs setup -> cleanup -> setup on mount; disposing a useMemo-owned manager
    // in that cleanup would leave the remounted manager permanently unusable.
    const uploadManager = createViewport3DGpuUploadManager({
      policy: {
        targetFrameBudgetMs: VIEWPORT_3D_SCALAR_COLOR_UPLOAD_FRAME_BUDGET_MS,
      },
    });
    const abortController = new AbortController();
    uploadManager.enqueue({
      chunks: uploadPlan.chunks,
      estimatedBytes: uploadPlan.estimatedBytes,
      key: `${uploadKey}:${vertexCount}:${uploadPlan.estimatedBytes}`,
      lane: "field-color",
      onVisible: () => {
        uploadPlan.onVisible();
        store.publish(effectiveColorBuffer, geometry, retentionKey ?? null, true);
        tracker.recordDirtyFrame(dirtyReason);
        invalidate();
      },
      signal: abortController.signal,
      targetRevision: targetRevision ?? null,
    });

    return () => {
      abortController.abort();
      uploadManager.dispose();
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
    vertexColorsEnabled,
    vertexCount,
  ]);

  return isViewport3DScalarUploadSnapshotCurrent({
    requestedGeometry: geometry,
    requestedRetentionKey: retentionKey,
    snapshotGeometry: snapshot.geometry,
    snapshotRetentionKey: snapshot.retentionKey,
  })
    ? { buffer: snapshot.buffer, fresh: snapshot.fresh }
    : { buffer: null, fresh: false };
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
  // S-19: fmScalarValue/fmVectorValue/... i tu "color" są nadpisywane co
  // krok animacji fazy (bufferSubData wiele razy na sekundę). Domyślny
  // StaticDrawUsage sugeruje sterownikowi jednorazowy zapis — częste
  // aktualizacje na takiej alokacji wymuszają realokację bufora GPU albo
  // synchronizację potoku. Hint trzeba ustawić przed pierwszym bufferData,
  // czyli w momencie tworzenia atrybutu (nie przy każdym ponownym użyciu).
  // New attributes use the staging array directly; compatible live
  // attributes get one bounded replacement array for the pending plan.
  const staging = new Float32Array(vertexCount * 3);
  const attribute = existingAttribute ?? new BufferAttribute(staging, 3);
  if (!existingAttribute) {
    attribute.setUsage(DynamicDrawUsage);
  }
  const previousArray = existingAttribute
    ? (existingAttribute.array as Float32Array)
    : null;
  const previousUpdateRanges = existingAttribute
    ? existingAttribute.updateRanges.map(({ start, count }) => ({
        count,
        start,
      }))
    : [];
  // Keep all chunk writes off the live geometry. This adds one bounded CPU
  // staging array per active attribute, but an aborted ticket leaves both the
  // attached attribute and its GPU buffer untouched.
  const source = colorBuffer.colors;
  const safeBatchSize = Math.max(1, Math.floor(batchSize));
  const chunks: Viewport3DGpuUploadChunk[] = [];
  let committed = false;
  const rollback = () => {
    if (existingAttribute) {
      if (
        !committed ||
        geometry.getAttribute("color") !== attribute ||
        !previousArray
      ) {
        return;
      }
      attribute.array = previousArray;
      attribute.clearUpdateRanges();
      for (const range of previousUpdateRanges) {
        attribute.addUpdateRange(range.start, range.count);
      }
      // The version intentionally advances so the renderer uploads the
      // restored array even when the previous state had no update range.
      attribute.needsUpdate = true;
      committed = false;
      return;
    }
    if (geometry.getAttribute("color") === attribute) {
      geometry.deleteAttribute("color");
    }
    committed = false;
  };

  for (let start = 0; start < vertexCount; start += safeBatchSize) {
    const end = Math.min(start + safeBatchSize, vertexCount);
    chunks.push({
      estimatedBytes: (end - start) * 3 * Float32Array.BYTES_PER_ELEMENT,
      itemCount: end - start,
      upload: () => {
        staging.set(source.subarray(start * 3, end * 3), start * 3);
      },
      rollback,
    });
  }

  return {
    chunks,
    estimatedBytes: source.byteLength,
    onVisible: () => {
      if (existingAttribute) {
        attribute.array = staging;
        committed = true;
      } else {
        geometry.setAttribute("color", attribute);
        committed = true;
      }
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, staging.length);
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
}): Viewport3DScalarColorUploadResult {
  const store = useMemo(() => createViewport3DScalarShaderUploadStore(), []);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

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
        store.publish(current.buffer, geometry, current.retentionKey, false);
        return;
      }
      if (current.buffer) {
        tracker.recordRetentionRejection(
          current.geometry !== geometry ? "geometry" : "retention-key",
        );
      }
      store.publish(null, geometry, null, false);
      tracker.recordDirtyFrame(dirtyReason);
      invalidate();
      return;
    }

    const current = store.getSnapshot();
    if (
      current.geometry === geometry &&
      canReuseViewport3DScalarShaderAttributes(current.buffer, colorBuffer)
    ) {
      store.publish(colorBuffer, geometry, retentionKey ?? null, true);
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
        store.publish(current.buffer, geometry, current.retentionKey, false);
        return;
      }
      if (current.buffer) {
        tracker.recordRetentionRejection(
          current.geometry !== geometry ? "geometry" : "retention-key",
        );
      }
      store.publish(null, geometry, null, false);
      tracker.recordDirtyFrame(dirtyReason);
      invalidate();
      return;
    }

    // See the vertex-color hook above: the manager must share the effect's
    // lifetime so StrictMode remounts cannot reuse a disposed coordinator.
    const uploadManager = createViewport3DGpuUploadManager({
      policy: {
        targetFrameBudgetMs: VIEWPORT_3D_SCALAR_COLOR_UPLOAD_FRAME_BUDGET_MS,
      },
    });
    const abortController = new AbortController();
    uploadManager.enqueue({
      chunks: uploadPlan.chunks,
      estimatedBytes: uploadPlan.estimatedBytes,
      key: `${uploadKey}:${vertexCount}:${uploadPlan.estimatedBytes}`,
      lane: "field-color",
      onVisible: () => {
        uploadPlan.onVisible();
        store.publish(colorBuffer, geometry, retentionKey ?? null, true);
        tracker.recordDirtyFrame(dirtyReason);
        invalidate();
      },
      signal: abortController.signal,
      targetRevision: targetRevision ?? null,
    });

    return () => {
      abortController.abort();
      uploadManager.dispose();
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
    vertexCount,
  ]);

  return isViewport3DScalarUploadSnapshotCurrent({
    requestedGeometry: geometry,
    requestedRetentionKey: retentionKey,
    snapshotGeometry: snapshot.geometry,
    snapshotRetentionKey: snapshot.retentionKey,
  })
    ? { buffer: snapshot.buffer, fresh: snapshot.fresh }
    : { buffer: null, fresh: false };
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
  const attributes: PendingViewport3DScalarShaderUploadAttribute[] = [];

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
      if (entry.wasAttached) {
        if (
          !entry.committed ||
          geometry.getAttribute(entry.name) !== entry.attribute ||
          !entry.previousArray
        ) {
          continue;
        }
        entry.attribute.array = entry.previousArray;
        entry.attribute.clearUpdateRanges();
        for (const range of entry.previousUpdateRanges) {
          entry.attribute.addUpdateRange(range.start, range.count);
        }
        // The version intentionally advances so the renderer uploads the
        // restored array even when the previous state had no update range.
        entry.attribute.needsUpdate = true;
        entry.committed = false;
        continue;
      }
      if (geometry.getAttribute(entry.name) === entry.attribute) {
        geometry.deleteAttribute(entry.name);
      }
      entry.committed = false;
    }
  };

  for (const entry of attributes) {
    for (let start = 0; start < vertexCount; start += safeBatchSize) {
      const end = Math.min(start + safeBatchSize, vertexCount);
      chunks.push({
        estimatedBytes:
          (end - start) * entry.itemSize * Float32Array.BYTES_PER_ELEMENT,
        itemCount: end - start,
        upload: () => {
          const sourceStart = start * entry.itemSize;
          const sourceEnd = end * entry.itemSize;
          entry.staging.set(
            entry.source.subarray(sourceStart, sourceEnd),
            sourceStart,
          );
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
        if (entry.wasAttached) {
          entry.attribute.array = entry.staging;
          entry.committed = true;
        } else {
          geometry.setAttribute(entry.name, entry.attribute);
          entry.committed = true;
        }
        entry.attribute.clearUpdateRanges();
        entry.attribute.addUpdateRange(0, entry.staging.length);
        entry.attribute.needsUpdate = true;
      }
    },
  };
}

interface PendingViewport3DScalarShaderUploadAttribute {
  readonly attribute: BufferAttribute;
  readonly itemSize: number;
  readonly name: string;
  readonly previousArray: Float32Array | null;
  readonly previousUpdateRanges: ReadonlyArray<{
    readonly count: number;
    readonly start: number;
  }>;
  readonly source: Float32Array;
  readonly staging: Float32Array;
  readonly wasAttached: boolean;
  committed: boolean;
}

function addShaderUploadAttribute(
  attributes: PendingViewport3DScalarShaderUploadAttribute[],
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
  // S-19: patrz komentarz w createViewport3DScalarColorUploadPlan — ten sam
  // problem dotyczy fmScalarValue/fmVectorValue/fmComplexRealValue/
  // fmComplexImagValue.
  // New attributes use the staging array directly; compatible live
  // attributes get one bounded replacement array for the pending plan.
  const staging = new Float32Array(vertexCount * itemSize);
  const attribute = existingAttribute ?? new BufferAttribute(staging, itemSize);
  if (!existingAttribute) {
    attribute.setUsage(DynamicDrawUsage);
  }
  const previousArray = existingAttribute
    ? (existingAttribute.array as Float32Array)
    : null;
  const previousUpdateRanges = existingAttribute
    ? existingAttribute.updateRanges.map(({ start, count }) => ({
        count,
        start,
      }))
    : [];
  attributes.push({
    attribute,
    itemSize,
    name,
    previousArray,
    previousUpdateRanges,
    source,
    // See createViewport3DScalarColorUploadPlan: chunk work stays bounded,
    // while this per-attribute staging array keeps aborts off live geometry.
    staging,
    wasAttached: Boolean(existingAttribute),
    committed: false,
  });
}

export function createViewport3DScalarShaderUploadStore():
  Viewport3DScalarShaderUploadStore {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_VIEWPORT_3D_SCALAR_SHADER_UPLOAD_SNAPSHOT;

  function publish(
    buffer: ScalarColorBuffer | null,
    geometry: BufferGeometry | null,
    retentionKey: string | null,
    fresh = true,
  ): void {
    if (
      snapshot.buffer === buffer &&
      snapshot.fresh === fresh &&
      snapshot.geometry === geometry &&
      snapshot.retentionKey === retentionKey
    ) return;
    snapshot = {
      buffer,
      fresh,
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
