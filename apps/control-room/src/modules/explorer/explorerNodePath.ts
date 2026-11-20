"use client";

import { useSyncExternalStore } from "react";

import type { ExplorerNode } from "./explorerTypes";

/**
 * The Explorer tree path of the selected node, root first. The Inspector
 * shows it as its full selection path (specs/frontend-v2/13 §1a, slot 1).
 */
export interface ExplorerNodePath {
  nodeId: string;
  nodes: readonly ExplorerNode[];
}

const EMPTY: ExplorerNodePath | null = null;
let current: ExplorerNodePath | null = EMPTY;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Root-first chain of nodes ending at `nodeId`, or null when it is not in the tree. */
export function findExplorerNodePath(
  nodes: readonly ExplorerNode[],
  nodeId: string,
): ExplorerNode[] | null {
  for (const node of nodes) {
    if (node.id === nodeId) return [node];
    if (node.children?.length) {
      const below = findExplorerNodePath(node.children, nodeId);
      if (below) return [node, ...below];
    }
  }
  return null;
}

/** Publishes the path of the selected node; an unchanged chain keeps its identity. */
export function publishExplorerNodePath(
  nodes: readonly ExplorerNode[],
  nodeId: string | null,
): void {
  const path = nodeId ? findExplorerNodePath(nodes, nodeId) : null;
  const next = path && nodeId ? { nodeId, nodes: path } : null;
  const same = next === current || (
    next !== null && current !== null && next.nodeId === current.nodeId &&
    next.nodes.length === current.nodes.length &&
    next.nodes.every((node, index) => node.id === current?.nodes[index]?.id && node.label === current.nodes[index]?.label)
  );
  if (same) return;
  current = next;
  listeners.forEach((listener) => listener());
}

export function readExplorerNodePath(): ExplorerNodePath | null {
  return current;
}

/** The published path when it belongs to `nodeId`, else null. */
export function useExplorerNodePath(nodeId: string | null | undefined): ExplorerNodePath | null {
  const path = useSyncExternalStore(subscribe, () => current, () => EMPTY);
  return path && nodeId && path.nodeId === nodeId ? path : null;
}
