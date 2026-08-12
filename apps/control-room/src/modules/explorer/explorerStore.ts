"use client";

import { useCallback, useRef, useSyncExternalStore } from "react";

import type { ExplorerTabId } from "./explorerTypes";
import {
  buildExplorerTree,
  collectExplorerNodeIds,
} from "./builders/buildModelTree";

type ExpandedIdsByTab = Record<ExplorerTabId, ReadonlySet<string>>;

export interface ExplorerStoreState {
  activeTab: ExplorerTabId;
  expandedIds: ExpandedIdsByTab;
  filterText: string;
  textureLoadObjectIds: ReadonlySet<string>;
  keyboardRow: string | null;
  resultContextRunId: string | null;
}

type ExplorerStoreListener = () => void;

/** Returns a set with every node ID in that tab's tree — fully expanded by default. */
function defaultExpandedIds(): ExpandedIdsByTab {
  const tabs: ExplorerTabId[] = ["model", "resources", "results", "jobs", "diagnostics"];
  const result = {} as ExpandedIdsByTab;
  for (const tab of tabs) {
    const expandedIds = new Set(collectExplorerNodeIds(buildExplorerTree(tab)));
    if (tab === "model") {
      expandedIds.delete("model:mesh");
    }
    result[tab] = expandedIds;
  }
  return result;
}

const INITIAL_STATE: ExplorerStoreState = {
  activeTab: "model",
  expandedIds: defaultExpandedIds(),
  filterText: "",
  textureLoadObjectIds: new Set(),
  keyboardRow: null,
  resultContextRunId: null,
};

class ExplorerStore {
  private listeners = new Set<ExplorerStoreListener>();
  private defaultExpandedModelObjectIds = new Set<string>();
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
    this.defaultExpandedModelObjectIds.clear();
    this.state = {
      ...INITIAL_STATE,
      expandedIds: defaultExpandedIds(),
    };
    this.notify();
  }

  ensureModelObjectDefaults(objectRootIds: readonly string[]): void {
    const newObjectRootIds = objectRootIds.filter(
      (nodeId) => !this.defaultExpandedModelObjectIds.has(nodeId),
    );
    if (newObjectRootIds.length === 0) return;

    const state = this.state;
    const expandedModelIds = new Set(state.expandedIds.model);
    for (const nodeId of newObjectRootIds) {
      this.defaultExpandedModelObjectIds.add(nodeId);
      expandedModelIds.add(nodeId);
    }

    this.setState({
      expandedIds: {
        ...state.expandedIds,
        model: expandedModelIds,
      },
    });
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export const explorerStore = new ExplorerStore();

export function useExplorerStoreSelector<T>(
  selector: (state: ExplorerStoreState) => T,
  options: { isEqual?: (previous: T, next: T) => boolean } = {},
): T {
  const { isEqual = Object.is } = options;
  const selectedRef = useRef<{ selected: T } | null>(null);

  const getSelectedSnapshot = useCallback(() => {
    const selected = selector(explorerStore.getSnapshot());
    const previous = selectedRef.current;
    if (previous && isEqual(previous.selected, selected)) {
      return previous.selected;
    }

    selectedRef.current = { selected };
    return selected;
  }, [isEqual, selector]);

  return useSyncExternalStore(
    explorerStore.subscribe,
    getSelectedSnapshot,
    getSelectedSnapshot,
  );
}

export function setExplorerActiveTab(activeTab: ExplorerTabId): void {
  explorerStore.setState({ activeTab, keyboardRow: null });
}

export function shouldAutoRevealModelTab(
  previousNodeId: string | null,
  selectedNodeId: string | null,
  activeTab: ExplorerTabId,
): boolean {
  return previousNodeId !== selectedNodeId
    && selectedNodeId?.startsWith("model:") === true
    && activeTab !== "model";
}

export function setExplorerFilterText(filterText: string): void {
  explorerStore.setState({ filterText });
}

export function setExplorerResultContextRunId(
  resultContextRunId: string | null,
): void {
  explorerStore.setState({ resultContextRunId });
}

export function reconcileResultContextRunId({
  currentRunId,
  previousCurrentRunId,
  selectedRunId,
}: {
  currentRunId: string | null;
  previousCurrentRunId: string | null;
  selectedRunId: string | null;
}): string | null {
  if (!currentRunId) return selectedRunId;
  if (!selectedRunId || selectedRunId === previousCurrentRunId) {
    return currentRunId;
  }
  return selectedRunId;
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

export function ensureExplorerModelObjectDefaults(
  objectRootIds: readonly string[],
): void {
  explorerStore.ensureModelObjectDefaults(objectRootIds);
}

export function revealExplorerNode(
  tabId: ExplorerTabId,
  nodeId: string,
  ancestorIds: readonly string[],
): void {
  const state = explorerStore.getSnapshot();
  const expanded = new Set(state.expandedIds[tabId]);
  let expansionChanged = false;
  for (const ancestorId of ancestorIds) {
    if (expanded.has(ancestorId)) continue;
    expanded.add(ancestorId);
    expansionChanged = true;
  }
  if (
    state.activeTab === tabId &&
    state.keyboardRow === nodeId &&
    !expansionChanged
  ) {
    return;
  }
  explorerStore.setState({
    activeTab: tabId,
    expandedIds: expansionChanged
      ? { ...state.expandedIds, [tabId]: expanded }
      : state.expandedIds,
    keyboardRow: nodeId,
  });
}

export function activateTextureLoadNode(objectId: string): void {
  const state = explorerStore.getSnapshot();
  explorerStore.setState({
    activeTab: "model",
    expandedIds: {
      ...state.expandedIds,
      model: new Set([
        ...state.expandedIds.model,
        `model:object:${objectId}`,
        `model:object:${objectId}:magnetic-texture`,
      ]),
    },
    textureLoadObjectIds: new Set([...state.textureLoadObjectIds, objectId]),
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
