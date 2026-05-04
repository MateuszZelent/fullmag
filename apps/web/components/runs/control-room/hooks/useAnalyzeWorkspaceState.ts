import { startTransition, useCallback, useState } from "react";
import {
  DEFAULT_ANALYZE_SELECTION,
  nextAnalyzeRefresh,
  type AnalyzeSelectionState,
  type AnalyzeTab,
} from "../analyzeSelection";
import { resultWorkspaceIcon } from "../controlRoomUtils";
import type {
  ResultWorkspaceEntry,
  ResultWorkspaceKind,
} from "../context-hooks";

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
  const [analyzeSelection, setAnalyzeSelection] =
    useState<AnalyzeSelectionState>(DEFAULT_ANALYZE_SELECTION);
  const [resultWorkspaceEntries, setResultWorkspaceEntries] = useState<ResultWorkspaceEntry[]>([]);
  const [activeResultWorkspaceId, setActiveResultWorkspaceId] = useState<string | null>(null);

  const openAnalyze = useCallback((next?: Partial<AnalyzeSelectionState>) => {
    startTransition(options.activateAnalyzeView);
    setAnalyzeSelection((prev) => {
      const resolved = next ? { ...prev, ...next } : prev;
      return analyzeSelectionEquals(prev, resolved) ? prev : resolved;
    });
  }, [options.activateAnalyzeView]);

  const selectAnalyzeTab = useCallback((tab: AnalyzeTab) => {
    setAnalyzeSelection((prev) => {
      if (prev.tab === tab) {
        return prev;
      }
      return { ...prev, tab };
    });
  }, []);

  const selectAnalyzeMode = useCallback((index: number | null) => {
    setAnalyzeSelection((prev) => {
      if (prev.tab === "modes" && prev.selectedModeIndex === index) {
        return prev;
      }
      return { ...prev, tab: "modes", selectedModeIndex: index };
    });
  }, []);

  const refreshAnalyze = useCallback(() => {
    setAnalyzeSelection((prev) => nextAnalyzeRefresh(prev));
  }, []);

  const addResultWorkspaceEntry = useCallback(
    (entry: {
      key?: string | null;
      kind: ResultWorkspaceKind;
      label: string;
      quantityId?: string | null;
      icon?: string;
      badge?: string | null;
      pinned?: boolean;
      openAfterCreate?: boolean;
    }) => {
      const key = entry.key?.trim().length ? entry.key.trim() : `${entry.kind}:${entry.label}`;
      const existing = resultWorkspaceEntries.find((candidate) => candidate.key === key);
      if (existing) {
        if (entry.openAfterCreate) {
          setActiveResultWorkspaceId(existing.id);
        }
        return existing.id;
      }
      const now = Date.now();
      const created: ResultWorkspaceEntry = {
        id: `${entry.kind}-${now}-${Math.floor(Math.random() * 10000)}`,
        key,
        kind: entry.kind,
        label: entry.label,
        quantityId: entry.quantityId ?? null,
        icon: entry.icon ?? resultWorkspaceIcon(entry.kind),
        badge: entry.badge ?? null,
        pinned: entry.pinned ?? !key.startsWith("auto:"),
        createdAtUnixMs: now,
      };
      setResultWorkspaceEntries((prev) => [...prev, created]);
      if (entry.openAfterCreate) {
        setActiveResultWorkspaceId(created.id);
      }
      return created.id;
    },
    [resultWorkspaceEntries],
  );

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
