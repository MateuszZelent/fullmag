/**
 * P2 — Viewport Interaction State
 *
 * ADR-002: Viewport has exclusive Camera or Manipulate mode.
 * Camera mode: orbit/pan/zoom active, gizmo hidden.
 * Manipulate mode: gizmo active, camera controls disabled.
 *
 * ADR-004: Transform tool is separate from viewport mode.
 */

import type { SelectionTarget } from "./selection";

// ── Viewport mode ─────────────────────────────────────────────

export type ViewportMode = "camera" | "manipulate";

// ── Transform tool ────────────────────────────────────────────

export type TransformTool = "select" | "move" | "rotate" | "scale";

// ── Transform scope ───────────────────────────────────────────

export type TransformScope = "object" | "magnetization_texture" | "work_plane" | "mesh_local";

// ── Transform space ───────────────────────────────────────────

export type TransformSpace = "world" | "local" | "view";

// ── Pivot mode ────────────────────────────────────────────────

export type PivotMode = "object_origin" | "selection_center" | "texture_pivot" | "custom";

// ── Active drag ───────────────────────────────────────────────

export interface ActiveDrag {
  target: SelectionTarget;
  tool: TransformTool;
  scope: TransformScope;
  startedAt: number;
  draftTransform: {
    translation: [number, number, number];
    rotationQuat: [number, number, number, number];
    scale: [number, number, number];
  };
}

// ── Snapping ──────────────────────────────────────────────────

export interface SnappingConfig {
  enabled: boolean;
  translateStep: number | null;
  rotateStepDeg: number | null;
  scaleStep: number | null;
}

// ── Viewport interaction state ────────────────────────────────

export interface ViewportInteractionState {
  mode: ViewportMode;
  tool: TransformTool;
  scope: TransformScope | null;
  transformSpace: TransformSpace;
  pivotMode: PivotMode;
  target: SelectionTarget | null;
  gizmoVisible: boolean;
  orbitControlsEnabled: boolean;
  transformControlsEnabled: boolean;
  snapping: SnappingConfig;
  activeDrag: ActiveDrag | null;
}

export const DEFAULT_VIEWPORT_INTERACTION: ViewportInteractionState = {
  mode: "camera",
  tool: "select",
  scope: null,
  transformSpace: "world",
  pivotMode: "object_origin",
  target: null,
  gizmoVisible: false,
  orbitControlsEnabled: true,
  transformControlsEnabled: false,
  snapping: {
    enabled: false,
    translateStep: null,
    rotateStepDeg: null,
    scaleStep: null,
  },
  activeDrag: null,
};

// ── Mode transition helpers ───────────────────────────────────

export function setViewportMode(state: ViewportInteractionState, mode: ViewportMode): ViewportInteractionState {
  if (mode === "camera") {
    return {
      ...state,
      mode: "camera",
      gizmoVisible: false,
      orbitControlsEnabled: true,
      transformControlsEnabled: false,
      activeDrag: null,
    };
  }
  // manipulate
  return {
    ...state,
    mode: "manipulate",
    gizmoVisible: state.target !== null,
    orbitControlsEnabled: false,
    transformControlsEnabled: true,
  };
}

export function setTransformTool(state: ViewportInteractionState, tool: TransformTool): ViewportInteractionState {
  if (tool === "select") {
    return {
      ...state,
      tool: "select",
      gizmoVisible: false,
    };
  }
  // Move/Rotate/Scale → auto-switch to manipulate
  const next = state.mode === "camera" ? setViewportMode(state, "manipulate") : state;
  return {
    ...next,
    tool,
    gizmoVisible: next.target !== null,
  };
}

export function setTransformScope(state: ViewportInteractionState, scope: TransformScope | null): ViewportInteractionState {
  return { ...state, scope };
}

export function startDrag(state: ViewportInteractionState, drag: ActiveDrag): ViewportInteractionState {
  return { ...state, activeDrag: drag };
}

export function commitDrag(state: ViewportInteractionState): ViewportInteractionState {
  return { ...state, activeDrag: null };
}

export function cancelDrag(state: ViewportInteractionState): ViewportInteractionState {
  return { ...state, activeDrag: null };
}
