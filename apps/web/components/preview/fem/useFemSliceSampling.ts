"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { recordFrontendPerfSample, type PerfSample } from "@/lib/debug/frontendPerfDebug";
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

interface WorkerSamplingRequest {
  id: number;
  type: "compute";
  payload: {
    meshData: FemMeshData;
    plane: SlicePlane;
    planeCoord: number;
    component: VectorComponent;
    visibilityState: SliceVisibilityState;
    boundsStrategy: SliceBoundsStrategy;
  };
}

interface WorkerSamplingSuccess {
  id: number;
  ok: true;
  topology: SliceTopologyCollection;
  slice: SliceCollection;
  topologyDurationMs: number;
  fieldDurationMs: number;
}

interface WorkerSamplingFailure {
  id: number;
  ok: false;
  error: string;
}

type WorkerSamplingResponse = WorkerSamplingSuccess | WorkerSamplingFailure;

let femSliceSamplingWorker: Worker | null = null;
let nextWorkerRequestId = 1;

function getFemSliceSamplingWorker(): Worker | null {
  if (typeof window === "undefined" || typeof Worker === "undefined") {
    return null;
  }
  if (!femSliceSamplingWorker) {
    femSliceSamplingWorker = new Worker(new URL("./femSliceSampling.worker.ts", import.meta.url), {
      type: "module",
      name: "fem-slice-sampling",
    });
  }
  return femSliceSamplingWorker;
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
      setWorkerPending(false);
      inflightKeyRef.current = null;
      return;
    }
    const worker = getFemSliceSamplingWorker();
    if (!worker) {
      failedWorkerKeysRef.current.add(requestKey);
      setWorkerRevision((version) => version + 1);
      setWorkerPending(false);
      inflightKeyRef.current = null;
      return;
    }
    if (inflightKeyRef.current === requestKey) {
      return;
    }

    const requestId = nextWorkerRequestId++;
    inflightKeyRef.current = requestKey;
    setWorkerPending(true);
    const workerStart = perfNow();

    const handleMessage = (event: MessageEvent<WorkerSamplingResponse>) => {
      const message = event.data;
      if (!message || message.id !== requestId) {
        return;
      }
      worker.removeEventListener("message", handleMessage);
      inflightKeyRef.current = null;
      if (!message.ok) {
        failedWorkerKeysRef.current.add(requestKey);
        setWorkerRevision((version) => version + 1);
        setWorkerPending(false);
        return;
      }

      failedWorkerKeysRef.current.delete(requestKey);
      writeSliceTopologyCache(topologyKey, message.topology);
      writeSliceFieldCache(fieldKey, message.slice);

      if (ENABLE_SLICE_PERF_SAMPLES) {
        const cacheSnapshot = getSliceCacheSnapshot();
        recordFrontendPerfSample({
          scope: "FemSlice2D",
          phase: "worker-roundtrip",
          durationMs: perfNow() - workerStart,
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
    };

    worker.addEventListener("message", handleMessage);
    worker.postMessage({
      id: requestId,
      type: "compute",
      payload: {
        meshData,
        plane: effectivePlane,
        planeCoord,
        component: effectiveComponent,
        visibilityState,
        boundsStrategy,
      },
    } satisfies WorkerSamplingRequest);

    return () => {
      worker.removeEventListener("message", handleMessage);
      if (inflightKeyRef.current === requestKey) {
        inflightKeyRef.current = null;
      }
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
