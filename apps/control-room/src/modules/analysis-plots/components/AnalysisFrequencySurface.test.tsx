import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";

const renderedRanges: Array<{ fromValue: number; toValue: number } | null | undefined> = [];
let forwardedRangeChange: ((range: { fromValue: number; toValue: number }) => void) | undefined;
vi.mock("./EChartsSurface", () => ({ EChartsSurface: ({ initialRange, onRangeChange }: { initialRange?: { fromValue: number; toValue: number } | null; onRangeChange?: (range: { fromValue: number; toValue: number }) => void }) => { renderedRanges.push(initialRange); forwardedRangeChange = onRangeChange; return <div data-testid="chart" />; } }));

import type { ChartSeries } from "../chartTableModel";
import { AnalysisFrequencySurface } from "./AnalysisFrequencySurface";

const series: ChartSeries[] = [{
  dataRevision: "response:7",
  id: "response",
  label: "Response",
  points: [{ rowIndex: 0, x: 9500, y: 0.5 }],
  quantity: "response",
  source: {
    kind: "analysis.frequency_domain",
    resourceKey: "analysis/frequency-domain/response-sweep",
    tableId: "frequency-domain:response-sweep",
  },
  sourceIdentity: {
    artifactPath: "response/magnetic_response_sweep.v2.json",
    backend: null,
    contentDigest: "sha256:response",
    device: null,
    precision: null,
    provenance: null,
    qualification: "unknown",
    runId: "run-7",
    schemaVersion: "magnetic_response_sweep.v2",
    stageId: "stage-3",
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
        onSelectedSeriesIdsChange={() => undefined}
        selectedSeriesIds={["response"]}
        selectedPoint={selectedPoint}
        series={series}
        status="ready"
        title="FMR response sweep"
        unavailableReason={null}
      />,
    );

    expect(html).toContain("9.5 THz");
    expect(html).toContain('aria-label="Response, unit dimensionless, latest 0.5');
    expect(html).toContain("Artifact: response/magnetic_response_sweep.v2.json");
    expect(html).toContain("Schema: magnetic_response_sweep.v2");
    expect(html).toContain("Digest: sha256:response");
    expect(html).toContain("Run: run-7");
    expect(html).toContain("Stage: stage-3");
    expect(html).toContain("Backend: unknown");
    expect(html).toContain("Device: unknown");
    expect(html).toContain("Precision: unknown");
    expect(html).toContain("Qualification: unknown");
    expect(html).toContain("Provenance: unknown");
  });

  it("renders an explicit empty selection instead of restoring all frequency series", () => {
    const html = renderToStaticMarkup(
      <AnalysisFrequencySurface
        kernel={{} as KernelApi}
        onPointSelect={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        selectedSeriesIds={[]}
        selectedPoint={null}
        series={series}
        status="ready"
        title="FMR response sweep"
        unavailableReason={null}
      />,
    );

    expect(html).toContain("Select at least one signal");
  });

  it("shows unknown source identity while the frequency artifact is unavailable", () => {
    const html = renderToStaticMarkup(
      <AnalysisFrequencySurface
        kernel={{} as KernelApi}
        onPointSelect={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        selectedSeriesIds={[]}
        selectedPoint={null}
        series={[]}
        status="unsupported"
        title="FMR response sweep"
        unavailableReason="Typed response contract unavailable"
      />,
    );

    expect(html).toContain("Artifact: unknown");
    expect(html).toContain("Qualification: unknown");
  });

  it("forwards restored and changed artifact ranges through the shared ECharts surface", () => {
    renderedRanges.length = 0;
    const onRangeChange = vi.fn();
    renderToStaticMarkup(
      <AnalysisFrequencySurface
        kernel={{} as KernelApi}
        onPointSelect={() => undefined}
        onRangeChange={onRangeChange}
        onSelectedSeriesIdsChange={() => undefined}
        range={{ fromValue: 1, toValue: 2 }}
        selectedSeriesIds={["response"]}
        selectedPoint={null}
        series={series}
        status="ready"
        title="FMR response sweep"
        unavailableReason={null}
      />,
    );
    expect(renderedRanges).toContainEqual({ fromValue: 1, toValue: 2 });
    forwardedRangeChange?.({ fromValue: 3, toValue: 4 });
    expect(onRangeChange).toHaveBeenCalledWith({ fromValue: 3, toValue: 4 });
  });
});
