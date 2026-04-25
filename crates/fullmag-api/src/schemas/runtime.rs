use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::types::MeshCommandTarget;

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CurrentRunResource {
    pub run_id: String,
    pub session_id: String,
    pub revision: u64,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_reason: Option<String>,
    pub started_at: String,
    pub total_steps: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solver_time_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_exchange_energy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_demag_energy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_zeeman_energy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_anisotropy_energy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_dmi_energy: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_total_energy: Option<f64>,
    pub artifact_dir: String,
    pub requested_backend: String,
    pub requested_device: String,
    pub requested_precision: String,
    pub requested_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_backend: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_precision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_runtime_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_engine_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_worker: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_stage_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_stage_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_stages: Option<u32>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StageExecutionResource {
    pub revision: u64,
    pub runtime_state: String,
    pub total_stages: u32,
    pub completed_stage_indexes: Vec<u32>,
    pub stage_statuses: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_stage_index: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_stage_kind: Option<String>,
    pub stages: Vec<StageExecutionRecordResource>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StageExecutionRecordResource {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_value: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SolverStatusResource {
    pub revision: u64,
    pub runtime_state: String,
    pub runtime_status_kind: String,
    pub runtime_status_code: String,
    pub session_status: String,
    pub is_busy: bool,
    pub can_accept_commands: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub algorithm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dt_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sim_time_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_index: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_torque: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub converged: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SolverEnergyCurrentResource {
    pub revision: u64,
    pub step: u64,
    pub time_seconds: f64,
    pub exchange: f64,
    pub demag: f64,
    pub zeeman: f64,
    pub anisotropy: f64,
    pub dmi: f64,
    pub total: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SolverEnergyHistoryResource {
    pub revision: u64,
    pub total_rows: u64,
    pub returned_rows: u64,
    pub rows: Vec<SolverEnergyRow>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct SolverEnergyRow {
    pub step: u64,
    pub time_seconds: f64,
    pub exchange: f64,
    pub demag: f64,
    pub zeeman: f64,
    pub anisotropy: f64,
    pub dmi: f64,
    pub total: f64,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CommandQueueStatusResource {
    pub revision: u64,
    pub pending_count: u64,
    pub accepted_count: u64,
    pub dispatched_count: u64,
    pub running_count: u64,
    pub completed_count: u64,
    pub rejected_count: u64,
    pub failed_count: u64,
    pub can_accept_commands: bool,
    pub commands: Vec<CommandStatusResource>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CommandStatusResource {
    pub command_id: String,
    pub seq: u64,
    pub kind: String,
    pub status: String,
    pub created_at_unix_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dispatched_at_unix_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct CommandDetailResource {
    pub command_id: String,
    pub seq: u64,
    pub kind: String,
    pub status: String,
    pub created_at_unix_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dispatched_at_unix_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_steps: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub torque_tolerance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy_tolerance: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integrator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixed_timestep: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_error: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relax_algorithm: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub relax_alpha: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_target: Option<MeshCommandTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_reason: Option<String>,
}
