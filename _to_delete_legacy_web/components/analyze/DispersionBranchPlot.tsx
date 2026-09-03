"use client";

import { useCallback, useMemo } from "react";
import DynamicEChart, { ECHARTS_THEME } from "../plots/DynamicEChart";
import type * as echarts from "echarts";

import type { DispersionRow } from "./eigenTypes";

/** Palette consistent with ModeSpectrumPlot polarization colors */
const BRANCH_COLORS = [
  "#8ec5ff", "#c3a6ff", "#6ee7b7", "#fcd34d", "#f9a8d4",
  "#5eead4", "#93c5fd", "#fda4af", "#a5f3fc", "#d8b4fe",
];

const C = {
  bg: "transparent",
  text: "rgba(225,232,245,0.9)",
  grid: "rgba(120,140,170,0.16)",
  sel: "#ffb86c",
  hovBg: "rgba(10,16,28,0.96)",
  hovBorder: "rgba(132,156,240,0.55)",
} as const;

interface DispersionBranchPlotProps {
  rows: DispersionRow[];
  selectedMode: number | null;
  onSelectMode?: (modeIndex: number) => void;
}

function kMag(row: DispersionRow): number {
  return Math.sqrt(row.kx ** 2 + row.ky ** 2 + row.kz ** 2);
}

/** Estimate group velocity dω/dk for a sorted branch (returns m/s or null). */
function groupVelocity(branch: DispersionRow[]): number | null {
  if (branch.length < 2) return null;
  const sorted = [...branch].sort((a, b) => kMag(a) - kMag(b));
  const dk = kMag(sorted[sorted.length - 1]) - kMag(sorted[0]);
  if (dk === 0) return null;
  const domega =
    sorted[sorted.length - 1].angularFrequencyRadPerS - sorted[0].angularFrequencyRadPerS;
  return domega / dk;
}

function fmtVg(vg: number | null): string {
  if (vg === null) return "—";
  const abs = Math.abs(vg);
  if (abs >= 1e6) return `${(vg / 1e6).toFixed(2)} Mm/s`;
  if (abs >= 1e3) return `${(vg / 1e3).toFixed(2)} km/s`;
  return `${vg.toFixed(1)} m/s`;
}

export default function DispersionBranchPlot({
  rows,
  selectedMode,
  onSelectMode,
}: DispersionBranchPlotProps) {
  const { series, branchModeIndices } = useMemo(() => {
    // Group rows by modeIndex
    const grouped = new Map<number, DispersionRow[]>();
    for (const row of rows) {
      const entries = grouped.get(row.modeIndex);
      if (entries) entries.push(row);
      else grouped.set(row.modeIndex, [row]);
    }

    const sortedEntries = Array.from(grouped.entries()).sort(([a], [b]) => a - b);
    const modeIndices: number[] = [];

    const chartSeries: echarts.SeriesOption[] = sortedEntries.map(([modeIndex, entries], idx) => {
      const sorted = [...entries].sort((a, b) => kMag(a) - kMag(b));
      const isSelected = modeIndex === selectedMode;
      const color = isSelected ? C.sel : BRANCH_COLORS[idx % BRANCH_COLORS.length];
      modeIndices.push(modeIndex);

      return {
        type: sorted.length > 1 ? "line" : "scatter",
        name: `M${modeIndex}`,
        data: sorted.map((r) => ({
          value: [kMag(r), r.frequencyHz / 1e9],
          _modeIndex: modeIndex,
        })),
        lineStyle: { color, width: isSelected ? 2.8 : 1.6 },
        itemStyle: {
          color,
          borderColor: isSelected ? "rgba(255,184,108,0.4)" : "rgba(8,12,24,0.45)",
          borderWidth: isSelected ? 3 : 1,
        },
        symbolSize: isSelected ? 11 : 7,
        showSymbol: true,
      } as echarts.SeriesOption;
    });

    return { series: chartSeries, branchModeIndices: modeIndices };
  }, [rows, selectedMode]);

  const option = useMemo((): echarts.EChartsOption => {
    return {
      backgroundColor: C.bg,
      animation: false,
      grid: { left: 68, right: 12, top: 16, bottom: 52 },
      xAxis: {
        type: "value",
        name: "|k| (m⁻¹)",
        nameLocation: "middle",
        nameGap: 30,
        nameTextStyle: { color: C.text, fontSize: 10.5 },
        axisLine: { show: true, lineStyle: { color: ECHARTS_THEME.border } },
        axisLabel: {
          color: C.text,
          fontSize: 10,
          formatter: (val: number) => val.toExponential(1),
        },
        splitLine: { lineStyle: { color: C.grid } },
      },
      yAxis: {
        type: "value",
        name: "f (GHz)",
        nameLocation: "middle",
        nameGap: 48,
        nameTextStyle: { color: C.text, fontSize: 10.5 },
        min: 0,
        axisLine: { show: true, lineStyle: { color: ECHARTS_THEME.border } },
        axisLabel: { color: C.text, fontSize: 10 },
        splitLine: { lineStyle: { color: C.grid } },
      },
      tooltip: {
        trigger: "item",
        backgroundColor: C.hovBg,
        borderColor: C.hovBorder,
        borderWidth: 1,
        textStyle: { color: "#eef4ff", fontSize: 12 },
        formatter: (params: unknown) => {
          const p = params as { seriesIndex?: number; dataIndex?: number; value?: [number, number] };
          if (p?.seriesIndex == null || p?.value == null) return "";
          const modeIndex = branchModeIndices[p.seriesIndex];
          const branch = rows.filter((r) => r.modeIndex === modeIndex);
          const vg = groupVelocity(branch);
          return [
            `<b>Mode ${modeIndex}</b>`,
            `|k| = ${p.value[0].toExponential(4)} m⁻¹`,
            `f = ${p.value[1].toFixed(4)} GHz`,
            `vg ≈ ${fmtVg(vg)}`,
          ].join("<br/>");
        },
      },
      legend: {
        type: "scroll",
        orient: "horizontal",
        bottom: 0,
        left: 0,
        textStyle: { color: C.text, fontSize: 9.5 },
        backgroundColor: "rgba(8,12,24,0.55)",
        borderColor: "rgba(120,140,170,0.2)",
        borderWidth: 1,
      },
      toolbox: {
        show: true,
        top: 4,
        right: 4,
        itemSize: 16,
        iconStyle: { borderColor: "rgba(107,167,255,0.55)", borderWidth: 1 },
        emphasis: { iconStyle: { borderColor: C.text } },
        feature: {
          dataZoom: {},
          restore: { show: true },
          saveAsImage: { type: "png", name: "fullmag_dispersion" },
        },
      },
      dataZoom: [
        { type: "inside", xAxisIndex: 0, yAxisIndex: 0 },
      ],
      series,
    };
  }, [series, branchModeIndices, rows]);

  const handleClick = useCallback(
    (params: echarts.ECElementEvent) => {
      if (params.seriesIndex != null) {
        const modeIndex = branchModeIndices[params.seriesIndex];
        if (modeIndex != null) {
          onSelectMode?.(modeIndex);
        }
      }
    },
    [branchModeIndices, onSelectMode],
  );

  return (
    <DynamicEChart
      option={option}
      className="h-full w-full"
      onClick={handleClick}
    />
  );
}
