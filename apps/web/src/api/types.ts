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
  component: string;
  colormap: string;
  auto_contrast: boolean;
  contrast_min: number | null;
  contrast_max: number | null;
  vector_glyphs: boolean;
  vector_density: number;
  slice_mode: string;
  slice_layer: number;
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

export interface DisplayUpdate {
  active_quantity_id?: string;
  component?: string;
  colormap?: string;
  auto_contrast?: boolean;
  contrast_min?: number | null;
  contrast_max?: number | null;
  vector_glyphs?: boolean;
  vector_density?: number;
  slice_mode?: string;
  slice_layer?: number;
}

// ── Commands ──────────────────────────────────────────────────────────

export interface CommandRequest {
  command: string;
  params?: Record<string, unknown>;
}

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
  sample_time_unix_ms: number;
  devices: GpuTelemetryDevice[];
}
