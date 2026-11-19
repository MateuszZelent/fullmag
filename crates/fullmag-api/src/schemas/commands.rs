use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::ToSchema;

use crate::schemas::diagnostics::SolverProfileCommandConfig;
use crate::schemas::relaxation::RelaxationAlgorithm;
use crate::types::MeshCommandTarget;

pub use crate::study_execution_contract::{RuntimeAuthoredInitialStateSource, RuntimeInitialStateRequest};

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_state: Option<RuntimeInitialStateRequest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
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

/// Pin the current run seen when Compute was requested, including its absence.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RuntimeCommandRunPrecondition {
    None,
    Run { run_id: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema)]
pub struct RuntimeCommandPrecondition {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_run: Option<RuntimeCommandRunPrecondition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_execution_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_state: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scene_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mesh_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_generation_id: Option<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CommandFailureRequest {
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum FixedSolverIntegratorRequest {
    Auto,
    Heun,
    Rk4,
    Rk23,
    Rk45,
    Abm3,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AdaptiveSolverIntegratorRequest {
    Rk23,
    Rk45,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, ToSchema)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SolverPolicyRequest {
    Fixed {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        integrator: Option<FixedSolverIntegratorRequest>,
        fix_dt: f64,
    },
    AdaptiveMaxError {
        integrator: AdaptiveSolverIntegratorRequest,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dt_initial: Option<f64>,
        dt_min: f64,
        dt_max: f64,
        max_err: f64,
    },
    AdaptiveAdvanced {
        integrator: AdaptiveSolverIntegratorRequest,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        dt_initial: Option<f64>,
        dt_min: f64,
        dt_max: f64,
        atol: f64,
        rtol: f64,
        safety: f64,
        growth_limit: f64,
        shrink_limit: f64,
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
        /// Omit for an exact authored StageId in the accepted Study lane.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        until_seconds: Option<f64>,
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
    /// Replan the FDM grid and membership masks from the committed scene.
    FdmGridRefresh {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
        #[schema(value_type = Object, nullable)]
        #[serde(skip_serializing_if = "Option::is_none")]
        mesh_options: Option<Value>,
    },
    SetSolverProfile {
        #[serde(default, flatten)]
        intent: RuntimeCommandIntent,
        profile: SolverProfileCommandConfig,
    },
}

/// Immutable binding of an accepted command to its own execution.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub struct CommandExecutionBinding {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_target: Option<RuntimeCommandTarget>,
    pub run_id: String,
    /// The selected authored step for a single-stage execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct CommandResponse {
    pub accepted: bool,
    pub command_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_binding: Option<CommandExecutionBinding>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{
        RuntimeInitialStateRequest, SolverPolicyRequest, StructuredCommandRequest,
    };
    use serde_json::json;

    #[test]
    fn solver_policy_matches_shared_api_cli_serde_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fullmag-ir/tests/fixtures/solver-policy-transport.json"
        ))
        .expect("shared solver policy fixture must be valid JSON");
        let policies: Vec<SolverPolicyRequest> =
            serde_json::from_value(fixture.clone()).expect("API policy must decode fixture");
        assert_eq!(
            serde_json::to_value(policies).expect("API policy must encode fixture"),
            fixture
        );
    }

    #[test]
    fn runtime_initial_state_request_round_trips_tagged_variants_and_default_flag() {
        let requests = [
            json!({"kind": "default_for_target"}),
            json!({
                "kind": "authored_initial_state",
                "source": {"kind": "study", "scene_revision": 3}
            }),
            json!({
                "kind": "authored_initial_state",
                "source": {"kind": "stage", "stage_id": "relax-a", "scene_revision": 4}
            }),
            json!({
                "kind": "authored_initial_state",
                "source": {
                    "kind": "prepared",
                    "scene_revision": 5,
                    "initial_state_revision": 6,
                    "publication_id": "prepared-state-6"
                }
            }),
            json!({
                "kind": "stage_result",
                "run_id": "run-source",
                "step_id": "relax-source",
                "case_id": "default",
                "artifact_id": "artifact-state",
                "content_sha256": "a".repeat(64),
                "allow_stale_model": false
            }),
            json!({"kind": "latest_compatible_state"}),
        ];
        for expected in requests {
            let request: RuntimeInitialStateRequest =
                serde_json::from_value(expected.clone()).expect("decode initial-state request");
            assert_eq!(serde_json::to_value(request).unwrap(), expected);
        }

        let stage_result: RuntimeInitialStateRequest = serde_json::from_value(json!({
            "kind": "stage_result",
            "run_id": "run-source",
            "step_id": "relax-source",
            "case_id": "default",
            "artifact_id": "artifact-state",
            "content_sha256": "a".repeat(64)
        }))
        .expect("missing allow_stale_model defaults to false");
        assert!(matches!(
            stage_result,
            RuntimeInitialStateRequest::StageResult {
                allow_stale_model: false,
                ..
            }
        ));
        assert!(serde_json::from_value::<RuntimeInitialStateRequest>(json!({
            "kind": "latest_compatible_state",
            "unexpected": true
        }))
        .is_err());
        assert!(serde_json::from_value::<RuntimeInitialStateRequest>(json!({
            "kind": "authored_initial_state",
            "source": {"kind": "study", "scene_revision": 3, "unexpected": true}
        }))
        .is_err());

        let command: StructuredCommandRequest = serde_json::from_value(json!({
            "kind": "run",
            "until_seconds": 1.0,
            "initial_state": {
                "kind": "authored_initial_state",
                "source": {"kind": "study", "scene_revision": 3}
            }
        }))
        .expect("flattened command intent should carry initial_state");
        assert_eq!(
            serde_json::to_value(command).unwrap()["initial_state"],
            json!({
                "kind": "authored_initial_state",
                "source": {"kind": "study", "scene_revision": 3}
            })
        );
    }
}
