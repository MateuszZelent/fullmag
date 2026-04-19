/**
 * P5 — Interaction Controller
 *
 * Orchestrates the interaction store actions from external callers:
 * sidebar tree, viewport click, ribbon, keyboard shortcuts.
 *
 * This is the main integration point between the new interaction
 * model and the rest of the application. Components should call
 * these functions instead of reaching into multiple stores.
 */

import { useInteractionStore } from "../store/useInteractionStore";
import type { SelectionTarget, SelectionOrigin } from "../model/selection";
import { isTargetSpatial } from "../model/selection";
import type { TransformTool, ViewportMode } from "../model/viewportInteraction";
import { executeCommand } from "../commands/commandRegistry";

// ── Selection orchestration ───────────────────────────────────

/**
 * Handle sidebar tree node click.
 * - Updates selection to the clicked node.
 * - Does NOT move camera (ADR-001).
 */
export function handleTreeSelect(nodeId: string | null): void {
  const store = useInteractionStore.getState();
  if (!nodeId) {
    store.clearSelection();
    return;
  }
  store.select({ nodeId, origin: "tree" });
}

/**
 * Handle sidebar tree node double-click.
 * - Selects the node AND focuses camera on it (explicit).
 */
export function handleTreeDoubleClick(nodeId: string | null): void {
  const store = useInteractionStore.getState();
  if (!nodeId) return;
  store.select({ nodeId, origin: "tree" });
  // Focus only spatial targets
  const { selection } = useInteractionStore.getState();
  if (isTargetSpatial(selection.target)) {
    store.focusTarget(selection.target);
  }
}

/**
 * Handle viewport object click.
 * - Updates selection to the clicked object.
 * - Does NOT move camera.
 */
export function handleViewportSelect(
  target: SelectionTarget,
  origin: SelectionOrigin = "viewport",
): void {
  const store = useInteractionStore.getState();
  store.select({ target, origin });
}

/**
 * Handle viewport background click.
 * - Clears selection.
 */
export function handleViewportDeselect(): void {
  const store = useInteractionStore.getState();
  store.clearSelection();
}

// ── Camera orchestration ──────────────────────────────────────

/** Focus camera on current selection (F key). */
export function focusOnSelection(): void {
  const store = useInteractionStore.getState();
  const { selection } = store;
  if (isTargetSpatial(selection.target)) {
    store.focusSelection();
  }
}

/** Fit camera to all objects. */
export function fitCameraToAll(): void {
  useInteractionStore.getState().fitAll();
}

// ── Mode orchestration ────────────────────────────────────────

/** Switch to camera mode (C key). */
export function switchToCameraMode(): void {
  useInteractionStore.getState().setMode("camera");
}

/** Switch to manipulate mode (M key). */
export function switchToManipulateMode(): void {
  useInteractionStore.getState().setMode("manipulate");
}

/** Set the active transform tool. Auto-switches to manipulate mode. */
export function setActiveTool(tool: TransformTool): void {
  useInteractionStore.getState().setTool(tool);
}

// ── Command orchestration ─────────────────────────────────────

/**
 * Execute a registered command by ID.
 * This is the preferred way to invoke commands from
 * keyboard shortcuts, ribbon buttons, and context menus.
 *
 * Context is built automatically from the current store state.
 */
export async function runCommand(commandId: string, args?: unknown): Promise<void> {
  // When called without explicit context, executeCommand reads current store state.
  await executeCommand(commandId, args);
}
