"use client";

import { useSyncExternalStore } from "react";

type Listener = () => void;
let activeTab = "overview";
let descriptorKey = "";
const listeners = new Set<Listener>();

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): string {
  return activeTab;
}

export function configureInspectorTabs(key: string, tabIds: readonly string[]): void {
  const next = key === descriptorKey && tabIds.includes(activeTab)
    ? activeTab
    : tabIds[0] ?? "overview";
  descriptorKey = key;
  if (next === activeTab) return;
  activeTab = next;
  listeners.forEach((listener) => listener());
}

export function setInspectorActiveTab(tabId: string): void {
  if (tabId === activeTab) return;
  activeTab = tabId;
  listeners.forEach((listener) => listener());
}

export function useInspectorActiveTab(): string {
  return useSyncExternalStore(subscribe, snapshot, () => "overview");
}
