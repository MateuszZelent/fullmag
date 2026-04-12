"use client";

import { useCallback, useMemo, useState } from "react";
import { useAnalyzeStore } from "@/features/analyze";
import {
  type ResultsWorkspaceState,
  type ResultNodeKind,
  EMPTY_RESULTS_WORKSPACE,
} from "@/features/analyze/model/resultsWorkspace";
import { applyResultsCommand, type ResultsCommand } from "@/features/analyze/commands/resultsCommands";
import { ResultsAuthoringShell } from "@/features/analyze/views/ResultsAuthoringShell";
import { useWorkspaceGraphStore } from "@/features/workspace-graph";
import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";
import { SidebarSection, InfoRow } from "./primitives";
import { Button } from "../../ui/button";
import PreviewControlsPanel from "./PreviewControlsPanel";

const GRAPH_V2_ENABLED = FRONTEND_DIAGNOSTIC_FLAGS.workspace.enableGraphV2;

function nodeTone(active: boolean): string {
  return active
    ? "border-primary bg-primary/10 text-foreground"
    : "border-border/30 hover:bg-accent/40 text-muted-foreground";
}

function nodeButton(
  active: boolean,
): string {
  return `w-full text-left rounded-md border px-2.5 py-1.5 text-[0.72rem] transition-colors ${nodeTone(active)}`;
}

function SolutionsSection({ workspace, dispatch }: WorkspaceSectionProps) {
  const solutions = workspace.solutions;
  if (solutions.length === 0) return null;
  return (
    <SidebarSection title="Solutions" defaultOpen={true}>
      <div className="flex flex-col gap-1">
        {solutions.map((solution) => (
          <button
            key={solution.id}
            type="button"
            className={nodeButton(workspace.activeResultNodeId === solution.id)}
            onClick={() => dispatch({ type: "result.set-active", nodeId: solution.id })}
          >
            <span className="font-medium">{solution.label}</span>
            <span className="ml-2 text-[0.65rem] opacity-60">
              {solution.solutionKind.replaceAll("_", " ")}
              {solution.revision != null ? ` · rev ${solution.revision}` : ""}
            </span>
          </button>
        ))}
      </div>
    </SidebarSection>
  );
}

// ── Section: Datasets ────────────────────────────────────────

function DatasetsSection({ workspace, dispatch }: WorkspaceSectionProps) {
  const datasets = workspace.datasets;
  if (datasets.length === 0) {
    return (
      <SidebarSection title="Datasets" defaultOpen={true}>
        <p className="text-[0.72rem] text-muted-foreground">
          No datasets yet. Run a study to generate solution data.
        </p>
      </SidebarSection>
    );
  }
  return (
    <SidebarSection title="Datasets" defaultOpen={true}>
      <div className="flex flex-col gap-1">
        {datasets.map((ds) => (
          <button
            key={ds.id}
            type="button"
            className={nodeButton(workspace.activeResultNodeId === ds.id)}
            onClick={() => dispatch({ type: "result.set-active", nodeId: ds.id })}
          >
            <span className="font-medium">{ds.label}</span>
            <span className="ml-2 text-[0.65rem] opacity-60">
              {ds.sampleCount} samples
              {ds.hasEigen ? ` · ${ds.eigenModeCount} modes` : ""}
              {ds.sourceSolutionId ? ` · ${ds.sourceSolutionId}` : ""}
            </span>
          </button>
        ))}
      </div>
    </SidebarSection>
  );
}

// ── Section: Derived Values & Plot Groups ────────────────────

function DerivedValuesSection({ workspace, dispatch }: WorkspaceSectionProps) {
  const derivedValues = workspace.derivedValues;
  const plotGroups = workspace.plotGroups;
  if (derivedValues.length === 0 && plotGroups.length === 0) return null;
  return (
    <SidebarSection title="Derived Values" defaultOpen={true}>
      <div className="flex flex-col gap-1">
        {derivedValues.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={nodeButton(workspace.activeResultNodeId === entry.id)}
            onClick={() => dispatch({ type: "result.set-active", nodeId: entry.id })}
          >
            <span className="font-medium">{entry.label}</span>
            <span className="ml-2 text-[0.65rem] opacity-60">
              {entry.quantityId}
              {entry.unit ? ` · ${entry.unit}` : ""}
              {entry.latestValue != null ? ` · ${entry.latestValue.toExponential(3)}` : ""}
            </span>
          </button>
        ))}
        {plotGroups.map((pg) => (
          <button
            key={pg.id}
            type="button"
            className={nodeButton(workspace.activeResultNodeId === pg.id)}
            onClick={() => dispatch({ type: "result.set-active", nodeId: pg.id })}
          >
            <span className="font-medium">{pg.label}</span>
            <span className="ml-2 text-[0.65rem] opacity-60">
              {pg.plots.length} plots
            </span>
          </button>
        ))}
      </div>
    </SidebarSection>
  );
}

// ── Section: Tables ──────────────────────────────────────────

function TablesSection({ workspace, dispatch }: WorkspaceSectionProps) {
  const tables = workspace.tables;
  if (tables.length === 0) return null;
  return (
    <SidebarSection title="Tables" defaultOpen={true}>
      <div className="flex flex-col gap-1">
        {tables.map((tbl) => (
          <button
            key={tbl.id}
            type="button"
            className={nodeButton(workspace.activeResultNodeId === tbl.id)}
            onClick={() => dispatch({ type: "result.set-active", nodeId: tbl.id })}
          >
            <span className="font-medium">{tbl.label}</span>
            <span className="ml-2 text-[0.65rem] opacity-60">
              {tbl.columns.length} columns
            </span>
          </button>
        ))}
      </div>
    </SidebarSection>
  );
}

// ── Section: Analyses ────────────────────────────────────────

function AnalysesSection({ workspace, dispatch }: WorkspaceSectionProps) {
  const analyses = workspace.analyses;
  if (analyses.length === 0) return null;
  return (
    <SidebarSection title="Analyses" defaultOpen={true}>
      <div className="flex flex-col gap-1">
        {analyses.map((an) => (
          <button
            key={an.id}
            type="button"
            className={nodeButton(workspace.activeResultNodeId === an.id)}
            onClick={() => dispatch({ type: "result.set-active", nodeId: an.id })}
          >
            <span className="font-medium">{an.label}</span>
            <span className="ml-2 text-[0.65rem] opacity-60">
              {an.analysisKind} · {an.status}
            </span>
          </button>
        ))}
      </div>
    </SidebarSection>
  );
}

// ── Section: Reports & Exports ───────────────────────────────

function OutputSection({ workspace, dispatch }: WorkspaceSectionProps) {
  const reports = workspace.reports;
  const exports = workspace.exports;
  if (reports.length === 0 && exports.length === 0) return null;
  return (
    <SidebarSection title="Reports & Exports" defaultOpen={false}>
      <div className="flex flex-col gap-1">
        {reports.map((r) => (
          <button
            key={r.id}
            type="button"
            className={nodeButton(workspace.activeResultNodeId === r.id)}
            onClick={() => dispatch({ type: "result.set-active", nodeId: r.id })}
          >
            <span className="font-medium">{r.label}</span>
            <span className="ml-2 text-[0.65rem] opacity-60">
              {r.sections.length} sections
            </span>
          </button>
        ))}
        {exports.map((ex) => (
          <button
            key={ex.id}
            type="button"
            className={nodeButton(workspace.activeResultNodeId === ex.id)}
            onClick={() => dispatch({ type: "result.set-active", nodeId: ex.id })}
          >
            <span className="font-medium">{ex.label}</span>
            <span className="ml-2 text-[0.65rem] opacity-60">
              {ex.format.toUpperCase()}
            </span>
          </button>
        ))}
      </div>
    </SidebarSection>
  );
}

// ── Props helpers ────────────────────────────────────────────

interface WorkspaceSectionProps {
  workspace: ResultsWorkspaceState;
  dispatch: (cmd: ResultsCommand) => void;
}

// ── Main ResultsPanel ────────────────────────────────────────

export default function ResultsPanel() {
  const analyzeStore = useAnalyzeStore();
  const graphWorkspace = useWorkspaceGraphStore((state) => state.snapshot.resultsWorkspace);
  const applyGraphPatch = useWorkspaceGraphStore((state) => state.applyPatch);
  const [addResultOpen, setAddResultOpen] = useState(false);

  const workspace: ResultsWorkspaceState =
    GRAPH_V2_ENABLED
      ? graphWorkspace ?? EMPTY_RESULTS_WORKSPACE
      : analyzeStore.resultsWorkspace ?? EMPTY_RESULTS_WORKSPACE;

  const dispatch = useCallback(
    (cmd: ResultsCommand) => {
      const next = applyResultsCommand(workspace, cmd);
      analyzeStore.setResultsWorkspace(next);
      if (GRAPH_V2_ENABLED) {
        applyGraphPatch({
          resultsWorkspace: next,
          datasets: next.datasets.map((dataset) => ({
            id: dataset.id,
            label: dataset.label,
            sourceStudyId: dataset.sourceStudyId,
            sourceSolutionId: dataset.sourceSolutionId,
            quantityIds: [],
            scalarCount: 0,
            sampleCount: dataset.sampleCount,
            kind: dataset.hasFinalState ? "artifact" : "analysis",
          })),
          derivedValues: next.derivedValues.map((entry) => ({
            id: entry.id,
            label: entry.label,
            quantityId: entry.quantityId,
            sourceDatasetId: entry.sourceDatasetId,
            latestValue: entry.latestValue,
            unit: entry.unit,
          })),
          selection: {
            activeResultNodeId: next.activeResultNodeId,
          },
        });
      }
    },
    [workspace, analyzeStore, applyGraphPatch],
  );

  const handleAddResult = useCallback(
    (kind: ResultNodeKind, label: string) => {
      switch (kind) {
        case "solution":
          dispatch({
            type: "solution.add",
            solution: {
              id: `sol_${Date.now()}`,
              label,
              nodeKind: "solution",
              pinned: false,
              createdAt: Date.now(),
              lineage: {
                sourceStudyId: workspace.datasets[0]?.sourceStudyId ?? null,
                sourceSolutionId: workspace.datasets[0]?.sourceSolutionId ?? null,
              },
              solutionKind: "artifact",
              revision: null,
              status: "idle",
            },
          });
          break;
        case "dataset":
          dispatch({
            type: "dataset.add",
            dataset: {
              id: `ds_${Date.now()}`,
              label,
              nodeKind: "dataset",
              pinned: false,
              createdAt: Date.now(),
              sourceStudyId: null,
              sourceSolutionId: null,
              lineage: {
                sourceStudyId: null,
                sourceSolutionId: null,
              },
              sampleCount: 0,
              hasFinalState: false,
              hasEigen: false,
              eigenModeCount: 0,
              hasDispersion: false,
            },
          });
          break;
        case "derived_value":
          dispatch({
            type: "derived-value.add",
            derivedValue: {
              id: `dv_${Date.now()}`,
              label,
              nodeKind: "derived_value",
              pinned: false,
              createdAt: Date.now(),
              quantityId: workspace.derivedValues[0]?.quantityId ?? "e_total",
              sourceDatasetId: workspace.datasets[0]?.id ?? null,
              sourceSolutionId: workspace.datasets[0]?.sourceSolutionId ?? null,
              latestValue: null,
              unit: null,
            },
          });
          break;
        case "plot_group":
          dispatch({
            type: "plot-group.add",
            plotGroup: {
              id: `pg_${Date.now()}`,
              label,
              nodeKind: "plot_group",
              pinned: false,
              createdAt: Date.now(),
              sourceDatasetId: workspace.datasets[0]?.id ?? "",
              plots: [],
              display: {
                xAxis: "time",
                yAxis: "auto",
                normalizeY: false,
                logScale: false,
                autoRange: true,
              },
            },
          });
          break;
        case "table":
          dispatch({
            type: "table.add",
            table: {
              id: `tbl_${Date.now()}`,
              label,
              nodeKind: "table",
              pinned: false,
              createdAt: Date.now(),
              sourceDatasetId: workspace.datasets[0]?.id ?? "",
              columns: [],
              sortColumn: null,
              sortDirection: "asc",
              pageSize: 50,
            },
          });
          break;
        case "analysis":
          dispatch({ type: "analysis.add", analysisKind: "eigenmodes", label });
          break;
        case "export":
          dispatch({
            type: "export.add",
            exportNode: {
              id: `exp_${Date.now()}`,
              label,
              nodeKind: "export",
              pinned: false,
              createdAt: Date.now(),
              format: "vtk",
              quantityIds: [],
              frameRange: null,
            },
          });
          break;
        case "report":
          dispatch({
            type: "report.add",
            report: {
              id: `rpt_${Date.now()}`,
              label,
              nodeKind: "report",
              pinned: false,
              createdAt: Date.now(),
              sections: [],
            },
          });
          break;
      }
    },
    [dispatch, workspace.datasets],
  );

  const datasetIds = useMemo(
    () => workspace.datasets.map((ds) => ds.id),
    [workspace.datasets],
  );

  const totalNodes =
    workspace.solutions.length +
    workspace.datasets.length +
    workspace.derivedValues.length +
    workspace.plotGroups.length +
    workspace.tables.length +
    workspace.analyses.length +
    workspace.exports.length +
    workspace.reports.length;

  return (
    <div className="flex flex-col gap-0 pt-2 px-2">
      {/* ── Results Overview ── */}
      <SidebarSection title="Results Workspace" defaultOpen={true}>
        <div className="flex flex-col gap-1">
          <InfoRow label="Solutions" value={String(workspace.solutions.length)} />
          <InfoRow label="Datasets" value={String(workspace.datasets.length)} />
          <InfoRow label="Derived" value={String(workspace.derivedValues.length)} />
          <InfoRow label="Plot Groups" value={String(workspace.plotGroups.length)} />
          <InfoRow label="Tables" value={String(workspace.tables.length)} />
          <InfoRow label="Analyses" value={String(workspace.analyses.length)} />
          <InfoRow label="Total Nodes" value={String(totalNodes)} />
        </div>
        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={() => setAddResultOpen(true)}
          >
            Add Result
          </Button>
        </div>
      </SidebarSection>

      {/* ── Workspace sections ── */}
      <SolutionsSection workspace={workspace} dispatch={dispatch} />
      <DatasetsSection workspace={workspace} dispatch={dispatch} />
      <DerivedValuesSection workspace={workspace} dispatch={dispatch} />
      <TablesSection workspace={workspace} dispatch={dispatch} />
      <AnalysesSection workspace={workspace} dispatch={dispatch} />
      <OutputSection workspace={workspace} dispatch={dispatch} />

      {/* ── Live Preview Controls (bridge from legacy) ── */}
      <PreviewControlsPanel />

      {/* ── Add Result Dialog ── */}
      <ResultsAuthoringShell
        open={addResultOpen}
        onClose={() => setAddResultOpen(false)}
        onAddResult={handleAddResult}
        availableDatasetIds={datasetIds}
      />
    </div>
  );
}
