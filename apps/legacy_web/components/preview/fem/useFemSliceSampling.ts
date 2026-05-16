"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendPerfSample, type PerfSample } from "@/lib/debug/frontendPerfDebug";
import { useViewportResourceOwner } from "@/lib/workspace/viewport-resource-owner-context";
import type { FemMeshData } from "./femMeshTypes";
import type { SliceVisibilityState } from "./femSliceUtils";
import {
  collectSliceTopology,
  sampleSliceField,
  type SliceBoundsStrategy,
  type SliceCollection,
  type SlicePlane,
  type SliceTopologyCollection,
  type VectorComponent,
} from "./femSliceGeometry";
import {
  fieldCacheKey,
  getSliceCacheSnapshot,
  getSliceFieldCached,
  getSliceTopologyCached,
  readSliceFieldCache,
  readSliceTopologyCache,
  topologyCacheKey,
  writeSliceFieldCache,
  writeSliceTopologyCache,
} from "./femSliceCache";
import type { FemSliceQuery } from "./femSliceQuery";
import {
  buildFemSliceSamplingWorkerPayload,
  type FemSliceSamplingResponse,
} from "./femSliceSamplingTransport";

type CommittedPerfSample = Omit<PerfSample, "timestampMs">;

const ENABLE_SLICE_PERF_SAMPLES = process.env.NODE_ENV !== "production";

function perfNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function useCommittedPerfSample(sample: CommittedPerfSample | null): void {
  useEffect(() => {
    if (!sample || !ENABLE_SLICE_PERF_SAMPLES) {
      return;
    }
    recordFrontendPerfSample({
      ...sample,
      timestampMs: perfNow(),
    });
  }, [sample]);
}

let nextWorkerRequestId = 1;

export interface FemSliceSamplingWorkerCallbacks {
  onSuccess: (
    message: Extract<FemSliceSamplingResponse, { ok: true }>,
    roundtripDurationMs: number,
  ) => void;
  onFailure: (message: Extract<FemSliceSamplingResponse, { ok: false }>) => void;
}

export class FemSliceSamplingWorkerClient {
  private worker: Worker | null = null;
  private activeRequestId: number | null = null;
  private activeHandler: ((event: MessageEvent<FemSliceSamplingResponse>) => void) | null = null;
  private disposed = false;

  postCompute(
    args: Omit<Parameters<typeof buildFemSliceSamplingWorkerPayload>[0], "id">,
    callbacks: FemSliceSamplingWorkerCallbacks,
  ): { ok: true; requestId: number; estimatedBytes: number } | { ok: false } {
    if (this.disposed || typeof window === "undefined" || typeof Worker === "undefined") {
      return { ok: false };
    }
    this.cancel("superseded");
    const worker = this.ensureWorker();
    if (!worker) {
      return { ok: false };
    }
    const requestId = nextWorkerRequestId++;
    const workerStart = perfNow();
    const builtPayload = buildFemSliceSamplingWorkerPayload({ ...args, id: requestId });
    const handleMessage = (event: MessageEvent<FemSliceSamplingResponse>) => {
      const message = event.data;
      if (!message || message.id !== requestId || this.activeRequestId !== requestId || this.disposed) {
        return;
      }
      this.detachHandler();
      this.activeRequestId = null;
      if (message.ok) {
        callbacks.onSuccess(message, perfNow() - workerStart);
      } else {
        callbacks.onFailure(message);
      }
    };
    this.activeRequestId = requestId;
    this.activeHandler = handleMessage;
    worker.addEventListener("message", handleMessage);
    worker.postMessage(builtPayload.message, builtPayload.transferList);
    return { ok: true, requestId, estimatedBytes: builtPayload.estimatedBytes };
  }

  cancel(_reason: string): void {
    this.detachHandler();
    this.activeRequestId = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
  }

  cancelRequest(requestId: number, reason: string): void {
    if (this.activeRequestId === requestId) {
      this.cancel(reason);
    }
  }

  dispose(reason = "dispose"): void {
    this.disposed = true;
    this.cancel(reason);
  }

  private ensureWorker(): Worker | null {
    if (!this.worker) {
      this.worker = new Worker(new URL("./femSliceSampling.worker.ts", import.meta.url), {
        type: "module",
        name: "fem-slice-sampling",
      });
      this.worker.addEventListener("error", () => {
        this.cancel("worker-error");
      });
    }
    return this.worker;
  }

  private detachHandler(): void {
    if (this.worker && this.activeHandler) {
      this.worker.removeEventListener("message", this.activeHandler);
    }
    this.activeHandler = null;
  }
}

export interface UseFemSliceSamplingArgs {
  meshData: FemMeshData;
  sliceQuery: FemSliceQuery;
  planeCoord: number;
  effectivePlane: SlicePlane;
  effectiveComponent: VectorComponent;
  quantityId?: string;
  visibilityState: SliceVisibilityState;
  boundsStrategy: SliceBoundsStrategy;
}

export interface UseFemSliceSamplingResult {
  topologyKey: string;
  fieldKey: string;
  sliceTopology: SliceTopologyCollection;
  slice: SliceCollection;
  pending: boolean;
}

export function useFemSliceSampling(args: UseFemSliceSamplingArgs): UseFemSliceSamplingResult {
  const {
    meshData,
    sliceQuery,
    planeCoord,
    effectivePlane,
    effectiveComponent,
    quantityId,
    visibilityState,
    boundsStrategy,
  } = args;

  const workerEnabled = FRONTEND_DIAGNOSTIC_FLAGS.dataPlaneRollout.femSliceWorkerSampling;
  const [workerRevision, setWorkerRevision] = useState(0);
  const [workerPending, setWorkerPending] = useState(false);
  const inflightKeyRef = useRef<string | null>(null);
  const failedWorkerKeysRef = useRef<Set<string>>(new Set());
  const lastStableResultRef = useRef<UseFemSliceSamplingResult | null>(null);
  const workerClientRef = useRef<FemSliceSamplingWorkerClient | null>(null);
  const viewportResourceOwner = useViewportResourceOwner();
  if (!workerClientRef.current) {
    workerClientRef.current = new FemSliceSamplingWorkerClient();
  }

  useEffect(() => {
    const workerClient = workerClientRef.current;
    return () => {
      workerClient?.dispose("unmount");
      workerClientRef.current = null;
    };
  }, []);

  useEffect(() => {
    const owner = viewportResourceOwner;
    const workerClient = workerClientRef.current;
    if (!owner || !workerClient) {
      return;
    }
    const cleanupKey = "fem-slice-sampling-worker";
    const cleanup = () => workerClient.dispose("viewport-resource-owner-dispose");
    owner.registerCleanup(cleanupKey, cleanup);
    return () => {
      owner.unregisterCleanup(cleanupKey, cleanup);
    };
  }, [viewportResourceOwner]);

  const topologyKey = useMemo(
    () =>
      topologyCacheKey(sliceQuery, {
        planeWorldCoord: planeCoord,
        meshNodes: meshData.nodes as unknown as object,
        meshElements: meshData.elements as unknown as object,
        meshBoundaryFaces: meshData.boundaryFaces as unknown as object,
        visibleElements: visibilityState.visibleElements,
        visibleBoundaryFaces: visibilityState.visibleBoundaryFaces,
        visiblePartIds: visibilityState.visiblePartIds,
        boundsStrategy,
      }),
    [
      boundsStrategy,
      meshData.boundaryFaces,
      meshData.elements,
      meshData.nodes,
      planeCoord,
      sliceQuery,
      visibilityState,
    ],
  );
  const fieldKey = useMemo(
    () =>
      fieldCacheKey(sliceQuery, {
        planeWorldCoord: planeCoord,
        meshNodes: meshData.nodes as unknown as object,
        meshElements: meshData.elements as unknown as object,
        meshBoundaryFaces: meshData.boundaryFaces as unknown as object,
        visibleElements: visibilityState.visibleElements,
        visibleBoundaryFaces: visibilityState.visibleBoundaryFaces,
        visiblePartIds: visibilityState.visiblePartIds,
        boundsStrategy,
        fieldX: meshData.fieldData?.x as object | null | undefined,
        fieldY: meshData.fieldData?.y as object | null | undefined,
        fieldZ: meshData.fieldData?.z as object | null | undefined,
        fieldRevision: meshData.fieldRevision,
        fieldNComp: meshData.fieldNComp,
      }),
    [
      boundsStrategy,
      meshData.boundaryFaces,
      meshData.elements,
      meshData.fieldData?.x,
      meshData.fieldData?.y,
      meshData.fieldData?.z,
      meshData.fieldNComp,
      meshData.fieldRevision,
      meshData.nodes,
      planeCoord,
      sliceQuery,
      visibilityState,
    ],
  );

  const requestKey = `${topologyKey}::${fieldKey}`;
  const cachedTopology = useMemo(
    () => readSliceTopologyCache(topologyKey),
    [topologyKey, workerRevision],
  );
  const cachedField = useMemo(
    () => readSliceFieldCache(fieldKey),
    [fieldKey, workerRevision],
  );
  const hasCachedResult = Boolean(cachedTopology && cachedField);
  const shouldFallbackToSync =
    !workerEnabled ||
    failedWorkerKeysRef.current.has(requestKey) ||
    !lastStableResultRef.current ||
    hasCachedResult;

  const syncMeasurement = useMemo<{
    topology: SliceTopologyCollection;
    slice: SliceCollection;
    topologySample: CommittedPerfSample | null;
    fieldSample: CommittedPerfSample | null;
  } | null>(() => {
    if (!shouldFallbackToSync) {
      return null;
    }
    const topologyStart = ENABLE_SLICE_PERF_SAMPLES ? perfNow() : 0;
    const topologyResult = getSliceTopologyCached(topologyKey, () =>
      collectSliceTopology(
        meshData,
        effectivePlane,
        planeCoord,
        visibilityState,
        boundsStrategy,
      ),
    );

    const fieldStart = ENABLE_SLICE_PERF_SAMPLES ? perfNow() : 0;
    const fieldResult = getSliceFieldCached(fieldKey, () =>
      sampleSliceField(meshData, effectivePlane, effectiveComponent, topologyResult.value),
    );

    const cacheSnapshot = getSliceCacheSnapshot();

    return {
      topology: topologyResult.value,
      slice: fieldResult.value,
      topologySample: ENABLE_SLICE_PERF_SAMPLES
        ? {
            scope: "FemSlice2D",
            phase: "topology",
            durationMs: fieldStart - topologyStart,
            meta: {
              cacheState: topologyResult.cacheState,
              topologyCacheEntries: cacheSnapshot.topologyEntries,
              topologyCacheCapacity: cacheSnapshot.topologyCapacity,
              topologyCacheEstimatedBytes: cacheSnapshot.topologyEstimatedBytes,
              plane: effectivePlane,
              boundsStrategy,
              elements: visibilityState.visibleElements?.length ?? 0,
              boundaryFaces: visibilityState.visibleBoundaryFaces?.length ?? 0,
              polygons: topologyResult.value.polygons.length,
              segments: topologyResult.value.segments.length,
            },
          }
        : null,
      fieldSample: ENABLE_SLICE_PERF_SAMPLES
        ? {
            scope: "FemSlice2D",
            phase: "field",
            durationMs: perfNow() - fieldStart,
            meta: {
              cacheState: fieldResult.cacheState,
              fieldCacheEntries: cacheSnapshot.fieldEntries,
              fieldCacheCapacity: cacheSnapshot.fieldCapacity,
              fieldCacheEstimatedBytes: cacheSnapshot.fieldEstimatedBytes,
              plane: effectivePlane,
              component: effectiveComponent,
              quantity: quantityId ?? "m",
              fieldNComp: meshData.fieldNComp ?? 0,
              fieldRevision:
                typeof meshData.fieldRevision === "number"
                  ? meshData.fieldRevision
                  : meshData.fieldRevision
                    ? String(meshData.fieldRevision)
                    : "none",
              polygons: fieldResult.value.polygons.length,
              arrows: fieldResult.value.arrows.length,
            },
          }
        : null,
    };
  }, [
    boundsStrategy,
    effectiveComponent,
    effectivePlane,
    fieldKey,
    meshData,
    planeCoord,
    quantityId,
    shouldFallbackToSync,
    topologyKey,
    visibilityState,
  ]);

  useCommittedPerfSample(syncMeasurement?.topologySample ?? null);
  useCommittedPerfSample(syncMeasurement?.fieldSample ?? null);

  useEffect(() => {
    if (!syncMeasurement) {
      return;
    }
    lastStableResultRef.current = {
      topologyKey,
      fieldKey,
      sliceTopology: syncMeasurement.topology,
      slice: syncMeasurement.slice,
      pending: false,
    };
  }, [fieldKey, syncMeasurement, topologyKey]);

  useEffect(() => {
    if (shouldFallbackToSync) {
      workerClientRef.current?.cancel("fallback");
      setWorkerPending(false);
      inflightKeyRef.current = null;
      return;
    }
    const workerClient = workerClientRef.current;
    if (!workerClient) {
      failedWorkerKeysRef.current.add(requestKey);
      setWorkerRevision((version) => version + 1);
      setWorkerPending(false);
      inflightKeyRef.current = null;
      return;
    }
    if (inflightKeyRef.current === requestKey) {
      return;
    }

    inflightKeyRef.current = requestKey;
    setWorkerPending(true);
    const postResult = workerClient.postCompute(
      {
        meshData,
        plane: effectivePlane,
        planeCoord,
        component: effectiveComponent,
        visibilityState,
        boundsStrategy,
      },
      {
        onSuccess: (message, roundtripDurationMs) => {
          if (inflightKeyRef.current !== requestKey) {
            return;
          }
          inflightKeyRef.current = null;
          failedWorkerKeysRef.current.delete(requestKey);
          writeSliceTopologyCache(topologyKey, message.topology);
          writeSliceFieldCache(fieldKey, message.slice);

          if (ENABLE_SLICE_PERF_SAMPLES) {
            const cacheSnapshot = getSliceCacheSnapshot();
            recordFrontendPerfSample({
              scope: "FemSlice2D",
              phase: "worker-roundtrip",
              durationMs: roundtripDurationMs,
              timestampMs: perfNow(),
              meta: {
                plane: effectivePlane,
                component: effectiveComponent,
                quantity: quantityId ?? "m",
                topologyDurationMs: message.topologyDurationMs,
                fieldDurationMs: message.fieldDurationMs,
                topologyCacheEntries: cacheSnapshot.topologyEntries,
                fieldCacheEntries: cacheSnapshot.fieldEntries,
              },
            });
          }

          setWorkerRevision((version) => version + 1);
          setWorkerPending(false);
        },
        onFailure: () => {
          if (inflightKeyRef.current !== requestKey) {
            return;
          }
          inflightKeyRef.current = null;
          failedWorkerKeysRef.current.add(requestKey);
          setWorkerRevision((version) => version + 1);
          setWorkerPending(false);
        },
      },
    );
    if (!postResult.ok) {
      failedWorkerKeysRef.current.add(requestKey);
      setWorkerRevision((version) => version + 1);
      setWorkerPending(false);
      inflightKeyRef.current = null;
      return;
    }

    return () => {
      if (inflightKeyRef.current === requestKey) {
        inflightKeyRef.current = null;
      }
      workerClient.cancelRequest(postResult.requestId, "effect-cleanup");
    };
  }, [
    boundsStrategy,
    effectiveComponent,
    effectivePlane,
    fieldKey,
    meshData,
    planeCoord,
    quantityId,
    requestKey,
    shouldFallbackToSync,
    topologyKey,
    visibilityState,
  ]);

  const result = syncMeasurement
    ? {
        topologyKey,
        fieldKey,
        sliceTopology: syncMeasurement.topology,
        slice: syncMeasurement.slice,
        pending: false,
      }
    : lastStableResultRef.current;

  if (!result) {
    // First render safety fallback when worker path is enabled but no stable snapshot exists yet.
    const topology = collectSliceTopology(
      meshData,
      effectivePlane,
      planeCoord,
      visibilityState,
      boundsStrategy,
    );
    const slice = sampleSliceField(meshData, effectivePlane, effectiveComponent, topology);
    writeSliceTopologyCache(topologyKey, topology);
    writeSliceFieldCache(fieldKey, slice);
    return {
      topologyKey,
      fieldKey,
      sliceTopology: topology,
      slice,
      pending: false,
    };
  }

  return {
    ...result,
    pending: workerPending,
  };
}
