"use client";

import { useMemo } from "react";
import Plot from "../plots/DynamicPlot";

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
  const data = useMemo(() => {
    if (samples.length === 0) return [];

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

    return [
      {
        x: t,
        y: radius,
        type: "scattergl" as const,
        mode: "lines" as const,
        name: "√(mₓ² + m_y²)",
        line: { color: "#8ec5ff", width: 1 },
        opacity: 0.6,
        hovertemplate: "r = %{y:.6f}<br>t = %{x:.4f} ns<extra></extra>",
      },
      {
        x: t,
        y: envelope,
        type: "scattergl" as const,
        mode: "lines" as const,
        name: "Envelope",
        line: { color: "#ffb86c", width: 1.8 },
        hovertemplate: "Envelope: %{y:.6f}<br>t = %{x:.4f} ns<extra></extra>",
      },
    ];
  }, [samples]);

  if (samples.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No orbit data available.
      </div>
    );
  }

  return (
    <Plot
      data={data}
      layout={{
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        margin: { l: 55, r: 20, t: 30, b: 45 },
        xaxis: {
          title: { text: "Time [ns]", font: { size: 11, color: "rgba(200,210,230,0.7)" } },
          gridcolor: "rgba(120,140,170,0.12)",
          tickfont: { size: 10, color: "rgba(200,210,230,0.6)" },
        },
        yaxis: {
          title: {
            text: "Oscillation amplitude",
            font: { size: 11, color: "rgba(200,210,230,0.7)" },
          },
          gridcolor: "rgba(120,140,170,0.12)",
          tickfont: { size: 10, color: "rgba(200,210,230,0.6)" },
          rangemode: "tozero",
        },
        legend: {
          x: 1,
          y: 1,
          xanchor: "right",
          yanchor: "top",
          bgcolor: "rgba(10,16,28,0.8)",
          bordercolor: "rgba(120,140,170,0.2)",
          font: { size: 10, color: "rgba(200,210,230,0.8)" },
        },
        hovermode: "x unified",
        hoverlabel: {
          bgcolor: "rgba(10,16,28,0.96)",
          bordercolor: "rgba(132,156,240,0.55)",
          font: { size: 11, color: "rgba(225,232,245,0.9)" },
        },
        autosize: true,
      }}
      config={{ responsive: true, displayModeBar: false }}
      useResizeHandler
      className="w-full h-full"
    />
  );
}
