"use client";

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { BufferGeometry } from "three";

import type { Viewport3DBuildLane } from "../build-engine/viewport3dBuildEngineTypes";
import type { Viewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadTypes";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";

interface Viewport3DGeometryUploadSnapshot {
  readonly geometry: BufferGeometry | null;
  readonly version: number;
}

interface Viewport3DGeometryUploadStore {
  readonly getSnapshot: () => Viewport3DGeometryUploadSnapshot;
  readonly publish: (geometry: BufferGeometry | null) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY_VIEWPORT_3D_GEOMETRY_UPLOAD_SNAPSHOT:
  Viewport3DGeometryUploadSnapshot = {
    geometry: null,
    version: 0,
  };

export function useViewport3DGeometryUpload({
  createGeometry,
  dirtyReason,
  enabled,
  estimatedBytes,
  invalidate,
  itemCount,
  key,
  lane,
  targetRevision,
  tracker,
  uploadManager,
}: {
  createGeometry: () => BufferGeometry | null;
  dirtyReason: string;
  enabled: boolean;
  estimatedBytes: number;
  invalidate: () => void;
  itemCount: number;
  key: string;
  lane: Viewport3DBuildLane;
  targetRevision?: string | null;
  tracker: Viewport3DResourceTracker;
  uploadManager: Viewport3DGpuUploadManager;
}): BufferGeometry | null {
  const store = useMemo(() => createViewport3DGeometryUploadStore(), []);
  const releasedGeometriesRef = useRef(new WeakSet<BufferGeometry>());
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const releaseGeometry = useCallback(
    (geometry: BufferGeometry | null): void => {
      if (!geometry || releasedGeometriesRef.current.has(geometry)) return;
      releasedGeometriesRef.current.add(geometry);
      tracker.release("geometry", geometry);
    },
    [tracker],
  );
  const clearCurrentGeometry = useCallback((): void => {
    const current = store.getSnapshot().geometry;
    if (!current) return;
    store.publish(null);
    releaseGeometry(current);
  }, [releaseGeometry, store]);

  useEffect(
    () => () => {
      clearCurrentGeometry();
    },
    [clearCurrentGeometry],
  );

  useEffect(() => {
    if (!enabled) {
      clearCurrentGeometry();
      return;
    }

    const abortController = new AbortController();
    let uploadedGeometry: BufferGeometry | null = null;

    uploadManager.enqueue({
      chunks: [
        {
          estimatedBytes,
          itemCount,
          upload: () => {
            const next = createGeometry();
            uploadedGeometry = next ? tracker.track("geometry", next) : null;
          },
        },
      ],
      estimatedBytes,
      key,
      lane,
      onVisible: () => {
        if (!uploadedGeometry) return;
        const previousGeometry = store.getSnapshot().geometry;
        store.publish(uploadedGeometry);
        if (previousGeometry !== uploadedGeometry) {
          releaseGeometry(previousGeometry);
        }
        tracker.recordDirtyFrame(dirtyReason);
        invalidate();
      },
      signal: abortController.signal,
      targetRevision: targetRevision ?? null,
    });

    return () => {
      abortController.abort();
      if (store.getSnapshot().geometry !== uploadedGeometry) {
        releaseGeometry(uploadedGeometry);
      }
    };
  }, [
    clearCurrentGeometry,
    createGeometry,
    dirtyReason,
    enabled,
    estimatedBytes,
    invalidate,
    itemCount,
    key,
    lane,
    store,
    targetRevision,
    releaseGeometry,
    tracker,
    uploadManager,
  ]);

  return snapshot.geometry;
}

function createViewport3DGeometryUploadStore():
  Viewport3DGeometryUploadStore {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_VIEWPORT_3D_GEOMETRY_UPLOAD_SNAPSHOT;

  function publish(geometry: BufferGeometry | null): void {
    if (snapshot.geometry === geometry) return;
    snapshot = {
      geometry,
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
