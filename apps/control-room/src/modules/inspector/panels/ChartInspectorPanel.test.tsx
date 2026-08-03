import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { KernelProvider } from "@/kernel/KernelProvider";
import { analysisWorkspaceStore, resetAnalysisWorkspaceForTests } from "@/kernel/workspace/analysisWorkspace";

import { ChartInspectorPanel } from "./ChartInspectorPanel";

afterEach(resetAnalysisWorkspaceForTests);

describe("ChartInspectorPanel", () => {
  it("shows the explicit Analysis dataset, surface, range, and series without Live Chart controls", () => {
    analysisWorkspaceStore.setSelectedDatasetRef("table:run-7:stage-2:table-4");
    analysisWorkspaceStore.setActiveSurface("dynamics");
    analysisWorkspaceStore.setChartState("step", ["data.table:table:run-7:stage-2:table-4:step:mx"]);
    expect(analysisWorkspaceStore.getSnapshot()).toMatchObject({
      activeSurface: "dynamics",
      selectedDatasetRef: "table:run-7:stage-2:table-4",
      selectedSeriesIds: ["data.table:table:run-7:stage-2:table-4:step:mx"],
      xAxisId: "step",
    });

    const html = renderToStaticMarkup(
      <KernelProvider>
        <ChartInspectorPanel selection={{ kind: "analysis.chart", label: "Analysis chart", moduleSource: "analysis-plots", nodeId: "analysis:charts:table-4", objectId: null, ref: { chartId: "dynamics:table:run-7:stage-2:table-4", kind: "analysis.chart", nodeId: "analysis:charts:table-4", tableId: "table:run-7:stage-2:table-4", type: "analysis-chart" } }} />
      </KernelProvider>,
    );

    expect(html).toContain("dynamics");
    expect(html).toContain("full dataset");
    expect(html).not.toContain("Follow");
    expect(html).not.toContain("Pause");
  });
});
