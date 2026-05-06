"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as echarts from "echarts";
import type { FemMeshData, FemVectorDomainFilter, RenderMode } from "./fem/femMeshTypes";
import type { AntennaOverlay, ObjectViewMode } from "../runs/control-room/shared";
import type { FemMeshPart, MeshEntityViewStateMap } from "../../lib/session/types";
import {
  buildSliceVisibilityState,
  clipAxisToPlane,
  normalizedClipToWorld,
} from "./fem/femSliceUtils";
import {
  axisIndices,
  computeProjectionSlice,
  type ProjectionResult,
  type ProjectionReduction,
  type SlicePlane,
  type VectorComponent,
} from "./fem/femSliceGeometry";
import { PREVIEW_MAX_POINTS_DEFAULT } from "./fem/vectorDensityBudget";
import {
  paletteForMode,
  smartAutoScale,
  interpolatePalette,
} from "./fem/femSliceColorScale";
import { useFemSliceSampling } from "./fem/useFemSliceSampling";
import {
  projectionCacheKey,
  readProjectionCache,
  writeProjectionCache,
} from "./fem/femSliceCache";
import { ECHARTS_THEME } from "../../lib/echartsTheme";

// ── Types ────────────────────────────────────────────────────────

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
  /** Slice toolbar mode — "all_layers" triggers Z-projection averaging. */
  sliceMode?: "single" | "slab" | "all_layers";
  projectionReduction?: ProjectionReduction;
  projectionIncludeAirAsZero?: boolean;
  projectionSamples?: number;
  projectionResolution?: number;
  onQuantityChange?: (quantityId: string) => void;
  onComponentChange?: (component: VectorComponent) => void;
  onPlaneChange?: (plane: SlicePlane) => void;
  onClipAxisChange?: (axis: "x" | "y" | "z") => void;
  onClipPosChange?: (value: number) => void;
  onShowArrowsChange?: (value: boolean) => void;
  onPreviewMaxPointsChange?: (value: number) => void;
}

// ── Constants ────────────────────────────────────────────────────

const THEME = ECHARTS_THEME;
const BG = "#1e1e2e";
const PROJECTION_MAX_ELEMENTS = 150_000;

function formatMagnitude(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e3 || (abs > 0 && abs < 1e-2)) return v.toExponential(2);
  return v.toPrecision(4);
}

function projectionTitle(reduction: ProjectionReduction): string {
  if (reduction === "sum") return "sum";
  if (reduction === "thickness_integral") return "thickness integral";
  if (reduction === "area_weighted_mean") return "area-weighted mean";
  if (reduction === "min") return "min";
  if (reduction === "max") return "max";
  if (reduction === "rms") return "RMS";
  if (reduction === "stddev") return "std dev";
  if (reduction === "abs_max") return "absolute max";
  return "occupied mean";
}

// ── Component ────────────────────────────────────────────────────

export default function FemMeshSlice2DECharts({
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
  sliceMode = "single",
  projectionReduction = "mean_occupied",
  projectionIncludeAirAsZero = false,
  projectionSamples = 20,
  projectionResolution = 128,
  onComponentChange,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const projectionRequestSeq = useRef(0);
  const [projectionResult, setProjectionResult] = useState<ProjectionResult | null>(null);
  const [projectionPending, setProjectionPending] = useState(false);

  const fieldNComp = meshData.fieldNComp ?? 3;
  const hasField = Boolean(meshData.fieldData);
  const isMagnetizationQuantity = !quantityId || quantityId === "m";
  const componentOptions: VectorComponent[] = fieldNComp >= 3
    ? (isMagnetizationQuantity ? ["x", "y", "z"] : ["magnitude", "x", "y", "z"])
    : ["magnitude"];
  const effectiveComponent: VectorComponent = componentOptions.includes(component)
    ? component
    : componentOptions[0];
  const effectivePlane = clipAxis ? clipAxisToPlane(clipAxis) : plane;
  const isProjectionMode = sliceMode === "all_layers";

  useEffect(() => {
    if (component !== effectiveComponent) {
      onComponentChange?.(effectiveComponent);
    }
  }, [component, effectiveComponent, onComponentChange]);

  // ── Normal axis bounds ─────────────────────────────────────────
  const { normal } = axisIndices(effectivePlane);
  const normalBounds = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < meshData.nNodes; i += 1) {
      const value = meshData.nodes[i * 3 + normal];
      if (value < min) min = value;
      if (value > max) max = value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 0 };
    return { min, max };
  }, [meshData.nNodes, meshData.nodes, normal]);

  const planeCoord = useMemo(
    () => normalizedClipToWorld(normalBounds.min, normalBounds.max, clipPos),
    [clipPos, normalBounds.max, normalBounds.min],
  );

  // ── Visibility state ───────────────────────────────────────────
  const visibilityState = useMemo(
    () =>
      buildSliceVisibilityState({
        meshData,
        meshParts,
        meshEntityViewState,
        airSegmentVisible,
        objectViewMode,
        visibleObjectIds,
        vectorDomainFilter: "full_domain",
      }),
    [airSegmentVisible, meshData, meshEntityViewState, meshParts, objectViewMode, visibleObjectIds],
  );

  // ── Slice query (exact section) ────────────────────────────────
  const sliceQuery = useMemo(() => {
    const vectorMode: "in_plane" | "off" = showArrows ? "in_plane" : "off";
    const scope: "selection" | "visible" = objectViewMode === "isolate" ? "selection" : "visible";
    const extentMode: "fit_intersection" | "fit_visible" = objectViewMode === "isolate" ? "fit_intersection" : "fit_visible";
    return {
      orientation: effectivePlane,
      positionMode: "sync_3d_clip" as const,
      planeOffset: clipPos,
      thicknessMode: "exact" as const,
      thicknessWorld: 0,
      aggregation: "sample" as const,
      quantityId: quantityId ?? "m",
      component: effectiveComponent,
      vectorMode,
      scope,
      extentMode,
      colorScaleMode: "slice_auto" as const,
    };
  }, [showArrows, clipPos, effectiveComponent, effectivePlane, objectViewMode, quantityId]);
  const boundsStrategy = objectViewMode === "isolate" ? "visible-intersection" : "visible-context";

  // ── Exact section slice (non-projection mode) ──────────────────
  const exactSlice = useFemSliceSampling({
    meshData,
    sliceQuery,
    planeCoord,
    effectivePlane,
    effectiveComponent,
    quantityId,
    visibilityState,
    boundsStrategy,
  });

  const projectionKey = useMemo(
    () =>
      projectionCacheKey({
        orientation: effectivePlane,
        component: effectiveComponent,
        reduction: projectionReduction,
        includeAirAsZero: projectionIncludeAirAsZero,
        samples: projectionSamples,
        resolution: projectionResolution,
        maxElements: PROJECTION_MAX_ELEMENTS,
        boundsStrategy,
        meshNodes: meshData.nodes,
        meshElements: meshData.elements,
        meshBoundaryFaces: meshData.boundaryFaces,
        visibleElements: visibilityState.visibleElements,
        visibleBoundaryFaces: visibilityState.visibleBoundaryFaces,
        visiblePartIds: visibilityState.visiblePartIds,
        quantityId,
        fieldX: meshData.fieldData?.x,
        fieldY: meshData.fieldData?.y,
        fieldZ: meshData.fieldData?.z,
        fieldRevision: meshData.fieldRevision,
        fieldNComp,
      }),
    [
      boundsStrategy,
      effectiveComponent,
      effectivePlane,
      fieldNComp,
      meshData.boundaryFaces,
      meshData.elements,
      meshData.fieldData?.x,
      meshData.fieldData?.y,
      meshData.fieldData?.z,
      meshData.fieldRevision,
      meshData.nodes,
      projectionIncludeAirAsZero,
      projectionReduction,
      projectionResolution,
      projectionSamples,
      quantityId,
      visibilityState.visibleBoundaryFaces,
      visibilityState.visibleElements,
      visibilityState.visiblePartIds,
    ],
  );

  useEffect(() => {
    if (!isProjectionMode || !hasField) {
      projectionRequestSeq.current += 1;
      setProjectionPending(false);
      setProjectionResult(null);
      return;
    }
    const cached = readProjectionCache(projectionKey);
    if (cached) {
      projectionRequestSeq.current += 1;
      setProjectionPending(false);
      setProjectionResult(cached);
      return;
    }

    const requestId = projectionRequestSeq.current + 1;
    projectionRequestSeq.current = requestId;
    setProjectionPending(true);

    const options = {
      nPlanes: projectionSamples,
      resolution: projectionResolution,
      maxElements: PROJECTION_MAX_ELEMENTS,
      reduction: projectionReduction,
      includeAirAsZero: projectionIncludeAirAsZero,
    };

    if (typeof Worker === "undefined") {
      const result = computeProjectionSlice(
        meshData,
        effectivePlane,
        effectiveComponent,
        visibilityState,
        boundsStrategy,
        options,
      );
      writeProjectionCache(projectionKey, result);
      if (projectionRequestSeq.current === requestId) {
        setProjectionResult(result);
        setProjectionPending(false);
      }
      return;
    }

    const worker = new Worker(new URL("./fem/femProjectionWorker.ts", import.meta.url));
    worker.onmessage = (
      event: MessageEvent<{ id: number; result?: ProjectionResult; error?: string }>,
    ) => {
      if (event.data.id !== requestId || projectionRequestSeq.current !== requestId) {
        return;
      }
      if (event.data.result) {
        writeProjectionCache(projectionKey, event.data.result);
        setProjectionResult(event.data.result);
      } else {
        setProjectionResult(null);
      }
      setProjectionPending(false);
      worker.terminate();
    };
    worker.onerror = () => {
      if (projectionRequestSeq.current === requestId) {
        setProjectionPending(false);
        setProjectionResult(null);
      }
      worker.terminate();
    };
    worker.postMessage({
      id: requestId,
      meshData,
      plane: effectivePlane,
      component: effectiveComponent,
      visibility: visibilityState,
      boundsStrategy,
      options,
    });

    return () => {
      worker.terminate();
    };
  }, [
    boundsStrategy,
    effectiveComponent,
    effectivePlane,
    hasField,
    isProjectionMode,
    meshData,
    projectionIncludeAirAsZero,
    projectionKey,
    projectionReduction,
    projectionResolution,
    projectionSamples,
    visibilityState,
  ]);

  // ── Color scale ────────────────────────────────────────────────
  const colorScale = useMemo(() => {
    if (isProjectionMode && projectionResult) {
      return smartAutoScale(
        projectionResult.valueRange.min,
        projectionResult.valueRange.max,
        quantityId,
        effectiveComponent,
      );
    }
    return smartAutoScale(
      exactSlice.slice.valueRange.min,
      exactSlice.slice.valueRange.max,
      quantityId,
      effectiveComponent,
    );
  }, [isProjectionMode, projectionResult, exactSlice.slice.valueRange, quantityId, effectiveComponent]);

  const palette = useMemo(() => paletteForMode(colorScale.mode), [colorScale.mode]);

  const quantityTitle = useMemo(() => {
    const base = isMagnetizationQuantity ? "m" : (quantityId ?? "v");
    const comp = effectiveComponent === "magnitude" ? `|${base}|` : `${base}_${effectiveComponent}`;
    const unit = quantityUnit ? ` [${quantityUnit}]` : "";
    return `${quantityLabel} · ${comp}${unit}`;
  }, [effectiveComponent, isMagnetizationQuantity, quantityId, quantityLabel, quantityUnit]);

  // ── Render chart ───────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    if (!chartRef.current || chartRef.current.isDisposed()) {
      chartRef.current = echarts.init(containerRef.current, undefined, { renderer: "canvas" });
    }
    const chart = chartRef.current;

    if (isProjectionMode && projectionResult && projectionResult.xRes > 0) {
      // ── Projection raster (heatmap) ──────────────────────────
      const { values, xRes, yRes, bounds } = projectionResult;
      const data: [number, number, number][] = [];
      for (let iy = 0; iy < yRes; iy++) {
        for (let ix = 0; ix < xRes; ix++) {
          const v = values[iy * xRes + ix];
          if (!Number.isNaN(v)) {
            data.push([ix, iy, v]);
          }
        }
      }

      const uLabel = projectionResult.uLabel;
      const vLabel = projectionResult.vLabel;

      chart.setOption({
        animation: true,
        animationDurationUpdate: 140,
        backgroundColor: BG,
        title: {
          text: `${quantityTitle}  (${projectionTitle(projectionReduction)}, ${projectionResult.nPlanesSampled} planes${projectionPending ? ", updating" : ""})`,
          left: 16,
          top: 10,
          textStyle: { color: THEME.text1, fontSize: 13, fontWeight: 600 },
        },
        tooltip: {
          position: "top",
          confine: true,
          formatter: (params: unknown) => {
            const p = (Array.isArray(params) ? params[0] : params) as { value?: unknown } | undefined;
            const val = p?.value;
            if (!Array.isArray(val) || val.length < 3) return "";
            return [
              `<strong>${quantityTitle}</strong>`,
              `${uLabel}: ${val[0]}`,
              `${vLabel}: ${val[1]}`,
              `value: ${formatMagnitude(Number(val[2]))}`,
            ].join("<br/>");
          },
          backgroundColor: THEME.tooltipBg,
          borderColor: THEME.tooltipBorder,
          borderWidth: 1,
          padding: [10, 12],
          textStyle: { color: THEME.tooltipText, fontSize: 12 },
        },
        xAxis: {
          type: "category",
          data: Array.from({ length: xRes }, (_, i) => i),
          name: `${uLabel} (cell)`,
          nameLocation: "middle",
          nameGap: 30,
          nameTextStyle: { color: THEME.text2, fontWeight: 600 },
          axisLine: { show: true, lineStyle: { color: THEME.border } },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false },
        },
        yAxis: {
          type: "category",
          data: Array.from({ length: yRes }, (_, i) => i),
          name: `${vLabel} (cell)`,
          nameLocation: "middle",
          nameGap: 44,
          nameTextStyle: { color: THEME.text2, fontWeight: 600 },
          axisLine: { show: true, lineStyle: { color: THEME.border } },
          axisTick: { show: false },
          axisLabel: { show: false },
          splitLine: { show: false },
        },
        visualMap: [{
          type: "continuous",
          min: colorScale.min,
          max: colorScale.max,
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
          text: [formatMagnitude(colorScale.max), formatMagnitude(colorScale.min)],
          textStyle: { color: THEME.text2, fontSize: 11, fontWeight: 600 },
          formatter: (value: number) => formatMagnitude(value),
          inRange: { color: palette },
          outOfRange: { color: ["rgba(107, 122, 154, 0.18)"] },
          seriesIndex: 0,
        }],
        series: [{
          name: quantityLabel,
          type: "heatmap",
          selectedMode: false,
          emphasis: { disabled: true },
          progressive: 0,
          data,
        }],
        grid: { containLabel: true, left: 58, right: 92, top: 48, bottom: 52 },
        toolbox: {
          show: true,
          top: 10,
          right: 10,
          itemSize: 20,
          iconStyle: { borderColor: THEME.toolboxIcon, borderWidth: 1.15 },
          emphasis: { iconStyle: { borderColor: THEME.text1 } },
          feature: {
            dataZoom: { xAxisIndex: 0, yAxisIndex: 0 },
            restore: { show: true },
            saveAsImage: { type: "png", name: "projection" },
          },
        },
      }, { notMerge: true });
    } else if (hasField && !isProjectionMode) {
      // ── Exact section: render polygons via custom series ──────
      const slice = exactSlice.slice;
      const polygons = slice.polygons;
      const bounds = slice.bounds;

      if (polygons.length === 0) {
        chart.clear();
        return;
      }

      const customData = polygons.map((p, i) => [i, p.value]);
      const segments = showMesh ? slice.segments : [];

      chart.setOption({
        animation: false,
        backgroundColor: BG,
        title: {
          text: quantityTitle,
          left: 16,
          top: 10,
          textStyle: { color: THEME.text1, fontSize: 13, fontWeight: 600 },
        },
        tooltip: {
          trigger: "item",
          confine: true,
          formatter: (params: unknown) => {
            const p = params as { dataIndex?: number } | undefined;
            if (p?.dataIndex == null || !polygons[p.dataIndex]) return "";
            const poly = polygons[p.dataIndex];
            return [
              `<strong>${quantityTitle}</strong>`,
              `value: ${formatMagnitude(poly.value)}`,
              poly.worldPoint ? `pos: (${poly.worldPoint.map(v => formatMagnitude(v)).join(", ")})` : "",
            ].filter(Boolean).join("<br/>");
          },
          backgroundColor: THEME.tooltipBg,
          borderColor: THEME.tooltipBorder,
          borderWidth: 1,
          textStyle: { color: THEME.tooltipText, fontSize: 12 },
        },
        xAxis: {
          type: "value",
          min: bounds.uMin,
          max: bounds.uMax,
          name: `${slice.uLabel} [m]`,
          nameLocation: "middle",
          nameGap: 30,
          nameTextStyle: { color: THEME.text2, fontWeight: 600 },
          axisLine: { show: true, lineStyle: { color: THEME.border } },
          axisLabel: { color: THEME.text2, fontSize: 10, formatter: (v: number) => formatMagnitude(v) },
          splitLine: { show: false },
        },
        yAxis: {
          type: "value",
          min: bounds.vMin,
          max: bounds.vMax,
          name: `${slice.vLabel} [m]`,
          nameLocation: "middle",
          nameGap: 50,
          nameTextStyle: { color: THEME.text2, fontWeight: 600 },
          axisLine: { show: true, lineStyle: { color: THEME.border } },
          axisLabel: { color: THEME.text2, fontSize: 10, formatter: (v: number) => formatMagnitude(v) },
          splitLine: { show: false },
        },
        visualMap: showQuantity ? [{
          type: "continuous",
          min: colorScale.min,
          max: colorScale.max,
          calculable: false,
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
          text: [formatMagnitude(colorScale.max), formatMagnitude(colorScale.min)],
          textStyle: { color: THEME.text2, fontSize: 11, fontWeight: 600 },
          formatter: (value: number) => formatMagnitude(value),
          inRange: { color: palette },
          outOfRange: { color: ["rgba(107, 122, 154, 0.18)"] },
          seriesIndex: 0,
        }] : [],
        series: [
          // Polygon fill
          {
            type: "custom",
            coordinateSystem: "cartesian2d",
            data: customData,
            renderItem: (_params: unknown, api: echarts.CustomSeriesRenderItemAPI) => {
              const idx = api.value(0) as number;
              const poly = polygons[idx];
              if (!poly || poly.points.length < 3) return { type: "group", children: [] };
              const pts = poly.points.map(([u, v]) => api.coord([u, v]));
              const t = colorScale.max > colorScale.min
                ? (poly.value - colorScale.min) / (colorScale.max - colorScale.min)
                : 0.5;
              const fillColor = showQuantity
                ? interpolatePalette(t, palette)
                : "rgba(108, 112, 134, 0.18)";
              return {
                type: "polygon",
                shape: { points: pts },
                style: { fill: fillColor, stroke: showMesh ? THEME.border : "none", lineWidth: showMesh ? 0.5 : 0 },
              };
            },
          },
          // Wireframe segments
          ...(segments.length > 0 ? [{
            type: "custom" as const,
            coordinateSystem: "cartesian2d" as const,
            data: segments.map((_, i) => [i]),
            renderItem: (_params: unknown, api: echarts.CustomSeriesRenderItemAPI) => {
              const idx = api.value(0) as number;
              const seg = segments[idx];
              if (!seg) return { type: "group" as const, children: [] };
              const a = api.coord([seg.a[0], seg.a[1]]);
              const b = api.coord([seg.b[0], seg.b[1]]);
              return {
                type: "line" as const,
                shape: { x1: a[0], y1: a[1], x2: b[0], y2: b[1] },
                style: { stroke: "rgba(205, 214, 244, 0.5)", lineWidth: 0.8 },
              };
            },
            silent: true,
          }] : []),
        ],
        grid: { containLabel: true, left: 70, right: 92, top: 48, bottom: 52 },
        toolbox: {
          show: true,
          top: 10,
          right: 10,
          itemSize: 20,
          iconStyle: { borderColor: THEME.toolboxIcon, borderWidth: 1.15 },
          emphasis: { iconStyle: { borderColor: THEME.text1 } },
          feature: {
            dataZoom: { xAxisIndex: 0, yAxisIndex: 0 },
            restore: { show: true },
            saveAsImage: { type: "png", name: "fem-slice" },
          },
        },
      }, { notMerge: true });
    } else {
      chart.clear();
    }
  }, [
    isProjectionMode, projectionResult, exactSlice.slice,
    hasField, showQuantity, showMesh, colorScale, palette,
    quantityTitle, quantityLabel,
  ]);

  // ── Resize observer ────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // ── Cleanup ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      if (chartRef.current && !chartRef.current.isDisposed()) {
        chartRef.current.dispose();
      }
      chartRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full"
      style={{ backgroundColor: BG }}
    />
  );
}
