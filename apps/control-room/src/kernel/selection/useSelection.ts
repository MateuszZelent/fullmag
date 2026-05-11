"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";
import type { ModuleId } from "../types";

import type { Selection } from "./selectionTypes";

/**
 * React hook for reading and writing kernel selection.
 * Re-renders only when the selection changes.
 */
export function useSelection(moduleId: ModuleId) {
  const { selection } = useKernel();

  const state = useSyncExternalStore<Selection>(
    (onStoreChange) => selection.subscribe(onStoreChange),
    () => selection.get(),
    () => selection.get(),
  );

  const select = useCallback(
    (patch: Partial<Omit<Selection, "moduleSource">>) => {
      selection.set(patch, moduleId);
    },
    [selection, moduleId],
  );

  const clear = useCallback(() => {
    selection.clear(moduleId);
  }, [selection, moduleId]);

  return { selection: state, select, clear } as const;
}
