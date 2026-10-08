import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { chartRenderModelToEChartsOption, createChartRendererOwner, type ChartRendererEngine, type ChartRenderModel } from "./chartRenderer";
import { DEFAULT_CHART_TOKENS } from "./fullmagChartTokens";

const model: ChartRenderModel = {
  ariaLabel: "Magnetization dynamics",
  key: "table:default@3",
  series: [{ id: "mx", kind: "line", label: "mx", points: [{ rowIndex: 7, x: 1, y: 0.25 }], unit: "1", yAxis: 0 }],
  status: "ready",
  xAxis: { label: "time [s]", unit: "s" },
  yAxes: [{ label: "magnetization", unit: "1" }],
};

describe("chart renderer owner", () => {
  it("owns exactly one lifecycle and is inert after dispose", () => {
    const chart = { dispatchAction: vi.fn(), dispose: vi.fn(), getDataURL: vi.fn(() => "data:image/png;base64,proof"), resize: vi.fn(), setOption: vi.fn() };
    const engine: ChartRendererEngine = { init: vi.fn(() => chart) };
    const owner = createChartRendererOwner(engine);
    owner.mount({} as HTMLElement);
    owner.update(model);
    owner.resize();
    owner.fitView();
    owner.setRange(1e-9, 2e-9);
    expect(owner.exportPng()).toContain("image/png");
    owner.dispose();
    owner.update({ ...model, key: "later" });
    owner.resize();
    expect(engine.init).toHaveBeenCalledTimes(1);
    expect(chart.setOption).toHaveBeenCalledTimes(1);
    expect(chart.resize).toHaveBeenCalledTimes(1);
    expect(chart.dispatchAction).toHaveBeenCalledWith({ type: "dataZoom", start: 0, end: 100 });
    expect(chart.dispatchAction).toHaveBeenCalledWith({ type: "dataZoom", startValue: 1e-9, endValue: 2e-9 });
    expect(chart.dispose).toHaveBeenCalledTimes(1);
  });

  it("encodes stable semantic row identity in renderer data", () => {
    const chart = { dispose: vi.fn(), getDataURL: vi.fn(), resize: vi.fn(), setOption: vi.fn() };
    const owner = createChartRendererOwner({ init: () => chart });
    owner.mount({} as HTMLElement);
    owner.update(model);
    expect(chart.setOption).toHaveBeenCalledWith(expect.objectContaining({
      series: [expect.objectContaining({ data: [[1, 0.25, 7]] })],
    }), false);
  });

  it("keeps dimensionless axes unscaled, enables ECharts aria and removes the bottom slider", () => {
    const option = chartRenderModelToEChartsOption(model);
    expect(option.aria).toMatchObject({ enabled: true });
    expect(option.dataZoom).toEqual([{ filterMode: "none", type: "inside", zoomOnMouseWheel: "ctrl" }]);
    expect(option.xAxis).toMatchObject({ name: "time [s]" });
    expect(option.yAxis).toEqual(expect.arrayContaining([expect.objectContaining({ name: "magnetization" })]));
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter;
    expect(formatter([{
      axisValue: 1,
      data: [1, 0.10317, 7],
      seriesName: "mx",
      value: [1, 0.10317, 7],
    }])).toContain("0.10317");
    expect(JSON.stringify(option)).not.toContain("var(--fm-");
  });

  it("uses a compatible persisted display unit in the rendered y-axis", () => {
    const option = chartRenderModelToEChartsOption({
      ...model,
      provenance: { dataRevision: 1, decimation: "none", displayUnits: { "y:period": "ns" }, query: "period", resourceKey: "period" },
      series: [{ id: "period", kind: "line", label: "Period", points: [{ rowIndex: 0, x: 0, y: 2e-9 }], unit: "s", yAxis: 0 }],
      yAxes: [{ label: "Period", unit: "s" }],
    });

    expect(option.yAxis).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Period [ns]" })]));
  });

  it("renders explicit branch gaps as null sentinels instead of connecting points", () => {
    const option = chartRenderModelToEChartsOption({
      ...model,
      series: [{
        ...model.series[0]!,
        points: [
          { rowIndex: 0, x: 1, y: 0.25 },
          { breakBefore: true, rowIndex: 2, x: 3, y: 0.5 },
        ],
      }],
    });

    expect(option.series).toEqual([
      expect.objectContaining({
        connectNulls: false,
        data: [[1, 0.25, 0], [3, null, null], [3, 0.5, 2]],
      }),
    ]);
  });

  it("renders requested scatter series with symbols and without a connecting line", () => {
    const option = chartRenderModelToEChartsOption({
      ...model,
      series: [{ ...model.series[0]!, kind: "scatter" }],
    });

    expect(option.series).toEqual([
      expect.objectContaining({
        data: [[1, 0.25, 7]],
        showSymbol: true,
        symbol: "circle",
        type: "scatter",
      }),
    ]);
  });

  it("pins a series color to its stable model slot when earlier series are hidden", () => {
    const option = chartRenderModelToEChartsOption(
      {
        ...model,
        series: [{
          ...model.series[0]!,
          colorIndex: 1,
        }],
      },
      { ...DEFAULT_CHART_TOKENS, palette: ["red", "green", "blue"] },
    );

    expect(option.series).toEqual([
      expect.objectContaining({
        itemStyle: { color: "green" },
        lineStyle: { color: "green", width: 1.5 },
      }),
    ]);
  });

  it("computes axis scales without flattening every chart point into temporary arrays", () => {
    const source = readFileSync(new URL("./chartRenderer.ts", import.meta.url), "utf8");
    expect(source).not.toContain("model.series.flatMap");
    expect(source).not.toContain("Math.max(1, ...model.series.map");
  });
});


describe("dispersion scientific presentation", () => {
  const dispersion: ChartRenderModel = {
    ariaLabel: "Dispersion", key: "dispersion", status: "ready",
    provenance: { dataRevision: 1, decimation: "none", query: "ky", resourceKey: "dispersion", displayUnits: { x: "rad/µm" } },
    xAxis: { label: "kᵧ [rad/m]", unit: "rad/m" }, yAxes: [{ label: "Frequency", unit: "Hz" }],
    series: [{ id: "band", label: "Branch 1", kind: "line", unit: "Hz", yAxis: 0, showSymbols: true,
      points: [{ x: -25e6, y: 12e9, rowIndex: 7, wavevectorRadPerM: [0, -25e6, 0], modeIndex: 1, sampleIndex: 0, residualNorm: 2e-12, modeFieldAvailable: true, selected: true }] }],
  };
  it("renders scaled wavevector units, sampled symbols and selection without mutating SI", () => {
    const option = chartRenderModelToEChartsOption(dispersion);
    expect(option.xAxis).toMatchObject({ name: "kᵧ [rad/µm]" });
    expect(option.series).toEqual([expect.objectContaining({ showSymbol: true,
      data: [expect.objectContaining({ value: [-25e6, 12e9, 7], symbolSize: 10 })] })]);
    expect(dispersion.series[0]?.points[0]?.x).toBe(-25e6);
  });
  it("shows physical metadata instead of an internal row id in the tooltip", () => {
    const option = chartRenderModelToEChartsOption(dispersion);
    const formatter = (option.tooltip as { formatter: (params: unknown) => string }).formatter;
    const tooltip = formatter([{ axisValue: -25e6, data: [-25e6, 12e9, 7], value: [-25e6, 12e9, 7], seriesName: "Branch 1 [GHz]" }]);
    expect(tooltip).toContain("-25 rad/µm");
    expect(tooltip).toContain("mode 2");
    expect(tooltip).toContain("3D field available");
    expect(tooltip).toContain("2.000e-12");
    expect(tooltip).not.toContain("row id");
    expect(tooltip).not.toContain("[rad/m]");
  });
  it("visually distinguishes analytic references", () => {
    const option = chartRenderModelToEChartsOption({ ...dispersion, series: [{ ...dispersion.series[0]!, analyticReference: true }] });
    expect(option.series).toEqual([expect.objectContaining({ symbol: "diamond", lineStyle: expect.objectContaining({ type: "dashed" }) })]);
  });
});
