use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::types::MeshCommandTarget;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StructuredCommandRequest {
    Run {
        until_seconds: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_steps: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        integrator: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fixed_timestep: Option<f64>,
    },
    Relax {
        #[serde(skip_serializing_if = "Option::is_none")]
        until_seconds: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_steps: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        torque_tolerance: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        energy_tolerance: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        relax_algorithm: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        relax_alpha: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fixed_timestep: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_error: Option<f64>,
    },
    Pause,
    Resume,
    Stop,
    Skip,
    SaveVtk,
    Solve,
    ComputeFields,
    Close,
    MeshBuild {
        #[schema(value_type = Object, nullable)]
        #[serde(skip_serializing_if = "Option::is_none")]
        mesh_options: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mesh_target: Option<MeshCommandTarget>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mesh_reason: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CommandResponse {
    pub accepted: bool,
    pub command_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
