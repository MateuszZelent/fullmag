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
      { dampingRateHz: 0.2, frequencyValue: 7.5, rowIndex: 0 },
      { dampingRateHz: 0.4, frequencyValue: 8.5, rowIndex: 1 },
    ], "GHz");
    const envelope = model.series.find((series) => series.id === "spectral-envelope");
    expect(envelope?.points).toHaveLength(501);
    expect(Math.max(...(envelope?.points.map((point) => point.y) ?? []))).toBeCloseTo(1);
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
});
