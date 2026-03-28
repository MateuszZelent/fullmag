"use client";

import { useEffect } from "react";
import { useControlRoom } from "../components/runs/control-room/ControlRoomContext";

/**
 * useKeyboardShortcuts — global keyboard shortcut handler for the control room.
 *
 * Shortcuts:
 * - F5 / Ctrl+Enter  → Run simulation
 * - Shift+F5         → Stop simulation
 * - Ctrl+B           → Toggle sidebar
 * - 1                → 3D view
 * - 2                → 2D view
 * - 3                → Mesh view
 * - Ctrl+Shift+P     → Toggle solver setup
 */
export function useKeyboardShortcuts() {
  const ctx = useControlRoom();

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
        ctx.handleSimulationAction("run");
        return;
      }

      /* Shift+F5 → Stop */
      if (e.key === "F5" && shift) {
        e.preventDefault();
        ctx.handleSimulationAction("stop");
        return;
      }

      /* Ctrl+Enter → Run */
      if (e.key === "Enter" && ctrl) {
        e.preventDefault();
        ctx.handleSimulationAction("run");
        return;
      }

      /* Ctrl+B → Toggle sidebar */
      if (e.key === "b" && ctrl) {
        e.preventDefault();
        ctx.setSidebarCollapsed((v: boolean) => !v);
        return;
      }

      /* 1/2/3 → View modes */
      if (e.key === "1" && !ctrl) { e.preventDefault(); ctx.handleViewModeChange("3D"); return; }
      if (e.key === "2" && !ctrl) { e.preventDefault(); ctx.handleViewModeChange("2D"); return; }
      if (e.key === "3" && !ctrl) { e.preventDefault(); ctx.handleViewModeChange("Mesh"); return; }

      /* Ctrl+Shift+P → Solver setup */
      if (e.key === "P" && ctrl && shift) {
        e.preventDefault();
        ctx.setSolverSetupOpen((v: boolean) => !v);
        return;
      }
    }

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [ctx]);
}
