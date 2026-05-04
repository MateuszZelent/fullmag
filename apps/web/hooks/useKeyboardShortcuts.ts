"use client";

import { useEffect } from "react";
import { useCommand, useViewport, useModel } from "../components/runs/control-room/ControlRoomContext";
import { useVisualizationStore, selectMeshRenderMode } from "@/features/visualization";
import { visualizationPatchForRenderMode } from "@/components/runs/control-room/visualizationStateSync";

/**
 * useKeyboardShortcuts — global keyboard shortcut handler for the control room.
 *
 * Shortcuts:
 * - F5 / Ctrl+Enter  → Run simulation
 * - Shift+F5         → Stop simulation
 * - Ctrl+B           → Toggle sidebar
 * - Ctrl+S           → Save session
 * - Ctrl+O           → Open session
 * - 1                → 3D view
 * - 2                → 2D view
 * - Ctrl+Shift+P     → Toggle solver setup
 * - I                → Toggle isolate/context mode
 * - H                → Show all (exit isolate + reset visibility)
 * - Z                → Cycle render mode (surface → surface+edges → wireframe → points)
 */
export interface KeyboardShortcutCallbacks {
  onSaveSession?: () => void;
  onOpenSession?: () => void;
  onResetView?: () => void;
  onFrameSelection?: () => void;
}

export function useKeyboardShortcuts(callbacks?: KeyboardShortcutCallbacks) {
  const { handleSimulationAction } = useCommand();
  const { handleViewModeChange, patchDisplay, setSidebarCollapsed } = useViewport();
  const { setSelectedSidebarNodeId, setObjectViewMode } = useModel();
  const meshRenderMode = useVisualizationStore(selectMeshRenderMode);

  useEffect(() => {
    function handler(e: KeyboardEvent) {
      /* Ignore when typing in inputs */
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;

      /* F5 → Run */
      if (e.key === "F5" && !shift && !ctrl) {
        e.preventDefault();
        handleSimulationAction("run");
        return;
      }

      /* Shift+F5 → Stop */
      if (e.key === "F5" && shift) {
        e.preventDefault();
        handleSimulationAction("stop");
        return;
      }

      /* Ctrl+Enter → Run */
      if (e.key === "Enter" && ctrl) {
        e.preventDefault();
        handleSimulationAction("run");
        return;
      }

      /* Ctrl+S → Save session */
      if (e.key === "s" && ctrl && !shift) {
        e.preventDefault();
        callbacks?.onSaveSession?.();
        return;
      }

      /* Ctrl+O → Open session */
      if (e.key === "o" && ctrl && !shift) {
        e.preventDefault();
        callbacks?.onOpenSession?.();
        return;
      }

      /* Ctrl+B → Toggle sidebar */
      if (e.key === "b" && ctrl) {
        e.preventDefault();
        setSidebarCollapsed((v: boolean) => !v);
        return;
      }

      /* 1/2 → View modes */
      if (e.key === "1" && !ctrl) { e.preventDefault(); handleViewModeChange("3D"); return; }
      if (e.key === "2" && !ctrl) { e.preventDefault(); handleViewModeChange("2D"); return; }

      /* Ctrl+Shift+P → Solver setup */
      if (e.key === "P" && ctrl && shift) {
        e.preventDefault();
        setSelectedSidebarNodeId("study-integrator");
        return;
      }

      /* I → Toggle isolate/context */
      if (e.key === "i" && !ctrl && !shift) {
        e.preventDefault();
        setObjectViewMode((mode) => (mode === "isolate" ? "context" : "isolate"));
        return;
      }

      /* H → Show all (exit isolate) */
      if (e.key === "h" && !ctrl && !shift) {
        e.preventDefault();
        setObjectViewMode("context");
        return;
      }

      /* Z → Cycle render mode (FEM) */
      if (e.key === "z" && !ctrl && !shift) {
        e.preventDefault();
        const cycle: Array<"surface" | "surface+edges" | "wireframe" | "mesh" | "points"> = [
          "surface", "surface+edges", "wireframe", "mesh", "points",
        ];
        const idx = cycle.indexOf(meshRenderMode);
        void patchDisplay(visualizationPatchForRenderMode(cycle[(idx + 1) % cycle.length]));
        return;
      }

      /* Home → Reset view */
      if (e.key === "Home" && !ctrl && !shift) {
        e.preventDefault();
        callbacks?.onResetView?.();
        return;
      }

      /* F → Frame selection */
      if (e.key === "f" && !ctrl && !shift) {
        e.preventDefault();
        callbacks?.onFrameSelection?.();
        return;
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    callbacks,
    handleSimulationAction,
    handleViewModeChange,
    meshRenderMode,
    patchDisplay,
    setObjectViewMode,
    setSelectedSidebarNodeId,
    setSidebarCollapsed,
  ]);
}
