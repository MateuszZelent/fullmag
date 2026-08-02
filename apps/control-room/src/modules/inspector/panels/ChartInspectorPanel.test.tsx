import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  analysisPlotsWorkspaceStore,
  resetAnalysisPlotsWorkspaceForTests,
} from "@/kernel/workspace/analysisPlotsWorkspace";
import { KernelProvider } from "@/kernel/KernelProvider";
import { nextYAxisIdsForToggle } from "@/shared/domain/analysis/TableColumnList";

import { ChartInspectorPanel } from "./ChartInspectorPanel";

afterEach(() => {
  resetAnalysisPlotsWorkspaceForTests();
});

describe("ChartInspectorPanel", () => {
  it("owns table-chart controls and does not embed a Quick Chart", () => {
    analysisPlotsWorkspaceStore.setAvailableColumns([
      { column_id: "step", label: "step", unit: "1" },
      { column_id: "mx", label: "mx", unit: "1" },
    ]);
    analysisPlotsWorkspaceStore.setRangeMode({ mode: "tailRows", rows: 160 });

    const html = renderToStaticMarkup(
      <KernelProvider>
        <ChartInspectorPanel
          selection={{
            kind: "analysis.chart",
            label: "Table chart",
            moduleSource: "analysis-plots",
            nodeId: "analysis:charts:default",
            objectId: null,
            ref: {
              chartId: "default",
              kind: "analysis.chart",
              nodeId: "analysis:charts:default",
              tableId: "default",
              type: "analysis-chart",
            },
          }}
        />
      </KernelProvider>,
    );

    expect(html).toContain('aria-label="Chart controls"');
    expect(html).toContain("Last 160 rows");
    expect(html).toContain("Columns");
    expect(html).not.toContain("Quick Chart");
  });

  it("clears a chart zoom from the inspector rather than the chart surface", () => {
    analysisPlotsWorkspaceStore.setRange({ fromValue: 20, toValue: 40 });

    const html = renderToStaticMarkup(
      <KernelProvider>
        <ChartInspectorPanel
          selection={{
            kind: "analysis.chart",
            label: "Table chart",
            moduleSource: "analysis-plots",
            nodeId: "analysis:charts:default",
            objectId: null,
            ref: {
              chartId: "default",
              kind: "analysis.chart",
              nodeId: "analysis:charts:default",
              tableId: "default",
              type: "analysis-chart",
            },
          }}
        />
      </KernelProvider>,
    );

    expect(html).toContain("Clear zoom");
  });

  it("allows the inspector to remove its final selected signal", () => {
    expect(nextYAxisIdsForToggle(["mx"], "mx", false)).toEqual([]);
  });
});
