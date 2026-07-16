use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::schemas::relaxation::RelaxationAlgorithm;

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy)]
pub enum DisplayViewMode {
    #[serde(rename = "2d")]
    TwoD,
    #[serde(rename = "3d")]
    ThreeD,
}

#[derive(Debug, Serialize, Deserialize, ToSchema, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldComponent {
    X,
    Y,
    Z,
    Magnitude,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct LiveStatus {
    pub api_contract_version: String,
    pub runtime_bundle_version: String,
    /// Thin current-session summary. Full session persistence state is owned by persistence resources.
    pub session: SessionSummary,
    /// Thin run summary for header/status surfaces. Full run metadata is owned by `simulation/runs/*`.
    pub run: Option<RunSummary>,
    /// Thin solver summary for polling cadence and top-bar state. Detailed solver state is owned by `simulation/solver/status`.
    pub solver: SolverSummary,
    /// Current renderer/view selection. The writable display resource is `visualization/display`.
    pub display: DisplaySelection,
    /// Thin domain summary for adapter selection. Heavy topology is owned by `data/domain/topology` and meshing mesh resources.
    pub domain: DomainSummary,
    /// Revision pointers used to invalidate resource hooks. Heavy resources must be fetched from their owning endpoint.
    pub resources: ResourceRevisionMap,
    /// Canonical UI gating source for the current session. Platform and meshing capabilities have narrower ownership.
    pub capabilities: CapabilityMap,
    /// Thin latest energy summary for status surfaces. Energy samples/history are owned by `simulation/solver/energies/*`.
    pub energies: EnergySummary,
    /// Lightweight runtime metrics for status surfaces. Detailed logs/diagnostics live under `diagnostics/*`.
    pub metrics: MetricsSummary,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SessionSummary {
    pub session_id: String,
    pub name: String,
    pub created_at: String,
    pub workspace_root: String,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct RunSummary {
    pub run_id: String,
    pub stage_index: u32,
    pub stage_label: String,
    pub stage_count: u32,
    pub started_at: String,
    pub solver_steps: u64,
    pub solver_time: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SolverSummary {
    /// idle | running | paused | finished | error
    pub state: String,
    pub algorithm: Option<String>,
    pub relaxation_algorithm: Option<RelaxationAlgorithm>,
    pub dt: Option<f64>,
    #[serde(rename = "max_torque_T")]
    pub max_torque_t: Option<f64>,
    #[serde(rename = "max_torque_Apm")]
    pub max_torque_apm: Option<f64>,
    pub max_rhs_norm_per_s: Option<f64>,
    /// Deprecated ambiguous alias. When present it is in A/m.
    #[schema(deprecated)]
    pub max_torque: Option<f64>,
    pub converged: Option<bool>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DisplaySelection {
    pub active_quantity_id: String,
    pub view_mode: DisplayViewMode,
    pub field_component: FieldComponent,
    pub colormap: String,
    pub auto_contrast: bool,
    pub contrast_min: Option<f64>,
    pub contrast_max: Option<f64>,
    pub vector_glyphs: bool,
    pub vector_density: u32,
    pub slice_mode: String,
    pub slice_layer: i32,
    pub max_points: u32,
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct DomainSummary {
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub generation_id: u64,
    pub discretization: String,
    pub cell_count: u64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct ResourceRevisionMap {
    pub topology_revision: u64,
    pub field_catalog_revision: u64,
    pub field_revision: u64,
    pub slice_revision: u64,
    pub artifact_revision: u64,
    pub command_completion_revision: u64,
    pub fields_revision: u64,
    pub scalars_revision: u64,
    #[serde(with = "crate::schemas::decimal_u64")]
    #[schema(value_type = String)]
    pub domain_generation_id: u64,
    pub artifacts_revision: u64,
    pub engine_log_revision: u64,
    pub solver_profile_revision: u64,
    pub display_revision: u64,
    pub workspace_revision: u64,
    pub mesh_revision: u64,
    pub mesh_build_revision: u64,
    pub commands_revision: u64,
    pub stages_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    pub visualization_state_revision: u64,
    pub region_topology_revision: u64,
    pub region_membership_revision: u64,
    pub region_coefficients_revision: u64,
    pub region_initial_state_revision: u64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CapabilityMap {
    pub structured_grid: bool,
    pub explicit_topology: bool,
    pub binary_fields: bool,
    pub cell_fields: bool,
    pub node_fields: bool,
    pub scalar_history: bool,
    pub eigen_modes: bool,
    pub gpu_telemetry: bool,
    pub preview_2d: bool,
    pub preview_3d: bool,
    pub algorithms_available: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct EnergySummary {
    pub total: Option<f64>,
    pub exchange: Option<f64>,
    pub demag: Option<f64>,
    pub zeeman: Option<f64>,
    pub anisotropy: Option<f64>,
    pub dmi: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct MetricsSummary {
    pub uptime_seconds: u64,
    pub total_steps: u64,
    pub steps_per_second: Option<f64>,
}
