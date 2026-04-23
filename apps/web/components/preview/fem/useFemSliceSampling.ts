"use client";

import { useEffect, useMemo } from "react";
import { recordFrontendPerfSample, type PerfSample } from "@/lib/debug/frontendPerfDebug";
import type { FemMeshData } from "./femMeshTypes";
import type { SliceVisibilityState } from "./femSliceUtils";
import {
  collectSliceTopology,
  sampleSliceField,
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
  topologyCacheKey,
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

export interface UseFemSliceSamplingArgs {
  meshData: FemMeshData;
  sliceQuery: FemSliceQuery;
  planeCoord: number;
  effectivePlane: SlicePlane;
  effectiveComponent: VectorComponent;
  quantityId?: string;
  visibilityState: SliceVisibilityState;
  boundsStrategy: "visible-intersection" | "visible-context";
}

export interface UseFemSliceSamplingResult {
  topologyKey: string;
  fieldKey: string;
  sliceTopology: SliceTopologyCollection;
  slice: SliceCollection;
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
  const sliceTopologyMeasurement = useMemo<{
    value: SliceTopologyCollection;
    sample: CommittedPerfSample | null;
  }>(() => {
    const start = ENABLE_SLICE_PERF_SAMPLES ? perfNow() : 0;
    const topologyResult = getSliceTopologyCached(topologyKey, () =>
      collectSliceTopology(
        meshData,
        effectivePlane,
        planeCoord,
        visibilityState,
        boundsStrategy,
      ),
    );
    const cacheSnapshot = getSliceCacheSnapshot();
    return {
      value: topologyResult.value,
      sample: ENABLE_SLICE_PERF_SAMPLES
        ? {
            scope: "FemSlice2D",
            phase: "topology",
            durationMs: perfNow() - start,
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
    };
  },
    [
      boundsStrategy,
      effectivePlane,
      meshData,
      planeCoord,
      topologyKey,
      visibilityState,
    ],
  );
  const sliceTopology = sliceTopologyMeasurement.value;
  useCommittedPerfSample(sliceTopologyMeasurement.sample);

  const sliceMeasurement = useMemo<{
    value: SliceCollection;
    sample: CommittedPerfSample | null;
  }>(() => {
    const start = ENABLE_SLICE_PERF_SAMPLES ? perfNow() : 0;
    const fieldResult = getSliceFieldCached(fieldKey, () =>
      sampleSliceField(meshData, effectivePlane, effectiveComponent, sliceTopology),
    );
    const cacheSnapshot = getSliceCacheSnapshot();
    return {
      value: fieldResult.value,
      sample: ENABLE_SLICE_PERF_SAMPLES
        ? {
            scope: "FemSlice2D",
            phase: "field",
            durationMs: perfNow() - start,
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
  },
    [
      effectiveComponent,
      effectivePlane,
      fieldKey,
      meshData,
      quantityId,
      sliceTopology,
    ],
  );
  const slice = sliceMeasurement.value;
  useCommittedPerfSample(sliceMeasurement.sample);

  return {
    topologyKey,
    fieldKey,
    sliceTopology,
    slice,
  };
}
