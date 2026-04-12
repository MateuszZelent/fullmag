"use client";

/**
 * Professional FEM 2D slice viewport.
 *
 * This component owns the `FemSliceQuery` model and orchestrates:
 *
 *   Query (toolbar) → Engine (femSliceExact) → Renderer (Plotly) → Probe
 *
 * It wraps the existing `FemMeshSlice2DPlotly` renderer but drives it
 * through the canonical `FemSliceQuery` model instead of ad-hoc props.
 *
 * The old prop interface is still supported via the `legacy` prop group
 * so that `ViewportPanels.tsx` can switch incrementally.
 */

import { useMemo, useState } from "react";
import type { FemMeshData, FemVectorDomainFilter } from "./fem/femMeshTypes";
import type { FemMeshPart, MeshEntityViewStateMap } from "../../lib/session/types";
import type { ObjectViewMode, AntennaOverlay } from "../runs/control-room/shared";
import type { FemSliceQuery, VectorComponent, SlicePlane } from "./fem/femSliceQuery";
import {
  useFemSliceViewportModel,
  type FemSliceViewportModel,
} from "./fem/useFemSliceViewportModel";
import { computeExactSlice, type SliceResult } from "./fem/femSliceExact";
import { resolveColorScale, type ResolvedColorScale } from "./fem/femSliceColorScale";
import { buildSliceVisibilityState, type SliceVisibilityState } from "./fem/femSliceUtils";
import { FemSliceToolbar, FemSliceTitleBar } from "./fem/FemSliceToolbar";
import { ViewportOverlayLayout } from "./ViewportOverlayLayout";

// ── Props ────────────────────────────────────────────────────────

export interface FemSlice2DViewportProps {
  meshData: FemMeshData;
  quantityLabel: string;
  quantityId?: string;
  quantityUnit?: string;
  quantityOptions?: Array<{
    id: string;
    shortLabel: string;
    label?: string;
    available: boolean;
  }>;

  // ── Mesh visibility ──
  meshParts?: FemMeshPart[];
  meshEntityViewState?: MeshEntityViewStateMap;
  airSegmentVisible?: boolean;
  objectViewMode?: ObjectViewMode;
  visibleObjectIds?: string[];
  vectorDomainFilter?: FemVectorDomainFilter;

  // ── Antenna overlays ──
  antennaOverlays?: AntennaOverlay[];
  selectedAntennaId?: string | null;

  // ── Vectors ──
  showArrows?: boolean;
  previewMaxPoints?: number;

  // ── Legacy bridge: initial values derived from old 3D clip state ──
  initialComponent?: VectorComponent;
  initialPlane?: SlicePlane;
  initialClipPos?: number;

  // ── Callbacks ──
  onQuantityChange?: (quantityId: string) => void;
  onComponentChange?: (component: VectorComponent) => void;
  onPlaneChange?: (plane: SlicePlane) => void;
  onClipAxisChange?: (axis: "x" | "y" | "z") => void;
  onClipPosChange?: (value: number) => void;
  onShowArrowsChange?: (value: boolean) => void;
  onPreviewMaxPointsChange?: (value: number) => void;
}

// ── Component ────────────────────────────────────────────────────

export default function FemSlice2DViewport({
  meshData,
  quantityLabel,
  quantityId,
  quantityUnit,
  quantityOptions = [],
  meshParts = [],
  meshEntityViewState = {},
  airSegmentVisible = true,
  objectViewMode = "context",
  visibleObjectIds = [],
  vectorDomainFilter = "auto",
  antennaOverlays = [],
  selectedAntennaId,
  showArrows,
  previewMaxPoints,
  initialComponent = "magnitude",
  initialPlane = "xy",
  initialClipPos = 50,
  onQuantityChange,
  onComponentChange,
  onPlaneChange,
  onClipAxisChange,
  onClipPosChange,
  onShowArrowsChange,
  onPreviewMaxPointsChange,
}: FemSlice2DViewportProps) {
  // ── Model ──────────────────────────────────────────
  const model = useFemSliceViewportModel({
    meshData,
    initialQuery: {
      orientation: initialPlane,
      component: initialComponent,
      planeOffset: initialClipPos,
      quantityId: quantityId ?? "m",
    },
  });

  // ── Visibility ─────────────────────────────────────
  const visibilityState = useMemo<SliceVisibilityState>(
    () =>
      buildSliceVisibilityState({
        meshData,
        meshParts,
        meshEntityViewState,
        airSegmentVisible,
        objectViewMode,
        visibleObjectIds,
        vectorDomainFilter:
          vectorDomainFilter === "auto"
            ? meshData.quantityDomain === "full_domain"
              ? "full_domain"
              : "magnetic_only"
            : vectorDomainFilter,
      }),
    [
      airSegmentVisible,
      meshData,
      meshEntityViewState,
      meshParts,
      objectViewMode,
      vectorDomainFilter,
      visibleObjectIds,
    ],
  );

  // ── Slice computation ──────────────────────────────
  const sliceResult = useMemo<SliceResult>(
    () =>
      computeExactSlice({
        meshData,
        query: model.query,
        resolved: model.resolved,
        visibility: visibilityState,
        boundsStrategy:
          objectViewMode === "isolate" ? "visible-intersection" : "visible-context",
      }),
    [meshData, model.query, model.resolved, visibilityState, objectViewMode],
  );

  // ── Colour scale ───────────────────────────────────
  const colorScale = useMemo<ResolvedColorScale>(
    () =>
      resolveColorScale({
        dataRange: sliceResult.valueRange,
        colorScaleMode: model.query.colorScaleMode,
        lockedRange: model.query.lockedRange,
        quantityId: model.query.quantityId,
        component: model.query.component,
      }),
    [
      sliceResult.valueRange,
      model.query.colorScaleMode,
      model.query.lockedRange,
      model.query.quantityId,
      model.query.component,
    ],
  );

  // ── Compact detection ──────────────────────────────
  const [compact, setCompact] = useState(false);

  return (
    <div className="relative h-full min-h-[360px] w-full overflow-hidden rounded-[8px] bg-[#1e1e2e]">
      {/* Placeholder: the actual renderer will be integrated here.
          For now, render the key diagnostic info so the toolbar works. */}
      <div className="flex items-center justify-center h-full w-full text-muted-foreground font-mono text-sm">
        <div className="text-center space-y-2">
          <p>FEM Slice 2D — new semantic engine active</p>
          <p className="text-xs">
            {sliceResult.polygons.length + sliceResult.segments.length} elements |{" "}
            {sliceResult.normalLabel} = {sliceResult.planeCoord.toExponential(3)} m
          </p>
          <p className="text-xs">
            range [{colorScale.min.toExponential(2)}, {colorScale.max.toExponential(2)}] | mode: {colorScale.mode}
          </p>
        </div>
      </div>

      <ViewportOverlayLayout>
        <ViewportOverlayLayout.TopLeft>
          <FemSliceTitleBar model={model} />
        </ViewportOverlayLayout.TopLeft>

        <ViewportOverlayLayout.BottomCenter>
          <FemSliceToolbar model={model} compact={compact} />
        </ViewportOverlayLayout.BottomCenter>
      </ViewportOverlayLayout>
    </div>
  );
}
