/**
 * @module model-builder/types
 *
 * Canonical types for the Fullmag frontend workspace model.
 *
 * This module defines the semantic node system that replaces
 * ad-hoc `nodeId.startsWith(...)` routing with a typed,
 * registry-driven architecture.
 */

// ---------------------------------------------------------------------------
// NodeKind — every semantic class of node in the workspace tree
// ---------------------------------------------------------------------------

export type NodeKind =
  // Session & Script
  | "session.root"
  | "session.script-builder"
  // Universe
  | "universe.root"
  | "universe.domain"
  | "universe.domain.size"
  | "universe.domain.center"
  | "universe.domain.padding"
  | "universe.airbox"
  | "universe.airbox.sizing"
  | "universe.boundary"
  | "universe.mesh"
  | "universe.mesh.view"
  | "universe.mesh.pipeline"
  | "universe.mesh.algorithm"
  | "universe.mesh.size"
  | "universe.mesh.quality"
  | "universe.role"
  // Objects & Geometry
  | "objects.root"
  | "object.root"
  | "object.geometry"
  | "object.geometry.mesh"
  | "object.material"
  | "object.material.properties"
  | "object.initial_state"
  | "object.initial_state.texture"
  | "object.initial_state.texture_transform"
  | "object.regions"
  | "object.region"
  | "object.mesh"
  // Materials
  | "materials.root"
  | "material.entry"
  // Physics
  | "physics.root"
  | "physics.llg"
  | "physics.exchange"
  | "physics.demag"
  | "physics.demag.method"
  | "physics.zeeman"
  | "physics.boundary_conditions"
  | "physics.thermal_noise"
  | "physics.spin_torque"
  | "physics.dmi"
  | "physics.anisotropy"
  | "physics.interaction"
  // Antennas / RF
  | "antennas.root"
  | "antenna.cpw"
  | "antenna.microstrip"
  | "antenna.excitation_analysis"
  // Mesh (global)
  | "mesh.root"
  | "mesh.size"
  | "mesh.algorithm"
  | "mesh.quality"
  | "mesh.inspector"
  | "mesh.pipeline"
  // Study
  | "study.root"
  | "study.pipeline.root"
  | "study.stage.relax"
  | "study.stage.run"
  | "study.stage.eigenmodes"
  | "study.stage.set_field"
  | "study.stage.set_current"
  | "study.stage.save_state"
  | "study.stage.load_state"
  | "study.stage.export"
  | "study.macro.hysteresis_loop"
  | "study.macro.field_sweep_relax"
  | "study.macro.field_sweep_relax_snapshot"
  | "study.macro.relax_run"
  | "study.macro.relax_eigenmodes"
  | "study.macro.parameter_sweep"
  | "study.macro.current_sweep_run"
  | "study.macro.dc_bias_plus_rf_probe"
  | "study.group"
  | "study.stage.detail.overview"
  | "study.stage.detail.solver"
  | "study.stage.detail.time_range"
  | "study.stage.detail.stop_criteria"
  | "study.stage.detail.equilibrium"
  | "study.stage.detail.operator"
  | "study.stage.detail.sweep"
  | "study.stage.detail.settle"
  | "study.stage.detail.outputs"
  | "study.stage.detail.materialized"
  // Results
  | "results.root"
  | "results.fields"
  | "results.energy"
  | "results.state_io"
  | "results.export"
  | "results.dataset"
  | "results.analysis"
  | "results.analysis.pinned"
  | "results.field_quantity"
  | "results.derived_scalars"
  | "results.time_trace"
  | "results.eigen_spectrum"
  | "results.eigen_dispersion"
  | "results.eigenmodes"
  | "results.eigenmode"
  // Visualization
  | "visualization.root"
  | "visualization.preset.project"
  | "visualization.preset.local"
  // Diagnostics
  | "diagnostics.root";

// ---------------------------------------------------------------------------
// NodeDomain — workspace stage during which the node is primarily relevant
// ---------------------------------------------------------------------------

export type NodeDomain = "build" | "study" | "analyze" | "results" | "global";

// ---------------------------------------------------------------------------
// NodeScope — how the node participates in the workspace model
// ---------------------------------------------------------------------------

export type NodeScope =
  | "solver_affecting"
  | "physics_affecting"
  | "mesh_affecting"
  | "output_affecting"
  | "workspace_only"
  | "readonly";

// ---------------------------------------------------------------------------
// SourceOfTruth — where the canonical value of this node lives
// ---------------------------------------------------------------------------

export type SourceOfTruth =
  | "scene_document"
  | "builder_graph"
  | "solver_settings"
  | "mesh_options"
  | "study_pipeline"
  | "workspace_store"
  | "backend_live"
  | "computed";

// ---------------------------------------------------------------------------
// NodeHandle — the semantic identity of any node in the tree
// ---------------------------------------------------------------------------

export interface NodeHandle {
  /** Technical id (existing `nodeId` string from the tree) */
  id: string;
  /** Semantic class of the node */
  nodeKind: NodeKind;
  /** Workspace domain where this node primarily belongs */
  domain: NodeDomain;
  /** How this node affects the workspace model */
  scope: NodeScope;
  /** Where the authoritative value of this node lives */
  sourceOfTruth: SourceOfTruth;
  /** Optional parent handle id for hierarchical context */
  parentId?: string;
  /** Optional entity id (object name, stage id, etc.) */
  entityId?: string;
}

// ---------------------------------------------------------------------------
// Canonical workspace document types
// ---------------------------------------------------------------------------

export interface FullmagWorkspaceDocument {
  version: "workspace.v1";
  studyGraph: StudyGraphRef;
  workspaceGraph: WorkspaceGraphRef;
}

export interface StudyGraphRef {
  /** The study pipeline document that drives solver execution */
  studyPipelineVersion: string;
  /** Active study root node id */
  activeStudyRootId: string | null;
  /** Study-affecting node handles */
  solverNodeRefs: string[];
}

export interface WorkspaceGraphRef {
  /** Ribbon state & active tab */
  ribbonState: {
    activeTab: string;
    contextualTab: string | null;
  };
  /** Tree expansion state */
  treeExpansionState: Record<string, boolean>;
  /** Dock layout snapshot */
  dockLayoutVersion: string;
  /** Active viewport presets */
  viewportPresetRefs: string[];
  /** Results workspace tabs */
  resultWorkspaceIds: string[];
}
