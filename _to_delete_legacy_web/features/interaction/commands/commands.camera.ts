/**
 * P3 — Camera & Selection Commands
 *
 * Commands for selection management and camera focus.
 * ADR-001: Focus is an explicit command, never a selection side-effect.
 */

import type { CommandDefinition } from "./commandRegistry";
import { registerCommand } from "./commandRegistry";
import { isTargetSpatial } from "../model/selection";
import { useInteractionStore } from "../store/useInteractionStore";

// ── selection.clear ───────────────────────────────────────────

const selectionClear: CommandDefinition = {
  id: "selection.clear",
  label: "Clear Selection",
  group: "selection",
  shortcut: "Escape",
  isVisible: () => true,
  getState: (ctx) => ({
    enabled: ctx.selection.target.kind !== "workspace",
  }),
  execute: () => {
    useInteractionStore.getState().clearSelection();
  },
};

// ── selection.focus ───────────────────────────────────────────

const selectionFocus: CommandDefinition = {
  id: "selection.focus",
  label: "Focus in 3D",
  icon: "focus",
  group: "selection",
  shortcut: "F",
  isVisible: (ctx) => isTargetSpatial(ctx.selection.target),
  getState: (ctx) => ({
    enabled: isTargetSpatial(ctx.selection.target),
    reason: isTargetSpatial(ctx.selection.target) ? undefined : "Select a spatial object to focus",
  }),
  execute: (ctx) => {
    useInteractionStore.getState().focusTarget(ctx.selection.target, true);
  },
};

// ── selection.fit-all ─────────────────────────────────────────

const selectionFitAll: CommandDefinition = {
  id: "selection.fit-all",
  label: "Fit All",
  icon: "fit-all",
  group: "selection",
  isVisible: () => true,
  getState: () => ({ enabled: true }),
  execute: () => {
    useInteractionStore.getState().fitAll(true);
  },
};

// ── Register all ──────────────────────────────────────────────

export function registerCameraCommands(): void {
  registerCommand(selectionClear);
  registerCommand(selectionFocus);
  registerCommand(selectionFitAll);
}
