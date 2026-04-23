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
      return { snapshot, lastSnapshotSignature: signature };
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
    set((state) => ({
      snapshot: {
        ...state.snapshot,
        viewportDocuments: {
          ...state.snapshot.viewportDocuments,
          [document.id]: document,
        },
        updatedAt: Date.now(),
      },
      lastSnapshotSignature: null,
    })),
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
