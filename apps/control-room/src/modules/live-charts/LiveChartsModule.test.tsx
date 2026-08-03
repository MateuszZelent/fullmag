import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { EventBus } from "@/kernel/events/EventBus";
import type { KernelEventMap } from "@/kernel/events/eventTypes";
import { LayoutController } from "@/kernel/layout/LayoutController";
import { SelectionController } from "@/kernel/selection/SelectionController";
import { resolveInspectorPanel } from "@/modules/inspector/inspectorRegistry";

import { liveChartsManifest } from "./manifest";
import { compatibleLiveChartPanes } from "./liveChartsModel";
import { liveChartsCommandRequests } from "./liveChartsCommandRequests";
import { LiveChartSurface } from "./components/LiveChartSurface";
import {
  createLiveChartSelectionHandlers,
  ensureLiveChartsInspectorVisible,
} from "./useLiveChartsController";

describe("LiveChartsModule", () => {
  it("declares the active-run viewport module and its commands", () => {
    expect(liveChartsManifest.id).toBe("live-charts");
    expect(liveChartsManifest.slots).toEqual(["viewport-main"]);
    expect(liveChartsManifest.contributes?.commands?.map((command) => command.id)).toEqual([
      "live-charts.open", "live-charts.follow", "live-charts.pause", "live-charts.fit", "live-charts.set-preset", "live-charts.set-selected-series", "live-charts.set-range", "live-charts.export.csv", "live-charts.export.tsv", "live-charts.export.png",
    ]);
  });

  it("renders three incompatible custom or convergence units as separate panels", () => {
    expect(compatibleLiveChartPanes([
      { id: "torque", label: "max torque", unit: "A/m" },
      { id: "energy", label: "total energy", unit: "J" },
      { id: "time", label: "runtime", unit: "s" },
    ]).map((pane) => pane.label)).toEqual(["A/m", "J", "s"]);
  });

  it("mounts one labelled shared surface per incompatible unit", () => {
    const series = ["A/m", "J", "s"].map((unit, index) => ({
      id: `series-${index}`, label: unit, points: [{ rowIndex: 0, x: 0, y: index + 1 }], quantity: unit,
      source: { kind: "data.table.rows" as const, resourceKey: "resource", tableId: "default" }, status: "ready" as const, unit, xUnit: "1",
    }));
    const html = renderToStaticMarkup(<LiveChartSurface fitRequest={0} onChartSelected={() => undefined} onExport={() => undefined} onPointSelected={() => undefined} onRangeSelected={() => undefined} onRequestedExportHandled={() => undefined} onSeriesChange={() => undefined} presentation={{ kind: "ready", revision: 1 }} requestedExportFormat={null} series={series} selectedSeriesIds={series.map((item) => item.id)} title="Custom" xAxisLabel="step" />);
    expect(html).toContain("Custom — A/m");
    expect(html).toContain("Custom — J");
    expect(html).toContain("Custom — s");
  });

  it("renders an explicit loading state while the live resource has no series yet", () => {
    const html = renderToStaticMarkup(
      <LiveChartSurface
        fitRequest={0}
        onChartSelected={() => undefined}
        onExport={() => undefined}
        onPointSelected={() => undefined}
        onRangeSelected={() => undefined}
        onRequestedExportHandled={() => undefined}
        onSeriesChange={() => undefined}
        presentation={{ kind: "initial-loading" }}
        requestedExportFormat={null}
        series={[]}
        selectedSeriesIds={[]}
        title="Magnetization"
        xAxisLabel="step"
      />,
    );

    expect(html).toContain("Loading live samples");
    expect(html).toContain("Magnetization");
  });

  it("completes fit and export commands only after their mounted request is handled", async () => {
    const handled: string[] = [];
    const unsubscribe = liveChartsCommandRequests.subscribe(() => {
      const action = liveChartsCommandRequests.getSnapshot();
      if (!action) return;
      handled.push(action.kind === "export" ? action.format : action.kind);
      liveChartsCommandRequests.complete();
    });
    const commands = liveChartsManifest.contributes!.commands!;
    expect(await commands.find((command) => command.id === "live-charts.fit")!.run({ source: "test" })).toEqual({ status: "completed" });
    expect(await commands.find((command) => command.id === "live-charts.export.csv")!.run({ source: "test" })).toEqual({ status: "completed" });
    unsubscribe();
    expect(handled).toEqual(["fit", "csv"]);
  });

  it("routes Inspector display changes through the mounted command request", async () => {
    const unsubscribe = liveChartsCommandRequests.subscribe(() => undefined);
    const pending = liveChartsManifest.contributes!.commands!.find(
      (command) => command.id === "live-charts.set-selected-series",
    )!.run({
      input: { descriptorId: "magnetization", selectedSeriesIds: ["mx", "mz"] },
      source: "inspector",
    });
    expect(liveChartsCommandRequests.getSnapshot()).toEqual({
      descriptorId: "magnetization",
      kind: "set-selected-series",
      selectedSeriesIds: ["mx", "mz"],
    });
    liveChartsCommandRequests.complete();
    await expect(pending).resolves.toEqual({ status: "completed" });
    unsubscribe();
  });

  it("routes mounted Live Chart and point interactions through kernel selection into its Inspector", () => {
    const selection = new SelectionController(new EventBus<KernelEventMap>());
    const interactions = createLiveChartSelectionHandlers({
      descriptorId: "magnetization",
      selection,
    });

    interactions.onChartSelected();
    expect(selection.get().ref).toMatchObject({
      descriptorId: "magnetization",
      kind: "live.chart",
      type: "live-chart",
    });
    expect(resolveInspectorPanel(selection.get())?.id).toBe("live-chart");

    interactions.onPointSelected("mx", 1, 7);
    expect(selection.get().ref).toMatchObject({
      descriptorId: "magnetization",
      kind: "live.chart-point",
      pointIndex: 1,
      revision: 7,
      seriesId: "mx",
      type: "live-chart-point",
    });

    const Panel = resolveInspectorPanel(selection.get())!.component;
    expect(renderToStaticMarkup(<Panel selection={selection.get()} />)).toContain("Selected Point");
  });

  it("selects the chart and opens the Inspector when Live Charts is entered", () => {
    const bus = new EventBus<KernelEventMap>();
    const selection = new SelectionController(bus);
    const layout = new LayoutController(bus);

    ensureLiveChartsInspectorVisible({ layout, selection }, "magnetization");

    expect(selection.get()).toMatchObject({
      kind: "live.chart",
      ref: { descriptorId: "magnetization", type: "live-chart" },
    });
    expect(layout.get()).toMatchObject({
      focusedSlot: "panel-right",
      panelVisible: { right: true },
    });
  });
});
