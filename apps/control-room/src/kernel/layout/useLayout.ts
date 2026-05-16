"use client";

import { useCallback, useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";

import type { LayoutState, PanelPosition, RibbonTabId } from "./layoutTypes";

/**
 * React hook for reading and writing kernel layout state.
 * Re-renders only when layout changes.
 */
export function useLayout() {
  const { layout } = useKernel();

  const state = useSyncExternalStore<LayoutState>(
    (onStoreChange) => layout.subscribe(onStoreChange),
    () => layout.get(),
    () => layout.get(),
  );

  const setActiveTab = useCallback(
    (tabId: RibbonTabId) => layout.setActiveTab(tabId),
    [layout],
  );

  const togglePanel = useCallback(
    (panel: PanelPosition) => layout.togglePanel(panel),
    [layout],
  );

  return { layout: state, setActiveTab, togglePanel } as const;
}
