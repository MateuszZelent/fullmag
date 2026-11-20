"use client";

import { useSyncExternalStore } from "react";

import type { Selection } from "./selectionTypes";

/**
 * Root-first path of the selected tree node. The Explorer publishes it and
 * the Inspector renders it as its selection path (specs/frontend-v2/13 §1a,
 * slot 1); the kernel owns it so the two modules stay independent.
 */
export interface SelectionPathCrumb {
  id: string;
  label: string;
  /** Selection that the crumb restores; absent for the current node. */
  selection?: Omit<Selection, "moduleSource">;
}

export interface SelectionPath {
  nodeId: string;
  crumbs: readonly SelectionPathCrumb[];
}

let current: SelectionPath | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function samePath(a: SelectionPath | null, b: SelectionPath | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.nodeId !== b.nodeId || a.crumbs.length !== b.crumbs.length) return false;
  return a.crumbs.every((crumb, index) =>
    crumb.id === b.crumbs[index]?.id && crumb.label === b.crumbs[index]?.label);
}

/** Publishes the selected path; an unchanged chain keeps its identity. */
export function publishSelectionPath(next: SelectionPath | null): void {
  if (samePath(next, current)) return;
  current = next;
  listeners.forEach((listener) => listener());
}

export function readSelectionPath(): SelectionPath | null {
  return current;
}

/** The published path when it belongs to `nodeId`, else null. */
export function useSelectionPath(nodeId: string | null | undefined): SelectionPath | null {
  const path = useSyncExternalStore(subscribe, () => current, () => null);
  return path && nodeId && path.nodeId === nodeId ? path : null;
}
