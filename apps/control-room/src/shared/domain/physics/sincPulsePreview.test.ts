import { describe, expect, it } from "vitest";

import { buildSincPulsePreview } from "./sincPulsePreview";

describe("buildSincPulsePreview", () => {
  it("uses declared autosave sampling and centers the pulse at t0", () => {
    const model = buildSincPulsePreview({
      cutoffHz: 20e9,
      t0S: 50e-12,
      waveformAmplitude: 1,
      fieldAmplitudeT: 1e-3,
      samplePeriodS: 0.5e-12,
      durationS: 100e-12,
    });

    expect(model.status).toBe("ready");
    expect(model.sampleCount).toBe(200);
    expect(model.samplePeriodS).toBe(0.5e-12);
    expect(model.frequencyResolutionHz).toBeCloseTo(1 / (200 * 0.5e-12));
    expect(model.nyquistHz).toBe(1e12);
    expect(model.waveform.at(-1)?.timeS).toBeCloseTo(99.5e-12);
    const center = model.waveform.reduce((best, point) =>
      Math.abs(point.value) > Math.abs(best.value) ? point : best,
    );
    expect(center.timeS).toBeCloseTo(50e-12);
  });

  it("marks FFT as preview-only when autosave sampling is unavailable", () => {
    const model = buildSincPulsePreview({
      cutoffHz: 20e9,
      t0S: 50e-12,
      waveformAmplitude: 1,
      fieldAmplitudeT: 1e-3,
      samplePeriodS: null,
      durationS: null,
    });
    expect(model.status).toBe("preview_only");
    expect(model.message).toContain("table autosave");
  });

  it("reports the exact half-open response clock and sinc symmetry window", () => {
    const model = buildSincPulsePreview({
      cutoffHz: 40e9,
      t0S: 50e-12,
      waveformAmplitude: 1,
      fieldAmplitudeT: 1e-3,
      samplePeriodS: 0.5e-12,
      durationS: 2e-9,
    });

    expect(model.sampleCount).toBe(4_000);
    expect(model.waveform.at(-1)?.timeS).toBeCloseTo(1.9995e-9);
    expect(model.frequencyResolutionHz).toBeCloseTo(0.5e9);
    expect(model.nyquistHz).toBeCloseTo(1e12);
    expect(model.leftOfCenterS).toBeCloseTo(50e-12);
    expect(model.rightOfCenterS).toBeCloseTo(1.95e-9);
    expect(model.isSymmetricWindow).toBe(false);
    expect(model.symmetryMessage).toContain("asymmetric");
    expect(model.nyquistStatus).toBe("pass");
    expect(model.nyquistMessage).toContain("satisfies Nyquist");
    expect(model.maximumSamplePeriodForCutoffS).toBeCloseTo(12.5e-12);
  });

  it("keeps the plotted source spectrum wide enough to verify the authored cutoff", () => {
    const model = buildSincPulsePreview({
      cutoffHz: 300e9,
      t0S: 50e-12,
      waveformAmplitude: 1,
      fieldAmplitudeT: 1e-3,
      samplePeriodS: 0.5e-12,
      durationS: 2e-9,
    });

    expect(model.spectrum.at(-1)?.frequencyHz).toBeGreaterThanOrEqual(600e9);
    expect(model.spectrum).toHaveLength(193);
  });

  it("rejects antenna settings whose cutoff exceeds the sampling Nyquist limit", () => {
    const model = buildSincPulsePreview({
      cutoffHz: 40e9,
      t0S: 50e-12,
      waveformAmplitude: 1,
      fieldAmplitudeT: 1e-3,
      samplePeriodS: 20e-12,
      durationS: 2e-9,
    });

    expect(model.nyquistHz).toBeCloseTo(25e9);
    expect(model.nyquistStatus).toBe("fail");
    expect(model.nyquistMessage).toContain("violates Nyquist");
  });
});
