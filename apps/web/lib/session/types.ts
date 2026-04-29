/* ── Session stream types ──
 * All interfaces and type aliases used by the session streaming pipeline. */

import { FRONTEND_DIAGNOSTIC_FLAGS } from "@/lib/debug/frontendDiagnosticFlags";

export interface SessionManifest {
  session_id: string;
  run_id: string;
  status: string;
  interactive_session_requested: boolean;
  script_path: string;
  problem_name: string;
  requested_backend: string;
  explicit_selection?: boolean;
  requested_device?: string;
  requested_precision?: string;
  requested_mode?: string;
  requested_cpu_threads?: number | null;
  execution_mode: string;
  precision: string;
  resolved_backend?: string | null;
  resolved_device?: string | null;
  resolved_precision?: string | null;
  resolved_mode?: string | null;
  resolved_runtime_family?: string | null;
  resolved_engine_id?: string | null;
  resolved_worker?: string | null;
  resolved_cpu_threads?: number | null;
  resolved_fallback?: ResolvedFallback;
  artifact_dir: string;
  started_at_unix_ms: number;
  finished_at_unix_ms: number;
  plan_summary?: Record<string, unknown>;
}

export interface ResolvedFallback {
  occurred: boolean;
  original_engine: string;
  fallback_engine: string;
  reason: string;
  message: string;
}

export interface RunManifest {
  run_id: string;
  session_id: string;
  status: string;
  total_steps: number;
  final_time: number | null;
  final_e_ex: number | null;
  final_e_demag: number | null;
  final_e_ext: number | null;
  final_e_ani: number | null;
  final_e_dmi: number | null;
  final_e_total: number | null;
  artifact_dir: string;
}

export interface LiveState {
  status: string;
  updated_at_unix_ms: number;
  step: number;
  time: number;
  dt: number;
  e_ex: number;
  e_demag: number;
  e_ext: number;
  e_ani: number;
  e_dmi: number;
  e_total: number;
  max_dm_dt: number;
  max_h_eff: number;
  max_h_demag: number;
  max_torque_Apm?: number;
  max_torque_T?: number;
  wall_time_ns: number;
  grid: [number, number, number];
  preview_grid: [number, number, number] | null;
  preview_data_points_count: number | null;
  preview_max_points: number | null;
  preview_auto_downscaled: boolean;
  preview_auto_downscale_message: string | null;
  fem_mesh: FemLiveMesh | null;
  /** @deprecated Use `latest_fields.frames["m"]?.values` instead. Remove once StepUpdate migrates to StepUpdateV2 (Q16). */
  magnetization: Float64Array | null;
  finished: boolean;
}

export interface FemLiveMesh {
  mesh_name?: string | null;
  mesh_id?: string | null;
  nodes: [number, number, number][];
  elements: [number, number, number, number][];
  element_markers?: number[];
  boundary_faces: [number, number, number][];
  boundary_markers?: number[];
  topology_buffers?: {
    nodes: Float64Array;
    elements: Uint32Array;
    boundary_faces: Uint32Array;
    element_markers: Uint32Array;
    boundary_markers: Uint32Array;
  } | null;
  topology_transport?: "json" | "binary" | null;
  node_count?: number | null;
  element_count?: number | null;
  boundary_face_count?: number | null;
  object_segments?: FemLiveMeshObjectSegment[];
  mesh_parts?: FemMeshPart[];
  domain_mesh_mode?: string | null;
  domain_frame?: DomainFrameState | null;
  generation_id?: string | null;
  per_domain_quality?: Record<number, MeshQualityStats> | null;
}

export interface FemLiveMeshObjectSegment {
  object_id: string;
  geometry_id?: string | null;
  node_start: number;
  node_count: number;
  element_start: number;
  element_count: number;
  boundary_face_start: number;
  boundary_face_count: number;
}

export interface FemMeshPart {
  id: string;
  label: string;
  role: "air" | "magnetic_object" | "interface" | "outer_boundary";
  object_id: string | null;
  geometry_id: string | null;
  material_id: string | null;
  element_start: number;
  element_count: number;
  boundary_face_start: number;
  boundary_face_count: number;
  boundary_face_indices: number[];
  node_start: number;
  node_count: number;
  node_indices: number[];
  surface_faces: [number, number, number][];
  bounds_min: [number, number, number] | null;
  bounds_max: [number, number, number] | null;
}

// ── Swept mesh controls ─────────────────────────────────────────────

export interface SweepDistribution {
  kind: "uniform" | "arithmetic" | "geometric";
  num_layers: number;
  growth_rate?: number;
}

export interface SweptMeshHints {
  sweep_direction: "auto" | "x" | "y" | "z";
  distribution: SweepDistribution;
}

// ── Mesh quality ────────────────────────────────────────────────────

export interface MeshQualityStats {
  n_elements: number;
  sicn_mean: number;
  sicn_min: number;
  sicn_max: number;
  sicn_p5: number;
  sicn_histogram?: number[];
  gamma_min: number;
  gamma_mean: number;
  gamma_histogram?: number[];
  volume_min: number;
  volume_max: number;
  volume_mean: number;
  volume_std: number;
  avg_quality: number;
}

export interface PerObjectMeshReport {
  geometry_name: string;
  marker: number;
  quality: MeshQualityStats | null;
}

export interface MeshEntityViewState {
  visible: boolean;
  renderMode: "surface" | "surface+edges" | "wireframe" | "mesh" | "points";
  opacity: number;
  colorField:
    | "orientation"
    | "x"
    | "y"
    | "z"
    | "magnitude"
    | "quality"
    | "sicn"
    | "none";
}

export type MeshEntityViewStateMap = Record<string, MeshEntityViewState>;

/** Single source of truth for default per-part view state. */
export function defaultMeshEntityViewState(part: Pick<FemMeshPart, "role">): MeshEntityViewState {
  const airboxDisabledByDefault =
    FRONTEND_DIAGNOSTIC_FLAGS.femViewport.airboxDisabledByDefault;
  return {
    visible:
      part.role === "air"
        ? !airboxDisabledByDefault
        : part.role !== "outer_boundary",
    renderMode: part.role === "air" ? "wireframe" : "surface+edges",
    opacity:
      part.role === "air"
        ? 28
        : part.role === "outer_boundary"
          ? 46
          : part.role === "interface"
            ? 88
            : 100,
    colorField: part.role === "magnetic_object" ? "orientation" : "none",
  };
}

export interface ScalarRow {
  step: number;
  time: number;
  solver_dt: number;
  mx: number;
  my: number;
  mz: number;
  e_ex: number;
  e_demag: number;
  e_ext: number;
  e_ani: number;
  e_dmi: number;
  e_total: number;
  max_dm_dt: number;
  max_h_eff: number;
  max_h_demag: number;
  max_torque_Apm?: number;
  max_torque_T?: number;
}

export interface EngineLogEntry {
  timestamp_unix_ms: number;
  level: string;
  message: string;
}

export interface QuantityDescriptor {
  id: string;
  label: string;
  kind: string;
  unit: string;
  location: string;
  available: boolean;
  data_available: boolean;
  interactive_preview: boolean;
  quick_access_label: string | null;
  scalar_metric_key: string | null;
  n_comp: number;
  domain: "magnetic_only" | "full_domain";
  normalization_hint: "unit_vector" | "max_abs" | "none";
  supports_preview_2d: boolean;
  supports_preview_3d: boolean;
  supports_history: boolean;
  supports_export: boolean;
}

export interface BackendCapabilities {
  engine_id: string;
  capability_profile_version: string;
  supported_terms: string[];
  supported_demag_realizations: string[];
  preview_quantities: string[];
  snapshot_quantities: string[];
  scalar_outputs: string[];
  approximate_operators: string[];
  supports_lossy_fallback_override: boolean;
}

export interface ArtifactEntry {
  path: string;
  kind: string;
}

export interface LatestFieldFrame {
  quantity_id: string;
  unit: string;
  n_comp: number;
  grid: [number, number, number];
  values: Float64Array;
  active_mask?: Uint8Array | null;
  location?: string | null;
  domain?: string | null;
  /**
   * Topology signature used to validate that the field frame matches
   * the currently active FEM mesh topology.
   * Typical values: "gen:<generation_id>", "hash:<topology_hash>".
   */
  topology_signature?: string | null;
  field_revision?: number | null;
  source_step?: number | null;
  source_time?: number | null;
}

export interface LatestFields {
  frames: Record<string, LatestFieldFrame>;
  grid: [number, number, number] | null;
}

export interface SpatialPreviewState {
  kind: "spatial";
  display_kind: "vector_field" | "spatial_scalar";
  config_revision: number;
  source_step: number;
  source_time: number;
  spatial_kind: "grid" | "mesh";
  quantity: string;
  unit: string;
  quantity_domain: "magnetic_only" | "full_domain" | "surface_only";
  component: string;
  layer: number;
  all_layers: boolean;
  type: string;
  vector_payload_id: number | null;
  vector_field_values: Float64Array | null;
  scalar_field: [number, number, number][];
  min: number;
  max: number;
  n_comp: number;
  max_points: number;
  data_points_count: number;
  x_possible_sizes: number[];
  y_possible_sizes: number[];
  x_chosen_size: number;
  y_chosen_size: number;
  applied_x_chosen_size: number;
  applied_y_chosen_size: number;
  applied_layer_stride: number;
  auto_scale_enabled: boolean;
  auto_downscaled: boolean;
  auto_downscale_message: string | null;
  preview_grid: [number, number, number];
  fem_mesh: FemLiveMesh | null;
  original_node_count: number | null;
  original_face_count: number | null;
  active_mask: boolean[] | null;
}

export interface GlobalScalarPreviewState {
  kind: "global_scalar";
  display_kind: "global_scalar";
  config_revision: number;
  source_step: number;
  source_time: number;
  quantity: string;
  unit: string;
  value: number;
}

export type PreviewState = SpatialPreviewState | GlobalScalarPreviewState;

export interface PreviewConfig {
  revision: number;
  quantity: string;
  component: string;
  vector_glyphs?: boolean;
  layer: number;
  all_layers: boolean;
  every_n: number;
  x_chosen_size: number;
  y_chosen_size: number;
  auto_scale_enabled: boolean;
  max_points: number;
}

export interface SessionMetadata {
  session_protocol_version?: string;
  capability_profile_version?: string;
  capabilities?: BackendCapabilities | null;
  [key: string]: unknown;
}

export type DisplayKind = "vector_field" | "spatial_scalar" | "global_scalar";

export interface DisplaySelection {
  quantity: string;
  kind: DisplayKind;
  view_mode: "2d" | "3d";
  field_component: "x" | "y" | "z" | "magnitude";
  vector_glyphs?: boolean;
  layer: number;
  all_layers: boolean;
  x_chosen_size: number;
  y_chosen_size: number;
  every_n: number;
  max_points: number;
  auto_scale_enabled: boolean;
}

export interface CurrentDisplaySelection {
  revision: number;
  selection: DisplaySelection;
}

export type RuntimeStatusKind =
  | "bootstrapping"
  | "materializing"
  | "materializing_script"
  | "waiting_for_compute"
  | "awaiting_command"
  | "running"
  | "paused"
  | "breaking"
  | "closing"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface RuntimeStatusState {
  kind: RuntimeStatusKind;
  code: string;
  is_busy: boolean;
  can_accept_commands: boolean;
}

export type MeshCommandTarget =
  | { kind: "study_domain" }
  | { kind: "adaptive_followup" }
  | { kind: "airbox" }
  | { kind: "object_mesh"; object_id: string };

export type MeshBuildIntent =
  | { mode: "all"; target: { kind: "study_domain" } }
  | { mode: "selected"; target: { kind: "study_domain" } }
  | { mode: "selected"; target: { kind: "airbox" } }
  | { mode: "selected"; target: { kind: "object_mesh"; object_id: string } };

export interface CommandStatus {
  session_id: string;
  seq: number | null;
  command_id: string;
  command_kind: string;
  state: "acknowledged" | "rejected" | "completed";
  issued_at_unix_ms: number | null;
  completed_at_unix_ms: number | null;
  completion_state: string | null;
  reason: string | null;
  display_selection: CurrentDisplaySelection | null;
  mesh_target?: MeshCommandTarget | null;
  mesh_reason?: string | null;
}

export type StageStopReason =
  | "torque"
  | "energy"
  | "max_steps"
  | "max_pseudotime"
  | "max_physical_time"
  | "user_cancelled"
  | "backend_error";

export interface StageExecutionRecord {
  status: string;
  reason: StageStopReason | null;
  metric_name: string | null;
  metric_value: number | null;
  threshold: number | null;
}

export interface StageExecutionState {
  total_stages: number;
  completed_stage_indexes: number[];
  stages: StageExecutionRecord[];
  stage_statuses: string[];
  active_stage_index: number | null;
  active_stage_kind: string | null;
  runtime_state: string;
}

export interface ScriptBuilderSolverState {
  integrator: string;
  fixed_timestep: string;
  relax_algorithm: string;
  torque_tolerance: string;
  energy_tolerance: string;
  max_relax_steps: string;
}

export interface ScriptBuilderMeshState {
  algorithm_2d: number;
  algorithm_3d: number;
  size_mode?: "predefined" | "custom";
  hmax: string;
  hmin: string;
  maximum_element_size?: string;
  minimum_element_size?: string;
  calibrate_for?: string;
  size_preset?: string;
  size_factor: number;
  size_from_curvature: number;
  curvature_factor?: string;
  growth_rate: string;
  maximum_element_growth_rate?: string;
  narrow_regions: number;
  smoothing_steps: number;
  narrow_region_resolution?: string;
  resolved_size_from_curvature?: number | null;
  resolved_narrow_regions?: number | null;
  resolved_growth_rate?: string;
  optimize: string;
  optimize_iterations: number;
  compute_quality: boolean;
  per_element_quality: boolean;
  interface_hmax?: string;
  interface_thickness?: string;
  transition_distance?: string;
  transition_growth?: string;
  adaptive_enabled: boolean;
  adaptive_policy: string;
  adaptive_indicator?: string;
  adaptive_target_quantity?: string;
  adaptive_convergence_metric?: string;
  adaptive_theta: number;
  adaptive_h_min: string;
  adaptive_h_max: string;
  adaptive_max_passes: number;
  adaptive_error_tolerance: string;
}

export interface ScriptBuilderMeshSizeFieldEntry {
  kind: string;
  params: Record<string, unknown>;
}

export interface ScriptBuilderMeshOperationEntry {
  kind: string;
  params: Record<string, unknown>;
}

export interface ScriptBuilderUniverseState {
  mode: string;
  size: [number, number, number] | null;
  center: [number, number, number] | null;
  padding: [number, number, number] | null;
  airbox_hmax: number | null;
  airbox_hmin: number | null;
  airbox_growth_rate: number | null;
  airbox_grading: string | null;
}

export interface DomainFrameDeclaredUniverseState {
  mode: string;
  size: [number, number, number] | null;
  center: [number, number, number] | null;
  padding: [number, number, number] | null;
  airbox_hmax: number | null;
  airbox_hmin: number | null;
  airbox_growth_rate: number | null;
  airbox_grading: string | null;
}

export interface DomainFrameState {
  declared_universe: DomainFrameDeclaredUniverseState | null;
  object_bounds_min: [number, number, number] | null;
  object_bounds_max: [number, number, number] | null;
  mesh_bounds_min: [number, number, number] | null;
  mesh_bounds_max: [number, number, number] | null;
  effective_extent: [number, number, number] | null;
  effective_center: [number, number, number] | null;
  effective_source: string | null;
}

export interface ScriptBuilderStageState {
  kind: string;
  entrypoint_kind: string;
  integrator: string;
  fixed_timestep: string;
  until_seconds: string;
  relax_algorithm: string;
  torque_tolerance: string;
  energy_tolerance: string;
  max_steps: string;
  /** Eigenmode fields — only meaningful when kind === "eigenmodes" */
  eigen_count: string;
  eigen_target: string;
  eigen_include_demag: boolean;
  eigen_equilibrium_source: string;
  eigen_normalization: string;
  eigen_target_frequency: string;
  eigen_damping_policy: string;
  eigen_k_vector: string;
  eigen_spin_wave_bc: string;
  eigen_spin_wave_bc_config: Record<string, unknown> | null;
}

export interface StudyPipelinePrimitiveNodeState {
  id: string;
  label: string;
  enabled: boolean;
  node_kind: "primitive";
  stage_kind: string;
  payload: Record<string, unknown>;
  notes?: string | null;
}

export interface StudyPipelineMacroNodeState {
  id: string;
  label: string;
  enabled: boolean;
  node_kind: "macro";
  macro_kind: string;
  config: Record<string, unknown>;
  notes?: string | null;
}

export interface StudyPipelineGroupNodeState {
  id: string;
  label: string;
  enabled: boolean;
  node_kind: "group";
  collapsed: boolean;
  children: StudyPipelineNodeState[];
  notes?: string | null;
}

export type StudyPipelineNodeState =
  | StudyPipelinePrimitiveNodeState
  | StudyPipelineMacroNodeState
  | StudyPipelineGroupNodeState;

export interface StudyPipelineDocumentState {
  version: "study_pipeline.v1";
  nodes: StudyPipelineNodeState[];
}

export interface ScriptBuilderInitialState {
  magnet_name: string | null;
  source_path: string;
  format: string;
  dataset: string | null;
  sample_index: number | null;
}

export interface ScriptBuilderMaterialEntry {
  Ms: number | null;
  Aex: number | null;
  alpha: number;
  Dind: number | null;
}

export type ScriptBuilderMagneticInteractionKind =
  | "exchange"
  | "demag"
  | "interfacial_dmi"
  | "uniaxial_anisotropy";

export interface ScriptBuilderMagneticInteractionEntry {
  kind: ScriptBuilderMagneticInteractionKind;
  enabled: boolean;
  params: Record<string, unknown> | null;
}

export interface ScriptBuilderMagnetizationEntry {
  kind: string;                   // canonical: "preset_texture" | "sampled"
  value: number[] | null;         // legacy compatibility only
  seed: number | null;            // legacy compatibility only
  source_path: string | null;     // for sampled/loadfile sources
  source_format?: string | null;
  dataset?: string | null;
  sample_index?: number | null;
  mapping?: MagnetizationMapping | null;
  texture_transform?: TextureTransform3D | null;
  preset_kind?: string | null;
  preset_params?: Record<string, unknown> | null;
  preset_version?: number | null;
  ui_label?: string | null;
}

export interface ScriptBuilderPerGeometryMeshEntry {
  mode: "inherit" | "custom";
  size_mode?: "predefined" | "custom";
  hmax: string;
  hmin: string;
  maximum_element_size?: string;
  minimum_element_size?: string;
  calibrate_for?: string | null;
  size_preset?: string | null;
  order: number | null;
  source: string | null;
  algorithm_2d: number | null;
  algorithm_3d: number | null;
  size_factor: number | null;
  size_from_curvature: number | null;
  curvature_factor?: string;
  growth_rate: string;
  maximum_element_growth_rate?: string;
  narrow_regions: number | null;
  narrow_region_resolution?: string;
  resolved_size_from_curvature?: number | null;
  resolved_narrow_regions?: number | null;
  resolved_growth_rate?: string;
  smoothing_steps: number | null;
  optimize: string | null;
  optimize_iterations: number | null;
  compute_quality: boolean | null;
  per_element_quality: boolean | null;
  // First-class mesh semantics (Commit 3)
  bulk_hmax: string | null;
  bulk_hmin: string | null;
  interface_hmax: string | null;
  interface_thickness: string | null;
  transition_distance: string | null;
  transition_growth: number | null;
  // Boundary layer extrusion
  boundary_layer_count: number | null;
  boundary_layer_thickness: string | null;   // SI metres as string (matches hmax/hmin pattern)
  boundary_layer_stretching: number | null;
  // Swept / through-thickness meshing
  mesh_strategy: string | null;
  through_thickness_elements: number | null;
  through_thickness_distribution: string | null;
  through_thickness_element_ratio: number | null;
  through_thickness_symmetric: boolean;
  sweep_face_meshing: string | null;
  size_fields: ScriptBuilderMeshSizeFieldEntry[];
  operations: ScriptBuilderMeshOperationEntry[];
  build_requested: boolean;
  // Last build diagnostics (read-only, set by backend)
  last_build_n_elements?: number | null;
  last_build_quality_sicn?: number | null;
  last_build_status?: "ok" | "warning" | "error" | null;
}

export interface ScriptBuilderGeometryEntry {
  name: string;
  region_name?: string | null;
  geometry_kind: string;
  geometry_params: Record<string, unknown>;
  bounds_min?: [number, number, number] | null;
  bounds_max?: [number, number, number] | null;
  material: ScriptBuilderMaterialEntry;
  physics_stack?: ScriptBuilderMagneticInteractionEntry[];
  magnetization: ScriptBuilderMagnetizationEntry;
  mesh: ScriptBuilderPerGeometryMeshEntry | null;
}

export interface ScriptBuilderDriveEntry {
  current_a: number;
  frequency_hz: number | null;
  phase_rad: number;
  waveform: Record<string, unknown> | null;
}

export interface ScriptBuilderCurrentModuleEntry {
  kind: string;
  name: string;
  solver: string;
  air_box_factor: number;
  antenna_kind: string;
  antenna_params: Record<string, unknown>;
  drive: ScriptBuilderDriveEntry;
}

export interface ScriptBuilderExcitationAnalysisEntry {
  source: string;
  method: string;
  propagation_axis: [number, number, number];
  k_max_rad_per_m: number | null;
  samples: number;
}

export interface ScriptBuilderState {
  revision: number;
  backend: string | null;
  cpu_threads: number | null;
  fem_demag_solver_policy: Record<string, unknown> | null;
  demag_realization: string | null;
  external_field: [number, number, number] | null;
  solver: ScriptBuilderSolverState;
  mesh: ScriptBuilderMeshState;
  universe: ScriptBuilderUniverseState | null;
  domain_frame: DomainFrameState | null;
  stages: ScriptBuilderStageState[];
  study_pipeline: StudyPipelineDocumentState | null;
  initial_state: ScriptBuilderInitialState | null;
  geometries: ScriptBuilderGeometryEntry[];
  current_modules: ScriptBuilderCurrentModuleEntry[];
  excitation_analysis: ScriptBuilderExcitationAnalysisEntry | null;
}

export interface ModelBuilderGraphObjectTreeRefs {
  geometry: string;
  material: string;
  region: string;
  mesh: string;
}

export interface ModelBuilderGraphObjectNode {
  id: string;
  kind: "ferromagnet";
  name: string;
  label: string;
  geometry: ScriptBuilderGeometryEntry;
  object_mesh: ScriptBuilderPerGeometryMeshEntry | null;
  tree: ModelBuilderGraphObjectTreeRefs;
}

export interface ModelBuilderGraphStudyNode {
  id: "study";
  kind: "study";
  label: string;
  backend: string | null;
  requested_backend: string;
  requested_device: string;
  requested_precision: string;
  requested_mode: string;
  requested_cpu_threads: number | null;
  fem_demag_solver_policy: Record<string, unknown> | null;
  demag_realization: string | null;
  external_field: [number, number, number] | null;
  solver: ScriptBuilderSolverState;
  universe_mesh: ScriptBuilderUniverseState | null;
  shared_domain_mesh: ScriptBuilderMeshState;
  mesh_defaults: ScriptBuilderMeshState;
  stages: ScriptBuilderStageState[];
  study_pipeline: StudyPipelineDocumentState | null;
  initial_state: ScriptBuilderInitialState | null;
}

export interface ModelBuilderGraphUniverseNode {
  id: "universe";
  kind: "universe";
  label: string;
  value: ScriptBuilderUniverseState | null;
}

export interface ModelBuilderGraphObjectsNode {
  id: "objects";
  kind: "objects";
  label: string;
  items: ModelBuilderGraphObjectNode[];
}

export interface ModelBuilderGraphCurrentModulesNode {
  id: "current_modules";
  kind: "current_modules";
  label: string;
  modules: ScriptBuilderCurrentModuleEntry[];
  excitation_analysis: ScriptBuilderExcitationAnalysisEntry | null;
}

export interface ModelBuilderGraphV2 {
  version: "model_builder.v2";
  source_of_truth: "repo_head";
  authoring_schema: "mesh-first-fem.v1";
  revision: number;
  study: ModelBuilderGraphStudyNode;
  universe: ModelBuilderGraphUniverseNode;
  objects: ModelBuilderGraphObjectsNode;
  current_modules: ModelBuilderGraphCurrentModulesNode;
}

export interface SceneMetadata {
  id: string;
  name: string;
  source_of_truth?: "repo_head";
  authoring_schema?: string;
}

export interface Transform3D {
  translation: [number, number, number];
  rotation_quat: [number, number, number, number];
  scale: [number, number, number];
  pivot: [number, number, number];
}

export interface TextureTransform3D {
  translation: [number, number, number];
  rotation_quat: [number, number, number, number];
  scale: [number, number, number];
  pivot: [number, number, number];
}

export interface MagnetizationMapping {
  space: string;
  projection: string;
  clamp_mode: string;
}

export interface SceneGeometry {
  geometry_kind: string;
  geometry_params: Record<string, unknown>;
  bounds_min?: [number, number, number] | null;
  bounds_max?: [number, number, number] | null;
  preset_kind?: string | null;
  preset_params?: Record<string, unknown> | null;
  preset_version?: number | null;
}

export interface SceneObject {
  id: string;
  name: string;
  geometry: SceneGeometry;
  transform: Transform3D;
  material_ref: string;
  region_name: string | null;
  magnetization_ref: string | null;
  physics_stack?: ScriptBuilderMagneticInteractionEntry[];
  object_mesh: ScriptBuilderPerGeometryMeshEntry | null;
  mesh_override: ScriptBuilderPerGeometryMeshEntry | null;
  visible: boolean;
  locked: boolean;
  tags: string[];
}

export interface SceneMaterialAsset {
  id: string;
  name: string;
  properties: ScriptBuilderMaterialEntry;
}

export interface MagnetizationAsset {
  id: string;
  name: string;
  kind: string;
  value: number[] | null;
  seed: number | null;
  source_path: string | null;
  source_format: string | null;
  dataset: string | null;
  sample_index: number | null;
  mapping: MagnetizationMapping;
  texture_transform: TextureTransform3D;
  preset_kind: string | null;
  preset_params: Record<string, unknown> | null;
  preset_version: number | null;
  ui_label: string | null;
}

/** @deprecated Use MagnetizationAsset.preset_params directly. */
export interface MagnetizationPresetState {
  preset_kind: string;
  preset_params: Record<string, unknown>;
  ui_label: string | null;
}

export interface TextureTransformState {
  translation: [number, number, number];
  rotation_quat: [number, number, number, number];
  scale: [number, number, number];
  pivot: [number, number, number];
}

export interface SceneCurrentModulesState {
  modules: ScriptBuilderCurrentModuleEntry[];
  excitation_analysis: ScriptBuilderExcitationAnalysisEntry | null;
}

export interface SceneStudyState {
  backend: string | null;
  requested_backend: string;
  requested_device: string;
  requested_precision: string;
  requested_mode: string;
  requested_cpu_threads: number | null;
  fem_demag_solver_policy: Record<string, unknown> | null;
  demag_realization: string | null;
  external_field: [number, number, number] | null;
  solver: ScriptBuilderSolverState;
  universe_mesh: ScriptBuilderUniverseState | null;
  shared_domain_mesh: ScriptBuilderMeshState;
  mesh_defaults: ScriptBuilderMeshState;
  stages: ScriptBuilderStageState[];
  study_pipeline: StudyPipelineDocumentState | null;
  initial_state: ScriptBuilderInitialState | null;
}

export interface SceneOutputsState {
  items: Record<string, unknown>[];
}

export interface SceneEditorMeshEntityViewState {
  visible: boolean;
  render_mode: "surface" | "surface+edges" | "wireframe" | "mesh" | "points";
  opacity: number;
  color_field:
    | "orientation"
    | "x"
    | "y"
    | "z"
    | "magnitude"
    | "quality"
    | "sicn"
    | "none";
}

export type VisualizationPresetMode = "3D" | "2D";
export type VisualizationPresetDomain = "fem" | "fdm";
export type VisualizationPresetSource = "project" | "local";
export type VisualizationArrowColorMode =
  | "orientation"
  | "x"
  | "y"
  | "z"
  | "magnitude"
  | "monochrome";
export type FemVectorDomainFilter =
  | "auto"
  | "magnetic_only"
  | "full_domain"
  | "airbox_only";
export type FemFerromagnetVisibilityMode = "hide" | "ghost";

export interface VisualizationCameraState {
  projection: "perspective" | "orthographic" | null;
  navigation: "trackball" | "cad" | null;
  preset: "reset" | "front" | "top" | "right" | "iso" | null;
}

export interface VisualizationPresetFemState {
  render_mode: "surface" | "surface+edges" | "wireframe" | "mesh" | "points";
  opacity: number;
  clip_enabled: boolean;
  clip_axis: "x" | "y" | "z";
  clip_pos: number;
  show_arrows: boolean;
  max_points: number;
  arrow_color_mode: VisualizationArrowColorMode;
  arrow_mono_color: string;
  arrow_alpha: number;
  arrow_length_scale: number;
  arrow_thickness: number;
  object_view_mode: "context" | "isolate";
  vector_domain_filter: FemVectorDomainFilter;
  ferromagnet_visibility_mode: FemFerromagnetVisibilityMode;
  air_mesh_visible: boolean;
  air_mesh_opacity: number;
  mesh_entity_view_state: Record<string, SceneEditorMeshEntityViewState>;
}

export interface VisualizationPresetFdmState {
  quality: "low" | "high" | "ultra";
  render_mode: "glyph" | "voxel";
  voxel_color_mode: "orientation" | "x" | "y" | "z";
  sampling: 1 | 2 | 4;
  brightness: number;
  voxel_opacity: number;
  voxel_gap: number;
  voxel_threshold: number;
  topo_enabled: boolean;
  topo_component: "x" | "y" | "z";
  topo_multiplier: number;
}

export interface VisualizationPreset2DState {
  component: "x" | "y" | "z" | "magnitude";
  plane: "xy" | "xz" | "yz";
  slice_index: number;
}

export interface VisualizationPreset {
  id: string;
  name: string;
  mode: VisualizationPresetMode;
  domain: VisualizationPresetDomain;
  quantity: string;
  fem: VisualizationPresetFemState;
  fdm: VisualizationPresetFdmState;
  two_d: VisualizationPreset2DState;
  camera: VisualizationCameraState;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
}

export interface VisualizationPresetRef {
  source: VisualizationPresetSource;
  preset_id: string;
}

export interface SceneEditorState {
  selected_object_id: string | null;
  gizmo_mode: string | null;
  transform_space: string | null;
  selected_entity_id: string | null;
  focused_entity_id: string | null;
  object_view_mode: "context" | "isolate" | null;
  vector_domain_filter: FemVectorDomainFilter | null;
  ferromagnet_visibility_mode: FemFerromagnetVisibilityMode | null;
  air_mesh_visible: boolean | null;
  air_mesh_opacity: number | null;
  mesh_entity_view_state: Record<string, SceneEditorMeshEntityViewState>;
  visualization_presets: VisualizationPreset[];
  active_visualization_preset_ref: VisualizationPresetRef | null;
  /** "object" | "texture" | null — which gizmo scope is active for the selected object */
  active_transform_scope: "object" | "texture" | null;
}

export interface SceneDocument {
  version: "scene.v1";
  revision: number;
  scene: SceneMetadata;
  universe: ScriptBuilderUniverseState | null;
  objects: SceneObject[];
  materials: SceneMaterialAsset[];
  magnetization_assets: MagnetizationAsset[];
  current_modules: SceneCurrentModulesState;
  study: SceneStudyState;
  outputs: SceneOutputsState;
  editor: SceneEditorState;
}

export interface MeshSummaryState {
  mesh_id: string | null;
  mesh_name: string;
  mesh_source: string | null;
  backend: string;
  source_kind: string;
  order: number;
  hmax: number;
  node_count: number;
  element_count: number;
  boundary_face_count: number;
  bounds_min: [number, number, number] | null;
  bounds_max: [number, number, number] | null;
  mesh_extent: [number, number, number] | null;
  world_extent: [number, number, number] | null;
  world_center: [number, number, number] | null;
  world_extent_source: string | null;
  domain_frame: DomainFrameState | null;
  domain_mesh_mode: string | null;
  generation_id: string;
}

export interface MeshQualitySummaryState {
  n_elements: number;
  sicn_min: number;
  sicn_max: number;
  sicn_mean: number;
  sicn_p5: number;
  gamma_min: number;
  gamma_mean: number;
  avg_quality: number;
}

export interface MeshPipelinePhaseState {
  id: string;
  label: string;
  status: "idle" | "active" | "done" | "warning" | "queued" | "failed";
  detail: string | null;
}

export interface MeshCapabilitiesState {
  has_volume_mesh: boolean;
  has_quality_arrays: boolean;
  supports_adaptive_remesh: boolean;
  supports_compare_snapshots: boolean;
  supports_size_field_remesh: boolean;
  supports_mesh_error_preview: boolean;
  supports_target_h_preview: boolean;
}

export interface MeshAdaptivityState {
  enabled: boolean;
  policy: string;
  pass_count: number;
  max_passes: number;
  convergence_status: string;
  last_target_h_summary: Record<string, unknown> | null;
}

export interface MeshHistoryEntryState {
  mesh_name: string;
  generation_mode: string | null;
  node_count: number;
  element_count: number;
  boundary_face_count: number;
  kind?: string;
  quality?: Record<string, unknown> | null;
  mesh_provenance?: Record<string, unknown> | null;
  size_field_stats?: Record<string, unknown> | null;
}

export interface MeshEffectiveAirboxTargetState {
  hmax: number | null;
  hmin: number | null;
  growth_rate: number | null;
}

export interface MeshEffectiveObjectTargetState {
  marker: number | null;
  hmax: number | null;
  interface_hmax: number | null;
  transition_distance: number | null;
  source: string | null;
}

export interface MeshWorkspaceManifestRegionState {
  region_id: string;
  name: string;
  source_object_ids: string[];
  source_region_candidate_id: string | null;
  material_ref: string;
  magnetization_ref: string | null;
  mesh_part_ids: string[];
  element_count: number | null;
  cell_count: number | null;
  bounds_min: [number, number, number] | null;
  bounds_max: [number, number, number] | null;
}

export interface MeshWorkspaceSharedDomainManifestState {
  source_scene_revision: number | null;
  geometry_realization_revision: number | null;
  mesh_name: string;
  mesh_id: string;
  generation_id: string | null;
  domain_mesh_mode: string | null;
  object_segment_count: number;
  mesh_part_count: number;
  regions: MeshWorkspaceManifestRegionState[];
}

export interface MeshWorkspaceState {
  mesh_summary: MeshSummaryState | null;
  mesh_quality_summary: MeshQualitySummaryState | null;
  mesh_statistics: Record<string, unknown> | null;
  shared_domain_manifest: MeshWorkspaceSharedDomainManifestState | null;
  mesh_pipeline_status: MeshPipelinePhaseState[];
  mesh_capabilities: MeshCapabilitiesState | null;
  mesh_adaptivity_state: MeshAdaptivityState | null;
  mesh_history: MeshHistoryEntryState[];
  // Commit 4: build contract extensions
  active_build: MeshBuildIntent | null;
  effective_airbox_target: MeshEffectiveAirboxTargetState | null;
  effective_per_object_targets: Record<string, MeshEffectiveObjectTargetState> | null;
  last_build_summary: Record<string, unknown> | null;
  last_build_error: string | null;
}

export interface SessionState {
  state_version?: number;
  session_protocol_version?: string;
  capability_profile_version?: string;
  session: SessionManifest;
  run: RunManifest | null;
  live_state: LiveState | null;
  runtime_status: RuntimeStatusState | null;
  capabilities?: BackendCapabilities | null;
  metadata: SessionMetadata | null;
  mesh_workspace: MeshWorkspaceState | null;
  stage_execution: StageExecutionState | null;
  scene_document: SceneDocument | null;
  script_builder: ScriptBuilderState | null;
  model_builder_graph: ModelBuilderGraphV2 | null;
  scalar_rows: ScalarRow[];
  /** Total number of scalar rows accumulated server-side (including history not in this payload). */
  scalar_rows_total?: number;
  engine_log: EngineLogEntry[];
  /** Omitted in WS delta events when quantities haven't changed since last broadcast. */
  quantities: QuantityDescriptor[];
  fem_mesh: FemLiveMesh | null;
  latest_fields: LatestFields;
  artifacts: ArtifactEntry[];
  display_selection: CurrentDisplaySelection | null;
  preview_config: PreviewConfig | null;
  preview: PreviewState | null;
  command_status: CommandStatus | null;
  /** V2 canonical step representation (Q16/Q17). Present when live_state has a latest step. */
  step_update_v2?: StepUpdateV2 | null;
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface UseSessionStreamResult {
  state: SessionState | null;
  connection: ConnectionStatus;
  error: string | null;
  refresh: () => Promise<void>;
}

/* ── StepUpdateV2 canonical types (Q16/Q17) ── */

/** Solver-internal telemetry for one integration step. */
export interface StepDiagnostics {
  step: number;
  time: number;
  dt: number;
  wall_time_ns: number;
  exchange_wall_time_ns?: number;
  demag_wall_time_ns?: number;
  rhs_wall_time_ns?: number;
  extra_energy_wall_time_ns?: number;
  snapshot_wall_time_ns?: number;
  error_estimate?: number | null;
  dt_suggested?: number | null;
  rejected_attempts?: number;
  rhs_evals?: number;
  demag_solves?: number;
  fsal_reused?: boolean;
}

/** Per-step physical scalar observations. */
export interface GlobalQuantityRow {
  step: number;
  time: number;
  mx: number;
  my: number;
  mz: number;
  e_ex: number;
  e_demag: number;
  e_ext: number;
  e_ani: number;
  e_dmi: number;
  e_total: number;
  max_dm_dt: number;
  max_h_eff: number;
  max_h_demag: number;
  max_torque_Apm?: number;
  max_torque_T?: number;
  per_object_scalars?: Record<string, Record<string, number>>;
}

/** A single live spatial quantity frame. */
export interface LiveQuantityFrame {
  quantity_id: string;
  unit: string;
  grid: [number, number, number];
  n_comp: number;
  values: number[];
  active_mask?: boolean[] | null;
  topology_signature?: string | null;
  field_revision?: number | null;
  source_step?: number | null;
  source_time?: number | null;
}

/** V2 step update — cleanly separates diagnostics, scalars, and spatial frames. */
export interface StepUpdateV2 {
  diagnostics: StepDiagnostics;
  scalars: GlobalQuantityRow;
  frames: LiveQuantityFrame[];
  finished: boolean;
}
