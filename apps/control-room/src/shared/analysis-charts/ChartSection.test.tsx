import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ChartSection } from "./ChartSection";

describe("ChartSection", () => {
  it("renders title, subtitle, and primary status badge", () => {
    const html = renderToStaticMarkup(
      <ChartSection
        title="Magnetization history"
        subtitle="stage: hysteresis-1"
        status={{ primary: "Live", trust: "qualified" as never, pointSummary: "1,600 pts", revision: 42 }}
      >
        <div>Chart Content</div>
      </ChartSection>,
    );

    expect(html).toContain('aria-label="Magnetization history"');
    expect(html).toContain("Magnetization history");
    expect(html).toContain("stage: hysteresis-1");
    expect(html).toContain("Live");
    expect(html).toContain("Scientific trust: Qualified");
    expect(html).toContain("1,600 pts");
    expect(html).toContain("rev 42");
    expect(html).toContain("fm-chart-section__status--ok");
  });

  it("keeps resource readiness separate from unknown scientific trust", () => {
    const html = renderToStaticMarkup(
      <ChartSection
        title="Energy"
        status={{ primary: "Ready", trust: "unknown" }}
      >
        <div>Chart Content</div>
      </ChartSection>,
    );

    expect(html).toContain("Ready");
    expect(html).toContain("Scientific trust: Unknown");
    expect(html).not.toContain("Canonical");
  });

  it("applies error status class and alert role when status isAlert is true", () => {
    const html = renderToStaticMarkup(
      <ChartSection
        title="Energy"
        status={{ primary: "Failed", isAlert: true }}
      >
        <div>Chart Content</div>
      </ChartSection>,
    );

    expect(html).toContain("fm-chart-section__status--error");
    expect(html).toContain('role="alert"');
  });

  it("renders toolbar, legend, and footer slots when provided", () => {
    const html = renderToStaticMarkup(
      <ChartSection
        title="Table"
        toolbar={<button>Toolbar Action</button>}
        legend={<div>Legend Content</div>}
        footer={<div>Footer Content</div>}
      >
        <div>Main Body</div>
      </ChartSection>,
    );

    expect(html).toContain("Toolbar Action");
    expect(html).toContain("Legend Content");
    expect(html).toContain("Main Body");
    expect(html).toContain("Footer Content");
  });
});
