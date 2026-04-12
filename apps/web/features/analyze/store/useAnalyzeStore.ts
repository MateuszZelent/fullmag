/**
 * Analyze feature – Zustand store.
 *
 * Owns the analyze selection state and query cache.
 * Consumers read selection via selectors; mutations go through actions.
 */
import { create } from "zustand";
import type {
  AnalyzeSelectionState,
  AnalyzeTab,
  AnalyzeDomain,
  AnalyzeQueryState,
  AnalyzeQueryKey,
} from "../model/analyzeTypes";
import type { ResultsWorkspaceState } from "../model/resultsWorkspace";
import { EMPTY_RESULTS_WORKSPACE } from "../model/resultsWorkspace";

export interface AnalyzeStoreState {
  /* ── Selection ── */
  selection: AnalyzeSelectionState;

  /* ── Query cache (keyed by JSON of AnalyzeQueryKey) ── */
  queries: Record<string, AnalyzeQueryState>;

  /* ── Results workspace ── */
  resultsWorkspace: ResultsWorkspaceState;

  /* ── Actions ── */
  setDomain: (domain: AnalyzeDomain) => void;
  selectTab: (tab: AnalyzeTab) => void;
  selectMode: (index: number | null) => void;
  selectSample: (index: number | null) => void;
  selectBranch: (branchId: number | null) => void;
  selectChannel: (channel: string | null) => void;
  refresh: () => void;
  resetSelection: () => void;

  /** Update a query cache entry (used by the fetch layer). */
  setQuery: (key: AnalyzeQueryKey, state: Partial<AnalyzeQueryState>) => void;
  /** Invalidate all cached queries. */
  invalidateAll: () => void;
  /** Replace the results workspace state (used by the results panel). */
  setResultsWorkspace: (workspace: ResultsWorkspaceState) => void;
}

const DEFAULT_SELECTION: AnalyzeSelectionState = {
  domain: "eigenmodes",
  tab: "spectrum",
  selectedModeIndex: null,
  sampleIndex: null,
  branchId: null,
  selectedChannel: null,
  refreshNonce: 0,
};

function queryKeyString(key: AnalyzeQueryKey): string {
  return JSON.stringify(key);
}

export const useAnalyzeStore = create<AnalyzeStoreState>((set) => ({
  selection: { ...DEFAULT_SELECTION },
  queries: {},
  resultsWorkspace: { ...EMPTY_RESULTS_WORKSPACE },

  setDomain: (domain) =>
    set((s) => ({
      selection: { ...s.selection, domain, tab: domain === "vortex" ? "time-traces" : "spectrum" },
    })),

  selectTab: (tab) =>
    set((s) => ({ selection: { ...s.selection, tab } })),

  selectMode: (index) =>
    set((s) => ({ selection: { ...s.selection, selectedModeIndex: index } })),

  selectSample: (index) =>
    set((s) => ({ selection: { ...s.selection, sampleIndex: index } })),

  selectBranch: (branchId) =>
    set((s) => ({ selection: { ...s.selection, branchId } })),

  selectChannel: (channel) =>
    set((s) => ({ selection: { ...s.selection, selectedChannel: channel } })),

  refresh: () =>
    set((s) => ({
      selection: { ...s.selection, refreshNonce: s.selection.refreshNonce + 1 },
    })),

  resetSelection: () =>
    set({ selection: { ...DEFAULT_SELECTION } }),

  setQuery: (key, state) =>
    set((s) => {
      const k = queryKeyString(key);
      const prev = s.queries[k] ?? { status: "idle", data: null, error: null, requestedAt: null, completedAt: null };
      return { queries: { ...s.queries, [k]: { ...prev, ...state } } };
    }),

  invalidateAll: () => set({ queries: {} }),

  setResultsWorkspace: (resultsWorkspace) => set({ resultsWorkspace }),
}));
