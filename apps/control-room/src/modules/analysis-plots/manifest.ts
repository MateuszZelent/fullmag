import type { ModuleManifest } from "@/kernel/types";

export const analysisPlotsManifest: ModuleManifest = {
  id: "analysis-plots",
  title: "Analysis",
  version: "0.1.0",
  slots: ["viewport-main"],
  component: () => import("./AnalysisPlotsModule"),
  contributes: {
    commands: [
      {
        id: "analysis-plots.open",
        title: "Open Analysis Plots",
        group: "analysis-plots",
        category: "Viewport",
        scope: "viewport",
        isActive: (context) =>
          context.layout?.get().activeViewportMainModuleId ===
          "analysis-plots",
        run: (context) => {
          context.layout?.setActiveViewportMainModule("analysis-plots");
          context.layout?.setFocusedSlot("viewport-main");
          return { status: "completed" };
        },
      },
    ],
  },
};
