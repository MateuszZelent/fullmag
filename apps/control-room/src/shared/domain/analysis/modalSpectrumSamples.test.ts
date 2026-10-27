import { describe, expect, it } from "vitest";
import { modalSpectrumSampleIndices, modalSpectrumSeriesAtSample } from "./modalSpectrumSamples";
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
