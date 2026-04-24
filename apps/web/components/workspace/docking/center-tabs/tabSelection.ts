"use client";

import type { AnalyzeTab } from "@/components/runs/control-room/analyzeSelection";
import type { WorkspaceMode, WorkspaceTab } from "@/lib/workspace/workspace-store";

export function isAnalyzeTab(value: string | undefined): value is AnalyzeTab {
  return (
    value === "summary" ||
    value === "spectrum" ||
    value === "modes" ||
    value === "dispersion" ||
    value === "time-traces" ||
    value === "vortex-trajectory" ||
    value === "vortex-frequency" ||
    value === "vortex-orbit"
  );
}

export function asAnalyzeTab(value: string | undefined): AnalyzeTab {
  return isAnalyzeTab(value) ? value : "spectrum";
}

export function isAnalyzeLikeTab(tab: WorkspaceTab): boolean {
  if (tab.kind === "analyze") return true;
  if (tab.kind === "result-quantity") return false;
  return tab.kind.startsWith("result-");
}

function analyzeSelectionForTab(tab: WorkspaceTab):
  | { domain: "eigenmodes" | "vortex"; tab: AnalyzeTab; selectedModeIndex?: number | null }
  | null {
  switch (tab.kind) {
    case "analyze":
      return {
        domain: (tab.payload?.analyzeDomain ?? "eigenmodes") as "eigenmodes" | "vortex",
        tab: asAnalyzeTab(tab.payload?.analyzeTab),
      };
    case "result-spectrum":
      return { domain: "eigenmodes", tab: "spectrum", selectedModeIndex: null };
    case "result-dispersion":
      return { domain: "eigenmodes", tab: "dispersion", selectedModeIndex: null };
    case "result-modes":
      return { domain: "eigenmodes", tab: "modes" };
    case "result-time-traces":
      return { domain: "vortex", tab: "time-traces" };
    case "result-vortex-frequency":
      return { domain: "vortex", tab: "vortex-frequency" };
    case "result-vortex-trajectory":
      return { domain: "vortex", tab: "vortex-trajectory" };
    case "result-vortex-orbit":
      return { domain: "vortex", tab: "vortex-orbit" };
    case "result-table":
      return { domain: "eigenmodes", tab: "spectrum" };
    default:
      return null;
  }
}

function sameAnalyzeSelection(
  current: { domain: "eigenmodes" | "vortex"; tab: AnalyzeTab; selectedModeIndex: number | null },
  next: { domain: "eigenmodes" | "vortex"; tab: AnalyzeTab; selectedModeIndex?: number | null },
): boolean {
  return (
    current.domain === next.domain &&
    current.tab === next.tab &&
    (current.selectedModeIndex ?? null) === (next.selectedModeIndex ?? null)
  );
}

export interface WorkspaceTabSelectionApi {
  currentWorkspaceMode: WorkspaceMode;
  setWorkspaceMode: (next: WorkspaceMode | ((prev: WorkspaceMode) => WorkspaceMode)) => void;
  handleViewModeChange: (mode: string) => void;
  effectiveViewMode: "3D" | "2D" | "Mesh" | "Analyze";
  requestPreviewQuantity: (quantity: string) => void;
  selectedQuantity: string;
  activeResultWorkspaceId: string | null;
  analyzeSelection: {
    domain: "eigenmodes" | "vortex";
    tab: AnalyzeTab;
    selectedModeIndex: number | null;
  };
  openResultWorkspaceEntry: (entryId: string) => void;
  openAnalyze: (selection: {
    domain?: "eigenmodes" | "vortex";
    tab?: AnalyzeTab;
    selectedModeIndex?: number | null;
  }) => void;
}

export function applyWorkspaceTabSelection(
  stage: WorkspaceMode,
  tab: WorkspaceTab,
  api: WorkspaceTabSelectionApi,
): void {
  if (tab.payload?.resultWorkspaceId) {
    if (api.currentWorkspaceMode !== "analyze") {
      api.setWorkspaceMode("analyze");
    }
    if (api.activeResultWorkspaceId !== tab.payload.resultWorkspaceId) {
      api.openResultWorkspaceEntry(tab.payload.resultWorkspaceId);
    }
    return;
  }

  if (tab.kind === "viewport-3d") {
    if (api.currentWorkspaceMode !== stage) api.setWorkspaceMode(stage);
    if (api.effectiveViewMode !== "3D") api.handleViewModeChange("3D");
    return;
  }
  if (tab.kind === "viewport-2d") {
    if (api.currentWorkspaceMode !== stage) api.setWorkspaceMode(stage);
    if (api.effectiveViewMode !== "2D") api.handleViewModeChange("2D");
    return;
  }
  if (tab.kind === "viewport-mesh") {
    if (api.currentWorkspaceMode !== stage) api.setWorkspaceMode(stage);
    if (api.effectiveViewMode !== "Mesh") api.handleViewModeChange("Mesh");
    return;
  }
  if (tab.kind === "viewport-charts") {
    if (api.currentWorkspaceMode !== stage) api.setWorkspaceMode(stage);
    return;
  }
  if (tab.kind === "result-quantity") {
    if (api.currentWorkspaceMode !== stage) api.setWorkspaceMode(stage);
    if (tab.payload?.quantityId && tab.payload.quantityId !== api.selectedQuantity) {
      api.requestPreviewQuantity(tab.payload.quantityId);
    }
    if (api.effectiveViewMode !== "3D") api.handleViewModeChange("3D");
    return;
  }

  const analyzeSelection = analyzeSelectionForTab(tab);
  if (analyzeSelection) {
    if (api.currentWorkspaceMode !== "analyze") {
      api.setWorkspaceMode("analyze");
    }
    if (!sameAnalyzeSelection(api.analyzeSelection, analyzeSelection)) {
      api.openAnalyze({
        domain: analyzeSelection.domain,
        tab: analyzeSelection.tab,
        selectedModeIndex: analyzeSelection.selectedModeIndex ?? null,
      });
    }
    return;
  }

  if (api.currentWorkspaceMode !== stage) {
    api.setWorkspaceMode(stage);
  }
}
