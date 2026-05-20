"use client";

import { useSyncExternalStore } from "react";

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
): T {
  const { visualization } = useKernel();

  return useSyncExternalStore(
    (onStoreChange) => visualization.subscribe(onStoreChange),
    () => selector(visualization.getSnapshot()),
    () => selector(visualization.getSnapshot()),
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
