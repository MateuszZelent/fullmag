"use client";

import { useSyncExternalStore } from "react";

import type {
  PlanarMonitorDraft,
  PlanarMonitorOperator,
} from "./crossSectionWorkspace";

export interface PlanarMonitorFramePreview {
  boundsUvM: readonly [number, number, number, number];
  monitorId: string;
  normal: readonly [number, number, number];
  operator: PlanarMonitorOperator | null;
  originM: readonly [number, number, number];
  uAxis: readonly [number, number, number];
  vAxis: readonly [number, number, number];
  /** Preview-only overlays may be hidden without retaining an interaction target. */
  selectable?: boolean;
  visible?: boolean;
}

export type PlanarMonitorPreviewSupport =
  | { status: "ready" }
  | { reason: string; status: "unavailable" };

export function resolvePlanarMonitorPreviewSupport(
  operator: PlanarMonitorOperator,
): PlanarMonitorPreviewSupport {
  if (operator.kind === "depth_projection") {
    return {
      reason: "Depth projection has no finite 3D support frame; edit its monitor frame in the Inspector.",
      status: "unavailable",
    };
  }
  if (operator.kind === "surface_projection") {
    return {
      reason: "Surface projection support is backend-resolved and has no published 3D boundary frame.",
      status: "unavailable",
    };
  }
  return { status: "ready" };
}

export function planarMonitorFramePreviewCanSelect(
  preview: PlanarMonitorFramePreview,
): boolean {
  return preview.visible !== false && preview.selectable !== false;
}

interface PlanarMonitorPreviewBounds {
  center: readonly [number, number, number];
  size: readonly [number, number, number];
}

export function planarMonitorFramePreviewFromDraft(
  draft: PlanarMonitorDraft,
  bounds: PlanarMonitorPreviewBounds | null,
): PlanarMonitorFramePreview | null {
  const { frame } = draft.monitor;
  if (resolvePlanarMonitorPreviewSupport(draft.monitor.operator).status !== "ready") {
    return null;
  }
  const boundsUvM = frame.extent.kind === "explicit"
    ? [
      frame.extent.u_min_m,
      frame.extent.u_max_m,
      frame.extent.v_min_m,
      frame.extent.v_max_m,
    ] as const
    : projectBoundsToMonitorFrame(bounds, frame);
  if (!boundsUvM) return null;
  return {
    boundsUvM,
    monitorId: draft.monitor.id,
    normal: frame.normal as [number, number, number],
    operator: draft.monitor.operator,
    originM: frame.origin_m as [number, number, number],
    uAxis: frame.u_axis as [number, number, number],
    vAxis: frame.v_axis as [number, number, number],
    selectable: true,
    visible: true,
  };
}

type Listener = () => void;

let preview: PlanarMonitorFramePreview | null = null;
let draftPreview: PlanarMonitorDraft | null = null;
const listeners = new Set<Listener>();

export const planarMonitorFramePreviewStore = {
  clear() {
    if (!preview) return;
    preview = null;
    emit();
  },
  clearDraft() {
    if (!draftPreview) return;
    draftPreview = null;
    emit();
  },
  getDraftSnapshot() {
    return draftPreview;
  },
  getSnapshot() {
    return preview;
  },
  set(next: PlanarMonitorFramePreview) {
    preview = next;
    emit();
  },
  setDraft(next: PlanarMonitorDraft | null) {
    if (draftPreview === next) return;
    draftPreview = next;
    emit();
  },
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export function usePlanarMonitorFramePreview(): PlanarMonitorFramePreview | null {
  return useSyncExternalStore(
    planarMonitorFramePreviewStore.subscribe,
    planarMonitorFramePreviewStore.getSnapshot,
    planarMonitorFramePreviewStore.getSnapshot,
  );
}

export function usePlanarMonitorFramePreviewDraft(): PlanarMonitorDraft | null {
  return useSyncExternalStore(
    planarMonitorFramePreviewStore.subscribe,
    planarMonitorFramePreviewStore.getDraftSnapshot,
    planarMonitorFramePreviewStore.getDraftSnapshot,
  );
}

function emit() {
  for (const listener of listeners) listener();
}

function projectBoundsToMonitorFrame(
  bounds: PlanarMonitorPreviewBounds | null,
  frame: PlanarMonitorDraft["monitor"]["frame"],
): readonly [number, number, number, number] | null {
  if (!bounds || frame.extent.kind === "explicit") return null;
  const halfSize = bounds.size.map((value) => value / 2);
  const uValues: number[] = [];
  const vValues: number[] = [];
  for (const xSign of [-1, 1]) {
    for (const ySign of [-1, 1]) {
      for (const zSign of [-1, 1]) {
        const signs = [xSign, ySign, zSign];
        const corner = bounds.center.map((value, axis) =>
          value + signs[axis] * halfSize[axis]);
        const relative = corner.map((value, axis) => value - frame.origin_m[axis]);
        uValues.push(dot(relative, frame.u_axis));
        vValues.push(dot(relative, frame.v_axis));
      }
    }
  }
  return [
    Math.min(...uValues) - frame.extent.padding_m,
    Math.max(...uValues) + frame.extent.padding_m,
    Math.min(...vValues) - frame.extent.padding_m,
    Math.max(...vValues) + frame.extent.padding_m,
  ];
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}
