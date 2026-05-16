import { startTransition, useCallback } from "react";
import {
  nextAnalyzeRefresh,
  type AnalyzeSelectionState,
  type AnalyzeTab,
} from "../analyzeSelection";
import {
  selectActiveAnalyzeResultWorkspaceId,
  selectAnalyzeResultWorkspaceEntries,
  selectAnalyzeSelection,
  useAnalyzeStore,
} from "@/features/analyze/store/useAnalyzeStore";

function analyzeSelectionEquals(
  a: AnalyzeSelectionState,
  b: AnalyzeSelectionState,
): boolean {
  return (
    a.domain === b.domain &&
    a.tab === b.tab &&
    a.selectedModeIndex === b.selectedModeIndex &&
    a.sampleIndex === b.sampleIndex &&
    a.branchId === b.branchId &&
    a.selectedChannel === b.selectedChannel &&
    a.refreshNonce === b.refreshNonce
  );
}

export function useAnalyzeWorkspaceState(options: {
  activateAnalyzeView: () => void;
}) {
  const analyzeSelection = useAnalyzeStore(selectAnalyzeSelection);
  const setAnalyzeSelection = useAnalyzeStore((s) => s.setSelection);
  const resultWorkspaceEntries = useAnalyzeStore(selectAnalyzeResultWorkspaceEntries);
  const activeResultWorkspaceId = useAnalyzeStore(selectActiveAnalyzeResultWorkspaceId);
  const setResultWorkspaceEntries = useAnalyzeStore((s) => s.setResultWorkspaceEntries);
  const setActiveResultWorkspaceId = useAnalyzeStore((s) => s.setActiveResultWorkspaceId);
  const addResultWorkspaceEntry = useAnalyzeStore((s) => s.addResultWorkspaceEntry);

  const openAnalyze = useCallback((next?: Partial<AnalyzeSelectionState>) => {
    startTransition(options.activateAnalyzeView);
    setAnalyzeSelection((prev) => {
      const resolved = next ? { ...prev, ...next } : prev;
      return analyzeSelectionEquals(prev, resolved) ? prev : resolved;
    });
  }, [options.activateAnalyzeView, setAnalyzeSelection]);

  const selectAnalyzeTab = useCallback((tab: AnalyzeTab) => {
    setAnalyzeSelection((prev) => {
      if (prev.tab === tab) {
        return prev;
      }
      return { ...prev, tab };
    });
  }, [setAnalyzeSelection]);

  const selectAnalyzeMode = useCallback((index: number | null) => {
    setAnalyzeSelection((prev) => {
      if (prev.tab === "modes" && prev.selectedModeIndex === index) {
        return prev;
      }
      return { ...prev, tab: "modes", selectedModeIndex: index };
    });
  }, [setAnalyzeSelection]);

  const refreshAnalyze = useCallback(() => {
    setAnalyzeSelection((prev) => nextAnalyzeRefresh(prev));
  }, [setAnalyzeSelection]);

  return {
    activeResultWorkspaceId,
    addResultWorkspaceEntry,
    analyzeSelection,
    openAnalyze,
    refreshAnalyze,
    resultWorkspaceEntries,
    selectAnalyzeMode,
    selectAnalyzeTab,
    setActiveResultWorkspaceId,
    setAnalyzeSelection,
    setResultWorkspaceEntries,
  };
}
