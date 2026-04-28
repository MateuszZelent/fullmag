"use client";

import { useEffect, useMemo, useState } from "react";
import type { PlotHoverEvent, PlotMouseEvent } from "plotly.js";
import type { FemMeshData, FemVectorDomainFilter, RenderMode } from "./FemMeshView3D";
import type { AntennaOverlay } from "../runs/control-room/shared";
import Plot from "../plots/DynamicPlot";
import { ViewportOverlayLayout } from "./ViewportOverlayLayout";
import { defaultMeshEntityViewState, type FemMeshPart, type MeshEntityViewStateMap } from "../../lib/session/types";
import type { ObjectViewMode } from "../runs/control-room/shared";
import {
  buildSliceVisibilityState,
  clipAxisToPlane,
  normalizedClipToWorld,
} from "./fem/femSliceUtils";
import {
  axisIndices,
  type Point2,
  type SlicePlane,
  type VectorComponent,
} from "./fem/femSliceGeometry";
import {
  maxPointsToGlyphBudget,
  PREVIEW_MAX_POINTS_DEFAULT,
} from "./fem/vectorDensityBudget";
import { POSITIVE_PALETTE } from "../../lib/colorPalettes";
import {
  paletteForMode,
  smartAutoScale,
  type ResolvedColorScale,
} from "./fem/femSliceColorScale";
import type { FemSliceQuery } from "./fem/femSliceQuery";
import { useFemSliceSampling } from "./fem/useFemSliceSampling";

interface Props {
  meshData: FemMeshData;
  meshRenderMode?: RenderMode;
  showPrimitives?: boolean;
  showMesh?: boolean;
  showQuantity?: boolean;
  quantityLabel: string;
  quantityId?: string;
  quantityUnit?: string;
  quantityOptions?: Array<{
    id: string;
    shortLabel: string;
    label?: string;
    available: boolean;
  }>;
  component: VectorComponent;
  plane: SlicePlane;
  meshParts?: FemMeshPart[];
  meshEntityViewState?: MeshEntityViewStateMap;
  airSegmentVisible?: boolean;
  objectViewMode?: ObjectViewMode;
  visibleObjectIds?: string[];
  vectorDomainFilter?: FemVectorDomainFilter;
  clipAxis?: "x" | "y" | "z";
  clipPos?: number;
  antennaOverlays?: AntennaOverlay[];
  selectedAntennaId?: string | null;
  showArrows?: boolean;
  previewMaxPoints?: number;
  onQuantityChange?: (quantityId: string) => void;
  onComponentChange?: (component: VectorComponent) => void;
  onPlaneChange?: (plane: SlicePlane) => void;
  onClipAxisChange?: (axis: "x" | "y" | "z") => void;
  onClipPosChange?: (value: number) => void;
  onShowArrowsChange?: (value: boolean) => void;
  onPreviewMaxPointsChange?: (value: number) => void;
}

interface SliceProbe {
  worldPoint: [number, number, number];
  u: number;
  v: number;
  value: number | null;
  worldVector: [number, number, number] | null;
  inPlaneMagnitude: number | null;
  source: "volume" | "boundary" | "vector" | null;
}

interface AntennaRect2D {
  id: string;
  role: AntennaOverlay["conductors"][number]["role"];
  bounds: { uMin: number; uMax: number; vMin: number; vMax: number };
  selected: boolean;
}

const BG = "#1e1e2e";
const BORDER = "#313244";
const TEXT = "#a6adc8";
const TEXT_STRONG = "#cdd6f4";
const GRID = "rgba(108, 112, 134, 0.08)";
const POSITIVE = [...POSITIVE_PALETTE];
const COOLWARM = [
  "#3b4cc0",
  "#6f92f3",
  "#aac7fd",
  "#dddcdc",
  "#f7b89c",
  "#e7745b",
  "#b40426",
] as const;
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function paletteColor(t: number, palette: string[]): string {
  const n = palette.length - 1;
  const scaled = clamp(t, 0, 1) * n;
  const index = Math.min(Math.floor(scaled), n - 1);
  const frac = scaled - index;
  const a = palette[index];
  const b = palette[index + 1];
  if (frac <= 1e-6) {
    return a;
  }
  const parse = (hex: string) => [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const mix = (x: number, y: number) => Math.round(lerp(x, y, frac));
  return `rgb(${mix(ar, br)}, ${mix(ag, bg)}, ${mix(ab, bb)})`;
}

function colorForValue(
  value: number,
  scale: ResolvedColorScale,
  palette: string[],
): string {
  if (scale.min === 0 && scale.max === 1 && palette === POSITIVE) {
    return paletteColor(value, POSITIVE);
  }
  const t = scale.max > scale.min ? (value - scale.min) / (scale.max - scale.min) : 0.5;
  return paletteColor(t, palette);
}

function colorForDomain(partId: string | null): string {
  if (!partId) return "rgba(108, 112, 134, 0.18)";
  let hash = 0;
  for (let i = 0; i < partId.length; i += 1) {
    hash = (hash * 31 + partId.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  return `hsla(${hue} 55% 62% / 0.34)`;
}

function edgeColorForPart(part: FemMeshPart | null | undefined): string {
  if (part?.role === "air" || part?.role === "outer_boundary") {
    return "rgba(137, 220, 235, 0.82)";
  }
  if (part?.role === "interface") {
    return "rgba(250, 179, 135, 0.86)";
  }
  return "rgba(205, 214, 244, 0.78)";
}

function edgeDashForPart(part: FemMeshPart | null | undefined): Plotly.Dash {
  return part?.role === "air" || part?.role === "outer_boundary" ? "dot" : "solid";
}

function isAirboxPart(part: FemMeshPart | null | undefined): boolean {
  return part?.role === "air" || part?.role === "outer_boundary";
}

function resolvedVectorDomainFilter(
  vectorDomainFilter: FemVectorDomainFilter,
  quantityDomain: FemMeshData["quantityDomain"],
): "magnetic_only" | "full_domain" | "airbox_only" {
  if (vectorDomainFilter === "airbox_only") return "airbox_only";
  if (vectorDomainFilter === "full_domain") return "full_domain";
  if (vectorDomainFilter === "magnetic_only") return "magnetic_only";
  return quantityDomain === "full_domain" ? "full_domain" : "magnetic_only";
}

function shouldShowVectorArrow(
  part: FemMeshPart | null | undefined,
  domain: "magnetic_only" | "full_domain" | "airbox_only",
): boolean {
  if (domain === "full_domain") return true;
  if (domain === "airbox_only") return isAirboxPart(part);
  return part?.role === "magnetic_object" || part == null;
}

function formatProbeValue(value: number | null): string {
  if (value == null || !Number.isFinite(value)) {
    return "n/a";
  }
  const abs = Math.abs(value);
  if (abs >= 1e3 || (abs > 0 && abs < 1e-3)) {
    return value.toExponential(2);
  }
  return value.toFixed(4);
}

function worldSymbolBase(quantityId: string | undefined, quantityLabel: string): string {
  if (!quantityId || quantityId === "m") return "m";
  if (/^H[_A-Za-z0-9]*$/i.test(quantityId)) return "H";
  if (/field/i.test(quantityLabel)) return "H";
  if (/^B[_A-Za-z0-9]*$/i.test(quantityId)) return "B";
  return "v";
}

function worldComponentSymbol(
  quantityId: string | undefined,
  quantityLabel: string,
  component: VectorComponent,
): string {
  if (component === "magnitude") {
    return `|${worldSymbolBase(quantityId, quantityLabel)}|`;
  }
  return `${worldSymbolBase(quantityId, quantityLabel)}_${component}`;
}

function quantityHeading(
  quantityId: string | undefined,
  quantityLabel: string,
  component: VectorComponent,
): string {
  return `${quantityLabel} · ${worldComponentSymbol(quantityId, quantityLabel, component)}`;
}

function axisValue(
  plane: SlicePlane,
  planeCoord: number,
  axis: "x" | "y" | "z",
  uValue: number,
  vValue: number,
): number {
  switch (plane) {
    case "xy":
      if (axis === "x") return uValue;
      if (axis === "y") return vValue;
      return planeCoord;
    case "xz":
      if (axis === "x") return uValue;
      if (axis === "y") return planeCoord;
      return vValue;
    case "yz":
      if (axis === "x") return planeCoord;
      if (axis === "y") return uValue;
      return vValue;
  }
}

function buildProbeFromPoint(
  point: PlotMouseEvent["points"][number] | PlotHoverEvent["points"][number],
  plane: SlicePlane,
  planeCoord: number,
): SliceProbe {
  const pointData = point as typeof point & { fullData?: { hovertemplate?: string } };
  const source =
    pointData.fullData?.hovertemplate?.includes("<extra>vector</extra>")
      ? "vector"
      : pointData.fullData?.hovertemplate?.includes("<extra>volume</extra>")
        ? "volume"
        : "boundary";
  const u = Number(point.x);
  const v = Number(point.y);
  const custom = Array.isArray(point.customdata) ? point.customdata : [];
  const value = typeof custom[6] === "number" ? custom[6] : null;
  const worldVector =
    typeof custom[3] === "number" &&
    typeof custom[4] === "number" &&
    typeof custom[5] === "number"
      ? [custom[3], custom[4], custom[5]] as [number, number, number]
      : null;
  const inPlaneMagnitude = typeof custom[7] === "number" ? custom[7] : null;
  return {
    worldPoint: [
      axisValue(plane, planeCoord, "x", u, v),
      axisValue(plane, planeCoord, "y", u, v),
      axisValue(plane, planeCoord, "z", u, v),
    ],
    u,
    v,
    value,
    worldVector,
    inPlaneMagnitude,
    source,
  };
}

function collectAntennaRects(
  overlays: AntennaOverlay[],
  plane: SlicePlane,
  planeCoord: number,
  selectedAntennaId?: string | null,
): AntennaRect2D[] {
  const { normal, u, v } = axisIndices(plane);
  const epsilon = 1e-15;
  const rects: AntennaRect2D[] = [];
  for (const overlay of overlays) {
    const selected = selectedAntennaId === overlay.id;
    for (const conductor of overlay.conductors) {
      if (
        planeCoord < conductor.boundsMin[normal] - epsilon ||
        planeCoord > conductor.boundsMax[normal] + epsilon
      ) {
        continue;
      }
      rects.push({
        id: conductor.id,
        role: conductor.role,
        selected,
        bounds: {
          uMin: conductor.boundsMin[u],
          uMax: conductor.boundsMax[u],
          vMin: conductor.boundsMin[v],
          vMax: conductor.boundsMax[v],
        },
      });
    }
  }
  return rects;
}

function sampleArrows(
  arrows: Array<{
    origin: Point2;
    vector: Point2;
    magnitude: number;
    worldPoint: [number, number, number];
    worldVector: [number, number, number];
  }>,
  target: number,
) {
  if (target <= 0 || arrows.length <= target) {
    return arrows;
  }
  const sorted = [...arrows].sort(
    (left, right) =>
      left.origin[0] - right.origin[0] ||
      left.origin[1] - right.origin[1] ||
      right.magnitude - left.magnitude,
  );
  const sampled: typeof arrows = [];
  const step = sorted.length / target;
  for (let index = 0; index < target; index += 1) {
    sampled.push(sorted[Math.floor(index * step)]);
  }
  return sampled;
}

export default function FemMeshSlice2DPlotly({
  meshData,
  meshRenderMode = "surface",
  showPrimitives = true,
  showMesh = false,
  showQuantity = true,
  quantityLabel,
  quantityId,
  quantityUnit,
  component,
  plane,
  meshParts = [],
  meshEntityViewState = {},
  airSegmentVisible = true,
  objectViewMode = "context",
  visibleObjectIds = [],
  vectorDomainFilter = "auto",
  clipAxis,
  clipPos = 50,
  antennaOverlays = [],
  selectedAntennaId,
  showArrows,
  previewMaxPoints = PREVIEW_MAX_POINTS_DEFAULT,
  onComponentChange,
}: Props) {
  const [hoverProbe, setHoverProbe] = useState<SliceProbe | null>(null);
  const [pinnedProbe, setPinnedProbe] = useState<SliceProbe | null>(null);

  const arrowsVisible = Boolean(showArrows);
  const effectivePreviewMaxPoints = previewMaxPoints;
  const arrowBudget = maxPointsToGlyphBudget(effectivePreviewMaxPoints);
  const vectorDomain = resolvedVectorDomainFilter(vectorDomainFilter, meshData.quantityDomain);
  const fieldNComp = meshData.fieldNComp ?? 3;
  const hasField = Boolean(meshData.fieldData);
  const hasVectorField = hasField && fieldNComp >= 3;
  const isMagnetizationQuantity = !quantityId || quantityId === "m";
  const resolvedMeshRenderMode = meshRenderMode === "wireframe" || meshRenderMode === "surface+edges" || meshRenderMode === "surface" || meshRenderMode === "points"
    ? meshRenderMode
    : "surface";
  const effectiveMeshRenderMode = resolvedMeshRenderMode === "surface" && showMesh
    ? "surface+edges"
    : resolvedMeshRenderMode === "surface+edges" && !showMesh
      ? "surface"
      : resolvedMeshRenderMode;
  const showPolygonFill = (effectiveMeshRenderMode === "surface" || effectiveMeshRenderMode === "surface+edges") && showPrimitives;
  const showSegments = effectiveMeshRenderMode === "surface+edges" || effectiveMeshRenderMode === "wireframe";
  const showPoints = effectiveMeshRenderMode === "points";
  const shouldShowColorbar = hasField && showQuantity && showPolygonFill;
  const componentOptions: VectorComponent[] = fieldNComp >= 3
    ? (isMagnetizationQuantity ? ["x", "y", "z"] : ["magnitude", "x", "y", "z"])
    : ["magnitude"];
  const effectiveComponent: VectorComponent = componentOptions.includes(component)
    ? component
    : componentOptions[0];
  const effectivePlane = clipAxis ? clipAxisToPlane(clipAxis) : plane;
  const { normal } = axisIndices(effectivePlane);

  useEffect(() => {
    if (component !== effectiveComponent) {
      onComponentChange?.(effectiveComponent);
    }
  }, [component, effectiveComponent, onComponentChange]);

  const normalBounds = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < meshData.nNodes; i += 1) {
      const value = meshData.nodes[i * 3 + normal];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return { min: 0, max: 0 };
    }
    return { min, max };
  }, [meshData.nNodes, meshData.nodes, normal]);

  const planeCoord = useMemo(
    () => normalizedClipToWorld(normalBounds.min, normalBounds.max, clipPos),
    [clipPos, normalBounds.max, normalBounds.min],
  );

  const visibilityState = useMemo(
    () =>
      buildSliceVisibilityState({
        meshData,
        meshParts,
        meshEntityViewState,
        airSegmentVisible,
        objectViewMode,
        visibleObjectIds,
        vectorDomainFilter:
          "full_domain",
      }),
    [
      airSegmentVisible,
      meshData,
      meshEntityViewState,
      meshParts,
      objectViewMode,
      visibleObjectIds,
    ],
  );

  const sliceQuery = useMemo<FemSliceQuery>(
    () => ({
      orientation: effectivePlane,
      positionMode: "sync_3d_clip",
      planeOffset: clipPos,
      thicknessMode: "exact",
      thicknessWorld: 0,
      aggregation: "sample",
      quantityId: quantityId ?? "m",
      component: effectiveComponent,
      vectorMode: arrowsVisible ? "in_plane" : "off",
      scope: objectViewMode === "isolate" ? "selection" : "visible",
      extentMode: objectViewMode === "isolate" ? "fit_intersection" : "fit_visible",
      colorScaleMode: "slice_auto",
    }),
    [
      arrowsVisible,
      clipPos,
      effectiveComponent,
      effectivePlane,
      objectViewMode,
      quantityId,
    ],
  );
  const boundsStrategy = objectViewMode === "isolate" ? "visible-intersection" : "visible-context";
  const {
    topologyKey,
    fieldKey,
    slice,
    pending: sliceSamplingPending,
  } = useFemSliceSampling({
    meshData,
    sliceQuery,
    planeCoord,
    effectivePlane,
    effectiveComponent,
    quantityId,
    visibilityState,
    boundsStrategy,
  });

  const colorScale = useMemo(
    () => smartAutoScale(slice.valueRange.min, slice.valueRange.max, quantityId, effectiveComponent),
    [effectiveComponent, quantityId, slice.valueRange.max, slice.valueRange.min],
  );
  const resolvedPalette = useMemo(
    () =>
      isMagnetizationQuantity && effectiveComponent !== "magnitude"
        ? [...COOLWARM]
        : colorScale.mode === "diverging"
          ? [...COOLWARM]
          : paletteForMode(colorScale.mode),
    [colorScale.mode, effectiveComponent, isMagnetizationQuantity],
  );
  const quantityTitle = useMemo(
    () => quantityHeading(quantityId, quantityLabel, effectiveComponent),
    [effectiveComponent, quantityId, quantityLabel],
  );

  const antennaRects = useMemo(
    () => collectAntennaRects(antennaOverlays, effectivePlane, slice.planeCoord, selectedAntennaId),
    [antennaOverlays, effectivePlane, selectedAntennaId, slice.planeCoord],
  );

  const sampledArrows = useMemo(
    () =>
      sampleArrows(
        slice.arrows.filter((arrow) => {
          const part = arrow.partId ? visibilityState.partById.get(arrow.partId) ?? null : null;
          return arrow.magnitude > 1e-12 && shouldShowVectorArrow(part, vectorDomain);
        }),
        arrowBudget,
      ),
    [arrowBudget, slice.arrows, vectorDomain, visibilityState.partById],
  );

  const traces = useMemo(() => {
    const items: Plotly.Data[] = [];
    const polygonWireframes = new Map<
      string,
      { part: FemMeshPart | null; x: Array<number | null>; y: Array<number | null> }
    >();
    const pointBuckets = new Map<
      string,
      { part: FemMeshPart | null; x: number[]; y: number[] }
    >();

    for (const polygon of slice.polygons) {
      if (polygon.points.length < 3) continue;
      const closed = [...polygon.points, polygon.points[0]];
      const part = polygon.partId ? visibilityState.partById.get(polygon.partId) ?? null : null;
      const bucketKey = part?.role ?? polygon.partId ?? "unknown";
      const viewState = part ? meshEntityViewState[part.id] ?? defaultMeshEntityViewState(part) : null;
      const basePartRenderMode = viewState?.renderMode ?? effectiveMeshRenderMode;
      const partRenderMode =
        !isAirboxPart(part) && basePartRenderMode === "surface" && showMesh
          ? "surface+edges"
          : !isAirboxPart(part) && basePartRenderMode === "surface+edges" && !showMesh
            ? "surface"
            : basePartRenderMode;
      const partShowPolygonFill =
        (partRenderMode === "surface" || partRenderMode === "surface+edges") && showPrimitives;
      const partShowSegments = partRenderMode === "surface+edges" || partRenderMode === "wireframe";
      const partShowPoints = partRenderMode === "points";
      const polygonWorldPoint = polygon.worldPoint ?? [
        axisValue(effectivePlane, slice.planeCoord, "x", closed[0][0], closed[0][1]),
        axisValue(effectivePlane, slice.planeCoord, "y", closed[0][0], closed[0][1]),
        axisValue(effectivePlane, slice.planeCoord, "z", closed[0][0], closed[0][1]),
      ];
      const polygonWorldVector = polygon.worldVector ?? null;
      if (partShowPolygonFill) {
        items.push({
          type: "scatter",
          mode: "lines",
          x: closed.map((point) => point[0]),
          y: closed.map((point) => point[1]),
          fill: "toself",
          fillcolor: showQuantity && hasField && !isAirboxPart(part)
            ? colorForValue(polygon.value, colorScale, resolvedPalette)
            : colorForDomain(polygon.partId),
          line: {
            color: hasField ? "rgba(0,0,0,0.18)" : "rgba(166,173,200,0.55)",
            width: hasField ? 0.7 : 1.1,
          },
          hovertemplate:
            [
              `<b>${quantityTitle}</b>`,
              `x %{customdata[0]:.3e} m`,
              `y %{customdata[1]:.3e} m`,
              `z %{customdata[2]:.3e} m`,
              `${slice.uLabel} %{x:.3e} m`,
              `${slice.vLabel} %{y:.3e} m`,
              `${worldComponentSymbol(quantityId, quantityLabel, effectiveComponent)} %{customdata[6]:.4e}${quantityUnit ? ` ${quantityUnit}` : ""}`,
              polygonWorldVector
                ? `world vector [%{customdata[3]:.3e}, %{customdata[4]:.3e}, %{customdata[5]:.3e}]${quantityUnit ? ` ${quantityUnit}` : ""}`
                : null,
              "<extra>volume</extra>",
            ]
              .filter(Boolean)
              .join("<br>"),
          customdata: closed.map(() => [
            polygonWorldPoint[0],
            polygonWorldPoint[1],
            polygonWorldPoint[2],
            polygonWorldVector?.[0] ?? null,
            polygonWorldVector?.[1] ?? null,
            polygonWorldVector?.[2] ?? null,
            polygon.value,
            polygonWorldVector
              ? Math.hypot(polygonWorldVector[axisIndices(effectivePlane).u], polygonWorldVector[axisIndices(effectivePlane).v])
              : null,
          ]),
          showlegend: false,
        } as Plotly.Data);
      }

      if (partShowSegments) {
        const bucket = polygonWireframes.get(bucketKey) ?? {
          part,
          x: [],
          y: [],
        };
        for (const point of closed) {
          bucket.x.push(point[0]);
          bucket.y.push(point[1]);
        }
        bucket.x.push(null);
        bucket.y.push(null);
        polygonWireframes.set(bucketKey, bucket);
      }

      if (partShowPoints) {
        const bucket = pointBuckets.get(bucketKey) ?? { part, x: [], y: [] };
        for (const point of polygon.points) {
          bucket.x.push(point[0]);
          bucket.y.push(point[1]);
        }
        pointBuckets.set(bucketKey, bucket);
      }
    }

    for (const bucket of polygonWireframes.values()) {
      items.push({
        type: "scatter",
        mode: "lines",
        x: bucket.x,
        y: bucket.y,
        line: {
          color: edgeColorForPart(bucket.part),
          width: bucket.part?.role === "air" || bucket.part?.role === "outer_boundary" ? 1.2 : 0.9,
          dash: edgeDashForPart(bucket.part),
        },
        hoverinfo: "skip",
        showlegend: false,
      } as Plotly.Data);
    }

    for (const bucket of pointBuckets.values()) {
      items.push({
        type: "scatter",
        mode: "markers",
        x: bucket.x,
        y: bucket.y,
        marker: {
          size: bucket.part?.role === "air" || bucket.part?.role === "outer_boundary" ? 3.2 : 4,
          color: edgeColorForPart(bucket.part),
          opacity: 0.82,
        },
        hoverinfo: "skip",
        showlegend: false,
      } as Plotly.Data);
    }

    if (showSegments && slice.segments.length > 0) {
      items.push({
        type: "scatter",
        mode: "lines",
        x: slice.segments.flatMap((segment) => [segment.a[0], segment.b[0], null]),
        y: slice.segments.flatMap((segment) => [segment.a[1], segment.b[1], null]),
        line: {
          color: hasField ? "rgba(205,214,244,0.7)" : "rgba(166,173,200,0.7)",
          width: hasField ? 2 : 1.6,
        },
        hoverinfo: "skip",
        showlegend: false,
      } as Plotly.Data);
    }

    if (showPoints && slice.segments.length > 0) {
      items.push({
        type: "scatter",
        mode: "markers",
        x: slice.segments.flatMap((segment) => [segment.a[0], segment.b[0]]),
        y: slice.segments.flatMap((segment) => [segment.a[1], segment.b[1]]),
        marker: {
          size: 4,
          color: "rgba(137, 220, 235, 0.84)",
          opacity: 0.82,
        },
        hoverinfo: "skip",
        showlegend: false,
      } as Plotly.Data);
    }

    for (const rect of antennaRects) {
      const points: Point2[] = [
        [rect.bounds.uMin, rect.bounds.vMin],
        [rect.bounds.uMax, rect.bounds.vMin],
        [rect.bounds.uMax, rect.bounds.vMax],
        [rect.bounds.uMin, rect.bounds.vMax],
        [rect.bounds.uMin, rect.bounds.vMin],
      ];
      items.push({
        type: "scatter",
        mode: "lines",
        x: points.map((point) => point[0]),
        y: points.map((point) => point[1]),
        fill: "toself",
        fillcolor: rect.role === "ground"
          ? rect.selected
            ? "rgba(137, 220, 235, 0.28)"
            : "rgba(137, 220, 235, 0.16)"
          : rect.selected
            ? "rgba(250, 179, 135, 0.32)"
            : "rgba(250, 179, 135, 0.18)",
        line: {
          color: rect.role === "ground" ? "#89dceb" : "#fab387",
          width: rect.selected ? 2.2 : 1.2,
        },
        hovertemplate: `${rect.role}<extra>antenna</extra>`,
        showlegend: false,
      } as Plotly.Data);
    }

    if (shouldShowColorbar) {
      items.push({
        type: "scatter",
        mode: "markers",
        x: [slice.bounds.uMin, slice.bounds.uMax],
        y: [slice.bounds.vMin, slice.bounds.vMax],
        marker: {
          size: 0.1,
          color: [colorScale.min, colorScale.max],
          colorscale: resolvedPalette,
          cmin: colorScale.min,
          cmax: colorScale.max,
          colorbar: {
            title: { text: quantityTitle, side: "right" },
            thickness: 12,
            tickfont: { color: TEXT, family: "IBM Plex Mono, monospace", size: 10 },
            titlefont: { color: TEXT_STRONG, family: "IBM Plex Mono, monospace", size: 11 },
            outlinecolor: BORDER,
            outlinewidth: 1.25,
          },
          showscale: true,
        },
        hoverinfo: "skip",
        showlegend: false,
        opacity: 0,
      } as Plotly.Data);
    }

    if (hasVectorField && arrowsVisible && sampledArrows.length > 0) {
      const du = slice.bounds.uMax - slice.bounds.uMin;
      const dv = slice.bounds.vMax - slice.bounds.vMin;
      const span = Math.max(du, dv, 1e-12);
      const maxMagnitude = Math.max(...sampledArrows.map((arrow) => arrow.magnitude), 1e-12);
      const baseLength = span * (sampledArrows.length > 400 ? 0.026 : 0.04);
      const arrowX: Array<number | null> = [];
      const arrowY: Array<number | null> = [];
      for (const arrow of sampledArrows) {
        const norm = arrow.magnitude / maxMagnitude;
        const length = baseLength * (0.35 + 0.65 * Math.sqrt(norm));
        const vx = (arrow.vector[0] / Math.max(arrow.magnitude, 1e-12)) * length;
        const vy = (arrow.vector[1] / Math.max(arrow.magnitude, 1e-12)) * length;
        const x1 = arrow.origin[0] - vx * 0.5;
        const y1 = arrow.origin[1] - vy * 0.5;
        const x2 = arrow.origin[0] + vx * 0.5;
        const y2 = arrow.origin[1] + vy * 0.5;
        const head = length * 0.24;
        const angle = Math.atan2(vy, vx);
        const wingA: Point2 = [x2 - head * Math.cos(angle - Math.PI / 7), y2 - head * Math.sin(angle - Math.PI / 7)];
        const wingB: Point2 = [x2 - head * Math.cos(angle + Math.PI / 7), y2 - head * Math.sin(angle + Math.PI / 7)];
        arrowX.push(x1, x2, null, x2, wingA[0], null, x2, wingB[0], null);
        arrowY.push(y1, y2, null, y2, wingA[1], null, y2, wingB[1], null);
      }
      items.push({
        type: "scatter",
        mode: "lines",
        x: arrowX,
        y: arrowY,
        line: {
          color: "rgba(205,214,244,0.86)",
          width: 1.4,
        },
        hoverinfo: "skip",
        showlegend: false,
      } as Plotly.Data);
      items.push({
        type: "scatter",
        mode: "markers",
        x: sampledArrows.map((arrow) => arrow.origin[0]),
        y: sampledArrows.map((arrow) => arrow.origin[1]),
        marker: {
          size: 4,
          color: "rgba(137,180,250,0.9)",
          line: { color: "rgba(17,17,27,0.9)", width: 0.5 },
        },
        hovertemplate: [
          `<b>${quantityTitle} vector</b>`,
          `x %{customdata[0]:.3e} m`,
          `y %{customdata[1]:.3e} m`,
          `z %{customdata[2]:.3e} m`,
          `${slice.uLabel} %{x:.3e} m`,
          `${slice.vLabel} %{y:.3e} m`,
          `world vector [%{customdata[3]:.3e}, %{customdata[4]:.3e}, %{customdata[5]:.3e}]${quantityUnit ? ` ${quantityUnit}` : ""}`,
          `in-plane |${worldSymbolBase(quantityId, quantityLabel)}_${slice.uLabel}${slice.vLabel}| %{customdata[7]:.4e}${quantityUnit ? ` ${quantityUnit}` : ""}`,
          "<extra>vector</extra>",
        ].join("<br>"),
        customdata: sampledArrows.map((arrow) => [
          arrow.worldPoint[0],
          arrow.worldPoint[1],
          arrow.worldPoint[2],
          arrow.worldVector[0],
          arrow.worldVector[1],
          arrow.worldVector[2],
          effectiveComponent === "magnitude"
            ? Math.hypot(...arrow.worldVector)
            : arrow.worldVector[effectiveComponent === "x" ? 0 : effectiveComponent === "y" ? 1 : 2],
          arrow.magnitude,
        ]),
        showlegend: false,
      } as Plotly.Data);
    }

    return items;
  }, [
    antennaRects,
    arrowsVisible,
    colorScale,
    effectiveComponent,
    effectivePlane,
    hasField,
    hasVectorField,
    resolvedPalette,
    quantityId,
    quantityLabel,
    quantityUnit,
    quantityTitle,
    sampledArrows,
    slice,
    showMesh,
    showPoints,
    showPolygonFill,
    showQuantity,
    showSegments,
    shouldShowColorbar,
    visibilityState,
  ]);

  const layout = useMemo(
    (): Partial<Plotly.Layout> => ({
      paper_bgcolor: BG,
      plot_bgcolor: "rgba(17,17,27,0.72)",
      margin: { l: 68, r: shouldShowColorbar ? 104 : 20, t: 92, b: 84 },
      font: {
        family: "IBM Plex Mono, monospace",
        size: 11,
        color: TEXT,
      },
      dragmode: "pan",
      hovermode: "closest",
      showlegend: false,
      uirevision: topologyKey,
      datarevision: fieldKey,
      xaxis: {
        title: { text: `${slice.uLabel} axis (m)`, font: { color: TEXT_STRONG, size: 12 } },
        range: [slice.bounds.uMin, slice.bounds.uMax],
        color: TEXT,
        gridcolor: GRID,
        zeroline: false,
        showline: true,
        linecolor: BORDER,
        mirror: true,
        exponentformat: "e",
      },
      yaxis: {
        title: { text: `${slice.vLabel} axis (m)`, font: { color: TEXT_STRONG, size: 12 } },
        range: [slice.bounds.vMin, slice.bounds.vMax],
        color: TEXT,
        gridcolor: GRID,
        zeroline: false,
        showline: true,
        linecolor: BORDER,
        mirror: true,
        exponentformat: "e",
        scaleanchor: "x",
        scaleratio: 1,
      },
      annotations: [
        {
          xref: "paper",
          yref: "paper",
          x: 0,
          y: 1.03,
          xanchor: "left",
          yanchor: "bottom",
          text: `<b>${hasField ? quantityTitle : "mesh"}</b><br>plane ${slice.normalLabel} = ${slice.planeCoord.toExponential(3)} m`,
          showarrow: false,
          align: "left",
          font: { family: "IBM Plex Mono, monospace", size: 11, color: TEXT_STRONG },
        },
        {
          xref: "paper",
          yref: "paper",
          x: 1,
          y: 1.03,
          xanchor: "right",
          yanchor: "bottom",
          text: `${slice.polygons.length + slice.segments.length} elements`,
          showarrow: false,
          font: { family: "IBM Plex Mono, monospace", size: 10, color: TEXT },
        },
      ],
      modebar: {
        bgcolor: "transparent",
        color: TEXT,
        activecolor: "#89b4fa",
      },
    }),
    [
      fieldKey,
      hasField,
      shouldShowColorbar,
      topologyKey,
      quantityTitle,
      slice,
    ],
  );

  const config = useMemo(
    (): Partial<Plotly.Config> => ({
      responsive: true,
      displaylogo: false,
      scrollZoom: true,
      doubleClick: "reset",
      modeBarButtonsToRemove: [
        "lasso2d",
        "select2d",
        "autoScale2d",
        "hoverCompareCartesian",
        "hoverClosestCartesian",
      ],
    }),
    [],
  );

  return (
    <div className="relative h-full min-h-[360px] w-full overflow-hidden rounded-[8px] bg-[#1e1e2e]">
      <Plot
        data={traces}
        layout={layout}
        config={config}
        useResizeHandler
        className="h-full w-full"
        style={{ width: "100%", height: "100%" }}
        onHover={(event: Readonly<PlotHoverEvent>) => {
          const point = event.points?.[0];
          if (!point) return;
          setHoverProbe(buildProbeFromPoint(point, effectivePlane, slice.planeCoord));
        }}
        onUnhover={() => setHoverProbe(null)}
        onClick={(event: Readonly<PlotMouseEvent>) => {
          const point = event.points?.[0];
          if (!point) return;
          setPinnedProbe(buildProbeFromPoint(point, effectivePlane, slice.planeCoord));
        }}
      />
      <ViewportOverlayLayout>
        {(hoverProbe || pinnedProbe) && (
          <ViewportOverlayLayout.TopRight>
            <div className="min-w-[190px] rounded-xl border border-border/30 bg-background/78 px-3 py-2 text-[0.68rem] font-mono text-slate-200 shadow-lg backdrop-blur-md pointer-events-auto">
              <div className="mb-1 flex items-center justify-between text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-slate-400">
                <span>Probe</span>
                {pinnedProbe && (
                  <button
                    className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2 py-0.5 text-cyan-100"
                    onClick={() => setPinnedProbe(null)}
                  >
                    pinned
                  </button>
                )}
              </div>
              {([["Hover", hoverProbe], ["Pinned", pinnedProbe]] as const)
                .filter(([, probe]) => probe != null)
                .map(([label, probe]) => (
                  <div key={label} className="mb-1 last:mb-0">
                    <div className="text-[0.56rem] font-semibold uppercase tracking-[0.12em] text-slate-500">
                      {label}
                    </div>
                    <div>x {probe!.worldPoint[0].toExponential(3)} m</div>
                    <div>y {probe!.worldPoint[1].toExponential(3)} m</div>
                    <div>z {probe!.worldPoint[2].toExponential(3)} m</div>
                    <div>
                      {slice.uLabel} {probe!.u.toExponential(3)} m
                    </div>
                    <div>
                      {slice.vLabel} {probe!.v.toExponential(3)} m
                    </div>
                    <div>
                      {worldComponentSymbol(quantityId, quantityLabel, effectiveComponent)} {formatProbeValue(probe!.value)}
                      {probe!.source ? ` (${probe!.source})` : ""}
                    </div>
                    {probe!.worldVector && (
                      <div>
                        vector [{probe!.worldVector[0].toExponential(2)}, {probe!.worldVector[1].toExponential(2)}, {probe!.worldVector[2].toExponential(2)}]
                      </div>
                    )}
                    {probe!.inPlaneMagnitude != null && (
                      <div>
                        in-plane {formatProbeValue(probe!.inPlaneMagnitude)}
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </ViewportOverlayLayout.TopRight>
        )}

        <ViewportOverlayLayout.BottomCenter>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/40 bg-card/60 px-4 py-2 text-[0.68rem] font-mono text-slate-300 shadow-sm backdrop-blur-md pointer-events-none">
            <span>{quantityTitle}</span>
            <span>{effectivePlane.toUpperCase()}</span>
            <span>{slice.normalLabel} = {slice.planeCoord.toExponential(2)} m</span>
            {hasVectorField ? <span>vectors {arrowsVisible ? "on" : "off"}</span> : <span>scalar slice</span>}
            {sliceSamplingPending ? <span className="text-amber-200">sampling...</span> : null}
          </div>
        </ViewportOverlayLayout.BottomCenter>
      </ViewportOverlayLayout>
    </div>
  );
}
