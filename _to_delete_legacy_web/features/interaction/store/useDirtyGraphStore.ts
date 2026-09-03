/**
 * Interaction — DirtyGraph integration hook
 *
 * Provides a Zustand-compatible hook that maintains the DirtyGraph
 * and derives the RunGate state. Components can subscribe to narrow
 * selectors for efficient re-renders.
 */

"use client";

import { create } from "zustand";
import type { DirtyGraphState, DirtyGraphAction } from "../model/dirtyGraph";
import { INITIAL_DIRTY_GRAPH, dirtyGraphReducer } from "../model/dirtyGraph";
import type { RunGateState } from "../model/runGate";
import { deriveRunGate, EMPTY_RUN_GATE } from "../model/runGate";
import { traceInteraction } from "../trace/interactionTrace";

// ── Store state ───────────────────────────────────────────────

export interface DirtyGraphStoreState {
  dirtyGraph: DirtyGraphState;
  runGate: RunGateState;

  /** Dispatch a dirty-graph action and re-derive runGate. */
  dispatch: (action: DirtyGraphAction) => void;

  /** Reset to initial state. */
  reset: () => void;
}

// ── Store ─────────────────────────────────────────────────────

export const useDirtyGraphStore = create<DirtyGraphStoreState>((set) => ({
  dirtyGraph: INITIAL_DIRTY_GRAPH,
  runGate: EMPTY_RUN_GATE,

  dispatch: (action) => {
    traceInteraction("dirty.dispatch" as never, { action: action.type });
    set((state) => {
      const next = dirtyGraphReducer(state.dirtyGraph, action);
      return {
        dirtyGraph: next,
        runGate: deriveRunGate(next),
      };
    });
  },

  reset: () =>
    set({
      dirtyGraph: INITIAL_DIRTY_GRAPH,
      runGate: deriveRunGate(INITIAL_DIRTY_GRAPH),
    }),
}));

// ── Convenience selectors ─────────────────────────────────────

export const selectCanRun = (s: DirtyGraphStoreState): boolean => s.runGate.canRun;
export const selectCanRelax = (s: DirtyGraphStoreState): boolean => s.runGate.canRelax;
export const selectBlockers = (s: DirtyGraphStoreState) => s.runGate.blockers;
export const selectMeshStatus = (s: DirtyGraphStoreState) => s.dirtyGraph.mesh.status;
export const selectInitialStateStatus = (s: DirtyGraphStoreState) => s.dirtyGraph.initialState.status;
