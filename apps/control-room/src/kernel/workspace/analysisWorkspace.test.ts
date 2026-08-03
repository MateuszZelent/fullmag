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
});
