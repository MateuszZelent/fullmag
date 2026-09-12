/**
 * useViewportResourceManager — React hook providing a stable `ViewportResourceManager`.
 *
 * - The manager instance persists for the component lifetime.
 * - Re-creating (via `key` prop or unmount) triggers `disposeAll`.
 * - Budget can be customised via `budgetOverride`; changes after mount are ignored.
 *   If you need dynamic budgets, create a new manager instance.
 */

import { useEffect, useRef } from "react";
import {
  DEFAULT_VIEWPORT_BUDGET,
  ViewportResourceBudget,
  ViewportResourceManager,
} from "./ViewportResourceManager";

export type { ViewportResourceManager, ViewportResourceBudget, ViewportResourceStats } from "./ViewportResourceManager";

/**
 * Returns a stable `ViewportResourceManager` for the lifetime of the calling component.
 *
 * @param budgetOverride - Optional partial budget overrides applied once at mount.
 *                         All omitted fields use `DEFAULT_VIEWPORT_BUDGET` values.
 */
export function useViewportResourceManager(
  budgetOverride?: Partial<ViewportResourceBudget>,
): ViewportResourceManager {
  const managerRef = useRef<ViewportResourceManager | null>(null);

  if (managerRef.current === null) {
    const budget: ViewportResourceBudget = budgetOverride
      ? { ...DEFAULT_VIEWPORT_BUDGET, ...budgetOverride }
      : DEFAULT_VIEWPORT_BUDGET;
    managerRef.current = new ViewportResourceManager(budget);
  }

  useEffect(() => {
    const manager = managerRef.current!;
    return () => {
      manager.disposeAll("unmount");
    };
  }, []);

  return managerRef.current;
}
