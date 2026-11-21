"use client";

import { useSyncExternalStore } from "react";
import type { Viewport3DSettingsSection } from "./components/Viewport3DSettingsContent";

export type Viewport3DInspectorContext = "selection" | "view" | "export";
export type Viewport3DExportMode = "png" | "3d";

interface InspectorDestination {
  context: Viewport3DInspectorContext;
  section: Viewport3DSettingsSection;
  exportMode: Viewport3DExportMode;
  visited: boolean;
  exportVisited: boolean;
  host: HTMLElement | null;
  exportHost: HTMLElement | null;
}

const INITIAL: InspectorDestination = {
  context: "selection",
  section: "view",
  exportMode: "png",
  visited: false,
  exportVisited: false,
  host: null,
  exportHost: null,
};

let snapshot = INITIAL;
let hostOwner: symbol | null = null;
let exportHostOwner: symbol | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getViewport3DInspectorSnapshot = () => snapshot;
const getServerSnapshot = () => INITIAL;

function update(patch: Partial<InspectorDestination>) {
  if (
    Object.entries(patch).every(
      ([key, value]) => snapshot[key as keyof InspectorDestination] === value,
    )
  ) {
    return;
  }
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
}

export function openViewport3DInspector(section?: Viewport3DSettingsSection) {
  update({ context: "view", visited: true, ...(section ? { section } : {}) });
}

export function openViewport3DExportInspector(exportMode?: Viewport3DExportMode) {
  update({
    context: "export",
    exportVisited: true,
    ...(exportMode ? { exportMode } : {}),
  });
}

export function setViewport3DInspectorContext(context: Viewport3DInspectorContext) {
  update({
    context,
    ...(context === "view" ? { visited: true } : {}),
    ...(context === "export" ? { exportVisited: true } : {}),
  });
}

export function setViewport3DInspectorSection(section: Viewport3DSettingsSection) {
  update({ section });
}

export function setViewport3DExportMode(exportMode: Viewport3DExportMode) {
  update({ exportMode });
}

/** Only presentation destinations cross the module boundary. Camera and export state remain in their viewport owner. */
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

export function registerViewport3DExportHost(exportHost: HTMLElement) {
  const owner = Symbol("viewport-export-host");
  exportHostOwner = owner;
  update({ exportHost });
  return () => {
    if (exportHostOwner !== owner) return;
    exportHostOwner = null;
    update({ exportHost: null });
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

export function useViewport3DExportVisited() {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.exportVisited,
    () => INITIAL.exportVisited,
  );
}
