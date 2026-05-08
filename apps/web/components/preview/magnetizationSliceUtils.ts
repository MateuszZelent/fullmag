/**
 * Pure utility functions for MagnetizationSlice2D, extracted into a .ts file
 * so they can be imported by tests without triggering JSX parse issues.
 */

import type { FieldSliceBounds } from "@/src/api/types";
import type { SliceArrowData } from "@/src/hooks/resources/useFieldSlice2D";
import { magnetizationHslColor } from "./magnetizationColor";
import { divergingColor, magnitudeColor } from "./r3f/colorUtils";
import { ECHARTS_THEME } from "../../lib/echartsTheme";
import * as THREE from "three";

type SlicePlane = "xy" | "xz" | "yz";
type VectorComponent = "x" | "y" | "z" | "magnitude";
type FemArrowColorMode = "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";
export interface VectorGlyph2D {
  origin: [number, number];
  delta: [number, number];
  magnitude: number;
  vector: [number, number];
}

export interface StyledVectorGlyph2D extends VectorGlyph2D {
  stroke: string;
}

interface Slice2DColorScale {
  min: number;
  max: number;
  palette: readonly string[];
}

function colorToCss(color: THREE.Color): string {
  return `#${color.getHexString()}`;
}

function formatMagnitude(value: number): string {
  if (!Number.isFinite(value)) return "NaN";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1000 || abs < 1e-2) return value.toExponential(2);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toPrecision(2);
}

function planeVectorToCartesian(
  plane: SlicePlane,
  vector: [number, number],
): { x: number; y: number; z: number } {
  if (plane === "xy") {
    return { x: vector[0], y: vector[1], z: 0 };
  }
  if (plane === "xz") {
    return { x: vector[0], y: 0, z: vector[1] };
  }
  return { x: 0, y: vector[0], z: vector[1] };
}

export function is2DVectorColorModeSupported(
  plane: SlicePlane,
  colorMode: FemArrowColorMode,
): boolean {
  if (
    colorMode === "orientation" ||
    colorMode === "magnitude" ||
    colorMode === "monochrome"
  ) {
    return true;
  }
  if (plane === "xy") {
    return colorMode === "x" || colorMode === "y";
  }
  if (plane === "xz") {
    return colorMode === "x" || colorMode === "z";
  }
  return colorMode === "y" || colorMode === "z";
}

export function resolveEffective2DVectorColorMode(
  plane: SlicePlane,
  colorMode: FemArrowColorMode,
): FemArrowColorMode {
  return is2DVectorColorModeSupported(plane, colorMode) ? colorMode : "orientation";
}

export function styleSliceVectorGlyphs(args: {
  glyphs: VectorGlyph2D[];
  plane: SlicePlane;
  colorMode: FemArrowColorMode;
  monoColor: string;
}): StyledVectorGlyph2D[] {
  if (args.glyphs.length === 0) {
    return [];
  }

  const effectiveColorMode = resolveEffective2DVectorColorMode(args.plane, args.colorMode);
  if (effectiveColorMode === "monochrome") {
    return args.glyphs.map((glyph) => ({
      ...glyph,
      stroke: args.monoColor,
    }));
  }

  let maxAbsX = 0;
  let maxAbsY = 0;
  let maxAbsZ = 0;
  let maxMagnitude = 0;
  const cartesianVectors = args.glyphs.map((glyph) => {
    const cartesian = planeVectorToCartesian(args.plane, glyph.vector);
    maxAbsX = Math.max(maxAbsX, Math.abs(cartesian.x));
    maxAbsY = Math.max(maxAbsY, Math.abs(cartesian.y));
    maxAbsZ = Math.max(maxAbsZ, Math.abs(cartesian.z));
    maxMagnitude = Math.max(maxMagnitude, glyph.magnitude);
    return cartesian;
  });
  const safeScaleX = Math.max(maxAbsX, 1e-12);
  const safeScaleY = Math.max(maxAbsY, 1e-12);
  const safeScaleZ = Math.max(maxAbsZ, 1e-12);
  const safeScaleMagnitude = Math.max(maxMagnitude, 1e-12);

  return args.glyphs.map((glyph, index) => {
    const color = new THREE.Color();
    const cartesian = cartesianVectors[index]!;
    switch (effectiveColorMode) {
      case "orientation":
        color.copy(magnetizationHslColor(cartesian.x, cartesian.y, cartesian.z));
        break;
      case "x":
        divergingColor(cartesian.x / safeScaleX, color);
        break;
      case "y":
        divergingColor(cartesian.y / safeScaleY, color);
        break;
      case "z":
        divergingColor(cartesian.z / safeScaleZ, color);
        break;
      case "magnitude":
        magnitudeColor(glyph.magnitude / safeScaleMagnitude, color);
        break;
    }
    return {
      ...glyph,
      stroke: colorToCss(color),
    };
  });
}

export function resolveSlicePlaneAxes(plane: SlicePlane): { u: "x" | "y"; v: "y" | "z" } | { u: "x" | "y"; v: "z" } {
  if (plane === "xy") return { u: "x", v: "y" };
  if (plane === "xz") return { u: "x", v: "z" };
  return { u: "y", v: "z" };
}

export function buildSlice2DChartTopologyKey(
  plane: SlicePlane,
  xLen: number,
  yLen: number,
  meshSegmentCount = 0,
  vectorGlyphCount = 0,
): string {
  return `${plane}:${xLen}:${yLen}:mesh:${meshSegmentCount}:vectors:${vectorGlyphCount}`;
}

export function resolveHeatmapTooltipValue(params: unknown): [number, number, number] | null {
  const source = Array.isArray(params) ? params[0] : params;
  if (!source || typeof source !== "object") return null;
  const value = (source as { value?: unknown }).value;
  if (!Array.isArray(value) || value.length < 3) return null;
  const x = Number(value[0]);
  const y = Number(value[1]);
  const sample = Number(value[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(sample)) return null;
  return [x, y, sample];
}

export function rasterToHeatmapPoints(args: {
  values: Float64Array;
  xLen: number;
  yLen: number;
  bounds?: FieldSliceBounds | null;
}): [number, number, number][] {
  const count = Math.min(args.values.length, args.xLen * args.yLen);
  const points: [number, number, number][] = [];
  if (args.bounds) {
    const du = (args.bounds.u_max - args.bounds.u_min) / Math.max(1, args.xLen);
    const dv = (args.bounds.v_max - args.bounds.v_min) / Math.max(1, args.yLen);
    for (let idx = 0; idx < count; idx++) {
      const ix = idx % args.xLen;
      const iy = Math.floor(idx / args.xLen);
      const value = args.values[idx];
      if (!Number.isFinite(value)) continue;
      points.push([
        args.bounds.u_min + (ix + 0.5) * du,
        args.bounds.v_min + (iy + 0.5) * dv,
        value,
      ]);
    }
    return points;
  }
  for (let idx = 0; idx < count; idx++) {
    const value = args.values[idx];
    if (!Number.isFinite(value)) continue;
    points.push([idx % args.xLen, Math.floor(idx / args.xLen), value]);
  }
  return points;
}

export function buildColorbarLabel(args: {
  quantityLabel: string;
  component: VectorComponent;
  quantityUnit?: string | null;
  quantityComponentCount?: number | null;
}): string {
  const suffix = args.quantityUnit ? ` [${args.quantityUnit}]` : "";
  if ((args.quantityComponentCount ?? null) === 1) {
    return `${args.quantityLabel}${suffix}`;
  }
  return `${args.quantityLabel}.${args.component}${suffix}`;
}

export function buildSlice2DChartOption(args: {
  data: [number, number, number][];
  xLen: number;
  yLen: number;
  scale: Slice2DColorScale;
  quantityLabel: string;
  quantityUnit?: string | null;
  quantityComponentCount?: number | null;
  component: VectorComponent;
  plane: SlicePlane;
  bounds?: FieldSliceBounds | null;
  showQuantity: boolean;
  meshOverlay?: { segments: Array<{ a: [number, number]; b: [number, number] }> } | null;
  vectorGlyphs?: StyledVectorGlyph2D[];
}): Record<string, unknown> {
  const THEME = ECHARTS_THEME;
  const planeAxes = resolveSlicePlaneAxes(args.plane);
  const colorbarLabel = buildColorbarLabel({
    quantityLabel: args.quantityLabel,
    component: args.component,
    quantityUnit: args.quantityUnit,
    quantityComponentCount: args.quantityComponentCount,
  });
  const hasWorldBounds = Boolean(args.bounds);
  const xCategories = Array.from({ length: args.xLen }, (_, i) => i);
  const yCategories = Array.from({ length: args.yLen }, (_, i) => i);
  const xAxis = hasWorldBounds
    ? {
        type: "value" as const,
        min: args.bounds?.u_min,
        max: args.bounds?.u_max,
        name: `${planeAxes.u} [m]`,
        nameLocation: "middle" as const,
        nameGap: 30,
        nameTextStyle: { color: THEME.text2, fontWeight: 600 },
        axisLine: { show: true, lineStyle: { color: THEME.border } },
        axisPointer: {
          show: true,
          label: {
            show: true,
            backgroundColor: THEME.tooltipBg,
            color: THEME.tooltipText,
            padding: [6, 8],
            borderColor: THEME.accent,
            borderWidth: 1,
            formatter: ({ value }: { value: number }) => `${formatMagnitude(value)} m`,
          },
          lineStyle: { color: THEME.accent, width: 1.5, type: "dashed" as const },
        },
        axisTick: { length: 6, lineStyle: { type: "solid" as const, color: THEME.border } },
        axisLabel: {
          show: true,
          color: THEME.text2,
          formatter: (value: number) => formatMagnitude(value),
        },
        splitLine: { show: false },
      }
    : {
        type: "category" as const,
        data: xCategories,
        name: `${planeAxes.u} (cell)`,
        nameLocation: "middle" as const,
        nameGap: 30,
        nameTextStyle: { color: THEME.text2, fontWeight: 600 },
        axisLine: { show: true, lineStyle: { color: THEME.border } },
        axisPointer: {
          show: true,
          label: {
            show: true,
            backgroundColor: THEME.tooltipBg,
            color: THEME.tooltipText,
            padding: [6, 8],
            borderColor: THEME.accent,
            borderWidth: 1,
          },
          lineStyle: { color: THEME.accent, width: 1.5, type: "dashed" as const },
        },
        axisTick: { length: 6, lineStyle: { type: "solid" as const, color: THEME.border } },
        axisLabel: { show: false },
        splitLine: { show: false },
      };
  const yAxis = hasWorldBounds
    ? {
        type: "value" as const,
        min: args.bounds?.v_min,
        max: args.bounds?.v_max,
        name: `${planeAxes.v} [m]`,
        nameLocation: "middle" as const,
        nameGap: 44,
        nameTextStyle: { color: THEME.text2, fontWeight: 600 },
        axisLine: { show: true, lineStyle: { color: THEME.border } },
        axisPointer: {
          show: true,
          label: {
            show: true,
            backgroundColor: THEME.tooltipBg,
            color: THEME.tooltipText,
            padding: [6, 8],
            borderColor: THEME.accent,
            borderWidth: 1,
            formatter: ({ value }: { value: number }) => `${formatMagnitude(value)} m`,
          },
          lineStyle: { color: THEME.accent, width: 1.5, type: "dashed" as const },
        },
        axisTick: { length: 6, lineStyle: { type: "solid" as const, color: THEME.border } },
        axisLabel: {
          show: true,
          color: THEME.text2,
          formatter: (value: number) => formatMagnitude(value),
        },
        splitLine: { show: false },
      }
    : {
        type: "category" as const,
        data: yCategories,
        name: `${planeAxes.v} (cell)`,
        nameLocation: "middle" as const,
        nameGap: 44,
        nameTextStyle: { color: THEME.text2, fontWeight: 600 },
        axisLine: { show: true, lineStyle: { color: THEME.border } },
        axisPointer: {
          show: true,
          label: {
            show: true,
            backgroundColor: THEME.tooltipBg,
            color: THEME.tooltipText,
            padding: [6, 8],
            borderColor: THEME.accent,
            borderWidth: 1,
          },
          lineStyle: { color: THEME.accent, width: 1.5, type: "dashed" as const },
        },
        axisTick: { length: 6, lineStyle: { type: "solid" as const, color: THEME.border } },
        axisLabel: { show: false },
        splitLine: { show: false },
      };
  const meshSegments = args.meshOverlay?.segments ?? [];
  const vectorGlyphs = args.vectorGlyphs ?? [];
  const series: Array<Record<string, unknown>> = [
    {
      id: "slice-heatmap",
      name: args.quantityLabel,
      type: "heatmap",
      selectedMode: false,
      emphasis: { disabled: true },
      progressive: 0,
      progressiveThreshold: Number.MAX_SAFE_INTEGER,
      animation: false,
      data: args.showQuantity ? args.data : [],
    },
  ];
  if (meshSegments.length > 0) {
    series.push({
      id: "slice-mesh-overlay",
      type: "custom",
      coordinateSystem: "cartesian2d",
      silent: true,
      z: 20,
      data: meshSegments.map((_, index) => [index]),
      renderItem: (_params: unknown, api: { value: (index: number) => unknown; coord: (point: [number, number]) => [number, number] }) => {
        const segmentIndex = api.value(0) as number;
        const segment = meshSegments[segmentIndex];
        if (!segment) {
          return null;
        }
        const a = api.coord(segment.a);
        const b = api.coord(segment.b);
        return {
          type: "line",
          shape: {
            x1: a[0],
            y1: a[1],
            x2: b[0],
            y2: b[1],
          },
          style: {
            stroke: THEME.border,
            lineWidth: 0.9,
            opacity: 0.88,
          },
        };
      },
    });
  }
  if (vectorGlyphs.length > 0) {
    series.push({
      id: "slice-vector-glyphs",
      type: "custom",
      coordinateSystem: "cartesian2d",
      silent: true,
      z: 30,
      data: vectorGlyphs.map((_, index) => [index]),
      renderItem: (_params: unknown, api: { value: (index: number) => unknown; coord: (point: [number, number]) => [number, number] }) => {
        const glyphIndex = api.value(0) as number;
        const glyph = vectorGlyphs[glyphIndex];
        if (!glyph) {
          return null;
        }
        const start = api.coord(glyph.origin);
        const end = api.coord([
          glyph.origin[0] + glyph.delta[0],
          glyph.origin[1] + glyph.delta[1],
        ]);
        const dx = end[0] - start[0];
        const dy = end[1] - start[1];
        const length = Math.hypot(dx, dy);
        if (length < 1e-6) {
          return null;
        }
        const headLength = Math.min(8, Math.max(4, length * 0.3));
        const angle = Math.atan2(dy, dx);
        const left = [
          end[0] - headLength * Math.cos(angle - Math.PI / 6),
          end[1] - headLength * Math.sin(angle - Math.PI / 6),
        ] as const;
        const right = [
          end[0] - headLength * Math.cos(angle + Math.PI / 6),
          end[1] - headLength * Math.sin(angle + Math.PI / 6),
        ] as const;
        return {
          type: "group",
          children: [
            {
              type: "line",
              shape: { x1: start[0], y1: start[1], x2: end[0], y2: end[1] },
              style: { stroke: glyph.stroke, lineWidth: 1.2, opacity: 0.92 },
            },
            {
              type: "line",
              shape: { x1: end[0], y1: end[1], x2: left[0], y2: left[1] },
              style: { stroke: glyph.stroke, lineWidth: 1.2, opacity: 0.92 },
            },
            {
              type: "line",
              shape: { x1: end[0], y1: end[1], x2: right[0], y2: right[1] },
              style: { stroke: glyph.stroke, lineWidth: 1.2, opacity: 0.92 },
            },
          ],
        };
      },
    });
  }

  return {
    animation: false,
    animationDurationUpdate: 0,
    tooltip: {
      position: "top",
      confine: true,
      formatter: (params: unknown) => {
        const v = resolveHeatmapTooltipValue(params);
        if (!v) {
          return `<strong>${colorbarLabel}</strong><br/>No sample`;
        }
        return [
          `<strong>${colorbarLabel}</strong>`,
          `${planeAxes.u}: ${formatMagnitude(v[0])}${hasWorldBounds ? " m" : ""}`,
          `${planeAxes.v}: ${formatMagnitude(v[1])}${hasWorldBounds ? " m" : ""}`,
          `value: ${formatMagnitude(v[2])}${args.quantityUnit ? ` ${args.quantityUnit}` : ""}`,
        ].join("<br/>");
      },
      backgroundColor: THEME.tooltipBg,
      borderColor: THEME.tooltipBorder,
      borderWidth: 1,
      padding: [10, 12],
      textStyle: { color: THEME.tooltipText, fontSize: 12 },
    },
    xAxis,
    yAxis,
    visualMap: [
      {
        type: "continuous",
        min: args.scale.min,
        max: args.scale.max,
        calculable: false,
        realtime: false,
        precision: 3,
        orient: "vertical",
        right: 8,
        top: "middle",
        itemWidth: 12,
        itemHeight: 188,
        align: "right",
        padding: [12, 10, 12, 10],
        backgroundColor: "rgba(15, 23, 42, 0.76)",
        borderColor: THEME.border,
        borderWidth: 1,
        text: [formatMagnitude(args.scale.max), formatMagnitude(args.scale.min)],
        textStyle: { color: THEME.text2, fontSize: 11, fontWeight: 600 },
        show: args.showQuantity,
        formatter: (value: number) =>
          `${formatMagnitude(value)}${args.quantityUnit ? ` ${args.quantityUnit}` : ""}`,
        inRange: { color: args.scale.palette },
        outOfRange: { color: ["rgba(107, 122, 154, 0.18)"] },
        seriesIndex: 0,
        showLabel: true,
      },
    ],
    graphic: [
      {
        type: "text",
        right: 8,
        top: 68,
        invisible: !args.showQuantity,
        style: {
          text: colorbarLabel,
          fill: THEME.text2,
          fontSize: 11,
          fontWeight: 600,
        },
      },
    ],
    series,
    grid: {
      containLabel: true,
      left: 58,
      right: 92,
      top: 42,
      bottom: 52,
    },
    toolbox: {
      show: true,
      top: 10,
      right: 10,
      itemSize: 20,
      itemGap: 12,
      iconStyle: { borderColor: THEME.toolboxIcon, borderWidth: 1.15 },
      emphasis: { iconStyle: { borderColor: THEME.text1 } },
      feature: {
        dataZoom: {
          xAxisIndex: 0,
          yAxisIndex: 0,
          brushStyle: {
            color: THEME.brushBg,
            borderColor: THEME.brushBorder,
            borderWidth: 2,
          },
        },
        dataView: { show: false },
        restore: { show: true },
        saveAsImage: { type: "png", name: "preview" },
      },
    },
  };
}

export function reconstructSliceArrowGlyphs(args: {
  arrows: SliceArrowData | null;
  scalarValues: Float64Array | null;
  xLen: number;
  yLen: number;
  bounds?: FieldSliceBounds | null;
  arrowEvery?: number | null;
}): VectorGlyph2D[] {
  if (!args.arrows || args.arrows.arrowCount <= 0 || args.xLen <= 0 || args.yLen <= 0) {
    return [];
  }

  const arrowEvery = Math.max(1, Math.round(args.arrowEvery ?? 1));
  const du = args.bounds
    ? (args.bounds.u_max - args.bounds.u_min) / Math.max(1, args.xLen)
    : 1;
  const dv = args.bounds
    ? (args.bounds.v_max - args.bounds.v_min) / Math.max(1, args.yLen)
    : 1;
  const cellSpan = 0.45 * Math.min(Math.abs(du), Math.abs(dv)) * arrowEvery;
  const candidates: Array<{ origin: [number, number]; vector: [number, number] }> = [];
  let cursor = 0;

  for (let py = 0; py < args.yLen; py += arrowEvery) {
    for (let px = 0; px < args.xLen; px += arrowEvery) {
      if (cursor >= args.arrows.arrowCount) {
        break;
      }
      const pixel = py * args.xLen + px;
      const sample = args.scalarValues?.[pixel];
      if (args.scalarValues && !Number.isFinite(sample)) {
        continue;
      }
      const base = cursor * 2;
      const u = args.arrows.values[base];
      const v = args.arrows.values[base + 1];
      cursor += 1;
      if (!Number.isFinite(u) || !Number.isFinite(v)) {
        continue;
      }
      const origin: [number, number] = args.bounds
        ? [
          args.bounds.u_min + (px + 0.5) * du,
          args.bounds.v_min + (py + 0.5) * dv,
        ]
        : [px, py];
      candidates.push({ origin, vector: [u, v] });
    }
    if (cursor >= args.arrows.arrowCount) {
      break;
    }
  }

  const maxMagnitude = candidates.reduce(
    (current, glyph) => Math.max(current, Math.hypot(glyph.vector[0], glyph.vector[1])),
    0,
  );
  if (maxMagnitude <= 0) {
    return candidates.map((glyph) => ({
      origin: glyph.origin,
      delta: [0, 0],
      magnitude: 0,
      vector: glyph.vector,
    }));
  }

  return candidates.map((glyph) => {
    const magnitude = Math.hypot(glyph.vector[0], glyph.vector[1]);
    const scale = (magnitude / maxMagnitude) * cellSpan;
    const safeMagnitude = magnitude || 1;
    return {
      origin: glyph.origin,
      delta: [
        (glyph.vector[0] / safeMagnitude) * scale,
        (glyph.vector[1] / safeMagnitude) * scale,
      ],
      magnitude,
      vector: glyph.vector,
    };
  });
}
