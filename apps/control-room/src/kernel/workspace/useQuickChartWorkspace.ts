"use client";

import { useSyncExternalStore } from "react";

import {
  quickChartWorkspaceStore,
  type QuickChartWorkspaceState,
} from "./quickChartWorkspace";

const SERVER_SNAPSHOT: QuickChartWorkspaceState = { pinned: null };

export function useQuickChartWorkspaceSelector<T>(
  selector: (state: QuickChartWorkspaceState) => T,
): T {
  return useSyncExternalStore(
    quickChartWorkspaceStore.subscribe,
    () => selector(quickChartWorkspaceStore.getSnapshot()),
    () => selector(SERVER_SNAPSHOT),
  );
}
