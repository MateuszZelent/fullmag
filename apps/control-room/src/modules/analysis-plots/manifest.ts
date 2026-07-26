import type { ModuleManifest } from "@/kernel/types";
import type { CommandContext } from "@/kernel/commands/commandTypes";

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
        title: "Open Quick Chart",
        group: "analysis-plots",
        category: "View",
        scope: "workspace",
        run: (context: CommandContext) => {
          context.layout?.openBottomPanel("analysis");
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
