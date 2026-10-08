import { describe, expect, it } from "vitest";

import type { FrequencyDomainChartSeries } from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  frequencySeriesRenderModel,
  frequencySpectrumRenderModel,
} from "./frequencyRenderModels";
import { chartRenderModelToEChartsOption } from "./chartRenderer";

const source = {
  kind: "analysis.frequency_domain" as const,
  resourceKey: "analysis/frequency-domain/test",
  tableId: "frequency-domain:test",
};

describe("frequency render models", () => {
  it("builds renderer-neutral modal spectrum coordinates with provenance", () => {
    const model = frequencySpectrumRenderModel([{ frequencyValue: 9.5, rowIndex: 4 }], "GHz");
    expect(model.series[0]?.points).toEqual([{ rowIndex: 4, x: 9.5, y: 1 }]);
    expect(model.xAxis).toEqual({ label: "frequency [GHz]", unit: "GHz" });
    expect(model.provenance?.query).toBe("frequencyUnit=GHz");
  });

  it("keeps supplied GHz values physically correct at the renderer boundary", () => {
    const model = frequencySpectrumRenderModel(
      [{ frequencyValue: 9.5, rowIndex: 4 }],
      "GHz",
    );
    const option = chartRenderModelToEChartsOption(model);
    const formatter = (option.tooltip as {
      formatter: (params: unknown) => string;
    }).formatter;

    expect(option.xAxis).toMatchObject({ name: "frequency [GHz]" });
    expect(formatter([{
      axisValue: 9.5,
      data: [9.5, 1, 4],
      seriesName: "Modes [a.u.]",
      value: [9.5, 1, 4],
    }])).toContain("frequency [GHz]: 9.5 GHz");
  });

  it("preserves the normalized 501-point Lorentzian envelope", () => {
    const model = frequencySpectrumRenderModel([
      { dampingRateHz: 0.2e9, frequencyValue: 7.5, rowIndex: 0 },
      { dampingRateHz: 0.4e9, frequencyValue: 8.5, rowIndex: 1 },
    ], "GHz");
    const envelope = model.series.find((series) => series.id === "spectral-envelope");
    expect(envelope?.points).toHaveLength(501);
    expect(Math.max(...(envelope?.points.map((point) => point.y) ?? []))).toBeCloseTo(1);
  });

  it("keeps physical modal envelopes invariant under Hz/kHz/MHz/GHz", () => {
    const curves = [1, 1e3, 1e6, 1e9].map((scale, index) => {
      const model = frequencySpectrumRenderModel([
        { dampingRateHz: 1e8, frequencyValue: 10e9 / scale, rowIndex: 0 },
      ], ["Hz", "kHz", "MHz", "GHz"][index]!);
      return model.series.find((series) => series.id === "spectral-envelope")!.points;
    });
    for (const curve of curves.slice(1)) {
      curve.forEach((point, index) => expect(point.y).toBeCloseTo(curves[0]![index]!.y, 12));
    }
    const curve = curves[0]!;
    const a = curve[30]!;
    const b = curve[80]!;
    const expected = ((b.x - 10e9) ** 2 + 1e16) / ((a.x - 10e9) ** 2 + 1e16);
    expect(a.y / b.y).toBeCloseTo(expected, 12);
  });

  it("rejects unknown units rather than inventing a physical envelope", () => {
    const model = frequencySpectrumRenderModel([
      { dampingRateHz: 1e8, frequencyValue: 10, rowIndex: 0 },
    ], "rad/s");
    expect(model.status).toBe("unsupported");
    expect(model.statusMessage).toContain("rad/s");
    expect(model.series).toEqual([]);
  });

  it("fails closed to the first compatible quantity and units", () => {
    const series: FrequencyDomainChartSeries[] = [
      { id: "a", label: "Amplitude", points: [{ rowIndex: 0, x: 1, y: 2 }], quantity: "amplitude", source, status: "ready", unit: "a.u.", xUnit: "GHz" },
      { id: "b", label: "Phase", points: [{ rowIndex: 0, x: 1, y: 3 }], quantity: "phase", source, status: "ready", unit: "rad", xUnit: "GHz" },
    ];
    const model = frequencySeriesRenderModel(series, "Response", "frequency");
    expect(model.series.map((entry) => entry.id)).toEqual(["a"]);
    expect(model.xAxis.label).toBe("frequency [GHz]");
    expect(model.yAxes[0]?.label).toBe("Amplitude [a.u.]");
  });

  it("keeps an analytic dispersion overlay with the numerical frequency series", () => {
    const pointMetadata = {
      branchId: "acoustic",
      itemId: "sample-0001/mode-0002",
      modeFieldAvailable: false,
      modeIndex: 2,
      residualNorm: 3e-12,
      sampleId: "k-path-sample-0001",
      sampleIndex: 1,
      wavevectorRadPerM: [0, 1, 0] as const,
    };
    const numericalPoint = { ...pointMetadata, rowIndex: 4, x: 1, y: 2 };
    const analyticPoint = { ...pointMetadata, rowIndex: 4, x: 1, y: 2.1 };
    const series: FrequencyDomainChartSeries[] = [
      {
        id: "numerical",
        label: "Branch acoustic",
        points: [numericalPoint],
        quantity: "frequency",
        source,
        status: "ready",
        unit: "GHz",
        xUnit: "rad/m",
      },
      {
        id: "analytic",
        label: "Branch acoustic analytic",
        points: [analyticPoint],
        quantity: "analytic_frequency",
        source,
        status: "ready",
        unit: "GHz",
        xUnit: "rad/m",
      },
      {
        id: "phase",
        label: "Phase",
        points: [{ rowIndex: 0, x: 1, y: 0.2 }],
        quantity: "phase",
        source,
        status: "ready",
        unit: "rad",
        xUnit: "rad/m",
      },
    ];

    const model = frequencySeriesRenderModel(series, "Dispersion", "k-path s");

    expect(model.series.map((entry) => entry.id)).toEqual(["numerical", "analytic"]);
    expect(model.series.map((entry) => entry.points)).toEqual([
      [numericalPoint],
      [analyticPoint],
    ]);
    expect(model.yAxes).toEqual([{ label: "Branch acoustic [GHz]", unit: "GHz" }]);
  });
});
