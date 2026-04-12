"use client";

import { useMemo } from "react";
import Plot from "../plots/DynamicPlot";

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
  const data = useMemo(() => {
    if (samples.length === 0) return [];

    let filtered = samples;
    if (timeRangeNs) {
      const [tMin, tMax] = timeRangeNs;
      filtered = samples.filter(
        (s) => s.time * 1e9 >= tMin && s.time * 1e9 <= tMax,
      );
    }

    return channels.map((ch) => {
      const cfg = CHANNEL_CONFIG[ch];
      const isActive = !selectedChannel || selectedChannel === ch;
      return {
        x: filtered.map((s) => s.time * 1e9), // ns
        y: filtered.map((s) => s[ch]),
        type: "scattergl" as const,
        mode: "lines" as const,
        name: cfg.label,
        line: {
          color: cfg.color,
          width: isActive ? 1.5 : 0.8,
        },
        opacity: isActive ? 1 : 0.3,
        hovertemplate: `${cfg.label}: %{y:.6f}<br>t = %{x:.4f} ns<extra></extra>`,
      };
    });
  }, [samples, channels, selectedChannel, timeRangeNs]);

  if (samples.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No time-domain data available. Run a TimeEvolution study first.
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
          zerolinecolor: "rgba(120,140,170,0.2)",
          tickfont: { size: 10, color: "rgba(200,210,230,0.6)" },
        },
        yaxis: {
          title: { text: "Magnetization", font: { size: 11, color: "rgba(200,210,230,0.7)" } },
          gridcolor: "rgba(120,140,170,0.12)",
          zerolinecolor: "rgba(120,140,170,0.2)",
          tickfont: { size: 10, color: "rgba(200,210,230,0.6)" },
          range: [-1.05, 1.05],
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
      style={{ width: "100%", height: "100%" }}
    />
  );
}
