import { describe, expect, it } from "vitest";

import { analysisWorkspaceStore, resetAnalysisWorkspaceForTests } from "./analysisWorkspace";

describe("analysis workspace", () => {
  it("keeps source selection as a small explicit identifier", () => {
    resetAnalysisWorkspaceForTests();
    analysisWorkspaceStore.setSelectedDatasetRef("table:run-7:stage-2:table-4");

    expect(analysisWorkspaceStore.getSnapshot().selectedDatasetRef).toBe("table:run-7:stage-2:table-4");

    analysisWorkspaceStore.setSelectedDatasetRef("x".repeat(300));
    expect(analysisWorkspaceStore.getSnapshot().selectedDatasetRef).toBeNull();
  });

  it("owns chart, table, axis, and selected-series state for commands", () => {
    resetAnalysisWorkspaceForTests();
    analysisWorkspaceStore.setSelectedDatasetRef("table:run-7:stage-2:table-4");
    analysisWorkspaceStore.setChartState("step", ["data.table:table:run-7:stage-2:table-4:step:mx"]);
    analysisWorkspaceStore.setActiveSurface("comparison");

    expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
      sourceChartId: "comparison:table:run-7:stage-2:table-4",
      sourceTableId: "table:run-7:stage-2:table-4",
      xAxisId: "step",
      selectedSeriesIds: ["data.table:table:run-7:stage-2:table-4:step:mx"],
    });
  });

  it("stores comparison selection as semantic keys and preserves an explicit empty selection", () => {
    resetAnalysisWorkspaceForTests();
    analysisWorkspaceStore.setSelectedDatasetRef("table-a");
    analysisWorkspaceStore.setComparisonDatasetRef("table-b");
    analysisWorkspaceStore.setComparisonSelection(["mx|1", "mx|1", "energy|J"]);
    expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
      comparisonSelectedSeriesKeys: ["mx|1", "energy|J"],
      hasComparisonSelection: true,
    });
    analysisWorkspaceStore.clearComparisonSelection();
    expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
      comparisonSelectedSeriesKeys: [],
      hasComparisonSelection: true,
    });
  });

  it("keeps a bounded focused chart identity separate from the primary source chart", () => {
    resetAnalysisWorkspaceForTests();
    analysisWorkspaceStore.setSelectedDatasetRef("table-a");
    analysisWorkspaceStore.setFocusedChartId("comparison:table-b");

    expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
      focusedChartId: "comparison:table-b",
      sourceChartId: "dynamics:table-a",
    });

    analysisWorkspaceStore.setFocusedChartId("x".repeat(513));
    expect(analysisWorkspaceStore.getSnapshot().focusedChartId).toBeNull();
  });

  it("projects the effective active descriptor selection separately from a dynamics chart selection", () => {
    resetAnalysisWorkspaceForTests();
    analysisWorkspaceStore.setChartState("step", ["data.table:table-a:step:mx"]);
    analysisWorkspaceStore.setActiveDescriptorId("artifact:frequency-response:v-response");
    analysisWorkspaceStore.setActiveDescriptorSelection("artifact:frequency-response:v-response", ["frequency:artifact://response"]);

    expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
      activeDescriptorId: "artifact:frequency-response:v-response",
      activeDescriptorSelectedSeriesIds: ["frequency:artifact://response"],
      selectedSeriesIds: ["data.table:table-a:step:mx"],
    });
  });

  it("rebases a focused comparison pane to the primary chart when dataset B changes", () => {
    resetAnalysisWorkspaceForTests();
    analysisWorkspaceStore.setActiveSurface("comparison");
    analysisWorkspaceStore.setSelectedDatasetRef("table-a");
    analysisWorkspaceStore.setComparisonDatasetRef("table-b");
    analysisWorkspaceStore.setFocusedChartId("comparison:table-b");

    analysisWorkspaceStore.setComparisonDatasetRef("table-c");
    expect(analysisWorkspaceStore.getSnapshot().focusedChartId).toBe("comparison:table-a");

    analysisWorkspaceStore.setFocusedChartId("comparison:table-c");
    analysisWorkspaceStore.setComparisonDatasetRef(null);
    expect(analysisWorkspaceStore.getSnapshot().focusedChartId).toBe("comparison:table-a");
  });

  it("clears comparison state when primary dataset A changes so A can never equal B", () => {
    resetAnalysisWorkspaceForTests();
    analysisWorkspaceStore.setActiveSurface("comparison");
    analysisWorkspaceStore.setSelectedDatasetRef("table-a");
    analysisWorkspaceStore.setComparisonDatasetRef("table-b");
    analysisWorkspaceStore.setComparisonSelection(["mx|1"]);
    analysisWorkspaceStore.setFocusedChartId("comparison:table-b");
    analysisWorkspaceStore.setActiveDescriptorId("comparison:v-table-a:v-table-b");
    analysisWorkspaceStore.setActiveDescriptorSelection("comparison:v-table-a:v-table-b", ["mx|1"]);

    analysisWorkspaceStore.setSelectedDatasetRef("table-b");
    expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
      comparisonDatasetRef: null,
      comparisonSelectedSeriesKeys: [],
      activeDescriptorId: null,
      activeDescriptorSelectedSeriesIds: [],
      focusedChartId: "comparison:table-b",
      hasComparisonSelection: false,
      selectedDatasetRef: "table-b",
    });
  });
});
