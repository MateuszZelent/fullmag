"use client";

import { useMemo } from "react";
import Plot from "../plots/DynamicPlot";

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
  diskRadiusNm,
}: VortexTrajectoryPlotProps) {
  const data = useMemo(() => {
    if (samples.length === 0) return [];

    const traces: Plotly.Data[] = [];

    // Full trajectory (color-coded by time)
    traces.push({
      x: samples.map((s) => s.mx),
      y: samples.map((s) => s.my),
      type: "scattergl",
      mode: "lines",
      name: "Trajectory",
      line: {
        color: "rgba(142,197,255,0.75)",
        width: 1.2,
      },
      hovertemplate:
        "mₓ = %{x:.6f}<br>m_y = %{y:.6f}<extra></extra>",
    });

    // Start marker
    traces.push({
      x: [samples[0].mx],
      y: [samples[0].my],
      type: "scatter",
      mode: "markers",
      name: "Start",
      marker: { color: "#4c6ef5", size: 8, symbol: "circle" },
      showlegend: true,
    });

    // End marker
    const last = samples[samples.length - 1];
    traces.push({
      x: [last.mx],
      y: [last.my],
      type: "scatter",
      mode: "markers",
      name: "End",
      marker: { color: "#ffb86c", size: 8, symbol: "diamond" },
      showlegend: true,
    });

    return traces;
  }, [samples]);

  const shapes = useMemo(() => {
    const s: Partial<Plotly.Shape>[] = [];
    // Unit circle boundary (magnetization must lie inside |m| <= 1)
    s.push({
      type: "circle",
      xref: "x",
      yref: "y",
      x0: -1,
      y0: -1,
      x1: 1,
      y1: 1,
      line: { color: "rgba(120,140,170,0.15)", width: 1, dash: "dot" },
    });
    return s;
  }, []);

  if (samples.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No trajectory data available.
      </div>
    );
  }

  return (
    <Plot
      data={data}
      layout={{
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        margin: { l: 55, r: 20, t: 30, b: 50 },
        xaxis: {
          title: { text: "mₓ", font: { size: 12, color: "rgba(200,210,230,0.7)" } },
          gridcolor: "rgba(120,140,170,0.12)",
          zerolinecolor: "rgba(120,140,170,0.25)",
          tickfont: { size: 10, color: "rgba(200,210,230,0.6)" },
          scaleanchor: "y",
          scaleratio: 1,
        },
        yaxis: {
          title: { text: "m_y", font: { size: 12, color: "rgba(200,210,230,0.7)" } },
          gridcolor: "rgba(120,140,170,0.12)",
          zerolinecolor: "rgba(120,140,170,0.25)",
          tickfont: { size: 10, color: "rgba(200,210,230,0.6)" },
        },
        shapes,
        legend: {
          x: 1,
          y: 1,
          xanchor: "right",
          yanchor: "top",
          bgcolor: "rgba(10,16,28,0.8)",
          bordercolor: "rgba(120,140,170,0.2)",
          font: { size: 10, color: "rgba(200,210,230,0.8)" },
        },
        hovermode: "closest",
        hoverlabel: {
          bgcolor: "rgba(10,16,28,0.96)",
          bordercolor: "rgba(132,156,240,0.55)",
          font: { size: 11, color: "rgba(225,232,245,0.9)" },
        },
        autosize: true,
      }}
      config={{ responsive: true, displayModeBar: false }}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}
