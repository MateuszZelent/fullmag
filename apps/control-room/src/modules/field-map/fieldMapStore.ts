"use client";

import { useSyncExternalStore } from "react";

export interface FieldMapState {
  activeMonitorId: string | null;
  component: string;
  quantityId: string;
}

type Listener = () => void;

const INITIAL_STATE: FieldMapState = {
  activeMonitorId: null,
  component: "magnitude",
  quantityId: "m",
};

let state = INITIAL_STATE;
const listeners = new Set<Listener>();

export const fieldMapStore = {
  get: () => state,
  reset: () => fieldMapStore.set(INITIAL_STATE),
  set: (patch: Partial<FieldMapState>) => {
    const next = { ...state, ...patch };
    if (
      next.activeMonitorId === state.activeMonitorId &&
      next.component === state.component &&
      next.quantityId === state.quantityId
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
