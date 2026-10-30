import { describe, expect, it } from "vitest";

import type { ChartSeries } from "./chartSeries";
import {
  availableDispersionAxes,
  defaultDispersionAxis,
  projectDispersionSeries,
} from "./dispersionChartAxes";

const source = {
  kind: "analysis.frequency_domain" as const,
  resourceKey: "analysis/frequency-domain/eigen-dispersion",
  tableId: "frequency-domain:eigen-dispersion",
};

const series: ChartSeries = {
  id: "dispersion:branch-a",
  kind: "line",
  label: "Branch a",
  points: [
    {
      branchId: "a",
      modeId: "sample-0-mode-2",
      pathS: 0,
      rawModeIndex: 2,
      rowIndex: 4,
      sampleId: "sample-0",
      sampleIndex: 0,
      wavevectorKf: [0, -25e6, 0],
      x: 0,
      y: 12,
    },
    {
      branchId: "a",
      modeId: "sample-1-mode-2",
      pathS: 25e6,
      rawModeIndex: 2,
      rowIndex: 8,
      sampleId: "sample-1",
      sampleIndex: 1,
      wavevectorKf: [0, 0, 0],
      x: 25e6,
      y: 9,
    },
    {
      branchId: "a",
      breakBefore: true,
      modeId: "sample-2-mode-2",
      pathS: 50e6,
      rawModeIndex: 2,
      rowIndex: 10,
      sampleId: "sample-2",
      sampleIndex: 2,
      wavevectorKf: [0, 25e6, 0],
      x: 50e6,
      y: 12,
    },
  ],
  quantity: "frequency",
  source,
  status: "ready",
  unit: "GHz",
  xUnit: "rad/m",
};

describe("dispersion chart axes", () => {
  it("defaults to the only varying signed component and preserves exact row metadata", () => {
    expect(defaultDispersionAxis([series])).toBe("ky");
    const projected = projectDispersionSeries([series], "ky")[0]!;

    expect(projected.points.map((point) => point.x)).toEqual([-25e6, 0, 25e6]);
    expect(projected.points.map((point) => point.rowIndex)).toEqual([4, 8, 10]);
    expect(projected.points.map((point) => point.modeId)).toEqual([
      "sample-0-mode-2",
      "sample-1-mode-2",
      "sample-2-mode-2",
    ]);
    expect(projected.points[2]?.breakBefore).toBe(true);
    expect(projected.points[0]?.wavevectorKf).toEqual([0, -25e6, 0]);
    expect(projected.xUnit).toBe("rad/m");
    expect(series.points.map((point) => point.x)).toEqual([0, 25e6, 50e6]);
  });

  it("keeps path distance as the default for constant or multidirectional k paths", () => {
    const constant = {
      ...series,
      points: series.points.map((point) => ({ ...point, wavevectorKf: [0, 0, 0] as const })),
    };
    const multidirectional = {
      ...series,
      points: series.points.map((point, index) => ({
        ...point,
        wavevectorKf: [index * 1e6, point.wavevectorKf![1], 0] as const,
      })),
    };

    expect(defaultDispersionAxis([constant])).toBe("path");
    expect(defaultDispersionAxis([multidirectional])).toBe("path");
  });

  it("does not invent signed components when any point lacks a finite published vector", () => {
    const missing = {
      ...series,
      points: [series.points[0]!, { ...series.points[1]!, wavevectorKf: null }],
    };
    const invalid = {
      ...series,
      points: [series.points[0]!, { ...series.points[1]!, wavevectorKf: [0, Number.NaN, 0] as const }],
    };
    const incompleteBeforeChartDecimation = {
      ...series,
      hasCompleteWavevectorKf: false,
    };

    expect(availableDispersionAxes([missing])).toEqual(["path"]);
    expect(availableDispersionAxes([invalid])).toEqual(["path"]);
    expect(availableDispersionAxes([incompleteBeforeChartDecimation])).toEqual(["path"]);
    expect(() => projectDispersionSeries([missing], "ky")).toThrow(RangeError);
  });

  it("keeps repeated k coordinates as distinct rows and preserves source order", () => {
    const repeated = {
      ...series,
      points: [
        series.points[0]!,
        series.points[2]!,
        {
          ...series.points[2]!,
          modeId: "sample-3-mode-2",
          pathS: 75e6,
          rowIndex: 12,
          sampleId: "sample-3",
          sampleIndex: 3,
        },
      ],
    };
    const projected = projectDispersionSeries([repeated], "ky")[0]!;

    expect(projected.points.map((point) => point.x)).toEqual([-25e6, 25e6, 25e6]);
    expect(projected.points.map((point) => point.rowIndex)).toEqual([4, 10, 12]);
    expect(projected.points.map((point) => point.sampleId)).toEqual([
      "sample-0",
      "sample-2",
      "sample-3",
    ]);
    expect(projected.points.map((point) => point.modeId)).toEqual([
      "sample-0-mode-2",
      "sample-2-mode-2",
      "sample-3-mode-2",
    ]);
  });
});
