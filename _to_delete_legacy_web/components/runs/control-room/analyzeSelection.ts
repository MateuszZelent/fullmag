"use client";

export type AnalyzeTab =
  | "summary"
  | "spectrum"
  | "modes"
  | "dispersion"
  | "time-traces"
  | "vortex-trajectory"
  | "vortex-frequency"
  | "vortex-orbit";

/** Top-level analysis domain — drives which workbench is shown. */
export type AnalyzeDomain = "eigenmodes" | "vortex";

export interface AnalyzeSelectionState {
  /** Active analysis domain. */
  domain: AnalyzeDomain;
  tab: AnalyzeTab;
  selectedModeIndex: number | null;
  /** k-sample index for multi-k (path) solves. Null means legacy single-sample. */
  sampleIndex: number | null;
  /** Tracked branch id. Null means no branch selected. */
  branchId: number | null;
  /** Selected time-trace channel (e.g. "mx", "my", "mz"). */
  selectedChannel: string | null;
  refreshNonce: number;
}

export const DEFAULT_ANALYZE_SELECTION: AnalyzeSelectionState = {
  domain: "eigenmodes",
  tab: "spectrum",
  selectedModeIndex: null,
  sampleIndex: null,
  branchId: null,
  selectedChannel: null,
  refreshNonce: 0,
};

export function nextAnalyzeRefresh(
  current: AnalyzeSelectionState,
): AnalyzeSelectionState {
  return {
    ...current,
    refreshNonce: current.refreshNonce + 1,
  };
}

export function parseAnalyzeTreeNode(
  nodeId: string,
): Partial<AnalyzeSelectionState> | null {
  // ── Eigenmodes domain ──
  if (nodeId === "res-eigenmodes-summary") {
    return { domain: "eigenmodes", tab: "summary", selectedModeIndex: null };
  }
  if (nodeId === "res-eigenmodes" || nodeId === "res-eigenmodes-spectrum") {
    return { domain: "eigenmodes", tab: "spectrum", selectedModeIndex: null };
  }
  if (nodeId === "res-eigenmodes-dispersion") {
    return { domain: "eigenmodes", tab: "dispersion", selectedModeIndex: null };
  }
  if (nodeId.startsWith("res-eigenmode-")) {
    const index = Number(nodeId.replace("res-eigenmode-", ""));
    if (Number.isFinite(index)) {
      return { domain: "eigenmodes", tab: "modes", selectedModeIndex: index };
    }
  }

  // ── Vortex domain ──
  if (nodeId === "res-vortex") {
    return { domain: "vortex", tab: "vortex-trajectory" };
  }
  if (nodeId === "res-vortex-trajectory") {
    return { domain: "vortex", tab: "vortex-trajectory" };
  }
  if (nodeId === "res-vortex-frequency") {
    return { domain: "vortex", tab: "vortex-frequency" };
  }
  if (nodeId === "res-vortex-orbit") {
    return { domain: "vortex", tab: "vortex-orbit" };
  }
  if (nodeId === "res-time-traces") {
    return { domain: "vortex", tab: "time-traces" };
  }
  if (nodeId.startsWith("res-time-trace-")) {
    const channel = nodeId.replace("res-time-trace-", "");
    return { domain: "vortex", tab: "time-traces", selectedChannel: channel };
  }

  return null;
}
