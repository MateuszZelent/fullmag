"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";
import type {
  ObjectVisualizationController,
  ObjectVisualizationSnapshot,
} from "./ObjectVisualizationController";

export const EMPTY_OBJECT_VISUALIZATION_SNAPSHOT: ObjectVisualizationSnapshot = {
  defaults: {},
  overrides: {},
  version: 0,
};

export function useObjectVisualizationSelector<T>(
  selector: (snapshot: ObjectVisualizationSnapshot) => T,
  options: { isEqual?: (previous: T, next: T) => boolean } = {},
): T {
  const { visualization } = useKernel();
  const { isEqual = Object.is } = options;
  const selectedRef = useRef<{ selected: T } | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => visualization.subscribe(onStoreChange),
    [visualization],
  );
  const getSelectedSnapshot = useCallback(() => {
    const selected = selector(visualization.getSnapshot());
    const previous = selectedRef.current;
    if (previous && isEqual(previous.selected, selected)) {
      return previous.selected;
    }

    selectedRef.current = { selected };
    return selected;
  }, [isEqual, selector, visualization]);

  return useSyncExternalStore(
    subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  );
}

export function useObjectVisualizationController(): ObjectVisualizationController {
  return useKernel().visualization;
}

export function useObjectVisualizationRegistry() {
  const visualization = useObjectVisualizationController();
  const snapshot = useObjectVisualizationSelector((currentSnapshot) => currentSnapshot);

  return {
    snapshot,
    visualization,
  } as const;
}
