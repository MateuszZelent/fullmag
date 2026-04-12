"use client";

import { useEffect } from "react";
import { createWorkspaceGraphSnapshot } from "../model/createWorkspaceGraphSnapshot";
import type { WorkspaceGraphBridgeInput } from "../model/types";
import { useWorkspaceGraphStore } from "../store/useWorkspaceGraphStore";

export function useWorkspaceGraphBridge(input: WorkspaceGraphBridgeInput): void {
  const applySnapshot = useWorkspaceGraphStore((state) => state.applySnapshot);

  useEffect(() => {
    applySnapshot(createWorkspaceGraphSnapshot(input));
  }, [
    applySnapshot,
    input.activeWorkspaceTabByStage,
    input.plane,
    input.projectLabel,
    input.quantities,
    input.renderMode,
    input.requestedPreviewComponent,
    input.requestedPreviewQuantity,
    input.resultsWorkspace,
    input.scalarRows,
    input.selectedNodeId,
    input.sliceIndex,
    input.studyPipeline,
    input.viewMode,
    input.workspaceMode,
    input.workspaceTabs,
  ]);
}

