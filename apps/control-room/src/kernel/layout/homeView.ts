import { useSyncExternalStore } from "react";

/**
 * Whether the start screen is laid over an open workspace. It is a view, not a
 * navigation: the workspace beneath stays mounted, so its viewport, drafts and
 * undo history survive a visit to Home.
 */
type Listener = () => void;

const listeners = new Set<Listener>();
let open = false;

function publish(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export const homeView = {
  isOpen: (): boolean => open,
  open: (): void => publish(true),
  close: (): void => publish(false),
  toggle: (): void => publish(!open),
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  resetForTests: (): void => {
    open = false;
    listeners.clear();
  },
};

export function useHomeViewOpen(): boolean {
  return useSyncExternalStore(homeView.subscribe, homeView.isOpen, () => false);
}
