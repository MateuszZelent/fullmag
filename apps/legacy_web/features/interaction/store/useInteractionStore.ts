/**
 * P2 — Interaction Store
 *
 * Zustand store that owns:
 * - SelectionState (typed selection target, origin, objectId)
 * - ViewportInteractionState (camera/manipulate mode, tool, scope)
 * - CameraCommandState (pending one-shot camera commands)
 *
 * This is the single source of truth for interaction-level state.
 * Components subscribe to narrow selectors to avoid unnecessary rerenders.
 */

import { create } from "zustand";
import type { SelectionTarget, SelectionOrigin, SelectionState } from "../model/selection";
import { EMPTY_SELECTION, objectIdFromTarget, assetIdFromTarget, parseNodeIdToTarget } from "../model/selection";
import type { ViewportInteractionState, ViewportMode, TransformTool, TransformScope, ActiveDrag } from "../model/viewportInteraction";
import { DEFAULT_VIEWPORT_INTERACTION, setViewportMode, setTransformTool, setTransformScope, startDrag, commitDrag, cancelDrag } from "../model/viewportInteraction";
import type { CameraCommand, CameraCommandState } from "../model/cameraCommand";
import { EMPTY_CAMERA_COMMAND, createCameraRequestId, dispatchCameraCommand, consumeCameraCommand } from "../model/cameraCommand";
import { traceInteraction } from "../trace/interactionTrace";

// ── Store state ───────────────────────────────────────────────

export interface InteractionStoreState {
  // Selection
  selection: SelectionState;

  // Viewport interaction
  viewport: ViewportInteractionState;

  // Camera commands
  camera: CameraCommandState;

  // ── Selection actions ─────────────────────────────────────

  /** Select a target. Does NOT change camera. */
  select: (input: { nodeId?: string | null; target?: SelectionTarget; origin: SelectionOrigin }) => void;

  /** Clear selection. */
  clearSelection: () => void;

  // ── Camera actions (explicit only) ────────────────────────

  /** Focus camera on a specific target (explicit command). */
  focusTarget: (target: SelectionTarget, animated?: boolean) => void;

  /** Focus camera on current selection. */
  focusSelection: (animated?: boolean) => void;

  /** Fit camera to show all objects. */
  fitAll: (animated?: boolean) => void;

  /** View from a specific axis. */
  viewAxis: (axis: "+x" | "-x" | "+y" | "-y" | "+z" | "-z") => void;

  /** Mark pending camera command as consumed. */
  consumeCamera: () => void;

  // ── Viewport mode actions ─────────────────────────────────

  /** Switch viewport to Camera or Manipulate mode. */
  setMode: (mode: ViewportMode) => void;

  /** Set the active transform tool. */
  setTool: (tool: TransformTool) => void;

  /** Set the transform scope. */
  setScope: (scope: TransformScope | null) => void;

  // ── Drag actions ──────────────────────────────────────────

  /** Begin a gizmo drag. */
  beginDrag: (drag: ActiveDrag) => void;

  /** Commit a gizmo drag (mouse up). */
  endDrag: () => void;

  /** Cancel a gizmo drag (Escape). */
  abortDrag: () => void;
}

// ── Store creation ────────────────────────────────────────────

export const useInteractionStore = create<InteractionStoreState>((set, get) => ({
  selection: EMPTY_SELECTION,
  viewport: DEFAULT_VIEWPORT_INTERACTION,
  camera: EMPTY_CAMERA_COMMAND,

  // ── Selection ───────────────────────────────────────────────

  select: (input) => {
    const target = input.target ?? parseNodeIdToTarget(input.nodeId ?? null);
    const prevSelection = get().selection;

    const nextSelection: SelectionState = {
      nodeId: input.nodeId ?? prevSelection.nodeId,
      target,
      previousTarget: prevSelection.target,
      origin: input.origin,
      selectedObjectId: objectIdFromTarget(target),
      selectedAssetId: assetIdFromTarget(target),
      selectedMeshPartId: null,
      revision: prevSelection.revision + 1,
      selectedAt: Date.now(),
    };

    traceInteraction("tree.select", {
      nodeId: nextSelection.nodeId,
      targetKind: target.kind,
      origin: input.origin,
    });

    // Update viewport target for gizmo
    set((s) => ({
      selection: nextSelection,
      viewport: { ...s.viewport, target },
    }));
  },

  clearSelection: () => {
    traceInteraction("selection.clear", null);
    set((s) => ({
      selection: {
        ...EMPTY_SELECTION,
        previousTarget: s.selection.target,
        revision: s.selection.revision + 1,
      },
      viewport: { ...s.viewport, target: null, gizmoVisible: false },
    }));
  },

  // ── Camera (explicit only) ─────────────────────────────────

  focusTarget: (target, animated = true) => {
    const requestId = createCameraRequestId();
    traceInteraction("selection.focus", { target: target.kind, requestId });
    set((s) => ({
      camera: dispatchCameraCommand(s.camera, {
        kind: "focus_target",
        target,
        animated,
        requestId,
      }),
    }));
  },

  focusSelection: (animated = true) => {
    const requestId = createCameraRequestId();
    traceInteraction("viewport.camera.fit", { requestId });
    set((s) => ({
      camera: dispatchCameraCommand(s.camera, {
        kind: "focus_selection",
        animated,
        requestId,
      }),
    }));
  },

  fitAll: (animated = true) => {
    const requestId = createCameraRequestId();
    traceInteraction("viewport.camera.fit", { requestId, kind: "fit_all" });
    set((s) => ({
      camera: dispatchCameraCommand(s.camera, {
        kind: "fit_all",
        animated,
        requestId,
      }),
    }));
  },

  viewAxis: (axis) => {
    const requestId = createCameraRequestId();
    set((s) => ({
      camera: dispatchCameraCommand(s.camera, {
        kind: "view_axis",
        axis,
        requestId,
      }),
    }));
  },

  consumeCamera: () => {
    set((s) => ({
      camera: consumeCameraCommand(s.camera),
    }));
  },

  // ── Viewport mode ──────────────────────────────────────────

  setMode: (mode) => {
    traceInteraction("viewport.mode.change", { mode });
    set((s) => ({
      viewport: setViewportMode(s.viewport, mode),
    }));
  },

  setTool: (tool) => {
    traceInteraction("viewport.tool.change", { tool });
    set((s) => ({
      viewport: setTransformTool(s.viewport, tool),
    }));
  },

  setScope: (scope) => {
    set((s) => ({
      viewport: setTransformScope(s.viewport, scope),
    }));
  },

  // ── Drag ───────────────────────────────────────────────────

  beginDrag: (drag) => {
    traceInteraction("viewport.gizmo.drag.start", { tool: drag.tool, scope: drag.scope });
    set((s) => ({
      viewport: startDrag(s.viewport, drag),
    }));
  },

  endDrag: () => {
    traceInteraction("viewport.gizmo.drag.commit", null);
    set((s) => ({
      viewport: commitDrag(s.viewport),
    }));
  },

  abortDrag: () => {
    set((s) => ({
      viewport: cancelDrag(s.viewport),
    }));
  },
}));
