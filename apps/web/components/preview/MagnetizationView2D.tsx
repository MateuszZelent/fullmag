"use client";

import { useEffect, useRef, useState } from "react";

interface Props {
  grid: [number, number, number];
  magnetization: Float64Array | null;
}

type Component = "mx" | "my" | "mz" | "magnitude";

const PALETTES: Record<Component, string[][]> = {
  mx: [
    ["0", "#2166ac"],
    ["0.25", "#67a9cf"],
    ["0.5", "#f7f7f7"],
    ["0.75", "#ef8a62"],
    ["1", "#b2182b"],
  ],
  my: [
    ["0", "#1b7837"],
    ["0.25", "#7fbf7b"],
    ["0.5", "#f7f7f7"],
    ["0.75", "#d6604d"],
    ["1", "#8e0152"],
  ],
  mz: [
    ["0", "#2d004b"],
    ["0.25", "#7570b3"],
    ["0.5", "#f7f7f7"],
    ["0.75", "#d95f02"],
    ["1", "#7f3b08"],
  ],
  magnitude: [
    ["0", "#0d0887"],
    ["0.25", "#6a00a8"],
    ["0.5", "#b12a90"],
    ["0.75", "#e16462"],
    ["1", "#fca636"],
  ],
};

const LABELS: Record<Component, string> = {
  mx: "mₓ",
  my: "m_y",
  mz: "m_z",
  magnitude: "|m|",
};

export default function MagnetizationView2D({ grid, magnetization }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const [component, setComponent] = useState<Component>("mz");
  const [zSlice, setZSlice] = useState(0);
  const [nx, ny, nz] = grid;

  // Initialize ECharts
  useEffect(() => {
    if (!containerRef.current) return;

    let chart: any = null;
    import("echarts").then((ec) => {
      if (!containerRef.current) return;
      chart = ec.init(containerRef.current, "dark");
      chartRef.current = chart;

      const observer = new ResizeObserver(() => chart?.resize());
      observer.observe(containerRef.current);

      return () => {
        observer.disconnect();
        chart?.dispose();
        chartRef.current = null;
      };
    });

    return () => {
      chart?.dispose();
      chartRef.current = null;
    };
  }, []);

  // Update data
  useEffect(() => {
    if (!chartRef.current || !magnetization || nx === 0 || ny === 0) return;

    const data: [number, number, number][] = [];
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const cellIdx = zSlice * nx * ny + iy * nx + ix;
        const base = cellIdx * 3;
        const mx = magnetization[base];
        const my = magnetization[base + 1];
        const mz = magnetization[base + 2];

        let val: number;
        switch (component) {
          case "mx":
            val = mx;
            break;
          case "my":
            val = my;
            break;
          case "mz":
            val = mz;
            break;
          case "magnitude":
            val = Math.sqrt(mx * mx + my * my + mz * mz);
            break;
        }

        data.push([ix, iy, val]);
        if (val < minVal) minVal = val;
        if (val > maxVal) maxVal = val;
      }
    }

    // For component views, center the scale around 0
    const isComponent = component !== "magnitude";
    const absMax = Math.max(Math.abs(minVal), Math.abs(maxVal), 0.001);
    const rangeMin = isComponent ? -absMax : minVal;
    const rangeMax = isComponent ? absMax : maxVal;

    chartRef.current.setOption({
      backgroundColor: "transparent",
      tooltip: {
        formatter: (params: any) => {
          const [ix, iy, val] = params.data;
          return `Cell [${ix}, ${iy}, ${zSlice}]<br/>${LABELS[component]}: ${val.toFixed(4)}`;
        },
      },
      grid: { left: 60, right: 80, top: 24, bottom: 40 },
      xAxis: {
        type: "category",
        data: Array.from({ length: nx }, (_, i) => i),
        name: "x",
        splitArea: { show: false },
      },
      yAxis: {
        type: "category",
        data: Array.from({ length: ny }, (_, i) => i),
        name: "y",
        splitArea: { show: false },
      },
      visualMap: {
        min: rangeMin,
        max: rangeMax,
        calculable: true,
        orient: "vertical",
        right: 0,
        top: "center",
        inRange: {
          color: PALETTES[component].map((p) => p[1]),
        },
        textStyle: { color: "#ccc", fontSize: 10 },
        formatter: (v: number) => v.toFixed(2),
      },
      series: [
        {
          type: "heatmap",
          data,
          emphasis: {
            itemStyle: { borderColor: "#fff", borderWidth: 1 },
          },
          progressive: 0,
        },
      ],
      animation: false,
    });
  }, [magnetization, component, zSlice, nx, ny, nz]);

  return (
    <div>
      {/* Controls */}
      <div className="flex items-center gap-[var(--sp-3)] border-b border-[var(--border)] px-[var(--sp-4)] py-[var(--sp-3)]">
        <label className="text-[var(--text-sm)] text-[var(--text-muted)]">
          Component
        </label>
        <select
          value={component}
          onChange={(e) => setComponent(e.target.value as Component)}
          className="rounded-[var(--radius-md)] border border-[var(--border)] bg-[var(--bg-raised)] px-[var(--sp-3)] py-[var(--sp-1)] text-[var(--text-sm)] text-[var(--text-primary)]"
        >
          <option value="mx">mₓ</option>
          <option value="my">mᵧ</option>
          <option value="mz">m_z</option>
          <option value="magnitude">|m|</option>
        </select>

        {nz > 1 && (
          <>
            <label className="ml-[var(--sp-4)] text-[var(--text-sm)] text-[var(--text-muted)]">
              z-slice
            </label>
            <input
              type="range"
              min={0}
              max={nz - 1}
              value={zSlice}
              onChange={(e) => setZSlice(parseInt(e.target.value))}
              className="w-20"
            />
            <span className="font-mono text-[var(--text-sm)] text-[var(--text-muted)]">
              {zSlice}/{nz - 1}
            </span>
          </>
        )}
      </div>

      {/* Chart */}
      <div
        ref={containerRef}
        className="h-[400px] w-full bg-[#0d1117]"
      />
    </div>
  );
}
