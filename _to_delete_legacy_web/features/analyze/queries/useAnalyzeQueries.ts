/**
 * Analyze feature – query hooks.
 *
 * React hooks that compose the analyze store selection with the API layer.
 * Each hook uses the current selection to build a query key and triggers
 * artifact fetching with proper cleanup on unmount.
 */
import { useEffect, useMemo } from "react";
import { useAnalyzeStore } from "../store/useAnalyzeStore";
import type { AnalyzeQueryKey, AnalyzeQueryState } from "../model/analyzeTypes";

function queryKeyString(key: AnalyzeQueryKey): string {
  return JSON.stringify(key);
}

/**
 * Read a cached query result from the store.
 */
export function useAnalyzeQuery<T = unknown>(
  key: AnalyzeQueryKey | null,
): AnalyzeQueryState<T> {
  const queries = useAnalyzeStore((s) => s.queries);
  if (!key) {
    return { status: "idle", data: null, error: null, requestedAt: null, completedAt: null };
  }
  const cached = queries[queryKeyString(key)];
  return (cached as AnalyzeQueryState<T> | undefined) ?? {
    status: "idle",
    data: null,
    error: null,
    requestedAt: null,
    completedAt: null,
  };
}

/**
 * Derive a query key from the current analyze selection.
 */
export function useAnalyzeQueryKey(): AnalyzeQueryKey | null {
  const selection = useAnalyzeStore((s) => s.selection);

  return useMemo(() => {
    const fp = [
      selection.selectedModeIndex,
      selection.sampleIndex,
      selection.branchId,
      selection.selectedChannel,
    ].join("|");

    return {
      domain: selection.domain,
      tab: selection.tab,
      selectionFingerprint: fp,
      refreshNonce: selection.refreshNonce,
    };
  }, [
    selection.domain,
    selection.tab,
    selection.selectedModeIndex,
    selection.sampleIndex,
    selection.branchId,
    selection.selectedChannel,
    selection.refreshNonce,
  ]);
}

/**
 * Convenience: read the current analyze selection without subscribing to queries.
 */
export function useAnalyzeSelection() {
  return useAnalyzeStore((s) => s.selection);
}
