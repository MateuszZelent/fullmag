"use client";

import { useMemo } from "react";
import DynamicEChart, { ECHARTS_THEME } from "../plots/DynamicEChart";

import type { VortexTimeSample } from "./vortexTypes";

interface VortexOrbitPlotProps {
  samples: VortexTimeSample[];
}

/**
 * Shows the in-plane oscillation amplitude and radius over time.
 *
 * Plots sqrt(mx²+my²) which serves as a proxy for vortex core displacement
 * when full spatial data isn't available.
 */
export default function VortexOrbitPlot({ samples }: VortexOrbitPlotProps) {
  const option = useMemo((): echarts.EChartsOption => {
    if (samples.length === 0) return {};

    const t = samples.map((s) => s.time * 1e9);
    const radius = samples.map((s) => Math.sqrt(s.mx * s.mx + s.my * s.my));

    // Envelope via running max over a window
    const envWindow = Math.max(1, Math.floor(samples.length / 100));
    const envelope: number[] = [];
    for (let i = 0; i < radius.length; i++) {
      let maxVal = 0;
      for (let j = Math.max(0, i - envWindow); j <= Math.min(radius.length - 1, i + envWindow); j++) {
        if (radius[j] > maxVal) maxVal = radius[j];
      }
      envelope.push(maxVal);
    }

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
        name: "Oscillation amplitude",
        nameLocation: "middle",
        nameGap: 38,
        nameTextStyle: { color: "rgba(200,210,230,0.7)", fontSize: 11 },
        min: 0,
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
      series: [
        {
          type: "line",
          name: "√(mₓ² + m_y²)",
          data: t.map((ti, i) => [ti, radius[i]]),
          lineStyle: { color: "#8ec5ff", width: 1, opacity: 0.6 },
          symbol: "none",
          large: true,
          sampling: "lttb",
        },
        {
          type: "line",
          name: "Envelope",
          data: t.map((ti, i) => [ti, envelope[i]]),
          lineStyle: { color: "#ffb86c", width: 1.8 },
          symbol: "none",
          large: true,
          sampling: "lttb",
        },
      ],
    };
  }, [samples]);

  if (samples.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No orbit data available.
      </div>
    );
  }

  return <DynamicEChart option={option} className="w-full h-full" />;
}
