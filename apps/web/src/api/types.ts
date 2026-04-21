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

export interface DomainSummary {
  generation_id: number;
  discretization: string;
  cell_count: number;
}

export interface ResourceRevisionMap {
  fields_revision: number;
  scalars_revision: number;
  domain_generation_id: number;
  artifacts_revision: number;
  engine_log_revision: number;
  display_revision: number;
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

/**
 * Transitional alias kept while legacy wrappers are being tightened.
 * New code should prefer `DisplayPatchRequest`.
 */
export type DisplayUpdate = DisplayPatchRequest;

// ── Commands ──────────────────────────────────────────────────────────

export type MeshCommandTargetRequest =
  | { kind: "study_domain" }
  | { kind: "adaptive_followup" }
  | { kind: "airbox" }
  | { kind: "object_mesh"; object_id: string };

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

export interface RemeshCommandRequest {
  kind: "remesh";
  mesh_options?: unknown;
  mesh_target?: MeshCommandTargetRequest;
  mesh_reason?: string;
}

export interface SaveVtkCommandRequest {
  kind: "save_vtk";
}

export interface SolveCommandRequest {
  kind: "solve";
}

export interface CloseCommandRequest {
  kind: "close";
}

export interface LegacyCommandEnvelope {
  command: string;
  params?: Record<string, unknown>;
}

export type StructuredCommandRequest =
  | RunCommandRequest
  | RelaxCommandRequest
  | PauseCommandRequest
  | ResumeCommandRequest
  | StopCommandRequest
  | SkipCommandRequest
  | RemeshCommandRequest
  | SaveVtkCommandRequest
  | SolveCommandRequest
  | CloseCommandRequest;

export type CommandRequest = StructuredCommandRequest | LegacyCommandEnvelope;

export interface CommandResponse {
  accepted: boolean;
  command_id: string;
  error?: string | null;
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
