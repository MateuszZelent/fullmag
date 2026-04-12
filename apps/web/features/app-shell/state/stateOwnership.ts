/**
 * State Ownership Policy — Layer 9
 *
 * Every piece of mutable state in the refactored frontend must be
 * classified into exactly one of four ownership classes **before**
 * implementation.  This file provides the canonical type definitions
 * and helper utilities that make ownership explicit at the type level.
 *
 * ┌──────────────────────┬──────────────────────────────────────────┐
 * │ Class                │ Description                              │
 * ├──────────────────────┼──────────────────────────────────────────┤
 * │ study                │ Solver-affecting, canonical, patched     │
 * │                      │ with backend, emitted to Python.         │
 * ├──────────────────────┼──────────────────────────────────────────┤
 * │ workspace            │ UI-affecting, canonical, partially       │
 * │                      │ patched, emitted to workspace DSL.       │
 * ├──────────────────────┼──────────────────────────────────────────┤
 * │ runtime_telemetry    │ Fast-changing, separate, must not force  │
 * │                      │ global re-renders.                       │
 * ├──────────────────────┼──────────────────────────────────────────┤
 * │ transient            │ Hover/drag/selection-rect — local and    │
 * │                      │ non-canonical.                           │
 * └──────────────────────┴──────────────────────────────────────────┘
 */

// ── Ownership class enum ─────────────────────────────────────

export type StateOwnershipClass =
  | "study"
  | "workspace"
  | "runtime_telemetry"
  | "transient";

// ── State field descriptor ───────────────────────────────────

/**
 * Metadata attached to a state field to make its ownership,
 * persistence, and serialisation rules explicit.
 */
export interface StateFieldDescriptor<T = unknown> {
  /** Unique dot-notation key, e.g. `"viewport.viewMode"`. */
  key: string;
  /** Which ownership class this field belongs to. */
  ownership: StateOwnershipClass;
  /** Whether this field is patched from the backend. */
  patchedFromBackend: boolean;
  /** Whether this field is emitted to Python script export. */
  emittedToPython: boolean;
  /** Whether this field is persisted across sessions. */
  persisted: boolean;
  /** Default / initial value. */
  defaultValue: T;
}

// ── Store ownership metadata (for auditing) ──────────────────

/**
 * A snapshot mapping field keys → ownership class.
 * Used at store-creation time to validate that every field has a
 * declared owner, and at compile time via `satisfies` to keep the
 * metadata in sync with the actual store shape.
 */
export type StateOwnershipMap = Record<string, StateOwnershipClass>;

// ── Built-in field ownership maps ────────────────────────────

/** Ownership map for `useViewportStore` fields. */
export const VIEWPORT_STATE_OWNERSHIP: StateOwnershipMap = {
  // Interaction — transient
  "interactionMode":        "transient",
  "hoverTarget":            "transient",
  "isDragging":             "transient",
  "gizmoActiveAxis":        "transient",

  // Camera — workspace (persisted in workspace DSL)
  "camera":                 "workspace",

  // View modes — workspace
  "viewMode":               "workspace",
  "component":              "workspace",
  "plane":                  "workspace",
  "sliceIndex":             "workspace",

  // Chrome — workspace
  "consoleCollapsed":       "workspace",
  "sidebarCollapsed":       "workspace",

  // FEM render settings — workspace
  "meshRenderMode":         "workspace",
  "meshOpacity":            "workspace",
  "meshClipEnabled":        "workspace",
  "meshClipAxis":           "workspace",
  "meshClipPos":            "workspace",
  "meshShowArrows":         "workspace",
  "femArrowColorMode":      "workspace",
  "femArrowMonoColor":      "workspace",
  "femArrowAlpha":          "workspace",
  "femArrowLengthScale":    "workspace",
  "femArrowThickness":      "workspace",
  "femVectorDomainFilter":  "workspace",
  "femFerromagnetVisibilityMode": "workspace",
  "femColorField":          "workspace",
  "femMagnetization3DActive": "workspace",
  "femDockTab":             "workspace",

  // Scope / selection — transient (local navigation)
  "viewportScope":          "transient",
  "objectViewMode":         "transient",
  "activeTransformScope":   "transient",
  "selectedSidebarNodeId":  "transient",
  "selectedObjectId":       "transient",
  "selectedEntityId":       "transient",
  "focusedEntityId":        "transient",

  // Air mesh — workspace
  "airMeshVisible":         "workspace",
  "airMeshOpacity":         "workspace",

  // Mesh selection — transient
  "meshSelection":          "transient",
} as const;

/** Ownership map for session-runtime related fields. */
export const SESSION_RUNTIME_STATE_OWNERSHIP: StateOwnershipMap = {
  "sessionId":              "runtime_telemetry",
  "runId":                  "runtime_telemetry",
  "solverStatus":           "runtime_telemetry",
  "currentStep":            "runtime_telemetry",
  "currentTime":            "runtime_telemetry",
  "maxTorque":              "runtime_telemetry",
  "wallClockElapsed":       "runtime_telemetry",
  "meshBuildPhase":         "runtime_telemetry",
} as const;

/** Ownership map for study (solver-affecting) fields. */
export const STUDY_STATE_OWNERSHIP: StateOwnershipMap = {
  "stages":                "study",
  "globalParams":          "study",
  "fieldOutputs":          "study",
  "solverConfig":          "study",
  "materialAssignments":   "study",
  "meshPolicy":            "study",
  "geometryObjects":       "study",
  "magnetizationConfigs":  "study",
  "antennaConfigs":        "study",
  "boundaryConditions":    "study",
} as const;

// ── Runtime helpers ──────────────────────────────────────────

/** Check whether a field key belongs to the given ownership class. */
export function isOwnedBy(
  map: StateOwnershipMap,
  field: string,
  cls: StateOwnershipClass,
): boolean {
  return map[field] === cls;
}

/** Return all field keys that belong to the given class. */
export function fieldsOwnedBy(
  map: StateOwnershipMap,
  cls: StateOwnershipClass,
): string[] {
  return Object.entries(map)
    .filter(([, c]) => c === cls)
    .map(([k]) => k);
}

/**
 * Validate that every field in `actualKeys` has an entry in the
 * ownership map.  Returns unclassified keys (should be empty).
 */
export function findUnclassifiedFields(
  map: StateOwnershipMap,
  actualKeys: string[],
): string[] {
  return actualKeys.filter((k) => !(k in map));
}
