"use client";

import dynamic from "next/dynamic";
import { useMemo } from "react";
import type { ReactNode } from "react";

import { resolveApiBase } from "@/lib/apiBase";
import { Slice2DShell } from "@/src/features/slice2d";
import { percentFromWorldPosition } from "@/src/features/slice2d/axisMapping";
import type { Slice2DModel } from "@/src/features/slice2d";
import type { CrossSurfaceSelectionState } from "@/src/features/workspaceSync";
import { sessionApiPaths } from "@/src/api/client/sessionPaths";
import type {
  DomainSliceMeshOverlayQuery,
  FieldProjectionMeta,
  FieldProjectionQuery,
  ResourceRevisionMap,
  FieldSliceMeta,
  FieldSliceQuery,
} from "@/src/api/types";
import type { SliceArrowData } from "@/src/hooks/resources/useFieldSlice2D";
import { useSliceMeshOverlay2D } from "@/src/hooks/resources/useSliceMeshOverlay2D";
import type { LiveApiError } from "@/src/api/client/errors/LiveApiError";
import type { FemMeshData, FemVectorDomainFilter } from "@/components/preview/FemMeshView3D";
import MagnetizationSlice2D from "@/components/preview/MagnetizationSlice2D";
import {
  buildExactSliceMeshOverlay2D,
  capSliceMeshOverlay2D,
  SLICE_MESH_OVERLAY_SOFT_SEGMENT_CAP,
  type SliceMeshOverlay2D,
} from "@/components/preview/fem/sliceMeshOverlay2D";
import EmptyState from "../../ui/EmptyState";
import {
  type MeshEntityViewStateMap,
  type FemMeshPart,
} from "../../../lib/session/types";
import type { AntennaOverlay, ObjectViewMode } from "./shared";
import { resolveSlice2DAirboxViewState } from "./slice2DAirboxViewState";

type SlicePlane = "xy" | "xz" | "yz";
type VectorComponent = "x" | "y" | "z" | "magnitude";
type FemArrowColorMode = "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
type SliceMeshOverlaySourceKind = "backend" | "local" | "none";
type SliceMeshOverlayStatus = "ready" | "loading" | "error" | "unavailable";

export interface SliceMeshOverlaySourceState {
  overlay: SliceMeshOverlay2D | null;
  source: SliceMeshOverlaySourceKind;
  status: SliceMeshOverlayStatus;
  message: string | null;
}

interface QuantityOption {
  id: string;
  shortLabel: string;
  label?: string;
  available: boolean;
}

function ViewportModuleLoading({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

const FemMeshSlice2D = dynamic(() => import("@/components/preview/FemMeshSlice2DECharts"), {
  ssr: false,
  loading: () => <ViewportModuleLoading label="Loading FEM slice viewport..." />,
});

export function resolveSliceMeshOverlaySource({
  backend,
  local,
  loading,
  error,
  enabled,
}: {
  backend: SliceMeshOverlay2D | null;
  local: SliceMeshOverlay2D | null;
  loading: boolean;
  error: LiveApiError | null;
  enabled: boolean;
}): SliceMeshOverlaySourceState {
  if (!enabled) {
    return {
      overlay: null,
      source: "none",
      status: "unavailable",
      message: "Mesh overlay disabled",
    };
  }
  if (backend) {
    const capped = capSliceMeshOverlay2D(backend);
    return {
      overlay: capped,
      source: "backend",
      status: "ready",
      message:
        backend.segments.length > SLICE_MESH_OVERLAY_SOFT_SEGMENT_CAP
          ? "mesh: backend sampled"
          : "mesh: backend",
    };
  }
  if (local) {
    const capped = capSliceMeshOverlay2D(local);
    return {
      overlay: capped,
      source: "local",
      status: loading ? "loading" : "ready",
      message:
        local.segments.length > SLICE_MESH_OVERLAY_SOFT_SEGMENT_CAP
          ? "mesh: local sampled"
          : error
            ? "mesh: local fallback after backend error"
            : "mesh: local",
    };
  }
  if (loading) {
    return {
      overlay: null,
      source: "none",
      status: "loading",
      message: "mesh: loading",
    };
  }
  if (error) {
    return {
      overlay: null,
      source: "none",
      status: "error",
      message: error.message || "mesh overlay request failed",
    };
  }
  return {
    overlay: null,
    source: "none",
    status: "unavailable",
    message: "mesh: unavailable",
  };
}

export interface UnifiedViewport2DPresenterProps {
  slice2DModel?: Slice2DModel | null;
  workspaceSelection?: CrossSurfaceSelectionState | null;
  shouldUseSliceApi2D: boolean;
  hasSliceScalar: boolean;
  sliceLoading: boolean;
  sliceStateKind?: "empty" | "loading" | "ready" | "unsupported" | "error";
  sliceHasStaleData?: boolean;
  sliceErrorMessage: string | null;
  sliceMeta: FieldSliceMeta | FieldProjectionMeta | null;
  sliceArrows: SliceArrowData | null;
  runtimeResourceRevisions?: Partial<ResourceRevisionMap> | null;
  grid: [number, number, number];
  vectors: Float64Array | null;
  sliceScalarValues: Float64Array | null;
  sliceScalarShape: [number, number] | null;
  quantityLabel: string;
  quantityId?: string;
  quantityUnit?: string | null;
  quantityComponentCount?: number | null;
  component: VectorComponent;
  plane: SlicePlane;
  sliceIndex: number;
  preferFemMesh: boolean;
  femMeshData: FemMeshData | null;
  femQuantityLabel: string;
  femQuantityId?: string;
  femQuantityUnit?: string;
  femQuantityOptions: QuantityOption[];
  femComponent: VectorComponent;
  meshParts: FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  meshRenderMode: "wireframe" | "surface" | "surface+edges" | "mesh" | "points" | null;
  showPrimitives: boolean;
  showMesh: boolean;
  showQuantity: boolean;
  airSegmentVisible: boolean;
  objectViewMode: ObjectViewMode;
  visibleObjectIds: string[];
  vectorDomainFilter: FemVectorDomainFilter;
  clipAxis: "x" | "y" | "z";
  clipPos: number;
  antennaOverlays: AntennaOverlay[];
  selectedAntennaId: string | null;
  showArrows: boolean;
  vectorColorMode?: FemArrowColorMode;
  vectorMonoColor?: string;
  previewMaxPoints: number;
  onQuantityChange: (quantityId: string) => void;
  onComponentChange: (component: VectorComponent) => void;
  onPlaneChange: (plane: SlicePlane) => void;
  onClipAxisChange: (axis: "x" | "y" | "z") => void;
  onClipPosChange: (value: number) => void;
  onShowArrowsChange: (value: boolean) => void;
  onPreviewMaxPointsChange: (value: number) => void;
}

export default function UnifiedViewport2DPresenter({
  slice2DModel,
  workspaceSelection,
  shouldUseSliceApi2D,
  hasSliceScalar,
  sliceLoading,
  sliceStateKind,
  sliceHasStaleData = false,
  sliceErrorMessage,
  sliceMeta,
  sliceArrows,
  runtimeResourceRevisions = null,
  grid,
  vectors,
  sliceScalarValues,
  sliceScalarShape,
  quantityLabel,
  quantityId,
  quantityUnit,
  quantityComponentCount = null,
  component,
  plane,
  sliceIndex,
  preferFemMesh,
  femMeshData,
  femQuantityLabel,
  femQuantityId,
  femQuantityUnit,
  femQuantityOptions,
  femComponent,
  meshParts,
  meshEntityViewState,
  meshRenderMode,
  showPrimitives,
  showMesh,
  showQuantity,
  airSegmentVisible,
  objectViewMode,
  visibleObjectIds,
  vectorDomainFilter,
  clipAxis,
  clipPos,
  antennaOverlays,
  selectedAntennaId,
  showArrows,
  vectorColorMode = "orientation",
  vectorMonoColor = "#38d9ff",
  previewMaxPoints,
  onQuantityChange,
  onComponentChange,
  onPlaneChange,
  onClipAxisChange,
  onClipPosChange,
  onShowArrowsChange,
  onPreviewMaxPointsChange,
}: UnifiedViewport2DPresenterProps) {
  const toolbar = slice2DModel?.toolbar ?? null;
  const effectiveShowMesh = toolbar?.renderMode === "mesh-overlay"
    ? true
    : toolbar?.showMesh ?? showMesh;
  const effectiveShowQuantity = toolbar?.renderMode === "mesh-overlay"
    ? toolbar.showQuantity
    : toolbar?.showQuantity ?? showQuantity;
  const effectiveShowPrimitives = toolbar?.showPrimitives ?? showPrimitives;
  const effectiveShowArrows = toolbar ? Boolean(toolbar.showVectors) : showArrows;
  const effectiveClipAxis = toolbar?.axis ?? clipAxis;
  const effectiveClipPos =
    toolbar?.normalAxisBounds && typeof toolbar.positionWorld === "number"
      ? percentFromWorldPosition(
        toolbar.normalAxisBounds.min,
        toolbar.normalAxisBounds.max,
        toolbar.positionWorld,
      )
      : toolbar?.positionPercent ?? clipPos;
  const effectiveAirboxVisible = toolbar?.showAirbox ?? airSegmentVisible;
  const effectiveMeshOverlayEnabled = effectiveShowMesh || effectiveAirboxVisible;
  const effectiveVectorDomainFilter: FemVectorDomainFilter =
    toolbar?.showAirboxVectors && effectiveAirboxVisible
      ? "airbox_only"
      : vectorDomainFilter;
  const effectiveMeshEntityViewState = useMemo(() => {
    if (!toolbar) {
      return meshEntityViewState;
    }
    return resolveSlice2DAirboxViewState({
      meshParts,
      meshEntityViewState,
      visible: effectiveAirboxVisible,
      renderMode: toolbar.airboxRenderMode,
    });
  }, [effectiveAirboxVisible, meshEntityViewState, meshParts, toolbar]);
  const backendSliceMeshOverlayRequest = useMemo(() => {
    if (
      !shouldUseSliceApi2D ||
      !effectiveShowMesh ||
      !isSliceMeta(sliceMeta) ||
      !canUseBackendSliceMeshOverlay({
        meshParts,
        meshEntityViewState: effectiveMeshEntityViewState,
        airSegmentVisible: effectiveAirboxVisible,
        objectViewMode,
        visibleObjectIds,
      })
    ) {
      return null;
    }
    const query = resolveBackendSliceMeshOverlayQuery(sliceMeta);
    if (!query) {
      return null;
    }
    return {
      domainGenerationId: sliceMeta.domain_generation_id,
      topologyRevision:
        runtimeResourceRevisions?.mesh_revision ?? sliceMeta.domain_generation_id,
      query,
    };
  }, [
    effectiveAirboxVisible,
    effectiveMeshEntityViewState,
    effectiveShowMesh,
    meshParts,
    objectViewMode,
    runtimeResourceRevisions?.mesh_revision,
    shouldUseSliceApi2D,
    sliceMeta,
    visibleObjectIds,
  ]);
  const {
    overlay: backendSliceMeshOverlay,
    loading: backendSliceMeshOverlayLoading,
    error: backendSliceMeshOverlayError,
  } = useSliceMeshOverlay2D(
    backendSliceMeshOverlayRequest,
  );
  const apiSliceMeshOverlay = useMemo(() => {
    if (
      !shouldUseSliceApi2D ||
      !femMeshData ||
      !effectiveMeshOverlayEnabled ||
      !toolbar ||
      toolbar.mode !== "single" ||
      !isSliceMeta(sliceMeta)
    ) {
      return null;
    }
    return buildExactSliceMeshOverlay2D({
      meshData: femMeshData,
      meta: sliceMeta,
      toolbar,
      meshParts,
      meshEntityViewState: effectiveMeshEntityViewState,
      airSegmentVisible: effectiveAirboxVisible,
      objectViewMode,
      visibleObjectIds,
      partRoleFilter:
        effectiveAirboxVisible && !effectiveShowMesh
          ? new Set<FemMeshPart["role"]>(["air", "outer_boundary"])
          : undefined,
    });
  }, [
    effectiveAirboxVisible,
    effectiveMeshEntityViewState,
    effectiveMeshOverlayEnabled,
    femMeshData,
    meshParts,
    objectViewMode,
    shouldUseSliceApi2D,
    sliceMeta,
    toolbar,
    visibleObjectIds,
  ]);
  const meshOverlaySource = useMemo(
    () =>
      resolveSliceMeshOverlaySource({
        backend: backendSliceMeshOverlay,
        local: apiSliceMeshOverlay,
        loading: backendSliceMeshOverlayLoading,
        error: backendSliceMeshOverlayError,
        enabled: effectiveMeshOverlayEnabled,
      }),
    [
      apiSliceMeshOverlay,
      backendSliceMeshOverlay,
      backendSliceMeshOverlayError,
      backendSliceMeshOverlayLoading,
      effectiveMeshOverlayEnabled,
    ],
  );

  const sliceDebugPanel = useMemo(() => {
    if (!slice2DModel) {
      return null;
    }
    return (
      <Slice2DDebugPanel
        quantityId={quantityId ?? sliceMeta?.quantity_id ?? null}
        query={slice2DModel.render.query}
        toolbar={slice2DModel.toolbar}
        sliceMeta={sliceMeta}
        sliceArrows={sliceArrows}
        sliceScalarValues={sliceScalarValues}
        sliceScalarShape={sliceScalarShape}
        sliceLoading={sliceLoading}
        sliceErrorMessage={sliceErrorMessage}
        usesSliceApi={shouldUseSliceApi2D}
        renderingMode={
          preferFemMesh && femMeshData
            ? "fem-mesh-local"
            : shouldUseSliceApi2D
              ? "api-raster"
              : "fdm-grid"
        }
      />
    );
  }, [
    femMeshData,
    preferFemMesh,
    shouldUseSliceApi2D,
    slice2DModel,
    sliceArrows,
    sliceErrorMessage,
    sliceLoading,
    sliceMeta,
    sliceScalarShape,
    sliceScalarValues,
  ]);

  const wrap = (content: ReactNode) =>
    slice2DModel ? (
      <Slice2DShell
        model={slice2DModel}
        selection={workspaceSelection}
        debugPanel={sliceDebugPanel}
      >
        <div className="relative h-full w-full">
          {content}
          {sliceStateKind === "unsupported" && sliceErrorMessage ? (
            <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-100 shadow-sm backdrop-blur-sm">
              {sliceErrorMessage}
            </div>
          ) : null}
          {sliceStateKind === "error" && sliceHasStaleData && sliceErrorMessage ? (
            <div className="pointer-events-none absolute left-3 top-3 rounded-md border border-rose-400/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-100 shadow-sm backdrop-blur-sm">
              stale 2D slice: {sliceErrorMessage}
            </div>
          ) : null}
          {effectiveMeshOverlayEnabled ? (
            <Slice2DOverlayStatusChip state={meshOverlaySource} />
          ) : null}
        </div>
      </Slice2DShell>
    ) : content;

  if (shouldUseSliceApi2D) {
    if (sliceLoading && !hasSliceScalar) {
      return wrap(
        <div className="flex h-full w-full items-center justify-center opacity-80">
          <EmptyState
            title="Loading 2D quantity slice"
            description="Fetching scalar slice data from /data/fields resources."
            tone="info"
          />
        </div>,
      );
    }
    if (sliceErrorMessage && !hasSliceScalar) {
      return wrap(
        <div className="flex h-full w-full items-center justify-center opacity-80">
          <EmptyState
            title="Slice request failed"
            description={sliceErrorMessage}
            tone="warning"
          />
        </div>,
      );
    }
    return wrap(
      <MagnetizationSlice2D
        grid={grid}
        vectors={null}
        scalarValues={sliceScalarValues}
        scalarShape={sliceScalarShape}
        meta={sliceMeta}
        arrows={sliceArrows}
        meshOverlay={meshOverlaySource.overlay}
        quantityLabel={quantityLabel}
        quantityId={quantityId}
        quantityUnit={quantityUnit}
        quantityComponentCount={quantityComponentCount}
        showQuantity={effectiveShowQuantity}
        showVectors={effectiveShowArrows}
        arrowEvery={toolbar?.vectorDensity ?? null}
        vectorColorMode={vectorColorMode}
        vectorMonoColor={vectorMonoColor}
        component={component}
        plane={plane}
        sliceIndex={sliceIndex}
      />,
    );
  }

  if (preferFemMesh && femMeshData) {
    return wrap(
      <FemMeshSlice2D
        meshData={femMeshData}
        quantityLabel={femQuantityLabel}
        quantityId={femQuantityId}
        quantityUnit={femQuantityUnit}
        quantityComponentCount={quantityComponentCount}
        quantityOptions={femQuantityOptions}
        component={femComponent}
        plane={plane}
        meshParts={meshParts}
        meshEntityViewState={effectiveMeshEntityViewState}
        meshRenderMode={toolbar?.renderMode === "mesh-overlay" ? "surface+edges" : meshRenderMode ?? "surface"}
        showPrimitives={effectiveShowPrimitives}
        showMesh={effectiveShowMesh}
        showQuantity={effectiveShowQuantity}
        airSegmentVisible={effectiveAirboxVisible}
        objectViewMode={objectViewMode}
        visibleObjectIds={visibleObjectIds}
        vectorDomainFilter={effectiveVectorDomainFilter}
        clipAxis={effectiveClipAxis}
        clipPos={effectiveClipPos}
        antennaOverlays={antennaOverlays}
        selectedAntennaId={selectedAntennaId}
        showArrows={effectiveShowArrows}
        vectorDensity={toolbar?.vectorDensity ?? null}
        vectorColorMode={vectorColorMode}
        vectorMonoColor={vectorMonoColor}
        previewMaxPoints={previewMaxPoints}
        sliceMode={toolbar?.mode ?? "single"}
        projectionReduction={toolbar?.projectionReduction}
        projectionIncludeAirAsZero={toolbar?.projectionIncludeAirAsZero}
        projectionSamples={toolbar?.projectionSamples}
        projectionResolution={toolbar?.projectionResolution}
        onQuantityChange={onQuantityChange}
        onComponentChange={onComponentChange}
        onPlaneChange={onPlaneChange}
        onClipAxisChange={onClipAxisChange}
        onClipPosChange={onClipPosChange}
        onShowArrowsChange={onShowArrowsChange}
        onPreviewMaxPointsChange={onPreviewMaxPointsChange}
      />,
    );
  }

  return wrap(
    <MagnetizationSlice2D
      grid={grid}
      vectors={vectors}
      scalarValues={sliceScalarValues}
      scalarShape={sliceScalarShape}
      meta={sliceMeta}
      arrows={null}
      quantityLabel={quantityLabel}
      quantityId={quantityId}
      quantityUnit={quantityUnit}
      quantityComponentCount={quantityComponentCount}
      showQuantity={effectiveShowQuantity}
      showVectors={false}
      arrowEvery={null}
      vectorColorMode={vectorColorMode}
      vectorMonoColor={vectorMonoColor}
      component={component}
      plane={plane}
      sliceIndex={sliceIndex}
    />,
  );
}

function Slice2DOverlayStatusChip({
  state,
}: {
  state: SliceMeshOverlaySourceState;
}) {
  const tone =
    state.status === "ready"
      ? "border-emerald-400/35 bg-emerald-500/10 text-emerald-100"
      : state.status === "loading"
        ? "border-sky-400/35 bg-sky-500/10 text-sky-100"
        : state.status === "error"
          ? "border-rose-400/40 bg-rose-500/10 text-rose-100"
          : "border-slate-400/25 bg-slate-500/10 text-slate-200";
  return (
    <div className={`pointer-events-none absolute right-3 top-3 rounded-md border px-2.5 py-1 text-[11px] shadow-sm backdrop-blur-sm ${tone}`}>
      {state.message ?? `mesh: ${state.source}`}
    </div>
  );
}

function resolveBackendSliceMeshOverlayQuery(
  meta: FieldSliceMeta,
): DomainSliceMeshOverlayQuery | null {
  if (Number.isFinite(meta.cut_world)) {
    return {
      plane: meta.plane,
      cut_world: meta.cut_world ?? undefined,
    };
  }
  if (Number.isFinite(meta.cut_norm)) {
    return {
      plane: meta.plane,
      cut_norm: meta.cut_norm,
    };
  }
  return null;
}

function canUseBackendSliceMeshOverlay({
  meshParts,
  meshEntityViewState,
  airSegmentVisible,
  objectViewMode,
  visibleObjectIds,
}: {
  meshParts: readonly FemMeshPart[];
  meshEntityViewState: MeshEntityViewStateMap;
  airSegmentVisible: boolean;
  objectViewMode: ObjectViewMode;
  visibleObjectIds: readonly string[];
}): boolean {
  if (objectViewMode !== "context" || !airSegmentVisible) {
    return false;
  }

  const expectedVisibleObjectIds = meshParts
    .filter((part) => part.role === "magnetic_object" && typeof part.object_id === "string")
    .map((part) => part.object_id as string);
  if (
    expectedVisibleObjectIds.length > 0 &&
    expectedVisibleObjectIds.some((objectId) => !visibleObjectIds.includes(objectId))
  ) {
    return false;
  }

  return meshParts.every((part) => {
    if (part.role === "outer_boundary") {
      return true;
    }
    return meshEntityViewState[part.id]?.visible !== false;
  });
}

function Slice2DDebugPanel({
  quantityId,
  query,
  toolbar,
  sliceMeta,
  sliceArrows,
  sliceScalarValues,
  sliceScalarShape,
  sliceLoading,
  sliceErrorMessage,
  usesSliceApi,
  renderingMode,
}: {
  quantityId: string | null;
  query: FieldSliceQuery | FieldProjectionQuery | null;
  toolbar: Slice2DModel["toolbar"];
  sliceMeta: FieldSliceMeta | FieldProjectionMeta | null;
  sliceArrows: SliceArrowData | null;
  sliceScalarValues: Float64Array | null;
  sliceScalarShape: [number, number] | null;
  sliceLoading: boolean;
  sliceErrorMessage: string | null;
  usesSliceApi: boolean;
  renderingMode: "fem-mesh-local" | "api-raster" | "fdm-grid";
}) {
  const requestSummary = useMemo(
    () => buildSliceRequestSummary(quantityId, query),
    [quantityId, query],
  );
  const scalarSummary = useMemo(
    () => buildScalarDebugSummary(sliceScalarValues, sliceScalarShape),
    [sliceScalarShape, sliceScalarValues],
  );
  const metaJson = useMemo(
    () => (sliceMeta ? JSON.stringify(sliceMeta, null, 2) : "null"),
    [sliceMeta],
  );

  return (
    <section className="rounded border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-foreground">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium text-amber-300">2D Slice API Debug</span>
        <span className="text-muted-foreground">renderer: {renderingMode}</span>
        <span className="text-muted-foreground">
          api slice path active: {usesSliceApi ? "yes" : "no"}
        </span>
        <span className="text-muted-foreground">loading: {sliceLoading ? "yes" : "no"}</span>
        {sliceErrorMessage ? (
          <span className="text-red-300">error: {sliceErrorMessage}</span>
        ) : null}
      </div>
      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        <DebugBlock
          title="Request"
          lines={[
            ["quantity_id", quantityId ?? "none"],
            ["resource", queryResourceKind(query)],
            ["query", requestSummary.queryJson],
            ["meta GET", requestSummary.metaUrl],
            ["scalar GET", requestSummary.scalarUrl],
            ["arrows GET", requestSummary.arrowsUrl ?? "not requested"],
          ]}
        />
        <DebugBlock
          title="Frontend Render Inputs"
          lines={[
            ["renderer", renderingMode],
            ["toolbar axis", toolbar.axis],
            ["toolbar component", toolbar.component],
            ["position %", formatNumber(toolbar.positionPercent)],
            ["position world", formatNumber(toolbar.positionWorld)],
            [
              "normal bounds",
              toolbar.normalAxisBounds
                ? `${formatNumber(toolbar.normalAxisBounds.min)} .. ${formatNumber(toolbar.normalAxisBounds.max)}`
                : "none",
            ],
            [
              "magnetic extent",
              toolbar.magneticExtent
                ? `${formatNumber(toolbar.magneticExtent.min)} .. ${formatNumber(toolbar.magneticExtent.max)}`
                : "none",
            ],
            ["query plane", query?.plane ?? "none"],
          ]}
        />
        <DebugBlock
          title="Meta Response"
          lines={[
            ["plane", sliceMeta?.plane ?? "none"],
            ["component", sliceMeta?.component ?? "none"],
            [
              "cut",
              isSliceMeta(sliceMeta)
                ? `${sliceMeta.cut_kind} norm=${formatNumber(sliceMeta.cut_norm)} world=${formatNumber(sliceMeta.cut_world)}`
                : isProjectionMeta(sliceMeta)
                  ? `${sliceMeta.reduction}, samples=${sliceMeta.samples}`
                  : "none",
            ],
            ["pixels", sliceMeta ? `${sliceMeta.x_pixels} x ${sliceMeta.y_pixels}` : "none"],
            [
              "grid",
              sliceMeta
                ? `${sliceMeta.grid.x_size} x ${sliceMeta.grid.y_size}, points=${sliceMeta.grid.point_count}`
                : "none",
            ],
            ["sampling", sliceMeta?.sampling_method ?? "none"],
            [
              "revisions",
              sliceMeta
                ? `field=${sliceMeta.field_revision}, domain=${sliceMeta.domain_generation_id}, ${isProjectionMeta(sliceMeta) ? `projection=${sliceMeta.projection_revision}` : `slice=${sliceMeta.slice_revision}`}`
                : "none",
            ],
            [
              "scalar desc",
              sliceMeta
                ? `available=${String(sliceMeta.scalar.available)}, n_comp=${sliceMeta.scalar.n_comp}, points=${sliceMeta.scalar.point_count}, min=${formatNumber(sliceMeta.scalar.min)}, max=${formatNumber(sliceMeta.scalar.max)}`
                : "none",
            ],
            [
              "arrow desc",
              isSliceMeta(sliceMeta)
                ? `available=${String(sliceMeta.arrows.available)}, n_comp=${sliceMeta.arrows.n_comp}, points=${sliceMeta.arrows.point_count}`
                : "none",
            ],
            ["raw json", metaJson],
          ]}
        />
        <DebugBlock
          title="Scalar Payload"
          lines={[
            ["shape", scalarSummary.shape],
            ["values", scalarSummary.length],
            ["finite", scalarSummary.finiteCount],
            ["non-zero", scalarSummary.nonZeroCount],
            ["min/max", `${scalarSummary.min} / ${scalarSummary.max}`],
            ["abs max", scalarSummary.absMax],
            ["bytes", scalarSummary.bytes],
            ["sample", scalarSummary.sample],
          ]}
        />
        <DebugBlock
          title="Arrow Payload"
          lines={[
            ["arrow count", sliceArrows ? String(sliceArrows.arrowCount) : "0"],
            ["components", isSliceMeta(sliceMeta) ? String(sliceMeta.arrows.n_comp) : "none"],
            ["values", sliceArrows ? String(sliceArrows.values.length) : "0"],
            ["bytes", sliceArrows ? String(sliceArrows.values.byteLength) : "0"],
            ["etag", sliceArrows?.etag ?? "none"],
          ]}
        />
      </div>
    </section>
  );
}

function DebugBlock({
  title,
  lines,
}: {
  title: string;
  lines: ReadonlyArray<readonly [string, string]>;
}) {
  return (
    <div className="rounded border border-border/40 bg-background/50 p-2">
      <div className="mb-1 font-medium text-foreground">{title}</div>
      <div className="space-y-1">
        {lines.map(([label, value]) => (
          <div key={label} className="grid grid-cols-[90px_minmax(0,1fr)] gap-2">
            <span className="text-muted-foreground">{label}</span>
            <code className="break-all whitespace-pre-wrap text-[11px] text-foreground/90">
              {value}
            </code>
          </div>
        ))}
      </div>
    </div>
  );
}

function buildSliceRequestSummary(
  quantityId: string | null,
  query: FieldSliceQuery | FieldProjectionQuery | null,
) {
  const baseUrl = resolveApiBase();
  if (!quantityId || !query) {
    return {
      queryJson: query ? JSON.stringify(query) : "null",
      metaUrl: "no slice request",
      scalarUrl: "no slice request",
      arrowsUrl: null as string | null,
    };
  }
  const isProjection = isProjectionQuery(query);
  const params = isProjection ? buildProjectionParams(query) : buildSliceParams(query);
  const paramsString = params.toString();
  const metaPath = isProjection
    ? `${sessionApiPaths.data.fieldProjectionMeta(quantityId)}?${paramsString}`
    : `${sessionApiPaths.data.fieldSliceMeta(quantityId)}?${paramsString}`;
  const scalarPath = isProjection
    ? `${sessionApiPaths.data.fieldProjectionScalar(quantityId)}?${paramsString}`
    : `${sessionApiPaths.data.fieldSliceScalar(quantityId)}?${paramsString}`;
  const arrowsPath = !isProjection && query.include_arrows
    ? `${sessionApiPaths.data.fieldSliceArrows(quantityId)}?${buildSliceParams(query, { arrows: true }).toString()}`
    : null;
  return {
    queryJson: JSON.stringify(query),
    metaUrl: `GET ${baseUrl}${metaPath}`,
    scalarUrl: `GET ${baseUrl}${scalarPath}`,
    arrowsUrl: arrowsPath
      ? `GET ${baseUrl}${arrowsPath}`
      : null,
  };
}

function isProjectionQuery(
  query: FieldSliceQuery | FieldProjectionQuery | null,
): query is FieldProjectionQuery {
  return Boolean(query && ("reduction" in query || "include_air_as_zero" in query));
}

function queryResourceKind(query: FieldSliceQuery | FieldProjectionQuery | null): string {
  if (!query) return "none";
  return isProjectionQuery(query) ? "projection" : "slice";
}

function isSliceMeta(
  meta: FieldSliceMeta | FieldProjectionMeta | null,
): meta is FieldSliceMeta {
  return Boolean(meta && "slice_revision" in meta);
}

function isProjectionMeta(
  meta: FieldSliceMeta | FieldProjectionMeta | null,
): meta is FieldProjectionMeta {
  return Boolean(meta && "projection_revision" in meta);
}

function buildSliceParams(
  q: FieldSliceQuery,
  extra?: { arrows?: boolean },
): URLSearchParams {
  const p = new URLSearchParams({ plane: q.plane });
  if (q.component && q.component !== "full") p.set("component", q.component);
  if (q.cut_world !== undefined) p.set("cut_world", String(q.cut_world));
  if (q.cut_norm !== undefined) p.set("cut_norm", String(q.cut_norm));
  if (q.x_size !== undefined) p.set("x_size", String(q.x_size));
  if (q.y_size !== undefined) p.set("y_size", String(q.y_size));
  if (q.max_points !== undefined) p.set("max_points", String(q.max_points));
  if (extra?.arrows || q.include_arrows) p.set("include_arrows", "true");
  if (q.arrow_every !== undefined) p.set("arrow_every", String(q.arrow_every));
  if (q.max_arrows !== undefined) p.set("max_arrows", String(q.max_arrows));
  return p;
}

function buildProjectionParams(q: FieldProjectionQuery): URLSearchParams {
  const p = new URLSearchParams({ plane: q.plane });
  if (q.component && q.component !== "full") p.set("component", q.component);
  if (q.reduction !== undefined) p.set("reduction", q.reduction);
  if (q.include_air_as_zero !== undefined) {
    p.set("include_air_as_zero", String(q.include_air_as_zero));
  }
  if (q.samples !== undefined) p.set("samples", String(q.samples));
  if (q.adaptive !== undefined) p.set("adaptive", String(q.adaptive));
  if (q.error_tolerance !== undefined) p.set("error_tolerance", String(q.error_tolerance));
  if (q.min_samples !== undefined) p.set("min_samples", String(q.min_samples));
  if (q.x_size !== undefined) p.set("x_size", String(q.x_size));
  if (q.y_size !== undefined) p.set("y_size", String(q.y_size));
  if (q.max_points !== undefined) p.set("max_points", String(q.max_points));
  return p;
}

function buildScalarDebugSummary(
  values: Float64Array | null,
  shape: [number, number] | null,
) {
  if (!values) {
    return {
      shape: shape ? `${shape[0]} x ${shape[1]}` : "none",
      length: "0",
      finiteCount: "0",
      nonZeroCount: "0",
      min: "none",
      max: "none",
      absMax: "none",
      bytes: "0",
      sample: "[]",
    };
  }

  let finiteCount = 0;
  let nonZeroCount = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let absMax = 0;
  const sample: number[] = [];
  const sampleCount = Math.min(values.length, 8);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (index < sampleCount) {
      sample.push(value);
    }
    if (!Number.isFinite(value)) {
      continue;
    }
    finiteCount += 1;
    if (value !== 0) {
      nonZeroCount += 1;
    }
    if (value < min) min = value;
    if (value > max) max = value;
    const abs = Math.abs(value);
    if (abs > absMax) absMax = abs;
  }

  return {
    shape: shape ? `${shape[0]} x ${shape[1]}` : "unknown",
    length: String(values.length),
    finiteCount: String(finiteCount),
    nonZeroCount: String(nonZeroCount),
    min: finiteCount > 0 ? formatNumber(min) : "none",
    max: finiteCount > 0 ? formatNumber(max) : "none",
    absMax: finiteCount > 0 ? formatNumber(absMax) : "none",
    bytes: String(values.byteLength),
    sample: `[${sample.map((value) => formatNumber(value)).join(", ")}]`,
  };
}

function formatNumber(value: number | null | undefined): string {
  if (value == null) return "none";
  if (!Number.isFinite(value)) return String(value);
  return value.toExponential(6);
}
