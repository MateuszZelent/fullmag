import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH } from "@/kernel/api/apiPaths";

import { SpinWaveGammaView } from "./SpinWaveGammaView";
import {
  spinWaveGammaFeatureSelection,
  spinWaveGammaResponseTraceSeries,
  spinWaveGammaSamplingSummary,
  spinWaveGammaSeries,
  spinWaveGammaSourceTraceSeries,
} from "./spinWaveGammaModel";

describe("spinWaveGammaModel", () => {
  it("builds unit-aware response and source spectra", () => {
    const seriesFixture = {
      schema_version: "spin_wave_response.gamma.v1",
      time_unit: "s",
      frequency_unit: "Hz",
      trace_unit: "1",
      source_unit: "A/m",
      susceptibility_unit: "m/A",
      weighting: "Ms_times_lumped_volume",
      detrend: "linear",
      window: "hann",
      normalization: "one_sided_abs_fft_squared_over_N_sum_window_squared",
      reference_m0: 0,
      reference_m0_secondary: 0,
      response_component: "my",
      transverse_components: ["my", "mz"] as [string, string],
      time_s: [0, 1],
      response_trace: [0, 1],
      secondary_response_trace: [0, 0.25],
      source_trace: [0, 0.5],
      frequency_hz: [0, 1e9],
      response_psd: [0, 4],
      primary_response_psd: [0, 3],
      secondary_response_psd: [0, 1],
      source_psd: [0, 1],
      response_spectrum_real: [0, 2],
      response_spectrum_imag: [0, 0],
      secondary_response_spectrum_real: [0, 1],
      secondary_response_spectrum_imag: [0, 0],
      source_spectrum_real: [0, 1],
      source_spectrum_imag: [0, 0],
      window_values: [0, 0],
      window_power_sum: 0,
      nyquist_hz: 1e9,
      susceptibility_abs: [null, 2],
      peaks: [],
    };
    const series = spinWaveGammaSeries(seriesFixture);
    expect(series).toHaveLength(2);
    expect(series[0].xUnit).toBe("Hz");
    expect(series[0].points[1].y).toBe(4);
    expect(spinWaveGammaResponseTraceSeries(seriesFixture)).toHaveLength(2);
    expect(spinWaveGammaResponseTraceSeries(seriesFixture)[0].unit).toBe("1");
    expect(spinWaveGammaSourceTraceSeries(seriesFixture)[0].unit).toBe("A/m");
    expect(spinWaveGammaSeries(seriesFixture).map((entry) => ({
      dataRevision: entry.dataRevision ?? null,
      id: entry.id,
      points: entry.points,
      source: entry.source,
      status: entry.status,
      unit: entry.unit,
      xUnit: entry.xUnit,
    }))).toEqual([
      { dataRevision: null, id: "gamma-response-psd", points: [{ rowIndex: 0, x: 0, y: 0 }, { rowIndex: 1, x: 1e9, y: 4 }], source: { kind: "analysis.spin_wave", resourceKey: ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH, tableId: "spin-wave-gamma" }, status: "ready", unit: "1²", xUnit: "Hz" },
      { dataRevision: null, id: "gamma-source-psd", points: [{ rowIndex: 0, x: 0, y: 0 }, { rowIndex: 1, x: 1e9, y: 1 }], source: { kind: "analysis.spin_wave", resourceKey: ANALYSIS_SPIN_WAVE_GAMMA_V1_PATH, tableId: "spin-wave-gamma" }, status: "ready", unit: "(A/m)²", xUnit: "Hz" },
    ]);
    expect(spinWaveGammaSamplingSummary(seriesFixture)).toMatchObject({
      status: "ready",
      sampleCount: 2,
      samplePeriodS: 1,
      frequencyResolutionHz: 1e9,
      nyquistHz: 1e9,
    });
  });

  it("fails closed for a nonuniform response time axis", () => {
    const summary = spinWaveGammaSamplingSummary({
      time_s: [0, 1e-12, 2.2e-12],
      frequency_hz: [0, 1e9],
      nyquist_hz: 5e11,
    } as never);
    expect(summary.status).toBe("nonuniform");
    expect(summary.message).toContain("Nonuniform");
  });

  it("builds stable result identity for a legacy gamma spectral feature", () => {
    expect(spinWaveGammaFeatureSelection({ frequency_hz: 12.5e9, index: 7, power: 0.25 })).toEqual({
      frequencyHz: 12.5e9,
      itemId: "legacy:gamma:peak:7",
      itemKind: "spectral_feature",
      ordinal: 7,
      peakIndex: 7,
      power: 0.25,
      sampleId: "gamma-spectrum-sample-0000",
    });
  });

  it("renders gamma peak rows as keyboard-activatable result selections", () => {
    const resource = {
      detrend: "linear",
      frequency_hz: [0, 12.5e9],
      frequency_unit: "Hz",
      nyquist_hz: 5e11,
      peaks: [{ frequency_hz: 12.5e9, index: 7, power: 0.25 }],
      response_psd: [0, 0.25],
      response_trace: [0, 1],
      schema_version: "spin_wave_response.gamma.v1",
      secondary_response_trace: [0, 0],
      source_psd: [0, 0],
      source_trace: [0, 0],
      source_unit: "A/m",
      time_s: [0, 1e-12],
      time_unit: "s",
      trace_unit: "1",
      transverse_components: ["my", "mz"],
      weighting: "Ms_times_lumped_volume",
      window: "hann",
    } as never;

    const html = renderToStaticMarkup(createElement(SpinWaveGammaView, { resource, status: "ready" }));

    expect(html).toContain('aria-label="Select spectral feature 7"');
    expect(html).toContain('data-result-item-id="legacy:gamma:peak:7"');
    expect(html).toContain('tabindex="0"');
  });
});
