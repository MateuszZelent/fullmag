"use client";

import { useSyncExternalStore } from "react";
import { analysisWorkspaceStore, type AnalysisWorkspaceState } from "./analysisWorkspace";

export function useAnalysisWorkspaceSelector<T>(selector: (state: AnalysisWorkspaceState) => T): T {
  return useSyncExternalStore(analysisWorkspaceStore.subscribe, () => selector(analysisWorkspaceStore.getSnapshot()), () => selector(analysisWorkspaceStore.getServerSnapshot()));
}
