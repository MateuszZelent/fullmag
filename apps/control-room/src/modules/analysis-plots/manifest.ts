import type { ModuleManifest } from "@/kernel/types";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import { analysisPlotsWorkspaceStore } from "@/kernel/workspace/analysisPlotsWorkspace";
import { quickChartWorkspaceStore } from "@/kernel/workspace/quickChartWorkspace";
import {
  isTableChartSeriesId,
  tableColumnIdFromSeriesId,
} from "@/shared/analysis-charts/chartSeriesSelection";

export const analysisPlotsManifest: ModuleManifest = {
  id: "analysis-plots",
  title: "Analysis",
  version: "0.1.0",
  slots: ["viewport-main"],
  component: () => import("./AnalysisPlotsModule"),
  emits: [
    "workspace:selection-changed",
    "analysis-plots:range-selected",
    "analysis-plots:series-selected",
    "analysis-plots:export-requested",
  ],
  listens: ["analysis-plots:add-series-requested", "analysis-plots:export-requested"],
  contributes: {
    commands: [
      {
        id: "analysis-plots.quick-chart.open",
        title: "Pin Quick Chart",
        group: "analysis-plots",
        category: "View",
        scope: "workspace",
        isEnabled: (context: CommandContext) =>
          context.layout?.get().activeViewportMainModuleId === "viewport-3d" &&
          analysisPlotsWorkspaceStore.getSnapshot().selectedSeriesIds.length > 0,
        run: (context: CommandContext) => {
          const chart = analysisPlotsWorkspaceStore.getSnapshot();
          const chartId = "default";
          const tableId = "default";
          const nodeId = `results:quick-charts:${chartId}`;
          quickChartWorkspaceStore.pin({
            chartId,
            tableId,
            xAxisId: chart.xAxisId,
            yAxisIds: chart.selectedSeriesIds
              .filter(isTableChartSeriesId)
              .map(tableColumnIdFromSeriesId),
          });
          context.bus?.emit("explorer:tab-requested", {
            source: "analysis-plots",
            tab: "results",
          });
          context.selection?.set({
            kind: "results.quick_chart",
            label: "Quick Chart",
            nodeId,
            objectId: null,
            ref: {
              chartId,
              kind: "results.quick_chart",
              nodeId,
              tableId,
              type: "quick-chart",
              xAxisId: chart.xAxisId,
              yAxisIds: chart.selectedSeriesIds
                .filter(isTableChartSeriesId)
                .map(tableColumnIdFromSeriesId),
            },
          }, "analysis-plots");
          context.layout?.setFocusedSlot("panel-right");
          return { status: "completed" };
        },
      },
      ...(["csv", "tsv", "png"] as const).map((format) => ({
        id: `analysis-plots.export.${format}`,
        title: `Export Analysis ${format.toUpperCase()}`,
        group: "analysis-plots",
        category: "Analysis",
        scope: "selection" as const,
        run: (context: CommandContext) => {
          const ref = context.selection?.get().ref;
          const chartId =
            ref?.type === "analysis-chart" || ref?.type === "analysis-chart-point"
              ? ref.chartId
              : "default";
          context.bus?.emit("analysis-plots:export-requested", {
            chartId,
            format,
            source: "analysis-plots",
          });
          return { status: "completed" as const };
        },
      })),
      {
        id: "analysis-plots.open",
        title: "Open Analysis Plots",
        group: "analysis-plots",
        category: "Viewport",
        scope: "viewport",
        isActive: (context) =>
          context.layout?.get().activeViewportMainModuleId === "analysis-plots",
        run: (context) => {
          context.layout?.setActiveViewportMainModule("analysis-plots");
          context.layout?.setFocusedSlot("viewport-main");
          return { status: "completed" };
        },
      },
    ],
  },
};
