"use client";

import { useSyncExternalStore } from "react";

import {
  liveChartsWorkspaceStore,
  type LiveChartsWorkspaceState,
} from "./liveChartsWorkspace";

export function useLiveChartsWorkspaceSelector<T>(
  selector: (state: LiveChartsWorkspaceState) => T,
): T {
  return useSyncExternalStore(
    liveChartsWorkspaceStore.subscribe,
    () => selector(liveChartsWorkspaceStore.getSnapshot()),
    () => selector(liveChartsWorkspaceStore.getServerSnapshot()),
  );
}
