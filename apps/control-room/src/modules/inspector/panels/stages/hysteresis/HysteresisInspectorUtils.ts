"use client";

import type { Selection } from "@/kernel/selection/selectionTypes";
import type { HysteresisExecutionTreeNode } from "@/kernel/api/apiTypes";

type JsonRecord = Record<string, unknown>;

export type HysteresisInspectorView =
  | "overview"
  | "plan"
  | "protocol"
  | "orientation"
  | "saturation"
  | "adaptive-refinement"
  | "angular-family"
  | "settle-pipeline"
  | "live-run"
  | "branches"
  | "branch-detail"
  | "points"
  | "points-completed"
  | "points-queued"
  | "points-planned"
  | "points-bookmarks"
  | "metrics"
  | "snapshots"
  | "transitions"
  | "settle-trace"
  | "execution-node"
  | "point-detail"
  | "current-field";

const HYSTERESIS_NODE_VIEW_SUFFIXES: Array<[string, HysteresisInspectorView]> = [
  [":plan", "plan"],
  [":protocol", "protocol"],
  [":orientation", "orientation"],
  [":saturation", "saturation"],
  [":adaptive-refinement", "adaptive-refinement"],
  [":angular-family", "angular-family"],
  [":settle-pipeline", "settle-pipeline"],
  [":live-run", "live-run"],
  [":branches", "branches"],
  [":branches:forward", "branch-detail"],
  [":branches:return", "branch-detail"],
  [":branches:minor-loops", "branch-detail"],
  [":points", "points"],
  [":points:completed", "points-completed"],
  [":points:queued", "points-queued"],
  [":points:planned", "points-planned"],
  [":points:bookmarks", "points-bookmarks"],
  [":metrics", "metrics"],
  [":snapshots", "snapshots"],
  [":transitions", "transitions"],
  [":transitions:continue", "transitions"],
  [":transitions:use-selected-point", "transitions"],
  [":state-transition", "transitions"],
  [":field-current", "current-field"],
];

export function resolveHysteresisInspectorView(
  nodeId: string | null | undefined,
): HysteresisInspectorView {
  if (!nodeId) return "overview";
  if (nodeId.includes(":points:bookmarks:snapshot:")) {
    return "snapshots";
  }
  if (
    nodeId.includes(":points:bookmarks:bookmark:") ||
    nodeId.includes(":points:bookmarks:key_event:")
  ) {
    return "points-bookmarks";
  }
  if (nodeId.includes(":field-point:") && nodeId.includes(":algorithm:")) {
    return "settle-trace";
  }
  if (nodeId.includes(":field-point:") && nodeId.includes(":snapshot:")) {
    return "snapshots";
  }
  if (nodeId.includes(":field-point:") && nodeId.includes(":warning:")) {
    return "execution-node";
  }
  if (/:field-point:\d+:[^:]+:/.test(nodeId)) {
    return "execution-node";
  }
  if (nodeId.includes(":field-point:")) return "point-detail";
  if (nodeId.includes(":branches:branch:")) return "branch-detail";
  if (nodeId.includes(":field-current:algorithm:")) return "settle-pipeline";
  if (nodeId.includes(":algorithm:")) return "settle-trace";
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

export interface ActiveHysteresisPointSelection {
  fieldValueMt: number | null;
  pointId: number | null;
  snapshotId: string | null;
}

export type ActiveHysteresisBranchSelection =
  | {
      branchId: string | null;
      kind: "branch";
      requestedRole: "forward" | "return" | null;
    }
  | { kind: "minor-loops" };

export interface ActiveHysteresisExecutionNodeSelection {
  nodeId: string | null;
  nodeKind: string | null;
  pointId: number | null;
  resourceRef: string | null;
}

export function activeHysteresisSnapshotSelection(
  selection: Selection,
  stageId: string | null | undefined,
): ActiveHysteresisSnapshotSelection | null {
  const ref = selection.ref;
  if (
    ref?.type === "hysteresis-snapshot" &&
    ref.stageId === stageId &&
    ref.snapshotId
  ) {
    return {
      fieldValueMt: null,
      pointId: ref.pointId,
      snapshotId: ref.snapshotId,
    };
  }
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

export function activeHysteresisPointSelection(
  selection: Selection,
  stageId: string | null | undefined,
): ActiveHysteresisPointSelection | null {
  if (!stageId) {
    return null;
  }
  const ref = selection.ref;
  if (ref?.type === "hysteresis-snapshot" && ref.stageId === stageId) {
    return {
      fieldValueMt: null,
      pointId: ref.pointId,
      snapshotId: ref.snapshotId,
    };
  }
  if (ref?.type === "analysis-chart-point" && ref.stageId === stageId) {
    return {
      fieldValueMt: ref.x,
      pointId: ref.pointId ?? null,
      snapshotId: ref.snapshotId ?? null,
    };
  }
  const pointId = pointIdFromHysteresisExplorerNode(selection.nodeId, stageId);
  if (pointId == null) {
    return null;
  }
  return {
    fieldValueMt: null,
    pointId,
    snapshotId: null,
  };
}

export function activeHysteresisBranchSelection(
  selection: Selection,
  stageId: string | null | undefined,
): ActiveHysteresisBranchSelection | null {
  if (!stageId || !selection.nodeId?.includes(`:${stageId}:branches:`)) {
    return null;
  }
  if (selection.nodeId.endsWith(":branches:forward")) {
    return { branchId: null, kind: "branch", requestedRole: "forward" };
  }
  if (selection.nodeId.endsWith(":branches:return")) {
    return { branchId: null, kind: "branch", requestedRole: "return" };
  }
  if (selection.nodeId.endsWith(":branches:minor-loops")) {
    return { kind: "minor-loops" };
  }
  const ref = selection.ref;
  if (
    ref?.type === "study-stage" &&
    ref.stageId === stageId &&
    ref.hysteresisExecutionNodeKind === "branch"
  ) {
    return {
      branchId: branchIdFromExecutionNodeId(ref.hysteresisExecutionNodeId),
      kind: "branch",
      requestedRole: null,
    };
  }
  const branchId = branchIdFromExplorerNodeId(selection.nodeId, stageId);
  if (branchId) {
    return { branchId, kind: "branch", requestedRole: null };
  }
  return null;
}

export function activeHysteresisExecutionNodeSelection(
  selection: Selection,
  stageId: string | null | undefined,
): ActiveHysteresisExecutionNodeSelection | null {
  const ref = selection.ref;
  if (
    ref?.type !== "study-stage" ||
    ref.kind !== "study.stage.action" ||
    ref.stageId !== stageId ||
    !ref.hysteresisExecutionNodeId
  ) {
    return null;
  }
  return {
    nodeId: ref.hysteresisExecutionNodeId,
    nodeKind: ref.hysteresisExecutionNodeKind ?? null,
    pointId: ref.hysteresisPointId ?? null,
    resourceRef: ref.resourceRef ?? null,
  };
}

export function activeHysteresisExecutionNodeSelectionEquals(
  left: ActiveHysteresisExecutionNodeSelection | null,
  right: ActiveHysteresisExecutionNodeSelection | null,
): boolean {
  return (
    left?.nodeId === right?.nodeId &&
    left?.nodeKind === right?.nodeKind &&
    left?.pointId === right?.pointId &&
    left?.resourceRef === right?.resourceRef
  );
}

export function findHysteresisExecutionTreeNode(
  nodes: readonly HysteresisExecutionTreeNode[],
  selection: ActiveHysteresisExecutionNodeSelection | null,
): HysteresisExecutionTreeNode | null {
  if (!selection?.nodeId) return null;
  for (const node of nodes) {
    if (node.node_id === selection.nodeId) {
      return node;
    }
    const child = findHysteresisExecutionTreeNode(node.children ?? [], selection);
    if (child) {
      return child;
    }
  }
  return null;
}

export function activeHysteresisBranchSelectionEquals(
  left: ActiveHysteresisBranchSelection | null,
  right: ActiveHysteresisBranchSelection | null,
): boolean {
  return (
    left?.kind === right?.kind &&
    branchRequestedRole(left) === branchRequestedRole(right) &&
    branchSelectionId(left) === branchSelectionId(right)
  );
}

function branchRequestedRole(selection: ActiveHysteresisBranchSelection | null): string | null {
  return selection?.kind === "branch" ? selection.requestedRole : null;
}

function branchSelectionId(selection: ActiveHysteresisBranchSelection | null): string | null {
  return selection?.kind === "branch" ? selection.branchId : null;
}

function branchIdFromExecutionNodeId(value: string | null | undefined): string | null {
  if (!value) return null;
  const parts = value.split(":").filter(Boolean);
  return parts.at(-1) ?? value;
}

function branchIdFromExplorerNodeId(
  nodeId: string | null | undefined,
  stageId: string,
): string | null {
  const marker = `:${stageId}:branches:branch:`;
  const markerIndex = nodeId?.indexOf(marker) ?? -1;
  if (markerIndex < 0 || !nodeId) return null;
  const branchId = nodeId.slice(markerIndex + marker.length).split(":")[0];
  return branchId || null;
}

export function activeHysteresisPointSelectionEquals(
  left: ActiveHysteresisPointSelection | null,
  right: ActiveHysteresisPointSelection | null,
): boolean {
  return (
    left?.snapshotId === right?.snapshotId &&
    left?.pointId === right?.pointId &&
    left?.fieldValueMt === right?.fieldValueMt
  );
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

function pointIdFromHysteresisExplorerNode(
  nodeId: string | null | undefined,
  stageId: string,
): number | null {
  if (!nodeId || !nodeId.includes(`:${stageId}:`)) {
    return null;
  }
  const match = nodeId.match(/:field-point:(\d+)(?::|$)/);
  if (!match) {
    return null;
  }
  const pointId = Number.parseInt(match[1], 10);
  return Number.isFinite(pointId) ? pointId : null;
}

export function hysteresisInitialStateActionPresentation(
  snapshotId: string | null | undefined,
  snapshotStorageStatus?: string | null,
  snapshotStorageReason?: string | null,
): {
  disabled: boolean;
  title: string;
} {
  if (!snapshotId) {
    return {
      disabled: true,
      title: "Snapshot not saved for this point",
    };
  }
  if (snapshotStorageStatus === "missing") {
    return {
      disabled: true,
      title: missingSnapshotPayloadTitle(snapshotStorageReason),
    };
  }
  return {
    disabled: false,
    title: "Use point magnetization as the initial state for the selected or only object",
  };
}

export function hysteresisReplayActionPresentation(
  snapshotId: string | null | undefined,
  snapshotStorageStatus?: string | null,
  snapshotStorageReason?: string | null,
): {
  disabled: boolean;
  title: string;
} {
  if (!snapshotId) {
    return {
      disabled: true,
      title: "Snapshot not saved for this point",
    };
  }
  if (snapshotStorageStatus === "missing") {
    return {
      disabled: true,
      title: missingSnapshotPayloadTitle(snapshotStorageReason),
    };
  }
  return {
    disabled: false,
    title: "Load point magnetization in 3D viewport",
  };
}

function missingSnapshotPayloadTitle(reason?: string | null): string {
  return reason
    ? `Snapshot payload is missing for this point: ${reason}`
    : "Snapshot payload is missing for this point";
}
