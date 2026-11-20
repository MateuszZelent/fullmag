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

/** A tab the active Inspector offers; the side rail renders one icon per tab. */
export interface InspectorTabInfo {
  id: string;
  label: string;
}

const NO_TABS: readonly InspectorTabInfo[] = Object.freeze([]);
let publishedTabs: readonly InspectorTabInfo[] = NO_TABS;
const tabListeners = new Set<Listener>();

function subscribeTabs(listener: Listener): () => void {
  tabListeners.add(listener);
  return () => tabListeners.delete(listener);
}

/** Publishes the mounted Inspector's tabs; unchanged lists keep their identity. */
export function publishInspectorTabs(tabs: readonly InspectorTabInfo[]): void {
  const same = tabs.length === publishedTabs.length &&
    tabs.every((tab, index) => tab.id === publishedTabs[index]?.id && tab.label === publishedTabs[index]?.label);
  if (same) return;
  publishedTabs = tabs.length === 0 ? NO_TABS : Object.freeze(tabs.map(({ id, label }) => ({ id, label })));
  tabListeners.forEach((listener) => listener());
}

export function readInspectorTabs(): readonly InspectorTabInfo[] {
  return publishedTabs;
}

export function useInspectorTabs(): readonly InspectorTabInfo[] {
  return useSyncExternalStore(subscribeTabs, () => publishedTabs, () => NO_TABS);
}
