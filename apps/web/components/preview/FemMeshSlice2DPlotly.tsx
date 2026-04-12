"use client";

import { useEffect, useMemo, useState } from "react";
import type { PlotHoverEvent, PlotMouseEvent } from "plotly.js";
import type { FemMeshData, FemVectorDomainFilter } from "./FemMeshView3D";
import type { AntennaOverlay } from "../runs/control-room/shared";
import Plot from "../plots/DynamicPlot";
import { ViewportOverlayLayout } from "./ViewportOverlayLayout";
import type { FemMeshPart, MeshEntityViewStateMap } from "../../lib/session/types";
import type { ObjectViewMode } from "../runs/control-room/shared";
import {
  buildSliceVisibilityState,
  clipAxisToPlane,
  getSmartColorScale,
  normalizedClipToWorld,
  planeToClipAxis,
} from "./fem/femSliceUtils";
import {
  axisIndices,
  collectSegments,
  type Point2,
  type SlicePlane,
  type VectorComponent,
} from "./fem/femSliceGeometry";
import {
  glyphBudgetToMaxPoints,
  maxPointsToGlyphBudget,
  GLYPH_BUDGET_MAX,
  GLYPH_BUDGET_MIN,
  GLYPH_BUDGET_STEP,
  PREVIEW_MAX_POINTS_DEFAULT,
} from "./fem/vectorDensityBudget";
import { DIVERGING_PALETTE, POSITIVE_PALETTE, SEQUENTIAL_BLUE_PALETTE } from "../../lib/colorPalettes";
import { ViewportToolbar3D } from "./ViewportToolbar3D";
import { ViewportToolGroup, ViewportToolSeparator } from "./ViewportToolGroup";
import { ViewportIconAction } from "./ViewportIconAction";
import { ViewportPopoverPanel, ViewportPopoverRow, ViewportPopoverTrigger } from "./ViewportPopoverPanel";
import { ArrowUpRight, Layers, Scissors, SlidersHorizontal } from "lucide-react";

interface Props {
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
  u: number;
  v: number;
  value: number | null;
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
const DIVERGING = DIVERGING_PALETTE as unknown as string[];
const POSITIVE = POSITIVE_PALETTE as unknown as string[];
const NEGATIVE = SEQUENTIAL_BLUE_PALETTE as unknown as string[];
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
  min: number,
  max: number,
  quantityId: string | undefined,
  component: VectorComponent,
): string {
  const isMagnetization = !quantityId || quantityId === "m";
  if (isMagnetization && component !== "magnitude") {
    const t = max > min ? (value - min) / (max - min) : 0.5;
    return paletteColor(t, COOLWARM as unknown as string[]);
  }
  if (isMagnetization && min === 0 && max === 1) {
    return paletteColor(value, POSITIVE);
  }
  const palette = min < 0 && max > 0 ? DIVERGING : max <= 0 ? NEGATIVE : POSITIVE;
  const t = max > min ? (value - min) / (max - min) : 0.5;
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
  arrows: Array<{ origin: Point2; vector: Point2; magnitude: number }>,
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
  quantityLabel,
  quantityId,
  quantityUnit,
  quantityOptions = [],
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
  onQuantityChange,
  onComponentChange,
  onPlaneChange,
  onClipAxisChange,
  onClipPosChange,
  onShowArrowsChange,
  onPreviewMaxPointsChange,
}: Props) {
  const [internalShowArrows, setInternalShowArrows] = useState(false);
  const [internalPreviewMaxPoints, setInternalPreviewMaxPoints] = useState(PREVIEW_MAX_POINTS_DEFAULT);
  const [openPopover, setOpenPopover] = useState<string | null>(null);
  const [hoverProbe, setHoverProbe] = useState<SliceProbe | null>(null);
  const [pinnedProbe, setPinnedProbe] = useState<SliceProbe | null>(null);

  const arrowsVisible = showArrows ?? internalShowArrows;
  const effectivePreviewMaxPoints = onPreviewMaxPointsChange ? previewMaxPoints : internalPreviewMaxPoints;
  const arrowBudget = maxPointsToGlyphBudget(effectivePreviewMaxPoints);
  const fieldNComp = meshData.fieldNComp ?? 3;
  const hasField = Boolean(meshData.fieldData);
  const hasVectorField = hasField && fieldNComp >= 3;
  const isMagnetizationQuantity = !quantityId || quantityId === "m";
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
          vectorDomainFilter === "auto"
            ? meshData.quantityDomain === "full_domain"
              ? "full_domain"
              : "magnetic_only"
            : vectorDomainFilter,
      }),
    [
      airSegmentVisible,
      meshData,
      meshData.quantityDomain,
      meshEntityViewState,
      meshParts,
      objectViewMode,
      vectorDomainFilter,
      visibleObjectIds,
    ],
  );

  const slice = useMemo(
    () =>
      collectSegments(
        meshData,
        effectivePlane,
        effectiveComponent,
        planeCoord,
        visibilityState,
        objectViewMode === "isolate" ? "visible-intersection" : "visible-context",
      ),
    [meshData, effectivePlane, effectiveComponent, planeCoord, visibilityState, objectViewMode],
  );

  const colorScale = useMemo(
    () => getSmartColorScale(slice.valueRange.min, slice.valueRange.max, quantityId, effectiveComponent),
    [effectiveComponent, quantityId, slice.valueRange.max, slice.valueRange.min],
  );

  const antennaRects = useMemo(
    () => collectAntennaRects(antennaOverlays, effectivePlane, slice.planeCoord, selectedAntennaId),
    [antennaOverlays, effectivePlane, selectedAntennaId, slice.planeCoord],
  );

  const sampledArrows = useMemo(
    () => sampleArrows(slice.arrows.filter((arrow) => arrow.magnitude > 1e-12), arrowBudget),
    [arrowBudget, slice.arrows],
  );

  const traces = useMemo(() => {
    const items: Plotly.Data[] = [];

    for (const polygon of slice.polygons) {
      if (polygon.points.length < 3) continue;
      const closed = [...polygon.points, polygon.points[0]];
      items.push({
        type: "scatter",
        mode: "lines",
        x: closed.map((point) => point[0]),
        y: closed.map((point) => point[1]),
        fill: "toself",
        fillcolor: hasField
          ? colorForValue(
              polygon.value,
              colorScale.min,
              colorScale.max,
              quantityId,
              effectiveComponent,
            )
          : colorForDomain(polygon.partId),
        line: {
          color: hasField ? "rgba(0,0,0,0.18)" : "rgba(166,173,200,0.55)",
          width: hasField ? 0.7 : 1.1,
        },
        hovertemplate:
          `${slice.uLabel} %{x:.3e} m<br>${slice.vLabel} %{y:.3e} m<br>${hasField ? quantityLabel : "value"} %{customdata:.4e} ${hasField && quantityUnit ? quantityUnit : ""}<extra>volume</extra>`,
        customdata: closed.map(() => polygon.value),
        showlegend: false,
      } as Plotly.Data);
    }

    if (slice.segments.length > 0) {
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

    if (hasField) {
      items.push({
        type: "scatter",
        mode: "markers",
        x: [slice.bounds.uMin, slice.bounds.uMax],
        y: [slice.bounds.vMin, slice.bounds.vMax],
        marker: {
          size: 0.1,
          color: [colorScale.min, colorScale.max],
          colorscale:
            isMagnetizationQuantity && effectiveComponent !== "magnitude"
              ? (COOLWARM as unknown as string[])
              : colorScale.mode === "diverging"
              ? DIVERGING
              : colorScale.mode === "negative"
                ? NEGATIVE
                : POSITIVE,
          cmin: colorScale.min,
          cmax: colorScale.max,
          colorbar: {
            title: { text: quantityLabel, side: "top" },
            thickness: 10,
            tickfont: { color: TEXT, family: "IBM Plex Mono, monospace", size: 10 },
            titlefont: { color: TEXT_STRONG, family: "IBM Plex Mono, monospace", size: 11 },
            outlinecolor: BORDER,
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
        hovertemplate: `${slice.uLabel} %{x:.3e} m<br>${slice.vLabel} %{y:.3e} m<br>|v_${slice.uLabel}${slice.vLabel}| %{customdata:.4e} ${quantityUnit ?? ""}<extra>vector</extra>`,
        customdata: sampledArrows.map((arrow) => arrow.magnitude),
        showlegend: false,
      } as Plotly.Data);
    }

    return items;
  }, [
    antennaRects,
    arrowsVisible,
    colorScale.max,
    colorScale.min,
    colorScale.mode,
    hasVectorField,
    quantityId,
    quantityLabel,
    sampledArrows,
    slice,
  ]);

  const layout = useMemo(
    (): Partial<Plotly.Layout> => ({
      paper_bgcolor: BG,
      plot_bgcolor: "rgba(17,17,27,0.72)",
      margin: { l: 68, r: hasField ? 88 : 20, t: 88, b: 84 },
      font: {
        family: "IBM Plex Mono, monospace",
        size: 11,
        color: TEXT,
      },
      dragmode: "pan",
      hovermode: "closest",
      showlegend: false,
      uirevision: `${effectivePlane}:${effectiveComponent}:${quantityId ?? "q"}`,
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
          text: `<b>${hasField ? `${quantityLabel}${fieldNComp >= 3 ? `.${effectiveComponent}` : ""}` : "mesh"}</b><br>plane ${slice.normalLabel} = ${slice.planeCoord.toExponential(3)} m`,
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
      effectiveComponent,
      effectivePlane,
      fieldNComp,
      hasField,
      quantityId,
      quantityLabel,
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
          const pointData = point as typeof point & { fullData?: { hovertemplate?: string } };
          const source =
            pointData.fullData?.hovertemplate?.includes("vector")
              ? "vector"
              : pointData.fullData?.hovertemplate?.includes("volume")
                ? "volume"
                : "boundary";
          const value =
            typeof point.customdata === "number"
              ? point.customdata
              : Array.isArray(point.customdata) && typeof point.customdata[0] === "number"
                ? point.customdata[0]
                : null;
          setHoverProbe({
            u: Number(point.x),
            v: Number(point.y),
            value,
            source,
          });
        }}
        onUnhover={() => setHoverProbe(null)}
        onClick={(event: Readonly<PlotMouseEvent>) => {
          const point = event.points?.[0];
          if (!point) return;
          const pointData = point as typeof point & { fullData?: { hovertemplate?: string } };
          const source =
            pointData.fullData?.hovertemplate?.includes("vector")
              ? "vector"
              : pointData.fullData?.hovertemplate?.includes("volume")
                ? "volume"
                : "boundary";
          const value =
            typeof point.customdata === "number"
              ? point.customdata
              : Array.isArray(point.customdata) && typeof point.customdata[0] === "number"
                ? point.customdata[0]
                : null;
          setPinnedProbe({
            u: Number(point.x),
            v: Number(point.y),
            value,
            source,
          });
        }}
      />
      <ViewportOverlayLayout>
        <ViewportOverlayLayout.TopLeft>
          <div className="pointer-events-auto">
            <ViewportToolbar3D compact>
              {quantityOptions.length > 0 && onQuantityChange ? (
                <>
                  <ViewportToolGroup label="Results" compact>
                    <ViewportPopoverTrigger preferredHorizontal="left">
                      <ViewportIconAction
                        icon={<Layers size={14} />}
                        label={quantityOptions.find((option) => option.id === quantityId)?.shortLabel ?? "Qty"}
                        showCaret
                        active={openPopover === "quantity"}
                        onClick={() => setOpenPopover(openPopover === "quantity" ? null : "quantity")}
                        title="Slice quantity"
                      />
                      {openPopover === "quantity" && (
                        <ViewportPopoverPanel anchorRef={{ current: null }} title="Quantity">
                          <div className="grid min-w-[220px] grid-cols-2 gap-1">
                            {quantityOptions
                              .map((option) => (
                                <ViewportIconAction
                                  key={option.id}
                                  active={option.id === quantityId}
                                  onClick={() => {
                                    if (!option.available) return;
                                    onQuantityChange(option.id);
                                    setOpenPopover(null);
                                  }}
                                  label={option.shortLabel}
                                  className={`justify-start px-2 py-1.5${!option.available ? " opacity-40 cursor-not-allowed" : ""}`}
                                  title={!option.available ? `${option.label ?? option.shortLabel} — waiting for data` : (option.label ?? option.shortLabel)}
                                />
                              ))}
                          </div>
                        </ViewportPopoverPanel>
                      )}
                    </ViewportPopoverTrigger>
                    {fieldNComp >= 3 ? (
                      <ViewportPopoverTrigger preferredHorizontal="left">
                        <ViewportIconAction
                          icon={<Layers size={14} />}
                          label={effectiveComponent === "magnitude" ? "|v|" : effectiveComponent}
                          showCaret
                          active={openPopover === "component"}
                          onClick={() => setOpenPopover(openPopover === "component" ? null : "component")}
                          title="Slice component"
                        />
                        {openPopover === "component" && (
                          <ViewportPopoverPanel anchorRef={{ current: null }} title="Component">
                            <div className="flex flex-wrap gap-1">
                              {componentOptions.map((option) => (
                                <ViewportIconAction
                                  key={option}
                                  active={option === effectiveComponent}
                                  onClick={() => {
                                    onComponentChange?.(option);
                                    setOpenPopover(null);
                                  }}
                                  label={option === "magnitude" ? "|v|" : option}
                                  className="px-3"
                                />
                              ))}
                            </div>
                          </ViewportPopoverPanel>
                        )}
                      </ViewportPopoverTrigger>
                    ) : null}
                  </ViewportToolGroup>
                  <ViewportToolSeparator />
                </>
              ) : null}

              <ViewportToolGroup label="Section" compact>
                <ViewportIconAction
                  icon={<Scissors size={14} />}
                  active
                  title="Slice plane"
                />
                <ViewportPopoverTrigger preferredHorizontal="left">
                  <ViewportIconAction
                    icon={<SlidersHorizontal size={14} />}
                    active={openPopover === "section"}
                    showCaret
                    onClick={() => setOpenPopover(openPopover === "section" ? null : "section")}
                    title="Slice plane settings"
                  />
                  {openPopover === "section" && (
                    <ViewportPopoverPanel anchorRef={{ current: null }} title="Slice Plane">
                      <ViewportPopoverRow label="Plane">
                        <div className="flex gap-1">
                          {(["xy", "xz", "yz"] as const).map((candidatePlane) => (
                            <ViewportIconAction
                              key={candidatePlane}
                              active={effectivePlane === candidatePlane}
                              onClick={() => {
                                onPlaneChange?.(candidatePlane);
                                onClipAxisChange?.(planeToClipAxis(candidatePlane));
                              }}
                              label={candidatePlane.toUpperCase()}
                              className="px-3"
                            />
                          ))}
                        </div>
                      </ViewportPopoverRow>
                      <ViewportPopoverRow label="Position">
                        <input
                          type="range"
                          min={0}
                          max={100}
                          step={0.1}
                          value={clipPos}
                          onChange={(event) => onClipPosChange?.(Number(event.target.value))}
                          className="flex-1 max-w-[180px]"
                        />
                      </ViewportPopoverRow>
                    </ViewportPopoverPanel>
                  )}
                </ViewportPopoverTrigger>
              </ViewportToolGroup>

              {hasVectorField ? (
                <>
                  <ViewportToolSeparator />
                  <ViewportToolGroup label="Vectors" compact>
                    <ViewportIconAction
                      icon={<ArrowUpRight size={14} />}
                      active={arrowsVisible}
                      onClick={() => {
                        const next = !arrowsVisible;
                        if (onShowArrowsChange) {
                          onShowArrowsChange(next);
                        } else {
                          setInternalShowArrows(next);
                        }
                      }}
                      title="Toggle vectors"
                    />
                    <ViewportPopoverTrigger preferredHorizontal="left">
                      <ViewportIconAction
                        icon={<SlidersHorizontal size={14} />}
                        active={openPopover === "vectors"}
                        showCaret
                        onClick={() => setOpenPopover(openPopover === "vectors" ? null : "vectors")}
                        title="Vector settings"
                      />
                      {openPopover === "vectors" && (
                        <ViewportPopoverPanel anchorRef={{ current: null }} title="Vectors">
                          <ViewportPopoverRow label="Visible">
                            <div className="flex gap-1">
                              <ViewportIconAction
                                active={arrowsVisible}
                                onClick={() => {
                                  if (onShowArrowsChange) {
                                    onShowArrowsChange(true);
                                  } else {
                                    setInternalShowArrows(true);
                                  }
                                }}
                                label="Show"
                                className="px-3"
                              />
                              <ViewportIconAction
                                active={!arrowsVisible}
                                onClick={() => {
                                  if (onShowArrowsChange) {
                                    onShowArrowsChange(false);
                                  } else {
                                    setInternalShowArrows(false);
                                  }
                                }}
                                label="Hide"
                                className="px-3"
                              />
                            </div>
                          </ViewportPopoverRow>
                          <ViewportPopoverRow label="Density">
                            <input
                              type="range"
                              min={GLYPH_BUDGET_MIN}
                              max={GLYPH_BUDGET_MAX}
                              step={GLYPH_BUDGET_STEP}
                              value={arrowBudget}
                              onChange={(event) => {
                                const nextMaxPoints = glyphBudgetToMaxPoints(Number(event.target.value));
                                if (onPreviewMaxPointsChange) {
                                  onPreviewMaxPointsChange(nextMaxPoints);
                                } else {
                                  setInternalPreviewMaxPoints(nextMaxPoints);
                                }
                              }}
                              className="flex-1 max-w-[180px]"
                            />
                          </ViewportPopoverRow>
                        </ViewportPopoverPanel>
                      )}
                    </ViewportPopoverTrigger>
                  </ViewportToolGroup>
                </>
              ) : null}
            </ViewportToolbar3D>
          </div>
        </ViewportOverlayLayout.TopLeft>
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
                    <div>u {probe!.u.toExponential(3)} m</div>
                    <div>v {probe!.v.toExponential(3)} m</div>
                    <div>
                      value {formatProbeValue(probe!.value)}
                      {probe!.source ? ` (${probe!.source})` : ""}
                    </div>
                  </div>
                ))}
            </div>
          </ViewportOverlayLayout.TopRight>
        )}

        <ViewportOverlayLayout.BottomCenter>
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/40 bg-card/60 px-4 py-2 text-[0.68rem] font-mono text-slate-300 shadow-sm backdrop-blur-md pointer-events-none">
            <span>{quantityLabel}{fieldNComp >= 3 ? `.${effectiveComponent}` : ""}</span>
            <span>{effectivePlane.toUpperCase()}</span>
            <span>{slice.normalLabel} = {slice.planeCoord.toExponential(2)} m</span>
            {hasVectorField ? <span>vectors {arrowsVisible ? "on" : "off"}</span> : <span>scalar slice</span>}
          </div>
        </ViewportOverlayLayout.BottomCenter>
      </ViewportOverlayLayout>
    </div>
  );
}
