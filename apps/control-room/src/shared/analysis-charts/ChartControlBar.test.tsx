import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ChartControlBar, chartRangeOptions } from "./ChartControlBar";

describe("ChartControlBar", () => {
  it("renders Live button, visible points, range mode badge, and Fit button", () => {
    const html = renderToStaticMarkup(
      <ChartControlBar
        liveMode="following"
        rangeMode={{ mode: "follow" }}
        visiblePoints={1600}
        totalRows={5000}
        onLiveModeToggle={vi.fn()}
        onFitView={vi.fn()}
      />,
    );

    expect(html).toContain("Live");
    expect(html).toContain("1,600");
    expect(html).toContain("5,000");
    expect(html).toContain("Follow");
    expect(html).toContain("Fit");
  });

  it("renders Paused button when liveMode is paused", () => {
    const html = renderToStaticMarkup(
      <ChartControlBar
        liveMode="paused"
        rangeMode={{ mode: "fixed" }}
        visiblePoints={500}
        onLiveModeToggle={vi.fn()}
        onFitView={vi.fn()}
      />,
    );

    expect(html).toContain("Paused");
    expect(html).toContain("fm-chart-control-bar__live-btn--paused");
    expect(html).toContain("Fixed range");
  });

  it("labels a one-nanosecond range in nanoseconds", () => {
    const html = renderToStaticMarkup(
      <ChartControlBar
        liveMode="following"
        rangeMode={{ mode: "tailTime", durationS: 1e-9 }}
        onLiveModeToggle={vi.fn()}
        onFitView={vi.fn()}
      />,
    );

    expect(html).toContain("Last 1 ns");
    expect(html).not.toContain("0.001 µs");
  });

  it("does not offer time-window presets without a simulation-time X axis", () => {
    expect(chartRangeOptions(false).map((option) => option.value)).not.toContain("tailTime:1e-9");
    expect(chartRangeOptions(true).map((option) => option.value)).toContain("tailTime:1e-9");
  });

  it("offers an exact last-160-points preset distinct from the render budget", () => {
    const values = chartRangeOptions().map((option) => option.value);
    expect(values).toContain("tailRows:160");
  });

  it("offers fixed range only after the chart has an explicit zoom range", () => {
    expect(chartRangeOptions(true, false).map((option) => option.value)).not.toContain("fixed");
    expect(chartRangeOptions(true, true).map((option) => option.value)).toContain("fixed");
  });
});
