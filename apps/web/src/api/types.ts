/**
 * Canonical TypeScript types for the resource-first Fullmag live API.
 *
 * These interfaces mirror the backend schemas from `crates/fullmag-api/src/schemas`.
 */

// ── Status ────────────────────────────────────────────────────────────

export interface LiveStatus {
  api_contract_version: string;
  runtime_bundle_version: string;
  session: SessionSummary;
  run: RunSummary | null;
  solver: SolverSummary;
  display: DisplaySelection;
  domain: DomainSummary;
  resources: ResourceRevisionMap;
  capabilities: CapabilityMap;
  energies: EnergySummary;
  metrics: MetricsSummary;
}

export interface SessionSummary {
  session_id: string;
  name: string;
  created_at: string;
  workspace_root: string;
}

export interface RunSummary {
  run_id: string;
  stage_index: number;
  stage_label: string;
  stage_count: number;
  started_at: string;
  solver_steps: number;
  solver_time: number;
}

export interface SolverSummary {
  state: string;
  algorithm: string | null;
  dt: number | null;
  max_torque: number | null;
  converged: boolean | null;
}

export interface DisplaySelection {
  active_quantity_id: string;
  view_mode: "2d" | "3d";
  field_component: "x" | "y" | "z" | "magnitude";
  colormap: string;
  auto_contrast: boolean;
  contrast_min: number | null;
  contrast_max: number | null;
  vector_glyphs: boolean;
  vector_density: number;
  slice_mode: string;
  slice_layer: number;
  max_points: number;
  x_chosen_size: number;
  y_chosen_size: number;
}

export interface VisualizationStateResource extends DisplaySelection {
  revision: number;
  schema_version: number;
}

export interface DomainSummary {
  generation_id: number;
  discretization: string;
  cell_count: number;
}

export interface ResourceRevisionMap {
  topology_revision?: number;
  field_catalog_revision?: number;
  field_revision?: number;
  slice_revision?: number;
  artifact_revision?: number;
  command_completion_revision?: number;
  fields_revision: number;
  scalars_revision: number;
  domain_generation_id: number;
  artifacts_revision: number;
  engine_log_revision: number;
  display_revision: number;
  visualization_state_revision: number;
  workspace_revision: number;
  mesh_revision: number;
  mesh_build_revision: number;
  commands_revision: number;
  stages_revision: number;
  scene_revision?: number | null;
}

export interface BinaryResourceResponse {
  buffer: ArrayBuffer;
  headers: Headers;
  status: number;
}

export interface JsonResourceResponse<T> {
  data: T | null;
  headers: Headers;
  status: number;
}

export interface CapabilityMap {
  structured_grid: boolean;
  explicit_topology: boolean;
  binary_fields: boolean;
  cell_fields: boolean;
  node_fields: boolean;
  scalar_history: boolean;
  eigen_modes: boolean;
  gpu_telemetry: boolean;
  preview_2d: boolean;
  preview_3d: boolean;
  algorithms_available: string[];
}

export interface EnergySummary {
  total: number | null;
  exchange: number | null;
  demag: number | null;
  zeeman: number | null;
  anisotropy: number | null;
  dmi: number | null;
}

export interface MetricsSummary {
  uptime_seconds: number;
  total_steps: number;
  steps_per_second: number | null;
}

// ── Field component selection ────────────────────────────────────────

/** Component selector for 3-D field vectors. Mirrors `ComponentSelection` in Rust. */
export type FieldComponent =
  | "full"
  | "magnitude"
  | "x"
  | "y"
  | "z"
  | `c${number}`;

export type FieldSampleScopeKind = "full" | "object" | "part" | "airbox" | "selection";

/** Query options when requesting a field vector binary buffer. */
export interface FieldVectorOptions {
  component?: FieldComponent;
  scope_kind?: FieldSampleScopeKind;
  scope_id?: string;
  /** ETag from a previous response; triggers If-None-Match/304 caching. */
  etag?: string;
}

// ── Field slice (2-D) ────────────────────────────────────────────────

export type SlicePlane = "xy" | "xz" | "yz";

/**
 * Query parameters for a 2-D field slice request.
 * All sizing values are in world-space units (metres) except `max_points` and `arrow_every`.
 */
export interface FieldSliceQuery {
  plane: SlicePlane;
  component?: FieldComponent;
  /** World-space coordinate of the cut. Mutually exclusive with `cut_norm`. */
  cut_world?: number;
  /** Normalised [0, 1] position along the perpendicular axis. */
  cut_norm?: number;
  x_size?: number;
  y_size?: number;
  max_points?: number;
  include_arrows?: boolean;
  arrow_every?: number;
  max_arrows?: number;
}

/** JSON metadata returned from `/fields/{id}/slice/meta`. */
export interface FieldSliceMeta {
  quantity_id: string;
  plane: SlicePlane;
  component: string;
  cut_kind: "normalized" | "world";
  cut_norm: number;
  cut_world: number | null;
  field_revision: number;
  domain_generation_id: number;
  sampling_method: string;
  etag: string;
  slice_revision: string;
  x_pixels: number;
  y_pixels: number;
  grid: FieldSliceGrid;
  bounds: FieldSliceBounds | null;
  scalar: FieldSliceBinaryDescriptor;
  arrows: FieldSliceBinaryDescriptor;
}

export interface FieldSliceGrid {
  x_size: number;
  y_size: number;
  point_count: number;
}

export interface FieldSliceBounds {
  u_min: number;
  u_max: number;
  v_min: number;
  v_max: number;
}

export interface FieldSliceBinaryDescriptor {
  available: boolean;
  n_comp: number;
  point_count: number;
  min: number | null;
  max: number | null;
  etag: string | null;
  href: string | null;
}

/**
 * Binary response wrapper that carries optional ETag and HTTP status.
 * Extends `BinaryResourceResponse` to allow a null buffer on 304.
 */
export interface FieldBinaryResponse {
  /** null when status is 304 (Not Modified). */
  buffer: ArrayBuffer | null;
  etag: string | null;
  status: 200 | 304;
  headers: Headers;
}

// ── Realtime websocket ───────────────────────────────────────────────

export type RealtimeResourceName =
  | "display"
  | "visualization_state"
  | "workspace"
  | "fields"
  | "scalars"
  | "domain"
  | "artifacts"
  | "logs"
  | "mesh"
  | "mesh_builds"
  | "commands"
  | "stages"
  | "scene_document";

export interface RealtimeResourceRevisionMap {
  topology_revision?: number;
  field_catalog_revision?: number;
  field_revision?: number;
  slice_revision?: number;
  artifact_revision?: number;
  command_completion_revision?: number;
  fields_revision: number;
  scalars_revision: number;
  domain_generation_id: number;
  artifacts_revision: number;
  engine_log_revision: number;
  display_revision: number;
  visualization_state_revision: number;
  workspace_revision: number;
  mesh_revision: number;
  mesh_build_revision: number;
  commands_revision: number;
  stages_revision: number;
  scene_revision?: number | null;
}

// ── Workspace ────────────────────────────────────────────────────────

export interface WorkspaceSelectionResource {
  revision: number;
  selected_node_id?: string | null;
  selected_object_id?: string | null;
  selected_entity_id?: string | null;
}

export interface WorkspaceSelectionReplaceRequest {
  selected_node_id?: string | null;
  selected_object_id?: string | null;
  selected_entity_id?: string | null;
}

export interface WorkspaceActiveNodeResource {
  revision: number;
  node_id?: string | null;
}

export interface WorkspaceActiveNodeReplaceRequest {
  node_id?: string | null;
}

export interface WorkspaceRibbonResource {
  revision: number;
  workspace_mode: string;
  active_core_tab: string;
  active_contextual_tab?: string | null;
}

export interface WorkspaceRibbonReplaceRequest {
  workspace_mode: string;
  active_core_tab: string;
  active_contextual_tab?: string | null;
}

export interface WorkspaceStageLayout {
  left_dock?: string | null;
  center_dock?: string | null;
  right_dock?: string | null;
  bottom_dock?: string | null;
}

export interface WorkspaceLayoutResource {
  revision: number;
  current_stage: string;
  stage_layouts: Record<string, WorkspaceStageLayout>;
  active_workspace_tab_by_stage: Record<string, string | null>;
}

export interface WorkspaceLayoutReplaceRequest {
  current_stage: string;
  stage_layouts: Record<string, WorkspaceStageLayout>;
  active_workspace_tab_by_stage: Record<string, string | null>;
}

export interface RealtimeResourceChange {
  resource: RealtimeResourceName;
  revision: number;
  resource_id?: string | null;
  domain_generation_id?: number | null;
  recommended_fetch?: string | null;
}

export interface RealtimeHelloPayload {
  server_time: string;
  replay_available_after_seq: number;
  current_seq: number;
  resource_revisions: RealtimeResourceRevisionMap;
}

export interface RealtimeHeartbeatPayload {
  current_seq: number;
}

export interface RealtimeResourceBatchChangedPayload {
  changes: RealtimeResourceChange[];
  coalesced: boolean;
  window_ms: number;
}

export interface RealtimeResyncRequiredPayload {
  reason: string;
  expected_after?: number | null;
  replay_available_after_seq: number;
}

interface RealtimeEnvelopeBase {
  seq: number;
  ts: string;
  session_id: string;
  run_id?: string | null;
  contract_version: string;
}

export interface RealtimeHelloEvent extends RealtimeEnvelopeBase {
  type: "hello";
  payload: RealtimeHelloPayload;
}

export interface RealtimeHeartbeatEvent extends RealtimeEnvelopeBase {
  type: "heartbeat";
  payload: RealtimeHeartbeatPayload;
}

export interface RealtimeResourceBatchChangedEvent extends RealtimeEnvelopeBase {
  type: "resource.batch_changed";
  payload: RealtimeResourceBatchChangedPayload;
}

export interface RealtimeResyncRequiredEvent extends RealtimeEnvelopeBase {
  type: "resync.required";
  payload: RealtimeResyncRequiredPayload;
}

export type LiveRealtimeEvent =
  | RealtimeHelloEvent
  | RealtimeHeartbeatEvent
  | RealtimeResourceBatchChangedEvent
  | RealtimeResyncRequiredEvent;

// ── Logs ─────────────────────────────────────────────────────────────

export interface EngineLogEntry {
  timestamp_unix_ms: number;
  level: string;
  message: string;
}

export interface EngineLogResource {
  revision: number;
  total: number;
  entries: EngineLogEntry[];
}

// ── Domain ────────────────────────────────────────────────────────────

export interface DomainMeta {
  domain_id: string;
  discretization: string;
  generation_id: number;
  dimension: number;
  coordinate_system: string;
  units: Record<string, string>;
  bounds: Bounds3;
  counts: DomainCounts;
  grid?: StructuredGridDescriptor | null;
  element_type: string | null;
}

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

export interface DomainCounts {
  cells?: number | null;
  nodes?: number | null;
  elements?: number | null;
  boundary_faces?: number | null;
}

export interface StructuredGridDescriptor {
  shape: [number, number, number];
  origin: [number, number, number];
  spacing: [number, number, number];
}

// ── Fields ────────────────────────────────────────────────────────────

export interface FieldCatalog {
  revision: number;
  domain_generation_id: number;
  quantities: FieldDescriptor[];
}

export interface FieldDescriptor {
  quantity_id: string;
  label: string;
  kind: string;
  components: number;
  location: string;
  unit: string;
  field_revision: number;
  domain_generation_id: number;
  available: boolean;
}

export interface FieldMeta {
  quantity_id: string;
  label: string;
  kind: string;
  components: number;
  location: string;
  unit: string;
  field_revision: number;
  domain_generation_id: number;
  stats: FieldStats | null;
}

export interface FieldStats {
  min: number;
  max: number;
  mean: number;
}

// ── Scalars ───────────────────────────────────────────────────────────

export interface ScalarWindow {
  revision: number;
  total_rows: number;
  returned_rows: number;
  columns: string[];
  rows: number[][];
}

// ── Display update ────────────────────────────────────────────────────

export type DisplayReplaceRequest = DisplaySelection;

export interface DisplayPatchRequest {
  active_quantity_id?: string;
  view_mode?: "2d" | "3d";
  field_component?: "x" | "y" | "z" | "magnitude";
  colormap?: string;
  auto_contrast?: boolean;
  contrast_min?: number | null;
  contrast_max?: number | null;
  vector_glyphs?: boolean;
  vector_density?: number;
  slice_mode?: string;
  slice_layer?: number;
  max_points?: number;
  x_chosen_size?: number;
  y_chosen_size?: number;
}

export type VisualizationStatePatch = DisplayPatchRequest;

// ── Commands ──────────────────────────────────────────────────────────

export type MeshConfigRecord = Record<string, unknown>;
export type MeshWorkspaceRecord = Record<string, unknown>;
export type MeshReportRecord = Record<string, unknown>;
export type MeshQualityRecord = Record<string, unknown>;

export interface MeshSummaryResource {
  revision: number;
  mesh_summary?: MeshWorkspaceRecord | null;
  mesh_quality_summary?: MeshWorkspaceRecord | null;
  effective_airbox_target?: MeshWorkspaceRecord | null;
  effective_per_object_targets?: MeshWorkspaceRecord | null;
}

export interface MeshCapabilitiesResource {
  revision: number;
  mesh_capabilities?: MeshWorkspaceRecord | null;
  mesh_adaptivity_state?: MeshWorkspaceRecord | null;
}

export interface MeshObjectConfigEntry {
  object_id: string;
  object_name: string;
  config?: MeshConfigRecord | null;
}

export interface MeshSolverMeshResource {
  mesh_name: string;
  mesh_id: string;
  generation_id?: string | null;
  domain_mesh_mode?: string | null;
  object_segment_count: number;
  mesh_part_count: number;
}

export interface MeshBuildDiagnosticsResource {
  mesh_quality_summary?: MeshQualityRecord | null;
  mesh_statistics?: MeshReportRecord | null;
  last_build_summary?: MeshWorkspaceRecord | null;
  mesh_pipeline_status?: unknown;
  last_build_error?: string | null;
}

export interface MeshSemanticsResource {
  revision: number;
  universe_config?: MeshConfigRecord | null;
  shared_domain_config: MeshConfigRecord;
  object_configs: MeshObjectConfigEntry[];
  solver_mesh?: MeshSolverMeshResource | null;
  mesh_build_diagnostics?: MeshBuildDiagnosticsResource | null;
  render_only_controls_do_not_change_solver_domain: boolean;
}

export interface MeshUniverseConfigResource {
  revision: number;
  config?: MeshConfigRecord | null;
}

export interface MeshUniverseConfigReplaceRequest {
  config: MeshConfigRecord;
}

export interface MeshUniverseReportResource {
  revision: number;
  report?: MeshReportRecord | null;
}

export interface MeshUniverseQualityResource {
  revision: number;
  quality?: MeshQualityRecord | null;
}

export interface MeshSharedDomainConfigResource {
  revision: number;
  config: MeshConfigRecord;
}

export interface MeshSharedDomainConfigReplaceRequest {
  config: MeshConfigRecord;
}

export interface MeshSharedDomainReportResource {
  revision: number;
  report?: MeshReportRecord | null;
}

export interface MeshSharedDomainQualityResource {
  revision: number;
  quality?: MeshQualityRecord | null;
}

export interface MeshObjectSegmentEntry {
  object_id: string;
  geometry_id?: string | null;
  node_start: number;
  node_count: number;
  element_start: number;
  element_count: number;
  boundary_face_start: number;
  boundary_face_count: number;
}

export interface MeshPartEntry {
  id: string;
  label: string;
  role: "air" | "magnetic_object" | "interface" | "outer_boundary" | string;
  object_id?: string | null;
  geometry_id?: string | null;
  material_id?: string | null;
  element_start: number;
  element_count: number;
  boundary_face_start: number;
  boundary_face_count: number;
  boundary_face_indices: number[];
  node_start: number;
  node_count: number;
  node_indices: number[];
  surface_faces: [number, number, number][];
  bounds_min?: [number, number, number] | null;
  bounds_max?: [number, number, number] | null;
}

export interface MeshRegionEntry {
  region_id: string;
  name: string;
  source_object_ids: string[];
  source_region_candidate_id?: string | null;
  material_ref: string;
  magnetization_ref?: string | null;
  mesh_part_ids: string[];
  element_count?: number | null;
  cell_count?: number | null;
  bounds_min?: [number, number, number] | null;
  bounds_max?: [number, number, number] | null;
}

export interface MeshSharedDomainManifestResource {
  revision: number;
  source_scene_revision?: number | null;
  geometry_realization_revision?: number | null;
  mesh_name: string;
  mesh_id: string;
  generation_id?: string | null;
  domain_mesh_mode?: string | null;
  object_segments: MeshObjectSegmentEntry[];
  mesh_parts: MeshPartEntry[];
  regions: MeshRegionEntry[];
}

export interface MeshObjectConfigResource {
  revision: number;
  object_id: string;
  config?: MeshConfigRecord | null;
}

export interface MeshObjectConfigReplaceRequest {
  config?: MeshConfigRecord | null;
}

export interface MeshObjectReportResource {
  revision: number;
  object_id: string;
  report?: MeshReportRecord | null;
}

export interface MeshObjectQualityResource {
  revision: number;
  object_id: string;
  quality?: MeshQualityRecord | null;
}

export interface MeshObjectSizeFieldResource {
  revision: number;
  object_id: string;
  size_field?: MeshWorkspaceRecord | null;
}

export interface MeshInterfaceConfigResource {
  revision: number;
  interface_id: string;
  config?: MeshConfigRecord | null;
}

export interface MeshInterfaceConfigReplaceRequest {
  config?: MeshConfigRecord | null;
  owner_a?: string | null;
  owner_b?: string | null;
}

export interface MeshInterfaceReportResource {
  revision: number;
  interface_id: string;
  report?: MeshReportRecord | null;
}

export interface MeshInterfaceQualityResource {
  revision: number;
  interface_id: string;
  quality?: MeshQualityRecord | null;
}

export interface MeshActiveBuildResource {
  revision: number;
  active_build?: MeshWorkspaceRecord | null;
  mesh_pipeline_status?: MeshWorkspaceRecord | null;
  effective_airbox_target?: MeshWorkspaceRecord | null;
  effective_per_object_targets?: MeshWorkspaceRecord | null;
  last_build_summary?: MeshWorkspaceRecord | null;
  last_build_error?: string | null;
}

export interface MeshBuildHistoryResource {
  revision: number;
  history: MeshWorkspaceRecord[];
}

export interface MeshLastSuccessfulBuildResource {
  revision: number;
  last_success?: MeshWorkspaceRecord | null;
  effective_airbox_target?: MeshWorkspaceRecord | null;
  effective_per_object_targets?: MeshWorkspaceRecord | null;
  last_build_error?: string | null;
}

export type MeshCommandTargetRequest =
  | { kind: "study_domain" }
  | { kind: "adaptive_followup" }
  | { kind: "airbox" }
  | { kind: "object_mesh"; object_id: string };

export interface MeshBuildCommandRequest {
  mesh_options?: unknown;
  mesh_target?: MeshCommandTargetRequest;
  mesh_reason?: string;
}

export interface RunCommandRequest {
  kind: "run";
  until_seconds: number;
  max_steps?: number;
  integrator?: string;
  fixed_timestep?: number;
}

export interface RelaxCommandRequest {
  kind: "relax";
  until_seconds?: number;
  max_steps?: number;
  torque_tolerance?: number;
  energy_tolerance?: number;
  relax_algorithm?: string;
  relax_alpha?: number;
  fixed_timestep?: number;
  max_error?: number;
}

export interface PauseCommandRequest {
  kind: "pause";
}

export interface ResumeCommandRequest {
  kind: "resume";
}

export interface StopCommandRequest {
  kind: "stop";
}

export interface SkipCommandRequest {
  kind: "skip";
}

export interface SaveVtkCommandRequest {
  kind: "save_vtk";
}

export interface SolveCommandRequest {
  kind: "solve";
}

export interface ComputeFieldsCommandRequest {
  kind: "compute_fields";
}

export interface CloseCommandRequest {
  kind: "close";
}

export interface MeshBuildStructuredCommandRequest extends MeshBuildCommandRequest {
  kind: "mesh_build";
}

export type StructuredCommandRequest =
  | RunCommandRequest
  | RelaxCommandRequest
  | PauseCommandRequest
  | ResumeCommandRequest
  | StopCommandRequest
  | SkipCommandRequest
  | SaveVtkCommandRequest
  | SolveCommandRequest
  | ComputeFieldsCommandRequest
  | CloseCommandRequest
  | MeshBuildStructuredCommandRequest;

export type CommandRequest = StructuredCommandRequest;

export interface CommandResponse {
  accepted: boolean;
  command_id: string;
  error?: string | null;
}

export interface CommandQueueStatus {
  revision: number;
  pending_count: number;
  accepted_count: number;
  dispatched_count: number;
  running_count: number;
  completed_count: number;
  rejected_count: number;
  failed_count: number;
  can_accept_commands: boolean;
  commands: CommandStatus[];
}

export type CommandCompletionOutcome =
  | "succeeded"
  | "completed"
  | "cancelled"
  | "rejected"
  | "failed"
  | "unknown";

export type CommandCompletionState = CommandCompletionOutcome;

export interface CommandStatus {
  command_id: string;
  seq: number;
  kind: string;
  status: "queued" | "accepted" | "dispatched" | "running" | "completed" | "rejected" | "failed";
  created_at_unix_ms: number;
  dispatched_at_unix_ms?: number | null;
  completed_at_unix_ms?: number | null;
  completion_status?: CommandCompletionOutcome | null;
  error?: string | null;
}

export interface CommandDetail {
  command_id: string;
  seq: number;
  kind: string;
  status: "queued" | "accepted" | "dispatched" | "running" | "completed" | "rejected" | "failed";
  created_at_unix_ms: number;
  dispatched_at_unix_ms?: number | null;
  completed_at_unix_ms?: number | null;
  completion_status?: CommandCompletionOutcome | null;
  error?: string | null;
  until_seconds?: number | null;
  max_steps?: number | null;
  torque_tolerance?: number | null;
  energy_tolerance?: number | null;
  integrator?: string | null;
  fixed_timestep?: number | null;
  max_error?: number | null;
  relax_algorithm?: string | null;
  relax_alpha?: number | null;
  mesh_target?: MeshCommandTargetRequest | null;
  mesh_reason?: string | null;
}

export interface ScriptSyncRequest {
  overrides?: unknown;
}

export interface ScriptSyncResponse {
  script_path: string;
  source_kind: string;
  entrypoint_kind: string;
  written: boolean;
  bytes_written: number;
}

export interface ScriptSourceResponse {
  script_path: string;
  source: string;
  bytes: number;
}

export interface ScenePatchRequest {
  merge_patch: Record<string, unknown>;
}

export interface AuthoringStudyRuntimeResource {
  backend: string | null;
  requested_backend: string;
  requested_device: string;
  requested_precision: string;
  requested_mode: string;
  requested_cpu_threads: number | null;
}

export interface AuthoringStudyRuntimePatchRequest {
  requested_backend?: string;
  requested_device?: string;
  requested_precision?: string;
  requested_mode?: string;
  requested_cpu_threads?: number | null;
}

export interface AuthoringMaterialPropertiesResource {
  Ms: number | null;
  Aex: number | null;
  alpha: number;
  Dind: number | null;
}

export interface AuthoringMaterialResource {
  id: string;
  name: string;
  properties: AuthoringMaterialPropertiesResource;
}

export interface AuthoringMaterialPropertiesPatchRequest {
  Ms?: number | null;
  Aex?: number | null;
  alpha?: number;
  Dind?: number | null;
}

export interface AuthoringMaterialPatchRequest {
  name?: string;
  properties?: AuthoringMaterialPropertiesPatchRequest;
}

export interface AuthoringObjectInteractionResource {
  object_id: string;
  interaction_kind: string;
  present: boolean;
  enabled: boolean;
  params: Record<string, unknown>;
}

export interface AuthoringObjectInteractionPatchRequest {
  present?: boolean;
  enabled?: boolean;
  params?: Record<string, unknown>;
}

export type GeometryBackendTarget = "fem" | "fdm";
export type GeometrySupportStatus = "production" | "preview" | "unsupported";
export type GeometryDiagnosticSeverity = "info" | "warning" | "error";

export interface GeometryDiagnostic {
  id: string;
  severity: GeometryDiagnosticSeverity;
  code: string;
  message: string;
  object_id?: string | null;
  geometry_path?: string | null;
  blocks: string[];
}

export interface PrimitiveGeometryCapability {
  id: string;
  label: string;
  category: string;
  fem: boolean;
  fdm: boolean;
  dsl: boolean;
  boolean: boolean;
  status: GeometrySupportStatus;
}

export interface BooleanGeometryCapability {
  op: "union" | "subtract" | "intersect" | string;
  fem: boolean;
  fdm: boolean;
  dsl: boolean;
  status: GeometrySupportStatus;
  notes: string;
}

export interface GeometryCapabilitiesResource {
  revision: number;
  primitive_capabilities: PrimitiveGeometryCapability[];
  csg_capabilities: BooleanGeometryCapability[];
}

export interface GeometryValidationResource {
  scene_revision: number;
  backend_target: GeometryBackendTarget;
  status: "ready" | "warning" | "blocked" | string;
  dirty: boolean;
  diagnostics: GeometryDiagnostic[];
}

export interface RealizedGeometryBody {
  object_id: string;
  object_name: string;
  geometry_kind: string;
  material_ref: string;
  magnetization_ref?: string | null;
  visible: boolean;
  status: string;
  bounds_min: [number, number, number];
  bounds_max: [number, number, number];
  provenance: string[];
}

export interface GeometryRegionCandidate {
  id: string;
  object_id: string;
  material_ref: string;
  magnetization_ref?: string | null;
  bounds_min: [number, number, number];
  bounds_max: [number, number, number];
  source_geometry_path: string;
}

export interface GeometryProvenanceEntry {
  object_id: string;
  geometry_path: string;
  source: string;
}

export interface GeometryRealizationSnapshot {
  source_scene_revision: number;
  realization_revision: number;
  backend_target: GeometryBackendTarget;
  status: "ready" | "warning" | "blocked" | string;
  bodies: RealizedGeometryBody[];
  bounds_min?: [number, number, number] | null;
  bounds_max?: [number, number, number] | null;
  diagnostics: GeometryDiagnostic[];
  region_candidates: GeometryRegionCandidate[];
  provenance: GeometryProvenanceEntry[];
}

export interface RegionResource {
  region_id: string;
  name: string;
  source: "object" | "csg_fragment" | "manual" | string;
  source_object_ids: string[];
  source_body_ids: string[];
  material_ref: string;
  magnetization_ref?: string | null;
  interaction_refs: string[];
  mesh_part_ids: string[];
  enabled: boolean;
  bounds_min: [number, number, number];
  bounds_max: [number, number, number];
}

export interface RegionListResource {
  scene_revision: number;
  geometry_realization_revision: number;
  regions: RegionResource[];
}

export interface RegionPatchRequest {
  name?: string;
  enabled?: boolean;
}

export interface GeometryDiagnosticsResource {
  scene_revision: number;
  backend_target: GeometryBackendTarget;
  status: string;
  diagnostics: GeometryDiagnostic[];
}

export interface ObjectCreateRequest {
  base_revision?: number;
  object_id: string;
  name: string;
  geometry: Record<string, unknown>;
  transform?: Record<string, unknown> | null;
  material_ref?: string | null;
  region_name?: string | null;
  magnetization_ref?: string | null;
  material_asset?: Record<string, unknown> | null;
  magnetization_asset?: Record<string, unknown> | null;
  universe?: Record<string, unknown> | null;
  study_universe_mesh?: Record<string, unknown> | null;
}

export interface ObjectPatchRequest {
  base_revision?: number;
  name?: string;
  visible?: boolean;
  material_ref?: string;
  region_name?: string;
  magnetization_ref?: string;
  geometry?: Record<string, unknown> | null;
  transform?: Record<string, unknown> | null;
}

export interface UniverseResource {
  scene_revision: number;
  universe?: Record<string, unknown> | null;
  study_universe_mesh?: Record<string, unknown> | null;
  object_bounds_min?: [number, number, number] | null;
  object_bounds_max?: [number, number, number] | null;
  mesh_dirty: boolean;
}

export interface UniversePatchRequest {
  base_revision?: number;
  universe: Record<string, unknown>;
  sync_study_universe_mesh?: boolean;
}

export interface UniverseFitRequest {
  base_revision?: number;
  padding?: [number, number, number];
  minimum_size?: [number, number, number];
  sync_study_universe_mesh?: boolean;
}

export interface AuthoringObjectGeometryPatchRequest {
  base_revision?: number;
  geometry: Record<string, unknown>;
  transform?: Record<string, unknown> | null;
}

export interface GeometryRealizationRequest {
  backend_target?: GeometryBackendTarget;
}

export interface AuthoringCreateObjectTransactionRequest {
  kind: "create_object";
  base_revision?: number;
  object_id: string;
  name: string;
  geometry: Record<string, unknown>;
  transform?: Record<string, unknown> | null;
  material_ref?: string | null;
  region_name?: string | null;
  magnetization_ref?: string | null;
  material_asset?: Record<string, unknown> | null;
  magnetization_asset?: Record<string, unknown> | null;
  universe?: Record<string, unknown> | null;
  study_universe_mesh?: Record<string, unknown> | null;
}

export type AuthoringTransactionRequest =
  | {
      kind: "replace_scene";
      scene: Record<string, unknown>;
    }
  | {
      kind: "merge_patch";
      merge_patch: Record<string, unknown>;
    }
  | {
      kind: "patch_object_geometry";
      object_id: string;
      base_revision?: number;
      geometry: Record<string, unknown>;
      transform?: Record<string, unknown> | null;
    }
  | AuthoringCreateObjectTransactionRequest
  | {
      kind: "delete_object";
      base_revision?: number;
      object_id: string;
    }
  | {
      kind: "rename_object";
      base_revision?: number;
      object_id: string;
      name: string;
    }
  | {
      kind: "commit_object_transform";
      base_revision?: number;
      object_id: string;
      transform: Record<string, unknown>;
    };

export interface AuthoringTransactionResponse {
  transaction_kind: string;
  scene_revision: number;
  committed_scene: Record<string, unknown>;
}

// ── Runtime read-models ───────────────────────────────────────────────

export interface CurrentRunResource {
  run_id: string;
  session_id: string;
  revision: number;
  status: string;
  status_reason?: string | null;
  started_at: string;
  total_steps: number;
  solver_time_seconds?: number | null;
  final_exchange_energy?: number | null;
  final_demag_energy?: number | null;
  final_zeeman_energy?: number | null;
  final_anisotropy_energy?: number | null;
  final_dmi_energy?: number | null;
  final_total_energy?: number | null;
  artifact_dir: string;
  requested_backend: string;
  requested_device: string;
  requested_precision: string;
  requested_mode: string;
  resolved_backend?: string | null;
  resolved_device?: string | null;
  resolved_precision?: string | null;
  resolved_mode?: string | null;
  resolved_runtime_family?: string | null;
  resolved_engine_id?: string | null;
  resolved_worker?: string | null;
  active_stage_index?: number | null;
  active_stage_kind?: string | null;
  total_stages?: number | null;
}

export interface StageExecutionResource {
  revision: number;
  runtime_state: string;
  total_stages: number;
  completed_stage_indexes: number[];
  stage_statuses: string[];
  active_stage_index?: number | null;
  active_stage_kind?: string | null;
  stages: StageExecutionRecordResource[];
}

export interface StageExecutionRecordResource {
  status: string;
  reason?: string | null;
  metric_name?: string | null;
  metric_value?: number | null;
  threshold?: number | null;
}

export interface SolverStatusResource {
  revision: number;
  runtime_state: string;
  runtime_status_kind: string;
  runtime_status_code: string;
  session_status: string;
  is_busy: boolean;
  can_accept_commands: boolean;
  run_id?: string | null;
  stage_kind?: string | null;
  algorithm?: string | null;
  integrator?: string | null;
  dt_seconds?: number | null;
  sim_time_seconds?: number | null;
  step_index?: number | null;
  max_torque?: number | null;
  converged?: boolean | null;
  last_error?: string | null;
  warnings: string[];
}

export interface SolverEnergyCurrentResource {
  revision: number;
  step: number;
  time_seconds: number;
  exchange: number;
  demag: number;
  zeeman: number;
  anisotropy: number;
  dmi: number;
  total: number;
}

export interface SolverEnergyHistoryResource {
  revision: number;
  total_rows: number;
  returned_rows: number;
  rows: SolverEnergyRow[];
}

export interface SolverEnergyRow {
  step: number;
  time_seconds: number;
  exchange: number;
  demag: number;
  zeeman: number;
  anisotropy: number;
  dmi: number;
  total: number;
}

// ── Artifacts ─────────────────────────────────────────────────────────

export interface ArtifactEntry {
  path: string;
  kind: string;
}

// ── Session persistence ───────────────────────────────────────────────

export type SaveProfile =
  | "compact"
  | "solved"
  | "resume"
  | "archive"
  | "recovery";

export type RestoreClass =
  | "exact_resume"
  | "logical_resume"
  | "initial_condition_import"
  | "config_only";

export type CompressionProfile = "speed" | "balanced" | "smallest";

export interface SessionExportRequest {
  profile: SaveProfile;
  name?: string;
  compression?: CompressionProfile;
  ui_state?: unknown;
}

export interface SessionExportResponse {
  session_id: string;
  profile: SaveProfile;
  fms_base64: string;
  size_bytes: number;
}

export interface CheckpointSummary {
  checkpoint_id: string;
  step: number;
  time_s: number;
  study_kind: string;
}

export interface SessionInspection {
  format_version: string;
  session_id: string;
  name: string;
  profile: SaveProfile;
  created_by_version: string;
  created_at: string;
  saved_at: string;
  run_count: number;
  latest_checkpoint: CheckpointSummary | null;
  restore_class: RestoreClass;
  warnings: string[];
  total_size_bytes: number;
}

export interface SessionImportInspectRequest {
  fms_base64: string;
}

export interface SessionImportInspectResponse {
  inspection: SessionInspection;
}

export interface SessionImportCommitRequest {
  fms_base64: string;
  restore_mode?: string;
}

export interface SessionImportCommitResponse {
  session_id: string;
  restore_class: RestoreClass;
  warnings: string[];
  ui_state?: unknown;
}

export interface CheckpointEntry {
  checkpoint_id: string;
  step: number;
  time_s: number;
  created_at: string;
}

export interface CheckpointListResponse {
  checkpoints: CheckpointEntry[];
}

export interface RecoveryEntry {
  session_id: string;
  name: string;
  saved_at: string;
  profile: SaveProfile;
}

export interface RecoveryListResponse {
  snapshots: RecoveryEntry[];
}

export interface RecoveryClearResponse {
  cleared: number;
}

// ── System / Health ───────────────────────────────────────────────────

export interface ApiErrorResponse {
  error: string;
  message: string;
  request_id?: string;
}

export interface HealthResponse {
  status: string;
  uptime_seconds: number;
  api_contract_version: string;
  active_session: boolean;
}

export interface HostEngineEntry {
  backend: string;
  device: string;
  precision: string;
  mode: string;
  runtime_family: string;
  runtime_version: string;
  worker: string;
  status: string;
  status_reason?: string | null;
  public: boolean;
  stability: string;
}

export interface RuntimeCapabilityMatrix {
  profile_version: string;
  engines: HostEngineEntry[];
}

export interface GpuTelemetryDevice {
  index: number;
  name: string;
  utilization_gpu_percent: number;
  utilization_memory_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
  temperature_c?: number | null;
}

export interface GpuTelemetryResponse {
  status: string;
  reason?: string | null;
  sample_time_unix_ms: number;
  devices: GpuTelemetryDevice[];
}
