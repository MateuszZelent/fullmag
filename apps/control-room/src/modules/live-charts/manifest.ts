import type { CommandContext } from "@/kernel/commands/commandTypes";
import type { ModuleManifest } from "@/kernel/types";
import { liveChartsCommandRequests } from "./liveChartsCommandRequests";
import { isLiveChartPresetId } from "@/shared/analysis-charts/liveChartPresets";
import type { ChartRangePreference } from "@/kernel/workspace/liveChartPreferences";

function open(context: CommandContext) { context.layout?.setActiveViewportMainModule("live-charts"); context.layout?.setFocusedSlot("viewport-main"); return { status: "completed" as const }; }

function inputRecord(context: CommandContext): Record<string, unknown> | null {
  return context.input && typeof context.input === "object" && !Array.isArray(context.input)
    ? context.input as Record<string, unknown>
    : null;
}

function descriptorIdFromInput(context: CommandContext): string | null {
  const descriptorId = inputRecord(context)?.descriptorId;
  return typeof descriptorId === "string" && isLiveChartPresetId(descriptorId) ? descriptorId : null;
}

function rangeFromInput(context: CommandContext): ChartRangePreference | null {
  const value = inputRecord(context)?.range;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const range = value as Record<string, unknown>;
  if (range.mode === "follow" || range.mode === "fullDecimated") return { mode: range.mode };
  if (range.mode === "tailRows" && typeof range.rows === "number") return { mode: "tailRows", rows: range.rows };
  if (range.mode === "tailTime" && typeof range.durationS === "number") return { mode: "tailTime", durationS: range.durationS };
  if (range.mode === "fixed" && typeof range.fromSI === "number" && typeof range.toSI === "number") return { mode: "fixed", fromSI: range.fromSI, toSI: range.toSI };
  return null;
}

function commandInputFailure(message: string) { return { status: "failed" as const, message }; }

export const liveChartsManifest: ModuleManifest = {
  id: "live-charts",
  title: "Live Charts",
  version: "0.1.0",
  slots: ["viewport-main"],
  component: () => import("./LiveChartsModule"),
  contributes: { commands: [
    { id: "live-charts.open", title: "Open Live Charts", group: "live-charts", category: "Viewport", scope: "viewport", run: open },
    { id: "live-charts.follow", title: "Follow Live Charts", group: "live-charts", category: "View", scope: "viewport", run: async (context) => { const descriptorId = descriptorIdFromInput(context); return { status: await liveChartsCommandRequests.request(descriptorId ? { descriptorId, kind: "set-live-mode", liveMode: "following" } : { kind: "set-live-mode", liveMode: "following" }) }; } },
    { id: "live-charts.pause", title: "Pause Live Charts", group: "live-charts", category: "View", scope: "viewport", run: async (context) => { const descriptorId = descriptorIdFromInput(context); return { status: await liveChartsCommandRequests.request(descriptorId ? { descriptorId, kind: "set-live-mode", liveMode: "paused" } : { kind: "set-live-mode", liveMode: "paused" }) }; } },
    { id: "live-charts.fit", title: "Fit Live Chart", group: "live-charts", category: "View", scope: "viewport", run: async () => ({ status: await liveChartsCommandRequests.request({ kind: "fit" }) }) },
    { id: "live-charts.set-preset", title: "Set Live Chart preset", group: "live-charts", category: "View", scope: "selection", run: async (context) => { const descriptorId = descriptorIdFromInput(context); return descriptorId ? { status: await liveChartsCommandRequests.request({ descriptorId, kind: "set-preset" }) } : commandInputFailure("A Live Chart preset is required."); } },
    { id: "live-charts.set-selected-series", title: "Set Live Chart series", group: "live-charts", category: "View", scope: "selection", run: async (context) => { const descriptorId = descriptorIdFromInput(context); const selectedSeriesIds = inputRecord(context)?.selectedSeriesIds; return descriptorId && Array.isArray(selectedSeriesIds) && selectedSeriesIds.every((id): id is string => typeof id === "string") ? { status: await liveChartsCommandRequests.request({ descriptorId, kind: "set-selected-series", selectedSeriesIds, }) } : commandInputFailure("Live Chart series selection is invalid."); } },
    { id: "live-charts.set-range", title: "Set Live Chart range", group: "live-charts", category: "View", scope: "selection", run: async (context) => { const descriptorId = descriptorIdFromInput(context); const range = rangeFromInput(context); return descriptorId && range ? { status: await liveChartsCommandRequests.request({ descriptorId, kind: "set-range", range }) } : commandInputFailure("Live Chart range is invalid."); } },
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
