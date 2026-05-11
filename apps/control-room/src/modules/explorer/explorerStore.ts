"use client";

import { useSyncExternalStore } from "react";

import type { ExplorerTabId } from "./explorerTypes";

type ExpandedIdsByTab = Record<ExplorerTabId, ReadonlySet<string>>;

export interface ExplorerStoreState {
  activeTab: ExplorerTabId;
  expandedIds: ExpandedIdsByTab;
  filterText: string;
  keyboardRow: string | null;
}

type ExplorerStoreListener = () => void;

function emptyExpandedIds(): ExpandedIdsByTab {
  return {
    diagnostics: new Set<string>(),
    jobs: new Set<string>(),
    model: new Set<string>(),
    resources: new Set<string>(),
    results: new Set<string>(),
  };
}

const INITIAL_STATE: ExplorerStoreState = {
  activeTab: "model",
  expandedIds: emptyExpandedIds(),
  filterText: "",
  keyboardRow: null,
};

class ExplorerStore {
  private listeners = new Set<ExplorerStoreListener>();
  private state: ExplorerStoreState = INITIAL_STATE;

  getSnapshot = (): ExplorerStoreState => this.state;

  subscribe = (listener: ExplorerStoreListener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setState(patch: Partial<ExplorerStoreState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  reset(): void {
    this.state = {
      ...INITIAL_STATE,
      expandedIds: emptyExpandedIds(),
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const explorerStore = new ExplorerStore();

export function useExplorerStore(): ExplorerStoreState {
  return useSyncExternalStore(
    explorerStore.subscribe,
    explorerStore.getSnapshot,
    explorerStore.getSnapshot,
  );
}

export function setExplorerActiveTab(activeTab: ExplorerTabId): void {
  explorerStore.setState({ activeTab, keyboardRow: null });
}

export function setExplorerFilterText(filterText: string): void {
  explorerStore.setState({ filterText });
}

export function setExplorerKeyboardRow(keyboardRow: string | null): void {
  explorerStore.setState({ keyboardRow });
}

export function expandExplorerNodes(tabId: ExplorerTabId, nodeIds: readonly string[]): void {
  const state = explorerStore.getSnapshot();
  explorerStore.setState({
    expandedIds: {
      ...state.expandedIds,
      [tabId]: new Set([...state.expandedIds[tabId], ...nodeIds]),
    },
  });
}

export function collapseExplorerNodes(tabId: ExplorerTabId, nodeIds: readonly string[]): void {
  const state = explorerStore.getSnapshot();
  const nextIds = new Set(state.expandedIds[tabId]);
  for (const nodeId of nodeIds) {
    nextIds.delete(nodeId);
  }

  explorerStore.setState({
    expandedIds: {
      ...state.expandedIds,
      [tabId]: nextIds,
    },
  });
}

export function toggleExplorerNode(tabId: ExplorerTabId, nodeId: string): void {
  const state = explorerStore.getSnapshot();
  const nextIds = new Set(state.expandedIds[tabId]);

  if (nextIds.has(nodeId)) {
    nextIds.delete(nodeId);
  } else {
    nextIds.add(nodeId);
  }

  explorerStore.setState({
    expandedIds: {
      ...state.expandedIds,
      [tabId]: nextIds,
    },
  });
}

export function resetExplorerStoreForTests(): void {
  explorerStore.reset();
}
