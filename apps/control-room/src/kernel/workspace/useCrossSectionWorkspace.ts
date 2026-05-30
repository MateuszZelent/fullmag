"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

import {
  crossSectionWorkspaceStore,
  type CrossSectionWorkspaceState,
} from "./crossSectionWorkspace";

export function useCrossSectionWorkspaceSelector<T>(
  selector: (state: CrossSectionWorkspaceState) => T,
  options: { isEqual?: (previous: T, next: T) => boolean } = {},
): T {
  const { isEqual = Object.is } = options;
  const selectedRef = useRef<{ selected: T } | null>(null);

  const getSelectedSnapshot = useCallback(() => {
    const selected = selector(crossSectionWorkspaceStore.getSnapshot());
    const previous = selectedRef.current;
    if (previous && isEqual(previous.selected, selected)) {
      return previous.selected;
    }

    selectedRef.current = { selected };
    return selected;
  }, [isEqual, selector]);

  return useSyncExternalStore(
    crossSectionWorkspaceStore.subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  );
}
