"use client";

import { useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";

export function useObjectVisualizationRegistry() {
  const { visualization } = useKernel();
  const snapshot = useSyncExternalStore(
    (onStoreChange) => visualization.subscribe(onStoreChange),
    () => visualization.getSnapshot(),
    () => visualization.getSnapshot(),
  );

  return {
    snapshot,
    visualization,
  } as const;
}
