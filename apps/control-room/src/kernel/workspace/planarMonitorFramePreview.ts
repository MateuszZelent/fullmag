"use client";

import { useSyncExternalStore } from "react";

export interface PlanarMonitorFramePreview {
  boundsUvM: readonly [number, number, number, number];
  monitorId: string;
  normal: readonly [number, number, number];
  originM: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
}

type Listener = () => void;

let preview: PlanarMonitorFramePreview | null = null;
const listeners = new Set<Listener>();

export const planarMonitorFramePreviewStore = {
  clear() {
    if (!preview) return;
    preview = null;
    emit();
  },
  getSnapshot() {
    return preview;
  },
  set(next: PlanarMonitorFramePreview) {
    preview = next;
    emit();
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function usePlanarMonitorFramePreview(): PlanarMonitorFramePreview | null {
  return useSyncExternalStore(
    planarMonitorFramePreviewStore.subscribe,
    planarMonitorFramePreviewStore.getSnapshot,
    planarMonitorFramePreviewStore.getSnapshot,
  );
}

function emit() {
  for (const listener of listeners) listener();
}
