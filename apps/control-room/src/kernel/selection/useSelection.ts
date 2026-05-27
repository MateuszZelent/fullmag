"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";
import type { ModuleId } from "../types";

import type { Selection } from "./selectionTypes";
export { selectionSnapshotEquals } from "./selectionTypes";

export type SelectionPatch = Partial<Omit<Selection, "moduleSource">>;

export function useSelectionActions(moduleId: ModuleId) {
  const { selection } = useKernel();

  const select = useCallback(
    (patch: SelectionPatch) => {
      selection.set(patch, moduleId);
    },
    [selection, moduleId],
  );

  const clear = useCallback(() => {
    selection.clear(moduleId);
  }, [selection, moduleId]);

  return { select, clear } as const;
}

export function useSelectionSelector<T>(
  selector: (state: Selection) => T,
  options: { isEqual?: (previous: T, next: T) => boolean } = {},
): T {
  const { selection } = useKernel();
  const { isEqual = Object.is } = options;
  const selectedRef = useRef<{ selected: T } | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => selection.subscribe(onStoreChange),
    [selection],
  );
  const getSelectedSnapshot = useCallback(() => {
    const selected = selector(selection.get());
    const previous = selectedRef.current;
    if (previous && isEqual(previous.selected, selected)) {
      return previous.selected;
    }

    selectedRef.current = { selected };
    return selected;
  }, [isEqual, selector, selection]);

  return useSyncExternalStore(
    subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  );
}
