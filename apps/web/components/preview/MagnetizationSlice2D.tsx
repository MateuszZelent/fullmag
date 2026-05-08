"use client";

import { useEffect, useRef, useMemo } from "react";
import * as echarts from "echarts";
import type {
  FieldProjectionMeta,
  FieldSliceMeta,
} from "@/src/api/types";
import type { SliceArrowData } from "@/src/hooks/resources/useFieldSlice2D";
import type { SliceMeshOverlay2D } from "./fem/sliceMeshOverlay2D";
import { DIVERGING_PALETTE, SEQUENTIAL_BLUE_PALETTE, POSITIVE_PALETTE } from "../../lib/colorPalettes";

type SlicePlane = "xy" | "xz" | "yz";
type VectorComponent = "x" | "y" | "z" | "magnitude";
type FemArrowColorMode = "orientation" | "x" | "y" | "z" | "magnitude" | "monochrome";

interface Props {
  grid: [number, number, number];
  vectors: Float64Array | null;
  /**
   * Optional pre-sliced scalar raster from `/fields/:id/slice/scalar`.
   * When provided, component extraction from `vectors` is skipped.
   */
  scalarValues?: Float64Array | null;
  /** `[xPixels, yPixels]` for `scalarValues`. */
  scalarShape?: [number, number] | null;
  meta?: FieldSliceMeta | FieldProjectionMeta | null;
  meshOverlay?: SliceMeshOverlay2D | null;
  arrows?: SliceArrowData | null;
  quantityLabel: string;
  /** e.g. "m", "H_ex", "H_demag", "H_ext", "H_eff" */
  quantityId?: string;
  quantityUnit?: string | null;
  quantityComponentCount?: number | null;
  showQuantity?: boolean;
  showVectors?: boolean;
  arrowEvery?: number | null;
  vectorColorMode?: FemArrowColorMode;
  vectorMonoColor?: string;
  component: VectorComponent;
  plane: SlicePlane;
  sliceIndex: number;
}

// Alias for local use
const NEGATIVE_PALETTE = SEQUENTIAL_BLUE_PALETTE;

function getColorScale(min: number, max: number) {
  if (min < 0 && max > 0) {
    const bound = Math.max(Math.abs(min), Math.abs(max));
    return { min: -bound, max: bound, palette: DIVERGING_PALETTE };
  }
  if (max <= 0) return { min, max, palette: NEGATIVE_PALETTE };
  return { min, max, palette: POSITIVE_PALETTE };
}

/**
 * Quantity-aware colorbar range.
 * – Magnetization magnitude: always [0, 1] (unit vector → |m|≡1, noise is FP artefact)
 * – Magnetization component:  always [-1, 1]
 * – Field quantities (H_ex, etc.): use actual data min/max, but snap symmetric if it crosses zero
 */
function getSmartColorScale(
  dMin: number,
  dMax: number,
  quantityId: string | undefined,
  component: VectorComponent,
) {
  const isMagnetization = !quantityId || quantityId === "m";

  if (isMagnetization) {
    if (component === "magnitude") {
      return { min: 0, max: 1, palette: POSITIVE_PALETTE };
    }
    // Component mx/my/mz: range is always [-1, 1]
    return { min: -1, max: 1, palette: DIVERGING_PALETTE };
  }

  // For field quantities, use actual data range but snap to nice bounds
  // If nearly constant (range < 1e-10 × |max|), expand the range
  const range = dMax - dMin;
  if (range < Math.abs(dMax) * 1e-10 && range > 0) {
    const mid = (dMin + dMax) / 2;
    const halfSpan = Math.abs(mid) * 0.01 || 1e-20;
    return getColorScale(mid - halfSpan, mid + halfSpan);
  }

  return getColorScale(dMin, dMax);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

import {
  buildSlice2DChartOption,
  buildSlice2DChartTopologyKey,
  reconstructSliceArrowGlyphs,
  rasterToHeatmapPoints,
  resolveHeatmapTooltipValue,
  styleSliceVectorGlyphs,
} from "./magnetizationSliceUtils";
export { buildSlice2DChartTopologyKey, resolveHeatmapTooltipValue };

function extractComponent(
  vectors: Float64Array,
  comp: VectorComponent,
  idx: number,
): number {
  const base = idx * 3;
  const vx = vectors[base],
    vy = vectors[base + 1],
    vz = vectors[base + 2];
  switch (comp) {
    case "x":
      return vx;
    case "y":
      return vy;
    case "z":
      return vz;
    case "magnitude":
      return Math.sqrt(vx * vx + vy * vy + vz * vz);
  }
}

export default function MagnetizationSlice2D({
  grid,
  vectors,
  scalarValues = null,
  scalarShape = null,
  meta = null,
  meshOverlay = null,
  arrows = null,
  quantityLabel,
  quantityId,
  quantityUnit = null,
  quantityComponentCount = null,
  showQuantity = true,
  showVectors = false,
  arrowEvery = null,
  vectorColorMode = "orientation",
  vectorMonoColor = "#38d9ff",
  component,
  plane,
  sliceIndex,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  const chartTopologyKeyRef = useRef<string | null>(null);

  // ─── Extract scalar field data ────────────────────────────────────
  const { data, xLen, yLen, dMin, dMax } = useMemo(() => {
    if (
      scalarValues &&
      scalarShape &&
      scalarShape[0] > 0 &&
      scalarShape[1] > 0 &&
      scalarValues.length > 0
    ) {
      const xLen = scalarShape[0];
      const yLen = scalarShape[1];
      const points = rasterToHeatmapPoints({
        values: scalarValues,
        xLen,
        yLen,
        bounds: meta?.bounds ?? null,
      });
      let dMin = Number.POSITIVE_INFINITY;
      let dMax = Number.NEGATIVE_INFINITY;

      for (const [, , v] of points) {
        if (v < dMin) dMin = v;
        if (v > dMax) dMax = v;
      }

      if (!Number.isFinite(dMin)) dMin = 0;
      if (!Number.isFinite(dMax)) dMax = 0;
      return { data: points, xLen, yLen, dMin, dMax };
    }

    if (!vectors || grid[0] === 0) {
      return { data: [] as [number, number, number][], xLen: 0, yLen: 0, dMin: 0, dMax: 0 };
    }

    const [Nx, Ny, Nz] = grid;
    let xLen: number, yLen: number;
    const points: [number, number, number][] = [];
    let dMin = Infinity,
      dMax = -Infinity;

    if (plane === "xy") {
      xLen = Nx;
      yLen = Ny;
      const iz = clamp(sliceIndex, 0, Nz - 1);
      for (let iy = 0; iy < Ny; iy++) {
        for (let ix = 0; ix < Nx; ix++) {
          const idx = iz * Nx * Ny + iy * Nx + ix;
          const v = extractComponent(vectors, component, idx);
          if (v < dMin) dMin = v;
          if (v > dMax) dMax = v;
          points.push([ix, iy, v]);
        }
      }
    } else if (plane === "xz") {
      xLen = Nx;
      yLen = Nz;
      const iy = clamp(sliceIndex, 0, Ny - 1);
      for (let iz = 0; iz < Nz; iz++) {
        for (let ix = 0; ix < Nx; ix++) {
          const idx = iz * Nx * Ny + iy * Nx + ix;
          const v = extractComponent(vectors, component, idx);
          if (v < dMin) dMin = v;
          if (v > dMax) dMax = v;
          points.push([ix, iz, v]);
        }
      }
    } else {
      xLen = Ny;
      yLen = Nz;
      const ix = clamp(sliceIndex, 0, Nx - 1);
      for (let iz = 0; iz < Nz; iz++) {
        for (let iy = 0; iy < Ny; iy++) {
          const idx = iz * Nx * Ny + iy * Nx + ix;
          const v = extractComponent(vectors, component, idx);
          if (v < dMin) dMin = v;
          if (v > dMax) dMax = v;
          points.push([iy, iz, v]);
        }
      }
    }

    if (!Number.isFinite(dMin)) dMin = 0;
    if (!Number.isFinite(dMax)) dMax = 0;

    return { data: points, xLen, yLen, dMin, dMax };
  }, [component, grid, meta?.bounds, plane, scalarShape, scalarValues, sliceIndex, vectors]);

  // ─── Init / update chart ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    if (!data.length) {
      chartRef.current?.clear();
      return;
    }

    if (!chartRef.current || chartRef.current.isDisposed()) {
      chartRef.current = echarts.init(containerRef.current, undefined, {
        renderer: "canvas",
      });
    }

    const chart = chartRef.current;
    const scale = getSmartColorScale(dMin, dMax, quantityId, component);
    const vectorGlyphs = showVectors
      ? reconstructSliceArrowGlyphs({
        arrows,
        scalarValues,
        xLen,
        yLen,
        bounds: meta?.bounds ?? null,
        arrowEvery,
      })
      : [];
    const styledVectorGlyphs = styleSliceVectorGlyphs({
      glyphs: vectorGlyphs,
      plane,
      colorMode: vectorColorMode,
      monoColor: vectorMonoColor,
    });

    const topologyKey = buildSlice2DChartTopologyKey(
      plane,
      xLen,
      yLen,
      meshOverlay?.segments.length ?? 0,
      styledVectorGlyphs.length,
    );
    const topologyChanged = chartTopologyKeyRef.current !== topologyKey;
    chartTopologyKeyRef.current = topologyKey;
    chart.setOption(buildSlice2DChartOption({
      data,
      xLen,
      yLen,
      scale,
      quantityLabel,
      quantityUnit,
      quantityComponentCount,
      component,
      plane,
      bounds: meta?.bounds ?? null,
      showQuantity,
      meshOverlay,
      vectorGlyphs: styledVectorGlyphs,
    }), { notMerge: topologyChanged });

    return () => {
      if (chart && !chart.isDisposed()) {
        chart.dispatchAction({ type: "hideTip" });
      }
    };
  }, [
    data,
    xLen,
    yLen,
    dMin,
    dMax,
    meta?.bounds,
    meshOverlay,
    arrows,
    scalarValues,
    arrowEvery,
    vectorColorMode,
    vectorMonoColor,
    quantityId,
    quantityLabel,
    quantityUnit,
    quantityComponentCount,
    showQuantity,
    showVectors,
    component,
    plane,
  ]);

  // ─── Resize observer ──────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      chartRef.current?.resize();
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // ─── Cleanup ──────────────────────────────────────────────────────
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
      className="h-full w-full bg-[#1e1e2e]"
    />
  );
}
