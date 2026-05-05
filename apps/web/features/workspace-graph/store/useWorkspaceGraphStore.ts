import { create } from "zustand";
import type {
  WorkspaceGraphPatch,
  WorkspaceGraphSelectionState,
  WorkspaceGraphState,
  ViewportDocumentState,
} from "../model/types";

const EMPTY_SELECTION: WorkspaceGraphSelectionState = {
  activeNodeId: null,
  activeResultNodeId: null,
  activeViewportDocumentId: null,
};

export const EMPTY_WORKSPACE_GRAPH: WorkspaceGraphState = {
  version: "workspace_graph.v2",
  project: { id: "project:active", label: "Fullmag Workspace" },
  studyPipeline: null,
  studyNodes: [],
  solutions: [],
  datasets: [],
  derivedValues: [],
  resultsWorkspace: {
    datasets: [],
    solutions: [],
    derivedValues: [],
    plotGroups: [],
    tables: [],
    analyses: [],
    exports: [],
    reports: [],
    activeResultNodeId: null,
  },
  quantityFrames: [],
  viewportDocuments: {},
  workspaceTabs: {
    build: [],
    study: [],
    analyze: [],
  },
  activeWorkspaceTabByStage: {
    build: null,
    study: null,
    analyze: null,
  },
  selection: EMPTY_SELECTION,
  scalarRows: [],
  updatedAt: null,
};

interface WorkspaceGraphStoreState {
  snapshot: WorkspaceGraphState;
  lastSnapshotSignature: string | null;
  applySnapshot: (snapshot: WorkspaceGraphState, signature?: string | null) => void;
  applyPatch: (patch: WorkspaceGraphPatch) => void;
  upsertViewportDocument: (document: ViewportDocumentState) => void;
  setSelection: (selection: Partial<WorkspaceGraphSelectionState>) => void;
  reset: () => void;
}

function viewportDocumentStatesEqual(
  a: ViewportDocumentState | null | undefined,
  b: ViewportDocumentState | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.workspaceMode === b.workspaceMode &&
    a.tabId === b.tabId &&
    a.viewMode === b.viewMode &&
    a.quantityId === b.quantityId &&
    a.component === b.component &&
    a.plane === b.plane &&
    a.sliceIndex === b.sliceIndex &&
    a.selectedDatasetId === b.selectedDatasetId &&
    a.selectedResultNodeId === b.selectedResultNodeId &&
    a.renderMode === b.renderMode &&
    cameraStatesEqual(a.camera, b.camera) &&
    a.overlayToggles.telemetryHudVisible === b.overlayToggles.telemetryHudVisible &&
    a.overlayToggles.previewNoticesVisible === b.overlayToggles.previewNoticesVisible
  );
}

function cameraStatesEqual(
  a: ViewportDocumentState["camera"],
  b: ViewportDocumentState["camera"],
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    tupleEqual(a.position, b.position) &&
    tupleEqual(a.target, b.target) &&
    tupleEqual(a.up, b.up) &&
    a.projection === b.projection &&
    a.navigation === b.navigation &&
    a.lastFocusedObjectId === b.lastFocusedObjectId
  );
}

function tupleEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function primitiveArraysEqual(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function shallowRecordsArrayEqual<T extends object>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]! as Record<string, unknown>;
    const right = b[index]! as Record<string, unknown>;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) {
      return false;
    }
    for (const key of leftKeys) {
      const leftValue = left[key];
      const rightValue = right[key];
      if (Array.isArray(leftValue) && Array.isArray(rightValue)) {
        if (!primitiveArraysEqual(leftValue, rightValue)) {
          return false;
        }
        continue;
      }
      if (leftValue !== rightValue) {
        return false;
      }
    }
  }
  return true;
}

export const useWorkspaceGraphStore = create<WorkspaceGraphStoreState>((set) => ({
  snapshot: EMPTY_WORKSPACE_GRAPH,
  lastSnapshotSignature: null,
  applySnapshot: (snapshot, signature = null) =>
    set((state) => {
      if (signature && state.lastSnapshotSignature === signature) {
        return state;
      }
      if (Object.is(state.snapshot, snapshot)) {
        return state;
      }
      // P-26: Per-field structural sharing — preserve sub-object references
      // when values haven't changed between snapshots. During solver relaxation,
      // only `solutions`, `datasets`, `derivedValues`, and `updatedAt`
      // typically change. Everything else (selection,
      // viewportDocuments, resultsWorkspace, etc.) stays structurally
      // identical. By preserving their references, downstream Zustand selectors
      // and React useMemo/useEffect dependencies remain stable.
      const prev = state.snapshot;
      const shared: WorkspaceGraphState = { ...snapshot };
      // Fields that are often pass-through references from input
      const IDENTITY_KEYS = [
        "version", "project", "studyPipeline", "resultsWorkspace",
        "workspaceTabs", "activeWorkspaceTabByStage", "scalarRows",
      ] as const;
      for (const key of IDENTITY_KEYS) {
        if (Object.is(prev[key], snapshot[key])) {
          (shared as unknown as Record<string, unknown>)[key] = prev[key];
        }
      }
      // Selection: shallow compare 3 primitive fields
      if (
        prev.selection.activeNodeId === snapshot.selection.activeNodeId &&
        prev.selection.activeResultNodeId === snapshot.selection.activeResultNodeId &&
        prev.selection.activeViewportDocumentId === snapshot.selection.activeViewportDocumentId
      ) {
        shared.selection = prev.selection;
      }
      // ViewportDocuments: compare each entry structurally
      const prevDocs = prev.viewportDocuments;
      const nextDocs = snapshot.viewportDocuments;
      const prevKeys = Object.keys(prevDocs);
      const nextKeys = Object.keys(nextDocs);
      if (prevKeys.length === nextKeys.length) {
        let allDocsEqual = true;
        const mergedDocs: Record<string, ViewportDocumentState> = {};
        for (const key of nextKeys) {
          if (viewportDocumentStatesEqual(prevDocs[key], nextDocs[key])) {
            mergedDocs[key] = prevDocs[key]!;
          } else {
            mergedDocs[key] = nextDocs[key];
            allDocsEqual = false;
          }
        }
        shared.viewportDocuments = allDocsEqual ? prevDocs : mergedDocs;
      }
      // Arrays with computed view-model records: compare shallow primitive fields
      // and primitive child arrays without serializing the hot snapshot path.
      if (shallowRecordsArrayEqual(prev.studyNodes, snapshot.studyNodes)) {
        shared.studyNodes = prev.studyNodes;
      }
      if (shallowRecordsArrayEqual(prev.solutions, snapshot.solutions)) {
        shared.solutions = prev.solutions;
      }
      if (shallowRecordsArrayEqual(prev.datasets, snapshot.datasets)) {
        shared.datasets = prev.datasets;
      }
      if (shallowRecordsArrayEqual(prev.derivedValues, snapshot.derivedValues)) {
        shared.derivedValues = prev.derivedValues;
      }
      if (shallowRecordsArrayEqual(prev.quantityFrames, snapshot.quantityFrames)) {
        shared.quantityFrames = prev.quantityFrames;
      }
      return { snapshot: shared, lastSnapshotSignature: signature };
    }),
  applyPatch: (patch) =>
    set((state) => ({
      snapshot: {
        ...state.snapshot,
        ...patch,
        viewportDocuments: {
          ...state.snapshot.viewportDocuments,
          ...patch.viewportDocuments,
        },
        selection: {
          ...state.snapshot.selection,
          ...patch.selection,
        },
        updatedAt: patch.updatedAt ?? Date.now(),
      },
      lastSnapshotSignature: null,
    })),
  upsertViewportDocument: (document) =>
    set((state) => {
      if (viewportDocumentStatesEqual(state.snapshot.viewportDocuments[document.id], document)) {
        return state;
      }
      return {
        snapshot: {
          ...state.snapshot,
          viewportDocuments: {
            ...state.snapshot.viewportDocuments,
            [document.id]: document,
          },
          updatedAt: Date.now(),
        },
        lastSnapshotSignature: null,
      };
    }),
  setSelection: (selection) =>
    set((state) => ({
      snapshot: {
        ...state.snapshot,
        selection: {
          ...state.snapshot.selection,
          ...selection,
        },
        updatedAt: Date.now(),
      },
      lastSnapshotSignature: null,
    })),
  reset: () => set({ snapshot: EMPTY_WORKSPACE_GRAPH, lastSnapshotSignature: null }),
}));

export const selectWorkspaceGraph = (state: WorkspaceGraphStoreState) => state.snapshot;
export const selectGraphResultsWorkspace = (state: WorkspaceGraphStoreState) => state.snapshot.resultsWorkspace;
export const selectGraphViewportDocuments = (state: WorkspaceGraphStoreState) => state.snapshot.viewportDocuments;
export const selectGraphActiveViewportDocument = (state: WorkspaceGraphStoreState) => {
  const docId = state.snapshot.selection.activeViewportDocumentId;
  return docId ? state.snapshot.viewportDocuments[docId] ?? null : null;
};
