/**
 * Layer D – FEM Viewport Engine: Selection Scope
 *
 * Pure function that resolves the current viewport selection scope from
 * sidebar node ID, object ID, entity ID, and mesh parts.
 *
 * This is the single source of truth for "what is the toolbar targeting?"
 * and replaces the previous heuristic of `find(first selected layer)`.
 */

import type { FemMeshPart } from "../../../lib/session/types";

/* ── Types ──────────────────────────────────────────────────────── */

export type ViewportSelectionScope =
  | { kind: "universe" }
  | { kind: "object"; objectId: string; partIds: string[] }
  | { kind: "airbox"; partId: string }
  | { kind: "part"; partId: string };

export interface ViewportSelectionState {
  scope: ViewportSelectionScope;
  focusedPartId: string | null;
}

/* ── Resolver ───────────────────────────────────────────────────── */

export interface ResolveSelectionScopeInput {
  selectedSidebarNodeId: string | null;
  selectedObjectId: string | null;
  selectedEntityId: string | null;
  meshParts: readonly FemMeshPart[];
}

/**
 * Resolve the current viewport selection scope.
 *
 * Priority:
 * 1. Airbox sidebar node → `{ kind: "airbox" }`
 * 2. Object selected (from tree) → `{ kind: "object", partIds: [...] }`
 * 3. Explicit entity/part selected → `{ kind: "part" }`
 * 4. Nothing selected → `{ kind: "universe" }`
 */
export function resolveViewportSelectionScope(
  input: ResolveSelectionScopeInput,
): ViewportSelectionScope {
  const { selectedSidebarNodeId, selectedObjectId, selectedEntityId, meshParts } = input;

  // 1. Airbox node selected
  if (
    selectedSidebarNodeId === "universe-airbox" ||
    selectedSidebarNodeId === "universe-airbox-mesh"
  ) {
    const airPart = meshParts.find((p) => p.role === "air");
    if (airPart) {
      return { kind: "airbox", partId: airPart.id };
    }
  }

  // 2. Object selected (composite — all parts of the object)
  if (selectedObjectId) {
    const objectPartIds = meshParts
      .filter((p) => p.object_id === selectedObjectId)
      .map((p) => p.id);
    if (objectPartIds.length > 0) {
      return { kind: "object", objectId: selectedObjectId, partIds: objectPartIds };
    }
  }

  // 3. Explicit entity (single part) selected
  if (selectedEntityId) {
    const part = meshParts.find((p) => p.id === selectedEntityId);
    if (part) {
      if (part.role === "air") {
        return { kind: "airbox", partId: part.id };
      }
      return { kind: "part", partId: part.id };
    }
  }

  // 4. No selection
  return { kind: "universe" };
}

/* ── Helpers ─────────────────────────────────────────────────────── */

/**
 * Get the part IDs that a given scope targets for style operations
 * (render mode, opacity, color field).
 */
export function scopeTargetPartIds(
  scope: ViewportSelectionScope,
  allVisiblePartIds: string[],
): string[] {
  switch (scope.kind) {
    case "object":
      return scope.partIds;
    case "airbox":
      return [scope.partId];
    case "part":
      return [scope.partId];
    case "universe":
      return allVisiblePartIds;
  }
}

/**
 * Format a human-readable label for the current scope.
 */
export function scopeLabel(
  scope: ViewportSelectionScope,
  meshParts: readonly FemMeshPart[],
): string {
  switch (scope.kind) {
    case "airbox":
      return "Airbox";
    case "part": {
      const part = meshParts.find((p) => p.id === scope.partId);
      return `Selected: ${part?.label ?? scope.partId}`;
    }
    case "object": {
      const parts = meshParts.filter((p) => scope.partIds.includes(p.id));
      // Try to derive object name from first part label
      const firstPart = parts[0];
      const objectLabel =
        firstPart?.label?.replace(/[_-](shell|core|part\d+)$/i, "") ??
        firstPart?.object_id ??
        "object";
      return `Selected object: ${objectLabel} (${parts.length} parts)`;
    }
    case "universe":
      return "All visible";
  }
}
