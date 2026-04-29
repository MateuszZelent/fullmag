"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import { Slice2DShell } from "@/src/features/slice2d";
import type { Slice2DModel } from "@/src/features/slice2d";
import type { CrossSurfaceSelectionState } from "@/src/features/workspaceSync";
import type { FemMeshData, FemVectorDomainFilter } from "@/components/preview/FemMeshView3D";
import MagnetizationSlice2D from "@/components/preview/MagnetizationSlice2D";
import EmptyState from "../../ui/EmptyState";
import type { MeshEntityViewStateMap, FemMeshPart } from "../../../lib/session/types";
import type { AntennaOverlay, ObjectViewMode } from "./shared";

type SlicePlane = "xy" | "xz" | "yz";
type VectorComponent = "x" | "y" | "z" | "magnitude";

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

const FemMeshSlice2D = dynamic(() => import("@/components/preview/FemMeshSlice2DPlotly"), {
  ssr: false,
  loading: () => <ViewportModuleLoading label="Loading FEM slice viewport..." />,
});

export interface UnifiedViewport2DPresenterProps {
  slice2DModel?: Slice2DModel | null;
  workspaceSelection?: CrossSurfaceSelectionState | null;
  shouldUseSliceApi2D: boolean;
  hasSliceScalar: boolean;
  sliceLoading: boolean;
  sliceErrorMessage: string | null;
  grid: [number, number, number];
  vectors: Float64Array | null;
  sliceScalarValues: Float64Array | null;
  sliceScalarShape: [number, number] | null;
  quantityLabel: string;
  quantityId?: string;
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
  sliceErrorMessage,
  grid,
  vectors,
  sliceScalarValues,
  sliceScalarShape,
  quantityLabel,
  quantityId,
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
  const effectiveShowArrows = toolbar?.showVectors ?? showArrows;
  const effectiveAirboxVisible = toolbar?.showAirbox ?? airSegmentVisible;

  const wrap = (content: ReactNode) =>
    slice2DModel ? (
      <Slice2DShell model={slice2DModel} selection={workspaceSelection}>
        {content}
      </Slice2DShell>
    ) : content;

  if (preferFemMesh && femMeshData) {
    return wrap(
      <FemMeshSlice2D
        meshData={femMeshData}
        quantityLabel={femQuantityLabel}
        quantityId={femQuantityId}
        quantityUnit={femQuantityUnit}
        quantityOptions={femQuantityOptions}
        component={femComponent}
        plane={plane}
        meshParts={meshParts}
        meshEntityViewState={meshEntityViewState}
        meshRenderMode={toolbar?.renderMode === "mesh-overlay" ? "surface+edges" : meshRenderMode ?? "surface"}
        showPrimitives={effectiveShowPrimitives}
        showMesh={effectiveShowMesh}
        showQuantity={effectiveShowQuantity}
        airSegmentVisible={effectiveAirboxVisible}
        objectViewMode={objectViewMode}
        visibleObjectIds={visibleObjectIds}
        vectorDomainFilter={vectorDomainFilter}
        clipAxis={clipAxis}
        clipPos={clipPos}
        antennaOverlays={antennaOverlays}
        selectedAntennaId={selectedAntennaId}
        showArrows={effectiveShowArrows}
        previewMaxPoints={previewMaxPoints}
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

  if (shouldUseSliceApi2D) {
    if (sliceLoading && !hasSliceScalar) {
      return wrap(
        <div className="flex h-full w-full items-center justify-center opacity-80">
          <EmptyState
            title="Loading 2D quantity slice"
            description="Fetching scalar slice data from /slice resources."
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
        quantityLabel={quantityLabel}
        quantityId={quantityId}
        component={component}
        plane={plane}
        sliceIndex={sliceIndex}
      />,
    );
  }

  return wrap(
    <MagnetizationSlice2D
      grid={grid}
      vectors={vectors}
      scalarValues={sliceScalarValues}
      scalarShape={sliceScalarShape}
      quantityLabel={quantityLabel}
      quantityId={quantityId}
      component={component}
      plane={plane}
      sliceIndex={sliceIndex}
    />,
  );
}
