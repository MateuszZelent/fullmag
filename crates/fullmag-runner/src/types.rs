//! Public and internal types for the runner.

use fullmag_ir::{FemMeshPartRole, FemMeshPartSelector, MeshQualityIR, StageCompletionIR};
pub use fullmag_quantities::{
    FemMaterialFieldLocation, FemRepresentationReceipt, FemStateRepresentation,
};
use serde::{de::Error as DeError, Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::sync::atomic::AtomicBool;

#[cfg(test)]
thread_local! {
    static FEM_MESH_PAYLOAD_BUILD_COUNT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    static FEM_MESH_FINGERPRINT_COUNT: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
fn reset_fem_mesh_payload_build_count() {
    FEM_MESH_PAYLOAD_BUILD_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
fn fem_mesh_payload_build_count() -> u64 {
    FEM_MESH_PAYLOAD_BUILD_COUNT.with(std::cell::Cell::get)
}

#[cfg(test)]
pub(crate) fn reset_fem_mesh_fingerprint_count() {
    FEM_MESH_FINGERPRINT_COUNT.with(|count| count.set(0));
}

#[cfg(test)]
pub(crate) fn fem_mesh_fingerprint_count() -> u64 {
    FEM_MESH_FINGERPRINT_COUNT.with(std::cell::Cell::get)
}

fn record_fem_mesh_payload_build() {
    #[cfg(test)]
    FEM_MESH_PAYLOAD_BUILD_COUNT.with(|count| count.set(count.get().saturating_add(1)));
}

// ----- public types -----

/// Public result type returned by [`crate::run_reference_fem_eigen`].
///
/// Contains the solver status and all artifact files (spectrum, modes) written
/// during the eigenmode solve.  Artifact bytes are the raw JSON content.
#[derive(Debug, Clone)]
pub struct FemEigenRunResult {
    /// Whether the solve completed successfully.
    pub status: RunStatus,
    /// Artifact files produced by the solver.
    /// Each entry is `(relative_path, bytes)`, e.g.
    /// `("eigen/spectrum.json", ...)` or `("eigen/modes/mode_0000.json", ...)`.
    pub artifacts: Vec<(String, Vec<u8>)>,
}

impl FemEigenRunResult {
    /// Return the bytes of the artifact at `relative_path`, if present.
    pub fn artifact_bytes(&self, relative_path: &str) -> Option<&[u8]> {
        self.artifacts
            .iter()
            .find(|(p, _)| p == relative_path)
            .map(|(_, b)| b.as_slice())
    }

    /// Parse the spectrum artifact as JSON and return all mode frequencies in Hz.
    pub fn spectrum_frequencies_hz(&self) -> Vec<f64> {
        let bytes = match self.artifact_bytes("eigen/spectrum.json") {
            Some(b) => b,
            None => return vec![],
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(bytes) else {
            return vec![];
        };
        value["modes"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("frequency_hz").and_then(|f| f.as_f64()))
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunResult {
    pub status: RunStatus,
    pub steps: Vec<StepStats>,
    pub final_magnetization: Vec<[f64; 3]>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completion: Option<StageCompletionIR>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemCpuRelaxationQualificationMetadata {
    pub schema_version: String,
    pub benchmark_gate_version: String,
    pub physics_terms: Vec<String>,
    pub solver_mesh_signature: String,
    pub demag_policy: FemCpuRelaxationDemagPolicyMetadata,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub algorithm_policy: Option<FemCpuRelaxationAlgorithmPolicyMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assembly_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relaxation_algorithm: Option<String>,
    pub converged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_metric_kind: Option<fullmag_ir::StageMetricKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_metric_unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_metric_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_metric_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_threshold: Option<f64>,
    pub final_energy_terms_j: FemCpuRelaxationEnergyTerms,
    pub final_torque_apm: f64,
    pub final_torque_t: f64,
    pub norm_defect: f64,
    pub executed_steps: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemCpuRelaxationAlgorithmPolicyMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_integrator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precession_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rhs_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_metric: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_direction_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_search_step_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armijo_slope_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armijo_decrement_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armijo_derivative_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_search: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preconditioner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linear_solver_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tangent_operator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_status: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemGpuRelaxationQualificationMetadata {
    pub schema_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relaxation_algorithm: Option<String>,
    pub algorithm_policy: FemGpuRelaxationAlgorithmPolicyMetadata,
    pub device_policy: FemGpuRelaxationDevicePolicyMetadata,
    pub converged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_metric_kind: Option<fullmag_ir::StageMetricKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_metric_unit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_metric_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_metric_value: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stop_threshold: Option<f64>,
    pub final_energy_terms_j: FemCpuRelaxationEnergyTerms,
    pub final_torque_apm: f64,
    pub final_torque_t: f64,
    pub norm_defect: f64,
    pub executed_steps: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemGpuRelaxationAlgorithmPolicyMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub realization: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time_integrator: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precession_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rhs_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_metric: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search_direction_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_search_step_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armijo_slope_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armijo_decrement_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armijo_derivative_units: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_search: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub direction_update: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step_update: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemGpuRelaxationDevicePolicyMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualification_status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_residency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exchange_operator_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_operator_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uses_cuda_kernels: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uses_gpu_poisson: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hot_loop_exchange_host_sync_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hot_loop_compute_host_sync_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hot_loop_control_scalar_host_sync_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemCpuRelaxationDemagPolicyMetadata {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub boundary_variant: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linear_solver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preconditioner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_tolerance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub absolute_tolerance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub print_level: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub actual_iterations: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub final_residual_norm: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub solver_setup_reused: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timings_ns: Option<FemCpuRelaxationDemagTimingsNs>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FemCpuRelaxationDemagTimingsNs {
    pub assemble: u64,
    pub solve: u64,
    pub solver_setup: u64,
    pub solver_apply: u64,
    pub recover: u64,
    pub energy: u64,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[allow(non_snake_case)]
pub struct FemCpuRelaxationEnergyTerms {
    #[serde(rename = "E_ex")]
    pub e_ex: f64,
    #[serde(rename = "E_demag")]
    pub e_demag: f64,
    #[serde(rename = "E_ext")]
    pub e_ext: f64,
    #[serde(default)]
    pub e_drive: f64,
    #[serde(rename = "E_ani")]
    pub e_ani: f64,
    #[serde(rename = "E_dmi")]
    pub e_dmi: f64,
    #[serde(rename = "E_total")]
    pub e_total: f64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Completed,
    Failed,
    Cancelled,
    /// The solver paused cleanly (user-requested). The runtime state is
    /// preserved and can be resumed.
    Paused,
}

/// Returned by the `on_step` callback to signal whether the runner should continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepAction {
    /// Continue the simulation.
    Continue,
    /// Stop the simulation as soon as possible (user-requested cancellation).
    Stop,
    /// Pause the simulation cleanly — preserve runtime state for resume.
    Pause,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverAttemptRecord {
    pub attempt: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_controller_policy_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_norm_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_node_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_measure: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalization_denominator: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_scaled_error: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub weighted_rms_error: Option<f64>,
    pub target_step: u64,
    pub time: f64,
    pub dt_attempt: f64,
    pub eta: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_norm_defect: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_spin_rotation: Option<f64>,
    pub decision: String,
    pub reason: String,
    pub dt_next: f64,
    pub demag_solves: u32,
    pub demag_iterations: u32,
    pub demag_residual: f64,
    pub rhs_evals: u32,
    pub estimator_order: i32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LiveFieldMaterializationState {
    Pending,
    Complete,
    Superseded,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiveFieldMaterializationStatus {
    pub quantity: String,
    pub source_step: u64,
    pub request_revision: u64,
    pub state: LiveFieldMaterializationState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(non_snake_case)]
pub struct StepStats {
    pub step: u64,
    pub time: f64,
    pub dt: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pseudo_time_s: Option<f64>,
    pub mx: f64,
    pub my: f64,
    pub mz: f64,
    pub e_ex: f64,
    pub e_demag: f64,
    pub e_ext: f64,
    #[serde(default)]
    pub e_drive: f64,
    pub e_ani: f64,
    pub e_dmi: f64,
    pub e_total: f64,
    pub max_dm_dt: f64,
    /// Maximum total dynamic RHS norm in 1/s.
    ///
    /// This is distinct from the field-equilibrium residual in
    /// `max_torque_Apm`; direct torques may contribute here.
    #[serde(default)]
    pub max_rhs_norm_per_s: f64,
    /// Maximum total dynamic RHS over all active DOFs, before frozen-spin masking.
    #[serde(default)]
    pub max_rhs_all_norm_per_s: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    /// Native max |m × H_eff| torque metric in A/m.
    #[serde(default)]
    pub max_torque_Apm: f64,
    /// Maximum field-equilibrium residual over all active DOFs in A/m.
    #[serde(default)]
    pub max_torque_all_Apm: f64,
    /// max |m × B_eff| = μ₀ · max_torque_Apm, in Tesla.
    /// Comparable to mumax MaxTorque.
    #[serde(default)]
    pub max_torque_T: f64,
    /// Largest norm difference between a frozen DOF and its activation reference.
    #[serde(default)]
    pub frozen_reference_max_drift: f64,
    #[serde(default)]
    pub active_dof_count: u64,
    #[serde(default)]
    pub frozen_dof_count: u64,
    #[serde(default)]
    pub free_dof_count: u64,
    #[serde(default)]
    pub accepted_energy_proof_available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_energy_delta_j: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_energy_roundoff_bound_j: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_energy_delta_upper_j: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub armijo_increment_rhs_j: Option<f64>,
    pub wall_time_ns: u64,
    /// One-time wall time spent constructing the native backend/context.
    ///
    /// This is attached to the first accepted step produced by that backend.
    #[serde(default)]
    pub backend_create_wall_time_ns: u64,
    #[serde(default)]
    pub exchange_wall_time_ns: u64,
    #[serde(default)]
    pub demag_wall_time_ns: u64,
    #[serde(default)]
    pub demag_assemble_wall_time_ns: u64,
    #[serde(default)]
    pub demag_solve_wall_time_ns: u64,
    #[serde(default)]
    pub demag_solver_setup_wall_time_ns: u64,
    #[serde(default)]
    pub demag_solver_apply_wall_time_ns: u64,
    /// Profiler-only RK transaction capture host wall time.
    #[serde(default)]
    pub rk_transaction_capture_host_wall_time_ns: u64,
    /// Device elapsed time for RK transaction capture; zero when not sampled.
    #[serde(default)]
    pub rk_transaction_capture_device_elapsed_time_ns: u64,
    #[serde(default)]
    pub rk_transaction_capture_bytes: u64,
    #[serde(default)]
    pub rk_transaction_restore_host_wall_time_ns: u64,
    /// Device elapsed time for RK transaction restore; zero when not sampled.
    #[serde(default)]
    pub rk_transaction_restore_device_elapsed_time_ns: u64,
    #[serde(default)]
    pub rk_transaction_restore_bytes: u64,
    #[serde(default)]
    pub rk_transaction_rollback_count: u64,
    #[serde(default)]
    pub rk_transaction_commit_count: u64,
    #[serde(default)]
    pub rk_transaction_cpu_snapshot_allocation_count: u64,
    #[serde(default)]
    pub rk_transaction_peak_rss_bytes: u64,
    /// Host time to enqueue the Fullmag→HYPRE dependency event.
    #[serde(default)]
    pub demag_hypre_wait_in_enqueue_wall_time_ns: u64,
    /// CPU time spent inside the HYPRE host API call.
    #[serde(default)]
    pub demag_hypre_host_api_wall_time_ns: u64,
    /// Device elapsed time measured on the borrowed HYPRE stream.
    #[serde(default)]
    pub demag_hypre_device_elapsed_time_ns: u64,
    /// Host time to enqueue the HYPRE→Fullmag dependency event.
    #[serde(default)]
    pub demag_hypre_wait_out_enqueue_wall_time_ns: u64,
    #[serde(default)]
    pub demag_hypre_event_wait_count: u64,
    #[serde(default)]
    pub demag_hypre_timed_solve_count: u64,
    #[serde(default)]
    pub demag_potential_order: i32,
    #[serde(default)]
    pub demag_potential_true_dof_count: u64,
    #[serde(default)]
    pub demag_variational_energy_joules: f64,
    #[serde(default)]
    pub demag_recovered_field_energy_joules: f64,
    #[serde(default)]
    pub demag_solver_setup_reused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_solver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_preconditioner: Option<String>,
    /// Effective native BoomerAMG policy copied from the native step-stats ABI.
    #[serde(default)]
    pub demag_amg_relax_type: i32,
    #[serde(default)]
    pub demag_amg_coarsening: i32,
    #[serde(default)]
    pub demag_amg_interpolation: i32,
    #[serde(default)]
    pub demag_amg_aggressive_coarsening: i32,
    #[serde(default)]
    pub demag_amg_strength_threshold: f64,
    #[serde(default)]
    pub demag_amg_strength_threshold_is_set: bool,
    #[serde(default)]
    pub demag_amg_max_levels: i32,
    #[serde(default)]
    pub demag_amg_max_levels_is_set: bool,
    #[serde(default)]
    pub demag_recover_wall_time_ns: u64,
    #[serde(default)]
    pub demag_energy_wall_time_ns: u64,
    #[serde(default)]
    pub rhs_wall_time_ns: u64,
    #[serde(default)]
    pub extra_energy_wall_time_ns: u64,
    #[serde(default)]
    pub snapshot_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_preconditioner_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_state_copy_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_state_upload_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_retraction_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_gradient_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_metric_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_line_search_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_update_wall_time_ns: u64,
    #[serde(default)]
    pub relaxation_preconditioner_cache_hits: u32,
    #[serde(default)]
    pub relaxation_preconditioner_cache_misses: u32,
    /// Native FFI wall time not attributed by the backend phase profiler.
    #[serde(default)]
    pub native_ffi_overhead_wall_time_ns: u64,
    /// Wall-clock time spent on active preview field extraction (ns).
    #[serde(default)]
    pub preview_wall_time_ns: u64,
    /// Wall-clock time spent on cached (non-active) preview field copies (ns).
    #[serde(default)]
    pub cached_preview_wall_time_ns: u64,
    /// Nonblocking worker-completion query time inside the preview handoff (ns).
    #[serde(default)]
    pub preview_harvest_query_wall_time_ns: u64,
    /// Completed preview result promotion into active/cache-ready ownership (ns).
    #[serde(default)]
    pub preview_result_promotion_wall_time_ns: u64,
    /// Bounded-worker capacity checks inside the preview handoff (ns).
    #[serde(default)]
    pub preview_can_accept_wall_time_ns: u64,
    /// Native vector-field snapshot scheduling time inside the preview handoff (ns).
    #[serde(default)]
    pub preview_vector_snapshot_schedule_wall_time_ns: u64,
    /// Native energy-density snapshot scheduling time inside the preview handoff (ns).
    #[serde(default)]
    pub preview_energy_snapshot_schedule_wall_time_ns: u64,
    /// Cache-cycle request coalescing time inside the preview handoff (ns).
    #[serde(default)]
    pub preview_queue_coalescing_wall_time_ns: u64,
    /// Bounded materializer job submission time inside the preview handoff (ns).
    #[serde(default)]
    pub preview_submit_wall_time_ns: u64,
    /// Time spent staging a deferred preview request for submission (ns).
    #[serde(default)]
    pub preview_submit_stage_wall_time_ns: u64,
    /// Time spent constructing submission descriptors and identities (ns).
    #[serde(default)]
    pub preview_submit_descriptor_wall_time_ns: u64,
    /// Time spent allocating per-submission acknowledgement channels (ns).
    #[serde(default)]
    pub preview_submit_channel_alloc_wall_time_ns: u64,
    /// Time spent in the nonblocking worker-channel send (ns).
    #[serde(default)]
    pub preview_submit_try_send_wall_time_ns: u64,
    /// Time spent recording submission ownership and failure state (ns).
    #[serde(default)]
    pub preview_submit_bookkeeping_wall_time_ns: u64,
    /// Calling-thread CPU time consumed by preview submission (ns).
    #[serde(default)]
    pub preview_submit_thread_cpu_time_ns: u64,
    /// Calling-thread CPU time consumed by the full preview callback (ns).
    #[serde(default)]
    pub preview_callback_thread_cpu_time_ns: u64,
    /// Internal absolute thread-CPU timestamp carried across the synchronous runner callback.
    #[serde(skip)]
    pub preview_callback_thread_cpu_started_ns: Option<u64>,
    /// Pre-step wait for the scheduler to enqueue exact-step native snapshots (ns).
    #[serde(default)]
    pub preview_schedule_fence_wall_time_ns: u64,
    /// Preview requests deliberately superseded while the bounded worker was busy.
    #[serde(default)]
    pub preview_superseded_count: u64,
    /// Bounded materializer ownership/state for each requested live field quantity.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_materialization_states: Vec<LiveFieldMaterializationStatus>,
    /// Capture step for the optional live magnetization payload in the enclosing StepUpdate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_source_step: Option<u64>,
    /// Monotonic capture revision for the optional live magnetization payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_source_revision: Option<u64>,
    /// Wall-clock completion time for the optional live magnetization payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_materialized_at_unix_ms: Option<u64>,
    /// Snapshot completion/copy duration for the optional live magnetization payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magnetization_materialization_wall_time_ns: Option<u64>,
    /// Wall-clock time spent in synchronous runner/CLI live callback orchestration (ns).
    #[serde(default)]
    pub orchestration_wall_time_ns: u64,
    /// Wall-clock time spent materializing or cloning FEM mesh payloads for this callback (ns).
    #[serde(default)]
    pub mesh_payload_wall_time_ns: u64,
    /// Number of deep `StepUpdate` clones performed by host orchestration.
    #[serde(default)]
    pub step_update_deep_clone_count: u64,
    /// Wall-clock time spent building the live-state resource under the workspace lock (ns).
    #[serde(default)]
    pub live_state_build_wall_time_ns: u64,
    /// Wall-clock time spent replacing the pending publisher payload synchronously (ns).
    #[serde(default)]
    pub publisher_replace_wall_time_ns: u64,
    /// Wall-clock time spent preparing an enabled profiler sample for persistence (ns).
    #[serde(default)]
    pub profile_persist_enqueue_wall_time_ns: u64,
    /// Wall-clock time spent copying full field payloads for live/artifact handoff (ns).
    #[serde(default)]
    pub field_copy_wall_time_ns: u64,
    /// Full field payload bytes copied for live/artifact handoff.
    #[serde(default)]
    pub field_copy_bytes: u64,
    /// Wall-clock time spent waiting to enqueue artifact writer jobs (ns).
    #[serde(default)]
    pub artifact_enqueue_block_wall_time_ns: u64,
    /// Estimated artifact payload bytes enqueued from this step.
    #[serde(default)]
    pub artifact_enqueue_bytes: u64,
    /// Maximum observed artifact writer queue depth after enqueue.
    #[serde(default)]
    pub artifact_queue_depth_max: u64,
    /// Current artifact writer queue depth observed by the live diagnostics snapshot.
    #[serde(default)]
    pub artifact_queue_depth_current: u64,
    /// Completed artifact writer jobs observed by the live diagnostics snapshot.
    #[serde(default)]
    pub artifact_writer_jobs_completed: u64,
    /// Total writer-thread artifact job wall time observed by the live diagnostics snapshot.
    #[serde(default)]
    pub artifact_writer_job_wall_time_ns: u64,
    /// Writer-thread scalar row wall time observed by the live diagnostics snapshot.
    #[serde(default)]
    pub artifact_scalar_row_writer_wall_time_ns: u64,
    /// Writer-thread field snapshot wall time observed by the live diagnostics snapshot.
    #[serde(default)]
    pub artifact_field_snapshot_writer_wall_time_ns: u64,
    /// Writer-thread native field snapshot wall time observed by the live diagnostics snapshot.
    #[serde(default)]
    pub artifact_native_field_snapshot_writer_wall_time_ns: u64,
    /// End-of-stage finalization wall time spent building final field outputs.
    #[serde(default)]
    pub finalization_wall_time_ns: u64,
    /// End-of-stage finalization wall time spent copying full field outputs.
    #[serde(default)]
    pub finalization_field_copy_wall_time_ns: u64,
    /// End-of-stage finalization full-field output bytes copied.
    #[serde(default)]
    pub finalization_field_copy_bytes: u64,
    // --- adaptive time-stepping diagnostics (PR1) ---
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_estimate: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_error: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dt_suggested: Option<f64>,
    #[serde(default)]
    pub rejected_attempts: u32,
    #[serde(default)]
    pub relaxation_energy_rejected_attempts: u64,
    #[serde(default)]
    pub relaxation_controller_tightenings: u64,
    #[serde(default)]
    pub relaxation_controller_at_floor: bool,
    #[serde(default)]
    pub relaxation_torque_confirmation_count: u32,
    #[serde(default)]
    pub rhs_evals: u32,
    #[serde(default)]
    pub demag_solves: u32,
    #[serde(default)]
    pub fsal_reused: bool,
    /// Optional native CPU RK accepted-endpoint cache receipt.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint_cache_telemetry: Option<fullmag_quantities::EndpointCacheTelemetry>,
    /// Versioned receipt of the native FEM state/material representation and
    /// cumulative conversion traffic observed by this backend handle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_representation_receipt: Option<FemRepresentationReceipt>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub solver_attempts: Vec<SolverAttemptRecord>,
    /// Number of PCG iterations in the last Poisson demag solve.
    #[serde(default)]
    pub poisson_iterations: u32,
    /// Final residual norm of the last Poisson demag solve.
    #[serde(default)]
    pub poisson_final_residual: f64,
    /// Whether demag was refreshed (true) or used frozen field (false) this step.
    #[serde(default)]
    pub demag_refreshed: bool,
    /// FEM requested OMP thread count (from C++ context, constant per run).
    #[serde(default)]
    pub requested_fem_omp_threads: i32,
    /// FEM effective OMP thread count (after auto-capping, constant per run).
    #[serde(default)]
    pub effective_fem_omp_threads: i32,
    /// Native FEM CPU thread-cap reason code.
    #[serde(default)]
    pub fem_cpu_thread_cap_reason: i32,
    /// Cumulative H2D bytes observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_h2d_bytes: u64,
    /// Cumulative D2H bytes observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_d2h_bytes: u64,
    /// Cumulative MFEM HostRead calls observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_host_read_count: u64,
    /// Cumulative MFEM HostWrite calls observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_host_write_count: u64,
    /// Cumulative MFEM host-access calls observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_host_sync_count: u64,
    /// Cumulative exchange-interop H2D bytes observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_exchange_h2d_bytes: u64,
    /// Cumulative exchange-interop D2H bytes observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_exchange_d2h_bytes: u64,
    /// Cumulative exchange-interop host sync calls observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_exchange_host_sync_count: u64,
    /// Cumulative non-exchange/RK H2D bytes observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_compute_h2d_bytes: u64,
    /// Cumulative non-exchange/RK D2H bytes observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_compute_d2h_bytes: u64,
    /// Cumulative non-exchange/RK host sync calls observed inside the native FEM hot loop.
    #[serde(default)]
    pub hot_loop_compute_host_sync_count: u64,
    /// Cumulative control-scalar D2H bytes observed inside direct-minimizer hot loops.
    #[serde(default)]
    pub hot_loop_control_scalar_d2h_bytes: u64,
    /// Cumulative control-scalar host sync calls observed inside direct-minimizer hot loops.
    #[serde(default)]
    pub hot_loop_control_scalar_host_sync_count: u64,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_object_scalars: HashMap<String, HashMap<String, f64>>,
}

impl Default for StepStats {
    fn default() -> Self {
        Self {
            step: 0,
            time: 0.0,
            dt: 0.0,
            pseudo_time_s: None,
            mx: 0.0,
            my: 0.0,
            mz: 0.0,
            e_ex: 0.0,
            e_demag: 0.0,
            e_ext: 0.0,
            e_drive: 0.0,
            e_ani: 0.0,
            e_dmi: 0.0,
            e_total: 0.0,
            max_dm_dt: 0.0,
            max_rhs_norm_per_s: 0.0,
            max_rhs_all_norm_per_s: 0.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            max_torque_all_Apm: 0.0,
            max_torque_T: 0.0,
            frozen_reference_max_drift: 0.0,
            active_dof_count: 0,
            frozen_dof_count: 0,
            free_dof_count: 0,
            accepted_energy_proof_available: false,
            accepted_energy_delta_j: None,
            accepted_energy_roundoff_bound_j: None,
            accepted_energy_delta_upper_j: None,
            armijo_increment_rhs_j: None,
            wall_time_ns: 0,
            backend_create_wall_time_ns: 0,
            exchange_wall_time_ns: 0,
            demag_wall_time_ns: 0,
            demag_assemble_wall_time_ns: 0,
            demag_solve_wall_time_ns: 0,
            demag_solver_setup_wall_time_ns: 0,
            demag_solver_apply_wall_time_ns: 0,
            rk_transaction_capture_host_wall_time_ns: 0,
            rk_transaction_capture_device_elapsed_time_ns: 0,
            rk_transaction_capture_bytes: 0,
            rk_transaction_restore_host_wall_time_ns: 0,
            rk_transaction_restore_device_elapsed_time_ns: 0,
            rk_transaction_restore_bytes: 0,
            rk_transaction_rollback_count: 0,
            rk_transaction_commit_count: 0,
            rk_transaction_cpu_snapshot_allocation_count: 0,
            rk_transaction_peak_rss_bytes: 0,
            demag_hypre_wait_in_enqueue_wall_time_ns: 0,
            demag_hypre_host_api_wall_time_ns: 0,
            demag_hypre_device_elapsed_time_ns: 0,
            demag_hypre_wait_out_enqueue_wall_time_ns: 0,
            demag_hypre_event_wait_count: 0,
            demag_hypre_timed_solve_count: 0,
            demag_potential_order: 0,
            demag_potential_true_dof_count: 0,
            demag_variational_energy_joules: 0.0,
            demag_recovered_field_energy_joules: 0.0,
            demag_solver_setup_reused: false,
            demag_solver: None,
            demag_preconditioner: None,
            demag_amg_relax_type: 0,
            demag_amg_coarsening: 0,
            demag_amg_interpolation: 0,
            demag_amg_aggressive_coarsening: 0,
            demag_amg_strength_threshold: 0.0,
            demag_amg_strength_threshold_is_set: false,
            demag_amg_max_levels: 0,
            demag_amg_max_levels_is_set: false,
            demag_recover_wall_time_ns: 0,
            demag_energy_wall_time_ns: 0,
            rhs_wall_time_ns: 0,
            extra_energy_wall_time_ns: 0,
            snapshot_wall_time_ns: 0,
            relaxation_preconditioner_wall_time_ns: 0,
            relaxation_state_copy_wall_time_ns: 0,
            relaxation_state_upload_wall_time_ns: 0,
            relaxation_retraction_wall_time_ns: 0,
            relaxation_gradient_wall_time_ns: 0,
            relaxation_metric_wall_time_ns: 0,
            relaxation_line_search_wall_time_ns: 0,
            relaxation_update_wall_time_ns: 0,
            relaxation_preconditioner_cache_hits: 0,
            relaxation_preconditioner_cache_misses: 0,
            native_ffi_overhead_wall_time_ns: 0,
            preview_wall_time_ns: 0,
            cached_preview_wall_time_ns: 0,
            preview_harvest_query_wall_time_ns: 0,
            preview_result_promotion_wall_time_ns: 0,
            preview_can_accept_wall_time_ns: 0,
            preview_vector_snapshot_schedule_wall_time_ns: 0,
            preview_energy_snapshot_schedule_wall_time_ns: 0,
            preview_queue_coalescing_wall_time_ns: 0,
            preview_submit_wall_time_ns: 0,
            preview_submit_stage_wall_time_ns: 0,
            preview_submit_descriptor_wall_time_ns: 0,
            preview_submit_channel_alloc_wall_time_ns: 0,
            preview_submit_try_send_wall_time_ns: 0,
            preview_submit_bookkeeping_wall_time_ns: 0,
            preview_submit_thread_cpu_time_ns: 0,
            preview_callback_thread_cpu_time_ns: 0,
            preview_callback_thread_cpu_started_ns: None,
            preview_schedule_fence_wall_time_ns: 0,
            preview_superseded_count: 0,
            field_materialization_states: Vec::new(),
            magnetization_source_step: None,
            magnetization_source_revision: None,
            magnetization_materialized_at_unix_ms: None,
            magnetization_materialization_wall_time_ns: None,
            orchestration_wall_time_ns: 0,
            mesh_payload_wall_time_ns: 0,
            step_update_deep_clone_count: 0,
            live_state_build_wall_time_ns: 0,
            publisher_replace_wall_time_ns: 0,
            profile_persist_enqueue_wall_time_ns: 0,
            field_copy_wall_time_ns: 0,
            field_copy_bytes: 0,
            artifact_enqueue_block_wall_time_ns: 0,
            artifact_enqueue_bytes: 0,
            artifact_queue_depth_max: 0,
            artifact_queue_depth_current: 0,
            artifact_writer_jobs_completed: 0,
            artifact_writer_job_wall_time_ns: 0,
            artifact_scalar_row_writer_wall_time_ns: 0,
            artifact_field_snapshot_writer_wall_time_ns: 0,
            artifact_native_field_snapshot_writer_wall_time_ns: 0,
            finalization_wall_time_ns: 0,
            finalization_field_copy_wall_time_ns: 0,
            finalization_field_copy_bytes: 0,
            error_estimate: None,
            max_error: None,
            dt_suggested: None,
            rejected_attempts: 0,
            relaxation_energy_rejected_attempts: 0,
            relaxation_controller_tightenings: 0,
            relaxation_controller_at_floor: false,
            relaxation_torque_confirmation_count: 0,
            rhs_evals: 0,
            demag_solves: 0,
            fsal_reused: false,
            endpoint_cache_telemetry: None,
            fem_representation_receipt: None,
            solver_attempts: Vec::new(),
            poisson_iterations: 0,
            poisson_final_residual: 0.0,
            demag_refreshed: false,
            requested_fem_omp_threads: 0,
            effective_fem_omp_threads: 0,
            fem_cpu_thread_cap_reason: 0,
            hot_loop_h2d_bytes: 0,
            hot_loop_d2h_bytes: 0,
            hot_loop_host_read_count: 0,
            hot_loop_host_write_count: 0,
            hot_loop_host_sync_count: 0,
            hot_loop_exchange_h2d_bytes: 0,
            hot_loop_exchange_d2h_bytes: 0,
            hot_loop_exchange_host_sync_count: 0,
            hot_loop_compute_h2d_bytes: 0,
            hot_loop_compute_d2h_bytes: 0,
            hot_loop_compute_host_sync_count: 0,
            hot_loop_control_scalar_d2h_bytes: 0,
            hot_loop_control_scalar_host_sync_count: 0,
            per_object_scalars: HashMap::new(),
        }
    }
}

#[cfg(test)]
mod all_in_gpu_fem_transfer_audit_tests {
    use super::{
        ExecutionProvenance, FdmMultilayerStageTelemetry, FdmMultilayerTransferTelemetry,
        FemMaterialFieldLocation, FemRepresentationReceipt, FemStateRepresentation, StepStats,
    };

    #[test]
    fn step_stats_carry_hot_loop_transfer_audit() {
        let stats = StepStats {
            hot_loop_h2d_bytes: 11,
            hot_loop_d2h_bytes: 17,
            hot_loop_host_read_count: 3,
            hot_loop_host_write_count: 5,
            hot_loop_host_sync_count: 8,
            hot_loop_exchange_host_sync_count: 2,
            hot_loop_compute_host_sync_count: 6,
            hot_loop_control_scalar_host_sync_count: 4,
            ..StepStats::default()
        };

        assert_eq!(stats.hot_loop_h2d_bytes, 11);
        assert_eq!(stats.hot_loop_d2h_bytes, 17);
        assert_eq!(stats.hot_loop_host_read_count, 3);
        assert_eq!(stats.hot_loop_host_write_count, 5);
        assert_eq!(stats.hot_loop_host_sync_count, 8);
        assert_eq!(stats.hot_loop_exchange_host_sync_count, 2);
        assert_eq!(stats.hot_loop_compute_host_sync_count, 6);
        assert_eq!(stats.hot_loop_control_scalar_host_sync_count, 4);
    }

    #[test]
    fn demag_profile_step_stats_flow_into_diagnostics() {
        let stats = StepStats {
            backend_create_wall_time_ns: 31,
            demag_wall_time_ns: 17,
            demag_assemble_wall_time_ns: 3,
            demag_solve_wall_time_ns: 5,
            demag_solver_setup_wall_time_ns: 13,
            demag_solver_apply_wall_time_ns: 19,
            demag_solver_setup_reused: true,
            demag_recover_wall_time_ns: 7,
            demag_energy_wall_time_ns: 11,
            extra_energy_wall_time_ns: 29,
            endpoint_cache_telemetry: Some(fullmag_quantities::EndpointCacheTelemetry {
                final_refresh_reason: "cache_hit".to_string(),
                cache_state_valid: true,
                cache_time_valid: true,
                cache_dynamic_sources_valid: true,
                cache_transport_valid: true,
                cache_projection_valid: true,
                final_rhs_evaluations: 2,
                extra_poisson_solves: 3,
                endpoint_cache_hits: 4,
                endpoint_refreshes: 5,
                accepted_step_wall_time_ns: 6,
            }),
            fem_representation_receipt: Some(FemRepresentationReceipt {
                schema_version: 1,
                state_space: FemStateRepresentation::LocalNodeAos,
                ms_location: FemMaterialFieldLocation::NodalP1,
                a_location: FemMaterialFieldLocation::ElementDg0,
                local_node_count: 12,
                true_node_count: 9,
                periodic_map_revision: 4,
                representation_copy_count: 7,
                gather_scatter_bytes: 288,
                invalid_space_assertion_count: 0,
                hot_loop_representation_copy_count: 2,
                hot_loop_gather_scatter_bytes: 96,
            }),
            ..StepStats::default()
        };

        let diagnostics = stats.to_diagnostics();
        assert_eq!(diagnostics.backend_create_wall_time_ns, 31);
        assert_eq!(diagnostics.demag_wall_time_ns, 17);
        assert_eq!(diagnostics.demag_assemble_wall_time_ns, 3);
        assert_eq!(diagnostics.demag_solve_wall_time_ns, 5);
        assert_eq!(diagnostics.demag_solver_setup_wall_time_ns, 13);
        assert_eq!(diagnostics.demag_solver_apply_wall_time_ns, 19);
        assert!(diagnostics.demag_solver_setup_reused);
        assert_eq!(diagnostics.demag_recover_wall_time_ns, 7);
        assert_eq!(diagnostics.demag_energy_wall_time_ns, 11);
        assert_eq!(diagnostics.extra_energy_wall_time_ns, 29);
        let endpoint = diagnostics
            .endpoint_cache_telemetry
            .as_ref()
            .expect("endpoint receipt should reach canonical diagnostics");
        assert_eq!(endpoint.final_refresh_reason, "cache_hit");
        assert_eq!(endpoint.final_rhs_evaluations, 2);
        assert_eq!(endpoint.extra_poisson_solves, 3);
        assert_eq!(endpoint.endpoint_cache_hits, 4);
        assert_eq!(endpoint.endpoint_refreshes, 5);
        assert_eq!(endpoint.accepted_step_wall_time_ns, 6);
        let receipt = diagnostics
            .fem_representation_receipt
            .as_ref()
            .expect("representation receipt should reach canonical diagnostics");
        assert_eq!(receipt.state_space, FemStateRepresentation::LocalNodeAos);
        assert_eq!(receipt.ms_location, FemMaterialFieldLocation::NodalP1);
        assert_eq!(receipt.a_location, FemMaterialFieldLocation::ElementDg0);
        assert_eq!(receipt.local_node_count, 12);
        assert_eq!(receipt.true_node_count, 9);
        assert_eq!(receipt.periodic_map_revision, 4);
        assert_eq!(receipt.representation_copy_count, 7);
        assert_eq!(receipt.gather_scatter_bytes, 288);
        assert_eq!(receipt.hot_loop_representation_copy_count, 2);
        assert_eq!(receipt.hot_loop_gather_scatter_bytes, 96);
        let serialized = serde_json::to_value(&diagnostics)
            .expect("canonical diagnostics should serialize with representation receipt");
        assert_eq!(
            serialized["fem_representation_receipt"]["state_space"],
            "local_node_aos"
        );
        assert_eq!(
            serialized["fem_representation_receipt"]["gather_scatter_bytes"],
            288
        );
        assert_eq!(diagnostics.relaxation_preconditioner_wall_time_ns, 0);
    }

    #[test]
    fn solver_profile_ring_buffer_keeps_latest_samples_and_phase_math() {
        let mut profile = crate::SolverProfileState::new(crate::SolverProfileConfig {
            enabled: true,
            sample_every: 1,
            sample_interval_wall_ms: 0,
            max_samples: 2,
            emit_engine_log: false,
            persist_artifact: false,
        });

        for step in 1..=3 {
            profile.record_step(&StepStats {
                step,
                wall_time_ns: 1_000,
                exchange_wall_time_ns: 100,
                demag_wall_time_ns: 250,
                demag_assemble_wall_time_ns: 30,
                demag_solver_setup_wall_time_ns: 40,
                demag_solver_apply_wall_time_ns: 120,
                demag_recover_wall_time_ns: 20,
                demag_energy_wall_time_ns: 10,
                extra_energy_wall_time_ns: 50,
                snapshot_wall_time_ns: 25,
                relaxation_preconditioner_wall_time_ns: 60,
                relaxation_state_copy_wall_time_ns: 10,
                relaxation_state_upload_wall_time_ns: 15,
                relaxation_retraction_wall_time_ns: 20,
                relaxation_gradient_wall_time_ns: 30,
                relaxation_metric_wall_time_ns: 40,
                relaxation_line_search_wall_time_ns: 50,
                relaxation_update_wall_time_ns: 60,
                relaxation_preconditioner_cache_hits: 2,
                relaxation_preconditioner_cache_misses: 1,
                native_ffi_overhead_wall_time_ns: 80,
                field_copy_wall_time_ns: 30,
                artifact_enqueue_block_wall_time_ns: 20,
                artifact_enqueue_bytes: 4096,
                artifact_queue_depth_max: 3,
                artifact_queue_depth_current: 1,
                artifact_writer_jobs_completed: 2,
                artifact_writer_job_wall_time_ns: 80,
                artifact_scalar_row_writer_wall_time_ns: 30,
                artifact_field_snapshot_writer_wall_time_ns: 50,
                rhs_evals: 3,
                rejected_attempts: 1,
                demag_solves: 2,
                demag_solver: Some("CG".to_string()),
                demag_preconditioner: Some("JACOBI".to_string()),
                poisson_iterations: 9,
                poisson_final_residual: 1.5e-8,
                requested_fem_omp_threads: 8,
                effective_fem_omp_threads: 4,
                fem_cpu_thread_cap_reason: 2,
                ..StepStats::default()
            });
        }

        let snapshot = profile.snapshot();
        assert_eq!(snapshot.revision, 3);
        assert_eq!(snapshot.latest_samples.len(), 2);
        assert_eq!(snapshot.latest_samples[0].step, 2);
        assert_eq!(snapshot.latest_samples[1].step, 3);
        assert!(snapshot.latest_samples[1].sample_time_unix_ms > 0);
        assert!(snapshot.latest_samples[1].delta_wall_time_ns.is_some());
        assert_eq!(snapshot.latest_samples[1].phase_sum_ns, 815);
        assert_eq!(snapshot.latest_samples[1].missing_ns, 185);
        assert_eq!(snapshot.latest_samples[1].artifact_enqueue_bytes, 4096);
        assert_eq!(snapshot.latest_samples[1].artifact_queue_depth_max, 3);
        assert_eq!(snapshot.latest_samples[1].artifact_queue_depth_current, 1);
        assert_eq!(snapshot.latest_samples[1].artifact_writer_jobs_completed, 2);
        assert_eq!(
            snapshot.latest_samples[1].artifact_writer_job_wall_time_ns,
            80
        );
        assert_eq!(
            snapshot.latest_samples[1].artifact_scalar_row_writer_wall_time_ns,
            30
        );
        assert_eq!(
            snapshot.latest_samples[1].artifact_field_snapshot_writer_wall_time_ns,
            50
        );
        assert_eq!(
            snapshot.latest_samples[1].relaxation_preconditioner_cache_hits,
            2
        );
        assert_eq!(
            snapshot.latest_samples[1].relaxation_preconditioner_cache_misses,
            1
        );
        assert_eq!(
            snapshot.latest_samples[1].threading.effective_omp_threads,
            4
        );
        assert_eq!(
            snapshot.latest_samples[1].threading.cap_reason,
            "auto-small-mesh-cap"
        );
        assert_eq!(
            snapshot.latest_samples[1].demag_solver.as_deref(),
            Some("CG")
        );
        assert_eq!(
            snapshot.latest_samples[1].demag_preconditioner.as_deref(),
            Some("JACOBI")
        );
        assert_eq!(snapshot.aggregates.sample_count, 2);
    }

    #[test]
    fn solver_profile_force_record_keeps_completion_finalization_visible() {
        let mut profile = crate::SolverProfileState::new(crate::SolverProfileConfig {
            enabled: true,
            sample_every: 1,
            sample_interval_wall_ms: 60_000,
            max_samples: 4,
            emit_engine_log: false,
            persist_artifact: false,
        });

        assert!(profile
            .record_step(&StepStats {
                step: 1,
                wall_time_ns: 1_000,
                ..StepStats::default()
            })
            .is_some());
        assert!(profile
            .record_step(&StepStats {
                step: 2,
                wall_time_ns: 2_000,
                ..StepStats::default()
            })
            .is_none());

        let forced = profile
            .force_record_step(&StepStats {
                step: 2,
                wall_time_ns: 3_000,
                finalization_wall_time_ns: 700,
                finalization_field_copy_wall_time_ns: 500,
                finalization_field_copy_bytes: 24_000,
                ..StepStats::default()
            })
            .expect("forced completion sample should bypass wall-clock sampling");
        let finalization_phase = forced
            .phases
            .iter()
            .find(|phase| phase.id == "finalization")
            .expect("missing finalization phase");

        assert_eq!(finalization_phase.wall_time_ns, 700);
        assert_eq!(forced.finalization_field_copy_wall_time_ns, 500);
        assert_eq!(forced.finalization_field_copy_bytes, 24_000);
        let samples = profile.snapshot().latest_samples;
        assert_eq!(samples.len(), 3);
        assert_eq!(samples[1].span_step_count, 1);
        assert_eq!(samples[2].span_step_count, 0);
    }

    #[test]
    fn solver_profile_gap_excludes_all_steps_between_sparse_samples() {
        let mut profile = crate::SolverProfileState::new(crate::SolverProfileConfig {
            enabled: true,
            sample_every: 3,
            sample_interval_wall_ms: 0,
            max_samples: 4,
            emit_engine_log: false,
            persist_artifact: false,
        });

        let first = profile
            .record_step(&StepStats {
                step: 3,
                wall_time_ns: 1_000_000,
                ..StepStats::default()
            })
            .expect("step 3 should be sampled");
        assert_eq!(first.delta_wall_time_ns, None);

        std::thread::sleep(std::time::Duration::from_millis(20));
        assert!(profile
            .record_step(&StepStats {
                step: 4,
                wall_time_ns: 2_000_000,
                ..StepStats::default()
            })
            .is_none());
        assert!(profile
            .record_step(&StepStats {
                step: 5,
                wall_time_ns: 3_000_000,
                ..StepStats::default()
            })
            .is_none());
        let second = profile
            .record_step(&StepStats {
                step: 6,
                wall_time_ns: 4_000_000,
                ..StepStats::default()
            })
            .expect("step 6 should be sampled");

        let delta = second
            .delta_wall_time_ns
            .expect("second sparse sample should have a wall delta");
        assert_eq!(
            second.unprofiled_gap_wall_time_ns,
            Some(delta.saturating_sub(9_000_000)),
        );
    }

    #[test]
    fn disabled_solver_profile_does_not_allocate_samples() {
        let mut profile = crate::SolverProfileState::default();

        profile.record_step(&StepStats {
            step: 1,
            wall_time_ns: 1_000,
            exchange_wall_time_ns: 100,
            ..StepStats::default()
        });

        let snapshot = profile.snapshot();
        assert!(!snapshot.config.enabled);
        assert_eq!(snapshot.revision, 0);
        assert!(snapshot.latest_samples.is_empty());
    }

    #[test]
    fn solver_profile_demag_total_covers_subphase_sum() {
        let sample = crate::SolverProfileStepSample::from_step_stats(&StepStats {
            step: 1,
            wall_time_ns: 1_000,
            demag_wall_time_ns: 10,
            demag_assemble_wall_time_ns: 30,
            demag_solver_setup_wall_time_ns: 40,
            demag_solver_apply_wall_time_ns: 50,
            demag_recover_wall_time_ns: 60,
            demag_energy_wall_time_ns: 70,
            ..StepStats::default()
        });
        let demag_total = sample
            .phases
            .iter()
            .find(|phase| phase.id == "demag_total")
            .expect("missing demag_total phase")
            .wall_time_ns;

        assert_eq!(sample.demag_subphase_sum_ns, 250);
        assert_eq!(demag_total, sample.demag_subphase_sum_ns);
        assert_eq!(sample.delta_wall_time_ns, None);
    }

    #[test]
    fn execution_provenance_carries_truthful_fem_gpu_runtime_contract() {
        let provenance = ExecutionProvenance {
            fem_execution_mode: Some("all_in_gpu_legacy_sparse".to_string()),
            fem_data_residency: Some("device_source_of_truth".to_string()),
            uses_cuda_kernels: Some(true),
            uses_gpu_poisson: Some(true),
            fem_demag_operator_mode: Some("device_hypre_poisson".to_string()),
            hypre_execution_policy: Some("device".to_string()),
            demag_residency: Some("device".to_string()),
            llg_mode: Some("pure_damping".to_string()),
            hot_loop_host_sync_count: Some(0),
            hot_loop_exchange_host_sync_count: Some(0),
            hot_loop_compute_host_sync_count: Some(0),
            hot_loop_control_scalar_host_sync_count: Some(0),
            ..ExecutionProvenance::default()
        };

        assert_eq!(
            provenance.fem_execution_mode.as_deref(),
            Some("all_in_gpu_legacy_sparse")
        );
        assert_eq!(
            provenance.fem_data_residency.as_deref(),
            Some("device_source_of_truth")
        );
        assert_eq!(provenance.uses_cuda_kernels, Some(true));
        assert_eq!(provenance.uses_gpu_poisson, Some(true));
        assert_eq!(
            provenance.fem_demag_operator_mode.as_deref(),
            Some("device_hypre_poisson")
        );
        assert_eq!(provenance.hypre_execution_policy.as_deref(), Some("device"));
        assert_eq!(provenance.demag_residency.as_deref(), Some("device"));
        assert_eq!(provenance.llg_mode.as_deref(), Some("pure_damping"));
        assert_eq!(provenance.hot_loop_host_sync_count, Some(0));
        assert_eq!(provenance.hot_loop_exchange_host_sync_count, Some(0));
        assert_eq!(provenance.hot_loop_compute_host_sync_count, Some(0));
        assert_eq!(provenance.hot_loop_control_scalar_host_sync_count, Some(0));
    }

    #[test]
    fn execution_provenance_serializes_fdm_multilayer_transfer_telemetry() {
        let provenance = ExecutionProvenance {
            fdm_multilayer_transfer_telemetry: Some(FdmMultilayerTransferTelemetry {
                execution_shape: "cuda_assisted_multilayer".to_string(),
                data_residency: "host_authoritative_with_cuda_field_roundtrips".to_string(),
                layer_count: 3,
                host_snapshot_count: 2,
                payload_precision: "double".to_string(),
                scalar_bytes: 8,
                setup_h2d_transfer_count: 3,
                setup_h2d_bytes: 4_608,
                observed_snapshot_d2h_transfer_count: 36,
                observed_snapshot_d2h_bytes: 55_296,
                warm_step_h2d_transfer_count: 0,
                warm_step_h2d_bytes: 0,
                warm_step_d2h_transfer_count: 0,
                warm_step_d2h_bytes: 0,
                h2d_transfer_count: 3,
                d2h_transfer_count: 36,
                h2d_bytes: 4_608,
                d2h_bytes: 55_296,
            }),
            ..ExecutionProvenance::default()
        };

        let value = serde_json::to_value(provenance).expect("provenance should serialize");
        assert_eq!(
            value["fdm_multilayer_transfer_telemetry"]["execution_shape"],
            "cuda_assisted_multilayer"
        );
        assert_eq!(
            value["fdm_multilayer_transfer_telemetry"]["data_residency"],
            "host_authoritative_with_cuda_field_roundtrips"
        );
        assert_eq!(value["fdm_multilayer_transfer_telemetry"]["layer_count"], 3);
        assert_eq!(
            value["fdm_multilayer_transfer_telemetry"]["host_snapshot_count"],
            2
        );
        assert_eq!(
            value["fdm_multilayer_transfer_telemetry"]["scalar_bytes"],
            8
        );
        assert_eq!(
            value["fdm_multilayer_transfer_telemetry"]["setup_h2d_bytes"],
            4_608
        );
        assert_eq!(
            value["fdm_multilayer_transfer_telemetry"]["observed_snapshot_d2h_transfer_count"],
            36
        );
        assert_eq!(
            value["fdm_multilayer_transfer_telemetry"]["warm_step_d2h_bytes"],
            0
        );
        assert_eq!(
            value["fdm_multilayer_transfer_telemetry"]["h2d_transfer_count"],
            3
        );
        assert_eq!(
            value["fdm_multilayer_transfer_telemetry"]["d2h_bytes"],
            55_296
        );
    }

    #[test]
    fn execution_provenance_serializes_native_multilayer_stage_telemetry() {
        let provenance = ExecutionProvenance {
            fdm_multilayer_stage_telemetry: Some(FdmMultilayerStageTelemetry {
                status: "recorded".to_string(),
                execution_engine: "cuda_native_multilayer_demag_v2".to_string(),
                data_residency: "device_resident_per_refresh".to_string(),
                fft_backend: "cuFFT".to_string(),
                layer_count: 3,
                refresh_count: 1,
                forward_fft_count: 3,
                inverse_fft_count: 3,
                pair_accumulation_count: 9,
            }),
            ..ExecutionProvenance::default()
        };

        let value = serde_json::to_value(provenance).expect("provenance should serialize");
        let telemetry = &value["fdm_multilayer_stage_telemetry"];
        assert_eq!(telemetry["status"], "recorded");
        assert_eq!(
            telemetry["execution_engine"],
            "cuda_native_multilayer_demag_v2"
        );
        assert_eq!(telemetry["data_residency"], "device_resident_per_refresh");
        assert_eq!(telemetry["fft_backend"], "cuFFT");
        assert_eq!(telemetry["layer_count"], 3);
        assert_eq!(telemetry["refresh_count"], 1);
        assert_eq!(telemetry["forward_fft_count"], 3);
        assert_eq!(telemetry["inverse_fft_count"], 3);
        assert_eq!(telemetry["pair_accumulation_count"], 9);
    }
}

impl StepStats {
    /// Extract solver diagnostics (non-physics telemetry).
    pub fn to_diagnostics(&self) -> fullmag_quantities::StepDiagnostics {
        fullmag_quantities::StepDiagnostics {
            step: self.step,
            time: self.time,
            dt: self.dt,
            wall_time_ns: self.wall_time_ns,
            backend_create_wall_time_ns: self.backend_create_wall_time_ns,
            exchange_wall_time_ns: self.exchange_wall_time_ns,
            demag_wall_time_ns: self.demag_wall_time_ns,
            demag_assemble_wall_time_ns: self.demag_assemble_wall_time_ns,
            demag_solve_wall_time_ns: self.demag_solve_wall_time_ns,
            demag_solver_setup_wall_time_ns: self.demag_solver_setup_wall_time_ns,
            demag_solver_apply_wall_time_ns: self.demag_solver_apply_wall_time_ns,
            demag_solver_setup_reused: self.demag_solver_setup_reused,
            demag_recover_wall_time_ns: self.demag_recover_wall_time_ns,
            demag_energy_wall_time_ns: self.demag_energy_wall_time_ns,
            rhs_wall_time_ns: self.rhs_wall_time_ns,
            extra_energy_wall_time_ns: self.extra_energy_wall_time_ns,
            snapshot_wall_time_ns: self.snapshot_wall_time_ns,
            relaxation_preconditioner_wall_time_ns: self.relaxation_preconditioner_wall_time_ns,
            relaxation_state_copy_wall_time_ns: self.relaxation_state_copy_wall_time_ns,
            relaxation_state_upload_wall_time_ns: self.relaxation_state_upload_wall_time_ns,
            relaxation_retraction_wall_time_ns: self.relaxation_retraction_wall_time_ns,
            relaxation_gradient_wall_time_ns: self.relaxation_gradient_wall_time_ns,
            relaxation_metric_wall_time_ns: self.relaxation_metric_wall_time_ns,
            relaxation_line_search_wall_time_ns: self.relaxation_line_search_wall_time_ns,
            relaxation_update_wall_time_ns: self.relaxation_update_wall_time_ns,
            relaxation_preconditioner_cache_hits: self.relaxation_preconditioner_cache_hits,
            relaxation_preconditioner_cache_misses: self.relaxation_preconditioner_cache_misses,
            finalization_wall_time_ns: self.finalization_wall_time_ns,
            finalization_field_copy_wall_time_ns: self.finalization_field_copy_wall_time_ns,
            finalization_field_copy_bytes: self.finalization_field_copy_bytes,
            error_estimate: self.error_estimate,
            max_error: self.max_error,
            dt_suggested: self.dt_suggested,
            rejected_attempts: self.rejected_attempts,
            rhs_evals: self.rhs_evals,
            demag_solves: self.demag_solves,
            fsal_reused: self.fsal_reused,
            endpoint_cache_telemetry: self.endpoint_cache_telemetry.clone(),
            fem_representation_receipt: self.fem_representation_receipt.clone(),
            poisson_iterations: self.poisson_iterations,
            poisson_final_residual: self.poisson_final_residual,
            demag_refreshed: self.demag_refreshed,
            max_torque_all_Apm: self.max_torque_all_Apm,
            frozen_reference_max_drift: self.frozen_reference_max_drift,
            active_dof_count: self.active_dof_count,
            frozen_dof_count: self.frozen_dof_count,
            free_dof_count: self.free_dof_count,
        }
    }

    /// Extract per-step physical scalar observations.
    pub fn to_quantity_row(&self) -> fullmag_quantities::GlobalQuantityRow {
        fullmag_quantities::GlobalQuantityRow {
            step: self.step,
            time: self.time,
            mx: self.mx,
            my: self.my,
            mz: self.mz,
            e_ex: self.e_ex,
            e_demag: self.e_demag,
            e_ext: self.e_ext,
            e_drive: self.e_drive,
            e_ani: self.e_ani,
            e_dmi: self.e_dmi,
            e_el: 0.0,
            e_kin_el: 0.0,
            e_total: self.e_total,
            elastic_residual_norm: 0.0,
            max_dm_dt: self.max_dm_dt,
            max_h_eff: self.max_h_eff,
            max_h_demag: self.max_h_demag,
            max_torque_Apm: self.max_torque_Apm,
            max_torque_T: self.max_torque_T,
            per_object_scalars: self.per_object_scalars.clone(),
        }
    }
}

/// Lightweight update emitted by the runner for live WebSocket streaming.
/// Contains step stats plus optional field snapshot for 3D preview.
///
/// **Migration note (Q16/Q17):** The canonical wire format for external
/// consumers is [`fullmag_quantities::StepUpdateV2`].  Use [`Self::to_v2()`]
/// to convert.  The legacy fields `magnetization`, `preview_field`, and
/// `cached_preview_fields` are retained for the internal runner→CLI callback
/// contract but should not be serialized to new external consumers.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StepUpdate {
    pub stats: StepStats,
    /// Internal restart envelope published to the session persistence resource.
    /// This is control-plane state, not a field/preview payload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub coupled_checkpoint: Option<serde_json::Value>,
    /// Grid dimensions [nx, ny, nz] for client-side reconstruction.
    pub grid: [u32; 3],
    /// Stage-scoped FEM mesh generation resolved through the separate mesh resource.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_mesh_generation_id: Option<String>,
    /// **Deprecated (Q16):** Use [`fullmag_quantities::LiveQuantityFrame`]
    /// with `quantity_id = "m"` via [`Self::to_v2()`] instead.
    ///
    /// Magnetization snapshot as flat \[mx,my,mz, mx,my,mz, ...\].
    /// Sent periodically (not every step) to limit bandwidth.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub magnetization: Option<Vec<f64>>,
    /// **Deprecated (Q17):** Use [`fullmag_quantities::LiveQuantityFrame`]
    /// via [`Self::to_v2()`] instead.
    ///
    /// Optional active preview field driven by the current UI preview request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_field: Option<LivePreviewField>,
    /// **Deprecated (Q17):** Use [`fullmag_quantities::LiveQuantityFrame`]
    /// via [`Self::to_v2()`] instead.
    ///
    /// Optional cached preview fields warmed in the background for instant
    /// quantity switching without waiting for a fresh live preview snapshot.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_preview_fields: Option<Vec<LivePreviewField>>,
    /// Current hysteresis field value in mT for live stage-progress UIs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hysteresis_field_m_t: Option<f64>,
    /// Zero-based hysteresis point index for live stage-progress UIs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hysteresis_point_index: Option<u32>,
    /// Zero-based settle-pipeline step index active within the current field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hysteresis_settle_step_index: Option<u32>,
    /// Settle-pipeline step kind active within the current field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hysteresis_settle_step_kind: Option<String>,
    /// Settle-pipeline method active within the current field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hysteresis_settle_step_method: Option<String>,
    /// True when this update also represents a due scalar-row sample.
    #[serde(default)]
    pub scalar_row_due: bool,
    /// Internal runner→CLI marker for a complete authoritative field generation.
    ///
    /// Individual asynchronously materialized fields must leave this false even
    /// when their own materialization timestamp is populated.
    #[serde(default)]
    pub terminal_field_snapshot: bool,
    /// true when simulation has completed.
    #[serde(default)]
    pub finished: bool,
}

impl StepUpdate {
    /// Convert to the canonical V2 transport format.
    ///
    /// Extracts diagnostics and scalar row from `StepStats`, and wraps
    /// the optional magnetization + preview fields as `LiveQuantityFrame`s.
    pub fn to_v2(&self) -> fullmag_quantities::StepUpdateV2 {
        let mut frames = Vec::new();
        let cached_m = self.cached_preview_fields.as_ref().and_then(|cached| {
            cached
                .iter()
                .find(|field| field.quantity == "m" && field.preview_grid == field.original_grid)
                .or_else(|| cached.iter().find(|field| field.quantity == "m"))
        });

        // A full-grid materialized m is the canonical terminal frame.  Do not
        // emit the legacy magnetization copy beside it: V2 consumers must not
        // resolve duplicate m frames by last-write-wins.
        if let Some(field) = cached_m {
            frames.push(live_quantity_frame_from_preview(field));
        } else if let Some(ref mag) = self.magnetization {
            frames.push(fullmag_quantities::LiveQuantityFrame {
                quantity_id: "m".to_string(),
                unit: fullmag_quantities::quantity_unit("m").to_string(),
                grid: self.grid,
                n_comp: fullmag_quantities::quantity_spec("m")
                    .map(|spec| spec.n_comp)
                    .unwrap_or(3),
                values: mag.clone(),
                active_mask: None,
                provenance: None,
                spatial_kind: None,
                quantity_domain: None,
                layout: None,
            });
        }

        // Active preview field → LiveQuantityFrame
        if let Some(ref pf) = self.preview_field {
            if pf.quantity != "m" || cached_m.is_none() && self.magnetization.is_none() {
                frames.push(live_quantity_frame_from_preview(pf));
            }
        }

        // Cached preview fields → LiveQuantityFrame each
        if let Some(ref cached) = self.cached_preview_fields {
            for cf in cached {
                if cf.quantity != "m" {
                    frames.push(live_quantity_frame_from_preview(cf));
                }
            }
        }

        fullmag_quantities::StepUpdateV2 {
            diagnostics: self.stats.to_diagnostics(),
            scalars: self.stats.to_quantity_row(),
            frames,
            finished: self.finished,
        }
    }
}

fn live_quantity_frame_from_preview(
    field: &LivePreviewField,
) -> fullmag_quantities::LiveQuantityFrame {
    fullmag_quantities::LiveQuantityFrame {
        quantity_id: field.quantity.clone(),
        unit: fullmag_quantities::quantity_unit(&field.quantity).to_string(),
        grid: field.preview_grid,
        n_comp: fullmag_quantities::quantity_spec(&field.quantity)
            .map(|spec| spec.n_comp)
            .unwrap_or(3),
        values: field.vector_field_values.clone(),
        active_mask: field.active_mask.clone(),
        provenance: Some(fullmag_quantities::LiveQuantityFrameProvenance {
            config_revision: field.config_revision,
            source_step: field.source_step,
            source_time_seconds: field.source_time_seconds,
            source_revision: field.source_revision,
            materialized_at_unix_ms: field.materialized_at_unix_ms,
            materialization_wall_time_ns: field.materialization_wall_time_ns,
        }),
        spatial_kind: Some(field.spatial_kind.clone()),
        quantity_domain: Some(field.quantity_domain.clone()),
        layout: Some(fullmag_quantities::LiveQuantityFrameLayout {
            original_grid: field.original_grid,
            x_chosen_size: field.x_chosen_size,
            y_chosen_size: field.y_chosen_size,
            applied_x_chosen_size: field.applied_x_chosen_size,
            applied_y_chosen_size: field.applied_y_chosen_size,
            applied_layer_stride: field.applied_layer_stride,
            auto_downscaled: field.auto_downscaled,
            auto_downscale_message: field.auto_downscale_message.clone(),
        }),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LivePreviewRequest {
    #[serde(default)]
    pub revision: u64,
    pub quantity: String,
    pub component: String,
    pub layer: u32,
    pub all_layers: bool,
    #[serde(default = "default_preview_every_n")]
    pub every_n: u32,
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
    pub auto_scale_enabled: bool,
    pub max_points: u32,
}

const fn default_preview_every_n() -> u32 {
    50
}

impl Default for LivePreviewRequest {
    fn default() -> Self {
        Self {
            revision: 0,
            quantity: "m".to_string(),
            component: "3D".to_string(),
            layer: 0,
            all_layers: false,
            every_n: default_preview_every_n(),
            x_chosen_size: 0,
            y_chosen_size: 0,
            auto_scale_enabled: true,
            max_points: 16_384,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LivePreviewField {
    pub config_revision: u64,
    /// Solver step whose state was captured for this completed field.
    #[serde(default)]
    pub source_step: u64,
    /// Solver time in seconds whose state was captured for this field.
    ///
    /// This is optional while older live-frame producers are still accepted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_time_seconds: Option<f64>,
    /// Display/materialization request revision used for this field.
    #[serde(default)]
    pub source_revision: u64,
    /// Wall-clock completion time for asynchronous materialization.
    #[serde(default)]
    pub materialized_at_unix_ms: u64,
    /// Worker-side wait and field-materialization duration.
    #[serde(default)]
    pub materialization_wall_time_ns: u64,
    pub quantity: String,
    pub unit: String,
    pub spatial_kind: String,
    pub quantity_domain: String,
    pub preview_grid: [u32; 3],
    pub original_grid: [u32; 3],
    pub vector_field_values: Vec<f64>,
    pub x_chosen_size: u32,
    pub y_chosen_size: u32,
    pub applied_x_chosen_size: u32,
    pub applied_y_chosen_size: u32,
    pub applied_layer_stride: u32,
    pub auto_downscaled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_downscale_message: Option<String>,
    /// Per-preview-cell boolean mask: `true` = geometry-active, `false` = empty.
    /// Resampled to match `preview_grid` dimensions (a preview cell is active if
    /// ANY original cell in its block is active).  `None` means all cells active.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_mask: Option<Vec<bool>>,
}

/// SHA-256 over the canonical little-endian `f64` preview payload bytes.
pub fn live_preview_values_sha256(values: &[f64]) -> String {
    let mut hasher = Sha256::new();
    for value in values {
        hasher.update(value.to_le_bytes());
    }
    digest_hex(&hasher.finalize())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiveVectorFieldSnapshot {
    pub quantity: String,
    pub grid: [u32; 3],
    pub values: Vec<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FemMeshObjectSegment {
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
    pub node_start: u32,
    pub node_count: u32,
    pub element_start: u32,
    pub element_count: u32,
    pub boundary_face_start: u32,
    pub boundary_face_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FemMeshPartPayload {
    pub id: String,
    pub label: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material_id: Option<String>,
    pub element_start: u32,
    pub element_count: u32,
    pub boundary_face_start: u32,
    pub boundary_face_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundary_face_indices: Vec<u32>,
    pub node_start: u32,
    pub node_count: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub node_indices: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub facet_global_ordinals: Vec<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_min: Option<[f64; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds_max: Option<[f64; 3]>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshQualityPayload {
    pub n_elements: u32,
    pub sicn_min: f64,
    pub sicn_max: f64,
    pub sicn_mean: f64,
    pub sicn_p5: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sicn_histogram: Vec<u32>,
    pub gamma_min: f64,
    pub gamma_mean: f64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gamma_histogram: Vec<u32>,
    pub volume_min: f64,
    pub volume_max: f64,
    pub volume_mean: f64,
    pub volume_std: f64,
    pub avg_quality: f64,
}

impl From<&MeshQualityIR> for MeshQualityPayload {
    fn from(q: &MeshQualityIR) -> Self {
        Self {
            n_elements: q.n_elements,
            sicn_min: q.sicn_min,
            sicn_max: q.sicn_max,
            sicn_mean: q.sicn_mean,
            sicn_p5: q.sicn_p5,
            sicn_histogram: q.sicn_histogram.clone(),
            gamma_min: q.gamma_min,
            gamma_mean: q.gamma_mean,
            gamma_histogram: q.gamma_histogram.clone(),
            volume_min: q.volume_min,
            volume_max: q.volume_max,
            volume_mean: q.volume_mean,
            volume_std: q.volume_std,
            avg_quality: q.avg_quality,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct FemMeshPayload {
    pub mesh_name: String,
    pub mesh_id: String,
    pub nodes: Vec<[f64; 3]>,
    pub cells: fullmag_ir::FemConnectivityIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub element_markers: Vec<u32>,
    pub facets: fullmag_ir::FemFacetConnectivityIR,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub boundary_markers: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periodic_boundary_pairs: Vec<fullmag_ir::MeshPeriodicBoundaryPairIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub periodic_node_pairs: Vec<fullmag_ir::MeshPeriodicNodePairIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub object_segments: Vec<FemMeshObjectSegment>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mesh_parts: Vec<FemMeshPartPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_mesh_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub domain_frame: Option<fullmag_ir::DomainFrameIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub generation_id: Option<String>,
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub per_domain_quality: HashMap<u32, MeshQualityPayload>,
    /// Immutable report for the mesh build that produced this solver mesh.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub build_report: Option<fullmag_ir::FemSharedDomainBuildReportIR>,
}

#[derive(Deserialize)]
struct FemMeshPayloadWire {
    mesh_name: String,
    mesh_id: String,
    nodes: Vec<[f64; 3]>,
    #[serde(default)]
    cells: Option<fullmag_ir::FemConnectivityIR>,
    #[serde(default)]
    facets: Option<fullmag_ir::FemFacetConnectivityIR>,
    #[serde(default)]
    elements: Option<Vec<[u32; 4]>>,
    #[serde(default)]
    boundary_faces: Option<Vec<[u32; 3]>>,
    #[serde(default)]
    element_markers: Vec<u32>,
    #[serde(default)]
    boundary_markers: Vec<u32>,
    #[serde(default)]
    periodic_boundary_pairs: Vec<fullmag_ir::MeshPeriodicBoundaryPairIR>,
    #[serde(default)]
    periodic_node_pairs: Vec<fullmag_ir::MeshPeriodicNodePairIR>,
    #[serde(default)]
    object_segments: Vec<FemMeshObjectSegment>,
    #[serde(default)]
    mesh_parts: Vec<FemMeshPartPayload>,
    #[serde(default)]
    domain_mesh_mode: Option<String>,
    #[serde(default)]
    domain_frame: Option<fullmag_ir::DomainFrameIR>,
    #[serde(default)]
    generation_id: Option<String>,
    #[serde(default)]
    per_domain_quality: HashMap<u32, MeshQualityPayload>,
    #[serde(default)]
    build_report: Option<fullmag_ir::FemSharedDomainBuildReportIR>,
}

impl<'de> Deserialize<'de> for FemMeshPayload {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let wire = FemMeshPayloadWire::deserialize(deserializer)?;
        let has_v2 = wire.cells.is_some() || wire.facets.is_some();
        let has_legacy = wire.elements.is_some() || wire.boundary_faces.is_some();
        if has_v2 && has_legacy {
            return Err(D::Error::custom(
                "FEM mesh payload contains both legacy and v2 topology",
            ));
        }
        let (mut cells, mut facets) = if has_v2 {
            (
                wire.cells
                    .ok_or_else(|| D::Error::custom("v2 FEM mesh payload requires cells"))?,
                wire.facets
                    .ok_or_else(|| D::Error::custom("v2 FEM mesh payload requires facets"))?,
            )
        } else if has_legacy {
            (
                fullmag_ir::FemConnectivityIR::from_tet4(wire.elements.ok_or_else(|| {
                    D::Error::custom("legacy FEM mesh payload requires elements")
                })?),
                fullmag_ir::FemFacetConnectivityIR::from_tri3(wire.boundary_faces.ok_or_else(
                    || D::Error::custom("legacy FEM mesh payload requires boundary_faces"),
                )?),
            )
        } else {
            return Err(D::Error::custom(
                "FEM mesh payload must provide either v2 or legacy topology",
            ));
        };
        if cells.global_ordinals.is_empty() && !cells.types.is_empty() {
            cells.global_ordinals = (0..cells.types.len() as u64).collect();
        }
        if facets.global_ordinals.is_empty() && !facets.types.is_empty() {
            facets.global_ordinals = (0..facets.types.len() as u64).collect();
        }
        Ok(Self {
            mesh_name: wire.mesh_name,
            mesh_id: wire.mesh_id,
            nodes: wire.nodes,
            cells,
            element_markers: wire.element_markers,
            facets,
            boundary_markers: wire.boundary_markers,
            periodic_boundary_pairs: wire.periodic_boundary_pairs,
            periodic_node_pairs: wire.periodic_node_pairs,
            object_segments: wire.object_segments,
            mesh_parts: wire.mesh_parts,
            domain_mesh_mode: wire.domain_mesh_mode,
            domain_frame: wire.domain_frame,
            generation_id: wire.generation_id,
            per_domain_quality: wire.per_domain_quality,
            build_report: wire.build_report,
        })
    }
}

impl FemMeshPayload {
    pub fn cell_count(&self) -> usize {
        self.cells.len()
    }

    pub fn facet_count(&self) -> usize {
        self.facets.len()
    }

    pub fn require_tet4_elements(&self) -> Result<Vec<[u32; 4]>, String> {
        if self.element_markers.len() != self.cells.len() {
            return Err("mesh.element_markers length must match mesh.cells.types length".into());
        }
        self.cells.require_tet4()
    }

    pub fn require_tri3_boundary_faces(&self) -> Result<Vec<[u32; 3]>, String> {
        if self.boundary_markers.len() != self.facets.len() {
            return Err("mesh.boundary_markers length must match mesh.facets.types length".into());
        }
        self.facets.require_tri3()
    }

    pub fn set_tet4_cells(&mut self, elements: Vec<[u32; 4]>) {
        self.cells = fullmag_ir::FemConnectivityIR::from_tet4(elements);
    }

    pub fn set_tri3_facets(&mut self, faces: Vec<[u32; 3]>) {
        self.facets = fullmag_ir::FemFacetConnectivityIR::from_tri3(faces);
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StageFemMeshIdentity {
    generation_id: String,
}

impl StageFemMeshIdentity {
    pub(crate) fn from_generation_id(generation_id: String) -> Self {
        Self { generation_id }
    }

    pub fn generation_id(&self) -> &str {
        &self.generation_id
    }

    pub fn from_fem_plan(plan: &fullmag_ir::FemPlanIR) -> Self {
        Self {
            generation_id: fem_plan_mesh_generation_id(plan),
        }
    }

    pub fn from_fem_eigen_plan(plan: &fullmag_ir::FemEigenPlanIR) -> Self {
        Self {
            generation_id: fem_eigen_mesh_generation_id(plan),
        }
    }

    pub fn from_fem_frequency_response_plan(plan: &fullmag_ir::FemFrequencyResponsePlanIR) -> Self {
        Self {
            generation_id: fem_frequency_response_mesh_generation_id(plan),
        }
    }
}

#[derive(Debug, Clone)]
pub struct StageFemMeshAsset {
    pub identity: StageFemMeshIdentity,
    pub payload: FemMeshPayload,
}

#[derive(Debug, Clone)]
pub(crate) struct FemStageExecutionContext {
    pub mesh_identity: StageFemMeshIdentity,
}

impl FemStageExecutionContext {
    pub fn from_mesh_identity(mesh_identity: StageFemMeshIdentity) -> Self {
        Self { mesh_identity }
    }

    pub fn from_fem_plan(plan: &fullmag_ir::FemPlanIR) -> Self {
        Self {
            mesh_identity: StageFemMeshIdentity::from_fem_plan(plan),
        }
    }

    pub fn generation_id(&self) -> Option<String> {
        Some(self.mesh_identity.generation_id().to_string())
    }

    pub fn from_backend_plan(plan: &fullmag_ir::BackendPlanIR) -> Option<Self> {
        let mesh_identity = match plan {
            fullmag_ir::BackendPlanIR::Fem(plan) => StageFemMeshIdentity::from_fem_plan(plan),
            fullmag_ir::BackendPlanIR::FemEigen(plan) => {
                StageFemMeshIdentity::from_fem_eigen_plan(plan)
            }
            fullmag_ir::BackendPlanIR::FemFrequencyResponse(plan) => {
                StageFemMeshIdentity::from_fem_frequency_response_plan(plan)
            }
            fullmag_ir::BackendPlanIR::Fdm(_) | fullmag_ir::BackendPlanIR::FdmMultilayer(_) => {
                return None;
            }
        };
        Some(Self { mesh_identity })
    }
}

pub fn fem_mesh_topology_fingerprint(mesh: &FemMeshPayload) -> String {
    fullmag_ir::fem_mesh_topology_fingerprint_v2(
        &mesh.nodes,
        &mesh.cells,
        &mesh.element_markers,
        &mesh.facets,
        &mesh.boundary_markers,
        &mesh.periodic_boundary_pairs,
        &mesh.periodic_node_pairs,
    )
}

fn digest_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = fmt::Write::write_fmt(&mut out, format_args!("{byte:02x}"));
    }
    out
}

fn normalized_payload_element_markers(
    element_markers: &[u32],
    magnetic_markers: Option<&BTreeSet<u32>>,
) -> Vec<u32> {
    if element_markers.is_empty() {
        return Vec::new();
    }

    if let Some(magnetic_markers) = magnetic_markers {
        return element_markers
            .iter()
            .map(|marker| u32::from(magnetic_markers.contains(marker)))
            .collect();
    }

    let has_air = element_markers.contains(&0);
    let has_magnetic = element_markers.iter().any(|marker| *marker != 0);
    if has_air && has_magnetic {
        element_markers
            .iter()
            .map(|marker| u32::from(*marker != 0))
            .collect()
    } else if element_markers
        .first()
        .is_some_and(|first| element_markers.iter().all(|marker| marker == first))
    {
        vec![1; element_markers.len()]
    } else {
        element_markers.to_vec()
    }
}

fn stable_fem_mesh_generation_id(
    mesh: &fullmag_ir::MeshIR,
    element_markers: &[u32],
    object_segments: &[fullmag_ir::FemObjectSegmentIR],
    mesh_parts: &[fullmag_ir::FemMeshPartIR],
    domain_mesh_mode: fullmag_ir::FemDomainMeshModeIR,
    domain_frame: &Option<fullmag_ir::DomainFrameIR>,
) -> String {
    #[cfg(test)]
    FEM_MESH_FINGERPRINT_COUNT.with(|count| count.set(count.get().saturating_add(1)));
    let mut hasher = Sha256::new();
    update_hash_bytes(&mut hasher, "schema", b"fullmag:fem-mesh-payload:v2");
    update_hash_str(&mut hasher, "mesh_name", &mesh.mesh_name);
    update_hash_nodes(&mut hasher, "nodes", &mesh.nodes);
    update_hash_serialized(&mut hasher, "cells", &mesh.cells);
    update_hash_u32_slice(&mut hasher, "element_markers", element_markers);
    update_hash_serialized(&mut hasher, "facets", &mesh.facets);
    update_hash_u32_slice(&mut hasher, "boundary_markers", &mesh.boundary_markers);
    update_hash_serialized(
        &mut hasher,
        "periodic_boundary_pairs",
        &mesh.periodic_boundary_pairs,
    );
    update_hash_serialized(
        &mut hasher,
        "periodic_node_pairs",
        &mesh.periodic_node_pairs,
    );
    update_hash_serialized(&mut hasher, "object_segments", object_segments);
    update_hash_serialized(&mut hasher, "mesh_parts", mesh_parts);
    update_hash_str(
        &mut hasher,
        "domain_mesh_mode",
        domain_mesh_mode_name(domain_mesh_mode),
    );
    update_hash_serialized(&mut hasher, "domain_frame", domain_frame);
    let quality_by_marker = mesh
        .per_domain_quality
        .iter()
        .map(|(marker, quality)| (*marker, quality))
        .collect::<BTreeMap<_, _>>();
    update_hash_serialized(&mut hasher, "per_domain_quality", &quality_by_marker);

    let digest = hasher.finalize();
    let mut revision_bytes = [0u8; 8];
    revision_bytes.copy_from_slice(&digest[..8]);
    u64::from_le_bytes(revision_bytes).to_string()
}

fn update_hash_str(hasher: &mut Sha256, label: &str, value: &str) {
    update_hash_bytes(hasher, label, value.as_bytes());
}

fn update_hash_bytes(hasher: &mut Sha256, label: &str, value: &[u8]) {
    hasher.update(label.as_bytes());
    hasher.update((value.len() as u64).to_le_bytes());
    hasher.update(value);
}

fn update_hash_nodes(hasher: &mut Sha256, label: &str, nodes: &[[f64; 3]]) {
    hasher.update(label.as_bytes());
    hasher.update((nodes.len() as u64).to_le_bytes());
    for node in nodes {
        for component in node {
            hasher.update(component.to_bits().to_le_bytes());
        }
    }
}

fn update_hash_u32_slice(hasher: &mut Sha256, label: &str, values: &[u32]) {
    hasher.update(label.as_bytes());
    hasher.update((values.len() as u64).to_le_bytes());
    for value in values {
        hasher.update(value.to_le_bytes());
    }
}

fn update_hash_serialized<T: Serialize + ?Sized>(hasher: &mut Sha256, label: &str, value: &T) {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    update_hash_bytes(hasher, label, &bytes);
}

impl FemMeshPayload {
    pub fn from_fem_plan_with_generation(
        plan: &fullmag_ir::FemPlanIR,
        generation_id: String,
    ) -> Self {
        record_fem_mesh_payload_build();
        let magnetic_markers = (!plan.region_materials.is_empty()).then(|| {
            plan.region_materials
                .iter()
                .map(|region| region.element_marker)
                .collect::<BTreeSet<_>>()
        });
        let element_markers = normalized_payload_element_markers(
            &plan.mesh.element_markers,
            magnetic_markers.as_ref(),
        );
        Self {
            mesh_name: plan.mesh.mesh_name.clone(),
            mesh_id: format!("{}:{}", plan.mesh.mesh_name, generation_id),
            nodes: plan.mesh.nodes.clone(),
            cells: plan.mesh.cells.clone(),
            element_markers,
            facets: plan.mesh.facets.clone(),
            boundary_markers: plan.mesh.boundary_markers.clone(),
            periodic_boundary_pairs: plan.mesh.periodic_boundary_pairs.clone(),
            periodic_node_pairs: plan.mesh.periodic_node_pairs.clone(),
            object_segments: plan
                .object_segments
                .iter()
                .map(|segment| FemMeshObjectSegment {
                    object_id: segment.object_id.clone(),
                    geometry_id: segment.geometry_id.clone(),
                    node_start: segment.node_start,
                    node_count: segment.node_count,
                    element_start: segment.element_start,
                    element_count: segment.element_count,
                    boundary_face_start: segment.boundary_face_start,
                    boundary_face_count: segment.boundary_face_count,
                })
                .collect(),
            mesh_parts: plan
                .mesh_parts
                .iter()
                .map(FemMeshPartPayload::from)
                .collect(),
            domain_mesh_mode: Some(domain_mesh_mode_name(plan.domain_mesh_mode).to_string()),
            domain_frame: plan.domain_frame.clone(),
            generation_id: Some(generation_id),
            per_domain_quality: plan
                .mesh
                .per_domain_quality
                .iter()
                .map(|(k, v)| (*k, MeshQualityPayload::from(v)))
                .collect(),
            build_report: plan.mesh_build_report.clone(),
        }
    }
}

impl StageFemMeshAsset {
    pub fn build_from_backend_plan(plan: &fullmag_ir::BackendPlanIR) -> Option<Self> {
        match plan {
            fullmag_ir::BackendPlanIR::Fem(plan) => Some(Self::build_from_fem_plan(plan)),
            fullmag_ir::BackendPlanIR::FemEigen(plan) => {
                Some(Self::build_from_fem_eigen_plan(plan))
            }
            fullmag_ir::BackendPlanIR::FemFrequencyResponse(plan) => {
                Some(Self::build_from_fem_frequency_response_plan(plan))
            }
            fullmag_ir::BackendPlanIR::Fdm(_) | fullmag_ir::BackendPlanIR::FdmMultilayer(_) => None,
        }
    }

    pub fn build_from_fem_plan(plan: &fullmag_ir::FemPlanIR) -> Self {
        let identity = StageFemMeshIdentity::from_fem_plan(plan);
        let payload =
            FemMeshPayload::from_fem_plan_with_generation(plan, identity.generation_id.clone());
        Self { identity, payload }
    }
}

impl From<&fullmag_ir::FemPlanIR> for FemMeshPayload {
    fn from(plan: &fullmag_ir::FemPlanIR) -> Self {
        StageFemMeshAsset::build_from_fem_plan(plan).payload
    }
}

pub fn fem_plan_mesh_generation_id(plan: &fullmag_ir::FemPlanIR) -> String {
    let magnetic_markers = (!plan.region_materials.is_empty()).then(|| {
        plan.region_materials
            .iter()
            .map(|region| region.element_marker)
            .collect::<BTreeSet<_>>()
    });
    let element_markers =
        normalized_payload_element_markers(&plan.mesh.element_markers, magnetic_markers.as_ref());
    stable_fem_mesh_generation_id(
        &plan.mesh,
        &element_markers,
        &plan.object_segments,
        &plan.mesh_parts,
        plan.domain_mesh_mode,
        &plan.domain_frame,
    )
}

impl From<&fullmag_ir::FemEigenPlanIR> for FemMeshPayload {
    fn from(plan: &fullmag_ir::FemEigenPlanIR) -> Self {
        StageFemMeshAsset::build_from_fem_eigen_plan(plan).payload
    }
}

impl FemMeshPayload {
    pub fn from_fem_eigen_plan_with_generation(
        plan: &fullmag_ir::FemEigenPlanIR,
        generation_id: String,
    ) -> Self {
        record_fem_mesh_payload_build();
        let element_markers = normalized_payload_element_markers(&plan.mesh.element_markers, None);
        Self {
            mesh_name: plan.mesh.mesh_name.clone(),
            mesh_id: format!("{}:{}", plan.mesh.mesh_name, generation_id),
            nodes: plan.mesh.nodes.clone(),
            cells: plan.mesh.cells.clone(),
            element_markers,
            facets: plan.mesh.facets.clone(),
            boundary_markers: plan.mesh.boundary_markers.clone(),
            periodic_boundary_pairs: plan.mesh.periodic_boundary_pairs.clone(),
            periodic_node_pairs: plan.mesh.periodic_node_pairs.clone(),
            object_segments: plan
                .object_segments
                .iter()
                .map(|segment| FemMeshObjectSegment {
                    object_id: segment.object_id.clone(),
                    geometry_id: segment.geometry_id.clone(),
                    node_start: segment.node_start,
                    node_count: segment.node_count,
                    element_start: segment.element_start,
                    element_count: segment.element_count,
                    boundary_face_start: segment.boundary_face_start,
                    boundary_face_count: segment.boundary_face_count,
                })
                .collect(),
            mesh_parts: plan
                .mesh_parts
                .iter()
                .map(FemMeshPartPayload::from)
                .collect(),
            domain_mesh_mode: Some(domain_mesh_mode_name(plan.domain_mesh_mode).to_string()),
            domain_frame: plan.domain_frame.clone(),
            generation_id: Some(generation_id),
            per_domain_quality: plan
                .mesh
                .per_domain_quality
                .iter()
                .map(|(k, v)| (*k, MeshQualityPayload::from(v)))
                .collect(),
            build_report: plan.mesh_build_report.clone(),
        }
    }
}

impl StageFemMeshAsset {
    pub fn build_from_fem_eigen_plan(plan: &fullmag_ir::FemEigenPlanIR) -> Self {
        let identity = StageFemMeshIdentity::from_fem_eigen_plan(plan);
        let payload = FemMeshPayload::from_fem_eigen_plan_with_generation(
            plan,
            identity.generation_id.clone(),
        );
        Self { identity, payload }
    }
}

pub fn fem_eigen_mesh_generation_id(plan: &fullmag_ir::FemEigenPlanIR) -> String {
    let element_markers = normalized_payload_element_markers(&plan.mesh.element_markers, None);
    stable_fem_mesh_generation_id(
        &plan.mesh,
        &element_markers,
        &plan.object_segments,
        &plan.mesh_parts,
        plan.domain_mesh_mode,
        &plan.domain_frame,
    )
}

impl From<&fullmag_ir::FemFrequencyResponsePlanIR> for FemMeshPayload {
    fn from(plan: &fullmag_ir::FemFrequencyResponsePlanIR) -> Self {
        StageFemMeshAsset::build_from_fem_frequency_response_plan(plan).payload
    }
}

impl FemMeshPayload {
    pub fn from_fem_frequency_response_plan_with_generation(
        plan: &fullmag_ir::FemFrequencyResponsePlanIR,
        generation_id: String,
    ) -> Self {
        record_fem_mesh_payload_build();
        let element_markers = normalized_payload_element_markers(&plan.mesh.element_markers, None);
        Self {
            mesh_name: plan.mesh.mesh_name.clone(),
            mesh_id: format!("{}:{}", plan.mesh.mesh_name, generation_id),
            nodes: plan.mesh.nodes.clone(),
            cells: plan.mesh.cells.clone(),
            element_markers,
            facets: plan.mesh.facets.clone(),
            boundary_markers: plan.mesh.boundary_markers.clone(),
            periodic_boundary_pairs: plan.mesh.periodic_boundary_pairs.clone(),
            periodic_node_pairs: plan.mesh.periodic_node_pairs.clone(),
            object_segments: plan
                .object_segments
                .iter()
                .map(|segment| FemMeshObjectSegment {
                    object_id: segment.object_id.clone(),
                    geometry_id: segment.geometry_id.clone(),
                    node_start: segment.node_start,
                    node_count: segment.node_count,
                    element_start: segment.element_start,
                    element_count: segment.element_count,
                    boundary_face_start: segment.boundary_face_start,
                    boundary_face_count: segment.boundary_face_count,
                })
                .collect(),
            mesh_parts: plan
                .mesh_parts
                .iter()
                .map(FemMeshPartPayload::from)
                .collect(),
            domain_mesh_mode: Some(domain_mesh_mode_name(plan.domain_mesh_mode).to_string()),
            domain_frame: plan.domain_frame.clone(),
            generation_id: Some(generation_id),
            per_domain_quality: plan
                .mesh
                .per_domain_quality
                .iter()
                .map(|(k, v)| (*k, MeshQualityPayload::from(v)))
                .collect(),
            build_report: plan.mesh_build_report.clone(),
        }
    }
}

impl StageFemMeshAsset {
    pub fn build_from_fem_frequency_response_plan(
        plan: &fullmag_ir::FemFrequencyResponsePlanIR,
    ) -> Self {
        let identity = StageFemMeshIdentity::from_fem_frequency_response_plan(plan);
        let payload = FemMeshPayload::from_fem_frequency_response_plan_with_generation(
            plan,
            identity.generation_id.clone(),
        );
        Self { identity, payload }
    }
}

pub fn fem_frequency_response_mesh_generation_id(
    plan: &fullmag_ir::FemFrequencyResponsePlanIR,
) -> String {
    let element_markers = normalized_payload_element_markers(&plan.mesh.element_markers, None);
    stable_fem_mesh_generation_id(
        &plan.mesh,
        &element_markers,
        &plan.object_segments,
        &plan.mesh_parts,
        plan.domain_mesh_mode,
        &plan.domain_frame,
    )
}

impl From<&fullmag_ir::FemMeshPartIR> for FemMeshPartPayload {
    fn from(part: &fullmag_ir::FemMeshPartIR) -> Self {
        let has_explicit_node_indices = !part.node_indices.is_empty();
        Self {
            id: part.id.clone(),
            label: part.label.clone(),
            role: mesh_part_role_name(&part.role).to_string(),
            object_id: part.object_id.clone(),
            geometry_id: part.geometry_id.clone(),
            material_id: part.material_id.clone(),
            element_start: selector_start(&part.element_selector),
            element_count: selector_count(&part.element_selector),
            boundary_face_start: selector_start(&part.boundary_face_selector),
            boundary_face_count: selector_count(&part.boundary_face_selector),
            boundary_face_indices: part.boundary_face_indices.clone(),
            node_start: selector_start(&part.node_selector),
            node_count: if has_explicit_node_indices {
                part.node_indices.len() as u32
            } else {
                selector_count(&part.node_selector)
            },
            node_indices: part.node_indices.clone(),
            facet_global_ordinals: part.facet_global_ordinals.clone(),
            bounds_min: part.bounds_min,
            bounds_max: part.bounds_max,
        }
    }
}

fn selector_start(selector: &FemMeshPartSelector) -> u32 {
    match selector {
        FemMeshPartSelector::ElementRange { start, .. }
        | FemMeshPartSelector::BoundaryFaceRange { start, .. }
        | FemMeshPartSelector::NodeRange { start, .. } => *start,
        FemMeshPartSelector::ElementMarkerSet { .. } => 0,
    }
}

fn selector_count(selector: &FemMeshPartSelector) -> u32 {
    match selector {
        FemMeshPartSelector::ElementRange { count, .. }
        | FemMeshPartSelector::BoundaryFaceRange { count, .. }
        | FemMeshPartSelector::NodeRange { count, .. } => *count,
        FemMeshPartSelector::ElementMarkerSet { markers } => markers.len() as u32,
    }
}

fn mesh_part_role_name(role: &FemMeshPartRole) -> &'static str {
    match role {
        FemMeshPartRole::Air => "air",
        FemMeshPartRole::MagneticObject => "magnetic_object",
        FemMeshPartRole::Interface => "interface",
        FemMeshPartRole::OuterBoundary => "outer_boundary",
    }
}

fn domain_mesh_mode_name(mode: fullmag_ir::FemDomainMeshModeIR) -> &'static str {
    match mode {
        fullmag_ir::FemDomainMeshModeIR::MergedMagneticMesh => "merged_magnetic_mesh",
        fullmag_ir::FemDomainMeshModeIR::SharedDomainMeshWithAir => "shared_domain_mesh_with_air",
    }
}

#[derive(Debug)]
pub struct RunError {
    pub message: String,
}

impl fmt::Display for RunError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "RunError: {}", self.message)
    }
}

impl std::error::Error for RunError {}

impl From<fullmag_plan::PlanError> for RunError {
    fn from(e: fullmag_plan::PlanError) -> Self {
        RunError {
            message: format!("Planning failed:\n{}", e),
        }
    }
}

// ----- execution provenance -----

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InitialTimestepReason {
    Explicit,
    DtMinDefault,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RequestedTimestepPolicy {
    Fixed {
        integrator: fullmag_ir::IntegratorChoice,
        timestep_s: f64,
    },
    Adaptive {
        integrator: fullmag_ir::IntegratorChoice,
        tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR,
        atol: f64,
        rtol: f64,
        dt_initial_s: Option<f64>,
        dt_min_s: f64,
        dt_max_s: f64,
        safety: f64,
        growth_limit: f64,
        shrink_limit: f64,
        max_spin_rotation: Option<f64>,
        norm_tolerance: Option<f64>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ResolvedTimestepPolicy {
    Fixed {
        integrator: fullmag_ir::IntegratorChoice,
        timestep_s: f64,
    },
    Adaptive {
        integrator: fullmag_ir::IntegratorChoice,
        estimator_order: u8,
        tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR,
        atol: f64,
        rtol: f64,
        dt_initial_s: f64,
        dt_initial_reason: InitialTimestepReason,
        dt_min_s: f64,
        dt_max_s: f64,
        safety: f64,
        growth_limit: f64,
        shrink_limit: f64,
        max_spin_rotation: Option<f64>,
        norm_tolerance: Option<f64>,
    },
}

impl ResolvedTimestepPolicy {
    pub fn initial_dt(&self) -> f64 {
        match self {
            Self::Fixed { timestep_s, .. } => *timestep_s,
            Self::Adaptive { dt_initial_s, .. } => *dt_initial_s,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimestepPolicyProvenance {
    pub requested: RequestedTimestepPolicy,
    pub resolved: ResolvedTimestepPolicy,
    pub execution_identity: TimestepExecutionIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relaxation_controller: Option<RelaxationControllerPolicyProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RelaxationControllerPolicyProvenance {
    pub policy_id: String,
    pub torque_confirmation_samples: u32,
    pub energy_increase_relative_tolerance: f64,
    pub energy_increase_absolute_tolerance_j: f64,
    pub tightening_factor: f64,
    pub max_error_floor: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FemDirectMinimizerPolicyProvenance {
    pub requested_direction_policy: String,
    pub resolved_direction_policy: String,
    pub requested_linear_solver: String,
    pub resolved_linear_solver: String,
    pub requested_preconditioner: String,
    pub resolved_preconditioner: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub environment_overrides: Vec<String>,
}

impl TimestepPolicyProvenance {
    pub fn initial_dt(&self) -> f64 {
        self.resolved.initial_dt()
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimestepBackend {
    Fdm,
    Fem,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimestepDevice {
    Cpu,
    Cuda,
    Gpu,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LlgTimestepCapabilityId {
    LlgTdPolicyV1,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LlgTimestepQualificationId {
    ExplicitFixedFdmCpuDouble,
    ExplicitFixedFdmCudaDouble,
    ExplicitFixedFdmCudaSingle,
    ExplicitFixedFemCpuDouble,
    ExplicitFixedFemGpuDouble,
    ExplicitAdaptiveFdmCpuDouble,
    ExplicitAdaptiveFdmCudaDouble,
    ExplicitAdaptiveFemCpuDouble,
    ExplicitAdaptiveFemGpuDouble,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TimestepValidationState {
    Unvalidated,
    AlgebraValidated,
    PhysicsValidated,
    ProductionQualified,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TimestepExecutionIdentity {
    pub capability_id: LlgTimestepCapabilityId,
    pub qualification_id: LlgTimestepQualificationId,
    pub backend: TimestepBackend,
    pub device: TimestepDevice,
    pub precision: fullmag_ir::ExecutionPrecision,
    pub integrator: fullmag_ir::IntegratorChoice,
    pub timestep_policy: crate::timestep_qualification::TimestepPolicyKind,
    pub validation_state: TimestepValidationState,
    pub qualification_registry_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualification_artifact_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_source_inputs_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub validated_scope: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualification_validated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub qualification_validator_schema: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct TimestepExecutionLane {
    pub backend: TimestepBackend,
    pub device: TimestepDevice,
    pub precision: fullmag_ir::ExecutionPrecision,
}

impl TimestepExecutionLane {
    pub(crate) const fn fdm_cpu() -> Self {
        Self {
            backend: TimestepBackend::Fdm,
            device: TimestepDevice::Cpu,
            precision: fullmag_ir::ExecutionPrecision::Double,
        }
    }

    #[cfg_attr(not(feature = "cuda"), allow(dead_code))]
    pub(crate) const fn fdm_cuda(precision: fullmag_ir::ExecutionPrecision) -> Self {
        Self {
            backend: TimestepBackend::Fdm,
            device: TimestepDevice::Cuda,
            precision,
        }
    }

    pub(crate) const fn fem_cpu(precision: fullmag_ir::ExecutionPrecision) -> Self {
        Self {
            backend: TimestepBackend::Fem,
            device: TimestepDevice::Cpu,
            precision,
        }
    }

    #[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
    pub(crate) const fn fem_gpu(precision: fullmag_ir::ExecutionPrecision) -> Self {
        Self {
            backend: TimestepBackend::Fem,
            device: TimestepDevice::Gpu,
            precision,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LegacyDtPolicy {
    User,
    Adaptive,
    Fallback,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedFallback {
    pub occurred: bool,
    pub original_engine: String,
    pub fallback_engine: String,
    pub reason: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmGpuTransferCounts {
    pub setup_full_vector_h2d_count: u64,
    pub setup_full_vector_h2d_bytes: u64,
    pub setup_full_vector_d2h_count: u64,
    pub setup_full_vector_d2h_bytes: u64,
    pub observation_full_vector_h2d_count: u64,
    pub observation_full_vector_h2d_bytes: u64,
    pub observation_full_vector_d2h_count: u64,
    pub observation_full_vector_d2h_bytes: u64,
    pub hot_loop_full_vector_h2d_count: u64,
    pub hot_loop_full_vector_h2d_bytes: u64,
    pub hot_loop_full_vector_d2h_count: u64,
    pub hot_loop_full_vector_d2h_bytes: u64,
    pub hot_loop_host_compute_count: u64,
    pub hot_loop_host_sync_count: u64,
    pub hot_loop_control_scalar_d2h_bytes: u64,
    pub hot_loop_control_scalar_host_sync_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmGpuOperatorResidency {
    pub operator: String,
    pub realization: String,
    pub location: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmGpuExecutionReceipt {
    pub requested: String,
    pub resolved: String,
    pub executed: String,
    pub device: String,
    pub precision: String,
    pub required_operator_mask: u64,
    pub resolved_device_operator_mask: u64,
    pub resolved_host_operator_mask: u64,
    pub resolved_unknown_operator_mask: u64,
    pub executed_device_operator_mask: u64,
    pub executed_host_operator_mask: u64,
    pub executed_unknown_operator_mask: u64,
    pub operator_residency: Vec<FdmGpuOperatorResidency>,
    pub fallback_count: u64,
    pub transfer_counts: FdmGpuTransferCounts,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_execution: Option<FdmGpuAdaptiveExecutionTelemetry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adaptive_numerics: Option<FdmGpuAdaptiveNumericsTelemetry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_pipeline: Option<FdmGpuLocalPipelineTelemetry>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_workspace: Option<FdmGpuWorkspaceTelemetry>,
    pub validation_state: String,
    pub accounting_valid: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmGpuAdaptiveExecutionTelemetry {
    pub realization: String,
    pub accounting_valid: bool,
    pub graph_build_count: u64,
    pub graph_launch_count: u64,
    pub terminal_control_d2h_bytes: u64,
    pub terminal_control_host_sync_count: u64,
    pub step_completion_host_sync_count: u64,
    pub stats_none_host_sync_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmGpuLocalPipelineTelemetry {
    pub requested_policy: String,
    pub resolved_realization: String,
    pub executed_realization: String,
    pub accounting_valid: bool,
    pub precision: String,
    pub integrator: String,
    pub metric_valid_mask: u64,
    pub required_operator_mask: u64,
    pub active_feature_mask: u64,
    pub source_revision: u64,
    pub field_revision: u64,
    pub direct_fused_field_rhs_launch_count: u64,
    pub direct_unfused_effective_field_launch_count: u64,
    pub direct_unfused_rhs_launch_count: u64,
    pub captured_fused_field_rhs_node_count: u64,
    pub captured_unfused_effective_field_node_count: u64,
    pub captured_unfused_rhs_node_count: u64,
    pub graph_build_count: u64,
    pub graph_replay_count: u64,
    pub graph_recapture_count: u64,
    pub graph_attempt_execution_count: u64,
    pub graph_fused_field_rhs_execution_count: u64,
    pub graph_unfused_effective_field_execution_count: u64,
    pub graph_unfused_rhs_execution_count: u64,
    pub profiled_dram_read_bytes: u64,
    pub profiled_dram_write_bytes: u64,
    pub profiled_launch_time_ns: u64,
    pub profiled_achieved_occupancy_permyriad: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmGpuWorkspaceTelemetry {
    pub accounting_valid: bool,
    pub setup_complete: bool,
    pub precision: String,
    pub integrator: String,
    pub metric_valid_mask: u64,
    pub workspace_revision: u64,
    pub source_revision: u64,
    pub field_revision: u64,
    pub setup_device_allocation_count: u64,
    pub setup_device_allocation_bytes: u64,
    pub total_device_allocation_count: u64,
    pub total_device_allocation_bytes: u64,
    pub step_device_allocation_count: u64,
    pub step_device_allocation_bytes: u64,
    pub setup_fft_plan_creation_count: u64,
    pub total_fft_plan_creation_count: u64,
    pub step_fft_plan_creation_count: u64,
    pub prepared_fft_workspace_count: u64,
    pub workspace_bytes: u64,
    pub peak_vram_bytes: u64,
    pub observed_step_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmGpuAdaptiveNumericsTelemetry {
    pub embedded_error_semantics: String,
    pub norm_defect_semantics: String,
    pub spin_rotation_semantics: String,
    pub accounting_valid: bool,
    pub terminal_observation_count: u64,
    pub decision_comparison_count: u64,
    pub decision_divergence_count: u64,
    pub last_terminal_normalized_error: f64,
    pub last_terminal_max_norm_defect: f64,
    pub last_terminal_max_spin_rotation_radians: f64,
    pub max_attempt_normalized_error: f64,
    pub max_attempt_norm_defect: f64,
    pub max_attempt_spin_rotation_radians: f64,
}

/// Native CUDA step-transaction counters captured after FDM GPU execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmGpuStepTransactionTelemetry {
    pub accounting_valid: bool,
    pub capture_count: u64,
    pub rollback_count: u64,
    pub capture_d2d_bytes: u64,
    pub rollback_d2d_bytes: u64,
    pub rollback_latency_total_ns: u64,
    pub rollback_latency_max_ns: u64,
    pub accepted_step_index: u64,
    pub attempt_generation: u64,
    pub thermal_rng_draws: u64,
    pub stale_publication_count: u64,
}

/// CPU FDM transaction counters captured after reference execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmCpuStepTransactionTelemetry {
    pub schema_version: String,
    pub accepted_step_count: u64,
    pub rejected_attempt_count: u64,
    pub rollback_count: u64,
    pub thermal_interval_index: u64,
    pub thermal_rng_draws: u64,
    /// Persistent-SoA accepted-state publications performed in this execution segment.
    #[serde(default)]
    pub accepted_state_publication_count: u64,
    /// Host bytes copied by those per-step accepted-state publications.
    #[serde(default)]
    pub accepted_state_publication_copy_bytes: u64,
    /// Full vector-field copies performed by accepted-state publication.
    #[serde(default)]
    pub accepted_state_publication_full_field_copy_count: u64,
    /// Host bytes copied by the one final full transactional-state synchronization.
    #[serde(default)]
    pub final_state_sync_copy_bytes: u64,
    /// Full vector-field copies performed by final transactional-state synchronization.
    #[serde(default)]
    pub final_state_sync_full_field_copy_count: u64,
    /// Scheduled artifact field payloads materialized by this execution segment.
    #[serde(default)]
    pub scheduled_field_snapshot_payload_count: u64,
    /// Exact serialized `f64` payload bytes materialized for scheduled field snapshots.
    #[serde(default)]
    pub scheduled_field_snapshot_copy_bytes: u64,
    /// Live vector-field payloads materialized for callbacks, including magnetization and previews.
    #[serde(default)]
    pub live_field_snapshot_payload_count: u64,
    /// Exact `f64` payload bytes materialized for live callbacks.
    #[serde(default)]
    pub live_field_snapshot_copy_bytes: u64,
    /// End-of-stage artifact field payloads materialized outside the regular output schedule.
    #[serde(default)]
    pub finalization_field_snapshot_payload_count: u64,
    /// Exact serialized `f64` payload bytes materialized during finalization.
    #[serde(default)]
    pub finalization_field_snapshot_copy_bytes: u64,
    pub checkpoint_digest: String,
}

/// Runtime-owned evidence for the production CPU FDM evaluation policy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmCpuEvaluationTelemetry {
    pub schema_version: String,
    pub minimal_step_count: u64,
    pub full_step_count: u64,
    pub minimal_step_wall_time_ns: u64,
    pub full_step_wall_time_ns: u64,
}

impl FdmGpuExecutionReceipt {
    pub fn strict_unvalidated(precision: &str) -> Self {
        Self {
            requested: "gpu".to_string(),
            resolved: "unavailable".to_string(),
            executed: "none".to_string(),
            device: "unavailable".to_string(),
            precision: precision.to_string(),
            required_operator_mask: 0,
            resolved_device_operator_mask: 0,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0,
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 0,
            operator_residency: Vec::new(),
            fallback_count: 0,
            transfer_counts: FdmGpuTransferCounts::default(),
            adaptive_execution: None,
            adaptive_numerics: None,
            local_pipeline: None,
            gpu_workspace: None,
            validation_state: "unvalidated".to_string(),
            accounting_valid: false,
        }
    }
}

#[cfg(test)]
mod fdm_gpu_execution_receipt_contract_tests {
    use super::*;

    #[test]
    fn execution_provenance_serializes_fdm_gpu_step_transaction_telemetry() {
        let mut provenance = ExecutionProvenance::default();
        provenance.fdm_gpu_step_transaction_telemetry = Some(FdmGpuStepTransactionTelemetry {
            accounting_valid: true,
            capture_count: 12,
            rollback_count: 3,
            capture_d2d_bytes: 3_072,
            rollback_d2d_bytes: 1_536,
            rollback_latency_total_ns: 1_800,
            rollback_latency_max_ns: 900,
            accepted_step_index: 7,
            attempt_generation: 8,
            thermal_rng_draws: 144,
            stale_publication_count: 2,
        });

        let value = serde_json::to_value(provenance).expect("serialize provenance");
        let telemetry = &value["fdm_gpu_step_transaction_telemetry"];
        assert_eq!(telemetry["capture_d2d_bytes"], 3_072);
        assert_eq!(telemetry["rollback_latency_max_ns"], 900);
        assert_eq!(telemetry["attempt_generation"], 8);
        assert_eq!(telemetry["accounting_valid"], true);
    }

    #[test]
    fn execution_provenance_serializes_fdm_cpu_step_transaction_telemetry() {
        let mut provenance = ExecutionProvenance::default();
        provenance.fdm_cpu_step_transaction_telemetry = Some(FdmCpuStepTransactionTelemetry {
            schema_version: "fullmag.fdm.cpu.step_transaction.v3".into(),
            accepted_step_count: 7,
            rejected_attempt_count: 2,
            rollback_count: 2,
            thermal_interval_index: 7,
            thermal_rng_draws: 7,
            accepted_state_publication_count: 7,
            accepted_state_publication_copy_bytes: 16_800,
            accepted_state_publication_full_field_copy_count: 7,
            final_state_sync_copy_bytes: 9_600,
            final_state_sync_full_field_copy_count: 4,
            scheduled_field_snapshot_payload_count: 3,
            scheduled_field_snapshot_copy_bytes: 7_200,
            live_field_snapshot_payload_count: 5,
            live_field_snapshot_copy_bytes: 12_000,
            finalization_field_snapshot_payload_count: 1,
            finalization_field_snapshot_copy_bytes: 2_400,
            checkpoint_digest: "sha256:test".into(),
        });

        let value = serde_json::to_value(provenance).expect("serialize provenance");
        let telemetry = &value["fdm_cpu_step_transaction_telemetry"];
        assert_eq!(telemetry["accepted_step_count"], 7);
        assert_eq!(telemetry["rollback_count"], 2);
        assert_eq!(telemetry["thermal_interval_index"], 7);
        assert_eq!(telemetry["accepted_state_publication_copy_bytes"], 16_800);
        assert_eq!(telemetry["final_state_sync_full_field_copy_count"], 4);
        assert_eq!(telemetry["scheduled_field_snapshot_copy_bytes"], 7_200);
        assert_eq!(telemetry["live_field_snapshot_payload_count"], 5);
        assert_eq!(telemetry["finalization_field_snapshot_copy_bytes"], 2_400);
        assert_eq!(telemetry["checkpoint_digest"], "sha256:test");
    }

    #[test]
    fn fdm_cpu_step_transaction_v1_defaults_copy_telemetry_to_zero() {
        let legacy = serde_json::json!({
            "schema_version": "fullmag.fdm.cpu.step_transaction.v1",
            "accepted_step_count": 3,
            "rejected_attempt_count": 0,
            "rollback_count": 0,
            "thermal_interval_index": 0,
            "thermal_rng_draws": 0,
            "checkpoint_digest": "sha256:legacy"
        });
        let telemetry: FdmCpuStepTransactionTelemetry =
            serde_json::from_value(legacy).expect("legacy CPU transaction receipt");

        assert_eq!(telemetry.accepted_state_publication_count, 0);
        assert_eq!(telemetry.accepted_state_publication_copy_bytes, 0);
        assert_eq!(telemetry.final_state_sync_copy_bytes, 0);
        assert_eq!(telemetry.scheduled_field_snapshot_payload_count, 0);
        assert_eq!(telemetry.scheduled_field_snapshot_copy_bytes, 0);
        assert_eq!(telemetry.live_field_snapshot_payload_count, 0);
        assert_eq!(telemetry.live_field_snapshot_copy_bytes, 0);
        assert_eq!(telemetry.finalization_field_snapshot_payload_count, 0);
        assert_eq!(telemetry.finalization_field_snapshot_copy_bytes, 0);
    }

    #[test]
    fn fdm_cpu_step_transaction_v2_defaults_snapshot_telemetry_to_zero() {
        let legacy = serde_json::json!({
            "schema_version": "fullmag.fdm.cpu.step_transaction.v2",
            "accepted_step_count": 3,
            "rejected_attempt_count": 0,
            "rollback_count": 0,
            "thermal_interval_index": 0,
            "thermal_rng_draws": 0,
            "accepted_state_publication_count": 3,
            "accepted_state_publication_copy_bytes": 7_200,
            "accepted_state_publication_full_field_copy_count": 3,
            "final_state_sync_copy_bytes": 2_400,
            "final_state_sync_full_field_copy_count": 1,
            "checkpoint_digest": "sha256:legacy-v2"
        });
        let telemetry: FdmCpuStepTransactionTelemetry =
            serde_json::from_value(legacy).expect("v2 CPU transaction receipt");

        assert_eq!(telemetry.scheduled_field_snapshot_payload_count, 0);
        assert_eq!(telemetry.scheduled_field_snapshot_copy_bytes, 0);
        assert_eq!(telemetry.live_field_snapshot_payload_count, 0);
        assert_eq!(telemetry.live_field_snapshot_copy_bytes, 0);
        assert_eq!(telemetry.finalization_field_snapshot_payload_count, 0);
        assert_eq!(telemetry.finalization_field_snapshot_copy_bytes, 0);
    }

    #[test]
    fn execution_provenance_serializes_fdm_cpu_evaluation_telemetry() {
        let mut provenance = ExecutionProvenance::default();
        provenance.fdm_cpu_evaluation_telemetry = Some(FdmCpuEvaluationTelemetry {
            schema_version: "fullmag.fdm.cpu.evaluation.v1".into(),
            minimal_step_count: 5,
            full_step_count: 2,
            minimal_step_wall_time_ns: 1_000,
            full_step_wall_time_ns: 900,
        });

        let value = serde_json::to_value(provenance).expect("serialize provenance");
        let telemetry = &value["fdm_cpu_evaluation_telemetry"];
        assert_eq!(telemetry["schema_version"], "fullmag.fdm.cpu.evaluation.v1");
        assert_eq!(telemetry["minimal_step_count"], 5);
        assert_eq!(telemetry["full_step_count"], 2);
        assert_eq!(telemetry["minimal_step_wall_time_ns"], 1_000);
        assert_eq!(telemetry["full_step_wall_time_ns"], 900);
    }

    #[test]
    fn execution_provenance_serializes_explicit_fdm_gpu_receipt() {
        let mut provenance = ExecutionProvenance::default();
        provenance.fdm_gpu_execution_receipt = Some(FdmGpuExecutionReceipt {
            requested: "gpu".into(),
            resolved: "device_resident".into(),
            executed: "cuda_fdm".into(),
            device: "cuda:0".into(),
            precision: "double".into(),
            required_operator_mask: 1,
            resolved_device_operator_mask: 1,
            resolved_host_operator_mask: 0,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0,
            executed_host_operator_mask: 0,
            executed_unknown_operator_mask: 1,
            operator_residency: vec![FdmGpuOperatorResidency {
                operator: "llg_integrator".into(),
                realization: "cuda_heun_fp64".into(),
                location: "device".into(),
            }],
            fallback_count: 0,
            transfer_counts: FdmGpuTransferCounts {
                setup_full_vector_h2d_count: 1,
                setup_full_vector_h2d_bytes: 24,
                hot_loop_control_scalar_d2h_bytes: 8,
                hot_loop_control_scalar_host_sync_count: 1,
                ..Default::default()
            },
            adaptive_execution: Some(FdmGpuAdaptiveExecutionTelemetry {
                realization: "cuda_conditional_graph_v1".into(),
                accounting_valid: true,
                graph_build_count: 1,
                graph_launch_count: 2,
                terminal_control_d2h_bytes: 128,
                terminal_control_host_sync_count: 2,
                step_completion_host_sync_count: 0,
                stats_none_host_sync_count: 2,
            }),
            adaptive_numerics: Some(FdmGpuAdaptiveNumericsTelemetry {
                embedded_error_semantics: "pre_projection_embedded_difference_v1".into(),
                norm_defect_semantics: "post_projection_abs_unit_norm_defect_v1".into(),
                spin_rotation_semantics: "attempt_geodesic_rotation_radians_v1".into(),
                accounting_valid: true,
                terminal_observation_count: 2,
                decision_comparison_count: 2,
                decision_divergence_count: 0,
                last_terminal_normalized_error: 0.25,
                last_terminal_max_norm_defect: 1.0e-15,
                last_terminal_max_spin_rotation_radians: 0.125,
                max_attempt_normalized_error: 1.5,
                max_attempt_norm_defect: 2.0e-15,
                max_attempt_spin_rotation_radians: 0.5,
            }),
            local_pipeline: None,
            gpu_workspace: Some(FdmGpuWorkspaceTelemetry {
                accounting_valid: true,
                setup_complete: true,
                precision: "double".into(),
                integrator: "heun".into(),
                metric_valid_mask: 0x1f,
                workspace_revision: 3,
                source_revision: 4,
                field_revision: 5,
                setup_device_allocation_count: 10,
                setup_device_allocation_bytes: 1_000,
                total_device_allocation_count: 10,
                total_device_allocation_bytes: 1_000,
                step_device_allocation_count: 0,
                step_device_allocation_bytes: 0,
                setup_fft_plan_creation_count: 2,
                total_fft_plan_creation_count: 2,
                step_fft_plan_creation_count: 0,
                prepared_fft_workspace_count: 2,
                workspace_bytes: 800,
                peak_vram_bytes: 1_200,
                observed_step_count: 7,
            }),
            validation_state: "unvalidated".into(),
            accounting_valid: true,
        });

        let value = serde_json::to_value(provenance).expect("serialize provenance");
        let receipt = &value["fdm_gpu_execution_receipt"];
        assert_eq!(receipt["requested"], "gpu");
        assert_eq!(receipt["resolved"], "device_resident");
        assert_eq!(receipt["executed"], "cuda_fdm");
        assert_eq!(receipt["fallback_count"], 0);
        assert_eq!(
            receipt["transfer_counts"]["observation_full_vector_d2h_count"],
            0
        );
        assert_eq!(
            receipt["transfer_counts"]["setup_full_vector_h2d_bytes"],
            24
        );
        assert_eq!(
            receipt["transfer_counts"]["hot_loop_full_vector_d2h_bytes"],
            0
        );
        assert_eq!(receipt["validation_state"], "unvalidated");
        assert_eq!(
            receipt["adaptive_execution"]["realization"],
            "cuda_conditional_graph_v1"
        );
        assert_eq!(receipt["adaptive_execution"]["graph_build_count"], 1);
        assert_eq!(receipt["adaptive_execution"]["graph_launch_count"], 2);
        assert_eq!(
            receipt["adaptive_numerics"]["embedded_error_semantics"],
            "pre_projection_embedded_difference_v1"
        );
        assert_eq!(receipt["adaptive_numerics"]["decision_divergence_count"], 0);
        assert_eq!(
            receipt["adaptive_numerics"]["max_attempt_normalized_error"],
            1.5
        );
        assert_eq!(receipt["gpu_workspace"]["step_device_allocation_count"], 0);
        assert_eq!(receipt["gpu_workspace"]["prepared_fft_workspace_count"], 2);
    }
}

/// Execution class reported by the native FEM receipt ABI.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FemGpuExecutionClass {
    DeviceResident,
    GpuOperatorHostSolver,
    HybridCpuPoisson,
    Cpu,
}

/// Native FEM GPU execution evidence captured after execution.
///
/// The resolved and executed fields are derived only from the versioned
/// native receipt. The Rust planner is not an execution oracle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FemGpuExecutionReceipt {
    pub requested: String,
    pub resolved: String,
    pub executed: String,
    pub execution_class: FemGpuExecutionClass,
    pub device_ordinal: i32,
    pub precision: String,
    pub integrator: String,
    pub required_operator_mask: u64,
    pub resolved_device_operator_mask: u64,
    pub resolved_host_operator_mask: u64,
    pub resolved_unknown_operator_mask: u64,
    pub executed_device_operator_mask: u64,
    pub executed_host_operator_mask: u64,
    pub executed_unknown_operator_mask: u64,
    pub fallback_count: u64,
    pub accepted_step_count: u64,
    pub rejected_attempt_count: u64,
    pub failed_attempt_count: u64,
    pub hot_loop_compute_h2d_bytes: u64,
    pub hot_loop_compute_d2h_bytes: u64,
    pub hot_loop_compute_host_sync_count: u64,
    pub accounting_valid: bool,
}

#[cfg(test)]
mod fem_gpu_execution_receipt_contract_tests {
    use super::*;

    #[test]
    fn execution_provenance_serializes_explicit_fem_gpu_receipt() {
        let mut provenance = ExecutionProvenance::default();
        provenance.fem_gpu_execution_receipt = Some(FemGpuExecutionReceipt {
            requested: "hybrid".into(),
            resolved: "hybrid_cpu_poisson".into(),
            executed: "cuda_fem_hybrid_cpu_poisson".into(),
            execution_class: FemGpuExecutionClass::HybridCpuPoisson,
            device_ordinal: 1,
            precision: "double".into(),
            integrator: "heun".into(),
            required_operator_mask: 0x3ff,
            resolved_device_operator_mask: 0x1fb,
            resolved_host_operator_mask: 0x204,
            resolved_unknown_operator_mask: 0,
            executed_device_operator_mask: 0x1fb,
            executed_host_operator_mask: 0x204,
            executed_unknown_operator_mask: 0,
            fallback_count: 0,
            accepted_step_count: 2,
            rejected_attempt_count: 1,
            failed_attempt_count: 0,
            hot_loop_compute_h2d_bytes: 24,
            hot_loop_compute_d2h_bytes: 24,
            hot_loop_compute_host_sync_count: 2,
            accounting_valid: true,
        });

        let value = serde_json::to_value(provenance).expect("serialize provenance");
        let receipt = &value["fem_gpu_execution_receipt"];
        assert_eq!(receipt["requested"], "hybrid");
        assert_eq!(receipt["resolved"], "hybrid_cpu_poisson");
        assert_eq!(receipt["executed"], "cuda_fem_hybrid_cpu_poisson");
        assert_eq!(receipt["execution_class"], "hybrid_cpu_poisson");
        assert_eq!(receipt["executed_host_operator_mask"], 0x204);
        assert_eq!(receipt["hot_loop_compute_d2h_bytes"], 24);
    }
}

/// FEM demag solver provenance.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FemPoissonDemagProvenance {
    pub linear_solver: String,
    pub preconditioner: String,
    pub rtol: f64,
    pub max_iterations: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_iterations: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_residual: Option<f64>,
    pub boundary_condition: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub robin_beta: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub potential_order: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub potential_true_dof_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub variational_energy_joules: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovered_field_energy_joules: Option<f64>,
}

/// Records which engine and device produced a run.
/// Measured host/device movement for a multilayer FDM CUDA realization.
///
/// The assisted lane deliberately keeps the state and RK orchestration on the
/// host. It must therefore never be presented as device-resident merely
/// because its local exchange and (optionally) multilayer demag calls use CUDA.
/// The native D-07 lane uses the same phase fields to prove that warm steps do
/// not perform vector round-trips.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct FdmMultilayerTransferTelemetry {
    /// Realization selected for the public multilayer run.
    pub execution_shape: String,
    /// Source of truth for the staged state during the hot loop.
    pub data_residency: String,
    /// Number of independently resident magnetic layers in this run.
    pub layer_count: u64,
    /// Number of complete six-field host observation snapshots.
    pub host_snapshot_count: u64,
    /// Precision of every accounted vector payload.
    pub payload_precision: String,
    /// Bytes per scalar in every accounted vector payload.
    pub scalar_bytes: u64,
    /// Initial magnetization vectors uploaded once during setup.
    pub setup_h2d_transfer_count: u64,
    pub setup_h2d_bytes: u64,
    /// Six final/scientific field vectors copied per layer and host snapshot.
    pub observed_snapshot_d2h_transfer_count: u64,
    pub observed_snapshot_d2h_bytes: u64,
    /// Vector transfers inside native device-resident timesteps. These must
    /// remain zero for the qualified D-07 lane.
    pub warm_step_h2d_transfer_count: u64,
    pub warm_step_h2d_bytes: u64,
    pub warm_step_d2h_transfer_count: u64,
    pub warm_step_d2h_bytes: u64,
    /// Number of state/field vector payloads transferred from host to CUDA
    /// during this run. Descriptor, kernel-spectrum and mask traffic is
    /// intentionally accounted separately by their owning runtime stages.
    pub h2d_transfer_count: u64,
    /// Number of state/field vector payloads transferred from CUDA to host
    /// during this run. Host-materialized uniform fields are not counted as
    /// device vector transfers.
    pub d2h_transfer_count: u64,
    /// Cumulative state/field vector payload bytes moved from host to CUDA.
    pub h2d_bytes: u64,
    /// Cumulative state/field vector payload bytes moved from CUDA to host.
    pub d2h_bytes: u64,
}

/// Exact stage accounting for one native CUDA D-07 demag refresh.
///
/// This describes only the device-resident demag operator. The surrounding
/// multilayer timestep may remain host-authoritative and is reported
/// independently by [`FdmMultilayerTransferTelemetry`].
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FdmMultilayerStageTelemetry {
    pub status: String,
    pub execution_engine: String,
    pub data_residency: String,
    pub fft_backend: String,
    pub layer_count: u64,
    pub refresh_count: u64,
    pub forward_fft_count: u64,
    pub inverse_fft_count: u64,
    pub pair_accumulation_count: u64,
}

/// Included in artifact metadata for reproducibility.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FemCrossoverDecision {
    pub requested: String,
    pub resolved: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub calibration_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// Immutable execution proof for the bounded public FDM GPU charge-only lane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChargeTransportExecutionProvenance {
    pub schema_version: String,
    pub module_id: String,
    pub requested_backend: String,
    pub requested_device: String,
    pub requested_precision: String,
    pub requested_execution_mode: String,
    pub resolved_engine: String,
    pub resolved_device: String,
    pub resolved_precision: String,
    pub gauge_policy: String,
    pub solver_policy: String,
    pub operator_version: String,
    pub allocator_limit_bytes: u64,
    pub workspace_limit_bytes: u64,
    pub fallbacks_triggered: Vec<String>,
    pub device_uuid: String,
    pub compute_capability: String,
    pub cuda_runtime: u32,
    pub cuda_driver: u32,
    pub build_digest: String,
    pub iterations: u64,
    pub algebraic_residual: f64,
    pub physical_residual: f64,
    pub component_balance: f64,
    pub electrode_balance: f64,
    pub transfer_count: u64,
    pub transfer_bytes: u64,
    pub peak_bytes: u64,
    pub accepted_sequence: u64,
    pub candidate_digest: String,
    pub snapshot_content_digest: String,
    pub convergence_digest: String,
}

/// One execution request at a specific resolution boundary.
///
/// Final artifacts carry three instances: immutable author intent, the
/// effective request after launcher/environment policy, and the execution
/// identity observed from the engine that actually ran.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExecutionRequestProvenance {
    pub backend: String,
    pub device: String,
    pub precision: String,
    pub mode: String,
}

/// Mandatory execution-resolution record inserted into final metadata.
///
/// `fallback_reason` is intentionally serialized as JSON null when no
/// fallback occurred so consumers never have to infer absence semantics.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FinalExecutionResolutionProvenance {
    pub authored_request: ExecutionRequestProvenance,
    pub effective_request: ExecutionRequestProvenance,
    pub resolved_execution: ExecutionRequestProvenance,
    pub resolution_mode: String,
    pub fallback_occurred: bool,
    pub fallback_reason: Option<String>,
}

/// Runtime-owned CPU FFT workspace evidence captured after execution.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmFftRuntimeTelemetry {
    pub schema_version: String,
    pub workspace_lifecycle_revision: u64,
    pub workspace_key_sha256: String,
    pub plan_creation_time_ns: u64,
    /// Allocator-reserved bytes for buffers owned by the FFT workspace.
    pub workspace_bytes: u64,
    pub forward_fft_count: u64,
    pub inverse_fft_count: u64,
    pub fft_elapsed_time_ns: u64,
}

/// Included in artifact metadata for reproducibility.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmFftExecutionProvenance {
    pub requested_backend: String,
    pub resolved_backend: String,
    pub executed_backend: String,
    pub backend_version: Option<String>,
    pub plan_mode: String,
    pub thread_count: Option<u32>,
    pub workspace_layout: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_telemetry: Option<FdmFftRuntimeTelemetry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmGpuObservationPolicyProvenance {
    pub requested_contract: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub requested_quantity_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub requested_min_period_s: Option<f64>,
    pub resolved_mode: String,
    pub resolved_quantity_mask: u64,
    pub resolved_stride: u32,
    pub executed_mode: String,
    pub executed_quantity_mask: u64,
    pub executed_stride: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmGpuEndpointCacheTelemetry {
    pub cache_identity_valid: bool,
    pub stats_valid: bool,
    pub accepted_state_revision: u64,
    pub valid_field_mask: u64,
    pub refresh_request_count: u64,
    pub refresh_execution_count: u64,
    pub refresh_cache_hit_count: u64,
    pub invalidation_count: u64,
    pub stats_snapshot_request_count: u64,
    pub stats_snapshot_cache_hit_count: u64,
    pub field_snapshot_request_count: u64,
    pub field_snapshot_latency_total_ns: u64,
    pub field_snapshot_latency_max_ns: u64,
    pub exchange_evaluation_count: u64,
    pub demag_evaluation_count: u64,
    pub demag_forward_fft_count: u64,
    pub demag_inverse_fft_count: u64,
    pub effective_field_evaluation_count: u64,
    pub energy_reduction_count: u64,
    pub last_step_exchange_evaluation_count: u64,
    pub last_step_demag_evaluation_count: u64,
    pub last_step_demag_forward_fft_count: u64,
    pub last_step_demag_inverse_fft_count: u64,
    pub last_step_effective_field_evaluation_count: u64,
    pub last_step_energy_reduction_count: u64,
}

/// Included in artifact metadata for reproducibility.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExecutionProvenance {
    /// Engine that executed the run: e.g. "cpu_reference", "cuda_fdm",
    /// "fem_cpu_baseline_internal", "fem_cpu_native", "fem_native_gpu",
    /// "fem_eigen_cpu_baseline", or "fem_eigen_native_gpu".
    pub execution_engine: String,
    /// Numeric precision used: "double" or "single".
    pub precision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charge_transport: Option<ChargeTransportExecutionProvenance>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub transport_modules: Vec<TransportExecutionProvenance>,
    /// Measured native CUDA M1 transport residency and provenance counters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_gpu_transport_telemetry: Option<FdmGpuTransportTelemetry>,
    /// CPU FDM state-layout receipt. `requested` is the public auto policy;
    /// `resolved` and `executed` are the layout actually used by the run.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cpu_state_layout: Option<FdmCpuStateLayoutProvenance>,
    /// Native CUDA Context receipt proving requested, resolved, and executed
    /// FDM LLG residency together with setup and hot-loop transfer counters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_gpu_execution_receipt: Option<FdmGpuExecutionReceipt>,
    /// Native CUDA counters for FDM GPU step-transaction capture and rollback.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_gpu_step_transaction_telemetry: Option<FdmGpuStepTransactionTelemetry>,
    /// Requested, resolved, and executed native CUDA observation schedule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_gpu_observation_policy: Option<FdmGpuObservationPolicyProvenance>,
    /// Native CUDA accepted-endpoint cache and operator counters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_gpu_endpoint_cache_telemetry: Option<FdmGpuEndpointCacheTelemetry>,
    /// CPU reference counters for accepted/rejected FDM step transactions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cpu_step_transaction_telemetry: Option<FdmCpuStepTransactionTelemetry>,
    /// Counts and wall time split by the actual Minimal/Full CPU evaluation request.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_cpu_evaluation_telemetry: Option<FdmCpuEvaluationTelemetry>,
    /// FDM FFT request, resolution, and actually executed realization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_fft_execution: Option<FdmFftExecutionProvenance>,
    /// Native FEM receipt preserving requested, resolved, and actually executed
    /// GPU residency without inferring execution from the RK plan.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_gpu_execution_receipt: Option<FemGpuExecutionReceipt>,
    /// Legacy compatibility observations retained for historical artifacts.
    /// Physics-graph realization must never infer an executed module from a
    /// kind-only observation.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub executed_physics_kinds: Vec<String>,
    /// Exact stable physics-graph module IDs confirmed by the executing
    /// backend for this run.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub executed_physics_module_ids: Vec<String>,
    /// Demag operator kind: e.g. "tensor_fft_newell".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_operator_kind: Option<String>,
    /// FFT backend used: "rustfft" (CPU) or "cuFFT" (CUDA).
    /// Unsupported CPU backends fail instead of silently falling back.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fft_backend: Option<String>,
    /// GPU device name, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// GPU compute capability, if applicable (e.g. "8.6").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compute_capability: Option<String>,
    /// CUDA driver version, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuda_driver_version: Option<i32>,
    /// CUDA runtime version, if applicable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cuda_runtime_version: Option<i32>,
    /// Whether a lossy fallback was used during this run (e.g. single-precision
    /// requested but unavailable, or an approximate demag operator substituted).
    #[serde(default)]
    pub lossy_fallback_used: bool,
    /// Physics terms that were present in the plan but silently ignored by the
    /// engine.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ignored_terms: Vec<String>,
    /// RNG seed used for stochastic initialisations, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub random_seed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_fallback: Option<ResolvedFallback>,
    /// Qualified FEM auto-device crossover decision, if requested device was auto.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_crossover_decision: Option<FemCrossoverDecision>,
    /// Integrator that was requested by the user/plan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_integrator: Option<String>,
    /// Integrator actually used for execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_integrator: Option<String>,
    /// Energy minimizer requested by the user/plan for direct relaxation stages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_energy_minimizer: Option<String>,
    /// Energy minimizer actually used for direct relaxation stages.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_energy_minimizer: Option<String>,
    /// Runtime realization of the energy minimizer.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub energy_minimizer_realization: Option<String>,
    /// Requested and resolved native FEM direct-minimizer direction/solver policy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fem_direct_minimizer_policy: Option<FemDirectMinimizerPolicyProvenance>,
    /// Demag realization requested by the user/plan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_demag_realization: Option<String>,
    /// Demag realization actually used for execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_demag_realization: Option<String>,
    /// Canonical requested and resolved timestep policy for LLG execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestep_policy: Option<TimestepPolicyProvenance>,
    /// Measured host/device transfers for the FDM multilayer realization.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fdm_multilayer_transfer_telemetry: Option<FdmMultilayerTransferTelemetry>,
    /// Exact counters for a recorded native CUDA D-07 demag refresh.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fdm_multilayer_stage_telemetry: Option<FdmMultilayerStageTelemetry>,
    /// Read-only compatibility for artifacts written before `timestep_policy`.
    #[serde(default, skip_serializing)]
    pub dt_policy: Option<LegacyDtPolicy>,
    /// Resolved LLG RHS mode: "precessional" or "pure_damping".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llg_mode: Option<String>,
    /// FEM-030: MFEM device string used for this run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mfem_device: Option<String>,
    /// MFEM major.minor version reported by the loaded native FEM runtime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mfem_version: Option<String>,
    /// HYPRE major.minor.patch version reported by the loaded native FEM runtime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hypre_version: Option<String>,
    /// Canonical demag refresh cadence in seconds, if explicitly configured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_refresh_interval_s: Option<f64>,
    /// FEM operator assembly mode used by the executing backend.
    ///
    /// Native FEM currently reports "legacy_sparse" until exchange/mass/DMI
    /// move to partial assembly or matrix-free libCEED operators.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_assembly_mode: Option<String>,
    /// FEM GPU execution contract: hybrid_legacy_sparse, all_in_gpu_legacy_sparse, etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_execution_mode: Option<String>,
    /// Native FEM GPU qualification status: unsupported, source_visible,
    /// production_executable, or validated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_qualification_status: Option<String>,
    /// FEM exchange operator mode selected by the native GPU exchange planner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_exchange_operator_mode: Option<String>,
    /// FEM data residency contract for the hot loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_data_residency: Option<String>,
    /// Whether Fullmag CUDA kernels were used in the native FEM hot loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uses_cuda_kernels: Option<bool>,
    /// Whether Poisson demag solve/recovery stayed on GPU in the native FEM hot loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uses_gpu_poisson: Option<bool>,
    /// FEM demag operator mode selected by native GPU runtime.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_demag_operator_mode: Option<String>,
    /// hypre execution policy used by native FEM demag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hypre_execution_policy: Option<String>,
    /// FEM demag data residency in the hot loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_residency: Option<String>,
    /// Cumulative native FEM hot-loop host synchronization count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_loop_host_sync_count: Option<u64>,
    /// Cumulative native FEM exchange-interop H2D bytes in the hot loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_loop_exchange_h2d_bytes: Option<u64>,
    /// Cumulative native FEM exchange-interop D2H bytes in the hot loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_loop_exchange_d2h_bytes: Option<u64>,
    /// Cumulative native FEM exchange-interop host synchronization count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_loop_exchange_host_sync_count: Option<u64>,
    /// Cumulative native FEM non-exchange/RK H2D bytes in the hot loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_loop_compute_h2d_bytes: Option<u64>,
    /// Cumulative native FEM non-exchange/RK D2H bytes in the hot loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_loop_compute_d2h_bytes: Option<u64>,
    /// Cumulative native FEM non-exchange/RK host synchronization count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_loop_compute_host_sync_count: Option<u64>,
    /// Cumulative native FEM direct-minimizer control-scalar D2H bytes in the hot loop.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_loop_control_scalar_d2h_bytes: Option<u64>,
    /// Cumulative native FEM direct-minimizer control-scalar host synchronization count.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hot_loop_control_scalar_host_sync_count: Option<u64>,
    /// Whether the native FEM runtime allocated the Phase-1 GPU state object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_state_allocated: Option<bool>,
    /// Node count mirrored by the native FEM GPU state object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_state_node_count: Option<u64>,
    /// Vector DOF length mirrored by the native FEM GPU state object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_state_dof_len: Option<u64>,
    /// RK stage count allocated by the native FEM GPU state object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_state_stage_count: Option<u32>,
    /// Total native FEM GPU state device bytes allocated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_state_device_bytes: Option<u64>,
    /// Native FEM GPU reduction workspace bytes allocated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_state_reduction_workspace_bytes: Option<u64>,
    /// Compatibility field: whether the native FEM device-resident GPU RK path is eligible.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_rk_exchange_only_enabled: Option<bool>,
    /// RK stage count selected by the native FEM GPU RK planner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_rk_stage_count: Option<u32>,
    /// Whether the native FEM GPU RK planner expects Fullmag CUDA kernels.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_rk_uses_cuda_kernels: Option<bool>,
    /// Whether temporary exchange interop host sync is allowed by the selected GPU RK phase.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_rk_allows_exchange_host_sync: Option<bool>,
    /// Whether stage exchange fields are recomputed without host roundtrip.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_rk_stage_exchange_device_resident: Option<bool>,
    /// Reason the native FEM GPU RK path is not enabled, if blocked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_gpu_rk_block_reason: Option<String>,
    /// Requested CPU thread count from authoring/runtime selection.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_cpu_threads: Option<u32>,
    /// Resolved Rayon/control-plane CPU thread count used for execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_cpu_threads: Option<u32>,
    /// Requested FEM OpenMP thread count when the native runtime reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_fem_omp_threads: Option<u32>,
    /// Effective FEM OpenMP thread count when the native runtime reports it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_fem_omp_threads: Option<u32>,
    /// FEM Poisson demag solver policy and observed solve result.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_poisson_demag: Option<FemPoissonDemagProvenance>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FdmCpuStateLayoutProvenance {
    pub requested: String,
    pub resolved: String,
    pub executed: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rejection_reason: Option<String>,
    /// Projected-RK state constraint resolved for the same CPU execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projection_policy: Option<String>,
    /// Stable implementation identity of the projected-RK constraint.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projection_realization: Option<String>,
}

impl FdmCpuStateLayoutProvenance {
    pub(crate) fn from_problem(
        problem: &fullmag_engine::ExchangeLlgProblem,
        soa_active: bool,
        execution_rejection_reason: Option<&str>,
    ) -> Self {
        let resolved = if soa_active { "soa_xyz" } else { "aos_xyz" };
        let rejection_reason = (!soa_active).then(|| {
            execution_rejection_reason
                .or_else(|| problem.soa_fast_path_rejection_reason())
                .unwrap_or("capability_matrix_rejected")
                .to_string()
        });
        Self {
            requested: "auto".to_string(),
            resolved: resolved.to_string(),
            executed: resolved.to_string(),
            rejection_reason,
            projection_policy: None,
            projection_realization: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FdmGpuTransportTelemetry {
    pub schema_version: String,
    pub status: String,
    pub stage_count: u64,
    pub record_count: u64,
    /// Full magnetic/state transfers in the accepted-step hot loop. Bounded
    /// control uploads and scalar reductions are reported separately below.
    pub hot_loop_host_device_transfers: u64,
    pub hot_loop_device_to_device_transfers: u64,
    pub hot_loop_host_sync_count: u64,
    pub forbidden_transfer_bytes: u64,
    pub allowed_control_h2d_records: u64,
    pub allowed_control_h2d_bytes: u64,
    pub allowed_scalar_d2h_records: u64,
    pub allowed_scalar_d2h_bytes: u64,
    pub torque_provenance: String,
    pub all_stage_records_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TransportExecutionProvenance {
    pub module_id: String,
    pub current_source_id: String,
    pub requested_discretization: String,
    pub requested_device: String,
    pub requested_precision: String,
    pub requested_execution_mode: String,
    pub resolved_discretization: String,
    pub resolved_device: String,
    pub resolved_precision: String,
    pub resolved_execution_mode: String,
    pub runtime_family: String,
    pub runtime_id: String,
    pub engine_id: String,
    pub charge_solver_engine: String,
    pub spin_solver_engine: String,
    pub constitutive_version: String,
    pub operator_version: String,
    pub physical_residual_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub charge_operator_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spin_operator_version: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub interface_formula_versions: Vec<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub torque_formula_version: Option<String>,
    pub interface_realization: String,
    pub stage_coupling: String,
    pub capability_status: String,
    pub implementation_state: String,
    pub validation_state: String,
    pub validation_scope: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inserted_default_boundaries: Vec<String>,
    pub charge_domain: fullmag_ir::ResolvedFemTransportDomainIR,
    pub spin_domain: fullmag_ir::ResolvedFemTransportDomainIR,
    pub charge_insulating_boundaries: Vec<fullmag_ir::ResolvedFemBoundaryMarkerSetIR>,
    pub spin_insulating_boundaries: Vec<fullmag_ir::ResolvedFemBoundaryMarkerSetIR>,
    pub interfaces: Vec<fullmag_ir::ResolvedFemTransportInterfaceIR>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub torque_target: Option<fullmag_ir::ResolvedFemTorqueTargetIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fdm_interfaces: Vec<fullmag_ir::ResolvedSpinInterfaceFaceIR>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub fdm_torque_target_cells: Vec<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<TransportFallbackProvenance>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub degradation: Option<TransportDegradationProvenance>,
    /// Identity of a solved-current source consumed by an Oersted realization.
    /// The legacy midpoint lane and the append-only conservative RT0/OE-F1
    /// lane use distinct `source_kind` values; the optional fields are absent
    /// for transport-only runs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_source_kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_source_current_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_mesh_source_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oersted_field_sha256: Option<String>,
    /// Identity and balance certificates of the closure-aware conservative
    /// RT0 source. These are distinct from the legacy nodal-reference hashes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conservative_current_view_identity_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conservative_current_balance_certificate_digest: Option<String>,
    /// Explicit cache policy for a source that is invariant across magnetic
    /// RHS stages.  This is not a magnetization-dependent stage solve.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_cache_policy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_cache_key_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_cache_last_observation: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_cache_hit_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_cache_miss_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage_cache_invalidation_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransportFallbackProvenance {
    pub requested_lane: String,
    pub resolved_lane: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransportDegradationProvenance {
    pub kind: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RuntimeEngineInfo {
    /// Canonical backend family such as "fdm", "fem", or "fem_eigen".
    pub backend_family: String,
    /// Canonical resolved engine id such as "fem_cpu_native" or
    /// "fem_eigen_cpu_baseline".
    pub engine_id: String,
    pub engine_label: String,
    pub accelerator: String,
}

// ----- internal execution types -----

#[derive(Debug, Clone)]
pub(crate) struct ExecutedRun {
    pub result: RunResult,
    pub initial_magnetization: Vec<[f64; 3]>,
    pub field_snapshots: Vec<FieldSnapshot>,
    pub field_snapshot_count: usize,
    pub auxiliary_artifacts: Vec<AuxiliaryArtifact>,
    pub provenance: ExecutionProvenance,
}

#[derive(Debug, Clone)]
pub(crate) struct FieldSnapshot {
    pub name: String,
    pub step: u64,
    pub time: f64,
    pub solver_dt: f64,
    pub component_count: u8,
    pub component_order: String,
    pub location: String,
    pub scope: String,
    pub revision: u64,
    pub values: Vec<f64>,
}

impl FieldSnapshot {
    pub(crate) fn flatten_vec3(values: Vec<[f64; 3]>) -> Vec<f64> {
        values.into_iter().flatten().collect()
    }

    #[allow(clippy::too_many_arguments)]
    #[cfg_attr(not(feature = "fem-gpu"), allow(dead_code))]
    pub(crate) fn new(
        name: impl Into<String>,
        step: u64,
        time: f64,
        solver_dt: f64,
        component_count: u8,
        component_order: impl Into<String>,
        location: impl Into<String>,
        scope: impl Into<String>,
        revision: u64,
        values: Vec<f64>,
    ) -> Result<Self, String> {
        if component_count == 0 {
            return Err("field snapshot component_count must be greater than zero".into());
        }
        if values.len() % usize::from(component_count) != 0 {
            return Err(format!(
                "field snapshot value count {} is not divisible by component_count {component_count}",
                values.len()
            ));
        }
        if revision == 0 {
            return Err("field snapshot revision must be greater than zero".into());
        }
        Ok(Self {
            name: name.into(),
            step,
            time,
            solver_dt,
            component_count,
            component_order: component_order.into(),
            location: location.into(),
            scope: scope.into(),
            revision,
            values,
        })
    }

    pub(crate) fn sample_count(&self) -> usize {
        self.values.len() / usize::from(self.component_count)
    }

    pub(crate) fn vec3_values(&self) -> Result<Vec<[f64; 3]>, String> {
        if self.component_count != 3 {
            return Err(format!(
                "field snapshot '{}' has {} components, expected 3",
                self.name, self.component_count
            ));
        }
        Ok(self
            .values
            .chunks_exact(3)
            .map(|value| [value[0], value[1], value[2]])
            .collect())
    }
}

#[cfg(test)]
mod field_snapshot_tests {
    use super::FieldSnapshot;

    #[test]
    fn canonical_snapshot_supports_scalar_vector_and_tensor_shapes() {
        let scalar = FieldSnapshot::new(
            "V_electric",
            0,
            0.0,
            0.0,
            1,
            "scalar",
            "node",
            "module:transport",
            1,
            vec![1.0, 2.0],
        )
        .unwrap();
        assert_eq!(scalar.sample_count(), 2);

        let vector = FieldSnapshot::new(
            "J_charge",
            0,
            0.0,
            0.0,
            3,
            "xyz",
            "node",
            "module:transport",
            2,
            FieldSnapshot::flatten_vec3(vec![[1.0, 2.0, 3.0]; 2]),
        )
        .unwrap();
        assert_eq!(vector.values, vec![1.0, 2.0, 3.0, 1.0, 2.0, 3.0]);

        let tensor = FieldSnapshot::new(
            "spin_current_tensor",
            0,
            0.0,
            0.0,
            9,
            "row_major_Q_ia",
            "node",
            "module:transport",
            3,
            vec![0.0; 18],
        )
        .unwrap();
        assert_eq!(tensor.sample_count(), 2);
    }

    #[test]
    fn canonical_snapshot_rejects_invalid_component_shape_and_revision() {
        assert!(
            FieldSnapshot::new("bad", 0, 0.0, 0.0, 0, "none", "node", "full", 1, vec![]).is_err()
        );
        assert!(FieldSnapshot::new(
            "bad",
            0,
            0.0,
            0.0,
            3,
            "xyz",
            "node",
            "full",
            1,
            vec![1.0, 2.0]
        )
        .is_err());
        assert!(FieldSnapshot::new(
            "bad",
            0,
            0.0,
            0.0,
            1,
            "scalar",
            "node",
            "full",
            0,
            vec![1.0]
        )
        .is_err());
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuxiliaryArtifact {
    pub relative_path: String,
    pub bytes: Vec<u8>,
}

pub(crate) struct LiveStepConsumer<'a> {
    pub grid: [u32; 3],
    /// Cadence for heavier live payloads such as full magnetization snapshots.
    pub field_every_n: u64,
    /// Whether this consumer needs a full step-0 physics snapshot before
    /// the first accepted step.
    pub initial_snapshot: bool,
    pub display_selection: Option<&'a (dyn Fn() -> crate::DisplaySelectionState + Send + Sync)>,
    #[cfg_attr(not(any(feature = "cuda", feature = "fem-gpu")), allow(dead_code))]
    pub interrupt_requested: Option<&'a AtomicBool>,
    pub on_step: &'a mut dyn FnMut(StepUpdate) -> StepAction,
}

#[derive(Debug, Clone)]
#[allow(non_snake_case)]
pub(crate) struct StateObservables {
    pub magnetization: Vec<[f64; 3]>,
    pub torque_field: Vec<[f64; 3]>,
    pub exchange_field: Vec<[f64; 3]>,
    pub demag_field: Vec<[f64; 3]>,
    pub external_field: Vec<[f64; 3]>,
    pub antenna_field: Vec<[f64; 3]>,
    pub drive_field: Vec<[f64; 3]>,
    pub effective_field: Vec<[f64; 3]>,
    // PH-02: extended vector observables
    pub anisotropy_field: Vec<[f64; 3]>,
    pub dmi_field: Vec<[f64; 3]>,
    pub magnetoelastic_field: Vec<[f64; 3]>,
    pub cubic_anisotropy_field: Vec<[f64; 3]>,
    pub bulk_dmi_field: Vec<[f64; 3]>,
    pub oersted_field: Vec<[f64; 3]>,
    pub thermal_field: Vec<[f64; 3]>,
    pub exchange_energy: f64,
    pub demag_energy: f64,
    pub external_energy: f64,
    pub drive_energy: f64,
    pub anisotropy_energy: f64,
    pub dmi_energy: f64,
    pub total_energy: f64,
    pub max_dm_dt: f64,
    pub max_rhs_all_norm_per_s: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    #[allow(dead_code)]
    pub max_torque_Apm: f64,
    pub max_torque_all_Apm: f64,
    pub per_object_scalars: HashMap<String, HashMap<String, f64>>,
}

#[cfg(test)]
mod tests {
    use super::{
        fem_mesh_fingerprint_count, fem_mesh_payload_build_count, fem_mesh_topology_fingerprint,
        normalized_payload_element_markers, reset_fem_mesh_fingerprint_count,
        reset_fem_mesh_payload_build_count, ExecutionProvenance, FdmCpuStateLayoutProvenance,
        FemMeshPartPayload, FemMeshPayload, FemPoissonDemagProvenance, InitialTimestepReason,
        LegacyDtPolicy, LivePreviewField, LlgTimestepCapabilityId, LlgTimestepQualificationId,
        RequestedTimestepPolicy, ResolvedTimestepPolicy, StageFemMeshAsset, StepStats, StepUpdate,
        TimestepBackend, TimestepDevice, TimestepExecutionIdentity, TimestepPolicyProvenance,
        TimestepValidationState,
    };
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FemDomainMeshModeIR, FemMeshPartIR,
        FemMeshPartRole, FemMeshPartSelector, FemPlanIR, IntegratorChoice, MaterialIR, MeshIR,
    };
    use std::collections::BTreeSet;

    fn fdm_cpu_timestep_identity() -> TimestepExecutionIdentity {
        TimestepExecutionIdentity {
            capability_id: LlgTimestepCapabilityId::LlgTdPolicyV1,
            qualification_id: LlgTimestepQualificationId::ExplicitFixedFdmCpuDouble,
            backend: TimestepBackend::Fdm,
            device: TimestepDevice::Cpu,
            precision: ExecutionPrecision::Double,
            integrator: IntegratorChoice::Heun,
            timestep_policy: crate::timestep_qualification::TimestepPolicyKind::Fixed,
            validation_state: TimestepValidationState::Unvalidated,
            qualification_registry_version: "fullmag.llg_timestep_qualification_registry.v1"
                .to_string(),
            qualification_artifact_sha256: None,
            runtime_source_inputs_sha256: None,
            validated_scope: None,
            qualification_validated_at: None,
            qualification_validator_schema: None,
        }
    }

    fn tiny_fem_plan() -> FemPlanIR {
        FemPlanIR {
            mesh_name: "unit_tet".to_string(),
            mesh_source: Some("test".to_string()),
            mesh: MeshIR {
                mesh_name: "unit_tet".to_string(),
                nodes: vec![
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                cells: fullmag_ir::FemConnectivityIR::from_tet4(vec![[0, 1, 2, 3]]),
                element_markers: vec![1],
                facets: fullmag_ir::FemFacetConnectivityIR::from_tri3(vec![[0, 1, 2]]),
                boundary_markers: vec![1],
                periodic_boundary_pairs: Vec::new(),
                periodic_node_pairs: Vec::new(),
                per_domain_quality: Default::default(),
            },
            object_segments: Vec::new(),
            mesh_parts: Vec::new(),
            mesh_build_report: None,
            domain_mesh_mode: FemDomainMeshModeIR::MergedMagneticMesh,
            domain_frame: None,
            fe_order: 1,
            hmax: 0.4,
            initial_magnetization: vec![[1.0, 0.0, 0.0]; 4],
            frozen_spins: None,
            material: MaterialIR {
                name: "Py".to_string(),
                saturation_magnetisation: 800e3,
                exchange_stiffness: 13e-12,
                damping: 0.5,
                uniaxial_anisotropy: None,
                anisotropy_axis: None,
                uniaxial_anisotropy_k2: None,
                cubic_anisotropy_kc1: None,
                cubic_anisotropy_kc2: None,
                cubic_anisotropy_kc3: None,
                cubic_anisotropy_axis1: None,
                cubic_anisotropy_axis2: None,
                ms_field: None,
                a_field: None,
                alpha_field: None,
                ku_field: None,
                ku2_field: None,
                kc1_field: None,
                kc2_field: None,
                kc3_field: None,
                interfacial_dmi: None,
                bulk_dmi: None,
                dind_field: None,
                dbulk_field: None,
            },
            anisotropy_axis_field: None,
            ms_element_field: None,
            a_element_field: None,
            region_materials: Vec::new(),
            enable_exchange: true,
            enable_demag: false,
            external_field: None,
            antenna_zeeman_masks: Vec::new(),
            field_drives: Vec::new(),
            field_drive_geometry_masks: Vec::new(),
            time_stage: Default::default(),
            current_modules: Vec::new(),
            spin_transport_plans: Vec::new(),
            gyromagnetic_ratio: 2.211e5,
            precision: ExecutionPrecision::Double,
            exchange_bc: ExchangeBoundaryCondition::Neumann,
            integrator: Some(IntegratorChoice::Heun),
            fixed_timestep: Some(1e-13),
            adaptive_timestep: None,
            field_refresh: None,
            relaxation: None,
            demag_realization: None,
            air_box_config: None,
            interfacial_dmi: None,
            dmi_interface_normal: None,
            bulk_dmi: None,
            dind_field: None,
            dbulk_field: None,
            temperature: None,
            current_density: None,
            stt_degree: None,
            stt_beta: None,
            stt_spin_polarization: None,
            stt_lambda: None,
            stt_epsilon_prime: None,
            stt_thickness: None,
            stt_fixed_layer_position: None,
            spin_torque_contract: None,
            has_oersted_cylinder: false,
            oersted_current: None,
            oersted_radius: None,
            oersted_center: None,
            oersted_axis: None,
            oersted_field_xyz: None,
            oersted_time_dep_kind: 0,
            oersted_time_dep_freq: 0.0,
            oersted_time_dep_phase: 0.0,
            oersted_time_dep_offset: 0.0,
            oersted_time_dep_t_on: 0.0,
            oersted_time_dep_t_off: 0.0,
            magnetoelastic: None,
            mechanics: None,
            demag_solver_policy: None,
            thermal_seed_config: None,
            oersted_realization: None,
            gpu_device_index: None,
            mfem_device_string: None,
            use_consistent_mass: None,
        }
    }

    #[test]
    fn fem_mesh_payload_generation_id_is_stable_for_same_plan() {
        let plan = tiny_fem_plan();

        let first = FemMeshPayload::from(&plan);
        let second = FemMeshPayload::from(&plan);

        assert_eq!(first.generation_id, second.generation_id);
        assert_eq!(first.mesh_id, second.mesh_id);
    }

    #[test]
    fn fem_mesh_payload_is_built_once_while_step_updates_reuse_generation() {
        reset_fem_mesh_payload_build_count();
        reset_fem_mesh_fingerprint_count();
        let mut plan = tiny_fem_plan();
        let stage_asset = StageFemMeshAsset::build_from_fem_plan(&plan);
        let stage_generation = stage_asset.identity.generation_id().to_string();
        let stage_mesh = &stage_asset.payload;
        for _ in 0..12 {
            assert_eq!(
                Some(stage_generation.as_str()),
                stage_mesh.generation_id.as_deref()
            );
        }
        assert_eq!(fem_mesh_payload_build_count(), 1);
        assert_eq!(fem_mesh_fingerprint_count(), 1);

        let rebuilt_payload = FemMeshPayload::from_fem_plan_with_generation(
            &plan,
            stage_asset.identity.generation_id().to_string(),
        );
        assert_eq!(rebuilt_payload.generation_id, stage_mesh.generation_id);
        assert_eq!(fem_mesh_payload_build_count(), 2);
        assert_eq!(fem_mesh_fingerprint_count(), 1);

        plan.mesh.nodes[0][0] += 0.25;
        let remeshed = FemMeshPayload::from(&plan);
        assert_ne!(remeshed.generation_id, stage_mesh.generation_id);
        assert_eq!(fem_mesh_payload_build_count(), 3);
        assert_eq!(fem_mesh_fingerprint_count(), 2);
    }

    #[test]
    fn stage_fem_mesh_asset_survives_initialization_and_stage_zero_without_rehash() {
        reset_fem_mesh_payload_build_count();
        reset_fem_mesh_fingerprint_count();
        let plan = tiny_fem_plan();

        let stage_asset = StageFemMeshAsset::build_from_fem_plan(&plan);
        let initialization_payload = stage_asset.payload.clone();
        let stage_context =
            super::FemStageExecutionContext::from_mesh_identity(stage_asset.identity.clone());

        for _ in 0..16 {
            assert_eq!(
                initialization_payload.generation_id.as_deref(),
                stage_context.generation_id().as_deref(),
            );
        }
        assert_eq!(fem_mesh_payload_build_count(), 1);
        assert_eq!(fem_mesh_fingerprint_count(), 1);
    }

    #[test]
    fn production_interactive_asset_reuse_does_not_rebuild_or_refingerprint_mesh() {
        reset_fem_mesh_payload_build_count();
        reset_fem_mesh_fingerprint_count();
        let stage_asset = StageFemMeshAsset::build_from_fem_plan(&tiny_fem_plan());

        let (mesh, context) = crate::interactive_runtime::reuse_stage_fem_mesh_asset(&stage_asset);

        assert_eq!(
            mesh.generation_id.as_deref(),
            context.generation_id().as_deref()
        );
        assert_eq!(fem_mesh_payload_build_count(), 1);
        assert_eq!(fem_mesh_fingerprint_count(), 1);
    }

    #[test]
    fn remeshed_stage_asset_publishes_and_executes_one_new_generation() {
        let mut plan = tiny_fem_plan();
        plan.mesh.nodes[1][0] += 0.25;
        reset_fem_mesh_payload_build_count();
        reset_fem_mesh_fingerprint_count();

        let remeshed_asset = StageFemMeshAsset::build_from_fem_plan(&plan);
        let published_generation = remeshed_asset
            .payload
            .generation_id
            .as_deref()
            .expect("published remesh generation");
        let context =
            super::FemStageExecutionContext::from_mesh_identity(remeshed_asset.identity.clone());
        for step in 0..8 {
            let update = StepUpdate {
                stats: StepStats {
                    step,
                    ..StepStats::default()
                },
                coupled_checkpoint: None,
                grid: [0, 0, 0],
                fem_mesh_generation_id: context.generation_id(),
                magnetization: None,
                preview_field: None,
                cached_preview_fields: None,
                hysteresis_field_m_t: None,
                hysteresis_point_index: None,
                hysteresis_settle_step_index: None,
                hysteresis_settle_step_kind: None,
                hysteresis_settle_step_method: None,
                scalar_row_due: false,
                terminal_field_snapshot: false,
                finished: step == 7,
            };
            assert_eq!(
                update.fem_mesh_generation_id.as_deref(),
                Some(published_generation)
            );
        }
        assert_eq!(fem_mesh_payload_build_count(), 1);
        assert_eq!(fem_mesh_fingerprint_count(), 1);
    }

    #[test]
    fn fem_mesh_topology_fingerprint_changes_for_node_reorder() {
        let base = FemMeshPayload::from(&tiny_fem_plan());
        let mut reordered = base.clone();
        reordered.nodes.swap(1, 2);

        assert_ne!(
            fem_mesh_topology_fingerprint(&base),
            fem_mesh_topology_fingerprint(&reordered)
        );
    }

    #[test]
    fn fem_mesh_topology_fingerprint_changes_for_element_connectivity() {
        let base = FemMeshPayload::from(&tiny_fem_plan());
        let mut rewired = base.clone();
        rewired.cells.nodes = vec![0, 1, 3, 2];

        assert_ne!(
            fem_mesh_topology_fingerprint(&base),
            fem_mesh_topology_fingerprint(&rewired)
        );
    }

    #[test]
    fn fem_mesh_topology_fingerprint_excludes_non_topological_mesh_parts() {
        let base = FemMeshPayload::from(&tiny_fem_plan());
        let mut repartitioned = base.clone();
        repartitioned.mesh_parts.push(FemMeshPartPayload {
            id: "part:film".to_string(),
            label: "Film".to_string(),
            role: "magnetic_object".to_string(),
            object_id: Some("film".to_string()),
            geometry_id: None,
            material_id: None,
            element_start: 0,
            element_count: 1,
            boundary_face_start: 0,
            boundary_face_count: 1,
            boundary_face_indices: Vec::new(),
            node_start: 0,
            node_count: 4,
            node_indices: vec![0, 1, 2, 3],
            facet_global_ordinals: Vec::new(),
            bounds_min: None,
            bounds_max: None,
        });

        assert_eq!(
            fem_mesh_topology_fingerprint(&base),
            fem_mesh_topology_fingerprint(&repartitioned)
        );
    }

    #[test]
    fn normalized_payload_markers_use_region_material_contract_when_available() {
        let magnetic_markers = [7u32].into_iter().collect::<BTreeSet<_>>();
        assert_eq!(
            normalized_payload_element_markers(&[7, 99, 0], Some(&magnetic_markers)),
            vec![1, 0, 0]
        );
    }

    #[test]
    fn normalized_payload_markers_preserve_simple_air_split_without_region_materials() {
        assert_eq!(
            normalized_payload_element_markers(&[2, 0], None),
            vec![1, 0]
        );
    }

    #[test]
    fn normalized_payload_markers_treat_uniform_marker_mesh_as_fully_magnetic() {
        assert_eq!(
            normalized_payload_element_markers(&[5, 5], None),
            vec![1, 1]
        );
    }

    #[test]
    fn fem_mesh_part_payload_counts_explicit_node_indices() {
        let part = FemMeshPartIR {
            id: "part:__air__".to_string(),
            label: "Airbox".to_string(),
            role: FemMeshPartRole::Air,
            object_id: None,
            geometry_id: None,
            material_id: None,
            element_selector: FemMeshPartSelector::ElementRange { start: 8, count: 2 },
            boundary_face_selector: FemMeshPartSelector::BoundaryFaceRange { start: 4, count: 1 },
            node_selector: FemMeshPartSelector::NodeRange { start: 4, count: 1 },
            boundary_face_indices: Vec::new(),
            node_indices: vec![0, 1, 2, 4],
            facet_global_ordinals: Vec::new(),
            bounds_min: None,
            bounds_max: None,
            parent_id: None,
        };

        let payload = FemMeshPartPayload::from(&part);

        assert_eq!(payload.node_start, 4);
        assert_eq!(payload.node_count, 4);
        assert_eq!(payload.node_indices, vec![0, 1, 2, 4]);
    }

    #[test]
    fn to_v2_uses_registry_metadata_for_magnetization() {
        let update = StepUpdate {
            coupled_checkpoint: None,
            stats: StepStats::default(),
            grid: [4, 1, 1],
            fem_mesh_generation_id: None,
            magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            terminal_field_snapshot: false,
            finished: false,
        };

        let v2 = update.to_v2();
        let frame = v2
            .frames
            .iter()
            .find(|entry| entry.quantity_id == "m")
            .expect("missing magnetization frame");
        let spec = fullmag_quantities::quantity_spec("m").expect("missing quantity spec");

        assert_eq!(frame.unit, spec.unit);
        assert_eq!(frame.n_comp, spec.n_comp);
        assert!(!frame.unit.is_empty());
    }

    #[test]
    fn to_v2_uses_registry_metadata_for_preview_fields() {
        let update = StepUpdate {
            coupled_checkpoint: None,
            stats: StepStats::default(),
            grid: [4, 1, 1],
            fem_mesh_generation_id: None,
            magnetization: None,
            preview_field: Some(LivePreviewField {
                config_revision: 1,
                source_step: 0,
                source_time_seconds: None,
                source_revision: 1,
                materialized_at_unix_ms: 0,
                materialization_wall_time_ns: 0,
                quantity: "eden_total".to_string(),
                unit: "wrong".to_string(),
                spatial_kind: "grid".to_string(),
                quantity_domain: "magnetic_only".to_string(),
                preview_grid: [4, 1, 1],
                original_grid: [4, 1, 1],
                vector_field_values: vec![1.0, 2.0, 3.0, 4.0],
                x_chosen_size: 4,
                y_chosen_size: 1,
                applied_x_chosen_size: 4,
                applied_y_chosen_size: 1,
                applied_layer_stride: 1,
                auto_downscaled: false,
                auto_downscale_message: None,
                active_mask: None,
            }),
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            terminal_field_snapshot: false,
            finished: false,
        };

        let v2 = update.to_v2();
        let frame = v2
            .frames
            .iter()
            .find(|entry| entry.quantity_id == "eden_total")
            .expect("missing preview frame");
        let spec = fullmag_quantities::quantity_spec("eden_total").expect("missing quantity spec");

        assert_eq!(frame.unit, spec.unit);
        assert_eq!(frame.n_comp, spec.n_comp);
        assert!(!frame.unit.is_empty());
    }

    #[test]
    fn to_v2_promotes_one_full_grid_m_frame_with_field_provenance() {
        let mut stats = StepStats::default();
        stats.step = 41;
        stats.time = 2.5e-12;
        let update = StepUpdate {
            coupled_checkpoint: None,
            stats,
            grid: [2, 1, 1],
            fem_mesh_generation_id: None,
            magnetization: Some(vec![9.0, 9.0, 9.0, 9.0, 9.0, 9.0]),
            preview_field: None,
            cached_preview_fields: Some(vec![LivePreviewField {
                config_revision: 7,
                source_step: 41,
                source_time_seconds: Some(2.5e-12),
                source_revision: 13,
                materialized_at_unix_ms: 1234,
                materialization_wall_time_ns: 55,
                quantity: "m".to_string(),
                unit: "wrong".to_string(),
                spatial_kind: "grid".to_string(),
                quantity_domain: "magnetic_only".to_string(),
                preview_grid: [2, 1, 1],
                original_grid: [2, 1, 1],
                vector_field_values: vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
                x_chosen_size: 2,
                y_chosen_size: 1,
                applied_x_chosen_size: 2,
                applied_y_chosen_size: 1,
                applied_layer_stride: 1,
                auto_downscaled: false,
                auto_downscale_message: None,
                active_mask: Some(vec![true, false]),
            }]),
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
            terminal_field_snapshot: false,
            finished: true,
        };

        let v2 = update.to_v2();
        let magnetization: Vec<_> = v2
            .frames
            .iter()
            .filter(|frame| frame.quantity_id == "m")
            .collect();

        assert_eq!(
            magnetization.len(),
            1,
            "m must be canonical, not last-write-wins"
        );
        let frame = magnetization[0];
        assert_eq!(frame.values, vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]);
        assert_eq!(frame.grid, [2, 1, 1]);
        assert_eq!(v2.diagnostics.step, 41);
        assert_eq!(v2.diagnostics.time, 2.5e-12);
        let provenance = frame.provenance.as_ref().expect("field provenance");
        assert_eq!(provenance.config_revision, 7);
        assert_eq!(provenance.source_step, 41);
        assert_eq!(provenance.source_revision, 13);
        assert_eq!(provenance.materialized_at_unix_ms, 1234);
        assert_eq!(frame.spatial_kind.as_deref(), Some("grid"));
        assert_eq!(frame.quantity_domain.as_deref(), Some("magnetic_only"));
        assert_eq!(
            frame.layout.as_ref().map(|layout| layout.original_grid),
            Some([2, 1, 1])
        );
    }

    #[test]
    fn timestep_policy_serializes_without_legacy_dt_policy() {
        let mut provenance = ExecutionProvenance::default();
        provenance.timestep_policy = Some(TimestepPolicyProvenance {
            requested: RequestedTimestepPolicy::Fixed {
                integrator: IntegratorChoice::Heun,
                timestep_s: 1e-15,
            },
            resolved: ResolvedTimestepPolicy::Fixed {
                integrator: IntegratorChoice::Heun,
                timestep_s: 1e-15,
            },
            execution_identity: fdm_cpu_timestep_identity(),
            relaxation_controller: None,
        });
        provenance.dt_policy = Some(LegacyDtPolicy::User);

        let value = serde_json::to_value(provenance).unwrap();
        assert!(value.get("timestep_policy").is_some());
        assert!(value.get("dt_policy").is_none());
    }

    #[test]
    fn fdm_cpu_state_layout_provenance_round_trips() {
        let provenance = ExecutionProvenance {
            fdm_cpu_state_layout: Some(FdmCpuStateLayoutProvenance {
                requested: "auto".to_string(),
                resolved: "aos_xyz".to_string(),
                executed: "aos_xyz".to_string(),
                rejection_reason: Some("spatial_damping".to_string()),
                projection_policy: None,
                projection_realization: None,
            }),
            ..ExecutionProvenance::default()
        };
        let value = serde_json::to_value(&provenance).expect("layout receipt should serialize");
        assert_eq!(value["fdm_cpu_state_layout"]["requested"], "auto");
        assert_eq!(value["fdm_cpu_state_layout"]["resolved"], "aos_xyz");
        assert_eq!(
            value["fdm_cpu_state_layout"]["rejection_reason"],
            "spatial_damping"
        );
        let decoded: ExecutionProvenance =
            serde_json::from_value(value).expect("layout receipt should deserialize");
        assert_eq!(
            decoded.fdm_cpu_state_layout,
            provenance.fdm_cpu_state_layout
        );
    }

    #[test]
    fn legacy_dt_policy_is_read_only_and_bounded() {
        let mut value = serde_json::to_value(ExecutionProvenance::default()).unwrap();
        value["dt_policy"] = serde_json::json!("adaptive");
        let provenance: ExecutionProvenance = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(provenance.dt_policy, Some(LegacyDtPolicy::Adaptive));

        value["dt_policy"] = serde_json::json!("unknown_policy");
        assert!(serde_json::from_value::<ExecutionProvenance>(value).is_err());
    }

    #[test]
    fn legacy_execution_provenance_defaults_exact_physics_module_ids() {
        let mut value = serde_json::to_value(ExecutionProvenance {
            executed_physics_module_ids: vec!["torque:strip".to_string()],
            ..ExecutionProvenance::default()
        })
        .unwrap();
        value
            .as_object_mut()
            .expect("execution provenance JSON object")
            .remove("executed_physics_module_ids");

        let provenance: ExecutionProvenance = serde_json::from_value(value).unwrap();

        assert!(provenance.executed_physics_module_ids.is_empty());
    }

    #[test]
    fn adaptive_timestep_provenance_keeps_requested_and_resolved_values() {
        let policy = TimestepPolicyProvenance {
            requested: RequestedTimestepPolicy::Adaptive {
                integrator: IntegratorChoice::Rk45,
                tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::MaxError,
                atol: 1e-6,
                rtol: 0.0,
                dt_initial_s: None,
                dt_min_s: 1e-16,
                dt_max_s: 1e-14,
                safety: 0.9,
                growth_limit: 2.0,
                shrink_limit: 0.2,
                max_spin_rotation: None,
                norm_tolerance: None,
            },
            resolved: ResolvedTimestepPolicy::Adaptive {
                integrator: IntegratorChoice::Rk45,
                estimator_order: 4,
                tolerance_mode: fullmag_ir::AdaptiveToleranceModeIR::MaxError,
                atol: 1e-6,
                rtol: 0.0,
                dt_initial_s: 1e-16,
                dt_initial_reason: InitialTimestepReason::DtMinDefault,
                dt_min_s: 1e-16,
                dt_max_s: 1e-14,
                safety: 0.9,
                growth_limit: 2.0,
                shrink_limit: 0.2,
                max_spin_rotation: None,
                norm_tolerance: None,
            },
            execution_identity: TimestepExecutionIdentity {
                qualification_id: LlgTimestepQualificationId::ExplicitAdaptiveFdmCpuDouble,
                ..fdm_cpu_timestep_identity()
            },
            relaxation_controller: None,
        };

        let value = serde_json::to_value(policy).unwrap();
        assert_eq!(value["requested"]["dt_initial_s"], serde_json::Value::Null);
        assert_eq!(value["resolved"]["dt_initial_s"], 1e-16);
        assert_eq!(value["resolved"]["estimator_order"], 4);
    }

    #[test]
    fn fem_mesh_payload_owns_v2_topology_and_fingerprint_covers_every_axis() {
        let base = FemMeshPayload::from(&tiny_fem_plan());
        let value = serde_json::to_value(&base).unwrap();
        assert!(value.get("cells").is_some());
        assert!(value.get("facets").is_some());
        assert!(value.get("elements").is_none());
        assert!(value.get("boundary_faces").is_none());

        let baseline = fem_mesh_topology_fingerprint(&base);
        let mutations: Vec<Box<dyn Fn(&mut FemMeshPayload)>> = vec![
            Box::new(|mesh| mesh.cells.types[0] = fullmag_ir::FemCellTypeIR::Prism6),
            Box::new(|mesh| mesh.cells.offsets[1] += 1),
            Box::new(|mesh| mesh.cells.nodes[0] += 1),
            Box::new(|mesh| mesh.cells.global_ordinals[0] += 1),
            Box::new(|mesh| mesh.element_markers[0] += 1),
            Box::new(|mesh| mesh.facets.types[0] = fullmag_ir::FemFacetTypeIR::Quad4),
            Box::new(|mesh| mesh.facets.roles[0] = fullmag_ir::FemFacetRoleIR::MaterialInterface),
            Box::new(|mesh| mesh.facets.offsets[1] += 1),
            Box::new(|mesh| mesh.facets.nodes[0] += 1),
            Box::new(|mesh| mesh.facets.global_ordinals[0] += 1),
            Box::new(|mesh| mesh.boundary_markers[0] += 1),
        ];
        for mutate in mutations {
            let mut changed = base.clone();
            mutate(&mut changed);
            assert_ne!(fem_mesh_topology_fingerprint(&changed), baseline);
        }
    }

    #[test]
    fn fem_mesh_payload_normalizes_legacy_topology_and_rejects_dual_encoding() {
        let base = FemMeshPayload::from(&tiny_fem_plan());
        let mut legacy = serde_json::to_value(&base).unwrap();
        let object = legacy.as_object_mut().unwrap();
        object.remove("cells");
        object.remove("facets");
        object.insert("elements".to_string(), serde_json::json!([[0, 1, 2, 3]]));
        object.insert("boundary_faces".to_string(), serde_json::json!([[0, 1, 2]]));

        let normalized: FemMeshPayload = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(
            normalized.cells.types,
            vec![fullmag_ir::FemCellTypeIR::Tet4]
        );
        assert_eq!(
            normalized.facets.types,
            vec![fullmag_ir::FemFacetTypeIR::Tri3]
        );
        assert_eq!(normalized.cells.global_ordinals, vec![0]);
        assert_eq!(normalized.facets.global_ordinals, vec![0]);
        let normalized_value = serde_json::to_value(normalized).unwrap();
        assert!(normalized_value.get("elements").is_none());
        assert!(normalized_value.get("boundary_faces").is_none());

        legacy.as_object_mut().unwrap().insert(
            "cells".to_string(),
            serde_json::json!({
                "types": ["tet4"],
                "offsets": [0, 4],
                "nodes": [0, 1, 2, 3]
            }),
        );
        assert!(serde_json::from_value::<FemMeshPayload>(legacy)
            .unwrap_err()
            .to_string()
            .contains("both legacy and v2 topology"));
    }

    #[test]
    fn demag_diagnostics_default_when_deserializing_old_json() {
        let mut step_json = serde_json::to_value(StepStats::default()).unwrap();
        let step_object = step_json.as_object_mut().unwrap();
        for field in [
            "demag_potential_order",
            "demag_potential_true_dof_count",
            "demag_variational_energy_joules",
            "demag_recovered_field_energy_joules",
        ] {
            step_object.remove(field);
        }
        let step: StepStats = serde_json::from_value(step_json).unwrap();
        assert_eq!(step.demag_potential_order, 0);
        assert_eq!(step.demag_potential_true_dof_count, 0);
        assert_eq!(step.demag_variational_energy_joules, 0.0);
        assert_eq!(step.demag_recovered_field_energy_joules, 0.0);

        let provenance: FemPoissonDemagProvenance = serde_json::from_value(serde_json::json!({
            "linear_solver": "CG",
            "preconditioner": "AMG",
            "rtol": 1.0e-8,
            "max_iterations": 500,
            "actual_iterations": 13,
            "final_residual": 4.0e-9,
            "boundary_condition": "robin",
            "robin_beta": 2.5
        }))
        .unwrap();
        assert_eq!(provenance.potential_order, None);
        assert_eq!(provenance.potential_true_dof_count, None);
        assert_eq!(provenance.variational_energy_joules, None);
        assert_eq!(provenance.recovered_field_energy_joules, None);
    }
}
