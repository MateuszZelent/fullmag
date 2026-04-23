use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub enum DisplayViewMode {
    #[serde(rename = "2d")]
    TwoD,
    #[serde(rename = "3d")]
    ThreeD,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
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
    pub session: SessionSummary,
    pub run: Option<RunSummary>,
    pub solver: SolverSummary,
    pub display: DisplaySelection,
    pub domain: DomainSummary,
    pub resources: ResourceRevisionMap,
    pub capabilities: CapabilityMap,
    pub energies: EnergySummary,
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
    pub dt: Option<f64>,
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
    pub domain_generation_id: u64,
    pub artifacts_revision: u64,
    pub engine_log_revision: u64,
    pub display_revision: u64,
    pub workspace_revision: u64,
    pub mesh_revision: u64,
    pub mesh_build_revision: u64,
    pub commands_revision: u64,
    pub stages_revision: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
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
