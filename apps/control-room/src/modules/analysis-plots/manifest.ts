import type { ModuleManifest } from "@/kernel/types";
import type { CommandContext } from "@/kernel/commands/commandTypes";
import { analysisWorkspaceStore, type AnalysisWorkspaceState } from "@/kernel/workspace/analysisWorkspace";
import { quickChartWorkspaceStore, type PinnedQuickChart } from "@/kernel/workspace/quickChartWorkspace";
import type { AnalysisSurface } from "@/kernel/workspace/analysisViewPreferences";

interface OpenAnalysisInput {
  datasetRef: string;
  surface: AnalysisSurface;
  tableId: string;
}

function openAnalysisInput(context: CommandContext): OpenAnalysisInput | null {
  const input = context.input;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  if (
    typeof candidate.datasetRef !== "string" ||
    candidate.datasetRef.length === 0 ||
    typeof candidate.tableId !== "string" ||
    candidate.tableId.length === 0 ||
    candidate.surface !== "dynamics" ||
    candidate.datasetRef !== `table:${candidate.tableId}`
  ) {
    return null;
  }
  return {
    datasetRef: candidate.datasetRef,
    surface: candidate.surface,
    tableId: candidate.tableId,
  };
}

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
        id: "quick-chart.pin",
        title: "Pin Quick Chart",
        group: "quick-chart",
        category: "View",
        scope: "workspace",
        isEnabled: () =>
          resolveQuickChartDescriptor(analysisWorkspaceStore.getSnapshot()).descriptor !== null,
        run: (context: CommandContext) => {
          const analysis = analysisWorkspaceStore.getSnapshot();
          const resolved = resolveQuickChartDescriptor(analysis);
          if (!resolved.descriptor) return { status: "failed", message: resolved.message };
          quickChartWorkspaceStore.pin(resolved.descriptor);
          context.layout?.openBottomPanel("quick-chart");
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
          const chartId = analysisWorkspaceStore.getSnapshot().focusedChartId ??
            analysisWorkspaceStore.getSnapshot().sourceChartId;
          if (!chartId) return { status: "failed" as const, message: "Select an Analysis dataset first." };
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
          if (context.input !== undefined && !openAnalysisInput(context)) {
            return {
              message: "Published table Analysis action is invalid.",
              status: "failed",
            };
          }
          const input = openAnalysisInput(context);
          if (input) {
            // The Results action carries both identities: tableId is the
            // Analysis loader key, while datasetRef remains the resource
            // identity used for provenance and action targeting.
            analysisWorkspaceStore.setActiveSurface(input.surface);
            analysisWorkspaceStore.setSelectedDatasetRef(input.tableId);
          }
          context.layout?.setActiveViewportMainModule("analysis-plots");
          context.layout?.setFocusedSlot("viewport-main");
          return { status: "completed" };
        },
      },
    ],
  },
};

function resolveQuickChartDescriptor(
  analysis: AnalysisWorkspaceState,
): { descriptor: PinnedQuickChart | null; message: string } {
  if (analysis.activeSurface !== "dynamics" && analysis.activeSurface !== "comparison") {
    return {
      descriptor: null,
      message: "Quick Chart supports explicit Analysis table datasets only.",
    };
  }
  if (!analysis.selectedDatasetRef || !analysis.sourceTableId) {
    return {
      descriptor: null,
      message: "Select a published Analysis dataset first.",
    };
  }
  const secondaryFocused = analysis.activeSurface === "comparison" &&
    Boolean(analysis.comparisonDatasetRef) &&
    analysis.focusedChartId === `comparison:${analysis.comparisonDatasetRef}`;
  const tableId = secondaryFocused
    ? analysis.comparisonDatasetRef!
    : analysis.sourceTableId;
  const xAxisId = secondaryFocused ? analysis.comparisonXAxisId : analysis.xAxisId;
  if (!xAxisId) {
    return { descriptor: null, message: "The selected Analysis table is not ready." };
  }
  const selectedSeriesIds = analysis.activeSurface === "comparison"
    ? analysis.comparisonSelectedSeriesKeys.flatMap((key) => {
        const separator = key.indexOf("|");
        const encodedColumnId = separator >= 0 ? key.slice(0, separator) : key;
        try {
          const columnId = decodeURIComponent(encodedColumnId);
          return columnId && columnId !== xAxisId
            ? [`data.table:${tableId}:${xAxisId}:${columnId}`]
            : [];
        } catch {
          return [];
        }
      })
    : analysis.activeDescriptorSelectedSeriesIds;
  return {
    descriptor: {
      chartId: secondaryFocused
        ? `comparison:${tableId}`
        : analysis.sourceChartId ?? `${analysis.activeSurface}:${tableId}`,
      displayUnits: analysis.activeDescriptorDisplayUnits,
      range: secondaryFocused && analysis.xAxisId !== xAxisId
        ? null
        : analysis.activeDescriptorRange,
      selectedSeriesIds,
      tableId,
      xAxisId,
    },
    message: "",
  };
}
