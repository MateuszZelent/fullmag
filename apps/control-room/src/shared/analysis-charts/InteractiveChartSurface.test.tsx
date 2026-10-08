import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { chartRenderModelToEChartsOption } from "./chartRenderer";

import {
  InteractiveChartSurface,
  chartPointFromEChartsClick,
  chartSeriesRenderModel,
} from "./InteractiveChartSurface";

const series = [{
  id: "analysis:mx",
  label: "m_x",
  points: [{ rowIndex: 0, x: 0, y: 1 }],
  quantity: "mx",
  source: { kind: "data.table.rows" as const, resourceKey: "data", tableId: "default" },
  status: "ready" as const,
  unit: "1",
  xUnit: "s",
}];

describe("InteractiveChartSurface", () => {
  it("renders caller-owned identity and presentation copy", () => {
    expect(renderToStaticMarkup(
      <InteractiveChartSurface
        series={series}
        surface={{
          ariaLabel: "Live magnetization",
          chartId: "live:magnetization",
          presentationCopy: { empty: "No live samples", error: "Live data unavailable", loading: "Loading live samples" },
          provenance: { dataRevision: 7, decimation: "tail", descriptorId: "live:magnetization", query: "tail=100", resourceKey: "live/magnetization" },
        }}
        xAxisLabel="time [s]"
      />,
    )).toContain('class="fm-analysis-plots__echarts"');
  });

  it("keeps caller-owned chart and provenance identity in the shared render model", () => {
    expect(chartSeriesRenderModel(series, series, {
      ariaLabel: "Live magnetization",
      chartId: "live:magnetization",
      presentationCopy: { empty: "No live samples", error: "Live data unavailable", loading: "Loading live samples" },
      provenance: { dataRevision: 7, decimation: "tail", descriptorId: "live:magnetization", query: "tail=100", resourceKey: "live/magnetization" },
    }, "time [s]", "loading")).toMatchObject({
      ariaLabel: "Live magnetization",
      key: "live:magnetization",
      provenance: { dataRevision: 7, descriptorId: "live:magnetization", resourceKey: "live/magnetization" },
      series: [{ id: "analysis:mx", points: series[0]?.points }],
      statusMessage: "Loading live samples",
      xAxis: { label: "time [s]", unit: "s" },
    });
  });

  it("leaves time-domain axes and symbols on their shared defaults", () => {
    const surface = {
      ariaLabel: "Live magnetization",
      chartId: "live:magnetization",
      presentationCopy: { empty: "No live samples", error: "Live data unavailable", loading: "Loading live samples" },
      provenance: { dataRevision: 7, decimation: "tail", query: "tail=100", resourceKey: "live/magnetization" },
    };
    const model = chartSeriesRenderModel(series, series, surface, "time [s]");

    expect(model.yAxes[0]?.dataRange).toBeUndefined();
    expect(model.series[0]?.symbolSize).toBeUndefined();
    const option = chartRenderModelToEChartsOption(model);
    expect(option.series).toEqual(expect.arrayContaining([expect.objectContaining({ symbolSize: 4 })]));
    const axis = (option.yAxis as Array<Record<string, unknown>>)[0];
    expect(axis).not.toHaveProperty("min");
    expect(axis).not.toHaveProperty("max");
  });

  it("maps a click after an inserted gap to the source point identity", () => {
    const dispersionSeries = [{
      ...series[0]!,
      points: [
        { itemId: "sample-0000/mode-0000", rowIndex: 0, sampleId: "k-path-sample-0000", x: 0, y: 1 },
        { itemId: "sample-0002/mode-0001", rowIndex: 2, sampleId: "k-path-sample-0002", x: 2, y: 3 },
      ],
    }];
    const sourceRows = [
      { sampleId: "k-path-sample-0000", modeId: "sample-0000/mode-0000" },
      { sampleId: "k-path-sample-0001", modeId: "sample-0001/mode-0000" },
      { sampleId: "k-path-sample-0002", modeId: "sample-0002/mode-0001" },
    ];

    const click = chartPointFromEChartsClick({
      data: [2, 3, 2],
      dataIndex: 2,
      seriesIndex: 0,
    }, dispersionSeries);

    expect(click).toEqual({ pointIndex: 1, seriesId: "analysis:mx" });
    const selectedPoint = dispersionSeries[0]!.points[click!.pointIndex]!;
    expect(sourceRows[selectedPoint.rowIndex]).toEqual({
      sampleId: "k-path-sample-0002",
      modeId: "sample-0002/mode-0001",
    });
    expect(chartPointFromEChartsClick({ dataIndex: 0, seriesIndex: 0 }, series)).toEqual({
      pointIndex: 0,
      seriesId: "analysis:mx",
    });
  });

  it("maps an ECharts object value payload through its original row index", () => {
    const dispersionSeries = [{
      ...series[0]!,
      points: [
        { rowIndex: 0, x: 0, y: 1 },
        { rowIndex: 2, x: 2, y: 3 },
      ],
    }];
    const click = chartPointFromEChartsClick({
      data: { value: [2, 3, 2] },
      dataIndex: 0,
      seriesIndex: 0,
    }, dispersionSeries);

    expect(click).toEqual({ pointIndex: 1, seriesId: "analysis:mx" });
    expect(dispersionSeries[0]!.points[click!.pointIndex]!.rowIndex).toBe(2);
  });

  it("preserves requested scatter and defaults unspecified series to line", () => {
    const scatterSeries = [{ ...series[0]!, kind: "scatter" as const }];
    const surface = {
      ariaLabel: "Dispersion modes",
      chartId: "dispersion:modes",
      presentationCopy: { empty: "No modes", error: "Mode data unavailable", loading: "Loading modes" },
      provenance: { dataRevision: 1, decimation: "none", descriptorId: "dispersion:modes", query: "k-path", resourceKey: "eigen/dispersion" },
    };

    expect(chartSeriesRenderModel(scatterSeries, scatterSeries, surface).series[0]?.kind).toBe("scatter");
    expect(chartSeriesRenderModel(series, series, surface).series[0]?.kind).toBe("line");
  });

  it("ranges frequency axes to plotted values and preserves analytic styling", () => {
    const numerical = {
      ...series[0]!,
      id: "numerical",
      kind: "scatter" as const,
      label: "Branch acoustic",
      points: [
        { rowIndex: 0, x: 0, y: 9.3 },
        { rowIndex: 1, x: 1, y: 13.5 },
      ],
      quantity: "frequency",
      unit: "GHz",
      xUnit: "rad/m",
    };
    const analytic = {
      ...numerical,
      id: "analytic",
      kind: "line" as const,
      label: "Branch acoustic analytic",
      points: [
        { rowIndex: 0, x: 0, y: 8 },
        { rowIndex: 1, x: 1, y: 14 },
      ],
      quantity: "analytic_frequency",
    };
    const surface = {
      ariaLabel: "Dispersion modes",
      chartId: "dispersion:modes",
      presentationCopy: { empty: "No modes", error: "Mode data unavailable", loading: "Loading modes" },
      provenance: { dataRevision: 1, decimation: "none", query: "k-path", resourceKey: "eigen/dispersion" },
    };

    const numericalOnly = chartSeriesRenderModel([numerical], [numerical, analytic], surface);
    const numericalRange = numericalOnly.yAxes[0]?.dataRange;
    if (!numericalRange) throw new Error("Missing visible frequency range");
    expect(numericalOnly.yAxes[0]?.label).toBe("Frequency");
    expect(numericalRange[0]).toBeCloseTo(9.09);
    expect(numericalRange[1]).toBeCloseTo(13.71);
    expect(numericalOnly.series[0]).toMatchObject({ symbolSize: 7 });
    const numericalOption = chartRenderModelToEChartsOption(numericalOnly);
    const numericalYAxis = (numericalOption.yAxis as Array<{ min?: number; max?: number; name?: string }>)[0];
    expect(numericalYAxis?.min).toBeCloseTo(9.09);
    expect(numericalYAxis?.max).toBeCloseTo(13.71);
    expect(numericalYAxis?.name).toBe("Frequency [GHz]");
    expect(numericalOption.series).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Branch acoustic [GHz]" })]));

    const combined = chartSeriesRenderModel([numerical, analytic], [numerical, analytic], surface);
    const analyticModel = combined.series.find((entry) => entry.id === "analytic");
    expect(analyticModel).toMatchObject({
      analyticReference: true,
      showSymbols: true,
      symbolSize: 7,
    });
    const combinedOption = chartRenderModelToEChartsOption(combined);
    expect(combinedOption.series).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lineStyle: expect.objectContaining({ type: "dashed" }),
        showSymbol: true,
        symbol: "diamond",
        symbolSize: 7,
      }),
    ]));
    const combinedYAxis = (combinedOption.yAxis as Array<{ min?: number; max?: number }>)[0];
    expect(combinedYAxis?.min).toBeCloseTo(7.7);
    expect(combinedYAxis?.max).toBeCloseTo(14.3);
  });

  it("keeps a visible series in its all-series color slot when an earlier series is hidden", () => {
    const allSeries = [
      series[0]!,
      {
        ...series[0]!,
        id: "analysis:my",
        label: "m_y",
        points: [{ rowIndex: 0, x: 0, y: 2 }],
        quantity: "my",
      },
    ];

    const model = chartSeriesRenderModel(
      [allSeries[1]!],
      allSeries,
      {
        ariaLabel: "Live magnetization",
        chartId: "live:magnetization",
        presentationCopy: { empty: "No live samples", error: "Live data unavailable", loading: "Loading live samples" },
        provenance: { dataRevision: 7, decimation: "tail", descriptorId: "live:magnetization", query: "tail=100", resourceKey: "live/magnetization" },
      },
    );

    expect(model.series).toEqual([
      expect.objectContaining({
        colorIndex: 1,
        id: "analysis:my",
      }),
    ]);
  });

});
