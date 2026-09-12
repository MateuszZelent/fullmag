import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveChartsView } from "./LiveChartsView";
import type { LiveChartsViewProps } from "./liveChartsViewTypes";

const noop = () => undefined;
const props: LiveChartsViewProps = {
  descriptorId: "magnetization", fitRequest: 0, isFollowing: true,
  onDescriptorChange: noop, onExport: noop, onFit: noop, onChartSelected: noop,
  onPointSelected: noop, onRangeSelected: noop, onRequestedExportHandled: noop,
  onSeriesChange: noop, onToggleFollow: noop, requestedExportFormat: null,
  presentation: { kind: "ready", revision: 7 }, selectedSeriesIds: ["mx"],
  series: [
    { id: "mx", label: "mx", quantity: "mx", unit: "1", xUnit: "s", points: [{ rowIndex: 0, x: 1e-9, y: 0.98 }], source: { kind: "data.table.rows", resourceKey: "table", tableId: "default" }, status: "ready" },
    { id: "energy", label: "Total energy", quantity: "energy", unit: "J", xUnit: "s", points: [{ rowIndex: 0, x: 1e-9, y: 1e-18 }], source: { kind: "data.table.rows", resourceKey: "table", tableId: "default" }, status: "ready" },
  ],
  title: "Magnetization", xAxisLabel: "Time", xAxisId: "t",
  xAxisOptions: [{ id: "t", label: "Time (s)" }, { id: "step", label: "Step" }],
  onXAxisChange: noop, range: { mode: "follow" }, onRangeChange: noop,
};

describe("Live Charts workspace", () => {
  it("offers direct signal, horizontal-axis and sample-window controls", () => {
    const html = renderToStaticMarkup(<LiveChartsView {...props} />);
    expect(html).toContain('aria-label="Search signals"');
    expect(html).toContain('aria-label="Horizontal axis"');
    expect(html).toContain('aria-label="Sample window"');
    expect(html).toContain("Latest sample");
    expect(html).toContain("0.98");
    expect(html).toContain("Total energy");
    expect(html.match(/class="fm-chart-section"/g)).toHaveLength(1);
    expect(html).not.toContain("Magnetization — J");
  });

  it("retains all signal controls when nothing is selected and disables unusable actions", () => {
    const html = renderToStaticMarkup(<LiveChartsView {...props} selectedSeriesIds={[]} />);
    expect(html).toContain("Select at least one signal");
    expect(html).toContain('aria-label="Search signals"');
    expect(html).toMatch(/<button[^>]*aria-label="Fit"[^>]*disabled/);
    expect(html).toMatch(/<button[^>]*aria-label="Export CSV"[^>]*disabled/);
  });

  it("communicates paused data independently from live controls", () => {
    const html = renderToStaticMarkup(<LiveChartsView {...props} isFollowing={false} presentation={{ kind: "paused", visibleRevision: 7, latestKnownRevision: 8 }} />);
    expect(html).toContain('aria-label="Follow"');
    expect(html).toContain("Paused");
    expect(html).toContain("0.98");
  });
});
