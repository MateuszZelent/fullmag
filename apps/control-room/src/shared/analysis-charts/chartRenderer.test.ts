import { describe, expect, it, vi } from "vitest";
import { createChartRendererOwner, type ChartRendererEngine, type ChartRenderModel } from "./chartRenderer";

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
    const chart = { dispose: vi.fn(), getDataURL: vi.fn(() => "data:image/png;base64,proof"), resize: vi.fn(), setOption: vi.fn() };
    const engine: ChartRendererEngine = { init: vi.fn(() => chart) };
    const owner = createChartRendererOwner(engine);
    owner.mount({} as HTMLElement);
    owner.update(model);
    owner.resize();
    expect(owner.exportPng()).toContain("image/png");
    owner.dispose();
    owner.update({ ...model, key: "later" });
    owner.resize();
    expect(engine.init).toHaveBeenCalledTimes(1);
    expect(chart.setOption).toHaveBeenCalledTimes(1);
    expect(chart.resize).toHaveBeenCalledTimes(1);
    expect(chart.dispose).toHaveBeenCalledTimes(1);
  });

  it("encodes stable semantic row identity in renderer data", () => {
    const chart = { dispose: vi.fn(), getDataURL: vi.fn(), resize: vi.fn(), setOption: vi.fn() };
    const owner = createChartRendererOwner({ init: () => chart });
    owner.mount({} as HTMLElement);
    owner.update(model);
    expect(chart.setOption).toHaveBeenCalledWith(expect.objectContaining({
      series: [expect.objectContaining({ data: [[1, 0.25, 7]] })],
    }), true);
  });
});
