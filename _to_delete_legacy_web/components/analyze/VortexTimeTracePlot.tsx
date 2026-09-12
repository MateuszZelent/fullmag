"use client";

import { useMemo } from "react";
import DynamicEChart, { ECHARTS_THEME } from "../plots/DynamicEChart";

import type { VortexTimeSample, VortexChannel } from "./vortexTypes";

const CHANNEL_CONFIG: Record<VortexChannel, { color: string; label: string }> = {
  mx: { color: "#8ec5ff", label: "mₓ(t)" },
  my: { color: "#c3a6ff", label: "m_y(t)" },
  mz: { color: "#6ee7b7", label: "mᵤ(t)" },
};

interface VortexTimeTracePlotProps {
  samples: VortexTimeSample[];
  channels?: VortexChannel[];
  selectedChannel?: VortexChannel | null;
  onSelectChannel?: (ch: VortexChannel) => void;
  /** Time range in ns to show. Null = show all. */
  timeRangeNs?: [number, number] | null;
}

export default function VortexTimeTracePlot({
  samples,
  channels = ["mx", "my", "mz"],
  selectedChannel,
  timeRangeNs,
}: VortexTimeTracePlotProps) {
  const option = useMemo((): echarts.EChartsOption => {
    if (samples.length === 0) return {};

    let filtered = samples;
    if (timeRangeNs) {
      const [tMin, tMax] = timeRangeNs;
      filtered = samples.filter(
        (s) => s.time * 1e9 >= tMin && s.time * 1e9 <= tMax,
      );
    }

    const series: echarts.SeriesOption[] = channels.map((ch) => {
      const cfg = CHANNEL_CONFIG[ch];
      const isActive = !selectedChannel || selectedChannel === ch;
      return {
        type: "line",
        name: cfg.label,
        data: filtered.map((s) => [s.time * 1e9, s[ch]]),
        lineStyle: { color: cfg.color, width: isActive ? 1.5 : 0.8, opacity: isActive ? 1 : 0.3 },
        symbol: "none",
        large: true,
        sampling: "lttb",
      };
    });

    return {
      backgroundColor: "transparent",
      animation: false,
      grid: { left: 55, right: 20, top: 30, bottom: 45 },
      xAxis: {
        type: "value",
        name: "Time [ns]",
        nameLocation: "middle",
        nameGap: 28,
        nameTextStyle: { color: "rgba(200,210,230,0.7)", fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: ECHARTS_THEME.border } },
        axisLabel: { color: "rgba(200,210,230,0.6)", fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(120,140,170,0.12)" } },
      },
      yAxis: {
        type: "value",
        name: "Magnetization",
        nameLocation: "middle",
        nameGap: 38,
        nameTextStyle: { color: "rgba(200,210,230,0.7)", fontSize: 11 },
        min: -1.05,
        max: 1.05,
        axisLine: { show: true, lineStyle: { color: ECHARTS_THEME.border } },
        axisLabel: { color: "rgba(200,210,230,0.6)", fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(120,140,170,0.12)" } },
      },
      tooltip: {
        trigger: "axis",
        backgroundColor: ECHARTS_THEME.tooltipBg,
        borderColor: ECHARTS_THEME.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: ECHARTS_THEME.tooltipText, fontSize: 11 },
      },
      legend: {
        show: true,
        right: 0,
        top: 0,
        textStyle: { color: "rgba(200,210,230,0.8)", fontSize: 10 },
        backgroundColor: "rgba(10,16,28,0.8)",
        borderColor: "rgba(120,140,170,0.2)",
        borderWidth: 1,
        padding: [4, 8],
      },
      series,
    };
  }, [samples, channels, selectedChannel, timeRangeNs]);

  if (samples.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No time-domain data available. Run a TimeEvolution study first.
      </div>
    );
  }

  return <DynamicEChart option={option} className="w-full h-full" />;
}
