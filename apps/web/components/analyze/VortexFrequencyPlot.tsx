"use client";

import { useMemo } from "react";
import Plot from "../plots/DynamicPlot";

import type { VortexSpectrumResult, LinewidthResult } from "./vortexTypes";


const CH_COLORS = {
  mx: "#8ec5ff",
  my: "#c3a6ff",
  mz: "#6ee7b7",
} as const;

interface VortexFrequencyPlotProps {
  spectrum: VortexSpectrumResult | null;
  linewidth?: LinewidthResult | null;
  /** If set, only show PSD for these channels. */
  channels?: ("mx" | "my" | "mz")[];
  logScale?: boolean;
}

function fmtGHz(hz: number): string {
  return `${(hz / 1e9).toFixed(3)} GHz`;
}

export default function VortexFrequencyPlot({
  spectrum,
  linewidth,
  channels = ["mx", "my", "mz"],
  logScale = true,
}: VortexFrequencyPlotProps) {
  const data = useMemo(() => {
    if (!spectrum || spectrum.frequencies.length === 0) return [];

    const freqGHz = spectrum.frequencies.map((f) => f / 1e9);
    const traces: Plotly.Data[] = [];

    const psdMap: Record<string, number[]> = {
      mx: spectrum.psd_mx,
      my: spectrum.psd_my,
      mz: spectrum.psd_mz,
    };

    for (const ch of channels) {
      traces.push({
        x: freqGHz,
        y: psdMap[ch],
        type: "scattergl",
        mode: "lines",
        name: `PSD(${ch})`,
        line: { color: CH_COLORS[ch], width: 1.3 },
        hovertemplate: `${ch}: %{y:.3e}<br>f = %{x:.4f} GHz<extra></extra>`,
      });
    }

    // Peak frequency marker
    if (spectrum.peak_frequency_hz != null) {
      const peakGHz = spectrum.peak_frequency_hz / 1e9;
      const peakCh = spectrum.peak_channel ?? "mx";
      const peakPsd = psdMap[peakCh];
      const peakIdx = spectrum.frequencies.findIndex(
        (f) => Math.abs(f - spectrum.peak_frequency_hz!) < 1,
      );
      const peakVal = peakIdx >= 0 ? peakPsd[peakIdx] : 0;

      traces.push({
        x: [peakGHz],
        y: [peakVal],
        type: "scatter",
        mode: "text+markers",
        name: `Peak: ${fmtGHz(spectrum.peak_frequency_hz)}`,
        marker: { color: "#ffb86c", size: 10, symbol: "diamond" },
        text: [fmtGHz(spectrum.peak_frequency_hz)],
        textposition: "top center",
        textfont: { color: "#ffb86c", size: 10 },
        showlegend: true,
      });
    }

    // Linewidth annotation
    if (linewidth && linewidth.fwhm_hz > 0) {
      const fLow = (linewidth.f_center_hz - linewidth.fwhm_hz / 2) / 1e9;
      const fHigh = (linewidth.f_center_hz + linewidth.fwhm_hz / 2) / 1e9;
      traces.push({
        x: [fLow, fHigh],
        y: [linewidth.peak_power / 2, linewidth.peak_power / 2],
        type: "scatter",
        mode: "lines",
        name: `FWHM: ${(linewidth.fwhm_hz / 1e6).toFixed(1)} MHz`,
        line: { color: "#ff5555", width: 2, dash: "dash" },
        showlegend: true,
      });
    }

    return traces;
  }, [spectrum, linewidth, channels]);

  if (!spectrum || spectrum.frequencies.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No spectrum data. Collect enough time-domain samples first.
      </div>
    );
  }

  return (
    <Plot
      data={data}
      layout={{
        paper_bgcolor: "transparent",
        plot_bgcolor: "transparent",
        margin: { l: 60, r: 20, t: 30, b: 45 },
        xaxis: {
          title: { text: "Frequency [GHz]", font: { size: 11, color: "rgba(200,210,230,0.7)" } },
          gridcolor: "rgba(120,140,170,0.12)",
          zerolinecolor: "rgba(120,140,170,0.2)",
          tickfont: { size: 10, color: "rgba(200,210,230,0.6)" },
        },
        yaxis: {
          title: { text: "PSD [a.u.]", font: { size: 11, color: "rgba(200,210,230,0.7)" } },
          type: logScale ? "log" : "linear",
          gridcolor: "rgba(120,140,170,0.12)",
          zerolinecolor: "rgba(120,140,170,0.2)",
          tickfont: { size: 10, color: "rgba(200,210,230,0.6)" },
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
