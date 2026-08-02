import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { chartRenderModelToEChartsOption, createChartRendererOwner, type ChartRendererEngine, type ChartRenderModel } from "./chartRenderer";

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
    expect(owner.exportPng()).toContain("image/png");
    owner.dispose();
    owner.update({ ...model, key: "later" });
    owner.resize();
    expect(engine.init).toHaveBeenCalledTimes(1);
    expect(chart.setOption).toHaveBeenCalledTimes(1);
    expect(chart.resize).toHaveBeenCalledTimes(1);
    expect(chart.dispatchAction).toHaveBeenCalledWith({ type: "dataZoom", start: 0, end: 100 });
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

  it("computes axis scales without flattening every chart point into temporary arrays", () => {
    const source = readFileSync(new URL("./chartRenderer.ts", import.meta.url), "utf8");
    expect(source).not.toContain("model.series.flatMap");
    expect(source).not.toContain("Math.max(1, ...model.series.map");
  });
});
