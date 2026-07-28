import { afterEach, describe, expect, it } from "vitest";

import {
  quickChartWorkspaceStore,
  resetQuickChartWorkspaceForTests,
} from "./quickChartWorkspace";

afterEach(() => {
  resetQuickChartWorkspaceForTests();
});

describe("quickChartWorkspaceStore", () => {
  it("stores only the pinned chart descriptor, never chart samples", () => {
    quickChartWorkspaceStore.pin({
      chartId: "default",
      tableId: "default",
      xAxisId: "step",
      yAxisIds: ["mx", "my"],
    });

    expect(quickChartWorkspaceStore.getSnapshot()).toEqual({
      pinned: {
        chartId: "default",
        tableId: "default",
        xAxisId: "step",
        yAxisIds: ["mx", "my"],
      },
    });
  });
});
