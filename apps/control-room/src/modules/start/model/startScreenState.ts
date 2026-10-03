import { useSyncExternalStore } from "react";

import type { StartSection } from "./types";

/**
 * Tiny external store so commands (Ctrl 1–4, command palette) and the rail
 * drive the same section state without a provider.
 */
let section: StartSection = "home";
const listeners = new Set<() => void>();

export function getStartSection(): StartSection {
  return section;
}

export function setStartSection(next: StartSection): void {
  if (next === section) return;
  section = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStartSection(): StartSection {
  return useSyncExternalStore(subscribe, getStartSection, getStartSection);
}
