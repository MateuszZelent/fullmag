"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";
import {
  EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS,
  getEmptyVisualizationDebugDemandSnapshot,
  type VisualizationDebugDemand,
  type VisualizationDebugController,
} from "./VisualizationDebugController";
import type { VisualizationDebugSnapshot } from "./visualizationDebugTypes";

export function useVisualizationDebugSnapshots(
  targetId: string,
): readonly VisualizationDebugSnapshot[] {
  const controller = useVisualizationDebugController();
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(targetId, listener),
    [controller, targetId],
  );
  const getSnapshot = useCallback(
    () => controller.getSnapshots(targetId),
    [controller, targetId],
  );

  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_VISUALIZATION_DEBUG_SNAPSHOTS,
  );
}

export function useVisualizationDebugDemand(
  targetId: string,
): VisualizationDebugDemand {
  const controller = useVisualizationDebugController();
  const serverSnapshot = getEmptyVisualizationDebugDemandSnapshot(targetId);
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribeDemand(targetId, listener),
    [controller, targetId],
  );
  const getSnapshot = useCallback(
    () => controller.getDemandSnapshot(targetId),
    [controller, targetId],
  );
  const getServerSnapshot = useCallback(
    () => serverSnapshot,
    [serverSnapshot],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useVisualizationDebugController(): VisualizationDebugController {
  return useKernel().visualizationDebug;
}
