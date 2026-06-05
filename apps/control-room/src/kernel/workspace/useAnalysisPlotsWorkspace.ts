"use client";

import { useSyncExternalStore } from "react";

import {
  analysisPlotsWorkspaceStore,
  type AnalysisPlotsWorkspaceState,
} from "./analysisPlotsWorkspace";

export function useAnalysisPlotsWorkspaceSelector<T>(
  selector: (state: AnalysisPlotsWorkspaceState) => T,
): T {
  return useSyncExternalStore(
    analysisPlotsWorkspaceStore.subscribe,
    () => selector(analysisPlotsWorkspaceStore.getSnapshot()),
    () => selector(analysisPlotsWorkspaceStore.getSnapshot()),
  );
}
