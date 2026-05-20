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

export function useLayoutActions() {
  const { layout } = useKernel();

  const setActiveTab = useCallback(
    (tabId: RibbonTabId) => layout.setActiveTab(tabId),
    [layout],
  );

  const togglePanel = useCallback(
    (panel: PanelPosition) => layout.togglePanel(panel),
    [layout],
  );

  return { setActiveTab, togglePanel } as const;
}

export function useLayoutSelector<T>(selector: (state: LayoutState) => T): T {
  const { layout } = useKernel();

  return useSyncExternalStore(
    (onStoreChange) => layout.subscribe(onStoreChange),
    () => selector(layout.get()),
    () => selector(layout.get()),
  );
}
