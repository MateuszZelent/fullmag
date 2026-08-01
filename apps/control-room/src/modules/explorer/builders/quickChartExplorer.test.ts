import { describe, expect, it } from "vitest";

import { buildExplorerTree } from "./buildModelTree";

describe("pinned Quick Chart explorer entry", () => {
  it("appears under Results and carries only a payload-free descriptor", () => {
    const tree = buildExplorerTree("results", {
      pinnedQuickChart: {
        chartId: "default",
        tableId: "default",
        xAxisId: "step",
        yAxisIds: ["mx", "my"],
      },
    });

    expect(tree[0]?.children).toContainEqual(expect.objectContaining({
      chartId: "default",
      id: "results:quick-charts:default",
      kind: "results.quick_chart",
      tableId: "default",
      xAxisId: "step",
      yAxisIds: ["mx", "my"],
    }));
  });
});
