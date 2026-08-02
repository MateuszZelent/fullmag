import { describe, expect, it } from "vitest";

import type { ChartSeries } from "./chartTableModel";
import {
  buildFrequencyDomainCursorSummary,
  buildFrequencyDomainWorkbenchSummary,
  resourceStatusFromString,
} from "./analysisWorkbenchModel";

describe("resourceStatusFromString", () => {
  it("treats a paused chart as a frozen ready resource, not idle data", () => {
    expect(resourceStatusFromString("paused")).toBe("ready");
  });
});

describe("buildFrequencyDomainWorkbenchSummary", () => {
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
      "FMR response sweep",
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

    expect(buildFrequencyDomainWorkbenchSummary(series, "FMR response sweep", "ready").frequencyRange).toBe("9.5 THz");
    expect(buildFrequencyDomainCursorSummary(point, "FMR response sweep", series)?.xValue).toBe("9.5 THz");
    expect(buildFrequencyDomainCursorSummary(point, "FMR response sweep", series)?.yValue).toBe("0.5");
  });
});
