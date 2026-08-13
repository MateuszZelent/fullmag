"use client";

import { useCallback, useSyncExternalStore } from "react";

import type { RuntimeExplorerDetail } from "./runtimeExplorerTypes";

export interface RuntimeExplorerDetailEntry {
  detail: RuntimeExplorerDetail;
  id: string;
}

interface RuntimeExplorerDetailSnapshot {
  details: ReadonlyMap<string, RuntimeExplorerDetail>;
}

const EMPTY_SNAPSHOT: RuntimeExplorerDetailSnapshot = {
  details: new Map(),
};

class RuntimeExplorerDetailStore {
  private listeners = new Set<() => void>();
  private snapshot = EMPTY_SNAPSHOT;

  getServerSnapshot = (): RuntimeExplorerDetailSnapshot => EMPTY_SNAPSHOT;

  getSnapshot = (): RuntimeExplorerDetailSnapshot => this.snapshot;

  publish(entries: readonly RuntimeExplorerDetailEntry[]): void {
    this.snapshot = {
      details: new Map(entries.map((entry) => [entry.id, entry.detail])),
    };
    for (const listener of this.listeners) listener();
  }

  clear(): void {
    if (this.snapshot === EMPTY_SNAPSHOT) return;
    this.snapshot = EMPTY_SNAPSHOT;
    for (const listener of this.listeners) listener();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
}

export const runtimeExplorerDetailStore = new RuntimeExplorerDetailStore();

export function useRuntimeExplorerDetail(
  ref: { descriptorId: string; resourceKey: string } | null,
): RuntimeExplorerDetail | null {
  const getSnapshot = useCallback(() => {
    if (!ref) return null;
    const detail = runtimeExplorerDetailStore.getSnapshot().details.get(ref.descriptorId);
    return detail?.key === ref.resourceKey ? detail : null;
  }, [ref]);
  const getServerSnapshot = useCallback(() => {
    if (!ref) return null;
    const detail = runtimeExplorerDetailStore.getServerSnapshot().details.get(ref.descriptorId);
    return detail?.key === ref.resourceKey ? detail : null;
  }, [ref]);

  return useSyncExternalStore(
    runtimeExplorerDetailStore.subscribe,
    getSnapshot,
    getServerSnapshot,
  );
}
