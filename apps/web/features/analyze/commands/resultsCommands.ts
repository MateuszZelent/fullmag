/**
 * Results workspace commands.
 *
 * Typed discriminated union + pure reducer for all operations on the
 * results workspace state. Follows the same pattern as StudyPipelineCommand.
 */

import type {
  ResultsWorkspaceState,
  DatasetNode,
  PlotGroupNode,
  TableNode,
  AnalysisWorkspaceNode,
  ExportNode,
  ReportNode,
  AnalysisKind,
  PlotEntry,
  PlotDisplayState,
  TableColumnEntry,
  ReportSectionEntry,
} from "../model/resultsWorkspace";
import { EMPTY_RESULTS_WORKSPACE } from "../model/resultsWorkspace";

// ── Command types ────────────────────────────────────────────

export type ResultsCommand =
  // Dataset
  | { type: "dataset.add"; dataset: DatasetNode }
  | { type: "dataset.remove"; datasetId: string }
  | { type: "dataset.rename"; datasetId: string; label: string }
  // Plot group
  | { type: "plot-group.add"; plotGroup: PlotGroupNode }
  | { type: "plot-group.remove"; plotGroupId: string }
  | { type: "plot-group.rename"; plotGroupId: string; label: string }
  | { type: "plot-group.add-plot"; plotGroupId: string; plot: PlotEntry }
  | { type: "plot-group.remove-plot"; plotGroupId: string; plotId: string }
  | { type: "plot-group.update-display"; plotGroupId: string; display: Partial<PlotDisplayState> }
  // Table
  | { type: "table.add"; table: TableNode }
  | { type: "table.remove"; tableId: string }
  | { type: "table.rename"; tableId: string; label: string }
  | { type: "table.toggle-column"; tableId: string; columnId: string }
  | { type: "table.set-sort"; tableId: string; column: string; direction: "asc" | "desc" }
  // Analysis workspace
  | { type: "analysis.add"; analysisKind: AnalysisKind; label?: string }
  | { type: "analysis.remove"; analysisId: string }
  | { type: "analysis.rename"; analysisId: string; label: string }
  | { type: "analysis.set-status"; analysisId: string; status: AnalysisWorkspaceNode["status"] }
  | { type: "analysis.patch-config"; analysisId: string; patch: Record<string, unknown> }
  | { type: "analysis.duplicate"; analysisId: string }
  // Export
  | { type: "export.add"; exportNode: ExportNode }
  | { type: "export.remove"; exportId: string }
  // Report
  | { type: "report.add"; report: ReportNode }
  | { type: "report.remove"; reportId: string }
  | { type: "report.add-section"; reportId: string; section: ReportSectionEntry }
  | { type: "report.remove-section"; reportId: string; sectionId: string }
  // General
  | { type: "result.toggle-pin"; nodeId: string }
  | { type: "result.set-active"; nodeId: string | null }
  | { type: "results.reset" };

// ── Helpers ──────────────────────────────────────────────────

function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 10_000)}`;
}

function updateIn<T extends { id: string }>(
  list: T[],
  id: string,
  updater: (item: T) => T,
): T[] {
  return list.map((item) => (item.id === id ? updater(item) : item));
}

function removeFrom<T extends { id: string }>(list: T[], id: string): T[] {
  return list.filter((item) => item.id !== id);
}

function togglePinIn<T extends { id: string; pinned: boolean }>(list: T[], id: string): T[] {
  return updateIn(list, id, (item) => ({ ...item, pinned: !item.pinned }));
}

// ── Default factories ────────────────────────────────────────

function createDefaultAnalysis(kind: AnalysisKind, label?: string): AnalysisWorkspaceNode {
  const labels: Record<AnalysisKind, string> = {
    eigenmodes: "Eigenmodes Analysis",
    vortex: "Vortex / STNO Analysis",
    fmr: "FMR Analysis",
    hysteresis: "Hysteresis Analysis",
    custom: "Custom Analysis",
  };
  return {
    id: nextId("analysis"),
    label: label ?? labels[kind],
    pinned: false,
    createdAt: Date.now(),
    nodeKind: "analysis",
    analysisKind: kind,
    config: {},
    status: "idle",
  };
}

// ── Reducer ──────────────────────────────────────────────────

export function applyResultsCommand(
  state: ResultsWorkspaceState,
  command: ResultsCommand,
): ResultsWorkspaceState {
  switch (command.type) {
    // ── Dataset ──
    case "dataset.add":
      return { ...state, datasets: [...state.datasets, command.dataset] };
    case "dataset.remove":
      return { ...state, datasets: removeFrom(state.datasets, command.datasetId) };
    case "dataset.rename":
      return {
        ...state,
        datasets: updateIn(state.datasets, command.datasetId, (d) => ({
          ...d,
          label: command.label,
        })),
      };

    // ── Plot group ──
    case "plot-group.add":
      return { ...state, plotGroups: [...state.plotGroups, command.plotGroup] };
    case "plot-group.remove":
      return { ...state, plotGroups: removeFrom(state.plotGroups, command.plotGroupId) };
    case "plot-group.rename":
      return {
        ...state,
        plotGroups: updateIn(state.plotGroups, command.plotGroupId, (g) => ({
          ...g,
          label: command.label,
        })),
      };
    case "plot-group.add-plot":
      return {
        ...state,
        plotGroups: updateIn(state.plotGroups, command.plotGroupId, (g) => ({
          ...g,
          plots: [...g.plots, command.plot],
        })),
      };
    case "plot-group.remove-plot":
      return {
        ...state,
        plotGroups: updateIn(state.plotGroups, command.plotGroupId, (g) => ({
          ...g,
          plots: g.plots.filter((p) => p.id !== command.plotId),
        })),
      };
    case "plot-group.update-display":
      return {
        ...state,
        plotGroups: updateIn(state.plotGroups, command.plotGroupId, (g) => ({
          ...g,
          display: { ...g.display, ...command.display },
        })),
      };

    // ── Table ──
    case "table.add":
      return { ...state, tables: [...state.tables, command.table] };
    case "table.remove":
      return { ...state, tables: removeFrom(state.tables, command.tableId) };
    case "table.rename":
      return {
        ...state,
        tables: updateIn(state.tables, command.tableId, (t) => ({
          ...t,
          label: command.label,
        })),
      };
    case "table.toggle-column":
      return {
        ...state,
        tables: updateIn(state.tables, command.tableId, (t) => ({
          ...t,
          columns: t.columns.map((c) =>
            c.id === command.columnId ? { ...c, visible: !c.visible } : c,
          ),
        })),
      };
    case "table.set-sort":
      return {
        ...state,
        tables: updateIn(state.tables, command.tableId, (t) => ({
          ...t,
          sortColumn: command.column,
          sortDirection: command.direction,
        })),
      };

    // ── Analysis workspace ──
    case "analysis.add":
      return {
        ...state,
        analyses: [...state.analyses, createDefaultAnalysis(command.analysisKind, command.label)],
      };
    case "analysis.remove":
      return { ...state, analyses: removeFrom(state.analyses, command.analysisId) };
    case "analysis.rename":
      return {
        ...state,
        analyses: updateIn(state.analyses, command.analysisId, (a) => ({
          ...a,
          label: command.label,
        })),
      };
    case "analysis.set-status":
      return {
        ...state,
        analyses: updateIn(state.analyses, command.analysisId, (a) => ({
          ...a,
          status: command.status,
        })),
      };
    case "analysis.patch-config":
      return {
        ...state,
        analyses: updateIn(state.analyses, command.analysisId, (a) => ({
          ...a,
          config: { ...a.config, ...command.patch },
        })),
      };
    case "analysis.duplicate": {
      const src = state.analyses.find((a) => a.id === command.analysisId);
      if (!src) return state;
      const dup: AnalysisWorkspaceNode = {
        ...src,
        id: nextId("analysis"),
        label: `${src.label} (copy)`,
        createdAt: Date.now(),
        status: "idle",
      };
      return { ...state, analyses: [...state.analyses, dup] };
    }

    // ── Export ──
    case "export.add":
      return { ...state, exports: [...state.exports, command.exportNode] };
    case "export.remove":
      return { ...state, exports: removeFrom(state.exports, command.exportId) };

    // ── Report ──
    case "report.add":
      return { ...state, reports: [...state.reports, command.report] };
    case "report.remove":
      return { ...state, reports: removeFrom(state.reports, command.reportId) };
    case "report.add-section":
      return {
        ...state,
        reports: updateIn(state.reports, command.reportId, (r) => ({
          ...r,
          sections: [...r.sections, command.section],
        })),
      };
    case "report.remove-section":
      return {
        ...state,
        reports: updateIn(state.reports, command.reportId, (r) => ({
          ...r,
          sections: r.sections.filter((s) => s.id !== command.sectionId),
        })),
      };

    // ── General ──
    case "result.toggle-pin": {
      return {
        ...state,
        datasets: togglePinIn(state.datasets, command.nodeId),
        plotGroups: togglePinIn(state.plotGroups, command.nodeId),
        tables: togglePinIn(state.tables, command.nodeId),
        analyses: togglePinIn(state.analyses, command.nodeId),
        exports: togglePinIn(state.exports, command.nodeId),
        reports: togglePinIn(state.reports, command.nodeId),
      };
    }
    case "result.set-active":
      return { ...state, activeResultNodeId: command.nodeId };
    case "results.reset":
      return { ...EMPTY_RESULTS_WORKSPACE };
  }
}
