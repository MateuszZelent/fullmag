"use client";

import { useSyncExternalStore } from "react";

/* ── Bottom dock expansion ──
 * Like the ribbon: a collapsed dock keeps only its header (tab strip and
 * run status) so the workspace gains the height; picking a tab opens it
 * again. Independent of panelVisible.bottom, which hides the dock entirely.
 * Persisted per browser; the server snapshot is always expanded. */
const EXPANDED_STORAGE_KEY = "fullmag.control-room.bottom-dock-expanded.v1";
let expanded = true;
let hydrated = false;
const listeners = new Set<() => void>();

function hydrateFromStorage(): void {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    if (window.localStorage.getItem(EXPANDED_STORAGE_KEY) === "false") expanded = false;
  } catch {
    // Storage can be unavailable in private or embedded browsing contexts.
  }
}

export function getBottomDockExpanded(): boolean {
  return expanded;
}

function getServerBottomDockExpanded(): boolean {
  return true;
}

export function subscribeBottomDockExpanded(listener: () => void): () => void {
  listeners.add(listener);
  hydrateFromStorage();
  return () => listeners.delete(listener);
}

export function setBottomDockExpanded(
  next: boolean,
  options?: { persist?: boolean },
): void {
  hydrateFromStorage();
  if (expanded === next) return;
  expanded = next;
  if (options?.persist !== false) {
    try {
      window.localStorage.setItem(EXPANDED_STORAGE_KEY, String(next));
    } catch {
      // Keep the preference for this page even when persistence is unavailable.
    }
  }
  for (const listener of listeners) listener();
}

export function toggleBottomDockExpanded(): boolean {
  setBottomDockExpanded(!getBottomDockExpanded());
  return expanded;
}

export function useBottomDockExpanded(): boolean {
  return useSyncExternalStore(
    subscribeBottomDockExpanded,
    getBottomDockExpanded,
    getServerBottomDockExpanded,
  );
}
