"use client";

import { useCallback, useEffect, useMemo } from "react";
import { RefreshCw } from "lucide-react";

import DispersionBranchPlot from "@/components/analyze/DispersionBranchPlot";
import EigenAnalyzeWorkbench from "@/components/analyze/EigenAnalyzeWorkbench";
import EigenModeInspector from "@/components/analyze/EigenModeInspector";
import ModeSpectrumPlot from "@/components/analyze/ModeSpectrumPlot";
import VortexAnalyzeWorkbench from "@/components/analyze/VortexAnalyzeWorkbench";
import type { VortexTimeSample } from "@/components/analyze/vortexTypes";
import EmptyState from "@/components/ui/EmptyState";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useWorkspaceGraphStore } from "@/features/workspace-graph";
import { findResultNode } from "@/features/analyze/model/resultsWorkspace";
import { parseAnalyzeTreeNode } from "./analyzeSelection";

import AnalyzeDiagnosticsPanel from "./AnalyzeDiagnosticsPanel";
import AnalyzeRuntimeBadges from "./AnalyzeRuntimeBadges";
import { useCommand, useModel, useTransport } from "./ControlRoomContext";
import { useAnalyzeWorkspaceState } from "./useAnalyzeWorkspaceState";
import { useAnalyzeRuntimeDiagnostics } from "./useAnalyzeRuntimeDiagnostics";

function fmtGHz(hz: number): string {
  return `${(hz / 1e9).toFixed(4)} GHz`;
}

function includedTermsLabel(
  includedTerms:
    | {
        exchange?: boolean;
        demag?: boolean;
        zeeman?: boolean;
        interfacial_dmi?: boolean;
        bulk_dmi?: boolean;
        surface_anisotropy?: boolean;
      }
    | undefined,
): string | null {
  if (!includedTerms) return null;
  const labels = [
    includedTerms.exchange ? "exchange" : null,
    includedTerms.demag ? "demag" : null,
    includedTerms.zeeman ? "zeeman" : null,
    includedTerms.interfacial_dmi ? "iDMI" : null,
    includedTerms.bulk_dmi ? "bDMI" : null,
    includedTerms.surface_anisotropy ? "surface-K" : null,
  ].filter(Boolean);
  return labels.length > 0 ? labels.join(" · ") : null;
}

function compactList(values: string[] | undefined): string | null {
  if (!values || values.length === 0) return null;
  return values.join(" · ");
}

export default function AnalyzeViewport() {
  const model = useModel();
  const cmd = useCommand();
  const tp = useTransport();
  const graphSelection = useWorkspaceGraphStore((state) => state.snapshot.selection);
  const graphResultsWorkspace = useWorkspaceGraphStore((state) => state.snapshot.resultsWorkspace);
  const graphActiveViewportDocument = useWorkspaceGraphStore((state) => {
    const id = state.snapshot.selection.activeViewportDocumentId;
    return id ? state.snapshot.viewportDocuments[id] ?? null : null;
  });

  /* ── Vortex time-domain samples from scalar rows ── */
  const vortexSamples = useMemo<VortexTimeSample[]>(() => {
    if (!tp.scalarRows || tp.scalarRows.length === 0) return [];
    return tp.scalarRows.map((r) => ({
      time: r.time,
      mx: r.mx,
      my: r.my,
      mz: r.mz,
    }));
  }, [tp.scalarRows]);

  const hasVortexData = vortexSamples.length > 4;
  const analyzeDomain = model.analyzeSelection.domain ?? "eigenmodes";
  const activeDatasetLabel = useMemo(() => {
    const datasetId = graphActiveViewportDocument?.selectedDatasetId;
    if (!datasetId) {
      return null;
    }
    return (
      graphResultsWorkspace.datasets.find((dataset) => dataset.id === datasetId)?.label
      ?? datasetId
    );
  }, [graphActiveViewportDocument?.selectedDatasetId, graphResultsWorkspace.datasets]);

  useEffect(() => {
    const treeSelection = parseAnalyzeTreeNode(graphSelection.activeNodeId ?? "");
    if (treeSelection) {
      const nextDomain = treeSelection.domain ?? model.analyzeSelection.domain;
      const nextTab = treeSelection.tab ?? model.analyzeSelection.tab;
      if (
        nextDomain !== model.analyzeSelection.domain
        || nextTab !== model.analyzeSelection.tab
        || (treeSelection.selectedModeIndex ?? null) !== model.analyzeSelection.selectedModeIndex
        || (treeSelection.selectedChannel ?? null) !== model.analyzeSelection.selectedChannel
      ) {
        model.openAnalyze(treeSelection);
      }
      return;
    }
    const activeResultNode = graphSelection.activeResultNodeId
      ? findResultNode(graphResultsWorkspace, graphSelection.activeResultNodeId)
      : null;
    if (!activeResultNode) {
      return;
    }
    if (activeResultNode.nodeKind === "analysis") {
      const next = {
        domain: activeResultNode.analysisKind === "vortex" ? "vortex" : "eigenmodes",
        tab:
          activeResultNode.analysisKind === "vortex"
            ? "vortex-trajectory"
            : "spectrum",
      } as const;
      if (
        next.domain !== model.analyzeSelection.domain
        || next.tab !== model.analyzeSelection.tab
      ) {
        model.openAnalyze(next);
      }
      return;
    }
    if (activeResultNode.nodeKind === "plot_group" || activeResultNode.nodeKind === "table") {
      if (
        model.analyzeSelection.domain !== "eigenmodes"
        || model.analyzeSelection.tab !== "spectrum"
      ) {
        model.openAnalyze({ domain: "eigenmodes", tab: "spectrum" });
      }
    }
  }, [
    graphResultsWorkspace,
    graphSelection.activeNodeId,
    graphSelection.activeResultNodeId,
    model.analyzeSelection.domain,
    model.analyzeSelection.selectedChannel,
    model.analyzeSelection.selectedModeIndex,
    model.analyzeSelection.tab,
    model,
  ]);

  const setSelectedModeIndex = useCallback(
    (index: number | null) =>
      model.setAnalyzeSelection((prev) => ({ ...prev, selectedModeIndex: index })),
    [model],
  );
  const setAnalyzeTab = useCallback(
    (tab: Parameters<typeof model.selectAnalyzeTab>[0]) => model.selectAnalyzeTab(tab),
    [model],
  );

  const {
    loadState,
    modeLoadState,
    error,
    modeError,
    mesh,
    spectrum,
    branches,
    dispersionRows,
    hasEigenArtifacts,
    refresh,
    selectedMode,
    selectedModeArtifact,
    selectedModeSummary,
    selectMode,
  } = useAnalyzeWorkspaceState({
    analyzeSelection: model.analyzeSelection,
    setSelectedModeIndex,
    setTab: setAnalyzeTab,
  });

  const diagnostics = useAnalyzeRuntimeDiagnostics({
    runtimeEngineLabel: cmd.runtimeEngineLabel,
    latestBackendError: cmd.latestBackendError,
    engineLog: cmd.engineLog,
    magneticParts: model.magneticParts,
    airPart: model.airPart,
    interfaceParts: model.interfaceParts,
    metadata: cmd.metadata,
  });

  // ← / → keyboard shortcuts to navigate between eigen modes
  useEffect(() => {
    if (!spectrum || spectrum.modes.length === 0) return;
    const sortedModes = [...spectrum.modes].sort((a, b) => a.index - b.index);
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // Don't steal focus when user is typing in an input
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      const currentIndex = model.analyzeSelection.selectedModeIndex ?? sortedModes[0].index;
      const pos = sortedModes.findIndex((m) => m.index === currentIndex);
      if (pos === -1) return;
      const next =
        e.key === "ArrowRight"
          ? sortedModes[Math.min(pos + 1, sortedModes.length - 1)]
          : sortedModes[Math.max(pos - 1, 0)];
      if (next && next.index !== currentIndex) {
        selectMode(next.index);
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [model.analyzeSelection.selectedModeIndex, selectMode, spectrum]);

  /* ── Vortex domain ── */
  if (analyzeDomain === "vortex") {
    if (!hasVortexData) {
      return (
        <div className="flex h-full items-center justify-center">
          <EmptyState
            title="No time-domain data"
            description="Run a TimeEvolution study with mx/my/mz scalar outputs to use Vortex analysis."
            tone="info"
            compact
          />
        </div>
      );
    }
    return (
      <VortexAnalyzeWorkbench
        samples={vortexSamples}
        activeTab={model.analyzeSelection.tab}
        onTabChange={(tab) => model.selectAnalyzeTab(tab)}
        selectedChannel={
          (model.analyzeSelection.selectedChannel as "mx" | "my" | "mz") ?? undefined
        }
      />
    );
  }

  /* ── Eigenmodes domain ── */
  if (loadState === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="Loading eigen data"
          description="Fetching spectrum and artifacts from the active session."
          tone="info"
          compact
        />
      </div>
    );
  }

  if (loadState === "error") {
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="Analyze unavailable"
          description={error ?? "No active eigen data."}
          tone="warning"
          compact
        />
      </div>
    );
  }

  if (!hasEigenArtifacts || !spectrum) {
    // Fall through to vortex if we have time-domain data
    if (hasVortexData) {
      return (
        <VortexAnalyzeWorkbench
          samples={vortexSamples}
          activeTab={model.analyzeSelection.tab}
          onTabChange={(tab) => model.selectAnalyzeTab(tab)}
          selectedChannel={
            (model.analyzeSelection.selectedChannel as "mx" | "my" | "mz") ?? undefined
          }
        />
      );
    }
    return (
      <div className="flex h-full items-center justify-center">
        <EmptyState
          title="No analysis data"
          description="Run a FEM Eigenmodes study or a TimeEvolution study with scalar outputs to unlock Analyze."
          tone="info"
          compact
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <div className="shrink-0 border-b border-border/30 bg-card/30 px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-sm border border-border/40 bg-muted/50 px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-widest text-muted-foreground">
            Analyze
          </span>
          <AnalyzeRuntimeBadges badges={diagnostics.badges} />
          {activeDatasetLabel && (
            <span className="rounded-sm border border-border/30 bg-muted/40 px-1.5 py-0.5 text-[0.62rem] font-bold tracking-widest text-muted-foreground">
              dataset: {activeDatasetLabel}
            </span>
          )}
          {spectrum.solver_kind && (
            <span className="rounded-sm border border-sky-500/25 bg-sky-500/10 px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-widest text-sky-200">
              {spectrum.solver_kind}
            </span>
          )}
          {spectrum.boundary_config?.kind && (
            <span className="rounded-sm border border-violet-500/25 bg-violet-500/10 px-1.5 py-0.5 text-[0.62rem] font-bold uppercase tracking-widest text-violet-200">
              bc: {spectrum.boundary_config.kind}
            </span>
          )}
          {includedTermsLabel(spectrum.included_terms) && (
            <span className="rounded-sm border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[0.62rem] font-bold tracking-widest text-emerald-200">
              {includedTermsLabel(spectrum.included_terms)}
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            title="Refresh analyze data"
            onClick={() => {
              model.refreshAnalyze();
              refresh();
            }}
            className="flex items-center gap-1 rounded-md border border-transparent px-2 py-1 text-[0.68rem] text-muted-foreground transition-colors hover:border-border/40 hover:bg-muted/60 hover:text-foreground"
          >
            <RefreshCw size={11} />
            Refresh
          </button>
        </div>

        {selectedModeSummary && (
          <div className="mt-2 text-sm text-foreground/90">
            Mode {selectedModeSummary.index} · {fmtGHz(selectedModeSummary.frequency_hz)} ·{" "}
            {selectedModeSummary.dominant_polarization}
          </div>
        )}
        {spectrum.solver_notes && (
          <div className="mt-1 text-xs text-muted-foreground">{spectrum.solver_notes}</div>
        )}
        {compactList(spectrum.solver_capabilities) && (
          <div className="mt-1 text-xs text-emerald-300/90">
            Capabilities: {compactList(spectrum.solver_capabilities)}
          </div>
        )}
        {compactList(spectrum.solver_limitations) && (
          <div className="mt-1 text-xs text-amber-300/90">
            Limitations: {compactList(spectrum.solver_limitations)}
          </div>
        )}
      </div>

      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        <div className="min-w-0 flex-1 overflow-hidden">
          {branches ? (
            <EigenAnalyzeWorkbench
              spectrum={spectrum}
              branches={branches}
              renderModeInspector={(mode) => (
                <EigenModeInspector
                  mesh={mesh}
                  mode={mode}
                  loading={false}
                  compact
                />
              )}
            />
          ) : (
          <Tabs
            value={model.analyzeSelection.tab}
            onValueChange={(value) => model.selectAnalyzeTab(value as "spectrum" | "modes" | "dispersion")}
            className="flex h-full flex-col"
          >
            <div className="shrink-0 border-b border-border/20 px-3 pt-2">
              <TabsList className="h-7 gap-0.5 bg-transparent p-0">
                <TabsTrigger value="spectrum" className="h-7 px-3 text-[0.72rem]">
                  Spectrum
                </TabsTrigger>
                <TabsTrigger value="modes" className="h-7 px-3 text-[0.72rem]">
                  Modes
                </TabsTrigger>
                {dispersionRows.length > 0 && (
                  <TabsTrigger value="dispersion" className="h-7 px-3 text-[0.72rem]">
                    Dispersion
                  </TabsTrigger>
                )}
              </TabsList>
            </div>

            <TabsContent value="spectrum" className="flex-1 min-h-0 p-3">
              <ModeSpectrumPlot
                modes={spectrum.modes}
                selectedMode={selectedMode}
                onSelectMode={(modeIndex) => selectMode(modeIndex)}
              />
            </TabsContent>

            <TabsContent value="modes" className="flex-1 min-h-0 p-0">
              {selectedMode == null ? (
                <div className="flex h-full items-center justify-center">
                  <EmptyState
                    title="No mode selected"
                    description="Choose a mode from the spectrum, dispersion plot, or outputs tree."
                    tone="info"
                    compact
                  />
                </div>
              ) : modeLoadState === "error" ? (
                <div className="flex h-full items-center justify-center">
                  <EmptyState
                    title="Mode unavailable"
                    description={modeError ?? "Mode artifact could not be loaded."}
                    tone="warning"
                    compact
                  />
                </div>
              ) : (
                <EigenModeInspector
                  mesh={mesh}
                  mode={selectedModeArtifact}
                  loading={modeLoadState === "loading"}
                  compact
                />
              )}
            </TabsContent>

            {dispersionRows.length > 0 && (
              <TabsContent value="dispersion" className="flex-1 min-h-0 p-3">
                <DispersionBranchPlot
                  rows={dispersionRows}
                  selectedMode={selectedMode}
                  onSelectMode={(modeIndex) => selectMode(modeIndex)}
                />
              </TabsContent>
            )}
          </Tabs>
          )}
        </div>

        <aside className="hidden w-full max-w-[360px] shrink-0 border-l border-border/25 bg-card/20 p-3 xl:block">
          <AnalyzeDiagnosticsPanel diagnostics={diagnostics} />
        </aside>
      </div>
    </div>
  );
}
