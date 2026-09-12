"use client";

import { useEffect, useMemo, useRef } from "react";
import type { WorkspaceMode, WorkspaceTab } from "@/lib/workspace/workspace-store";
import {
  applyWorkspaceTabSelection,
  type WorkspaceTabSelectionApi,
} from "./tabSelection";

interface UseDockCenterTabSelectionInput {
  enabled: boolean;
  stage: WorkspaceMode;
  activeTab: WorkspaceTab | null;
  api: WorkspaceTabSelectionApi;
}

export function useDockCenterTabSelection({
  enabled,
  stage,
  activeTab,
  api,
}: UseDockCenterTabSelectionInput): void {
  const signature = useMemo(() => {
    if (!activeTab) return "none";
    return JSON.stringify({
      stage,
      tabId: activeTab.id,
      tabKind: activeTab.kind,
      resultWorkspaceId: activeTab.payload?.resultWorkspaceId ?? null,
      quantityId: activeTab.payload?.quantityId ?? null,
      analyzeDomain: activeTab.payload?.analyzeDomain ?? null,
      analyzeTab: activeTab.payload?.analyzeTab ?? null,
      currentWorkspaceMode: api.currentWorkspaceMode,
      effectiveViewMode: api.effectiveViewMode,
      selectedQuantity: api.selectedQuantity,
      activeResultWorkspaceId: api.activeResultWorkspaceId,
      analyzeDomainState: api.analyzeSelection.domain,
      analyzeTabState: api.analyzeSelection.tab,
      selectedModeIndex: api.analyzeSelection.selectedModeIndex,
    });
  }, [
    activeTab,
    api.activeResultWorkspaceId,
    api.analyzeSelection.domain,
    api.analyzeSelection.selectedModeIndex,
    api.analyzeSelection.tab,
    api.currentWorkspaceMode,
    api.effectiveViewMode,
    api.selectedQuantity,
    stage,
  ]);
  const lastAppliedSignatureRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !activeTab) {
      return;
    }
    if (lastAppliedSignatureRef.current === signature) {
      return;
    }
    lastAppliedSignatureRef.current = signature;
    applyWorkspaceTabSelection(stage, activeTab, api);
  }, [activeTab, api, enabled, signature, stage]);
}
