//! Public and internal types for the runner.

use fullmag_ir::{FemMeshPartRole, FemMeshPartSelector, MeshQualityIR, StageCompletionIR};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fmt;
use std::sync::atomic::AtomicBool;

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
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    /// Native max |m × H_eff| torque metric in A/m.
    #[serde(default)]
    pub max_torque_Apm: f64,
    /// max |m × B_eff| = μ₀ · max_torque_Apm, in Tesla.
    /// Comparable to mumax MaxTorque.
    #[serde(default)]
    pub max_torque_T: f64,
    pub wall_time_ns: u64,
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
    #[serde(default)]
    pub demag_solver_setup_reused: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_solver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub demag_preconditioner: Option<String>,
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
    /// Wall-clock time spent in synchronous runner/CLI live callback orchestration (ns).
    #[serde(default)]
    pub orchestration_wall_time_ns: u64,
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
    pub dt_suggested: Option<f64>,
    #[serde(default)]
    pub rejected_attempts: u32,
    #[serde(default)]
    pub rhs_evals: u32,
    #[serde(default)]
    pub demag_solves: u32,
    #[serde(default)]
    pub fsal_reused: bool,
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
            e_ani: 0.0,
            e_dmi: 0.0,
            e_total: 0.0,
            max_dm_dt: 0.0,
            max_rhs_norm_per_s: 0.0,
            max_h_eff: 0.0,
            max_h_demag: 0.0,
            max_torque_Apm: 0.0,
            max_torque_T: 0.0,
            wall_time_ns: 0,
            exchange_wall_time_ns: 0,
            demag_wall_time_ns: 0,
            demag_assemble_wall_time_ns: 0,
            demag_solve_wall_time_ns: 0,
            demag_solver_setup_wall_time_ns: 0,
            demag_solver_apply_wall_time_ns: 0,
            demag_solver_setup_reused: false,
            demag_solver: None,
            demag_preconditioner: None,
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
            orchestration_wall_time_ns: 0,
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
            dt_suggested: None,
            rejected_attempts: 0,
            rhs_evals: 0,
            demag_solves: 0,
            fsal_reused: false,
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
    use super::{ExecutionProvenance, StepStats};

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
            demag_wall_time_ns: 17,
            demag_assemble_wall_time_ns: 3,
            demag_solve_wall_time_ns: 5,
            demag_solver_setup_wall_time_ns: 13,
            demag_solver_apply_wall_time_ns: 19,
            demag_solver_setup_reused: true,
            demag_recover_wall_time_ns: 7,
            demag_energy_wall_time_ns: 11,
            extra_energy_wall_time_ns: 29,
            ..StepStats::default()
        };

        let diagnostics = stats.to_diagnostics();
        assert_eq!(diagnostics.demag_wall_time_ns, 17);
        assert_eq!(diagnostics.demag_assemble_wall_time_ns, 3);
        assert_eq!(diagnostics.demag_solve_wall_time_ns, 5);
        assert_eq!(diagnostics.demag_solver_setup_wall_time_ns, 13);
        assert_eq!(diagnostics.demag_solver_apply_wall_time_ns, 19);
        assert!(diagnostics.demag_solver_setup_reused);
        assert_eq!(diagnostics.demag_recover_wall_time_ns, 7);
        assert_eq!(diagnostics.demag_energy_wall_time_ns, 11);
        assert_eq!(diagnostics.extra_energy_wall_time_ns, 29);
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
        assert_eq!(snapshot.latest_samples[1].phase_sum_ns, 840);
        assert_eq!(snapshot.latest_samples[1].missing_ns, 160);
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
        assert_eq!(profile.snapshot().latest_samples.len(), 2);
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
}

impl StepStats {
    /// Extract solver diagnostics (non-physics telemetry).
    pub fn to_diagnostics(&self) -> fullmag_quantities::StepDiagnostics {
        fullmag_quantities::StepDiagnostics {
            step: self.step,
            time: self.time,
            dt: self.dt,
            wall_time_ns: self.wall_time_ns,
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
            dt_suggested: self.dt_suggested,
            rejected_attempts: self.rejected_attempts,
            rhs_evals: self.rhs_evals,
            demag_solves: self.demag_solves,
            fsal_reused: self.fsal_reused,
            poisson_iterations: self.poisson_iterations,
            poisson_final_residual: self.poisson_final_residual,
            demag_refreshed: self.demag_refreshed,
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
    /// Grid dimensions [nx, ny, nz] for client-side reconstruction.
    pub grid: [u32; 3],
    /// Optional FEM mesh payload for mesh-native preview in the control room.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fem_mesh: Option<FemMeshPayload>,
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

        // Magnetization → LiveQuantityFrame
        if let Some(ref mag) = self.magnetization {
            frames.push(fullmag_quantities::LiveQuantityFrame {
                quantity_id: "m".to_string(),
                unit: fullmag_quantities::quantity_unit("m").to_string(),
                grid: self.grid,
                n_comp: fullmag_quantities::quantity_spec("m")
                    .map(|spec| spec.n_comp)
                    .unwrap_or(3),
                values: mag.clone(),
                active_mask: None,
            });
        }

        // Active preview field → LiveQuantityFrame
        if let Some(ref pf) = self.preview_field {
            frames.push(fullmag_quantities::LiveQuantityFrame {
                quantity_id: pf.quantity.clone(),
                unit: fullmag_quantities::quantity_unit(&pf.quantity).to_string(),
                grid: pf.preview_grid,
                n_comp: fullmag_quantities::quantity_spec(&pf.quantity)
                    .map(|spec| spec.n_comp)
                    .unwrap_or(3),
                values: pf.vector_field_values.clone(),
                active_mask: pf.active_mask.clone(),
            });
        }

        // Cached preview fields → LiveQuantityFrame each
        if let Some(ref cached) = self.cached_preview_fields {
            for cf in cached {
                frames.push(fullmag_quantities::LiveQuantityFrame {
                    quantity_id: cf.quantity.clone(),
                    unit: fullmag_quantities::quantity_unit(&cf.quantity).to_string(),
                    grid: cf.preview_grid,
                    n_comp: fullmag_quantities::quantity_spec(&cf.quantity)
                        .map(|spec| spec.n_comp)
                        .unwrap_or(3),
                    values: cf.vector_field_values.clone(),
                    active_mask: cf.active_mask.clone(),
                });
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
    pub surface_faces: Vec<[u32; 3]>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FemMeshPayload {
    pub mesh_name: String,
    pub mesh_id: String,
    pub nodes: Vec<[f64; 3]>,
    pub elements: Vec<[u32; 4]>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub element_markers: Vec<u32>,
    pub boundary_faces: Vec<[u32; 3]>,
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

pub fn fem_mesh_topology_fingerprint(mesh: &FemMeshPayload) -> String {
    let mut hasher = Sha256::new();
    update_hash_bytes(
        &mut hasher,
        "schema",
        b"fullmag:fem-mesh-topology-fingerprint:v1",
    );
    update_hash_str(&mut hasher, "mesh_name", &mesh.mesh_name);
    update_hash_str(&mut hasher, "mesh_id", &mesh.mesh_id);
    update_hash_serialized(&mut hasher, "generation_id", &mesh.generation_id);
    update_hash_nodes(&mut hasher, "nodes", &mesh.nodes);
    update_hash_tets(&mut hasher, "elements", &mesh.elements);
    update_hash_u32_slice(&mut hasher, "element_markers", &mesh.element_markers);
    update_hash_triangles(&mut hasher, "boundary_faces", &mesh.boundary_faces);
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
    update_hash_serialized(&mut hasher, "object_segments", &mesh.object_segments);
    update_hash_serialized(&mut hasher, "mesh_parts", &mesh.mesh_parts);
    update_hash_serialized(&mut hasher, "domain_mesh_mode", &mesh.domain_mesh_mode);
    update_hash_serialized(&mut hasher, "domain_frame", &mesh.domain_frame);
    digest_hex(&hasher.finalize())
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
    let mut hasher = Sha256::new();
    update_hash_bytes(&mut hasher, "schema", b"fullmag:fem-mesh-payload:v1");
    update_hash_str(&mut hasher, "mesh_name", &mesh.mesh_name);
    update_hash_nodes(&mut hasher, "nodes", &mesh.nodes);
    update_hash_tets(&mut hasher, "elements", &mesh.elements);
    update_hash_u32_slice(&mut hasher, "element_markers", element_markers);
    update_hash_triangles(&mut hasher, "boundary_faces", &mesh.boundary_faces);
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

fn update_hash_tets(hasher: &mut Sha256, label: &str, elements: &[[u32; 4]]) {
    hasher.update(label.as_bytes());
    hasher.update((elements.len() as u64).to_le_bytes());
    for element in elements {
        for index in element {
            hasher.update(index.to_le_bytes());
        }
    }
}

fn update_hash_triangles(hasher: &mut Sha256, label: &str, faces: &[[u32; 3]]) {
    hasher.update(label.as_bytes());
    hasher.update((faces.len() as u64).to_le_bytes());
    for face in faces {
        for index in face {
            hasher.update(index.to_le_bytes());
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

impl From<&fullmag_ir::FemPlanIR> for FemMeshPayload {
    fn from(plan: &fullmag_ir::FemPlanIR) -> Self {
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
        let generation_id = stable_fem_mesh_generation_id(
            &plan.mesh,
            &element_markers,
            &plan.object_segments,
            &plan.mesh_parts,
            plan.domain_mesh_mode,
            &plan.domain_frame,
        );
        Self {
            mesh_name: plan.mesh.mesh_name.clone(),
            mesh_id: format!("{}:{}", plan.mesh.mesh_name, generation_id),
            nodes: plan.mesh.nodes.clone(),
            elements: plan.mesh.elements.clone(),
            element_markers,
            boundary_faces: plan.mesh.boundary_faces.clone(),
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

impl From<&fullmag_ir::FemEigenPlanIR> for FemMeshPayload {
    fn from(plan: &fullmag_ir::FemEigenPlanIR) -> Self {
        let element_markers = normalized_payload_element_markers(&plan.mesh.element_markers, None);
        let generation_id = stable_fem_mesh_generation_id(
            &plan.mesh,
            &element_markers,
            &plan.object_segments,
            &plan.mesh_parts,
            plan.domain_mesh_mode,
            &plan.domain_frame,
        );
        Self {
            mesh_name: plan.mesh.mesh_name.clone(),
            mesh_id: format!("{}:{}", plan.mesh.mesh_name, generation_id),
            nodes: plan.mesh.nodes.clone(),
            elements: plan.mesh.elements.clone(),
            element_markers,
            boundary_faces: plan.mesh.boundary_faces.clone(),
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

impl From<&fullmag_ir::FemFrequencyResponsePlanIR> for FemMeshPayload {
    fn from(plan: &fullmag_ir::FemFrequencyResponsePlanIR) -> Self {
        let element_markers = normalized_payload_element_markers(&plan.mesh.element_markers, None);
        let generation_id = stable_fem_mesh_generation_id(
            &plan.mesh,
            &element_markers,
            &plan.object_segments,
            &plan.mesh_parts,
            plan.domain_mesh_mode,
            &plan.domain_frame,
        );
        Self {
            mesh_name: plan.mesh.mesh_name.clone(),
            mesh_id: format!("{}:{}", plan.mesh.mesh_name, generation_id),
            nodes: plan.mesh.nodes.clone(),
            elements: plan.mesh.elements.clone(),
            element_markers,
            boundary_faces: plan.mesh.boundary_faces.clone(),
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
            surface_faces: part.surface_faces.clone(),
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ResolvedFallback {
    pub occurred: bool,
    pub original_engine: String,
    pub fallback_engine: String,
    pub reason: String,
    pub message: String,
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
}

/// Records which engine and device produced a run.
/// Included in artifact metadata for reproducibility.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ExecutionProvenance {
    /// Engine that executed the run: e.g. "cpu_reference", "cuda_fdm",
    /// "fem_cpu_baseline_internal", "fem_cpu_native", "fem_native_gpu",
    /// "fem_eigen_cpu_baseline", or "fem_eigen_native_gpu".
    pub execution_engine: String,
    /// Numeric precision used: "double" or "single".
    pub precision: String,
    /// Demag operator kind: e.g. "tensor_fft_newell".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_operator_kind: Option<String>,
    /// FFT backend used: "rustfft" (CPU) or "cuFFT" (CUDA).
    /// CPU FDM demag resolves this through `FULLMAG_CPU_FFT_BACKEND`;
    /// unsupported CPU backends fail instead of silently falling back.
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
    /// Demag realization requested by the user/plan.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_demag_realization: Option<String>,
    /// Demag realization actually used for execution.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_demag_realization: Option<String>,
    /// Timestep policy: "user", "adaptive", or "fallback".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dt_policy: Option<String>,
    /// Resolved LLG RHS mode: "precessional" or "pure_damping".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub llg_mode: Option<String>,
    /// FEM-030: MFEM device string used for this run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mfem_device: Option<String>,
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
    pub values: Vec<[f64; 3]>,
}

#[derive(Debug, Clone)]
pub(crate) struct AuxiliaryArtifact {
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
    pub anisotropy_energy: f64,
    pub dmi_energy: f64,
    pub total_energy: f64,
    pub max_dm_dt: f64,
    pub max_h_eff: f64,
    pub max_h_demag: f64,
    #[allow(dead_code)]
    pub max_torque_Apm: f64,
    pub per_object_scalars: HashMap<String, HashMap<String, f64>>,
}

#[cfg(test)]
mod tests {
    use super::{
        fem_mesh_topology_fingerprint, normalized_payload_element_markers, FemMeshPartPayload,
        FemMeshPayload, LivePreviewField, StepStats, StepUpdate,
    };
    use fullmag_ir::{
        ExchangeBoundaryCondition, ExecutionPrecision, FemDomainMeshModeIR, FemMeshPartIR,
        FemMeshPartRole, FemMeshPartSelector, FemPlanIR, IntegratorChoice, MaterialIR, MeshIR,
    };
    use std::collections::BTreeSet;

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
                elements: vec![[0, 1, 2, 3]],
                element_markers: vec![1],
                boundary_faces: vec![[0, 1, 2]],
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
            current_modules: Vec::new(),
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
        rewired.elements[0] = [0, 1, 3, 2];

        assert_ne!(
            fem_mesh_topology_fingerprint(&base),
            fem_mesh_topology_fingerprint(&rewired)
        );
    }

    #[test]
    fn fem_mesh_topology_fingerprint_changes_for_mesh_part_node_indices() {
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
            surface_faces: Vec::new(),
            bounds_min: None,
            bounds_max: None,
        });

        assert_ne!(
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
            surface_faces: Vec::new(),
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
            stats: StepStats::default(),
            grid: [4, 1, 1],
            fem_mesh: None,
            magnetization: Some(vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
            preview_field: None,
            cached_preview_fields: None,
            hysteresis_field_m_t: None,
            hysteresis_point_index: None,
            hysteresis_settle_step_index: None,
            hysteresis_settle_step_kind: None,
            hysteresis_settle_step_method: None,
            scalar_row_due: false,
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
            stats: StepStats::default(),
            grid: [4, 1, 1],
            fem_mesh: None,
            magnetization: None,
            preview_field: Some(LivePreviewField {
                config_revision: 1,
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
}
