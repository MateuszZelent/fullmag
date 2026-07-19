"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";

import type { RealtimeConnectionSnapshot } from "./RealtimeConnectionController";

export function useRealtimeConnection(): RealtimeConnectionSnapshot {
  const { realtimeConnection } = useKernel();
  const subscribe = useCallback(
    (listener: () => void) => realtimeConnection.subscribe(listener),
    [realtimeConnection],
  );
  const getSnapshot = useCallback(
    () => realtimeConnection.getSnapshot(),
    [realtimeConnection],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
