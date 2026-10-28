import { describe, expect, it } from "vitest";
import { modalSpectrumSampleIndices, modalSpectrumSampleLabels, modalSpectrumSeriesAtSample } from "./modalSpectrumSamples";
import type { ChartSeries } from "./chartSeries";

describe("modal sample chart identity", () => {
  const series = [{ id: "modes", points: [
    { rowIndex: 8, sampleIndex: 2, x: 0, y: 10 },
    { rowIndex: 21, sampleIndex: 7, x: 0, y: 9.3 },
    { rowIndex: 22, sampleIndex: 7, x: 1, y: 11 },
  ] }] as ChartSeries[];
  it("isolates one k without renumbering rows or mixing equal mode ranks", () => {
    expect(modalSpectrumSampleIndices(series)).toEqual([2, 7]);
    expect(modalSpectrumSeriesAtSample(series, 7)[0]?.points.map((point) => point.rowIndex)).toEqual([21, 22]);
    expect(modalSpectrumSeriesAtSample(series, 99)[0]?.points).toEqual([]);
    expect(series[0]?.points).toHaveLength(3);
  });
});


it("derives signed k labels once from the published vectors", () => {
  const labels = modalSpectrumSampleLabels([{ quantity: "frequency", points: [
    { rowIndex: 0, sampleIndex: 0, x: 0, y: 13, wavevectorKf: [0, -25e6, 0] },
    { rowIndex: 1, sampleIndex: 7, x: 25e6, y: 9.3, wavevectorKf: [0, 0, 0] },
  ] }] as ChartSeries[]);
  expect(labels.get(0)).toBe("kᵧ = -25 rad/µm");
  expect(labels.get(7)).toBe("Γ · k = 0");
});
