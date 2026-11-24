"use client";

import { useSyncExternalStore } from "react";

import {
  getBottomDockExpanded,
  setBottomDockExpanded,
} from "./bottomDockPreference";

/* ── Workspace full-screen (focus) mode ──
 * Automatically minimizes the top header/ribbon chrome and folds the bottom
 * footer dock to its slim tab strip while keeping the left (Model) and right
 * (Inspector) panels full. Exiting restores the pre-fullscreen bottom dock
 * expansion without overwriting the user's persisted footer preference. */
let fullscreen = false;
let restoreBottomDockExpanded: boolean | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function getWorkspaceFullscreen(): boolean {
  return fullscreen;
}

function getServerWorkspaceFullscreen(): boolean {
  return false;
}

export function subscribeWorkspaceFullscreen(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setWorkspaceFullscreen(next: boolean): void {
  if (fullscreen === next) return;
  if (next) {
    restoreBottomDockExpanded = getBottomDockExpanded();
    fullscreen = true;
    setBottomDockExpanded(false, { persist: false });
  } else {
    const previousBottomDockExpanded = restoreBottomDockExpanded;
    restoreBottomDockExpanded = null;
    fullscreen = false;
    if (previousBottomDockExpanded !== null) {
      setBottomDockExpanded(previousBottomDockExpanded, { persist: false });
    }
  }
  notify();
}

export function toggleWorkspaceFullscreen(): boolean {
  setWorkspaceFullscreen(!fullscreen);
  return fullscreen;
}

export function useWorkspaceFullscreen(): boolean {
  return useSyncExternalStore(
    subscribeWorkspaceFullscreen,
    getWorkspaceFullscreen,
    getServerWorkspaceFullscreen,
  );
}
