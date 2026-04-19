/**
 * P3/P4 — Magnetization Commands
 *
 * Commands for magnetization authoring workflow.
 * ADR-003: Inspector edits draft, Apply commits transaction.
 */

import type { CommandDefinition } from "./commandRegistry";
import { registerCommand } from "./commandRegistry";

// ── magnetization.apply ───────────────────────────────────────

const magnetizationApply: CommandDefinition = {
  id: "magnetization.apply",
  label: "Apply Magnetization",
  icon: "check",
  group: "magnetization",
  isVisible: (ctx) => ctx.selection.target.kind === "magnetization_asset",
  getState: (ctx) => ({
    enabled: ctx.selection.target.kind === "magnetization_asset",
    reason: ctx.selection.target.kind !== "magnetization_asset"
      ? "Select a magnetization asset to apply changes"
      : undefined,
  }),
  execute: async () => {
    // Actual apply is handled by the magnetization inspector panel
    // which calls the authoring store. This command provides
    // the registry entry for Ribbon/shortcut binding.
  },
};

// ── magnetization.revert ──────────────────────────────────────

const magnetizationRevert: CommandDefinition = {
  id: "magnetization.revert",
  label: "Revert Magnetization",
  icon: "undo",
  group: "magnetization",
  isVisible: (ctx) => ctx.selection.target.kind === "magnetization_asset",
  getState: (ctx) => ({
    enabled: ctx.selection.target.kind === "magnetization_asset",
  }),
  execute: async () => {
    // Handled by inspector panel
  },
};

// ── magnetization.preset.uniform ──────────────────────────────

const magnetizationPresetUniform: CommandDefinition = {
  id: "magnetization.preset.uniform",
  label: "Uniform",
  icon: "arrow-right",
  group: "magnetization",
  isVisible: (ctx) => ctx.selection.target.kind === "magnetization_asset",
  getState: () => ({ enabled: true }),
  execute: async () => {
    // Sets preset kind in draft
  },
};

// ── magnetization.preset.random ───────────────────────────────

const magnetizationPresetRandom: CommandDefinition = {
  id: "magnetization.preset.random",
  label: "Random Seeded",
  icon: "shuffle",
  group: "magnetization",
  isVisible: (ctx) => ctx.selection.target.kind === "magnetization_asset",
  getState: () => ({ enabled: true }),
  execute: async () => {
    // Sets preset kind in draft
  },
};

// ── magnetization.resample-initial-state ──────────────────────

const magnetizationResample: CommandDefinition = {
  id: "magnetization.resample-initial-state",
  label: "Realize Initial State",
  icon: "refresh",
  group: "magnetization",
  isVisible: (ctx) =>
    ctx.selection.target.kind === "magnetization_asset" ||
    ctx.dirtyGraph.initialState.status === "stale",
  getState: (ctx) => ({
    enabled: ctx.dirtyGraph.mesh.status === "valid" && ctx.dirtyGraph.initialState.status !== "building",
    reason: ctx.dirtyGraph.mesh.status !== "valid"
      ? "Build mesh first"
      : ctx.dirtyGraph.initialState.status === "building"
        ? "Realization in progress"
        : undefined,
  }),
  execute: async () => {
    // Triggers field realization pipeline
  },
};

// ── Register all ──────────────────────────────────────────────

export function registerMagnetizationCommands(): void {
  registerCommand(magnetizationApply);
  registerCommand(magnetizationRevert);
  registerCommand(magnetizationPresetUniform);
  registerCommand(magnetizationPresetRandom);
  registerCommand(magnetizationResample);
}
