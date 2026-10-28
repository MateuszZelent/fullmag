import { useSyncExternalStore } from "react";

/**
 * Whether the start screen is laid over an open workspace. It is a view, not a
 * navigation: the workspace beneath stays mounted, so its viewport, drafts and
 * undo history survive a visit to Home.
 */
type Listener = () => void;
type DocsListener = (page: string) => void;

const listeners = new Set<Listener>();
const docsListeners = new Set<DocsListener>();
let open = false;

function publish(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export const homeView = {
  isOpen: (): boolean => open,
  open: (): void => publish(true),
  openDocs: (page = "index.html"): void => {
    for (const listener of docsListeners) listener(page);
    publish(true);
  },
  close: (): void => publish(false),
  toggle: (): void => publish(!open),
  subscribe: (listener: Listener): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  subscribeDocs: (listener: DocsListener): (() => void) => {
    docsListeners.add(listener);
    return () => docsListeners.delete(listener);
  },
  resetForTests: (): void => {
    open = false;
    listeners.clear();
  },
};

export function useHomeViewOpen(): boolean {
  return useSyncExternalStore(homeView.subscribe, homeView.isOpen, () => false);
}
