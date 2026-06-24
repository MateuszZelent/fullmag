"use client";

import type { ThreeEvent } from "@react-three/fiber";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { BufferAttribute, BufferGeometry } from "three";

import { createViewport3DGpuUploadManager } from "../build-engine/gpu/viewport3dGpuUploadManager";
import type {
  Viewport3DGpuUploadChunk,
  Viewport3DGpuUploadManager,
} from "../build-engine/gpu/viewport3dGpuUploadTypes";
import type { Viewport3DResourceTracker } from "../viewport3dDiagnostics";
import { useBatchedInvalidate } from "../viewport3dBatchedInvalidate";
import { type RegionMeshOverlayModel } from "./regionOverlayModel";
import { materialPolicyProps, RENDER_POLICIES } from "./viewport3DRenderPolicy";
import type { RegionOverlaySelection } from "./RegionOverlayLayer";

export interface RegionMeshOverlayLayerProps {
  models: readonly RegionMeshOverlayModel[];
  onSelectRegion?: (selection: RegionOverlaySelection) => void;
  targetVisualizationRevision?: string | number | null;
  topologyRevision?: string | number | null;
  tracker: Viewport3DResourceTracker;
  visible?: boolean;
}

const CSS_VARIABLE_COLOR_PATTERN = /^var\((--[-_a-zA-Z0-9]+)\)$/;
const REGION_MESH_OVERLAY_UPLOAD_FRAME_BUDGET_MS = 3;

interface RegionMeshOverlayGeometrySnapshot {
  readonly geometry: BufferGeometry | null;
  readonly version: number;
}

interface RegionMeshOverlayGeometryStore {
  readonly getSnapshot: () => RegionMeshOverlayGeometrySnapshot;
  readonly publish: (geometry: BufferGeometry | null) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY_REGION_MESH_OVERLAY_GEOMETRY_SNAPSHOT:
  RegionMeshOverlayGeometrySnapshot = {
    geometry: null,
    version: 0,
  };

function resolveCssColorToken(color: string): string {
  const match = CSS_VARIABLE_COLOR_PATTERN.exec(color.trim());
  if (!match || typeof document === "undefined") return color;

  const resolved = getComputedStyle(document.documentElement)
    .getPropertyValue(match[1])
    .trim();
  return resolved || color;
}

export function RegionMeshOverlayLayer({
  models,
  onSelectRegion,
  targetVisualizationRevision = null,
  topologyRevision = null,
  tracker,
  visible = true,
}: RegionMeshOverlayLayerProps) {
  const uploadManager = useMemo(
    () =>
      createViewport3DGpuUploadManager({
        policy: {
          targetFrameBudgetMs: REGION_MESH_OVERLAY_UPLOAD_FRAME_BUDGET_MS,
        },
      }),
    [],
  );
  useEffect(() => () => uploadManager.dispose(), [uploadManager]);

  if (!visible || models.length === 0) return null;

  return (
    <group name="region-mesh-overlays">
      {models.map((model) => (
        <RegionMeshOverlayShape
          key={model.regionId}
          model={model}
          onSelectRegion={onSelectRegion}
          targetVisualizationRevision={targetVisualizationRevision}
          topologyRevision={topologyRevision}
          tracker={tracker}
          uploadManager={uploadManager}
        />
      ))}
    </group>
  );
}

function RegionMeshOverlayShape({
  model,
  onSelectRegion,
  targetVisualizationRevision,
  topologyRevision,
  tracker,
  uploadManager,
}: {
  model: RegionMeshOverlayModel;
  onSelectRegion?: (selection: RegionOverlaySelection) => void;
  targetVisualizationRevision?: string | number | null;
  topologyRevision?: string | number | null;
  tracker: Viewport3DResourceTracker;
  uploadManager: Viewport3DGpuUploadManager;
}) {
  const invalidate = useBatchedInvalidate();
  const surfaceGeometry = useRegionMeshOverlayGeometryUpload({
    dirtyReason: "region-mesh-overlay",
    enabled: Boolean(model.surfaceIndices?.length && model.style.fillVisible),
    indices: model.surfaceIndices ?? null,
    invalidate,
    kind: "surface",
    model,
    targetVisualizationRevision,
    topologyRevision,
    tracker,
    uploadManager,
  });
  const edgeGeometry = useRegionMeshOverlayGeometryUpload({
    dirtyReason: "region-mesh-overlay",
    enabled: Boolean(
      (model.surfaceEdgeIndices?.length || model.edgeIndices?.length) &&
        model.style.wireframeVisible,
    ),
    indices: model.surfaceEdgeIndices ?? model.edgeIndices,
    invalidate,
    kind: "edge",
    model,
    targetVisualizationRevision,
    topologyRevision,
    tracker,
    uploadManager,
  });

  if (!surfaceGeometry && !edgeGeometry) return null;

  const handlePointerDown = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    onSelectRegion?.({ objectId: model.objectId, regionId: model.regionId });
  };
  const selectRegionFromClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    onSelectRegion?.({ objectId: model.objectId, regionId: model.regionId });
  };
  const fillColor = resolveCssColorToken(model.style.surfaceColor ?? model.color);
  const wireframeColor = resolveCssColorToken(
    model.style.wireframeColor ?? model.color,
  );

  return (
    <group
      name={`region-mesh-overlay:${model.regionId}`}
      onClick={selectRegionFromClick}
      onPointerDown={handlePointerDown}
    >
      {surfaceGeometry ? (
        <mesh
          geometry={surfaceGeometry}
          renderOrder={RENDER_POLICIES.selectionShell.renderOrder}
        >
          <meshBasicMaterial
            color={fillColor}
            colorWrite={model.surfaceOverlayVisible}
            opacity={model.surfaceOverlayVisible ? model.style.fillOpacity : 0}
            {...materialPolicyProps("selectionShell")}
            depthWrite={
              model.surfaceOverlayVisible && model.style.fillOpacity >= 1
            }
            transparent={!model.surfaceOverlayVisible || model.style.fillOpacity < 1}
          />
        </mesh>
      ) : null}
      {edgeGeometry ? (
        <lineSegments
          geometry={edgeGeometry}
          renderOrder={RENDER_POLICIES.featureEdges.renderOrder + 1}
        >
          <lineBasicMaterial
            color={wireframeColor}
            opacity={model.style.wireframeOpacity}
            {...materialPolicyProps("featureEdges")}
          />
        </lineSegments>
      ) : null}
    </group>
  );
}

function useRegionMeshOverlayGeometryUpload({
  dirtyReason,
  enabled,
  indices,
  invalidate,
  kind,
  model,
  targetVisualizationRevision,
  topologyRevision,
  tracker,
  uploadManager,
}: {
  dirtyReason: string;
  enabled: boolean;
  indices: Uint32Array | null | undefined;
  invalidate: () => void;
  kind: "edge" | "surface";
  model: RegionMeshOverlayModel;
  targetVisualizationRevision?: string | number | null;
  topologyRevision?: string | number | null;
  tracker: Viewport3DResourceTracker;
  uploadManager: Viewport3DGpuUploadManager;
}): BufferGeometry | null {
  const store = useMemo(() => createRegionMeshOverlayGeometryStore(), []);
  const snapshot = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const uploadKey = createRegionMeshOverlayGeometryUploadKey({
    indexBytes: indices?.byteLength ?? 0,
    kind,
    positionsBytes: model.positions.byteLength,
    regionId: model.regionId,
    targetVisualizationRevision,
    topologyRevision,
  });

  useEffect(() => {
    store.publish(null);

    if (!enabled || !indices?.length) return;

    const abortController = new AbortController();
    let uploadedGeometry: BufferGeometry | null = null;
    const estimatedBytes = model.positions.byteLength + indices.byteLength;
    const chunks: Viewport3DGpuUploadChunk[] = [
      {
        estimatedBytes,
        itemCount: indices.length,
        upload: () => {
          uploadedGeometry = tracker.track(
            "geometry",
            createRegionMeshOverlayGeometry(model.positions, indices),
          );
        },
      },
    ];

    uploadManager.enqueue({
      chunks,
      estimatedBytes,
      key: uploadKey,
      lane: "region-overlay",
      onVisible: () => {
        if (!uploadedGeometry) return;
        store.publish(uploadedGeometry);
        tracker.recordDirtyFrame(dirtyReason);
        invalidate();
      },
      signal: abortController.signal,
      targetRevision: uploadKey,
    });

    return () => {
      abortController.abort();
      if (!uploadedGeometry) return;
      if (store.getSnapshot().geometry === uploadedGeometry) {
        store.publish(null);
      }
      tracker.release("geometry", uploadedGeometry);
    };
  }, [
    dirtyReason,
    enabled,
    indices,
    invalidate,
    model.positions,
    store,
    targetVisualizationRevision,
    topologyRevision,
    tracker,
    uploadKey,
    uploadManager,
  ]);

  return snapshot.geometry;
}

function createRegionMeshOverlayGeometryStore():
  RegionMeshOverlayGeometryStore {
  const listeners = new Set<() => void>();
  let snapshot = EMPTY_REGION_MESH_OVERLAY_GEOMETRY_SNAPSHOT;

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

function createRegionMeshOverlayGeometry(
  positions: Float32Array,
  indices: Uint32Array,
): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

function createRegionMeshOverlayGeometryUploadKey({
  indexBytes,
  kind,
  positionsBytes,
  regionId,
  targetVisualizationRevision,
  topologyRevision,
}: {
  indexBytes: number;
  kind: "edge" | "surface";
  positionsBytes: number;
  regionId: string;
  targetVisualizationRevision?: string | number | null;
  topologyRevision?: string | number | null;
}): string {
  return [
    "region-overlay-geometry",
    `region=${regionId}`,
    `kind=${kind}`,
    `topology=${topologyRevision ?? "none"}`,
    `targets=${targetVisualizationRevision ?? "none"}`,
    `positions=${positionsBytes}`,
    `indices=${indexBytes}`,
  ].join(":");
}
