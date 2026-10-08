import { describe, expect, it } from "vitest";

import type { FrequencyDomainChartSeries } from "@/shared/domain/analysis/frequencyDomainChartModels";
import { frequencyAxisDataRange } from "./frequencyAxisPresentation";
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
    expect(model.series.find((entry) => entry.id === "modes")?.symbolSize).toBe(7);
    expect(model.yAxes[0]?.dataRange).toBeUndefined();
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

  it("keeps discrete fixed-k modes as visible, selectable scatter marks", () => {
    const modeSeries: FrequencyDomainChartSeries = {
      id: "modal-spectrum",
      kind: "scatter",
      label: "Eigen frequency",
      points: [{ rowIndex: 0, x: 0, y: 11.194 }],
      quantity: "frequency",
      source,
      status: "ready",
      unit: "GHz",
      xUnit: "1",
    };
    const option = chartRenderModelToEChartsOption(
      frequencySeriesRenderModel([modeSeries], "Eigenfrequencies at fixed k", "mode index"),
    );
    const range = (frequencySeriesRenderModel([modeSeries], "Eigenfrequencies at fixed k", "mode index").yAxes[0]?.dataRange);
    expect(range?.[0]).toBeLessThan(11.194);
    expect(range?.[1]).toBeGreaterThan(11.194);
    const axis = (option.yAxis as Array<{ min?: number; max?: number }>)[0];
    expect(axis?.min).toBe(range?.[0]);
    expect(axis?.max).toBe(range?.[1]);
    expect(option.series).toEqual([
      expect.objectContaining({
        data: [[0, 11.194, 0]],
        showSymbol: true,
        symbol: "circle",
        symbolSize: 7,
        type: "scatter",
      }),
    ]);
  });

  it("does not combine raw frequency values with different units", () => {
    expect(frequencyAxisDataRange([
      { quantity: "frequency", unit: "GHz", points: [{ y: 10 }] },
      { quantity: "frequency", unit: "MHz", points: [{ y: 10_000 }] },
    ])).toBeNull();
  });
  it("pads only finite signed frequency values and singleton ranges", () => {
    const render = (values: readonly number[]) => frequencySeriesRenderModel([{
      id: "frequency",
      label: "Eigen frequency",
      points: values.map((y, rowIndex) => ({ rowIndex, x: rowIndex, y })),
      quantity: "frequency",
      source,
      status: "ready",
      unit: "GHz",
      xUnit: "rad/m",
    }], "Dispersion", "k-path s");

    const signedRange = render([-12, -4, Number.NaN, Number.POSITIVE_INFINITY]).yAxes[0]?.dataRange;
    if (!signedRange) throw new Error("Missing signed frequency range");
    expect(Number.isFinite(signedRange[0])).toBe(true);
    expect(Number.isFinite(signedRange[1])).toBe(true);
    expect(signedRange[0]).toBeLessThan(-12);
    expect(signedRange[1]).toBeGreaterThan(-4);
    expect(signedRange[1]).toBeLessThan(0);

    const singletonRange = render([0]).yAxes[0]?.dataRange;
    if (!singletonRange) throw new Error("Missing singleton frequency range");
    expect(Number.isFinite(singletonRange[0])).toBe(true);
    expect(Number.isFinite(singletonRange[1])).toBe(true);
    expect(singletonRange[0]).toBeLessThan(0);
    expect(singletonRange[1]).toBeGreaterThan(0);

    const equalRange = render([-5, -5]).yAxes[0]?.dataRange;
    if (!equalRange) throw new Error("Missing equal-value frequency range");
    expect(equalRange[0]).toBeLessThan(-5);
    expect(equalRange[1]).toBeGreaterThan(-5);
    expect(equalRange[1]).toBeLessThan(0);

    const extremeRange = render([Number.MAX_VALUE]).yAxes[0]?.dataRange;
    if (!extremeRange) throw new Error("Missing extreme frequency range");
    expect(Number.isFinite(extremeRange[0])).toBe(true);
    expect(Number.isFinite(extremeRange[1])).toBe(true);
    expect(extremeRange[0]).toBeLessThan(Number.MAX_VALUE);
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
    expect(model.series.find((entry) => entry.id === "analytic")).toMatchObject({
      analyticReference: true,
      showSymbols: true,
      symbolSize: 7,
    });
    expect(model.yAxes[0]).toMatchObject({ label: "Frequency [GHz]", unit: "GHz" });
    expect(model.yAxes[0]?.dataRange).toBeDefined();

    const option = chartRenderModelToEChartsOption(model);
    expect(option.series).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lineStyle: expect.objectContaining({ type: "dashed" }),
        showSymbol: true,
        symbol: "diamond",
        symbolSize: 7,
      }),
    ]));
  });
});
