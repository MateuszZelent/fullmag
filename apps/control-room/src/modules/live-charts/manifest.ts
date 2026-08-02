import type { CommandContext } from "@/kernel/commands/commandTypes";
import type { ModuleManifest } from "@/kernel/types";
import { liveChartPreferencesStore } from "@/kernel/workspace/liveChartPreferences";
import { liveChartsCommandRequests } from "./liveChartsCommandRequests";

function open(context: CommandContext) { context.layout?.setActiveViewportMainModule("live-charts"); context.layout?.setFocusedSlot("viewport-main"); return { status: "completed" as const }; }

export const liveChartsManifest: ModuleManifest = {
  id: "live-charts",
  title: "Live Charts",
  version: "0.1.0",
  slots: ["viewport-main"],
  component: () => import("./LiveChartsModule"),
  contributes: { commands: [
    { id: "live-charts.open", title: "Open Live Charts", group: "live-charts", category: "Viewport", scope: "viewport", run: open },
    { id: "live-charts.follow", title: "Follow Live Charts", group: "live-charts", category: "View", scope: "viewport", run: () => { liveChartPreferencesStore.updateDescriptor("magnetization", () => ({ liveMode: "following" })); return { status: "completed" as const }; } },
    { id: "live-charts.pause", title: "Pause Live Charts", group: "live-charts", category: "View", scope: "viewport", run: () => { liveChartPreferencesStore.updateDescriptor("magnetization", () => ({ liveMode: "paused" })); return { status: "completed" as const }; } },
    { id: "live-charts.fit", title: "Fit Live Chart", group: "live-charts", category: "View", scope: "viewport", run: async () => ({ status: await liveChartsCommandRequests.request({ kind: "fit" }) }) },
    ...(["csv", "tsv", "png"] as const).map((format) => ({
      id: `live-charts.export.${format}`,
      title: `Export Live Chart ${format.toUpperCase()}`,
      group: "live-charts",
      category: "Analysis",
      scope: "viewport" as const,
      run: async () => ({ status: await liveChartsCommandRequests.request({ format, kind: "export" }) }),
    })),
  ] },
};
