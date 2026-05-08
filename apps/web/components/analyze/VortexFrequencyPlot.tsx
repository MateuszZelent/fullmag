"use client";

import { useMemo } from "react";
import DynamicEChart, { ECHARTS_THEME } from "../plots/DynamicEChart";

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
  const option = useMemo((): echarts.EChartsOption => {
    if (!spectrum || spectrum.frequencies.length === 0) return {};

    const freqGHz = spectrum.frequencies.map((f) => f / 1e9);
    const psdMap: Record<string, number[]> = {
      mx: spectrum.psd_mx,
      my: spectrum.psd_my,
      mz: spectrum.psd_mz,
    };

    const series: echarts.SeriesOption[] = channels.map((ch) => ({
      type: "line" as const,
      name: `PSD(${ch})`,
      data: freqGHz.map((f, i) => [f, psdMap[ch][i]]),
      lineStyle: { color: CH_COLORS[ch], width: 1.3 },
      symbol: "none",
      large: true,
      sampling: "lttb",
    }));

    // Peak frequency marker
    if (spectrum.peak_frequency_hz != null) {
      const peakGHz = spectrum.peak_frequency_hz / 1e9;
      const peakCh = spectrum.peak_channel ?? "mx";
      const peakPsd = psdMap[peakCh];
      const peakIdx = spectrum.frequencies.findIndex(
        (f) => Math.abs(f - spectrum.peak_frequency_hz!) < 1,
      );
      const peakVal = peakIdx >= 0 ? peakPsd[peakIdx] : 0;

      series.push({
        type: "scatter",
        name: `Peak: ${fmtGHz(spectrum.peak_frequency_hz)}`,
        data: [[peakGHz, peakVal]],
        symbolSize: 10,
        symbol: "diamond",
        itemStyle: { color: "#ffb86c" },
        label: {
          show: true,
          formatter: fmtGHz(spectrum.peak_frequency_hz),
          position: "top",
          color: "#ffb86c",
          fontSize: 10,
        },
      });
    }

    // Linewidth annotation
    if (linewidth && linewidth.fwhm_hz > 0) {
      const fLow = (linewidth.f_center_hz - linewidth.fwhm_hz / 2) / 1e9;
      const fHigh = (linewidth.f_center_hz + linewidth.fwhm_hz / 2) / 1e9;
      series.push({
        type: "line",
        name: `FWHM: ${(linewidth.fwhm_hz / 1e6).toFixed(1)} MHz`,
        data: [[fLow, linewidth.peak_power / 2], [fHigh, linewidth.peak_power / 2]],
        lineStyle: { color: "#ff5555", width: 2, type: "dashed" },
        symbol: "none",
      });
    }

    return {
      backgroundColor: "transparent",
      animation: false,
      grid: { left: 60, right: 20, top: 30, bottom: 45 },
      xAxis: {
        type: "value",
        name: "Frequency [GHz]",
        nameLocation: "middle",
        nameGap: 28,
        nameTextStyle: { color: "rgba(200,210,230,0.7)", fontSize: 11 },
        axisLine: { show: true, lineStyle: { color: ECHARTS_THEME.border } },
        axisLabel: { color: "rgba(200,210,230,0.6)", fontSize: 10 },
        splitLine: { lineStyle: { color: "rgba(120,140,170,0.12)" } },
      },
      yAxis: {
        type: logScale ? "log" : "value",
        name: "PSD [a.u.]",
        nameLocation: "middle",
        nameGap: 42,
        nameTextStyle: { color: "rgba(200,210,230,0.7)", fontSize: 11 },
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
  }, [spectrum, linewidth, channels, logScale]);

  if (!spectrum || spectrum.frequencies.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        No spectrum data. Collect enough time-domain samples first.
      </div>
    );
  }

  return <DynamicEChart option={option} className="w-full h-full" />;
}
