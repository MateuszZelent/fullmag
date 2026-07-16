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
    expect(model.sampleCount).toBe(201);
    expect(model.samplePeriodS).toBe(0.5e-12);
    expect(model.frequencyResolutionHz).toBeCloseTo(1 / (201 * 0.5e-12));
    expect(model.nyquistHz).toBe(1e12);
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
});
