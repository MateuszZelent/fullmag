import { readFileSync } from "node:fs";
import { init } from "echarts";
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

type DataZoomListener = (event: unknown) => void;

function createDataZoomChart(dataZoom: unknown) {
  const listeners = new Map<string, DataZoomListener>();
  const chart = {
    dispose: vi.fn(),
    getDataURL: vi.fn(() => "data:image/png;base64,proof"),
    getOption: vi.fn(() => ({ dataZoom })),
    off: vi.fn(),
    on: vi.fn((name: string, listener: DataZoomListener) => {
      listeners.set(name, listener);
    }),
    resize: vi.fn(),
    setOption: vi.fn(),
  };
  return { chart, listeners };
}

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
    expect(chart.dispatchAction).toHaveBeenCalledWith(
      { type: "dataZoom", start: 0, end: 100 },
      { silent: true },
    );
    expect(chart.dispatchAction).toHaveBeenCalledWith(
      { type: "dataZoom", startValue: 1e-9, endValue: 2e-9 },
      { silent: true },
    );
    expect(chart.dispose).toHaveBeenCalledTimes(1);
  });

  it("normalizes a user percentage zoom from ECharts calculated values", () => {
    const onDataZoom = vi.fn();
    const { chart, listeners } = createDataZoomChart([
      { id: "other-window", startValue: 10, endValue: 20 },
      { id: "x-window", startValue: 0.183, endValue: 3.819 },
    ]);
    const owner = createChartRendererOwner(
      { init: () => chart },
      { dataZoom: onDataZoom },
    );
    owner.mount({} as HTMLElement);

    listeners.get("dataZoom")?.({
      batch: [{ dataZoomId: "x-window", dataZoomIndex: 1, end: 95.4, start: 18.3 }],
      type: "datazoom",
    });

    expect(onDataZoom).toHaveBeenCalledWith({
      batch: [{ dataZoomId: "x-window", dataZoomIndex: 1, end: 95.4, endValue: 3.819, start: 18.3, startValue: 0.183 }],
      type: "datazoom",
    });
  });

  it("uses the dataZoom index when an event has no id and preserves finite value actions", () => {
    const onDataZoom = vi.fn();
    const { chart, listeners } = createDataZoomChart([
      { id: "other-window", startValue: 10, endValue: 20 },
      { id: "x-window", startValue: 0.183, endValue: 3.819 },
    ]);
    const owner = createChartRendererOwner(
      { init: () => chart },
      { dataZoom: onDataZoom },
    );
    owner.mount({} as HTMLElement);

    listeners.get("dataZoom")?.({ dataZoomIndex: 0, end: 100, start: 0, type: "datazoom" });
    listeners.get("dataZoom")?.({
      dataZoomId: "x-window",
      end: 80,
      endValue: 5,
      start: 20,
      startValue: 2,
      type: "datazoom",
    });

    expect(onDataZoom).toHaveBeenNthCalledWith(1, {
      dataZoomIndex: 0,
      end: 100,
      endValue: 20,
      start: 0,
      startValue: 10,
      type: "datazoom",
    });
    expect(onDataZoom).toHaveBeenNthCalledWith(2, {
      dataZoomId: "x-window",
      end: 80,
      endValue: 5,
      start: 20,
      startValue: 2,
      type: "datazoom",
    });
  });

  it("removes unpinned reference series in real ECharts while retaining the zoom", () => {
    const chart = init(null, undefined, {
      height: 320,
      renderer: "svg",
      ssr: true,
      width: 640,
    });
    const owner = createChartRendererOwner({ init: () => chart });
    const seriesIds = () => {
      const option = chart.getOption() as { series: { id: string }[] };
      return option.series.filter(Boolean).map((series) => series.id);
    };
    try {
      owner.mount({} as HTMLElement);
      owner.update({
        ...model,
        series: [
          ...model.series,
          { ...model.series[0]!, id: "reference", label: "Reference", selectable: false },
          { ...model.series[0]!, id: "mz", label: "mz" },
        ],
      });
      expect(seriesIds()).toEqual(["mx", "reference", "mz"]);
      chart.dispatchAction({ type: "dataZoom", start: 20, end: 80 });

      owner.update({
        ...model,
        series: [...model.series, { ...model.series[0]!, id: "mz", label: "mz" }],
      });
      expect(seriesIds()).toEqual(["mx", "mz"]);
      const zoom = chart.getOption().dataZoom as { start: number; end: number }[];
      expect(zoom[0]).toMatchObject({ start: 20, end: 80 });

      owner.update({ ...model, series: [], status: "empty" });
      expect(seriesIds()).toEqual([]);
    } finally {
      owner.dispose();
    }
  });

  it("keeps reference scatter markers visible without interaction targets", () => {
    const option = chartRenderModelToEChartsOption({
      ...model,
      series: [
        { ...model.series[0]!, kind: "scatter", id: "computed" },
        { ...model.series[0]!, kind: "scatter", id: "reference", selectable: false },
      ],
    });
    expect(option.series).toEqual([
      expect.objectContaining({ id: "computed", silent: false, showSymbol: true, symbolSize: 4 }),
      expect.objectContaining({ id: "reference", silent: true, showSymbol: true, symbolSize: 4 }),
    ]);
  });

  it("encodes stable semantic row identity in renderer data", () => {
    const chart = { dispose: vi.fn(), getDataURL: vi.fn(), resize: vi.fn(), setOption: vi.fn() };
    const owner = createChartRendererOwner({ init: () => chart });
    owner.mount({} as HTMLElement);
    owner.update(model);
    expect(chart.setOption).toHaveBeenCalledWith(expect.objectContaining({
      series: [expect.objectContaining({ id: "mx", data: [[1, 0.25, 7]] })],
    }), { notMerge: false, replaceMerge: ["series"] });
  });

  it("keeps dimensionless axes unscaled, enables ECharts aria and removes the bottom slider", () => {
    const option = chartRenderModelToEChartsOption(model);
    expect(option.aria).toMatchObject({ enabled: true });
    expect(option.tooltip).toMatchObject({ className: "fm-chart-tooltip" });
    expect(option.dataZoom).toEqual([{ id: "fullmag-x-window", filterMode: "none", type: "inside", zoomOnMouseWheel: "ctrl" }]);
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
        emphasis: expect.objectContaining({
          itemStyle: { color: expect.any(String) },
        }),
        itemStyle: { color: "transparent" },
        showSymbol: true,
        symbol: "circle",
        symbolSize: 2,
        type: "line",
      }),
    ]);
  });

  it("limits selectable line symbols to a chart-wide budget of 5,000 points", () => {
    const lineSeries = (
      id: string,
      pointCount: number,
      selectable = true,
    ) => ({
      ...model.series[0]!,
      id,
      label: id,
      selectable,
      points: Array.from({ length: pointCount }, (_, rowIndex) => ({
        rowIndex,
        x: rowIndex,
        y: rowIndex / 10,
      })),
    });
    const boundedOption = chartRenderModelToEChartsOption({
      ...model,
      series: [lineSeries("branch-a", 2_500), lineSeries("branch-b", 2_500)],
    });
    expect(boundedOption.series).toEqual(expect.arrayContaining([
      expect.objectContaining({
        data: expect.arrayContaining([[2_499, 249.9, 2_499]]),
        id: "branch-a",
        itemStyle: { color: "transparent" },
        showSymbol: true,
        symbolSize: 2,
      }),
      expect.objectContaining({
        data: expect.arrayContaining([[2_499, 249.9, 2_499]]),
        id: "branch-b",
        itemStyle: { color: "transparent" },
        showSymbol: true,
        symbolSize: 2,
      }),
    ]));

    const overBudgetOption = chartRenderModelToEChartsOption({
      ...model,
      series: [lineSeries("branch-a", 2_500), lineSeries("branch-b", 2_501)],
    });
    expect(overBudgetOption.series).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "branch-a", showSymbol: false, type: "line" }),
      expect.objectContaining({ id: "branch-b", showSymbol: false, type: "line" }),
    ]));

    const computedAndReference = chartRenderModelToEChartsOption({
      ...model,
      series: [lineSeries("computed", 2_500), lineSeries("reference", 4_000, false)],
    });
    expect(computedAndReference.series).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "computed", showSymbol: true }),
      expect.objectContaining({ id: "reference", showSymbol: false }),
    ]));
  });

  it("renders requested scatter series with symbols and without a connecting line", () => {
    const option = chartRenderModelToEChartsOption({
      ...model,
      series: [{ ...model.series[0]!, kind: "scatter", selectable: false }],
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
        emphasis: expect.objectContaining({
          itemStyle: { color: "green" },
        }),
        itemStyle: { color: "transparent" },
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
