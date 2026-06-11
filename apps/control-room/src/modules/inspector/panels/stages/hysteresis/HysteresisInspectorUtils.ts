"use client";

import type { Selection } from "@/kernel/selection/selectionTypes";

type JsonRecord = Record<string, unknown>;

export type HysteresisInspectorView =
  | "overview"
  | "plan"
  | "protocol"
  | "saturation"
  | "live-run"
  | "branches"
  | "points"
  | "metrics"
  | "snapshots"
  | "current-field";

const HYSTERESIS_NODE_VIEW_SUFFIXES: Array<[string, HysteresisInspectorView]> = [
  [":plan", "plan"],
  [":protocol", "protocol"],
  [":saturation", "saturation"],
  [":live-run", "live-run"],
  [":branches", "branches"],
  [":branches:forward", "branches"],
  [":branches:return", "branches"],
  [":branches:minor-loops", "branches"],
  [":points", "points"],
  [":points:completed", "points"],
  [":points:queued", "points"],
  [":points:planned", "points"],
  [":metrics", "metrics"],
  [":snapshots", "snapshots"],
  [":field-current", "current-field"],
];

export function resolveHysteresisInspectorView(
  nodeId: string | null | undefined,
): HysteresisInspectorView {
  if (!nodeId) return "overview";
  if (nodeId.includes(":field-point:")) return "current-field";
  if (nodeId.includes(":algorithm:")) return "current-field";
  const match = HYSTERESIS_NODE_VIEW_SUFFIXES.find(([suffix]) =>
    nodeId.endsWith(suffix),
  );
  return match?.[1] ?? "overview";
}

export function parseJsonArray(value: string | undefined): JsonRecord[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export function parseJsonRecord(value: string | undefined): JsonRecord | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function displayValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export interface ActiveHysteresisSnapshotSelection {
  fieldValueMt: number | null;
  pointId: number | null;
  snapshotId: string;
}

export function activeHysteresisSnapshotSelection(
  selection: Selection,
  stageId: string | null | undefined,
): ActiveHysteresisSnapshotSelection | null {
  const ref = selection.ref;
  if (
    !stageId ||
    ref?.type !== "analysis-chart-point" ||
    ref.stageId !== stageId ||
    !ref.snapshotId
  ) {
    return null;
  }

  return {
    fieldValueMt: ref.x,
    pointId: ref.pointId ?? null,
    snapshotId: ref.snapshotId,
  };
}

export function activeHysteresisSnapshotSelectionEquals(
  left: ActiveHysteresisSnapshotSelection | null,
  right: ActiveHysteresisSnapshotSelection | null,
): boolean {
  return (
    left?.snapshotId === right?.snapshotId &&
    left?.pointId === right?.pointId &&
    left?.fieldValueMt === right?.fieldValueMt
  );
}

export function hysteresisInitialStateActionPresentation(
  snapshotId: string | null | undefined,
): {
  disabled: boolean;
  title: string;
} {
  return snapshotId
    ? {
        disabled: false,
        title: "Use point magnetization as the initial state for the selected or only object",
      }
    : {
        disabled: true,
        title: "Snapshot not saved for this point",
      };
}
