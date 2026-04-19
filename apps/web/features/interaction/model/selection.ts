/**
 * P2 — Selection Model
 *
 * Typed selection target that replaces ad-hoc string-based node IDs.
 * One parser resolves a sidebar node ID into a canonical SelectionTarget.
 *
 * ADR-001: Selection is NOT focus. Select changes highlight/context only.
 */

// ── SelectionTarget ───────────────────────────────────────────

export type SelectionTarget =
  | { kind: "workspace" }
  | { kind: "universe" }
  | { kind: "airbox"; partId?: string | null }
  | { kind: "object"; objectId: string }
  | { kind: "object_geometry"; objectId: string }
  | { kind: "object_material"; objectId: string; materialId?: string | null }
  | { kind: "magnetization_asset"; objectId: string; assetId: string }
  | { kind: "magnetization_transform"; objectId: string; assetId: string }
  | { kind: "physics_stack"; objectId: string }
  | { kind: "magnetic_parameters"; objectId: string }
  | { kind: "mesh_domain"; scope: "universe" | "object" | "shared"; objectId?: string }
  | { kind: "study_stage"; nodeId: string }
  | { kind: "result"; resultId: string }
  | { kind: "visualization_preset"; source: "project" | "local"; presetId: string }
  | { kind: "regions"; objectId: string }
  | { kind: "domain_frame" }
  | { kind: "outer_boundary" }
  | { kind: "study_domain_mesh" }
  | { kind: "study_defaults" }
  | { kind: "runtime_backend" }
  | { kind: "solver_defaults" }
  | { kind: "physics_defaults" }
  | { kind: "outputs_defaults" }
  | { kind: "stages" }
  | { kind: "outputs" }
  // Geometry Builder
  | { kind: "builder_root" }
  | { kind: "builder_universe" }
  | { kind: "builder_primitives" }
  | { kind: "builder_primitive"; primitiveId: string }
  | { kind: "builder_primitive_params"; primitiveId: string }
  | { kind: "builder_primitive_transform"; primitiveId: string }
  | { kind: "builder_lifecycle" };

// ── Selection origin ──────────────────────────────────────────

export type SelectionOrigin = "tree" | "viewport" | "ribbon" | "inspector" | "command" | "route";

// ── SelectionState ────────────────────────────────────────────

export interface SelectionState {
  nodeId: string | null;
  target: SelectionTarget;
  previousTarget: SelectionTarget | null;
  origin: SelectionOrigin;
  selectedObjectId: string | null;
  selectedAssetId: string | null;
  selectedMeshPartId: string | null;
  revision: number;
  selectedAt: number | null;
}

export const EMPTY_SELECTION: SelectionState = {
  nodeId: null,
  target: { kind: "workspace" },
  previousTarget: null,
  origin: "tree",
  selectedObjectId: null,
  selectedAssetId: null,
  selectedMeshPartId: null,
  revision: 0,
  selectedAt: null,
};

// ── Helpers ───────────────────────────────────────────────────

/** Extract the objectId from a SelectionTarget if applicable. */
export function objectIdFromTarget(target: SelectionTarget): string | null {
  switch (target.kind) {
    case "object":
    case "object_geometry":
    case "object_material":
    case "magnetization_asset":
    case "magnetization_transform":
    case "physics_stack":
    case "magnetic_parameters":
    case "regions":
      return target.objectId;
    case "mesh_domain":
      return target.objectId ?? null;
    default:
      return null;
  }
}

/** Extract the assetId from a SelectionTarget if applicable. */
export function assetIdFromTarget(target: SelectionTarget): string | null {
  switch (target.kind) {
    case "magnetization_asset":
    case "magnetization_transform":
      return target.assetId;
    default:
      return null;
  }
}

/** Check if a target is selectable for 3D highlight/manipulation. */
export function isTargetSpatial(target: SelectionTarget): boolean {
  switch (target.kind) {
    case "object":
    case "object_geometry":
    case "magnetization_asset":
    case "magnetization_transform":
    case "mesh_domain":
    case "airbox":
    case "universe":
    case "study_domain_mesh":
    case "builder_primitive":
    case "builder_primitive_transform":
    case "builder_universe":
      return true;
    default:
      return false;
  }
}

/** Check if a target supports transform tools. */
export function isTargetTransformable(target: SelectionTarget): boolean {
  switch (target.kind) {
    case "object":
    case "object_geometry":
    case "magnetization_asset":
    case "magnetization_transform":
    case "builder_primitive":
    case "builder_primitive_transform":
      return true;
    default:
      return false;
  }
}

// ── Node ID parser ────────────────────────────────────────────

/**
 * Parse a sidebar nodeId string into a typed SelectionTarget.
 *
 * Node ID conventions in the current tree:
 *   "sim"               → workspace
 *   "universe"          → universe
 *   "domain-frame"      → domain_frame
 *   "airbox"            → airbox
 *   "outer-boundary"    → outer_boundary
 *   "study-domain-mesh" → study_domain_mesh
 *   "objects"           → workspace (objects root)
 *   "obj-{id}"          → object
 *   "geom-{id}"         → object_geometry
 *   "regions-{id}"      → regions
 *   "mat-{id}"          → object_material
 *   "mag-{id}"          → magnetization_asset
 *   "mag-transform-{id}"→ magnetization_transform
 *   "magparam-{id}"     → magnetic_parameters
 *   "physics-{id}"      → physics_stack
 *   "mesh-{id}"         → mesh_domain (object scope)
 *   "mesh-universe"     → mesh_domain (universe scope)
 *   "mesh-shared"       → mesh_domain (shared scope)
 *   "study"             → study_stage (study root)
 *   "study-defaults"    → study_defaults
 *   "runtime-backend"   → runtime_backend
 *   "solver-defaults"   → solver_defaults
 *   "physics-defaults"  → physics_defaults
 *   "outputs-defaults"  → outputs_defaults
 *   "stages"            → stages
 *   "stage-{id}"        → study_stage
 *   "outputs"           → outputs
 *   "res-*"             → result
 *   "viz-project-{id}"  → visualization_preset (project)
 *   "viz-local-{id}"    → visualization_preset (local)
 */
export function parseNodeIdToTarget(nodeId: string | null): SelectionTarget {
  if (!nodeId) return { kind: "workspace" };

  // Exact matches
  if (nodeId === "sim" || nodeId === "objects") return { kind: "workspace" };
  if (nodeId === "universe") return { kind: "universe" };
  if (nodeId === "domain-frame") return { kind: "domain_frame" };
  if (nodeId === "airbox") return { kind: "airbox" };
  if (nodeId === "outer-boundary") return { kind: "outer_boundary" };
  if (nodeId === "study-domain-mesh") return { kind: "study_domain_mesh" };
  if (nodeId === "study" || nodeId === "study-root") return { kind: "study_stage", nodeId };
  if (nodeId === "study-defaults") return { kind: "study_defaults" };
  if (nodeId === "runtime-backend") return { kind: "runtime_backend" };
  if (nodeId === "solver-defaults") return { kind: "solver_defaults" };
  if (nodeId === "physics-defaults") return { kind: "physics_defaults" };
  if (nodeId === "outputs-defaults") return { kind: "outputs_defaults" };
  if (nodeId === "stages") return { kind: "stages" };
  if (nodeId === "outputs") return { kind: "outputs" };
  if (nodeId === "mesh-universe") return { kind: "mesh_domain", scope: "universe" };
  if (nodeId === "mesh-shared") return { kind: "mesh_domain", scope: "shared" };

  // Prefix-based
  if (nodeId.startsWith("obj-")) {
    return { kind: "object", objectId: nodeId.slice(4) };
  }
  if (nodeId.startsWith("geom-")) {
    return { kind: "object_geometry", objectId: nodeId.slice(5) };
  }
  if (nodeId.startsWith("regions-")) {
    return { kind: "regions", objectId: nodeId.slice(8) };
  }
  if (nodeId.startsWith("mat-")) {
    return { kind: "object_material", objectId: nodeId.slice(4) };
  }
  if (nodeId.startsWith("mag-transform-")) {
    return { kind: "magnetization_transform", objectId: nodeId.slice(14), assetId: `mag:${nodeId.slice(14)}` };
  }
  if (nodeId.startsWith("mag-")) {
    return { kind: "magnetization_asset", objectId: nodeId.slice(4), assetId: `mag:${nodeId.slice(4)}` };
  }
  if (nodeId.startsWith("magparam-")) {
    return { kind: "magnetic_parameters", objectId: nodeId.slice(9) };
  }
  if (nodeId.startsWith("physics-")) {
    return { kind: "physics_stack", objectId: nodeId.slice(8) };
  }
  if (nodeId.startsWith("mesh-")) {
    return { kind: "mesh_domain", scope: "object", objectId: nodeId.slice(5) };
  }
  if (nodeId.startsWith("stage-")) {
    return { kind: "study_stage", nodeId };
  }
  if (nodeId.startsWith("res-")) {
    return { kind: "result", resultId: nodeId };
  }
  if (nodeId.startsWith("viz-project-")) {
    return { kind: "visualization_preset", source: "project", presetId: nodeId.slice(12) };
  }
  if (nodeId.startsWith("viz-local-")) {
    return { kind: "visualization_preset", source: "local", presetId: nodeId.slice(10) };
  }

  // Geometry Builder
  if (nodeId === "builder-root") return { kind: "builder_root" };
  if (nodeId === "builder-universe") return { kind: "builder_universe" };
  if (nodeId === "builder-primitives") return { kind: "builder_primitives" };
  if (nodeId === "builder-lifecycle") return { kind: "builder_lifecycle" };
  if (nodeId.startsWith("builder-prim-")) {
    const rest = nodeId.slice(13); // after "builder-prim-"
    // Sub-nodes: builder-prim-{id}/params, builder-prim-{id}/transform
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) {
      return { kind: "builder_primitive", primitiveId: rest };
    }
    const primitiveId = rest.slice(0, slashIdx);
    const sub = rest.slice(slashIdx + 1);
    if (sub === "params") {
      return { kind: "builder_primitive_params", primitiveId };
    }
    if (sub === "transform") {
      return { kind: "builder_primitive_transform", primitiveId };
    }
    return { kind: "builder_primitive", primitiveId };
  }

  // Fallback
  return { kind: "workspace" };
}

// ── Reverse: target → ribbon context mapping ──────────────────

export type RibbonCoreTab =
  | "home"
  | "definitions"
  | "geometry"
  | "materials"
  | "physics"
  | "mesh"
  | "study"
  | "results"
  | "automation";

export type ContextualTab =
  | "object"
  | "object-geometry"
  | "magnetization"
  | "magnetization-transform"
  | "texture-transform"
  | "mesh-domain"
  | "stage"
  | "analysis"
  | null;

export interface RibbonContext {
  coreTab: RibbonCoreTab;
  contextualTab: ContextualTab;
  defaultTransformScope: "object" | "magnetization_texture" | "mesh_local" | null;
}

export function ribbonContextForTarget(target: SelectionTarget): RibbonContext {
  switch (target.kind) {
    case "object":
    case "object_geometry":
      return { coreTab: "geometry", contextualTab: "object", defaultTransformScope: "object" };
    case "object_material":
      return { coreTab: "materials", contextualTab: null, defaultTransformScope: null };
    case "magnetization_asset":
      return { coreTab: "physics", contextualTab: "magnetization", defaultTransformScope: "magnetization_texture" };
    case "magnetization_transform":
      return { coreTab: "physics", contextualTab: "texture-transform", defaultTransformScope: "magnetization_texture" };
    case "physics_stack":
    case "magnetic_parameters":
      return { coreTab: "physics", contextualTab: null, defaultTransformScope: null };
    case "mesh_domain":
      return { coreTab: "mesh", contextualTab: "mesh-domain", defaultTransformScope: null };
    case "study_stage":
    case "stages":
      return { coreTab: "study", contextualTab: "stage", defaultTransformScope: null };
    case "result":
      return { coreTab: "results", contextualTab: "analysis", defaultTransformScope: null };
    case "builder_root":
    case "builder_universe":
    case "builder_primitives":
    case "builder_primitive":
    case "builder_primitive_params":
    case "builder_primitive_transform":
    case "builder_lifecycle":
      return { coreTab: "geometry", contextualTab: null, defaultTransformScope: "object" };
    default:
      return { coreTab: "home", contextualTab: null, defaultTransformScope: null };
  }
}

// ── Selection → Inspector panel mapping ───────────────────────

export type InspectorPanelKey =
  | "workspace-overview"
  | "object-overview"
  | "geometry-object"
  | "material-assignment"
  | "magnetization-authoring"
  | "magnetization-transform"
  | "magnetic-parameters"
  | "physics-stack"
  | "mesh-domain"
  | "study-stage"
  | "result-analysis"
  | "visualization-preset"
  | "universe"
  | "airbox"
  | "domain-frame"
  | "outer-boundary"
  | "study-domain-mesh"
  | "study-defaults"
  | "runtime-backend"
  | "solver-defaults"
  | "physics-defaults"
  | "outputs-defaults";

export function inspectorPanelForTarget(target: SelectionTarget): InspectorPanelKey {
  switch (target.kind) {
    case "object": return "object-overview";
    case "object_geometry": return "geometry-object";
    case "object_material": return "material-assignment";
    case "magnetization_asset": return "magnetization-authoring";
    case "magnetization_transform": return "magnetization-transform";
    case "magnetic_parameters": return "magnetic-parameters";
    case "physics_stack": return "physics-stack";
    case "mesh_domain": return "mesh-domain";
    case "study_stage":
    case "stages": return "study-stage";
    case "result": return "result-analysis";
    case "visualization_preset": return "visualization-preset";
    case "universe": return "universe";
    case "airbox": return "airbox";
    case "domain_frame": return "domain-frame";
    case "outer_boundary": return "outer-boundary";
    case "study_domain_mesh": return "study-domain-mesh";
    case "study_defaults": return "study-defaults";
    case "runtime_backend": return "runtime-backend";
    case "solver_defaults": return "solver-defaults";
    case "physics_defaults": return "physics-defaults";
    case "outputs_defaults": return "outputs-defaults";
    default: return "workspace-overview";
  }
}
