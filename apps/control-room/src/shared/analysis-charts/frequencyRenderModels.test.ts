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

function chartSeries(
  id: string,
  quantity: string,
  overrides: Partial<FrequencyDomainChartSeries> = {},
): FrequencyDomainChartSeries {
  return {
    id,
    label: id,
    points: [{ rowIndex: 0, x: 1, y: 2 }],
    quantity,
    source,
    status: "ready",
    unit: "GHz",
    xUnit: "rad/m",
    ...overrides,
  };
}

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
      { id: "a-overlay", label: "Amplitude overlay", points: [{ rowIndex: 0, x: 1, y: 4 }], quantity: "amplitude", source, status: "ready", unit: "a.u.", xUnit: "GHz" },
      { id: "b", label: "Phase", points: [{ rowIndex: 0, x: 1, y: 3 }], quantity: "phase", source, status: "ready", unit: "rad", xUnit: "GHz" },
    ];
    const model = frequencySeriesRenderModel(series, "Response", "frequency");
    expect(model.series.map((entry) => entry.id)).toEqual(["a", "a-overlay"]);
    expect(model.xAxis.label).toBe("frequency [GHz]");
    expect(model.yAxes[0]?.label).toBe("Amplitude [a.u.]");
  });

  it("keeps numerical, analytic, and reference frequency overlays in every first-series order", () => {
    const byId: Record<string, FrequencyDomainChartSeries> = {
      numerical: chartSeries("numerical", "frequency", {
        label: "Branch acoustic",
      }),
      analytic: chartSeries("analytic", "analytic_frequency", {
        label: "Branch acoustic analytic",
      }),
      reference: chartSeries("reference", "reference_frequency", {
        label: "COMSOL sweep (reference)",
      }),
    };
    const orders = [
      ["numerical", "analytic", "reference"],
      ["numerical", "reference", "analytic"],
      ["analytic", "numerical", "reference"],
      ["analytic", "reference", "numerical"],
      ["reference", "numerical", "analytic"],
      ["reference", "analytic", "numerical"],
    ];

    for (const order of orders) {
      const model = frequencySeriesRenderModel(
        order.map((id) => byId[id]!),
        "Dispersion",
        "k-path s",
      );
      expect(model.series.map((entry) => entry.id)).toEqual(order);
      expect(model.series.filter((entry) => entry.selectable).map((entry) => entry.id))
        .toEqual(["numerical"]);
    }
    const numericalFirst = frequencySeriesRenderModel(
      [byId.numerical!, byId.analytic!, byId.reference!],
      "Dispersion",
      "k-path s",
    );
    expect(numericalFirst.yAxes).toEqual([{ label: "Branch acoustic [GHz]", unit: "GHz" }]);
  });

  it("keeps frequency overlays only when both units match and ignores empty or unrelated Hz quantities", () => {
    const series: FrequencyDomainChartSeries[] = [
      chartSeries("empty-first", "frequency", { points: [] }),
      chartSeries("reference", "reference_frequency"),
      chartSeries("numerical", "frequency"),
      chartSeries("analytic", "analytic_frequency"),
      chartSeries("different-y-unit", "frequency", { unit: "MHz" }),
      chartSeries("different-x-unit", "analytic_frequency", { xUnit: "m^-1" }),
      chartSeries("decay-rate", "decay_rate"),
      chartSeries("imaginary-frequency", "frequency_imag"),
      chartSeries("response", "response"),
    ];

    const model = frequencySeriesRenderModel(series, "Dispersion", "k-path s");

    expect(model.series.map((entry) => entry.id)).toEqual(["reference", "numerical", "analytic"]);
  });

  it("preserves reference identity and source provenance through the chart renderer", () => {
    const referenceSource = {
      ...source,
      resourceKey: "analysis/frequency-domain/reference/comsol",
      tableId: "reference:comsol",
    };
    const referencePoints = [{ rowIndex: 4, x: -25e6, y: 13.68 }];
    const model = frequencySeriesRenderModel([
      chartSeries("reference", "reference_frequency", {
        label: "COMSOL sweep (reference)",
        points: referencePoints,
        source: referenceSource,
      }),
      chartSeries("computed", "frequency", { label: "Computed branch" }),
    ], "Dispersion", "k-path s");
    const option = chartRenderModelToEChartsOption(model);

    expect(model.provenance?.resourceKey).toBe(referenceSource.resourceKey);
    expect(model.series[0]).toMatchObject({
      id: "reference",
      label: "COMSOL sweep (reference)",
      points: referencePoints,
    });
    expect(option.series).toEqual(expect.arrayContaining([expect.objectContaining({
      name: expect.stringContaining("COMSOL sweep (reference)"),
      data: [[-25e6, 13.68, 4]],
    })]));
  });
});
