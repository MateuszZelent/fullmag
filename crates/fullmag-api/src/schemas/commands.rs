use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::schemas::diagnostics::SolverProfileCommandConfig;
use crate::schemas::relaxation::RelaxationAlgorithm;
use crate::types::MeshCommandTarget;

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct RuntimeCommandIntent {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<RuntimeCommandTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precondition: Option<RuntimeCommandPrecondition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_intent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_at_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeCommandTarget {
    Study,
    Run {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        run_id: Option<String>,
    },
    CurrentStage {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        stage_id: Option<String>,
    },
    StageIndex {
        stage_index: u32,
    },
    StageId {
        stage_id: String,
    },
    CommandId {
        command_id: String,
    },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct RuntimeCommandPrecondition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_execution_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_topology_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_membership_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_coefficients_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub region_initial_state_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_revision: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SolverPolicyRequest {
    Fixed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        integrator: Option<String>,
        fix_dt: f64,
    },
    Adaptive {
        integrator: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dt_initial: Option<f64>,
        dt_min: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dt_max: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_err: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        atol: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        rtol: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        safety: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        growth_limit: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        shrink_limit: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        max_spin_rotation: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        norm_tolerance: Option<f64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StructuredCommandRequest {
    Run {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
        until_seconds: f64,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_steps: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        integrator: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fixed_timestep: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        solver_policy: Option<SolverPolicyRequest>,
    },
    Relax {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
        #[serde(skip_serializing_if = "Option::is_none")]
        until_seconds: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_relaxation_time_s: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_steps: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        torque_tolerance_apm: Option<f64>,
        #[serde(rename = "torque_tolerance_T", skip_serializing_if = "Option::is_none")]
        torque_tolerance_t: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        torque_tolerance: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        energy_tolerance: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        energy_tolerance_j: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        relax_algorithm: Option<RelaxationAlgorithm>,
        #[serde(skip_serializing_if = "Option::is_none")]
        relax_alpha: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        fixed_timestep: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_error: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        solver_policy: Option<SolverPolicyRequest>,
    },
    Pause {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
    },
    Resume {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
    },
    Stop {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
    },
    Skip {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
    },
    SaveVtk {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
    },
    Solve {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
    },
    ComputeFields {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
    },
    ComputeEnergies {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
    },
    Close {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
    },
    MeshBuild {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
        #[schema(value_type = Object, nullable)]
        #[serde(skip_serializing_if = "Option::is_none")]
        mesh_options: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mesh_target: Option<MeshCommandTarget>,
        #[serde(skip_serializing_if = "Option::is_none")]
        mesh_reason: Option<String>,
    },
    SetSolverProfile {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
        profile: SolverProfileCommandConfig,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CommandResponse {
    pub accepted: bool,
    pub command_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
