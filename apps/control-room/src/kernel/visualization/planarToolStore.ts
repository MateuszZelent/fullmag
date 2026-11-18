"use client";

import { useSyncExternalStore } from "react";

/** Canvas tool of the 2D view; exactly one is active (spec 15, plan §2.2). */
export type PlanarToolId = "navigate" | "zoom-box" | "crop" | "inspect" | "profile" | "measure";

export const PLANAR_TOOL_IDS: readonly PlanarToolId[] = [
  "navigate",
  "zoom-box",
  "crop",
  "inspect",
  "profile",
  "measure",
];

/** Axis-aligned rectangle in frame coordinates (metres). */
export interface PlanarUvRect {
  u_min_m: number;
  u_max_m: number;
  v_min_m: number;
  v_max_m: number;
}

/** Segment in frame coordinates (metres). */
export interface PlanarUvSegment {
  u0_m: number;
  v0_m: number;
  u1_m: number;
  v1_m: number;
}

export interface PlanarCursorUv {
  u_m: number;
  v_m: number;
}

/**
 * Ephemeral client state of the 2D canvas tools. It is never persisted and
 * never sent to the server: the session-owned view lives in
 * `visualization/state.planar`, this store only carries what the pointer and
 * the active tool are doing right now.
 */
export interface PlanarToolState {
  activeTool: PlanarToolId;
  /** Crop rectangle being drawn, before it is committed. */
  cropDraft: PlanarUvRect | null;
  measure: PlanarUvSegment | null;
  cursorUv: PlanarCursorUv | null;
}

type Listener = () => void;

const INITIAL_STATE: PlanarToolState = Object.freeze({
  activeTool: "navigate",
  cropDraft: null,
  cursorUv: null,
  measure: null,
});

let state: PlanarToolState = INITIAL_STATE;
const listeners = new Set<Listener>();

function publish(next: PlanarToolState): void {
  if (
    next.activeTool === state.activeTool &&
    next.cropDraft === state.cropDraft &&
    next.measure === state.measure &&
    next.cursorUv === state.cursorUv
  ) {
    return;
  }
  state = next;
  for (const listener of listeners) listener();
}

function sameCursor(left: PlanarCursorUv | null, right: PlanarCursorUv | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.u_m === right.u_m && left.v_m === right.v_m;
}

export const planarToolStore = {
  getSnapshot: (): PlanarToolState => state,
  /** First render on the server and during hydration: the navigate tool, no cursor. */
  getServerSnapshot: (): PlanarToolState => INITIAL_STATE,
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  /** Switching tools always discards an uncommitted crop rectangle. */
  setActiveTool: (tool: PlanarToolId): void => {
    if (tool === state.activeTool && state.cropDraft === null) return;
    publish({ ...state, activeTool: tool, cropDraft: null });
  },
  setCropDraft: (rect: PlanarUvRect | null): void => {
    publish({ ...state, cropDraft: rect });
  },
  setMeasure: (segment: PlanarUvSegment | null): void => {
    publish({ ...state, measure: segment });
  },
  setCursorUv: (uv: PlanarCursorUv | null): void => {
    if (sameCursor(uv, state.cursorUv)) return;
    publish({ ...state, cursorUv: uv });
  },
  /** Closing or switching away from the 2D view returns to navigate. */
  reset: (): void => {
    publish(INITIAL_STATE);
  },
};

export function usePlanarToolState(): PlanarToolState {
  return useSyncExternalStore(
    planarToolStore.subscribe,
    planarToolStore.getSnapshot,
    planarToolStore.getServerSnapshot,
  );
}

const activeToolSnapshot = () => planarToolStore.getSnapshot().activeTool;
const serverActiveTool = () => INITIAL_STATE.activeTool;

/** Active tool only; consumers do not re-render for cursor movement. */
export function usePlanarActiveTool(): PlanarToolId {
  return useSyncExternalStore(planarToolStore.subscribe, activeToolSnapshot, serverActiveTool);
}

const cursorSnapshot = () => planarToolStore.getSnapshot().cursorUv;
const serverCursor = () => INITIAL_STATE.cursorUv;

/** Cursor position only (published at most once per animation frame). */
export function usePlanarCursorUv(): PlanarCursorUv | null {
  return useSyncExternalStore(planarToolStore.subscribe, cursorSnapshot, serverCursor);
}
