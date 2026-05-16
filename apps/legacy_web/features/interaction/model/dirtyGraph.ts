/**
 * P6 — Dirty Graph
 *
 * Central dependency graph tracking artifact validity.
 * Each artifact has a status (missing/valid/stale/building/error)
 * and tracks which action caused it to become stale.
 *
 * ADR-004: Geometry changes invalidate mesh.
 * ADR-005: Magnetization changes do NOT invalidate mesh topology.
 */

// ── Artifact validity ─────────────────────────────────────────

export type ArtifactName = "geometry" | "airbox" | "mesh" | "initialState" | "study" | "results";

export type ArtifactStatus = "missing" | "valid" | "stale" | "building" | "error";

export interface ArtifactValidity {
  artifact: ArtifactName;
  status: ArtifactStatus;
  reason?: string;
  revision: string | null;
  dependsOn: ArtifactName[];
  causedByTransactionId?: string;
  causedByLabel?: string;
  lastValidRevision?: string | null;
}

// ── Dirty graph state ─────────────────────────────────────────

export interface DirtyGraphState {
  geometry: ArtifactValidity;
  airbox: ArtifactValidity;
  mesh: ArtifactValidity;
  initialState: ArtifactValidity;
  study: ArtifactValidity;
  results: ArtifactValidity;
}

export const INITIAL_DIRTY_GRAPH: DirtyGraphState = {
  geometry: { artifact: "geometry", status: "valid", revision: "0", dependsOn: [] },
  airbox: { artifact: "airbox", status: "missing", revision: null, dependsOn: ["geometry"] },
  mesh: { artifact: "mesh", status: "missing", revision: null, dependsOn: ["geometry", "airbox"] },
  initialState: { artifact: "initialState", status: "missing", revision: null, dependsOn: ["mesh"] },
  study: { artifact: "study", status: "valid", revision: "0", dependsOn: [] },
  results: { artifact: "results", status: "missing", revision: null, dependsOn: ["mesh", "initialState", "study"] },
};

// ── Invalidation actions ──────────────────────────────────────

export type DirtyGraphAction =
  | { type: "geometry.changed"; transactionId: string; label: string }
  | { type: "airbox.changed"; transactionId: string; label: string }
  | { type: "magnetization.changed"; transactionId: string; label: string }
  | { type: "material.changed"; transactionId: string; label: string }
  | { type: "physics.changed"; transactionId: string; label: string }
  | { type: "study.changed"; transactionId: string; label: string }
  | { type: "mesh.build.started" }
  | { type: "mesh.build.completed"; revision: string }
  | { type: "mesh.build.failed"; error: string }
  | { type: "initialState.realize.started" }
  | { type: "initialState.realize.completed"; revision: string }
  | { type: "initialState.realize.failed"; error: string }
  | { type: "results.run.started" }
  | { type: "results.run.completed"; revision: string }
  | { type: "results.run.failed"; error: string }
  | { type: "reset" };

// ── Reducer ───────────────────────────────────────────────────

let revisionCounter = 0;
function nextRevision(): string {
  return `rev-${++revisionCounter}`;
}

export function dirtyGraphReducer(state: DirtyGraphState, action: DirtyGraphAction): DirtyGraphState {
  switch (action.type) {
    case "geometry.changed": {
      const geoRevision = nextRevision();
      return {
        ...state,
        geometry: {
          ...state.geometry,
          status: "valid",
          revision: geoRevision,
          causedByTransactionId: action.transactionId,
          causedByLabel: action.label,
        },
        airbox: {
          ...state.airbox,
          status: "stale",
          reason: `Geometry changed: ${action.label}`,
          causedByTransactionId: action.transactionId,
          causedByLabel: action.label,
          lastValidRevision: state.airbox.revision,
        },
        mesh: {
          ...state.mesh,
          status: state.mesh.status === "missing" ? "missing" : "stale",
          reason: `Geometry changed: ${action.label}`,
          causedByTransactionId: action.transactionId,
          causedByLabel: action.label,
          lastValidRevision: state.mesh.revision,
        },
        initialState: {
          ...state.initialState,
          status: state.initialState.status === "missing" ? "missing" : "stale",
          reason: "Mesh is stale due to geometry change",
          causedByTransactionId: action.transactionId,
        },
        results: {
          ...state.results,
          status: state.results.status === "missing" ? "missing" : "stale",
          reason: "Geometry changed",
          causedByTransactionId: action.transactionId,
        },
      };
    }

    case "airbox.changed": {
      return {
        ...state,
        airbox: {
          ...state.airbox,
          status: "stale",
          reason: `Airbox configuration changed: ${action.label}`,
          causedByTransactionId: action.transactionId,
          lastValidRevision: state.airbox.revision,
        },
        mesh: {
          ...state.mesh,
          status: state.mesh.status === "missing" ? "missing" : "stale",
          reason: "Airbox changed",
          causedByTransactionId: action.transactionId,
          lastValidRevision: state.mesh.revision,
        },
        initialState: {
          ...state.initialState,
          status: state.initialState.status === "missing" ? "missing" : "stale",
          reason: "Mesh is stale due to airbox change",
        },
        results: {
          ...state.results,
          status: state.results.status === "missing" ? "missing" : "stale",
          reason: "Airbox changed",
        },
      };
    }

    case "magnetization.changed": {
      // ADR-005: Magnetization does NOT invalidate mesh topology
      return {
        ...state,
        initialState: {
          ...state.initialState,
          status: "stale",
          reason: `Magnetization changed: ${action.label}`,
          causedByTransactionId: action.transactionId,
          causedByLabel: action.label,
        },
        results: {
          ...state.results,
          status: state.results.status === "missing" ? "missing" : "stale",
          reason: "Magnetization changed",
          causedByTransactionId: action.transactionId,
        },
      };
    }

    case "material.changed": {
      return {
        ...state,
        initialState: {
          ...state.initialState,
          status: state.initialState.status === "missing" ? "missing" : "stale",
          reason: `Material changed: ${action.label}`,
          causedByTransactionId: action.transactionId,
        },
        results: {
          ...state.results,
          status: state.results.status === "missing" ? "missing" : "stale",
          reason: "Material changed",
          causedByTransactionId: action.transactionId,
        },
      };
    }

    case "physics.changed": {
      return {
        ...state,
        results: {
          ...state.results,
          status: state.results.status === "missing" ? "missing" : "stale",
          reason: `Physics changed: ${action.label}`,
          causedByTransactionId: action.transactionId,
        },
      };
    }

    case "study.changed": {
      return {
        ...state,
        study: {
          ...state.study,
          revision: nextRevision(),
          causedByTransactionId: action.transactionId,
        },
        results: {
          ...state.results,
          status: state.results.status === "missing" ? "missing" : "stale",
          reason: "Study configuration changed",
          causedByTransactionId: action.transactionId,
        },
      };
    }

    case "mesh.build.started": {
      return {
        ...state,
        mesh: { ...state.mesh, status: "building" },
        airbox: state.airbox.status === "stale"
          ? { ...state.airbox, status: "building" }
          : state.airbox,
      };
    }

    case "mesh.build.completed": {
      return {
        ...state,
        mesh: {
          ...state.mesh,
          status: "valid",
          revision: action.revision,
          reason: undefined,
          causedByTransactionId: undefined,
          causedByLabel: undefined,
          lastValidRevision: action.revision,
        },
        airbox: {
          ...state.airbox,
          status: "valid",
          revision: action.revision,
          reason: undefined,
          lastValidRevision: action.revision,
        },
        initialState: {
          ...state.initialState,
          status: "stale",
          reason: "New mesh built — initial state needs realization",
        },
      };
    }

    case "mesh.build.failed": {
      return {
        ...state,
        mesh: { ...state.mesh, status: "error", reason: action.error },
        airbox: state.airbox.status === "building"
          ? { ...state.airbox, status: "error", reason: action.error }
          : state.airbox,
      };
    }

    case "initialState.realize.started": {
      return {
        ...state,
        initialState: { ...state.initialState, status: "building" },
      };
    }

    case "initialState.realize.completed": {
      return {
        ...state,
        initialState: {
          ...state.initialState,
          status: "valid",
          revision: action.revision,
          reason: undefined,
          causedByTransactionId: undefined,
          causedByLabel: undefined,
          lastValidRevision: action.revision,
        },
      };
    }

    case "initialState.realize.failed": {
      return {
        ...state,
        initialState: { ...state.initialState, status: "error", reason: action.error },
      };
    }

    case "results.run.started": {
      return {
        ...state,
        results: { ...state.results, status: "building" },
      };
    }

    case "results.run.completed": {
      return {
        ...state,
        results: {
          ...state.results,
          status: "valid",
          revision: action.revision,
          reason: undefined,
          causedByTransactionId: undefined,
          lastValidRevision: action.revision,
        },
      };
    }

    case "results.run.failed": {
      return {
        ...state,
        results: { ...state.results, status: "error", reason: action.error },
      };
    }

    case "reset": {
      return INITIAL_DIRTY_GRAPH;
    }

    default:
      return state;
  }
}
