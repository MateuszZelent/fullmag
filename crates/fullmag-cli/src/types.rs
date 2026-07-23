use fullmag_ir::{GeometryAssetsIR, OutputIR, ProblemIR, RegionalFieldDriveIR, TableAutosaveIR};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use crate::simulation_preparation::SimulationPreparationState;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum MeshCommandTarget {
    StudyDomain,
    AdaptiveFollowup,
    Airbox,
    ObjectMesh { object_id: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum RuntimeCommandTarget {
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct RuntimeCommandPrecondition {
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

#[derive(Debug, Serialize)]
pub(crate) struct RequestedExecutionProvenance {
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub mode: String,
    pub fallback_policy: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct ScriptRunSummary {
    pub session_id: String,
    pub run_id: String,
    pub script_path: String,
    pub problem_name: String,
    pub status: String,
    pub backend: String,
    pub mode: String,
    pub precision: String,
    pub requested_execution: RequestedExecutionProvenance,
    pub total_steps: usize,
    pub final_time: Option<f64>,
    pub final_e_ex: Option<f64>,
    pub final_e_demag: Option<f64>,
    pub final_e_ext: Option<f64>,
    pub final_e_ani: Option<f64>,
    pub final_e_dmi: Option<f64>,
    pub final_e_total: Option<f64>,
    pub wall_time_ns: Option<u64>,
    pub exchange_wall_time_ns: Option<u64>,
    pub demag_wall_time_ns: Option<u64>,
    pub demag_assemble_wall_time_ns: Option<u64>,
    pub demag_solve_wall_time_ns: Option<u64>,
    pub demag_solver_setup_wall_time_ns: Option<u64>,
    pub demag_solver_apply_wall_time_ns: Option<u64>,
    pub demag_recover_wall_time_ns: Option<u64>,
    pub demag_energy_wall_time_ns: Option<u64>,
    pub rhs_wall_time_ns: Option<u64>,
    pub extra_energy_wall_time_ns: Option<u64>,
    pub snapshot_wall_time_ns: Option<u64>,
    pub relaxation_preconditioner_wall_time_ns: Option<u64>,
    pub relaxation_preconditioner_cache_hits: Option<u32>,
    pub relaxation_preconditioner_cache_misses: Option<u32>,
    pub rhs_evals: Option<u32>,
    pub total_rhs_evals: u64,
    pub demag_solves: Option<u32>,
    /// Number of eigenmode frequencies found (FEM eigen only).
    pub eigen_mode_count: Option<usize>,
    /// Lowest eigenfrequency in Hz (FEM eigen only).
    pub eigen_lowest_frequency_hz: Option<f64>,
    pub artifact_dir: String,
    pub workspace_dir: String,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct SessionManifest {
    pub session_id: String,
    pub run_id: String,
    pub status: String,
    pub interactive_session_requested: bool,
    pub script_path: String,
    pub problem_name: String,
    pub requested_backend: String,
    pub explicit_selection: bool,
    pub requested_device: String,
    pub requested_precision: String,
    pub requested_mode: String,
    pub requested_cpu_threads: Option<u32>,
    pub execution_mode: String,
    pub precision: String,
    pub resolved_backend: Option<String>,
    pub resolved_device: Option<String>,
    pub resolved_precision: Option<String>,
    pub resolved_mode: Option<String>,
    pub resolved_runtime_family: Option<String>,
    pub resolved_engine_id: Option<String>,
    pub resolved_worker: Option<String>,
    pub resolved_cpu_threads: Option<u32>,
    pub resolved_fallback: Option<fullmag_runner::ResolvedFallback>,
    pub artifact_dir: String,
    pub started_at_unix_ms: u128,
    pub finished_at_unix_ms: u128,
    pub plan_summary: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionRuntimeSelection {
    pub requested_backend: String,
    pub explicit_selection: bool,
    pub requested_device: String,
    pub requested_precision: String,
    pub requested_mode: String,
    pub requested_cpu_threads: Option<u32>,
    pub resolved_backend: Option<String>,
    pub resolved_device: Option<String>,
    pub resolved_precision: Option<String>,
    pub resolved_mode: Option<String>,
    pub resolved_runtime_family: Option<String>,
    pub resolved_engine_id: Option<String>,
    pub resolved_worker: Option<String>,
    pub resolved_cpu_threads: Option<u32>,
    pub resolved_fallback: Option<fullmag_runner::ResolvedFallback>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct RunManifest {
    pub run_id: String,
    pub session_id: String,
    pub status: String,
    pub total_steps: usize,
    pub final_time: Option<f64>,
    pub final_e_ex: Option<f64>,
    pub final_e_demag: Option<f64>,
    pub final_e_ext: Option<f64>,
    pub final_e_ani: Option<f64>,
    pub final_e_dmi: Option<f64>,
    pub final_e_total: Option<f64>,
    pub artifact_dir: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LiveStateManifest {
    pub status: String,
    /// Typed runtime status enum — canonical source of truth for state machine.
    /// Published alongside the string `status` for backward compatibility.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_status: Option<fullmag_runner::RuntimeStatus>,
    pub updated_at_unix_ms: u128,
    pub latest_step: LiveStepView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EngineLogEntry {
    pub timestamp_unix_ms: u128,
    pub level: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct LiveStepView {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pseudo_time_s: Option<f64>,
    pub e_ex: f64,
    pub e_demag: f64,
    pub e_ext: f64,
    pub e_ani: f64,
    pub e_dmi: f64,
    pub e_total: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    pub max_torque_Apm: f64,
    pub max_torque_T: f64,
    pub wall_time_ns: u64,
    pub grid: [u32; 3],
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_mesh_generation_id: Option<String>,
    /// **Deprecated (Q16):** Spatial data flows through `latest_fields`.
    pub magnetization: Option<Vec<f64>>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_object_scalars: HashMap<String, HashMap<String, f64>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_materialization_states: Vec<fullmag_runner::LiveFieldMaterializationStatus>,
    /// **Deprecated (Q17):** Preview fields flow through `preview_fields`
    /// in `CurrentLiveSnapshotPayload`, not inside the step view.
    pub preview_field: Option<fullmag_runner::LivePreviewField>,
    pub finished: bool,
}

fn default_study_pipeline_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct StudyPipelineDocument {
    pub version: String,
    #[serde(default)]
    pub nodes: Vec<StudyPipelineNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
#[serde(tag = "node_kind", rename_all = "snake_case")]
pub(crate) enum StudyPipelineNode {
    Primitive {
        id: String,
        label: String,
        #[serde(default = "default_study_pipeline_enabled")]
        enabled: bool,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default)]
        source: Option<String>,
        stage_kind: String,
        #[serde(default)]
        payload: BTreeMap<String, Value>,
    },
    Macro {
        id: String,
        label: String,
        #[serde(default = "default_study_pipeline_enabled")]
        enabled: bool,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default)]
        source: Option<String>,
        macro_kind: String,
        #[serde(default)]
        config: BTreeMap<String, Value>,
    },
    Group {
        id: String,
        label: String,
        #[serde(default = "default_study_pipeline_enabled")]
        enabled: bool,
        #[serde(default)]
        notes: Option<String>,
        #[serde(default)]
        source: Option<String>,
        #[serde(default)]
        collapsed: bool,
        #[serde(default)]
        children: Vec<StudyPipelineNode>,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ScriptExecutionConfig {
    pub ir: ProblemIR,
    #[serde(default)]
    pub shared_geometry_assets: Option<GeometryAssetsIR>,
    pub default_until_seconds: Option<f64>,
    #[serde(default)]
    pub study_pipeline: Option<StudyPipelineDocument>,
    #[serde(default)]
    pub stages: Vec<ScriptExecutionStage>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum ScriptExecutionStageAction {
    SaveState {
        #[serde(default = "default_stage_action_artifact_name")]
        artifact_name: String,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        dataset: Option<String>,
    },
    LoadState {
        #[serde(default)]
        artifact_name: Option<String>,
        #[serde(default)]
        state_path: Option<String>,
        #[serde(default)]
        format: Option<String>,
        #[serde(default)]
        dataset: Option<String>,
        #[serde(default)]
        sample_index: Option<i64>,
    },
    Export {
        #[serde(default)]
        artifact_name: Option<String>,
        quantity: String,
        format: String,
        #[serde(default)]
        dataset: Option<String>,
    },
    ChangeDevice {
        device: String,
    },
    AddFieldDrive {
        drive: RegionalFieldDriveIR,
    },
    RemoveFieldDrive {
        drive_id: String,
    },
    TableAutosave {
        #[serde(default = "default_true")]
        enabled: bool,
        #[serde(default)]
        table_autosave: Option<TableAutosaveIR>,
    },
    Autosave {
        #[serde(default = "default_true")]
        enabled: bool,
        #[serde(default)]
        quantity: Option<String>,
        #[serde(default)]
        output: Option<OutputIR>,
    },
    FftResponse {
        #[serde(default = "default_true")]
        enabled: bool,
        #[serde(default)]
        request: Option<Value>,
    },
}

fn default_stage_action_artifact_name() -> String {
    "state_snapshot".to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ScriptExecutionStage {
    pub ir: ProblemIR,
    pub default_until_seconds: Option<f64>,
    pub entrypoint_kind: String,
    #[serde(default)]
    pub action: Option<ScriptExecutionStageAction>,
}

#[derive(Debug, Serialize)]
pub(crate) struct RuntimeResolutionSummary {
    pub script_mode: bool,
    pub requested_backend: String,
    pub explicit_selection: bool,
    pub requested_mode: String,
    pub resolved_backend: String,
    pub requested_device: String,
    pub requested_precision: String,
    pub resolved_device: String,
    pub resolved_precision: String,
    pub resolved_mode: String,
    pub preferred_runtime_family: String,
    pub resolved_runtime_family: Option<String>,
    pub resolved_engine_id: Option<String>,
    pub resolved_worker: Option<String>,
    pub resolved_fallback: Option<fullmag_runner::ResolvedFallback>,
    pub local_engine_id: Option<String>,
    pub local_engine_label: Option<String>,
    pub requires_managed_runtime: bool,
    pub entrypoint_kind: String,
}

#[derive(Debug, Clone)]
pub(crate) enum ResolvedScriptStageAction {
    SaveState {
        artifact_name: String,
        format: Option<String>,
        dataset: Option<String>,
    },
    LoadState {
        artifact_name: Option<String>,
        state_path: Option<String>,
        format: Option<String>,
        dataset: Option<String>,
        sample_index: Option<i64>,
    },
    Export {
        artifact_name: Option<String>,
        quantity: String,
        format: String,
        dataset: Option<String>,
    },
    ChangeDevice {
        device: String,
    },
    AddFieldDrive {
        drive: RegionalFieldDriveIR,
    },
    RemoveFieldDrive {
        drive_id: String,
    },
    TableAutosave {
        enabled: bool,
        table_autosave: Option<TableAutosaveIR>,
    },
    Autosave {
        enabled: bool,
        quantity: Option<String>,
        output: Option<OutputIR>,
    },
    FftResponse {
        enabled: bool,
        request: Option<Value>,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StageTransitionKind {
    ContinueInPlace,
    TransferState,
    RemeshTransfer,
    BackendTransfer,
    LoadState,
    SaveCheckpoint,
    ExportOnly,
    Unsupported,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StageTransitionReason {
    SameRuntimeContext,
    ExplicitRemesh,
    BackendChange,
    MeshGenerationChanged,
    ObjectTopologyChanged,
    MaterialTopologyChanged,
    DeviceChange,
    CheckpointLoad,
    UserExport,
    IncompatibleImplicitState,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StateTransferOperatorKind {
    IdentityCopy,
    FemToFdmGridResample,
    FdmToFemMeshResample,
    MeshToMeshInterpolation,
    CheckpointLoad,
    SampledFieldImport,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum StageTransitionUiPresentation {
    SmoothArrow,
    BoundaryBar,
    ErrorBoundary,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub(crate) struct StageTransitionMetadata {
    pub kind: StageTransitionKind,
    pub reason: StageTransitionReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transfer_operator: Option<StateTransferOperatorKind>,
    pub ui_presentation: StageTransitionUiPresentation,
}

impl StageTransitionMetadata {
    pub(crate) fn continue_in_place() -> Self {
        Self {
            kind: StageTransitionKind::ContinueInPlace,
            reason: StageTransitionReason::SameRuntimeContext,
            transfer_operator: None,
            ui_presentation: StageTransitionUiPresentation::SmoothArrow,
        }
    }

    pub(crate) fn boundary(
        kind: StageTransitionKind,
        reason: StageTransitionReason,
        transfer_operator: Option<StateTransferOperatorKind>,
    ) -> Self {
        Self {
            kind,
            reason,
            transfer_operator,
            ui_presentation: StageTransitionUiPresentation::BoundaryBar,
        }
    }

    pub(crate) fn unsupported(reason: StageTransitionReason) -> Self {
        Self {
            kind: StageTransitionKind::Unsupported,
            reason,
            transfer_operator: None,
            ui_presentation: StageTransitionUiPresentation::ErrorBoundary,
        }
    }

    pub(crate) fn legacy_state_transition_label(&self) -> &'static str {
        if self.reason == StageTransitionReason::DeviceChange {
            return "Change device";
        }
        match self.kind {
            StageTransitionKind::ContinueInPlace => "continues",
            StageTransitionKind::SaveCheckpoint => "preserved",
            StageTransitionKind::LoadState => "restored",
            StageTransitionKind::ExportOnly => "exported",
            StageTransitionKind::TransferState
            | StageTransitionKind::RemeshTransfer
            | StageTransitionKind::BackendTransfer => "transferred",
            StageTransitionKind::Unsupported => "unsupported",
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ResolvedScriptStage {
    pub ir: ProblemIR,
    pub until_seconds: f64,
    pub entrypoint_kind: String,
    pub action: Option<ResolvedScriptStageAction>,
    pub incoming_transition: Option<StageTransitionMetadata>,
}

impl ResolvedScriptStage {
    pub(crate) fn solver(
        ir: ProblemIR,
        until_seconds: f64,
        entrypoint_kind: impl Into<String>,
    ) -> Self {
        Self {
            ir,
            until_seconds,
            entrypoint_kind: entrypoint_kind.into(),
            action: None,
            incoming_transition: None,
        }
    }

    pub(crate) fn synthetic(
        ir: ProblemIR,
        entrypoint_kind: impl Into<String>,
        action: ResolvedScriptStageAction,
    ) -> Self {
        Self {
            ir,
            until_seconds: 0.0,
            entrypoint_kind: entrypoint_kind.into(),
            action: Some(action),
            incoming_transition: None,
        }
    }
}

pub(crate) type CurrentDisplaySelection = fullmag_runner::DisplaySelectionState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum FixedSolverIntegratorRequest {
    Auto,
    Heun,
    Rk4,
    Rk23,
    Rk45,
    Abm3,
}

impl FixedSolverIntegratorRequest {
    pub(crate) const fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Heun => "heun",
            Self::Rk4 => "rk4",
            Self::Rk23 => "rk23",
            Self::Rk45 => "rk45",
            Self::Abm3 => "abm3",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AdaptiveSolverIntegratorRequest {
    Rk23,
    Rk45,
}

impl AdaptiveSolverIntegratorRequest {
    pub(crate) const fn as_str(&self) -> &'static str {
        match self {
            Self::Rk23 => "rk23",
            Self::Rk45 => "rk45",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub(crate) enum SolverPolicyRequest {
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct SessionCommand {
    #[serde(default)]
    pub seq: u64,
    pub command_id: String,
    pub kind: String,
    pub created_at_unix_ms: u128,
    #[serde(default)]
    pub target: Option<RuntimeCommandTarget>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub precondition: Option<RuntimeCommandPrecondition>,
    #[serde(default)]
    pub client_intent_id: Option<String>,
    #[serde(default)]
    pub requested_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub until_seconds: Option<f64>,
    #[serde(default)]
    pub max_steps: Option<u64>,
    #[serde(default)]
    pub torque_tolerance: Option<f64>,
    #[serde(default)]
    pub energy_tolerance: Option<f64>,
    #[serde(default)]
    pub integrator: Option<String>,
    #[serde(default)]
    pub fixed_timestep: Option<f64>,
    #[serde(default)]
    pub max_error: Option<f64>,
    #[serde(default)]
    pub solver_policy: Option<SolverPolicyRequest>,
    #[serde(default)]
    pub relax_algorithm: Option<String>,
    #[serde(default)]
    pub relax_alpha: Option<f64>,
    #[serde(default)]
    pub mesh_options: Option<serde_json::Value>,
    #[serde(default)]
    pub mesh_target: Option<MeshCommandTarget>,
    #[serde(default)]
    pub mesh_reason: Option<String>,
    #[serde(default)]
    pub state_path: Option<String>,
    #[serde(default)]
    pub state_format: Option<String>,
    #[serde(default)]
    pub state_dataset: Option<String>,
    #[serde(default)]
    pub state_sample_index: Option<i64>,
    #[serde(default)]
    pub display_selection: Option<CurrentDisplaySelection>,
    #[serde(default)]
    pub preview_config: Option<fullmag_runner::LivePreviewRequest>,
    /// Stages for `run_sequence` command.
    #[serde(default)]
    pub stages: Option<Vec<fullmag_runner::SequenceStage>>,
    #[serde(default)]
    pub profile: Option<serde_json::Value>,
}

#[cfg(test)]
mod solver_policy_compatibility_tests {
    use super::SolverPolicyRequest;

    #[test]
    fn solver_policy_matches_shared_api_cli_serde_fixture() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../fullmag-ir/tests/fixtures/solver-policy-transport.json"
        ))
        .expect("shared solver policy fixture must be valid JSON");
        let policies: Vec<SolverPolicyRequest> =
            serde_json::from_value(fixture.clone()).expect("CLI policy must decode fixture");
        assert_eq!(
            serde_json::to_value(policies).expect("CLI policy must encode fixture"),
            fixture
        );
    }
}

#[derive(Debug, Clone, Serialize)]
#[allow(non_snake_case)]
pub(crate) struct CurrentLiveScalarRow {
    pub step: u64,
    pub time: f64,
    pub solver_dt: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_estimate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_error: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt_suggested: Option<f64>,
    #[serde(default)]
    pub rejected_attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pseudo_time_s: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_runtime_s: Option<f64>,
    pub mx: f64,
    pub my: f64,
    pub mz: f64,
    pub e_ex: f64,
    pub e_demag: f64,
    pub e_ext: f64,
    pub e_ani: f64,
    pub e_dmi: f64,
    pub e_total: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    pub max_torque_Apm: f64,
    pub max_torque_T: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct CurrentLiveStageExecutionRecord {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<fullmag_ir::StageStopReason>,
    #[serde(default)]
    pub converged: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub artifact_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checkpoint_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loaded_state_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_from_checkpoint_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_transition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_transition_kind: Option<StageTransitionKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_transition_reason: Option<StageTransitionReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_transfer_operator_kind: Option<StateTransferOperatorKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_transition_ui_presentation: Option<StageTransitionUiPresentation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<fullmag_ir::StageMetricKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub threshold: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_progress_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_field_m_t: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_point_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_settle_step_index: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_settle_step_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_settle_step_method: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct CurrentLiveStageExecutionState {
    pub total_stages: usize,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub completed_stage_indexes: Vec<usize>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stages: Vec<CurrentLiveStageExecutionRecord>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stage_statuses: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_stage_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_stage_kind: Option<String>,
    pub runtime_state: String,
}

#[derive(Debug, Clone, Serialize, Default)]
pub(crate) struct CurrentLiveSnapshotPayload {
    pub session: Option<SessionManifest>,
    pub session_status: Option<String>,
    pub metadata: Option<serde_json::Value>,
    pub run: Option<RunManifest>,
    pub live_state: Option<LiveStateManifest>,
    pub latest_scalar_row: Option<CurrentLiveScalarRow>,
    pub latest_fields: Option<CurrentLiveLatestFields>,
    pub preview_fields: Option<Vec<fullmag_runner::LivePreviewField>>,
    pub clear_preview_cache: bool,
    pub engine_log: Option<Vec<EngineLogEntry>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solver_profile: Option<fullmag_runner::SolverProfileSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_workspace: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_execution: Option<CurrentLiveStageExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simulation_preparation: Option<SimulationPreparationState>,
    /// Typed runtime status for the frontend typed protocol.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_status: Option<fullmag_runner::RuntimeStatus>,
    /// Explicit mesh payload — promoted to top-level so the mesh lifecycle is
    /// an independent event, not hidden inside `live_state.latest_step`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<fullmag_runner::FemMeshPayload>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(transparent)]
pub(crate) struct CurrentLiveLatestFields(pub BTreeMap<String, serde_json::Value>);

impl CurrentLiveLatestFields {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn insert(&mut self, quantity: String, value: serde_json::Value) {
        self.0.insert(quantity, value);
    }

}

#[derive(Debug, Clone, Default)]
pub(crate) struct CurrentLivePreviewFieldCache(BTreeMap<String, fullmag_runner::LivePreviewField>);

impl CurrentLivePreviewFieldCache {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn clear(&mut self) {
        self.0.clear();
    }

    pub fn insert(&mut self, field: fullmag_runner::LivePreviewField) {
        self.0.insert(field.quantity.clone(), field);
    }

    pub fn insert_replacing(
        &mut self,
        field: fullmag_runner::LivePreviewField,
    ) -> Option<fullmag_runner::LivePreviewField> {
        self.0.insert(field.quantity.clone(), field)
    }

    pub fn replace_all(
        &mut self,
        fields: impl IntoIterator<Item = fullmag_runner::LivePreviewField>,
    ) {
        self.clear();
        for field in fields {
            self.insert(field);
        }
    }

    pub fn to_vec(&self) -> Vec<fullmag_runner::LivePreviewField> {
        self.0.values().cloned().collect()
    }

    pub fn take_vec(&mut self) -> Vec<fullmag_runner::LivePreviewField> {
        std::mem::take(&mut self.0).into_values().collect()
    }

    #[cfg(test)]
    pub fn vector_values_ptr(&self, quantity: &str) -> Option<*const f64> {
        self.0
            .get(quantity)
            .map(|field| field.vector_field_values.as_ptr())
    }
}

#[derive(Debug, Serialize)]
pub(crate) struct CurrentLiveSnapshotRequest<'a> {
    pub session_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<&'a SessionManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_status: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<&'a RunManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_state: Option<&'a LiveStateManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_scalar_row: Option<&'a CurrentLiveScalarRow>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_fields: Option<&'a CurrentLiveLatestFields>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_fields: Option<&'a [fullmag_runner::LivePreviewField]>,
    pub clear_preview_cache: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_log: Option<&'a [EngineLogEntry]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solver_profile: Option<&'a fullmag_runner::SolverProfileSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_workspace: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_execution: Option<&'a CurrentLiveStageExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simulation_preparation: Option<&'a SimulationPreparationState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<&'a fullmag_runner::FemMeshPayload>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CurrentLiveSessionFrameRequest<'a> {
    pub session_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<&'a SessionManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_status: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_workspace: Option<&'a serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_execution: Option<&'a CurrentLiveStageExecutionState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub simulation_preparation: Option<&'a SimulationPreparationState>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run: Option<&'a RunManifest>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CurrentLiveRuntimeFrameRequest<'a> {
    pub session_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_state: Option<&'a LiveStateManifest>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine_log: Option<&'a [EngineLogEntry]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub solver_profile: Option<&'a fullmag_runner::SolverProfileSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<&'a fullmag_runner::FemMeshPayload>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CurrentLiveScalarFrameRequest<'a> {
    pub session_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_scalar_row: Option<&'a CurrentLiveScalarRow>,
}

#[derive(Debug, Serialize)]
pub(crate) struct CurrentLiveFieldFrameRequest<'a> {
    pub session_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_fields: Option<&'a CurrentLiveLatestFields>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_fields: Option<&'a [fullmag_runner::LivePreviewField]>,
    pub clear_preview_cache: bool,
}

#[derive(Debug, Clone)]
pub(crate) enum PythonProgressEvent {
    Message(String),
    FemSurfacePreview {
        geometry_name: String,
        fem_mesh: fullmag_runner::FemMeshPayload,
        message: Option<String>,
    },
    Structured {
        kind: String,
        payload: serde_json::Value,
    },
}

#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub(crate) struct PythonProgressEnvelope {
    pub kind: String,
    #[serde(default)]
    pub geometry_name: Option<String>,
    #[serde(default)]
    pub fem_mesh: Option<fullmag_runner::FemMeshPayload>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

pub(crate) type PythonProgressCallback = Arc<dyn Fn(PythonProgressEvent) + Send + Sync + 'static>;

#[derive(Debug, Deserialize)]
pub(crate) struct LoadedMagnetizationState {
    pub vector_count: usize,
    pub values: Vec<[f64; 3]>,
}
