/**
 * P6 — Run Gate
 *
 * Derives run/relax availability from the DirtyGraphState.
 * Shows explicit blockers with recommended actions.
 * R8: UI must show WHY run is blocked, not just that it is.
 */

import type { DirtyGraphState, ArtifactStatus } from "./dirtyGraph";

// ── Run blocker ───────────────────────────────────────────────

export interface RunBlocker {
  id: string;
  severity: "error" | "warning";
  title: string;
  message: string;
  action?: {
    label: string;
    commandId: string;
    args?: Record<string, unknown>;
  };
}

// ── Run gate state ────────────────────────────────────────────

export interface RunGateState {
  canRelax: boolean;
  canRun: boolean;
  blockers: RunBlocker[];
}

export const EMPTY_RUN_GATE: RunGateState = {
  canRelax: false,
  canRun: false,
  blockers: [],
};

// ── Derive run gate from dirty graph ──────────────────────────

export function deriveRunGate(dirtyGraph: DirtyGraphState): RunGateState {
  const blockers: RunBlocker[] = [];

  // Geometry must be valid (always true after commit)
  // but we check for missing airbox/mesh

  if (dirtyGraph.mesh.status === "missing") {
    blockers.push({
      id: "mesh.missing",
      severity: "error",
      title: "Mesh missing",
      message: "No mesh has been built. Build the mesh before running.",
      action: { label: "Build Mesh", commandId: "mesh.build.all" },
    });
  } else if (dirtyGraph.mesh.status === "stale") {
    blockers.push({
      id: "mesh.stale",
      severity: "error",
      title: "Mesh is stale",
      message: dirtyGraph.mesh.reason ?? "Geometry was modified after the last mesh build.",
      action: { label: "Build Mesh", commandId: "mesh.build.all" },
    });
  } else if (dirtyGraph.mesh.status === "building") {
    blockers.push({
      id: "mesh.building",
      severity: "warning",
      title: "Mesh is being built",
      message: "Wait for the mesh build to complete.",
    });
  } else if (dirtyGraph.mesh.status === "error") {
    blockers.push({
      id: "mesh.error",
      severity: "error",
      title: "Mesh build failed",
      message: dirtyGraph.mesh.reason ?? "The last mesh build failed.",
      action: { label: "Retry Build Mesh", commandId: "mesh.build.all" },
    });
  }

  if (dirtyGraph.initialState.status === "missing") {
    blockers.push({
      id: "initialState.missing",
      severity: "error",
      title: "Initial magnetization missing",
      message: "Initial magnetization has not been realized on the mesh.",
      action: { label: "Realize Initial State", commandId: "field.realizeInitialState" },
    });
  } else if (dirtyGraph.initialState.status === "stale") {
    blockers.push({
      id: "initialState.stale",
      severity: "error",
      title: "Initial magnetization is stale",
      message: dirtyGraph.initialState.reason ?? "Magnetization settings changed and must be realized on the current mesh.",
      action: { label: "Realize Initial State", commandId: "field.realizeInitialState" },
    });
  } else if (dirtyGraph.initialState.status === "building") {
    blockers.push({
      id: "initialState.building",
      severity: "warning",
      title: "Initial state is being realized",
      message: "Wait for the initial state realization to complete.",
    });
  } else if (dirtyGraph.initialState.status === "error") {
    blockers.push({
      id: "initialState.error",
      severity: "error",
      title: "Initial state realization failed",
      message: dirtyGraph.initialState.reason ?? "The last initial state realization failed.",
      action: { label: "Retry Realize", commandId: "field.realizeInitialState" },
    });
  }

  if (dirtyGraph.airbox.status === "stale" || dirtyGraph.airbox.status === "error") {
    blockers.push({
      id: "airbox.stale",
      severity: "error",
      title: "Airbox is stale",
      message: dirtyGraph.airbox.reason ?? "Airbox configuration needs rebuilding.",
      action: { label: "Build Mesh", commandId: "mesh.build.all" },
    });
  }

  // Results warnings (non-blocking)
  if (dirtyGraph.results.status === "stale") {
    blockers.push({
      id: "results.stale",
      severity: "warning",
      title: "Results are stale",
      message: dirtyGraph.results.reason ?? "Previous results do not match the current model configuration.",
    });
  }

  const hasError = blockers.some((b) => b.severity === "error");

  return {
    canRelax: !hasError,
    canRun: !hasError,
    blockers,
  };
}

// ── Builder-aware run gate extension ──────────────────────────

/**
 * Extended run gate that also checks geometry builder state.
 * Called from components that have access to both stores.
 */
export function extendRunGateWithBuilder(
  base: RunGateState,
  builder: {
    active: boolean;
    geometryDraftDirty: boolean;
    geometryRealizationDirty: boolean;
    meshDirty: boolean;
    hasValidationErrors: boolean;
  },
): RunGateState {
  if (!builder.active) return base;

  const blockers = [...base.blockers];

  if (builder.hasValidationErrors) {
    blockers.push({
      id: "builder.validation",
      severity: "error",
      title: "Geometry placement errors",
      message: "One or more primitives have placement errors. Fix them before running.",
      action: { label: "Validate", commandId: "builder.validate-geometry" },
    });
  }

  if (builder.geometryRealizationDirty) {
    blockers.push({
      id: "builder.geometry.stale",
      severity: "error",
      title: "Builder geometry not built",
      message: "Geometry has been modified. Build geometry before running.",
      action: { label: "Build Geometry", commandId: "builder.build-geometry" },
    });
  }

  if (builder.meshDirty) {
    blockers.push({
      id: "builder.mesh.stale",
      severity: "error",
      title: "Builder mesh out of date",
      message: "Geometry changed since last mesh build. Rebuild mesh before running.",
      action: { label: "Build Mesh", commandId: "builder.build-mesh" },
    });
  }

  const hasError = blockers.some((b) => b.severity === "error");
  return {
    canRelax: !hasError,
    canRun: !hasError,
    blockers,
  };
}
