import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { KernelApi } from "@/kernel/types";
import type { AnalysisChartCursorPoint } from "@/shared/domain/analysis/chartCursorPoint";

const renderedRanges: Array<{ fromValue: number; toValue: number } | null | undefined> = [];
let forwardedRangeChange: ((range: { fromValue: number; toValue: number }) => void) | undefined;
vi.mock("./EChartsSurface", () => ({ EChartsSurface: ({ initialRange, onRangeChange }: { initialRange?: { fromValue: number; toValue: number } | null; onRangeChange?: (range: { fromValue: number; toValue: number }) => void }) => { renderedRanges.push(initialRange); forwardedRangeChange = onRangeChange; return <div data-testid="chart" />; } }));

import type { ChartSeries } from "../chartTableModel";
import { AnalysisFrequencySurface } from "./AnalysisFrequencySurface";
import { classifyFrequencyDomainResult } from "@/shared/domain/analysis/frequencyDomainResultClassification";

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
  it("neutralizes an FMR title when typed qualification evidence is absent", () => {
    const html = renderToStaticMarkup(
      <AnalysisFrequencySurface
        calculationMode="fmr_response"
        kernel={{} as KernelApi}
        onPointSelect={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        selectedPoint={null}
        selectedSeriesIds={[]}
        series={series}
        status="ready"
        title="FMR response sweep"
        unavailableReason={null}
      />,
    );
    expect(html).toContain("Harmonic Response Spectrum");
    expect(html).not.toContain("FMR response sweep");
  });

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
    expect(html).toContain('data-analysis-handoff="response-overlay"');
    expect(html).toContain('data-analysis-inspector-route="chart"');
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

  it("renders modal-driven readiness instead of a generic empty chart", () => {
    const html = renderToStaticMarkup(
      <AnalysisFrequencySurface
        calculationMode="fmr_modal_driven"
        comparisonModel={{
          diagnostics: [],
          nearestComparison: null,
          pairs: [],
          readiness: "modal-only",
        }}
        kernel={{} as KernelApi}
        onPointSelect={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        selectedPoint={null}
        selectedSeriesIds={[]}
        series={[]}
        status="ready"
        title="Modal–Driven Comparison"
        unavailableReason={null}
      />,
    );

    expect(html).toContain("Modal–Driven comparison");
    expect(html).toContain("Readiness: modal-only");
    expect(html).not.toContain("Frequency-domain data is not available");
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

  it("shows typed physical identity, axes, SI/display units, and neutral workflow naming", () => {
    const classification = classifyFrequencyDomainResult({
      boundaryContext: "finite_open",
      drive: { identity: "rf-1", kind: "magnetic_rf" },
      equilibriumId: "eq-1",
      observables: [{ identity: "amplitude", kind: "response_amplitude", unit: "1" }],
      runId: "run-1",
      stageId: "response-1",
      studyProduct: "driven_response",
    });
    const html = renderToStaticMarkup(
      <AnalysisFrequencySurface
        calculationMode="fmr_response"
        context={{
          boundaryContext: "finite_open",
          classification,
          contractGaps: [],
          equilibriumId: "eq-1",
          evidence: {
          boundaryContext: "finite_open",
          drive: { identity: "rf-1", kind: "magnetic_rf" },
          equilibriumId: "eq-1",
          observables: [{ identity: "amplitude", kind: "response_amplitude", unit: "1" }],
          runId: "run-1",
          stageId: "response-1",
          studyProduct: "driven_response",
          },
          geometryId: null,
          kSampling: null,
          meshId: null,
          observables: [{ identity: "amplitude", kind: "response_amplitude", unit: "1" }],
          runId: "run-1",
          stageId: "response-1",
          studyProduct: "driven_response",
        }}
        displayUnits={{ response: "%" }}
        kernel={{} as KernelApi}
        onPointSelect={() => undefined}
        onSelectedSeriesIdsChange={() => undefined}
        selectedPoint={null}
        selectedSeriesIds={["response"]}
        series={series}
        status="ready"
        title="Harmonic Response Spectrum"
        unavailableReason={null}
      />,
    );
    expect(html).toContain("Run: run-1");
    expect(html).toContain("Stage: response-1");
    expect(html).toContain("Equilibrium: eq-1");
    expect(html).toContain("k: Finite system · k n/a");
    expect(html).toContain("Observable: amplitude");
    expect(html).toContain("SI axes: frequency [Hz] → response [1]");
    expect(html).toContain("Display units: frequency [GHz]; response [%]");
    expect(html).toContain("Workflow: Frequency response");
    expect(html).not.toContain("FMR driven");
  });
});
