"use client";

import { useCallback, useMemo } from "react";
import DynamicEChart, { ECHARTS_THEME } from "../plots/DynamicEChart";
import type * as echarts from "echarts";

import type { EigenModeSummary } from "./eigenTypes";

const C = {
  bg: "transparent",
  text: "rgba(225,232,245,0.9)",
  grid: "rgba(120,140,170,0.16)",
  stem: "rgba(76,110,245,0.38)",
  stemSel: "rgba(255,184,108,0.7)",
  sel: "#ffb86c",
  hovBg: "rgba(10,16,28,0.96)",
  hovBorder: "rgba(132,156,240,0.55)",
} as const;

/** Marker color keyed by dominant polarization label emitted by the solver. */
const POL_COLOR: Record<string, string> = {
  ip: "#8ec5ff",
  in_plane: "#8ec5ff",
  op: "#c3a6ff",
  out_of_plane: "#c3a6ff",
  z: "#6ee7b7",
  uniform: "#f9a8d4",
  mixed: "#fcd34d",
  default: "#9cc0ff",
};

function polColor(pol: string): string {
  const key = pol.toLowerCase().replace(/[\s-]/g, "_");
  return POL_COLOR[key] ?? POL_COLOR.default;
}

function toFrequencyGHz(valueHz: number): number {
  return valueHz / 1e9;
}

interface ModeSpectrumPlotProps {
  modes: EigenModeSummary[];
  selectedMode: number | null;
  onSelectMode?: (modeIndex: number) => void;
}

export default function ModeSpectrumPlot({
  modes,
  selectedMode,
  onSelectMode,
}: ModeSpectrumPlotProps) {
  const option = useMemo((): echarts.EChartsOption => {
    // Stem lines: use a custom series for vertical stems
    const stemData = modes.map((m) => ({
      value: [m.index, toFrequencyGHz(m.frequency_hz)],
      itemStyle: {
        color: m.index === selectedMode ? C.stemSel : C.stem,
      },
    }));

    // Marker data with custom data for click handling
    const markerData = modes.map((m) => ({
      value: [m.index, toFrequencyGHz(m.frequency_hz)],
      itemStyle: {
        color: m.index === selectedMode ? C.sel : polColor(m.dominant_polarization),
        borderColor: "rgba(8,12,24,0.5)",
        borderWidth: 1,
      },
      symbolSize: m.index === selectedMode ? 14 : 9,
      _modeIndex: m.index,
    }));

    const tickVals = modes.length <= 32 ? modes.map((m) => m.index) : undefined;

    return {
      backgroundColor: C.bg,
      animation: false,
      grid: { left: 60, right: 20, top: 36, bottom: 52 },
      xAxis: {
        type: "value",
        name: "Mode index",
        nameLocation: "middle",
        nameGap: 30,
        nameTextStyle: { color: C.text, fontSize: 10.5 },
        axisLine: { show: true, lineStyle: { color: ECHARTS_THEME.border } },
        axisLabel: {
          color: C.text,
          fontSize: 10,
          ...(tickVals ? { interval: 0 } : {}),
        },
        splitLine: { lineStyle: { color: C.grid } },
        min: modes.length > 0 ? modes[0].index - 0.5 : 0,
        max: modes.length > 0 ? modes[modes.length - 1].index + 0.5 : 1,
      },
      yAxis: {
        type: "value",
        name: "f (GHz)",
        nameLocation: "middle",
        nameGap: 42,
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
          const p = params as { dataIndex?: number };
          if (p?.dataIndex == null || !modes[p.dataIndex]) return "";
          const m = modes[p.dataIndex];
          return [
            `<b>Mode ${m.index}</b>  ${(m.frequency_hz / 1e9).toFixed(4)} GHz`,
            `pol: ${m.dominant_polarization}`,
            `max amp: ${m.max_amplitude.toExponential(2)}`,
            m.k_vector
              ? `k: (${m.k_vector.map((v) => v.toExponential(1)).join(", ")})`
              : "k: Γ",
          ].join("<br/>");
        },
      },
      series: [
        // Stem lines via custom series
        {
          type: "custom",
          data: stemData,
          renderItem: (_params: unknown, api: echarts.CustomSeriesRenderItemAPI) => {
            const modeIdx = api.value(0) as number;
            const fGHz = api.value(1) as number;
            const bottom = api.coord([modeIdx, 0]);
            const top = api.coord([modeIdx, fGHz]);
            const isSelected = modes.find((m) => m.index === modeIdx)?.index === selectedMode;
            return {
              type: "line",
              shape: { x1: bottom[0], y1: bottom[1], x2: top[0], y2: top[1] },
              style: {
                stroke: isSelected ? C.stemSel : C.stem,
                lineWidth: isSelected ? 2.5 : 1,
              },
            };
          },
          silent: true,
          z: 1,
        } as echarts.SeriesOption,
        // Markers
        {
          type: "scatter",
          data: markerData,
          symbolSize: (data: unknown) => {
            const d = data as { symbolSize?: number };
            return d?.symbolSize ?? 9;
          },
          z: 2,
        },
      ],
    };
  }, [modes, selectedMode]);

  const handleClick = useCallback(
    (params: echarts.ECElementEvent) => {
      if (params.seriesIndex === 1 && params.dataIndex != null) {
        const mode = modes[params.dataIndex];
        if (mode) {
          onSelectMode?.(mode.index);
        }
      }
    },
    [modes, onSelectMode],
  );

  return (
    <DynamicEChart
      option={option}
      className="h-full w-full"
      onClick={handleClick}
    />
  );
}
