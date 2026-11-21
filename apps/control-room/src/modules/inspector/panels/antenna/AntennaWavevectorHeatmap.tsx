"use client";

import { useMemo, type ReactNode } from "react";

import {
  minMaxFinite,
  ScientificEChart,
  type ResolvedChartThemePalette,
} from "@/shared/charts/ScientificEChart";

export interface AntennaWavevectorHeatmapProps {
  values: ArrayLike<number>;
  nu: number;
  nv: number;
  extentUM: number;
  extentVM: number;
  scaleMode?: "linear" | "db";
  showCenterCut?: boolean;
  componentLabel?: string;
}

/**
 * Renders 2D spatial Fourier spectrum |b_tilde(k_x, k_y)| on an ECharts `<canvas>`
 * heatmap (replacing the legacy 4096 inline-styled `<span>` DOM grid, MA-P1-8).
 */
export function AntennaWavevectorHeatmap({
  values,
  nu,
  nv,
  extentUM,
  extentVM,
  scaleMode = "linear",
  showCenterCut = true,
  componentLabel = "|b̃(kx, ky)|",
}: AntennaWavevectorHeatmapProps): ReactNode {
  const safeNu = Math.max(2, Math.floor(nu));
  const safeNv = Math.max(2, Math.floor(nv));
  const du = extentUM > 0 ? extentUM / safeNu : 50e-9;
  const dv = extentVM > 0 ? extentVM / safeNv : 50e-9;

  const { kxLabels, kyLabels, heatmapTuples, minVal, maxVal, centerCutKx } = useMemo(() => {
    const kMaxU = Math.PI / du / 1e6; // rad/µm
    const kMaxV = Math.PI / dv / 1e6; // rad/µm
    const xLabels: string[] = [];
    const yLabels: string[] = [];
    for (let ix = 0; ix < safeNu; ix += 1) {
      const kx = -kMaxU + (2 * kMaxU * ix) / Math.max(1, safeNu - 1);
      xLabels.push(kx.toFixed(1));
    }
    for (let iy = 0; iy < safeNv; iy += 1) {
      const ky = -kMaxV + (2 * kMaxV * iy) / Math.max(1, safeNv - 1);
      yLabels.push(ky.toFixed(1));
    }

    const extrema = minMaxFinite(values);
    const peak = extrema && extrema.max > 0 ? extrema.max : 1;
    const tuples: [number, number, number][] = new Array(safeNu * safeNv);
    const transformed = new Float64Array(safeNu * safeNv);

    let idx = 0;
    for (let iy = 0; iy < safeNv; iy += 1) {
      for (let ix = 0; ix < safeNu; ix += 1) {
        const raw = values[idx] ?? 0;
        const finite = Number.isFinite(raw) ? Math.max(0, raw) : 0;
        const mapped =
          scaleMode === "db"
            ? Math.max(-60, 20 * Math.log10(Math.max(1e-6, finite / peak)))
            : finite;
        tuples[idx] = [ix, iy, mapped];
        transformed[idx] = mapped;
        idx += 1;
      }
    }

    const mappedExtrema = minMaxFinite(transformed) ?? { max: 1, min: 0 };
    const midY = Math.floor(safeNv / 2);
    const cut: number[] = [];
    for (let ix = 0; ix < safeNu; ix += 1) {
      cut.push(transformed[midY * safeNu + ix] ?? 0);
    }

    return {
      centerCutKx: cut,
      heatmapTuples: tuples,
      kxLabels: xLabels,
      kyLabels: yLabels,
      maxVal: mappedExtrema.max === mappedExtrema.min ? mappedExtrema.min + 1 : mappedExtrema.max,
      minVal: mappedExtrema.min,
    };
  }, [du, dv, safeNu, safeNv, scaleMode, values]);

  const heatmapOptionBuilder = useMemo(
    () => (palette: ResolvedChartThemePalette) => ({
      animation: false,
      grid: { bottom: 38, left: 46, right: 18, top: 14 },
      series: [
        {
          data: heatmapTuples,
          emphasis: {
            itemStyle: { borderColor: palette.textPrimary, borderWidth: 1 },
          },
          name: componentLabel,
          progressive: 0,
          type: "heatmap" as const,
        },
      ],
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.borderSubtle,
        position: "top" as const,
        textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
      },
      visualMap: {
        calculable: false,
        inRange: {
          color: [
            palette.panelBackground,
            palette.info,
            palette.accent,
            palette.warning,
          ],
        },
        max: maxVal,
        min: minVal,
        orient: "horizontal" as const,
        show: false,
      },
      xAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        data: kxLabels,
        name: "kx [rad/µm]",
        nameGap: 22,
        nameLocation: "middle" as const,
        nameTextStyle: { color: palette.textSecondary, fontSize: palette.fontSize },
        type: "category" as const,
      },
      yAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        data: kyLabels,
        name: "ky [rad/µm]",
        nameTextStyle: { color: palette.textSecondary, fontSize: palette.fontSize },
        type: "category" as const,
      },
    }),
    [componentLabel, heatmapTuples, kxLabels, kyLabels, maxVal, minVal],
  );

  const cutOptionBuilder = useMemo(
    () => (palette: ResolvedChartThemePalette) => ({
      animation: false,
      grid: { bottom: 26, left: 46, right: 14, top: 12 },
      series: [
        {
          areaStyle: { color: palette.fieldBackground },
          data: centerCutKx,
          itemStyle: { color: palette.accent },
          lineStyle: { color: palette.accent, width: 1.75 },
          name: "ky = 0 cut",
          showSymbol: false,
          type: "line" as const,
        },
      ],
      tooltip: {
        backgroundColor: palette.tooltipBackground,
        borderColor: palette.borderSubtle,
        textStyle: { color: palette.textPrimary, fontSize: palette.fontSize },
        trigger: "axis" as const,
      },
      xAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        data: kxLabels,
        type: "category" as const,
      },
      yAxis: {
        axisLabel: { color: palette.textMuted, fontSize: palette.fontSize },
        splitLine: { lineStyle: { color: palette.borderSubtle } },
        type: "value" as const,
      },
    }),
    [centerCutKx, kxLabels],
  );

  return (
    <div className="fm-inspector-stack" data-slot="antenna-wavevector-heatmap">
      <ScientificEChart
        ariaLabel={`2D wavevector excitation spectrum ${componentLabel} (${safeNu}x${safeNv})`}
        height={220}
        optionBuilder={heatmapOptionBuilder}
      />
      {showCenterCut ? (
        <ScientificEChart
          ariaLabel="1D wavevector cut along ky = 0"
          height={120}
          optionBuilder={cutOptionBuilder}
        />
      ) : null}
    </div>
  );
}
