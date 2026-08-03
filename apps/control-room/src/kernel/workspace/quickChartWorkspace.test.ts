import { afterEach, describe, expect, it } from "vitest";

import {
  parsePinnedQuickChart,
  quickChartWorkspaceStore,
  resetQuickChartWorkspaceForTests,
} from "./quickChartWorkspace";

afterEach(() => {
  resetQuickChartWorkspaceForTests();
});

describe("quickChartWorkspaceStore", () => {
  it("stores the complete bounded descriptor with full table series identities", () => {
    quickChartWorkspaceStore.pin({
      chartId: "default",
      displayUnits: { mx: "1" },
      range: { fromSI: 1, toSI: 4 },
      selectedSeriesIds: ["data.table:default:step:mx", "data.table:default:step:my"],
      tableId: "default",
      xAxisId: "step",
    });

    expect(quickChartWorkspaceStore.getSnapshot()).toEqual({
      pinned: {
        chartId: "default",
        displayUnits: { mx: "1" },
        range: { fromSI: 1, toSI: 4 },
        selectedSeriesIds: ["data.table:default:step:mx", "data.table:default:step:my"],
        tableId: "default",
        xAxisId: "step",
      },
    });
  });

  it("migrates legacy yAxisIds once and never writes the legacy field", () => {
    const parsed = parsePinnedQuickChart({
      chartId: "legacy",
      displayUnits: { mx: "1" },
      range: { fromSI: 0, toSI: 2 },
      tableId: "table-4",
      xAxisId: "step",
      yAxisIds: ["mx", "my", "mx", "step"],
    });

    expect(parsed).toEqual({
      chartId: "legacy",
      displayUnits: { mx: "1" },
      range: { fromSI: 0, toSI: 2 },
      selectedSeriesIds: [
        "data.table:table-4:step:mx",
        "data.table:table-4:step:my",
      ],
      tableId: "table-4",
      xAxisId: "step",
    });
    expect(parsed).not.toHaveProperty("yAxisIds");
  });

  it("bounds legacy migration before inspecting an oversized input array", () => {
    const parsed = parsePinnedQuickChart({
      chartId: "legacy-bounded",
      tableId: "default",
      xAxisId: "step",
      yAxisIds: [...Array.from({ length: 100 }, () => "step"), "mx"],
    });

    expect(parsed?.selectedSeriesIds).toEqual([]);
  });

  it("preserves an explicit empty selection and rejects payload-shaped or invalid descriptors", () => {
    expect(parsePinnedQuickChart({
      chartId: "empty",
      displayUnits: {},
      range: null,
      selectedSeriesIds: [],
      tableId: "default",
      xAxisId: "step",
    })?.selectedSeriesIds).toEqual([]);
    expect(parsePinnedQuickChart({
      chartId: "payload",
      displayUnits: {},
      range: null,
      samples: new Float64Array([1]),
      selectedSeriesIds: [],
      tableId: "default",
      xAxisId: "step",
    })).toBeNull();
    expect(parsePinnedQuickChart({
      chartId: "range",
      displayUnits: {},
      range: { fromSI: Number.NaN, toSI: 2 },
      selectedSeriesIds: [],
      tableId: "default",
      xAxisId: "step",
    })?.range).toBeNull();
  });
});
