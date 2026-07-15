import { describe, expect, it } from "vitest";

import { spinWaveGammaResponseTraceSeries, spinWaveGammaSeries, spinWaveGammaSourceTraceSeries } from "./spinWaveGammaModel";

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
  });
});
