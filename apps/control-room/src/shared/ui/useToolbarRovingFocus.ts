import {
  useCallback,
  useLayoutEffect,
  useRef,
  type DependencyList,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

/** Default focusable toolbar items: enabled buttons plus explained disabled shells. */
export const DEFAULT_TOOLBAR_ITEM_SELECTOR =
  "button:not(:disabled), [data-disabled-reason], [role='combobox']";

/** Targets that own their own arrow-key semantics and must not be hijacked. */
const ARROW_KEY_OWNERS =
  "input, textarea, select, [role='slider'], [role='menu'], [role='menuitem'], [data-radix-popper-content-wrapper]";

export interface ToolbarRovingFocusOptions {
  /** CSS selector for items that participate in the single tab stop. */
  itemSelector?: string;
  orientation?: "horizontal" | "vertical";
  /** Values that change the rendered item set; re-normalizes tab stops. */
  deps?: DependencyList;
}

export interface ToolbarRovingFocus<T extends HTMLElement> {
  ref: RefObject<T | null>;
  onKeyDown: (event: ReactKeyboardEvent<T>) => void;
}

export function toolbarItems(toolbar: HTMLElement, itemSelector: string): HTMLElement[] {
  return Array.from(toolbar.querySelectorAll<HTMLElement>(itemSelector)).filter(
    // Items nested in a child toolbar belong to that toolbar's own tab stop.
    (item) => item.closest("[role='toolbar']") === toolbar,
  );
}

/**
 * WAI-ARIA toolbar keyboard model: exactly one item in the tab order, arrow
 * keys move between items (wrapping), Home/End jump to the ends. Clicking an
 * item makes it the remembered tab stop.
 */
export function useToolbarRovingFocus<T extends HTMLElement = HTMLDivElement>({
  itemSelector = DEFAULT_TOOLBAR_ITEM_SELECTOR,
  orientation = "horizontal",
  deps = [],
}: ToolbarRovingFocusOptions = {}): ToolbarRovingFocus<T> {
  const ref = useRef<T>(null);

  useLayoutEffect(() => {
    const toolbar = ref.current;
    if (!toolbar) return;
    const items = toolbarItems(toolbar, itemSelector);
    if (items.length === 0) return;
    const focused = items.find((item) => item.contains(document.activeElement));
    const current = focused ?? items.find((item) => item.tabIndex === 0) ?? items[0];
    for (const item of items) item.tabIndex = item === current ? 0 : -1;

    const rememberFocus = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const active = toolbarItems(toolbar, itemSelector);
      if (!active.includes(target)) return;
      for (const item of active) item.tabIndex = item === target ? 0 : -1;
    };
    toolbar.addEventListener("focusin", rememberFocus);
    return () => toolbar.removeEventListener("focusin", rememberFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemSelector, ...deps]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<T>) => {
      const target = event.target;
      if (!(target instanceof Element) || target.closest(ARROW_KEY_OWNERS)) return;
      const items = toolbarItems(event.currentTarget, itemSelector);
      const currentIndex = items.findIndex((item) => item === target || item.contains(target));
      if (currentIndex < 0) return;

      const next = orientation === "vertical" ? "ArrowDown" : "ArrowRight";
      const previous = orientation === "vertical" ? "ArrowUp" : "ArrowLeft";
      let nextIndex: number | undefined;
      if (event.key === next) nextIndex = (currentIndex + 1) % items.length;
      else if (event.key === previous) nextIndex = (currentIndex - 1 + items.length) % items.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = items.length - 1;
      if (nextIndex === undefined) return;

      event.preventDefault();
      items.forEach((item, index) => {
        item.tabIndex = index === nextIndex ? 0 : -1;
      });
      items[nextIndex]?.focus();
    },
    [itemSelector, orientation],
  );

  return { ref, onKeyDown };
}
