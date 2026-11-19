"use client";

import { useSyncExternalStore } from "react";
import type { Viewport3DSettingsSection } from "./components/Viewport3DSettingsContent";

export type Viewport3DInspectorContext = "selection" | "view";
interface InspectorDestination {
  context: Viewport3DInspectorContext;
  section: Viewport3DSettingsSection;
  visited: boolean;
  host: HTMLElement | null;
}
const INITIAL: InspectorDestination = { context: "selection", section: "view", visited: false, host: null };
let snapshot = INITIAL;
let hostOwner: symbol | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getViewport3DInspectorSnapshot = () => snapshot;
const getServerSnapshot = () => INITIAL;
function update(patch: Partial<InspectorDestination>) {
  if (Object.entries(patch).every(([key, value]) => snapshot[key as keyof InspectorDestination] === value)) return;
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(listener => listener());
}
export function openViewport3DInspector(section?: Viewport3DSettingsSection) {
  update({ context: "view", visited: true, ...(section ? { section } : {}) });
}
export function setViewport3DInspectorContext(context: Viewport3DInspectorContext) {
  update({ context, ...(context === "view" ? { visited: true } : {}) });
}
export function setViewport3DInspectorSection(section: Viewport3DSettingsSection) { update({ section }); }
/** Only a presentation destination crosses the module boundary. Camera state and mutations remain in their viewport owner. */
export function registerViewport3DInspectorHost(host: HTMLElement) {
  const owner = Symbol("viewport-inspector-host");
  hostOwner = owner;
  update({ host });
  return () => {
    if (hostOwner !== owner) return;
    hostOwner = null;
    update({ host: null });
  };
}
export function useViewport3DInspectorDestination() {
  return useSyncExternalStore(subscribe, getViewport3DInspectorSnapshot, getServerSnapshot);
}
export function useViewport3DInspectorContext() {
  return useSyncExternalStore(subscribe, () => snapshot.context, () => INITIAL.context);
}
export function useViewport3DInspectorVisited() {
  return useSyncExternalStore(subscribe, () => snapshot.visited, () => INITIAL.visited);
}
