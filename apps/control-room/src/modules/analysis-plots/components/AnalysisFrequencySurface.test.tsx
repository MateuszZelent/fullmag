import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";

import type { ChartSeries } from "../chartTableModel";
import { AnalysisFrequencySurface } from "./AnalysisFrequencySurface";

const series: ChartSeries[] = [{
  id: "response",
  label: "Response",
  points: [{ rowIndex: 0, x: 9500, y: 0.5 }],
  quantity: "response",
  source: {
    kind: "analysis.frequency_domain",
    resourceKey: "analysis/frequency-domain/response-sweep",
    tableId: "frequency-domain:response-sweep",
  },
  status: "ready",
  unit: "1",
  xUnit: "GHz",
}];

const selectedPoint: AnalysisChartCursorPoint = {
  label: "Response",
  point: { rowIndex: 0, x: 9500, y: 0.5 },
  quantity: "response",
  seriesId: "response",
  source: series[0]!.source,
  unit: "1",
  xUnit: "GHz",
};

describe("AnalysisFrequencySurface", () => {
  it("uses the renderer display transform for frequency summaries and legends", () => {
    const html = renderToStaticMarkup(
      <AnalysisFrequencySurface
        kernel={{} as KernelApi}
        onPointSelect={() => undefined}
        selectedPoint={selectedPoint}
        series={series}
        status="ready"
        title="FMR response sweep"
        unavailableReason={null}
      />,
    );

    expect(html).toContain("9.5 THz");
    expect(html).toContain('aria-label="Response, unit dimensionless, latest 0.5');
  });
});
