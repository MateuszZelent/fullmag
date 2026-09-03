/**
 * Layer D: Viewport Core – Interaction Mode Types
 *
 * Clear state machine for viewport interaction.
 * One arbiter decides what pointer events do.
 */

export type InteractionMode =
  | "camera-navigate"
  | "selection-click"
  | "selection-hover"
  | "gizmo-translate"
  | "gizmo-rotate"
  | "gizmo-scale"
  | "lasso-select"
  | "inspect-only"
  | "disabled";

export interface InteractionState {
  mode: InteractionMode;
  /** Transient hover target */
  hoverTarget: ViewportHoverTarget | null;
  /** Active gizmo axis (during transform) */
  gizmoActiveAxis: "x" | "y" | "z" | null;
  /** Drag in progress */
  isDragging: boolean;
}

export interface ViewportHoverTarget {
  type: "mesh-part" | "face" | "node" | "object" | "antenna" | "none";
  id: string | null;
  faceIndex: number | null;
  position: [number, number, number] | null;
}
