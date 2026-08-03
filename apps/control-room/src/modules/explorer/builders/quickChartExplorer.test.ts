import { describe, expect, it } from "vitest";

import { buildExplorerTree } from "./buildModelTree";

describe("pinned Quick Chart explorer entry", () => {
  it("appears under Results and carries only a payload-free descriptor", () => {
    const tree = buildExplorerTree("results", {
      pinnedQuickChart: {
        chartId: "default",
        displayUnits: { mx: "1" },
        range: { fromSI: 0, toSI: 4 },
        selectedSeriesIds: [
          "data.table:default:step:mx",
          "data.table:default:step:my",
        ],
        tableId: "default",
        xAxisId: "step",
      },
    });

    expect(tree[0]?.children).toContainEqual(expect.objectContaining({
      chartId: "default",
      displayUnits: { mx: "1" },
      id: "results:quick-charts:default",
      kind: "results.quick_chart",
      range: { fromSI: 0, toSI: 4 },
      selectedSeriesIds: [
        "data.table:default:step:mx",
        "data.table:default:step:my",
      ],
      tableId: "default",
      xAxisId: "step",
    }));
  });
});
