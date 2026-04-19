/**
 * P2 — Camera Command
 *
 * ADR-001: Camera changes are only triggered by explicit commands,
 * never as a side-effect of selection.
 *
 * Camera commands are one-shot: they are dispatched, consumed by the
 * viewport camera controller, and cleared.
 */

import type { SelectionTarget } from "./selection";

// ── Camera command ────────────────────────────────────────────

export type CameraCommand =
  | { kind: "focus_target"; target: SelectionTarget; animated: boolean; requestId: string }
  | { kind: "focus_selection"; animated: boolean; requestId: string }
  | { kind: "fit_all"; animated: boolean; requestId: string }
  | { kind: "view_axis"; axis: "+x" | "-x" | "+y" | "-y" | "+z" | "-z"; requestId: string }
  | { kind: "reset_view"; requestId: string };

// ── Camera command state ──────────────────────────────────────

export interface CameraCommandState {
  pending: CameraCommand | null;
  lastConsumedId: string | null;
}

export const EMPTY_CAMERA_COMMAND: CameraCommandState = {
  pending: null,
  lastConsumedId: null,
};

// ── Helpers ───────────────────────────────────────────────────

let nextCameraRequestId = 1;

export function createCameraRequestId(): string {
  return `cam-${nextCameraRequestId++}-${Date.now()}`;
}

export function dispatchCameraCommand(
  state: CameraCommandState,
  command: CameraCommand,
): CameraCommandState {
  return { ...state, pending: command };
}

export function consumeCameraCommand(
  state: CameraCommandState,
): CameraCommandState {
  return {
    pending: null,
    lastConsumedId: state.pending?.requestId ?? state.lastConsumedId,
  };
}
