import { useEffect, useMemo, useRef } from "react";
import type { ArtifactEntry, RunManifest, SessionManifest } from "@/lib/session/types";
import type { ScalarRow } from "@/lib/session/types";

export function useAutoResultsNavigation({
  artifacts,
  openAnalyzeCenterTab,
  run,
  scalarRows,
  selectedSidebarNodeId,
  session,
  setSelectedSidebarNodeId,
  workspaceStatus,
}: {
  artifacts: ArtifactEntry[];
  openAnalyzeCenterTab: (
    selection?: { tab?: "spectrum"; selectedModeIndex?: number | null },
    debug?: { source?: string },
  ) => void;
  run: RunManifest | null;
  scalarRows: ScalarRow[];
  selectedSidebarNodeId: string | null;
  session: SessionManifest | null;
  setSelectedSidebarNodeId: (nodeId: string) => void;
  workspaceStatus: string;
}) {
  const hasEigenArtifacts = useMemo(
    () =>
      artifacts.some(
        (artifact) =>
          artifact.path === "eigen/spectrum.json" ||
          artifact.path === "eigen/metadata/eigen_summary.json" ||
          artifact.path.startsWith("eigen/modes/"),
      ),
    [artifacts],
  );
  const hasResultsAvailable = useMemo(() => {
    const hasScalarRows = scalarRows.length > 0;
    const hasRuntimeSteps = (run?.total_steps ?? 0) > 0;
    return hasScalarRows || hasRuntimeSteps || hasEigenArtifacts;
  }, [run?.total_steps, scalarRows.length, hasEigenArtifacts]);
  const autoResultsEntryKeyRef = useRef<string | null>(null);
  const currentResultsEntryKey = `${session?.session_id ?? "none"}:${run?.run_id ?? session?.run_id ?? "none"}`;

  useEffect(() => {
    const solveFinished =
      workspaceStatus === "awaiting_command" || workspaceStatus === "completed";
    if (!solveFinished || !hasResultsAvailable) {
      return;
    }
    if (autoResultsEntryKeyRef.current === currentResultsEntryKey) {
      return;
    }
    autoResultsEntryKeyRef.current = currentResultsEntryKey;
    if (!selectedSidebarNodeId || !selectedSidebarNodeId.startsWith("res-")) {
      setSelectedSidebarNodeId(hasEigenArtifacts ? "res-eigenmodes" : "results");
    }
    openAnalyzeCenterTab(
      hasEigenArtifacts ? { tab: "spectrum", selectedModeIndex: null } : undefined,
      { source: "auto_results" },
    );
  }, [
    currentResultsEntryKey,
    hasEigenArtifacts,
    hasResultsAvailable,
    openAnalyzeCenterTab,
    selectedSidebarNodeId,
    setSelectedSidebarNodeId,
    workspaceStatus,
  ]);
}
