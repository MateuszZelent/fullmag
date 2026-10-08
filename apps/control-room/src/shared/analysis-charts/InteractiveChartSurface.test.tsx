import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

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
