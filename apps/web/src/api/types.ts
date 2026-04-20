/**
 * Comprehensive TypeScript types for the Fullmag live API,
 * matching backend schemas and the resource-first data plane.
 */

// ── Status ────────────────────────────────────────────────────────────

export interface LiveStatus {
  session_id: string;
  run_id: string | null;
  solver_state: SolverState;
  stage_label: string | null;
  iteration: number;
  sim_time: number;
  wall_time_s: number;
  field_revision: number;
  scalar_revision: number;
  domain_generation_id: number;
  display_selection: DisplaySelection;
  energy_summary: EnergySummary | null;
  metrics_summary: MetricsSummary | null;
  error: string | null;
}

export type SolverState =
  | "idle"
  | "initializing"
  | "running"
  | "paused"
  | "converged"
  | "stopped"
  | "error";

export interface SessionSummary {
  session_id: string;
  created_at: string;
  label: string | null;
  solver_state: SolverState;
}

export interface RunSummary {
  run_id: string;
  session_id: string;
  started_at: string;
  finished_at: string | null;
  solver_state: SolverState;
  stage_count: number;
}

export interface SolverSummary {
  backend: string;
  device: string;
  precision: string;
  discretization: "fdm" | "fem";
  runtime_family: string;
}

// ── Display ───────────────────────────────────────────────────────────

export interface DisplaySelection {
  quantity_id: string;
  component: string | null;
  colormap: string | null;
  range_min: number | null;
  range_max: number | null;
}

export interface DisplayUpdate {
  quantity_id?: string;
  component?: string | null;
  colormap?: string | null;
  range_min?: number | null;
  range_max?: number | null;
}

// ── Domain ────────────────────────────────────────────────────────────

export interface DomainSummary {
  discretization: "fdm" | "fem";
  dimension: 3;
  point_count: number;
  cell_count?: number;
  element_count?: number;
  generation_id: number;
}

export interface ResourceRevisionMap {
  field_revision: number;
  scalar_revision: number;
  domain_generation_id: number;
}

export interface DomainMeta {
  discretization: "fdm" | "fem";
  dimension: 3;
  generation_id: number;
  bounds: Bounds3;
  counts: DomainCounts;
  structured_grid: StructuredGridDescriptor | null;
}

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

export interface DomainCounts {
  point_count: number;
  cell_count: number;
  element_count?: number;
  boundary_face_count?: number;
}

export interface StructuredGridDescriptor {
  shape: [number, number, number];
  origin: [number, number, number];
  spacing: [number, number, number];
}

// ── Fields ────────────────────────────────────────────────────────────

export interface FieldCatalog {
  schema_version: string;
  quantities: FieldDescriptor[];
}

export interface FieldDescriptor {
  quantity_id: string;
  label: string;
  kind: string;
  unit: string;
  spatial_domain: string;
  n_comp: number;
  source: string;
  available: boolean;
  element_count: number;
  grid: [number, number, number] | null;
  stats: FieldStats | null;
}

export interface FieldMeta {
  quantity_id: string;
  label: string;
  kind: string;
  unit: string;
  n_comp: number;
  element_count: number;
  grid: [number, number, number] | null;
  stats: FieldStats | null;
}

export interface FieldStats {
  min: number;
  max: number;
  mean: number;
  component_min: [number, number, number] | null;
  component_max: [number, number, number] | null;
}

// ── Scalars ───────────────────────────────────────────────────────────

export interface ScalarWindow {
  rows: ScalarRow[];
  total_rows: number;
  since_revision: number;
}

export interface ScalarRow {
  iteration: number;
  sim_time: number;
  [key: string]: number;
}

// ── Commands ──────────────────────────────────────────────────────────

export interface CommandRequest {
  kind: string;
  params?: Record<string, unknown>;
}

export interface CommandResponse {
  accepted: boolean;
  command_id: string | null;
  message: string | null;
  error: string | null;
}

// ── Artifacts ─────────────────────────────────────────────────────────

export interface ArtifactEntry {
  path: string;
  kind?: string;
  size_bytes?: number;
  created_at?: string;
}

// ── Energy / Metrics ──────────────────────────────────────────────────

export interface EnergySummary {
  total: number;
  exchange: number;
  zeeman: number;
  demag: number;
  anisotropy: number;
  [key: string]: number;
}

export interface MetricsSummary {
  dt: number;
  max_torque: number;
  max_dm_dt: number;
  [key: string]: number;
}

// ── System / Health ───────────────────────────────────────────────────

export interface ApiErrorResponse {
  error: string;
  message: string;
  status: number;
  request_id?: string;
}

export interface HealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  version: string;
  uptime_s: number;
  contract_version: string;
}

// ── Capabilities ──────────────────────────────────────────────────────

export interface CapabilityMap {
  explicit_topology: boolean;
  implicit_coordinates: boolean;
  structured_grid: boolean;
  binary_field_transport: boolean;
  binary_topology_transport: boolean;
  eigen_spectrum: boolean;
  eigen_dispersion: boolean;
  frequency_response: boolean;
  algorithms_available: string[];
  discretization: "fdm" | "fem";
  device: string;
  precision: string;
}
