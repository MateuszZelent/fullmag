"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

import { useKernel } from "../KernelContext";
import type { ModuleId } from "../types";

import type { LayoutState, PanelPosition, RibbonTabId } from "./layoutTypes";

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

  const setActiveViewportMainModule = useCallback(
    (moduleId: ModuleId) => layout.setActiveViewportMainModule(moduleId),
    [layout],
  );

  return { setActiveTab, setActiveViewportMainModule, togglePanel } as const;
}

export function useLayoutSelector<T>(
  selector: (state: LayoutState) => T,
  options: { isEqual?: (previous: T, next: T) => boolean } = {},
): T {
  const { layout } = useKernel();
  const { isEqual = Object.is } = options;
  const selectedRef = useRef<{ selected: T } | null>(null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => layout.subscribe(onStoreChange),
    [layout],
  );
  const getSelectedSnapshot = useCallback(() => {
    const selected = selector(layout.get());
    const previous = selectedRef.current;
    if (previous && isEqual(previous.selected, selected)) {
      return previous.selected;
    }

    selectedRef.current = { selected };
    return selected;
  }, [isEqual, selector, layout]);

  return useSyncExternalStore(
    subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  );
}
