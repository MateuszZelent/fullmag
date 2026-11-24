"use client";

import { useSyncExternalStore } from "react";
import { instanceTabs } from "./instanceTabs";

let selected: string | null = null;
let closed: string | null = null;
const listeners = new Set<() => void>();

export const sessionPreviewSelection = {
  getSnapshot: () => selected,
  select(sessionId: string | null) {
    if (sessionId !== null) instanceTabs.activate(null);
    if (selected === sessionId) return;
    selected = sessionId;
    for (const listener of listeners) listener();
  },
  close(sessionId: string) {
    if (selected !== sessionId) return;
    closed = sessionId;
    sessionPreviewSelection.select(null);
  },
  takeClosed() {
    const sessionId = closed;
    closed = null;
    return sessionId;
  },
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  },
};

export function useSessionPreviewSelection(): string | null {
  return useSyncExternalStore(
    sessionPreviewSelection.subscribe,
    sessionPreviewSelection.getSnapshot,
    () => null,
  );
}
