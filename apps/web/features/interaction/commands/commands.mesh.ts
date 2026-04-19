/**
 * P3/P6 — Mesh Commands
 *
 * Commands for mesh build and field realization.
 * ADR-004: Geometry changes invalidate mesh; mesh build is explicit.
 */

import type { CommandDefinition } from "./commandRegistry";
import { registerCommand } from "./commandRegistry";

// ── mesh.build.selected ───────────────────────────────────────

const meshBuildSelected: CommandDefinition = {
  id: "mesh.build.selected",
  label: "Build Mesh (Selected)",
  icon: "mesh",
  group: "mesh",
  isVisible: (ctx) =>
    ctx.selection.target.kind === "mesh_domain" ||
    ctx.selection.target.kind === "object",
  getState: (ctx) => ({
    enabled: ctx.dirtyGraph.mesh.status !== "building",
    reason: ctx.dirtyGraph.mesh.status === "building" ? "Mesh build in progress" : undefined,
  }),
  execute: async () => {
    // Triggers mesh build for selected scope
  },
};

// ── mesh.build.all ────────────────────────────────────────────

const meshBuildAll: CommandDefinition = {
  id: "mesh.build.all",
  label: "Build Mesh",
  icon: "mesh",
  group: "mesh",
  isVisible: () => true,
  getState: (ctx) => ({
    enabled:
      ctx.dirtyGraph.mesh.status !== "building" &&
      (ctx.dirtyGraph.mesh.status === "missing" ||
        ctx.dirtyGraph.mesh.status === "stale" ||
        ctx.dirtyGraph.mesh.status === "error"),
    reason:
      ctx.dirtyGraph.mesh.status === "building"
        ? "Mesh build in progress"
        : ctx.dirtyGraph.mesh.status === "valid"
          ? "Mesh is up to date"
          : undefined,
    badge: ctx.dirtyGraph.mesh.status === "stale" ? "STALE" : undefined,
  }),
  execute: async () => {
    // Triggers final shared domain mesh build
  },
};

// ── mesh.show-stale-ghost.toggle ──────────────────────────────

const meshShowStaleGhost: CommandDefinition = {
  id: "mesh.show-stale-ghost.toggle",
  label: "Show Stale Mesh Ghost",
  icon: "ghost",
  group: "mesh",
  isVisible: (ctx) =>
    ctx.dirtyGraph.mesh.status === "stale" && ctx.dirtyGraph.mesh.lastValidRevision !== null,
  getState: () => ({
    enabled: true,
  }),
  execute: async () => {
    // Toggles stale mesh ghost overlay
  },
};

// ── field.realizeInitialState ─────────────────────────────────

const fieldRealizeInitialState: CommandDefinition = {
  id: "field.realizeInitialState",
  label: "Realize Initial State",
  icon: "sample",
  group: "field",
  isVisible: () => true,
  getState: (ctx) => ({
    enabled:
      ctx.dirtyGraph.mesh.status === "valid" &&
      ctx.dirtyGraph.initialState.status !== "building" &&
      (ctx.dirtyGraph.initialState.status === "missing" ||
        ctx.dirtyGraph.initialState.status === "stale"),
    reason:
      ctx.dirtyGraph.mesh.status !== "valid"
        ? "Build mesh first"
        : ctx.dirtyGraph.initialState.status === "building"
          ? "Realization in progress"
          : ctx.dirtyGraph.initialState.status === "valid"
            ? "Initial state is up to date"
            : undefined,
    badge: ctx.dirtyGraph.initialState.status === "stale" ? "STALE" : undefined,
  }),
  execute: async () => {
    // Triggers initial state realization
  },
};

// ── Register all ──────────────────────────────────────────────

export function registerMeshCommands(): void {
  registerCommand(meshBuildSelected);
  registerCommand(meshBuildAll);
  registerCommand(meshShowStaleGhost);
  registerCommand(fieldRealizeInitialState);
}
