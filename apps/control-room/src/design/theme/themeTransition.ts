/** Root attribute that disables CSS transitions in theme.css. */
export const THEME_SWITCHING_ATTRIBUTE = "data-theme-switching";

type TransitionView = Pick<
  Window,
  | "getComputedStyle"
  | "requestAnimationFrame"
  | "cancelAnimationFrame"
  | "setTimeout"
  | "clearTimeout"
>;

let cancelPendingRestore: (() => void) | null = null;

function afterNextFrame(view: TransitionView, callback: () => void): () => void {
  if (typeof view.requestAnimationFrame !== "function") {
    const timer = view.setTimeout(callback, 32);
    return () => view.clearTimeout(timer);
  }
  let frame = view.requestAnimationFrame(() => {
    frame = view.requestAnimationFrame(callback);
  });
  return () => view.cancelAnimationFrame(frame);
}

/**
 * Runs a palette change with CSS transitions suspended, so controls jump to
 * the new palette instead of animating through low-contrast intermediate
 * colors. Transitions return only after a frame has been styled with the new
 * palette, so re-enabling them animates nothing.
 */
export function applyWithoutTransitions(
  root: Element,
  view: TransitionView,
  change: () => void,
): void {
  cancelPendingRestore?.();
  root.setAttribute(THEME_SWITCHING_ATTRIBUTE, "");
  change();
  // Flush styles now, while transitions are still off.
  void view.getComputedStyle(root).color;
  cancelPendingRestore = afterNextFrame(view, () => {
    cancelPendingRestore = null;
    root.removeAttribute(THEME_SWITCHING_ATTRIBUTE);
  });
}
