"use client";

import { useSyncExternalStore } from "react";

export interface FieldMapState {
  hoverUv: readonly [number, number] | null;
}

type Listener = () => void;

const INITIAL_STATE: FieldMapState = {
  hoverUv: null,
};

let state = INITIAL_STATE;
const listeners = new Set<Listener>();

export const fieldMapStore = {
  get: () => state,
  reset: () => fieldMapStore.set(INITIAL_STATE),
  set: (patch: Partial<FieldMapState>) => {
    const next = { ...state, ...patch };
    if (
      next.hoverUv?.[0] === state.hoverUv?.[0] &&
      next.hoverUv?.[1] === state.hoverUv?.[1]
    ) {
      return;
    }
    state = next;
    for (const listener of listeners) listener();
  },
  subscribe: (listener: Listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function useFieldMapState(): FieldMapState {
  return useSyncExternalStore(
    fieldMapStore.subscribe,
    fieldMapStore.get,
    fieldMapStore.get,
  );
}
