import type { SpinWaveGammaResource } from "@/kernel/api/apiTypes";
import { ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH } from "@/kernel/api/apiPaths";

import type { ChartSeries } from "./chartTableModel";

function gammaSource() {
  return {
    kind: "analysis.spin_wave" as const,
    resourceKey: ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH,
    tableId: "spin-wave-gamma",
  };
}

export function spinWaveGammaSeries(
  resource: SpinWaveGammaResource | null,
): ChartSeries[] {
  if (!resource) return [];
  const source = gammaSource();
  return [
    {
      id: "gamma-response-psd",
      label: "SΓ = P₁ + P₂",
      points: resource.frequency_hz.map((x, rowIndex) => ({
        rowIndex,
        x,
        y: resource.response_psd[rowIndex] ?? 0,
      })),
      quantity: "response_psd",
      source,
      status: "ready",
      unit: `${resource.trace_unit}²`,
      xUnit: resource.frequency_unit,
    },
    {
      id: "gamma-source-psd",
      label: "Γ source PSD",
      points: resource.frequency_hz.map((x, rowIndex) => ({
        rowIndex,
        x,
        y: resource.source_psd[rowIndex] ?? 0,
      })),
      quantity: "source_psd",
      source,
      status: "ready",
      unit: `(${resource.source_unit})²`,
      xUnit: resource.frequency_unit,
    },
  ];
}

export function spinWaveGammaResponseTraceSeries(
  resource: SpinWaveGammaResource | null,
): ChartSeries[] {
  if (!resource) return [];
  return [{
    id: "gamma-response-trace-primary",
    label: `Δ${resource.transverse_components[0]}`,
    points: resource.time_s.map((x, rowIndex) => ({ rowIndex, x, y: resource.response_trace[rowIndex] ?? 0 })),
    quantity: "response_trace",
    source: gammaSource(),
    status: "ready",
    unit: resource.trace_unit,
    xUnit: resource.time_unit,
  }, {
    id: "gamma-response-trace-secondary",
    label: `Δ${resource.transverse_components[1]}`,
    points: resource.time_s.map((x, rowIndex) => ({ rowIndex, x, y: resource.secondary_response_trace[rowIndex] ?? 0 })),
    quantity: "secondary_response_trace",
    source: gammaSource(),
    status: "ready",
    unit: resource.trace_unit,
    xUnit: resource.time_unit,
  }];
}

export function spinWaveGammaSourceTraceSeries(
  resource: SpinWaveGammaResource | null,
): ChartSeries[] {
  if (!resource) return [];
  return [{
    id: "gamma-source-trace",
    label: "Drive H(t)",
    points: resource.time_s.map((x, rowIndex) => ({ rowIndex, x, y: resource.source_trace[rowIndex] ?? 0 })),
    quantity: "source_trace",
    source: gammaSource(),
    status: "ready",
    unit: resource.source_unit,
    xUnit: resource.time_unit,
  }];
}
