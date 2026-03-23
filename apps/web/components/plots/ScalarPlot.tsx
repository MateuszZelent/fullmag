"use client";

import { useEffect, useRef } from "react";
import type { StepStats } from "../../lib/useSimulation";

declare const echarts: any;

interface Props {
  steps: StepStats[];
  yField?: "e_ex" | "max_dm_dt" | "max_h_eff";
}

const FIELD_LABELS: Record<string, string> = {
  e_ex: "Exchange Energy (J)",
  max_dm_dt: "max |dm/dt|",
  max_h_eff: "max |H_eff| (A/m)",
};

export default function ScalarPlot({ steps, yField = "e_ex" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    // Dynamic import of echarts
    import("echarts").then((ec) => {
      if (!containerRef.current) return;
      const chart = ec.init(containerRef.current, "dark");
      chartRef.current = chart;

      const observer = new ResizeObserver(() => chart.resize());
      observer.observe(containerRef.current);

      return () => {
        observer.disconnect();
        chart.dispose();
        chartRef.current = null;
      };
    });
  }, []);

  useEffect(() => {
    if (!chartRef.current || steps.length === 0) return;

    const times = steps.map((s) => s.time.toExponential(2));
    const values = steps.map((s) => s[yField]);

    chartRef.current.setOption({
      backgroundColor: "transparent",
      tooltip: {
        trigger: "axis",
        formatter: (params: any) => {
          const p = params[0];
          return `t = ${steps[p.dataIndex].time.toExponential(3)} s<br/>${FIELD_LABELS[yField]}: ${p.value.toExponential(4)}`;
        },
      },
      grid: { left: 80, right: 24, top: 32, bottom: 40 },
      xAxis: {
        type: "category",
        data: times,
        name: "Time (s)",
        nameLocation: "center",
        nameGap: 28,
        axisLabel: { fontSize: 10, rotate: 30 },
      },
      yAxis: {
        type: "value",
        name: FIELD_LABELS[yField],
        nameLocation: "center",
        nameGap: 60,
        axisLabel: {
          formatter: (v: number) => v.toExponential(1),
        },
      },
      series: [
        {
          type: "line",
          data: values,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 2, color: "#58a6ff" },
          areaStyle: {
            color: {
              type: "linear",
              x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(88,166,255,0.3)" },
                { offset: 1, color: "rgba(88,166,255,0)" },
              ],
            },
          },
        },
      ],
      animation: false,
    });
  }, [steps, yField]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "300px",
        borderRadius: "var(--radius-lg)",
        overflow: "hidden",
      }}
    />
  );
}
