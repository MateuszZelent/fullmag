import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analysisWorkspaceStore, resetAnalysisWorkspaceForTests } from "@/kernel/workspace/analysisWorkspace";
import {
  quickChartWorkspaceStore,
  resetQuickChartWorkspaceForTests,
} from "@/kernel/workspace/quickChartWorkspace";

import { analysisPlotsManifest } from "./manifest";

afterEach(() => {
  resetAnalysisWorkspaceForTests();
  resetQuickChartWorkspaceForTests();
});

describe("pinned Quick Chart ownership", () => {
  it("keeps Analysis in viewport-main and does not render a bottom-dock variant", () => {
    expect(analysisPlotsManifest.slots).toEqual(["viewport-main"]);
    const source = readFileSync(new URL("./AnalysisPlotsModule.tsx", import.meta.url), "utf8");
    expect(source).not.toContain("panel-bottom");
    expect(source).not.toContain("AnalysisQuickChartDock");
  });

  it("pins the complete current table descriptor and opens only the bottom dock", () => {
    const emit = vi.fn();
    const set = vi.fn();
    const openBottomPanel = vi.fn();
    const setActiveViewportMainModule = vi.fn();
    const command = analysisPlotsManifest.contributes?.commands?.find(
      (candidate) => candidate.id === "quick-chart.pin",
    );
    const context = {
      bus: { emit },
      layout: {
        get: () => ({ activeViewportMainModuleId: "analysis-plots" }),
        openBottomPanel,
        setActiveViewportMainModule,
      },
      selection: { set },
    };

    analysisWorkspaceStore.setSelectedDatasetRef("table:run-7:stage-2:table-4");
    analysisWorkspaceStore.setChartState("step", ["data.table:table:run-7:stage-2:table-4:step:mx"]);
    analysisWorkspaceStore.setActiveDescriptorId("dynamics:v-table-4");
    analysisWorkspaceStore.setActiveDescriptorView({
      descriptorId: "dynamics:v-table-4",
      displayUnits: { mx: "1" },
      range: { fromSI: 2, toSI: 8 },
      selectedSeriesIds: ["data.table:table:run-7:stage-2:table-4:step:mx"],
    });
    expect(command?.isEnabled?.(context as never)).toBe(true);
    expect(command?.run(context as never)).toEqual({ status: "completed" });
    expect(quickChartWorkspaceStore.getSnapshot().pinned).toEqual(
      {
        chartId: "dynamics:table:run-7:stage-2:table-4",
        displayUnits: { mx: "1" },
        range: { fromSI: 2, toSI: 8 },
        selectedSeriesIds: ["data.table:table:run-7:stage-2:table-4:step:mx"],
        tableId: "table:run-7:stage-2:table-4",
        xAxisId: "step",
      },
    );
    expect(openBottomPanel).toHaveBeenCalledWith("quick-chart");
    expect(setActiveViewportMainModule).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it("refuses Quick Pin without an explicit Analysis dataset", () => {
    const command = analysisPlotsManifest.contributes?.commands?.find((candidate) => candidate.id === "quick-chart.pin");
    expect(command?.run({ layout: { get: () => ({ activeViewportMainModuleId: "viewport-3d" }) } } as never)).toEqual({ status: "failed", message: "Select a published Analysis dataset first." });
  });

  it("pins the focused secondary comparison table with table-specific series identities", () => {
    const command = analysisPlotsManifest.contributes?.commands?.find((candidate) => candidate.id === "quick-chart.pin");
    const openBottomPanel = vi.fn();
    analysisWorkspaceStore.setActiveSurface("comparison");
    analysisWorkspaceStore.setSelectedDatasetRef("table-a");
    analysisWorkspaceStore.setComparisonDatasetRef("table-b");
    analysisWorkspaceStore.setChartState("step", ["data.table:table-a:step:mx"]);
    analysisWorkspaceStore.setComparisonXAxisId("time");
    analysisWorkspaceStore.setComparisonSelection(["mx|1"]);
    analysisWorkspaceStore.setFocusedChartId("comparison:table-b");
    analysisWorkspaceStore.setActiveDescriptorId("comparison:v-table-a:v-table-b");
    analysisWorkspaceStore.setActiveDescriptorView({
      descriptorId: "comparison:v-table-a:v-table-b",
      displayUnits: { mx: "1" },
      range: { fromSI: 1, toSI: 9 },
      selectedSeriesIds: ["mx|1"],
    });

    expect(command?.run({ layout: { openBottomPanel } } as never)).toEqual({ status: "completed" });
    expect(quickChartWorkspaceStore.getSnapshot().pinned).toEqual({
      chartId: "comparison:table-b",
      displayUnits: { mx: "1" },
      range: null,
      selectedSeriesIds: ["data.table:table-b:time:mx"],
      tableId: "table-b",
      xAxisId: "time",
    });
    expect(openBottomPanel).toHaveBeenCalledWith("quick-chart");
  });

  it("disables and explicitly rejects frequency-domain Quick Pin", () => {
    const command = analysisPlotsManifest.contributes?.commands?.find((candidate) => candidate.id === "quick-chart.pin");
    analysisWorkspaceStore.setActiveSurface("frequency-response");
    analysisWorkspaceStore.setSelectedDatasetRef("stale-table");
    analysisWorkspaceStore.setChartState("step", ["data.table:stale-table:step:mx"]);
    expect(command?.isEnabled?.({ layout: { get: () => ({ activeViewportMainModuleId: "analysis-plots" }) } } as never)).toBe(false);
    expect(command?.run({} as never)).toEqual({
      status: "failed",
      message: "Quick Chart supports explicit Analysis table datasets only.",
    });
  });

  it("exports the explicit source chart identity", () => {
    analysisWorkspaceStore.setSelectedDatasetRef("table:run-7:stage-2:table-4");
    const emit = vi.fn();
    const command = analysisPlotsManifest.contributes?.commands?.find((candidate) => candidate.id === "analysis-plots.export.csv");
    expect(command?.run({ bus: { emit } } as never)).toEqual({ status: "completed" });
    expect(emit).toHaveBeenCalledWith("analysis-plots:export-requested", { chartId: "dynamics:table:run-7:stage-2:table-4", format: "csv", source: "analysis-plots" });
  });

  it("never exports a stale secondary comparison focus after replacing or clearing dataset B", () => {
    analysisWorkspaceStore.setActiveSurface("comparison");
    analysisWorkspaceStore.setSelectedDatasetRef("table-a");
    analysisWorkspaceStore.setComparisonDatasetRef("table-b");
    analysisWorkspaceStore.setFocusedChartId("comparison:table-b");
    const command = analysisPlotsManifest.contributes?.commands?.find((candidate) => candidate.id === "analysis-plots.export.csv");
    const emit = vi.fn();

    analysisWorkspaceStore.setComparisonDatasetRef("table-c");
    expect(command?.run({ bus: { emit } } as never)).toEqual({ status: "completed" });
    expect(emit).toHaveBeenLastCalledWith("analysis-plots:export-requested", { chartId: "comparison:table-a", format: "csv", source: "analysis-plots" });

    analysisWorkspaceStore.setFocusedChartId("comparison:table-c");
    analysisWorkspaceStore.setComparisonDatasetRef(null);
    expect(command?.run({ bus: { emit } } as never)).toEqual({ status: "completed" });
    expect(emit).toHaveBeenLastCalledWith("analysis-plots:export-requested", { chartId: "comparison:table-a", format: "csv", source: "analysis-plots" });
    expect(emit.mock.calls.flat()).not.toContain("comparison:table-b");
  });

  it("exposes Quick Chart only through the transport footer", () => {
    const source = readFileSync(
      new URL("../footer/FooterModule.tsx", import.meta.url),
      "utf8",
    );
    expect(source).not.toContain('TabsTrigger value="analysis"');
    expect(source).toContain('TabsTrigger value="quick-chart"');
  });
});
