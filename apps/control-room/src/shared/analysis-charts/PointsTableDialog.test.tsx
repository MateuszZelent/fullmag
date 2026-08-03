import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChartRenderModel } from "./chartRenderer";
import { PointsTableDialog } from "./PointsTableDialog";

const model: ChartRenderModel = {
  ariaLabel: "Energy / total",
  key: "energy@7",
  provenance: {
    dataRevision: 7,
    decimation: "minmax_lttb",
    query: "limit=5000",
    resourceKey: "solver/energies",
  },
  series: [
    {
      id: "e_total",
      kind: "line",
      label: "Total",
      points: [
        { rowIndex: 0, x: 0, y: 1e-18 },
        { rowIndex: 1, x: 1e-9, y: 2e-18 },
      ],
      unit: "J",
      yAxis: 0,
    },
  ],
  status: "ready",
  xAxis: { label: "time", unit: "s" },
  yAxes: [{ label: "energy", unit: "J" }],
};

describe("PointsTableDialog", () => {
  it("renders nothing when open is false", () => {
    const html = renderToStaticMarkup(
      <PointsTableDialog model={model} onClose={() => undefined} open={false} />,
    );
    expect(html).toBe("");
  });

  it("renders a dialog with aria-labelledby title when open", () => {
    const html = renderToStaticMarkup(
      <PointsTableDialog model={model} onClose={() => undefined} open />,
    );
    // Native <dialog> has implicit dialog role
    expect(html).toContain("<dialog");
    expect(html).toContain("Energy / total");
    expect(html).toContain("aria-labelledby");
  });

  it("renders provenance metadata when present", () => {
    const html = renderToStaticMarkup(
      <PointsTableDialog model={model} onClose={() => undefined} open />,
    );
    expect(html).toContain("minmax_lttb");
    expect(html).toContain("limit=5000");
  });

  it("shows trust warning for degraded status", () => {
    const degradedModel: ChartRenderModel = { ...model, status: "degraded" };
    const html = renderToStaticMarkup(
      <PointsTableDialog model={degradedModel} onClose={() => undefined} open />,
    );
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("degraded");
  });

  it("does not show trust warning for ready status", () => {
    const html = renderToStaticMarkup(
      <PointsTableDialog model={model} onClose={() => undefined} open />,
    );
    expect(html).not.toContain("role=\"alert\"");
  });

  it("renders table with correct column headers", () => {
    const html = renderToStaticMarkup(
      <PointsTableDialog model={model} onClose={() => undefined} open />,
    );
    expect(html).toContain("time [ns]");
    expect(html).toContain("energy [pJ]");
    expect(html).toContain("Row");
  });

  it("renders row index and data points", () => {
    const html = renderToStaticMarkup(
      <PointsTableDialog model={model} onClose={() => undefined} open />,
    );
    // row index 0 and 1 should be present
    expect(html).toContain(">0<");
    expect(html).toContain(">1<");
  });

  it("keeps dimensionless table values and headers free of SI prefixes", () => {
    const normalizedModel: ChartRenderModel = {
      ...model,
      series: [{
        ...model.series[0]!,
        id: "my",
        label: "my",
        points: [{ rowIndex: 0, x: 0, y: 4.447e-6 }],
        unit: "1",
      }],
      yAxes: [{ label: "Normalized magnetization m", unit: "1" }],
    };
    const html = renderToStaticMarkup(
      <PointsTableDialog model={normalizedModel} onClose={() => undefined} open />,
    );

    expect(html).toContain("Normalized magnetization m");
    expect(html).not.toContain("[1]");
    expect(html).toContain(">4.4470e-6<");
    expect(html).not.toContain("4.447 µ");
  });

  it("shows truncation notice when series has more than MAX_ROWS points", () => {
    const manyPoints = Array.from({ length: 600 }, (_, i) => ({
      rowIndex: i,
      x: i * 1e-9,
      y: i * 1e-18,
    }));
    const largeModel: ChartRenderModel = {
      ...model,
      series: [{ ...model.series[0]!, points: manyPoints }],
    };
    const html = renderToStaticMarkup(
      <PointsTableDialog model={largeModel} onClose={() => undefined} open />,
    );
    expect(html).toContain("Showing first 500 of 600 points");
    // Should only have 500 <tr> cells in tbody (plus 1 header tr)
    const rowMatches = html.match(/<tr>/g);
    expect(rowMatches?.length).toBe(501); // 500 data + 1 header
  });

  it("shows empty state when no series points", () => {
    const emptyModel: ChartRenderModel = { ...model, series: [] };
    const html = renderToStaticMarkup(
      <PointsTableDialog model={emptyModel} onClose={() => undefined} open />,
    );
    expect(html).toContain("No data points");
  });
});
