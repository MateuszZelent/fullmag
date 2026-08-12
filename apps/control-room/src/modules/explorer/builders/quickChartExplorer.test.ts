import { describe, expect, it } from "vitest";

import { buildExplorerTree } from "./buildModelTree";

describe("pinned Quick Chart explorer entry", () => {
  it("does not appear without an owned result context", () => {
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

    expect(tree).toEqual([
      expect.objectContaining({
        id: "results:root",
        kind: "results.root",
        status: "unavailable",
      }),
    ]);
    expect(tree[0]?.children).toBeUndefined();
  });
});
