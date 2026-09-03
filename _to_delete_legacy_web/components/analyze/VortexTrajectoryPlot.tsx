"use client";

import { useMemo } from "react";
import DynamicEChart, { ECHARTS_THEME } from "../plots/DynamicEChart";

import type { VortexTimeSample } from "./vortexTypes";

interface VortexTrajectoryPlotProps {
  samples: VortexTimeSample[];
  /** Disk radius for drawing the boundary circle [nm]. */
  diskRadiusNm?: number;
}

/**
 * Plots the in-plane magnetization trajectory (mx(t) vs my(t)).
 *
 * For a vortex, this shows the gyrotropic orbit of the average
 * magnetization, which is a proxy for the vortex core displacement.
 * A true core position requires spatial data; this uses the
 * spatially-averaged mx/my which is available from scalar outputs.
 */
export default function VortexTrajectoryPlot({
  samples,
}: VortexTrajectoryPlotProps) {
  const option = useMemo((): echarts.EChartsOption => {
    if (samples.length === 0) return {};

    const mx = samples.map((s) => s.mx);
    const my = samples.map((s) => s.my);
    const last = samples[samples.length - 1];

    return {
      backgroundColor: "transparent",
      animation: false,
      grid: { left: 55, right: 20, top: 30, bottom: 50 },
      xAxis: {
        type: "value",
        name: "mₓ",
        nameLocation: "middle",
        nameGap: 32,
        nameTextStyle: { color: "rgba(200,210,230,0.7)", fontSize: 12 },
        axisLine: { show: true, lineStyle: { color: ECHARTS_THEME.border } },
        axisLabel: { color: "rgba(200,210,230,0.6)", fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(120,140,170,0.12)" } },
      },
      yAxis: {
        type: "value",
        name: "m_y",
        nameLocation: "middle",
        nameGap: 38,
        nameTextStyle: { color: "rgba(200,210,230,0.7)", fontSize: 12 },
        axisLine: { show: true, lineStyle: { color: ECHARTS_THEME.border } },
        axisLabel: { color: "rgba(200,210,230,0.6)", fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(120,140,170,0.12)" } },
      },
      tooltip: {
        trigger: "item",
        backgroundColor: ECHARTS_THEME.tooltipBg,
        borderColor: ECHARTS_THEME.tooltipBorder,
        borderWidth: 1,
        textStyle: { color: ECHARTS_THEME.tooltipText, fontSize: 11 },
        formatter: (params: unknown) => {
          const p = params as { data?: [number, number] };
          if (!p?.data) return "";
          return `mₓ = ${p.data[0].toFixed(6)}<br/>m_y = ${p.data[1].toFixed(6)}`;
        },
      },
      graphic: [{
        type: "circle",
        shape: { cx: 0, cy: 0, r: 1 },
        style: { stroke: "rgba(120,140,170,0.15)", lineWidth: 1, lineDash: [4, 4], fill: "none" },
        // Position will be computed by ECharts coordinate system
      }],
      series: [
        {
          type: "line",
          name: "Trajectory",
          data: mx.map((x, i) => [x, my[i]]),
          lineStyle: { color: "rgba(142,197,255,0.75)", width: 1.2 },
          symbol: "none",
          silent: true,
        },
        {
          type: "scatter",
          name: "Start",
          data: [[samples[0].mx, samples[0].my]],
          symbolSize: 8,
          itemStyle: { color: "#4c6ef5" },
        },
        {
          type: "scatter",
          name: "End",
          data: [[last.mx, last.my]],
          symbolSize: 8,
          symbol: "diamond",
          itemStyle: { color: "#ffb86c" },
        },
      ],
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
    };
  }, [samples]);

  if (samples.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No trajectory data available.
      </div>
    );
  }

  return <DynamicEChart option={option} className="w-full h-full" />;
}
