"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FemMeshData, FemVectorDomainFilter } from "./fem/femMeshTypes";
import { DIVERGING_PALETTE, POSITIVE_PALETTE, SEQUENTIAL_BLUE_PALETTE } from "../../lib/colorPalettes";
import type { AntennaOverlay } from "../runs/control-room/shared";
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
  project,
  type Point2,
  type Point3,
} from "./fem/femSliceGeometry";

type SlicePlane = "xy" | "xz" | "yz";
type VectorComponent = "x" | "y" | "z" | "magnitude";

interface Props {
  meshData: FemMeshData;
  quantityLabel: string;
  quantityId?: string;
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
  onPlaneChange?: (plane: SlicePlane) => void;
  onClipAxisChange?: (axis: "x" | "y" | "z") => void;
  onClipPosChange?: (value: number) => void;
}

interface AntennaRect2D {
  id: string;
  role: AntennaOverlay["conductors"][number]["role"];
  bounds: { uMin: number; uMax: number; vMin: number; vMax: number };
  selected: boolean;
}

const BG = "#1e1e2e"; /* Catppuccin Base */
const BORDER = "#313244"; /* Catppuccin Surface0 */
const TEXT = "#a6adc8"; /* Catppuccin Subtext0 */
const TEXT_STRONG = "#cdd6f4"; /* Catppuccin Text */
const GRID = "rgba(108, 112, 134, 0.055)"; /* Catppuccin Overlay0 */
const EMPTY = "rgba(205, 214, 244, 0.08)"; /* Catppuccin Text */
const PANEL = "rgba(24, 24, 37, 0.88)";
const PANEL_SOFT = "rgba(30, 30, 46, 0.76)";
const ACCENT_LINE = "rgba(137, 180, 250, 0.4)";
const DIVERGING = [...DIVERGING_PALETTE];
const POSITIVE = [...POSITIVE_PALETTE];
const NEGATIVE = [...SEQUENTIAL_BLUE_PALETTE];

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function canvasTruncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0 || ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + "…").width > maxW) t = t.slice(0, -1);
  return t.length > 0 ? t + "…" : "…";
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

function colorForValue(value: number, min: number, max: number, quantityId: string | undefined): string {
  const isMagnetization = !quantityId || quantityId === "m";
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

function antennaRectColors(
  role: AntennaRect2D["role"],
  selected: boolean,
): { fill: string; stroke: string } {
  if (role === "ground") {
    return selected
      ? { fill: "rgba(137, 220, 235, 0.28)", stroke: "#89dceb" } /* Sky */
      : { fill: "rgba(137, 220, 235, 0.16)", stroke: "#89dceb66" };
  }
  return selected
    ? { fill: "rgba(250, 179, 135, 0.32)", stroke: "#fab387" } /* Peach */
    : { fill: "rgba(250, 179, 135, 0.18)", stroke: "#fab38766" };
}

interface SliceRenderFrame {
  width: number;
  height: number;
  margin: { left: number; right: number; top: number; bottom: number };
  plotRect: { x: number; y: number; width: number; height: number };
  colorbarRect: { x: number; y: number; width: number; height: number } | null;
  plotWidth: number;
  plotHeight: number;
  scale: number;
  ox: number;
  oy: number;
  bounds: { uMin: number; uMax: number; vMin: number; vMax: number };
}

interface SliceProbe {
  canvasX: number;
  canvasY: number;
  u: number;
  v: number;
  value: number | null;
  source: "volume" | "boundary" | null;
}

function pointInPolygon(point: Point2, polygon: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / Math.max(yj - yi, 1e-18) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function distanceToSegment(point: Point2, a: Point2, b: Point2): { distance: number; t: number } {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const apx = point[0] - a[0];
  const apy = point[1] - a[1];
  const denom = abx * abx + aby * aby;
  if (denom <= 1e-18) {
    return { distance: Math.hypot(apx, apy), t: 0 };
  }
  const t = clamp((apx * abx + apy * aby) / denom, 0, 1);
  const closestX = a[0] + abx * t;
  const closestY = a[1] + aby * t;
  return {
    distance: Math.hypot(point[0] - closestX, point[1] - closestY),
    t,
  };
}

function sampleSliceProbe(
  slice: ReturnType<typeof collectSegments>,
  frame: SliceRenderFrame,
  canvasX: number,
  canvasY: number,
): SliceProbe | null {
  const { ox, oy, scale, plotHeight, plotRect, bounds } = frame;
  if (
    canvasX < plotRect.x ||
    canvasX > plotRect.x + plotRect.width ||
    canvasY < plotRect.y ||
    canvasY > plotRect.y + plotRect.height
  ) {
    return null;
  }
  const u = (canvasX - ox) / scale + bounds.uMin;
  const v = (oy + plotHeight - canvasY) / scale + bounds.vMin;
  if (
    !Number.isFinite(u) ||
    !Number.isFinite(v) ||
    u < bounds.uMin ||
    u > bounds.uMax ||
    v < bounds.vMin ||
    v > bounds.vMax
  ) {
    return null;
  }

  const point: Point2 = [u, v];
  for (const polygon of slice.polygons) {
    if (polygon.points.length >= 3 && pointInPolygon(point, polygon.points)) {
      return { canvasX, canvasY, u, v, value: polygon.value, source: "volume" };
    }
  }

  const snapRadius = 10 / Math.max(scale, 1e-9);
  let best: SliceProbe | null = null;
  for (const segment of slice.segments) {
    const { distance, t } = distanceToSegment(point, segment.a, segment.b);
    if (distance > snapRadius) {
      continue;
    }
    const value = lerp(segment.va, segment.vb, t);
    if (!best || distance < Math.hypot(best.u - u, best.v - v)) {
      best = { canvasX, canvasY, u, v, value, source: "boundary" };
    }
  }
  return best ?? { canvasX, canvasY, u, v, value: null, source: null };
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

function formatMetricLength(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) {
    return "0 m";
  }
  if (abs >= 1) {
    return `${value.toFixed(abs >= 10 ? 2 : 3)} m`;
  }
  if (abs >= 1e-3) {
    return `${(value * 1e3).toFixed(abs >= 1e-2 ? 2 : 3)} mm`;
  }
  if (abs >= 1e-6) {
    return `${(value * 1e6).toFixed(abs >= 1e-5 ? 2 : 3)} um`;
  }
  if (abs >= 1e-9) {
    return `${(value * 1e9).toFixed(abs >= 1e-8 ? 2 : 3)} nm`;
  }
  return `${value.toExponential(2)} m`;
}

function buildNiceTicks(min: number, max: number, targetCount = 5): number[] {
  const span = max - min;
  if (!Number.isFinite(min) || !Number.isFinite(max) || span <= 0) {
    return [min];
  }

  const roughStep = span / Math.max(targetCount - 1, 1);
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  const niceUnit = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = niceUnit * magnitude;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];

  for (let value = start; value <= max + step * 0.5; value += step) {
    ticks.push(Number(value.toPrecision(12)));
  }

  if (ticks.length === 0) {
    return [min, max];
  }
  if (Math.abs(ticks[0] - min) > step * 0.35) {
    ticks.unshift(min);
  }
  if (Math.abs(ticks[ticks.length - 1] - max) > step * 0.35) {
    ticks.push(max);
  }

  return ticks;
}

export default function FemMeshSlice2D({
  meshData,
  quantityLabel,
  quantityId,
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
  onPlaneChange,
  onClipAxisChange,
  onClipPosChange,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<SliceRenderFrame | null>(null);
  const [canvasSize, setCanvasSize] = useState<[number, number]>([0, 0]);
  const [hoverProbe, setHoverProbe] = useState<SliceProbe | null>(null);
  const [pinnedProbe, setPinnedProbe] = useState<SliceProbe | null>(null);
  const controlsVisible = Boolean(onPlaneChange || onClipPosChange);

  const effectivePlane = clipAxis ? clipAxisToPlane(clipAxis) : plane;
  const { normal } = axisIndices(effectivePlane);
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
        component,
        planeCoord,
        visibilityState,
        objectViewMode === "isolate" ? "visible-intersection" : "visible-context",
      ),
    [meshData, effectivePlane, component, planeCoord, visibilityState, objectViewMode],
  );
  const colorScale = useMemo(
    () => getSmartColorScale(slice.valueRange.min, slice.valueRange.max, quantityId, component),
    [component, quantityId, slice.valueRange.max, slice.valueRange.min],
  );
  const antennaRects = useMemo(
    () => collectAntennaRects(antennaOverlays, effectivePlane, slice.planeCoord, selectedAntennaId),
    [antennaOverlays, effectivePlane, selectedAntennaId, slice.planeCoord],
  );

  // Sync probe state with slice parameters during render (React 19 recommended pattern for resets)
  const sliceParamsKey = `${component}:${effectivePlane}:${quantityId}:${slice.planeCoord}:${clipPos}`;
  const [prevSliceParamsKey, setPrevSliceParamsKey] = useState(sliceParamsKey);
  if (sliceParamsKey !== prevSliceParamsKey) {
    setPrevSliceParamsKey(sliceParamsKey);
    setHoverProbe(null);
    setPinnedProbe(null);
  }

  // Track container size so the canvas re-draws on resize
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasSize([Math.round(width), Math.round(height)]);
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const width = canvas.clientWidth || 900;
    const height = canvas.clientHeight || 520;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, width, height);

    const compactWidth = width < 720;
    const tightWidth = width < 560;
    const compactHeight = height < 420;
    const showColorbarPanel = !!meshData.fieldData && !tightWidth;
    const topMetaInset = compactWidth ? 34 : 44;
    const bottomSafeInset = controlsVisible ? (compactWidth ? 82 : 92) : compactHeight ? 20 : 28;
    const margin = {
      left: tightWidth ? 52 : compactWidth ? 62 : 74,
      right: compactWidth ? 18 : 26,
      top: (compactWidth ? 16 : 24) + topMetaInset,
      bottom: (compactWidth ? 56 : 68) + bottomSafeInset,
    };
    const colorbarW = showColorbarPanel ? 10 : 0;
    const colorbarGap = showColorbarPanel ? (compactWidth ? 10 : 16) : 0;
    const colorbarLabelW = showColorbarPanel ? (compactWidth ? 44 : 54) : 0;
    const reservedRight = colorbarW + colorbarGap + colorbarLabelW;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    const plotWidth = Math.max(innerW - reservedRight, 80);
    const plotHeight = innerH;
    const { uMin, uMax, vMin, vMax } = slice.bounds;
    const du = Math.max(uMax - uMin, 1e-18);
    const dv = Math.max(vMax - vMin, 1e-18);
    const scale = Math.min(plotWidth / du, plotHeight / dv);
    const ox = margin.left + (plotWidth - du * scale) * 0.5;
    const oy = margin.top + (plotHeight - dv * scale) * 0.5;
    frameRef.current = {
      width,
      height,
      margin,
      plotRect: { x: margin.left, y: margin.top, width: plotWidth, height: plotHeight },
      colorbarRect: meshData.fieldData
        ? { x: margin.left + plotWidth + colorbarGap, y: margin.top + 18, width: colorbarW, height: Math.max(plotHeight - 34, 120) }
        : null,
      plotWidth,
      plotHeight,
      scale,
      ox,
      oy,
      bounds: slice.bounds,
    };

    const map = ([u, v]: Point2): Point2 => [
      ox + (u - uMin) * scale,
      oy + plotHeight - (v - vMin) * scale,
    ];

    const headerPanelHeight = compactWidth ? 36 : 44;
    ctx.fillStyle = PANEL;
    ctx.fillRect(12, 12, width - 24, headerPanelHeight);
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(12.5, 12.5, width - 25, headerPanelHeight - 1);

    ctx.fillStyle = "rgba(17, 17, 27, 0.7)";
    ctx.fillRect(margin.left, margin.top, plotWidth, plotHeight);

    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.strokeRect(margin.left, margin.top, plotWidth, plotHeight);

    const xTicks = buildNiceTicks(uMin, uMax, tightWidth ? 4 : compactWidth ? 5 : 6);
    const yTicks = buildNiceTicks(vMin, vMax, compactHeight ? 4 : compactWidth ? 5 : 6);
    const xMajorTickEvery = Math.max(1, Math.floor(xTicks.length / 4));
    const yMajorTickEvery = Math.max(1, Math.floor(yTicks.length / 4));

    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    xTicks.forEach((tick, index) => {
      const x = ox + (tick - uMin) * scale;
      ctx.strokeStyle = index % xMajorTickEvery === 0 ? "rgba(108, 112, 134, 0.08)" : GRID;
      ctx.beginPath();
      ctx.moveTo(x, margin.top);
      ctx.lineTo(x, margin.top + plotHeight);
      ctx.stroke();
    });
    yTicks.forEach((tick, index) => {
      const y = oy + plotHeight - (tick - vMin) * scale;
      ctx.strokeStyle = index % yMajorTickEvery === 0 ? "rgba(108, 112, 134, 0.08)" : GRID;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(margin.left + plotWidth, y);
      ctx.stroke();
    });

    if (slice.segments.length === 0 && slice.polygons.length === 0) {
      ctx.fillStyle = EMPTY;
      ctx.font = "600 14px IBM Plex Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No mesh intersection for this plane", width / 2, height / 2 - 8);
      ctx.fillStyle = TEXT;
      ctx.font = "12px IBM Plex Sans, sans-serif";
      ctx.fillText(
        `${slice.normalLabel} = ${slice.planeCoord.toExponential(3)} m`,
        width / 2,
        height / 2 + 18,
      );
    } else {
      const { min, max } = colorScale;
      const hasField = !!meshData.fieldData;

      // Draw volume polygons
      for (const poly of slice.polygons) {
        if (poly.points.length < 3) continue;
        ctx.fillStyle = hasField
          ? colorForValue(poly.value, min, max, quantityId)
          : colorForDomain(poly.partId);
        ctx.beginPath();
        const first = map(poly.points[0]);
        ctx.moveTo(first[0], first[1]);
        for (let i = 1; i < poly.points.length; i++) {
          const pt = map(poly.points[i]);
          ctx.lineTo(pt[0], pt[1]);
        }
        ctx.closePath();
        ctx.fill();

        // Element boundaries — prominent when no field, subtle with field data
        ctx.strokeStyle = hasField ? "rgba(0, 0, 0, 0.2)" : "rgba(166, 173, 200, 0.55)";
        ctx.lineWidth = hasField ? 0.5 : 1;
        ctx.stroke();
      }

      // Draw surface segments
      for (const segment of slice.segments) {
        const [x1, y1] = map(segment.a);
        const [x2, y2] = map(segment.b);
        if (hasField) {
          const gradient = ctx.createLinearGradient(x1, y1, x2, y2);
          gradient.addColorStop(0, colorForValue(segment.va, min, max, quantityId));
          gradient.addColorStop(1, colorForValue(segment.vb, min, max, quantityId));
          ctx.strokeStyle = gradient;
        } else {
          ctx.strokeStyle = "rgba(166, 173, 200, 0.7)";
        }
        ctx.lineWidth = 2.35;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }

      for (const rect of antennaRects) {
        const [ax1, ay1] = map([rect.bounds.uMin, rect.bounds.vMin]);
        const [ax2, ay2] = map([rect.bounds.uMax, rect.bounds.vMax]);
        const x = Math.min(ax1, ax2);
        const y = Math.min(ay1, ay2);
        const width = Math.max(Math.abs(ax2 - ax1), 1);
        const height = Math.max(Math.abs(ay2 - ay1), 1);
        const colors = antennaRectColors(rect.role, rect.selected);
        ctx.fillStyle = colors.fill;
        ctx.strokeStyle = colors.stroke;
        ctx.lineWidth = rect.selected ? 2.4 : 1.5;
        ctx.fillRect(x, y, width, height);
        ctx.strokeRect(x, y, width, height);
      }
    }

    ctx.fillStyle = TEXT;
    ctx.font = tightWidth ? "10px IBM Plex Mono, monospace" : "11px IBM Plex Mono, monospace";
    ctx.textAlign = "center";
    xTicks.forEach((tick, index) => {
      if (index % xMajorTickEvery !== 0 && index !== xTicks.length - 1 && index !== 0) {
        return;
      }
      const x = ox + (tick - uMin) * scale;
      ctx.strokeStyle = TEXT;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, margin.top + plotHeight);
      ctx.lineTo(x, margin.top + plotHeight + 6);
      ctx.stroke();
      ctx.fillText(formatMetricLength(tick), x, margin.top + plotHeight + (compactWidth ? 16 : 20));
    });
    ctx.textAlign = "right";
    yTicks.forEach((tick, index) => {
      if (index % yMajorTickEvery !== 0 && index !== yTicks.length - 1 && index !== 0) {
        return;
      }
      const y = oy + plotHeight - (tick - vMin) * scale;
      ctx.beginPath();
      ctx.moveTo(margin.left - 6, y);
      ctx.lineTo(margin.left, y);
      ctx.stroke();
      ctx.fillText(formatMetricLength(tick), margin.left - (compactWidth ? 8 : 10), y + 4);
    });

    ctx.fillStyle = TEXT;
    ctx.font = compactWidth ? "11px IBM Plex Sans, sans-serif" : "12px IBM Plex Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${slice.uLabel} axis`, margin.left + plotWidth * 0.5, height - (compactWidth ? 14 : 18));
    ctx.save();
    ctx.translate(tightWidth ? 16 : 24, margin.top + plotHeight / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.fillText(`${slice.vLabel} axis`, 0, 0);
    ctx.restore();

    const elementCount = slice.segments.length + slice.polygons.length;
    const plotFieldLabel = meshData.fieldData
      ? `${quantityLabel}.${component}`
      : "mesh";
    ctx.fillStyle = TEXT_STRONG;
    ctx.font = compactWidth ? "600 11px IBM Plex Mono, monospace" : "600 13px IBM Plex Mono, monospace";
    ctx.textAlign = "left";
    ctx.fillText(canvasTruncate(ctx, plotFieldLabel, width - 100), 24, compactWidth ? 26 : 30);
    ctx.fillStyle = TEXT;
    ctx.font = compactWidth ? "10px IBM Plex Mono, monospace" : "11px IBM Plex Mono, monospace";
    ctx.fillText(canvasTruncate(ctx, `plane ${slice.normalLabel} = ${formatMetricLength(slice.planeCoord)}`, width - 100), 24, compactWidth ? 40 : 46);
    if (!tightWidth) {
      ctx.fillText(`${objectViewMode} view`, compactWidth ? 220 : 308, compactWidth ? 40 : 46);
    }

    ctx.fillStyle = TEXT_STRONG;
    ctx.font = compactWidth ? "600 10px IBM Plex Mono, monospace" : "600 12px IBM Plex Mono, monospace";
    ctx.textAlign = "right";
    ctx.fillText(tightWidth ? `${elementCount} el.` : `${elementCount} elements`, width - 16, compactWidth ? 24 : 18);

    if (showColorbarPanel && frameRef.current.colorbarRect) {
      const { x: colorbarX, y: colorbarY, width: colorbarWidth, height: colorbarH } = frameRef.current.colorbarRect;
      ctx.fillStyle = PANEL_SOFT;
      ctx.fillRect(colorbarX - 12, colorbarY - 24, colorbarWidth + (compactWidth ? 62 : 78), colorbarH + 36);
      ctx.strokeStyle = BORDER;
      ctx.lineWidth = 1;
      ctx.strokeRect(colorbarX - 11.5, colorbarY - 23.5, colorbarWidth + (compactWidth ? 61 : 77), colorbarH + 35);
      const gradient = ctx.createLinearGradient(0, colorbarY + colorbarH, 0, colorbarY);
      const palette =
        colorScale.mode === "diverging"
          ? DIVERGING
          : colorScale.mode === "negative"
            ? NEGATIVE
            : POSITIVE;
      palette.forEach((stop, index) => {
        gradient.addColorStop(index / Math.max(palette.length - 1, 1), stop);
      });
      ctx.fillStyle = gradient;
      ctx.fillRect(colorbarX, colorbarY, colorbarWidth, colorbarH);
      ctx.strokeStyle = ACCENT_LINE;
      ctx.strokeRect(colorbarX, colorbarY, colorbarWidth, colorbarH);
      ctx.fillStyle = TEXT;
      ctx.font = compactWidth ? "10px IBM Plex Mono, monospace" : "11px IBM Plex Mono, monospace";
      ctx.textAlign = "left";
      ctx.fillText(canvasTruncate(ctx, quantityLabel, colorbarWidth + (compactWidth ? 50 : 66)), colorbarX - 2, colorbarY - 10);
      const colorTicks = buildNiceTicks(colorScale.min, colorScale.max, compactHeight ? 4 : 5);
      for (const tick of colorTicks) {
        const ratio =
          colorScale.max > colorScale.min
            ? (tick - colorScale.min) / (colorScale.max - colorScale.min)
            : 0.5;
        const y = colorbarY + colorbarH - ratio * colorbarH;
        ctx.beginPath();
        ctx.moveTo(colorbarX + colorbarWidth, y);
        ctx.lineTo(colorbarX + colorbarWidth + (compactWidth ? 4 : 6), y);
        ctx.stroke();
        ctx.fillText(formatProbeValue(tick), colorbarX + colorbarWidth + (compactWidth ? 8 : 10), y + 4);
      }
    } else {
      ctx.fillStyle = TEXT;
      ctx.font = compactWidth ? "10px IBM Plex Mono, monospace" : "11px IBM Plex Mono, monospace";
      ctx.textAlign = "right";
      ctx.fillText("Domain-colored slice", width - 16, margin.top - 12);
    }

    const scaleTargetPx = 96;
    const niceUnits = [1, 2, 5];
    const worldPerPx = Math.max(du / Math.max(plotWidth, 1), 1e-18);
    const rawBarWorld = worldPerPx * scaleTargetPx;
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawBarWorld)));
    const scaleWorld =
      niceUnits
        .map((unit) => unit * magnitude)
        .find((candidate) => candidate >= rawBarWorld) ?? magnitude * 10;
    const scalePx = scaleWorld / worldPerPx;
    const scaleX = margin.left + 18;
    const scaleY = height - (compactWidth ? 22 : 26);
    ctx.fillStyle = PANEL_SOFT;
    ctx.fillRect(scaleX - 12, scaleY - 22, scalePx + 24, 30);
    ctx.strokeStyle = TEXT_STRONG;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(scaleX, scaleY);
    ctx.lineTo(scaleX + scalePx, scaleY);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(scaleX, scaleY - 5);
    ctx.lineTo(scaleX, scaleY + 5);
    ctx.moveTo(scaleX + scalePx, scaleY - 5);
    ctx.lineTo(scaleX + scalePx, scaleY + 5);
    ctx.stroke();
    ctx.fillStyle = TEXT;
    ctx.font = compactWidth ? "10px IBM Plex Mono, monospace" : "11px IBM Plex Mono, monospace";
    ctx.textAlign = "center";
    ctx.fillText(formatMetricLength(scaleWorld), scaleX + scalePx * 0.5, scaleY - 8);
  }, [
    antennaRects,
    canvasSize,
    component,
    colorScale,
    controlsVisible,
    effectivePlane,
    meshData.fieldData,
    quantityId,
    quantityLabel,
    slice,
  ]);

  const updateProbeFromPointer = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    const frame = frameRef.current;
    if (!canvas || !frame) {
      setHoverProbe(null);
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const canvasX = event.clientX - rect.left;
    const canvasY = event.clientY - rect.top;
    const probe = sampleSliceProbe(slice, frame, canvasX, canvasY);
    setHoverProbe(probe);
    return probe;
  }, [slice]);

  return (
    <div className="relative h-full min-h-[360px] w-full overflow-hidden rounded-[8px] bg-[#1e1e2e]">
      <canvas
        ref={canvasRef}
        className="block h-full w-full"
        onMouseMove={(event) => {
          updateProbeFromPointer(event);
        }}
        onMouseLeave={() => setHoverProbe(null)}
        onClick={(event) => {
          const probe = updateProbeFromPointer(event);
          setPinnedProbe(probe);
        }}
      />
      <ViewportOverlayLayout>
        {(hoverProbe || pinnedProbe) && (
          <ViewportOverlayLayout.TopRight>
            <div className="min-w-[190px] rounded-xl border border-border/30 bg-background/78 px-3 py-2 text-[0.68rem] font-mono text-slate-200 shadow-lg backdrop-blur-md pointer-events-auto">
              <div className="mb-1 flex items-center justify-between text-[0.58rem] font-semibold uppercase tracking-[0.14em] text-slate-400">
                <span>Probe</span>
                {pinnedProbe && (
                  <span className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-2 py-0.5 text-cyan-100">
                    pinned
                  </span>
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

        {(onPlaneChange || onClipPosChange) && (
          <ViewportOverlayLayout.BottomCenter>
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/40 bg-card/60 backdrop-blur-md px-4 py-2 shadow-sm pointer-events-auto">
              {onPlaneChange && (
                <div className="flex items-center gap-2">
                  <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground">Plane</span>
                  <div className="flex rounded-md border border-border/50 bg-background/50 overflow-hidden">
                    {(["xy", "xz", "yz"] as const).map((p) => (
                      <button
                        key={p}
                        className={`px-2 py-1 text-xs font-mono transition-colors ${effectivePlane === p ? "bg-primary/20 text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                        onClick={() => {
                          onPlaneChange(p);
                          onClipAxisChange?.(planeToClipAxis(p));
                        }}
                      >
                        {p.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {onClipPosChange && (
                <div className="flex items-center gap-3">
                  <span className="text-[0.65rem] font-semibold uppercase tracking-wider text-muted-foreground w-24 text-right">
                    {slice.normalLabel} {slice.planeCoord.toExponential(2)} m
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={0.1}
                    value={clipPos}
                    onChange={(e) => onClipPosChange(Number(e.target.value))}
                    className="w-40 h-[3px] accent-primary"
                  />
                </div>
              )}
            </div>
          </ViewportOverlayLayout.BottomCenter>
        )}
      </ViewportOverlayLayout>
    </div>
  );
}
