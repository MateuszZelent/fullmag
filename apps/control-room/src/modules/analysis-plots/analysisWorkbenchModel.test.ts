import { describe, expect, it } from "vitest";

import type { ChartSeries } from "./chartTableModel";
import {
  frequencyDomainChartRouteOverrideFromSelection,
  frequencyDomainChartRouteOverrideFromSubview,
  frequencyDomainManifestSupportsChartRoute,
} from "@/shared/domain/analysis/frequencyDomainChartModels";
import {
  buildFrequencyDomainCursorSummary,
  buildFrequencyDomainWorkflowSummary,
  buildFrequencyDomainWorkbenchSummary,
  isFixedKModalSpectrumSubview,
  normalizeFixedKModalRouteOverride,
  resourceStatusFromString,
} from "./analysisWorkbenchModel";

describe("resourceStatusFromString", () => {
  it("treats a paused chart as a frozen ready resource, not idle data", () => {
    expect(resourceStatusFromString("paused")).toBe("ready");
  });
});

describe("buildFrequencyDomainWorkbenchSummary", () => {
  it("uses the descriptor and calculation mode instead of a chart title", () => {
    expect(
      buildFrequencyDomainWorkflowSummary(
        "frequency-domain:eigen-spectrum",
        "free_modes",
      ),
    ).toMatchObject({
      inspector: "eigen mode inspector",
      workflow: "Eigenmode modal",
    });
    expect(
      buildFrequencyDomainWorkflowSummary(
        "frequency-domain:eigen-spectrum",
        "fmr_modal",
      ),
    ).toMatchObject({
      inspector: "mode inspector",
      workflow: "FMR modal",
    });
    expect(
      buildFrequencyDomainWorkflowSummary(
        "frequency-domain:response-sweep",
        "free_response",
      ),
    ).toMatchObject({
      inspector: "frequency response point inspector",
      workflow: "Frequency response",
    });
    expect(
      buildFrequencyDomainWorkflowSummary(
        "frequency-domain:response-sweep",
        "fmr_response",
      ),
    ).toMatchObject({
      inspector: "response point inspector",
      workflow: "FMR driven",
    });
  });

  it("summarizes a large response sweep without spreading all samples into Math.min/max", () => {
    const series: ChartSeries[] = [{
      id: "response",
      label: "Response",
      points: Array.from({ length: 200_000 }, (_, rowIndex) => ({
        rowIndex,
        x: rowIndex,
        y: rowIndex / 10,
      })),
      quantity: "response",
      source: {
        kind: "analysis.frequency_domain",
        resourceKey: "analysis/frequency-domain/response-sweep",
        tableId: "frequency-domain:response-sweep",
      },
      status: "ready",
      unit: "1",
      xUnit: "Hz",
    }];

    const summary = buildFrequencyDomainWorkbenchSummary(
      series,
      "fmr_response",
      "ready",
    );

    expect(summary.pointCount).toBe("200000 points");
    expect(summary.frequencyRange).toContain("Hz");
  });

  it("uses display transforms for prefixed frequency ranges and cursors", () => {
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
    const point = {
      label: "Response",
      point: { rowIndex: 0, x: 9500, y: 0.5 },
      quantity: "response",
      seriesId: "response",
      source: series[0]!.source,
      unit: "1",
      xUnit: "GHz",
    };

    expect(buildFrequencyDomainWorkbenchSummary(series, "fmr_response", "ready").frequencyRange).toBe("9.5 THz");
    expect(buildFrequencyDomainCursorSummary(point, "fmr_response", series)?.xValue).toBe("9.5 THz");
    expect(buildFrequencyDomainCursorSummary(point, "fmr_response", series)?.yValue).toBe("0.5");
  });

  it("keeps a zero-inclusive prefixed frequency range aligned with the chart axis", () => {
    const series: ChartSeries[] = [{
      id: "response",
      label: "Response",
      points: [
        { rowIndex: 0, x: 0, y: 0 },
        { rowIndex: 1, x: 9500, y: 0.5 },
      ],
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

    expect(buildFrequencyDomainWorkbenchSummary(series, "fmr_response", "ready").frequencyRange)
      .toBe("0 THz-9.5 THz");
  });
});

describe("fixed-k modal dispersion routing", () => {
  const publishedSingleKRoute = {
    mode: "dispersion_modal",
    primaryChart: "modal-spectrum",
  } as const;
  const dispersionSubviewRoute = {
    mode: "dispersion_modal",
    primaryChart: "dispersion",
  } as const;
  const singleKContext = {
    kSampling: { kind: "single", vectorRadPerM: [0, 1e7, 0] },
  } as never;

  it("maps the persisted modal subview and selected mode route to a single-k spectrum", () => {
    const manifest = {
      artifacts: {
        dispersion_csv_path: "eigen/dispersion.csv",
        spectrum_v2_path: "eigen/spectrum.v2.json",
      },
      requested_execution: { calculation_mode: "dispersion_modal" },
      k_sampling: { kind: "single", vector_rad_per_m: [0, 1e7, 0] },
    };
    const selectedModeRoute = frequencyDomainChartRouteOverrideFromSelection({
      ref: { type: "frequency-domain", calculationMode: "dispersion_modal" },
    } as never);
    const modalSubviewRoute = frequencyDomainChartRouteOverrideFromSubview(
      "dispersion.modal",
    );
    for (const requestedRoute of [selectedModeRoute, modalSubviewRoute]) {
      expect(
        normalizeFixedKModalRouteOverride(
          requestedRoute,
          publishedSingleKRoute,
          singleKContext,
          "dispersion.modal",
        ),
      ).toEqual(publishedSingleKRoute);
    }
    expect(
      frequencyDomainManifestSupportsChartRoute(
        manifest,
        normalizeFixedKModalRouteOverride(
          modalSubviewRoute,
          publishedSingleKRoute,
          singleKContext,
          "dispersion.modal",
        )!,
      ),
    ).toBe(true);

    expect(
      isFixedKModalSpectrumSubview({
        activeSurface: "dispersion",
        activeSubview: "dispersion.modal",
        resultContext: singleKContext,
        route: publishedSingleKRoute,
      }),
    ).toBe(true);
  });

  it("keeps path dispersion and other dispersion subviews on their published routes", () => {
    const pathContext = {
      kSampling: { kind: "path", sampleCount: 7, label: "Γ–X" },
    } as never;

    expect(
      normalizeFixedKModalRouteOverride(
        dispersionSubviewRoute,
        dispersionSubviewRoute,
        pathContext,
        "dispersion.modal",
      ),
    ).toEqual(dispersionSubviewRoute);
    expect(
      normalizeFixedKModalRouteOverride(
        dispersionSubviewRoute,
        publishedSingleKRoute,
        singleKContext,
        "dispersion.branches",
      ),
    ).toEqual(dispersionSubviewRoute);
    expect(
      isFixedKModalSpectrumSubview({
        activeSurface: "dispersion",
        activeSubview: "dispersion.modal",
        resultContext: pathContext,
        route: publishedSingleKRoute,
      }),
    ).toBe(false);
  });
});
