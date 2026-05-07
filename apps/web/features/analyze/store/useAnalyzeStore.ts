/**
 * Analyze feature – Zustand store.
 *
 * Owns the analyze selection state and query cache.
 * Consumers read selection via selectors; mutations go through actions.
 */
import { create } from "zustand";
import type { SetStateAction } from "react";
import type {
  AnalyzeSelectionState,
  AnalyzeTab,
  AnalyzeDomain,
  AnalyzeQueryState,
  AnalyzeQueryKey,
  CreateResultWorkspaceEntryInput,
  ResultWorkspaceEntry,
  ResultWorkspaceKind,
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
  resultWorkspaceEntries: ResultWorkspaceEntry[];
  activeResultWorkspaceId: string | null;

  /* ── Actions ── */
  setDomain: (domain: AnalyzeDomain) => void;
  selectTab: (tab: AnalyzeTab) => void;
  selectMode: (index: number | null) => void;
  selectSample: (index: number | null) => void;
  selectBranch: (branchId: number | null) => void;
  selectChannel: (channel: string | null) => void;
  refresh: () => void;
  resetSelection: () => void;
  setSelection: (selection: SetStateAction<AnalyzeSelectionState>) => void;

  /** Update a query cache entry (used by the fetch layer). */
  setQuery: (key: AnalyzeQueryKey, state: Partial<AnalyzeQueryState>) => void;
  /** Invalidate all cached queries. */
  invalidateAll: () => void;
  /** Replace the results workspace state (used by the results panel). */
  setResultsWorkspace: (workspace: ResultsWorkspaceState) => void;
  setResultWorkspaceEntries: (entries: SetStateAction<ResultWorkspaceEntry[]>) => void;
  setActiveResultWorkspaceId: (id: SetStateAction<string | null>) => void;
  addResultWorkspaceEntry: (entry: CreateResultWorkspaceEntryInput) => string;
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

function resolveSetStateAction<T>(value: SetStateAction<T>, previous: T): T {
  return typeof value === "function"
    ? (value as (prev: T) => T)(previous)
    : value;
}

function queryKeyString(key: AnalyzeQueryKey): string {
  return JSON.stringify(key);
}

function resultWorkspaceIcon(kind: ResultWorkspaceKind): string {
  switch (kind) {
    case "spectrum":
      return "📊";
    case "dispersion":
      return "≈";
    case "modes":
      return "〜";
    case "time-traces":
      return "〰";
    case "vortex-frequency":
      return "🌀";
    case "vortex-trajectory":
      return "◎";
    case "vortex-orbit":
      return "◉";
    case "table":
      return "📋";
    case "quantity":
    default:
      return "𝑓";
  }
}

export const useAnalyzeStore = create<AnalyzeStoreState>((set) => ({
  selection: { ...DEFAULT_SELECTION },
  queries: {},
  resultsWorkspace: { ...EMPTY_RESULTS_WORKSPACE },
  resultWorkspaceEntries: [],
  activeResultWorkspaceId: null,

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

  setSelection: (selection) =>
    set((s) => ({ selection: resolveSetStateAction(selection, s.selection) })),

  setQuery: (key, state) =>
    set((s) => {
      const k = queryKeyString(key);
      const prev = s.queries[k] ?? { status: "idle", data: null, error: null, requestedAt: null, completedAt: null };
      return { queries: { ...s.queries, [k]: { ...prev, ...state } } };
    }),

  invalidateAll: () => set({ queries: {} }),

  setResultsWorkspace: (resultsWorkspace) => set({ resultsWorkspace }),

  setResultWorkspaceEntries: (entries) =>
    set((s) => ({
      resultWorkspaceEntries: resolveSetStateAction(entries, s.resultWorkspaceEntries),
    })),

  setActiveResultWorkspaceId: (id) =>
    set((s) => ({
      activeResultWorkspaceId: resolveSetStateAction(id, s.activeResultWorkspaceId),
    })),

  addResultWorkspaceEntry: (entry) => {
    let resolvedId = "";
    set((s) => {
      const key = entry.key?.trim().length ? entry.key.trim() : `${entry.kind}:${entry.label}`;
      const existing = s.resultWorkspaceEntries.find((candidate) => candidate.key === key);
      if (existing) {
        resolvedId = existing.id;
        return entry.openAfterCreate
          ? { activeResultWorkspaceId: existing.id }
          : {};
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
      resolvedId = created.id;
      return {
        resultWorkspaceEntries: [...s.resultWorkspaceEntries, created],
        activeResultWorkspaceId: entry.openAfterCreate ? created.id : s.activeResultWorkspaceId,
      };
    });
    return resolvedId;
  },
}));

export const selectAnalyzeSelection = (s: AnalyzeStoreState) => s.selection;
export const selectAnalyzeResultWorkspaceEntries = (s: AnalyzeStoreState) =>
  s.resultWorkspaceEntries;
export const selectActiveAnalyzeResultWorkspaceId = (s: AnalyzeStoreState) =>
  s.activeResultWorkspaceId;
