// @ts-nocheck
"use client";

import { useEffect, useRef, useMemo } from "react";
import * as echarts from "echarts";

type SlicePlane = "xy" | "xz" | "yz";
type VectorComponent = "x" | "y" | "z" | "magnitude";

interface Props {
  grid: [number, number, number];
  vectors: Float64Array | null;
  quantityLabel: string;
  /** e.g. "m", "H_ex", "H_demag", "H_ext", "H_eff" */
  quantityId?: string;
  component: VectorComponent;
  plane: SlicePlane;
  sliceIndex: number;
}

// ─── Color palettes (1:1 from amumax preview2D.ts) ─────────────────
const DIVERGING_PALETTE = [
  "#15315f", "#2f6caa", "#90b9df", "#f4f1ed", "#efb09d", "#cf6256", "#7d1d34",
];
const NEGATIVE_PALETTE = [
  "#f3f7fd", "#cfdef1", "#91b8dd", "#5688bd", "#285b93", "#14365f",
];
const POSITIVE_PALETTE = [
  "#0a1220", "#143d67", "#1c6d8f", "#24a0a4", "#8ed6ac", "#f1f7bb",
];

// ─── Theme constants (from amumax echarts-theme.ts) ────────────────
const THEME = {
  border: "#273753",
  text2: "#a7bad3",
  tooltipBg: "rgba(15, 22, 42, 0.92)",
  tooltipBorder: "#273753",
  tooltipText: "#edf3fb",
  accent: "#57c8b6",
  toolboxIcon: "rgba(107, 167, 255, 0.55)",
  text1: "#edf3fb",
  brushBg: "rgba(87, 200, 182, 0.1)",
  brushBorder: "rgba(87, 200, 182, 0.45)",
};

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

function formatMagnitude(value: number): string {
  if (!Number.isFinite(value)) return "NaN";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1000 || abs < 1e-2) return value.toExponential(2);
  if (abs >= 10) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(2);
  return value.toPrecision(2);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, v));
}

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
  quantityLabel,
  quantityId,
  component,
  plane,
  sliceIndex,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // ─── Extract scalar field data ────────────────────────────────────
  const { data, xLen, yLen, dMin, dMax } = useMemo(() => {
    if (!vectors || grid[0] === 0)
      return { data: [] as [number, number, number][], xLen: 0, yLen: 0, dMin: 0, dMax: 0 };

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
  }, [vectors, grid, component, plane, sliceIndex]);

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
    const xCategories = Array.from({ length: xLen }, (_, i) => i);
    const yCategories = Array.from({ length: yLen }, (_, i) => i);

    const axisLabel = plane === "xy" ? "x" : plane === "xz" ? "x" : "y";
    const yAxisLabel = plane === "xy" ? "y" : "z";

    chart.setOption(
      {
        animation: false,
        tooltip: {
          position: "top",
          confine: true,
          formatter: (params: any) => {
            const v = params.value;
            return [
              `<strong>${quantityLabel}.${component}</strong>`,
              `${axisLabel}: ${v[0]}`,
              `${yAxisLabel}: ${v[1]}`,
              `value: ${formatMagnitude(v[2])}`,
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
          data: xCategories,
          name: `${axisLabel} (cell)`,
          nameLocation: "middle",
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
            lineStyle: { color: THEME.accent, width: 1.5, type: "dashed" },
          },
          axisTick: { length: 6, lineStyle: { type: "solid", color: THEME.border } },
          axisLabel: {
            show: true,
            color: THEME.text2,
            showMinLabel: true,
            showMaxLabel: true,
            hideOverlap: true,
          },
          splitLine: { show: false },
        },
        yAxis: {
          type: "category",
          data: yCategories,
          name: `${yAxisLabel} (cell)`,
          nameLocation: "middle",
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
            lineStyle: { color: THEME.accent, width: 1.5, type: "dashed" },
          },
          axisTick: { length: 6, lineStyle: { type: "solid", color: THEME.border } },
          axisLabel: {
            show: true,
            color: THEME.text2,
            showMinLabel: true,
            showMaxLabel: true,
            hideOverlap: true,
          },
          splitLine: { show: false },
        },
        visualMap: [
          {
            type: "continuous",
            min: scale.min,
            max: scale.max,
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
            text: [formatMagnitude(scale.max), formatMagnitude(scale.min)],
            textStyle: { color: THEME.text2, fontSize: 11, fontWeight: 600 },
            formatter: (value: number) => formatMagnitude(value),
            inRange: { color: scale.palette },
            outOfRange: { color: ["rgba(107, 122, 154, 0.18)"] },
            seriesIndex: 0,
            showLabel: true,
          },
        ],
        series: [
          {
            name: quantityLabel,
            type: "heatmap",
            selectedMode: false,
            emphasis: { disabled: true },
            progressive: 0,
            progressiveThreshold: Number.MAX_SAFE_INTEGER,
            animation: false,
            data,
          },
        ],
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
      },
      { notMerge: true },
    );

    return () => {};
  }, [data, xLen, yLen, dMin, dMax, quantityLabel, component, plane]);

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
      style={{
        width: "100%",
        height: "100%",
        background: "#0c121f",
      }}
    />
  );
}
