use std::collections::VecDeque;
use std::time::Instant;

use serde::{Deserialize, Serialize};

use crate::types::StepStats;

const DEFAULT_SAMPLE_EVERY: u64 = 1;
const DEFAULT_MAX_SAMPLES: usize = 128;
const MAX_PROFILE_SAMPLES: usize = 4096;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SolverProfileConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default = "default_sample_every")]
    pub sample_every: u64,
    /// When non-zero, gates sampling by real wall-clock time instead of step
    /// number. At most one sample is recorded per `sample_interval_wall_ms`
    /// milliseconds. Useful for fast GPU runs where per-step recording would
    /// flood the ring buffer. Set to e.g. 10_000 (10 s) for GPU profiling.
    /// When 0, step-number gating via `sample_every` is used instead.
    #[serde(default)]
    pub sample_interval_wall_ms: u64,
    #[serde(default = "default_max_samples")]
    pub max_samples: usize,
    #[serde(default)]
    pub emit_engine_log: bool,
    #[serde(default)]
    pub persist_artifact: bool,
}

impl Default for SolverProfileConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            sample_every: DEFAULT_SAMPLE_EVERY,
            sample_interval_wall_ms: 0,
            max_samples: DEFAULT_MAX_SAMPLES,
            emit_engine_log: false,
            persist_artifact: false,
        }
    }
}

impl SolverProfileConfig {
    pub fn normalized(mut self) -> Self {
        if self.sample_every == 0 {
            self.sample_every = DEFAULT_SAMPLE_EVERY;
        }
        if self.max_samples == 0 {
            self.max_samples = DEFAULT_MAX_SAMPLES;
        }
        self.max_samples = self.max_samples.min(MAX_PROFILE_SAMPLES);
        self
    }
}

fn default_sample_every() -> u64 {
    DEFAULT_SAMPLE_EVERY
}

fn default_max_samples() -> usize {
    DEFAULT_MAX_SAMPLES
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverProfileThreading {
    pub requested_omp_threads: i32,
    pub effective_omp_threads: i32,
    pub thread_mode: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cap_reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mfem_device: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openmp_compiled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub openmp_available: Option<bool>,
}

impl SolverProfileThreading {
    fn from_stats(stats: &StepStats) -> Self {
        let thread_mode = if stats.requested_fem_omp_threads <= 0 {
            "unknown"
        } else if stats.requested_fem_omp_threads == stats.effective_fem_omp_threads {
            "requested"
        } else {
            "resolved"
        };
        Self {
            requested_omp_threads: stats.requested_fem_omp_threads,
            effective_omp_threads: stats.effective_fem_omp_threads,
            thread_mode: thread_mode.to_string(),
            cap_reason: cpu_thread_cap_reason_label(stats.fem_cpu_thread_cap_reason).to_string(),
            mfem_device: None,
            openmp_compiled: None,
            openmp_available: None,
        }
    }
}

fn cpu_thread_cap_reason_label(code: i32) -> &'static str {
    match code {
        1 => "external-auto-resolved",
        2 => "auto-small-mesh-cap",
        3 => "auto-medium-mesh-cap",
        4 => "gpu-bypass",
        5 => "auto-uncapped",
        _ => "none",
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverProfilePhaseSample {
    pub id: String,
    pub label: String,
    pub wall_time_ns: u64,
    pub percent_of_total: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SolverProfileSampleKind {
    NormalStep,
    Publish,
    Preview,
    Finalization,
    Stall,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SolverProfilePhaseWindow {
    pub id: String,
    pub label: String,
    pub sum_wall_time_ns: u64,
    pub mean_wall_time_ns: u64,
    pub max_wall_time_ns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverProfileStepSample {
    pub step: u64,
    pub sample_time_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_wall_time_ns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unprofiled_gap_wall_time_ns: Option<u64>,
    #[serde(default)]
    pub span_first_step: u64,
    #[serde(default)]
    pub span_last_step: u64,
    #[serde(default)]
    pub span_step_count: u64,
    #[serde(default)]
    pub span_monotonic_wall_time_ns: u64,
    #[serde(default)]
    pub profiled_step_total_ns: u64,
    #[serde(default)]
    pub native_solver_wall_time_ns: u64,
    #[serde(default)]
    pub unprofiled_gap_total_ns: u64,
    #[serde(default)]
    pub unprofiled_gap_per_step_ns: u64,
    #[serde(default)]
    pub sample_kinds: Vec<SolverProfileSampleKind>,
    #[serde(default)]
    pub phase_windows: Vec<SolverProfilePhaseWindow>,
    pub time: f64,
    pub dt: f64,
    pub total_ns: u64,
    pub phase_sum_ns: u64,
    pub missing_ns: u64,
    pub phases: Vec<SolverProfilePhaseSample>,
    pub demag_subphase_sum_ns: u64,
    pub demag_subphases: Vec<SolverProfilePhaseSample>,
    pub rhs_evaluations: u32,
    pub rejected_attempts: u32,
    pub demag_solves: u32,
    pub poisson_iterations: u32,
    pub poisson_final_residual: f64,
    pub demag_solver_setup_reused: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_solver: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demag_preconditioner: Option<String>,
    pub field_copy_bytes: u64,
    pub artifact_enqueue_bytes: u64,
    pub artifact_queue_depth_max: u64,
    pub artifact_queue_depth_current: u64,
    pub artifact_writer_jobs_completed: u64,
    pub artifact_writer_job_wall_time_ns: u64,
    pub artifact_scalar_row_writer_wall_time_ns: u64,
    pub artifact_field_snapshot_writer_wall_time_ns: u64,
    pub artifact_native_field_snapshot_writer_wall_time_ns: u64,
    pub native_ffi_overhead_wall_time_ns: u64,
    pub finalization_wall_time_ns: u64,
    pub finalization_field_copy_wall_time_ns: u64,
    pub finalization_field_copy_bytes: u64,
    pub relaxation_state_copy_wall_time_ns: u64,
    pub relaxation_state_upload_wall_time_ns: u64,
    pub relaxation_retraction_wall_time_ns: u64,
    pub relaxation_gradient_wall_time_ns: u64,
    pub relaxation_metric_wall_time_ns: u64,
    pub relaxation_line_search_wall_time_ns: u64,
    pub relaxation_update_wall_time_ns: u64,
    pub hot_loop_h2d_bytes: u64,
    pub hot_loop_d2h_bytes: u64,
    pub hot_loop_host_sync_count: u64,
    pub hot_loop_control_scalar_d2h_bytes: u64,
    pub hot_loop_control_scalar_host_sync_count: u64,
    pub relaxation_preconditioner_cache_hits: u32,
    pub relaxation_preconditioner_cache_misses: u32,
    #[serde(default)]
    pub step_update_deep_clone_count: u64,
    pub threading: SolverProfileThreading,
}

impl SolverProfileStepSample {
    pub fn from_step_stats(stats: &StepStats) -> Self {
        let total_ns = stats.wall_time_ns;
        let demag_subphase_sum_ns = stats
            .demag_assemble_wall_time_ns
            .saturating_add(stats.demag_solver_setup_wall_time_ns)
            .saturating_add(stats.demag_solver_apply_wall_time_ns)
            .saturating_add(stats.demag_recover_wall_time_ns)
            .saturating_add(stats.demag_energy_wall_time_ns);
        let demag_total_ns = stats.demag_wall_time_ns.max(demag_subphase_sum_ns);
        let phase_sum_ns = native_solver_wall_time_ns(stats)
            .saturating_add(stats.native_ffi_overhead_wall_time_ns)
            .saturating_add(stats.preview_wall_time_ns)
            .saturating_add(stats.cached_preview_wall_time_ns)
            .saturating_add(stats.field_copy_wall_time_ns)
            .saturating_add(stats.artifact_enqueue_block_wall_time_ns)
            .saturating_add(stats.finalization_wall_time_ns)
            .saturating_add(stats.orchestration_wall_time_ns);

        Self {
            step: stats.step,
            sample_time_unix_ms: unix_time_millis(),
            delta_wall_time_ns: None,
            unprofiled_gap_wall_time_ns: None,
            span_first_step: stats.step,
            span_last_step: stats.step,
            span_step_count: 1,
            span_monotonic_wall_time_ns: 0,
            profiled_step_total_ns: stats.wall_time_ns,
            native_solver_wall_time_ns: native_solver_wall_time_ns(stats),
            unprofiled_gap_total_ns: 0,
            unprofiled_gap_per_step_ns: 0,
            sample_kinds: sample_kinds(stats, 0),
            phase_windows: Vec::new(),
            time: stats.time,
            dt: stats.dt,
            total_ns,
            phase_sum_ns,
            missing_ns: total_ns.saturating_sub(phase_sum_ns),
            phases: vec![
                phase("rhs_total", "RHS total", stats.rhs_wall_time_ns, total_ns),
                phase(
                    "exchange",
                    "Exchange",
                    stats.exchange_wall_time_ns,
                    total_ns,
                ),
                phase("demag_total", "Demag total", demag_total_ns, total_ns),
                phase(
                    "local_terms",
                    "Local terms",
                    stats.extra_energy_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "snapshot",
                    "Snapshot",
                    stats.snapshot_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "relax_preconditioner",
                    "Relax preconditioner",
                    stats.relaxation_preconditioner_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "native_ffi_overhead",
                    "Native FFI",
                    stats.native_ffi_overhead_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "relax_state_copy",
                    "Relax state copy",
                    stats.relaxation_state_copy_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "relax_state_upload",
                    "Relax state upload",
                    stats.relaxation_state_upload_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "relax_retraction",
                    "Relax retraction",
                    stats.relaxation_retraction_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "relax_gradient",
                    "Relax gradient",
                    stats.relaxation_gradient_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "relax_metric",
                    "Relax metric",
                    stats.relaxation_metric_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "relax_line_search",
                    "Relax line search",
                    stats.relaxation_line_search_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "relax_update",
                    "Relax update",
                    stats.relaxation_update_wall_time_ns,
                    total_ns,
                ),
                phase("preview", "Preview", stats.preview_wall_time_ns, total_ns),
                phase(
                    "cached_preview",
                    "Cached preview",
                    stats.cached_preview_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "orchestration",
                    "Orchestration",
                    stats.orchestration_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "mesh_payload",
                    "Mesh payload",
                    stats.mesh_payload_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "live_state_build",
                    "Live state build",
                    stats.live_state_build_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "publisher_replace",
                    "Publisher replace",
                    stats.publisher_replace_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "profile_persist_enqueue",
                    "Profile persist enqueue",
                    stats.profile_persist_enqueue_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "field_copy",
                    "Field copy",
                    stats.field_copy_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "artifact_enqueue",
                    "Artifact enqueue",
                    stats.artifact_enqueue_block_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "finalization",
                    "Finalization",
                    stats.finalization_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "unattributed",
                    "Unattributed",
                    total_ns.saturating_sub(phase_sum_ns),
                    total_ns,
                ),
            ],
            demag_subphase_sum_ns,
            demag_subphases: vec![
                phase(
                    "demag_assemble",
                    "Demag assemble",
                    stats.demag_assemble_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "demag_solver_setup",
                    "Demag solver setup",
                    stats.demag_solver_setup_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "demag_solver_apply",
                    "Demag solver apply",
                    stats.demag_solver_apply_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "demag_recover",
                    "Demag recover",
                    stats.demag_recover_wall_time_ns,
                    total_ns,
                ),
                phase(
                    "demag_energy",
                    "Demag energy",
                    stats.demag_energy_wall_time_ns,
                    total_ns,
                ),
            ],
            rhs_evaluations: stats.rhs_evals,
            rejected_attempts: stats.rejected_attempts,
            demag_solves: stats.demag_solves,
            poisson_iterations: stats.poisson_iterations,
            poisson_final_residual: stats.poisson_final_residual,
            demag_solver_setup_reused: stats.demag_solver_setup_reused,
            demag_solver: stats.demag_solver.clone(),
            demag_preconditioner: stats.demag_preconditioner.clone(),
            field_copy_bytes: stats.field_copy_bytes,
            artifact_enqueue_bytes: stats.artifact_enqueue_bytes,
            artifact_queue_depth_max: stats.artifact_queue_depth_max,
            artifact_queue_depth_current: stats.artifact_queue_depth_current,
            artifact_writer_jobs_completed: stats.artifact_writer_jobs_completed,
            artifact_writer_job_wall_time_ns: stats.artifact_writer_job_wall_time_ns,
            artifact_scalar_row_writer_wall_time_ns: stats.artifact_scalar_row_writer_wall_time_ns,
            artifact_field_snapshot_writer_wall_time_ns: stats
                .artifact_field_snapshot_writer_wall_time_ns,
            artifact_native_field_snapshot_writer_wall_time_ns: stats
                .artifact_native_field_snapshot_writer_wall_time_ns,
            native_ffi_overhead_wall_time_ns: stats.native_ffi_overhead_wall_time_ns,
            finalization_wall_time_ns: stats.finalization_wall_time_ns,
            finalization_field_copy_wall_time_ns: stats.finalization_field_copy_wall_time_ns,
            finalization_field_copy_bytes: stats.finalization_field_copy_bytes,
            relaxation_state_copy_wall_time_ns: stats.relaxation_state_copy_wall_time_ns,
            relaxation_state_upload_wall_time_ns: stats.relaxation_state_upload_wall_time_ns,
            relaxation_retraction_wall_time_ns: stats.relaxation_retraction_wall_time_ns,
            relaxation_gradient_wall_time_ns: stats.relaxation_gradient_wall_time_ns,
            relaxation_metric_wall_time_ns: stats.relaxation_metric_wall_time_ns,
            relaxation_line_search_wall_time_ns: stats.relaxation_line_search_wall_time_ns,
            relaxation_update_wall_time_ns: stats.relaxation_update_wall_time_ns,
            hot_loop_h2d_bytes: stats.hot_loop_h2d_bytes,
            hot_loop_d2h_bytes: stats.hot_loop_d2h_bytes,
            hot_loop_host_sync_count: stats.hot_loop_host_sync_count,
            hot_loop_control_scalar_d2h_bytes: stats.hot_loop_control_scalar_d2h_bytes,
            hot_loop_control_scalar_host_sync_count: stats.hot_loop_control_scalar_host_sync_count,
            relaxation_preconditioner_cache_hits: stats.relaxation_preconditioner_cache_hits,
            relaxation_preconditioner_cache_misses: stats.relaxation_preconditioner_cache_misses,
            step_update_deep_clone_count: stats.step_update_deep_clone_count,
            threading: SolverProfileThreading::from_stats(stats),
        }
    }

    pub fn compact_log_line(&self) -> String {
        format!(
            "solver-profile step={} span={}..{} span_steps={} span_wall={} profiled_total={} native_solver={} gap_total={} gap_per_step={} last_step_total={} exchange={} demag={} demag.solve={} demag.policy={}/{} relax_preconditioner={} relax_prec_cache={}/{} native_ffi={} rhs={} preview={} cache={} field_copy={} artifact_enqueue={} artifact_writer={}/{} finalization={} orchestration={} missing={} gpu_sync={} control_scalar_sync={} control_scalar_d2h={} omp={}/{} omp_reason={}",
            self.step,
            self.span_first_step,
            self.span_last_step,
            self.span_step_count,
            format_duration_ns(self.span_monotonic_wall_time_ns),
            format_duration_ns(self.profiled_step_total_ns),
            format_duration_ns(self.native_solver_wall_time_ns),
            format_duration_ns(self.unprofiled_gap_total_ns),
            format_duration_ns(self.unprofiled_gap_per_step_ns),
            format_duration_ns(self.total_ns),
            format_duration_ns(phase_time(&self.phases, "exchange")),
            format_duration_ns(phase_time(&self.phases, "demag_total")),
            format_duration_ns(phase_time(&self.demag_subphases, "demag_solver_apply")),
            self.demag_solver.as_deref().unwrap_or("n/a"),
            self.demag_preconditioner.as_deref().unwrap_or("n/a"),
            format_duration_ns(phase_time(&self.phases, "relax_preconditioner")),
            self.relaxation_preconditioner_cache_hits,
            self.relaxation_preconditioner_cache_misses,
            format_duration_ns(phase_time(&self.phases, "native_ffi_overhead")),
            format_duration_ns(phase_time(&self.phases, "rhs_total")),
            format_duration_ns(phase_time(&self.phases, "preview")),
            format_duration_ns(phase_time(&self.phases, "cached_preview")),
            format_duration_ns(phase_time(&self.phases, "field_copy")),
            format_duration_ns(phase_time(&self.phases, "artifact_enqueue")),
            self.artifact_writer_jobs_completed,
            format_duration_ns(self.artifact_writer_job_wall_time_ns),
            format_duration_ns(phase_time(&self.phases, "finalization")),
            format_duration_ns(phase_time(&self.phases, "orchestration")),
            format_duration_ns(self.missing_ns),
            self.hot_loop_host_sync_count,
            self.hot_loop_control_scalar_host_sync_count,
            format_bytes(self.hot_loop_control_scalar_d2h_bytes),
            self.threading.requested_omp_threads,
            self.threading.effective_omp_threads,
            self.threading.cap_reason,
        )
    }
}

fn duration_ns(duration: std::time::Duration) -> u64 {
    duration.as_nanos().min(u128::from(u64::MAX)) as u64
}

fn native_solver_wall_time_ns(stats: &StepStats) -> u64 {
    // Snapshot encloses exchange, normalized demag, and local interactions.
    // RHS and relaxation-driver phases are sequential in the native sources.
    let demag_subphase_sum = stats
        .demag_assemble_wall_time_ns
        .saturating_add(stats.demag_solver_setup_wall_time_ns)
        .saturating_add(stats.demag_solver_apply_wall_time_ns)
        .saturating_add(stats.demag_recover_wall_time_ns)
        .saturating_add(stats.demag_energy_wall_time_ns);
    let normalized_demag = stats.demag_wall_time_ns.max(demag_subphase_sum);
    let interaction_total = stats
        .exchange_wall_time_ns
        .saturating_add(normalized_demag)
        .saturating_add(stats.extra_energy_wall_time_ns);
    stats
        .snapshot_wall_time_ns
        .max(interaction_total.saturating_add(stats.rhs_wall_time_ns))
        .saturating_add(stats.relaxation_preconditioner_wall_time_ns)
        .saturating_add(stats.relaxation_state_copy_wall_time_ns)
        .saturating_add(stats.relaxation_state_upload_wall_time_ns)
        .saturating_add(stats.relaxation_retraction_wall_time_ns)
        .saturating_add(stats.relaxation_gradient_wall_time_ns)
        .saturating_add(stats.relaxation_metric_wall_time_ns)
        .saturating_add(stats.relaxation_line_search_wall_time_ns)
        .saturating_add(stats.relaxation_update_wall_time_ns)
}

fn sample_kinds(stats: &StepStats, gap_total_ns: u64) -> Vec<SolverProfileSampleKind> {
    let mut kinds = vec![SolverProfileSampleKind::NormalStep];
    if stats.publisher_replace_wall_time_ns > 0 {
        kinds.push(SolverProfileSampleKind::Publish);
    }
    if stats.preview_wall_time_ns > 0 || stats.cached_preview_wall_time_ns > 0 {
        kinds.push(SolverProfileSampleKind::Preview);
    }
    if stats.finalization_wall_time_ns > 0 {
        kinds.push(SolverProfileSampleKind::Finalization);
    }
    if gap_total_ns > stats.wall_time_ns {
        kinds.push(SolverProfileSampleKind::Stall);
    }
    kinds
}

fn unix_time_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SolverProfileAggregates {
    pub sample_count: usize,
    pub average_total_ns: u64,
    pub max_total_ns: u64,
    pub average_exchange_ns: u64,
    pub average_demag_ns: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct SolverProfileOverheadDiagnostics {
    pub last_record_wall_time_ns: u64,
    pub total_record_wall_time_ns: u64,
    pub last_persist_wall_time_ns: u64,
    pub total_persist_wall_time_ns: u64,
    pub last_publisher_replace_wall_time_ns: u64,
    pub total_publisher_replace_wall_time_ns: u64,
    pub heartbeat_seed_deep_clone_count: u64,
    pub heartbeat_worker_deep_clone_count: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct LivePublisherDiagnostics {
    pub replace_count: u64,
    pub publish_count: u64,
    pub coalesced_wake_count: u64,
    pub disconnected_wake_count: u64,
    pub last_payload_estimated_bytes: u64,
    pub max_payload_estimated_bytes: u64,
    pub last_replace_wall_time_ns: u64,
    pub max_replace_wall_time_ns: u64,
    pub total_replace_wall_time_ns: u64,
    pub last_merge_wall_time_ns: u64,
    pub max_merge_wall_time_ns: u64,
    pub total_merge_wall_time_ns: u64,
    pub last_clone_wall_time_ns: u64,
    pub max_clone_wall_time_ns: u64,
    pub total_clone_wall_time_ns: u64,
    pub last_publish_wall_time_ns: u64,
    pub max_publish_wall_time_ns: u64,
    pub total_publish_wall_time_ns: u64,
    pub last_publish_lag_wall_time_ns: u64,
    pub max_publish_lag_wall_time_ns: u64,
    pub total_publish_lag_wall_time_ns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverProfileSnapshot {
    pub revision: u64,
    pub state: String,
    pub config: SolverProfileConfig,
    #[serde(default)]
    pub preview_3d_disabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub threading: Option<SolverProfileThreading>,
    pub latest_samples: Vec<SolverProfileStepSample>,
    pub aggregates: SolverProfileAggregates,
    #[serde(default)]
    pub overhead: SolverProfileOverheadDiagnostics,
    pub artifact_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_publisher: Option<LivePublisherDiagnostics>,
}

#[derive(Debug, Clone, Default)]
struct PendingProfileWindow {
    started_at: Option<Instant>,
    first_step: Option<u64>,
    last_step: u64,
    step_count: u64,
    profiled_step_total_ns: u64,
    native_solver_wall_time_ns: u64,
    phase_windows: Vec<SolverProfilePhaseWindow>,
    sample_kinds: Vec<SolverProfileSampleKind>,
}

#[derive(Debug, Clone)]
pub struct SolverProfileState {
    config: SolverProfileConfig,
    revision: u64,
    samples: VecDeque<SolverProfileStepSample>,
    artifact_refs: Vec<String>,
    last_sampled_instant: Option<Instant>,
    pending_window: PendingProfileWindow,
    overhead: SolverProfileOverheadDiagnostics,
}

impl Default for SolverProfileState {
    fn default() -> Self {
        Self::new(SolverProfileConfig::default())
    }
}

impl SolverProfileState {
    pub fn new(config: SolverProfileConfig) -> Self {
        Self {
            config: config.normalized(),
            revision: 0,
            samples: VecDeque::new(),
            artifact_refs: Vec::new(),
            last_sampled_instant: None,
            pending_window: PendingProfileWindow::default(),
            overhead: SolverProfileOverheadDiagnostics::default(),
        }
    }

    pub fn config(&self) -> &SolverProfileConfig {
        &self.config
    }

    pub fn set_config(&mut self, config: SolverProfileConfig) {
        let config = config.normalized();
        if !config.enabled {
            self.samples.clear();
        }
        self.config = config;
        self.last_sampled_instant = None;
        self.pending_window = PendingProfileWindow::default();
        self.trim_samples();
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn record_step(&mut self, stats: &StepStats) -> Option<SolverProfileStepSample> {
        if !self.config.enabled {
            return None;
        }
        self.record_step_at(stats, Instant::now())
    }

    fn record_step_at(
        &mut self,
        stats: &StepStats,
        now: Instant,
    ) -> Option<SolverProfileStepSample> {
        self.account_step(stats, now);
        if self.config.sample_interval_wall_ms > 0 {
            let threshold = std::time::Duration::from_millis(self.config.sample_interval_wall_ms);
            if let Some(last) = self.last_sampled_instant {
                if now.duration_since(last) < threshold {
                    return None;
                }
            }
            self.last_sampled_instant = Some(now);
        } else if self.config.sample_every > 1 && stats.step % self.config.sample_every != 0 {
            return None;
        }

        Some(self.push_step_sample(stats, now))
    }

    pub fn force_record_step(&mut self, stats: &StepStats) -> Option<SolverProfileStepSample> {
        if !self.config.enabled {
            return None;
        }
        self.force_record_step_at(stats, Instant::now())
    }

    fn force_record_step_at(
        &mut self,
        stats: &StepStats,
        now: Instant,
    ) -> Option<SolverProfileStepSample> {
        let finalization_wall_time_ns = stats
            .finalization_wall_time_ns
            .max(stats.finalization_field_copy_wall_time_ns);
        let finalization_started_at = now
            .checked_sub(std::time::Duration::from_nanos(finalization_wall_time_ns))
            .unwrap_or(now);
        if self.pending_window.step_count > 0 {
            let mut step_only = stats.clone();
            step_only.wall_time_ns = step_only
                .wall_time_ns
                .saturating_sub(finalization_wall_time_ns);
            step_only.finalization_wall_time_ns = 0;
            step_only.finalization_field_copy_wall_time_ns = 0;
            step_only.finalization_field_copy_bytes = 0;
            self.push_step_sample(&step_only, finalization_started_at);
        }
        let mut finalization = StepStats {
            step: stats.step,
            time: stats.time,
            dt: stats.dt,
            wall_time_ns: stats.finalization_wall_time_ns,
            finalization_wall_time_ns: stats.finalization_wall_time_ns,
            finalization_field_copy_wall_time_ns: stats.finalization_field_copy_wall_time_ns,
            finalization_field_copy_bytes: stats.finalization_field_copy_bytes,
            ..StepStats::default()
        };
        finalization.wall_time_ns = finalization_wall_time_ns;
        let mut sample = SolverProfileStepSample::from_step_stats(&finalization);
        sample.span_first_step = stats.step;
        sample.span_last_step = stats.step;
        sample.span_step_count = 0;
        sample.span_monotonic_wall_time_ns = finalization.wall_time_ns;
        sample.profiled_step_total_ns = finalization.wall_time_ns;
        sample.native_solver_wall_time_ns = 0;
        sample.sample_kinds = vec![SolverProfileSampleKind::Finalization];
        sample.phase_windows = sample
            .phases
            .iter()
            .filter(|phase| phase.id == "finalization")
            .map(|phase| SolverProfilePhaseWindow {
                id: phase.id.clone(),
                label: phase.label.clone(),
                sum_wall_time_ns: phase.wall_time_ns,
                mean_wall_time_ns: phase.wall_time_ns,
                max_wall_time_ns: phase.wall_time_ns,
            })
            .collect();
        self.samples.push_back(sample.clone());
        self.trim_samples();
        self.revision = self.revision.wrapping_add(1);
        Some(sample)
    }

    fn account_step(&mut self, stats: &StepStats, now: Instant) {
        let pending = &mut self.pending_window;
        let step_started_at = now
            .checked_sub(std::time::Duration::from_nanos(stats.wall_time_ns))
            .unwrap_or(now);
        pending.started_at.get_or_insert(step_started_at);
        if pending.first_step.is_none() {
            pending.first_step = Some(stats.step);
        }
        if pending.step_count > 0 && pending.last_step == stats.step {
            return;
        }
        pending.last_step = stats.step;
        pending.step_count = pending.step_count.saturating_add(1);
        pending.profiled_step_total_ns = pending
            .profiled_step_total_ns
            .saturating_add(stats.wall_time_ns);
        pending.native_solver_wall_time_ns = pending
            .native_solver_wall_time_ns
            .saturating_add(native_solver_wall_time_ns(stats));

        let step_sample = SolverProfileStepSample::from_step_stats(stats);
        for phase in step_sample
            .phases
            .iter()
            .chain(step_sample.demag_subphases.iter())
        {
            if let Some(window) = pending
                .phase_windows
                .iter_mut()
                .find(|window| window.id == phase.id)
            {
                window.sum_wall_time_ns =
                    window.sum_wall_time_ns.saturating_add(phase.wall_time_ns);
                window.max_wall_time_ns = window.max_wall_time_ns.max(phase.wall_time_ns);
            } else {
                pending.phase_windows.push(SolverProfilePhaseWindow {
                    id: phase.id.clone(),
                    label: phase.label.clone(),
                    sum_wall_time_ns: phase.wall_time_ns,
                    mean_wall_time_ns: 0,
                    max_wall_time_ns: phase.wall_time_ns,
                });
            }
        }
        for kind in sample_kinds(stats, 0) {
            if !pending.sample_kinds.contains(&kind) {
                pending.sample_kinds.push(kind);
            }
        }
    }

    fn push_step_sample(&mut self, stats: &StepStats, now: Instant) -> SolverProfileStepSample {
        let mut sample = SolverProfileStepSample::from_step_stats(stats);
        let has_previous_sample = !self.samples.is_empty();
        let mut pending = std::mem::take(&mut self.pending_window);
        let span_wall_time_ns = pending
            .started_at
            .map(|started_at| duration_ns(now.duration_since(started_at)))
            .unwrap_or(0);
        let gap_total_ns = span_wall_time_ns.saturating_sub(pending.profiled_step_total_ns);
        for phase in &mut pending.phase_windows {
            phase.mean_wall_time_ns = phase.sum_wall_time_ns / pending.step_count.max(1);
        }
        if gap_total_ns > pending.profiled_step_total_ns
            && !pending
                .sample_kinds
                .contains(&SolverProfileSampleKind::Stall)
        {
            pending.sample_kinds.push(SolverProfileSampleKind::Stall);
        }
        sample.span_first_step = pending.first_step.unwrap_or(stats.step);
        sample.span_last_step = pending.last_step;
        sample.span_step_count = pending.step_count;
        sample.span_monotonic_wall_time_ns = span_wall_time_ns;
        sample.profiled_step_total_ns = pending.profiled_step_total_ns;
        sample.native_solver_wall_time_ns = pending.native_solver_wall_time_ns;
        sample.unprofiled_gap_total_ns = gap_total_ns;
        sample.unprofiled_gap_per_step_ns = gap_total_ns / pending.step_count.max(1);
        sample.sample_kinds = pending.sample_kinds;
        sample.phase_windows = pending.phase_windows;
        sample.delta_wall_time_ns = has_previous_sample.then_some(span_wall_time_ns);
        sample.unprofiled_gap_wall_time_ns = has_previous_sample.then_some(gap_total_ns);
        self.samples.push_back(sample.clone());
        self.trim_samples();
        self.revision = self.revision.wrapping_add(1);
        sample
    }

    pub fn add_artifact_ref(&mut self, artifact_ref: impl Into<String>) {
        let artifact_ref = artifact_ref.into();
        if !self
            .artifact_refs
            .iter()
            .any(|existing| existing == &artifact_ref)
        {
            self.artifact_refs.push(artifact_ref);
            self.revision = self.revision.wrapping_add(1);
        }
    }

    pub fn record_overhead(&mut self, record_ns: u64, persist_ns: u64, publisher_ns: u64) {
        self.overhead.last_record_wall_time_ns = record_ns;
        self.overhead.total_record_wall_time_ns = self
            .overhead
            .total_record_wall_time_ns
            .saturating_add(record_ns);
        self.overhead.last_persist_wall_time_ns = persist_ns;
        self.overhead.total_persist_wall_time_ns = self
            .overhead
            .total_persist_wall_time_ns
            .saturating_add(persist_ns);
        self.overhead.last_publisher_replace_wall_time_ns = publisher_ns;
        self.overhead.total_publisher_replace_wall_time_ns = self
            .overhead
            .total_publisher_replace_wall_time_ns
            .saturating_add(publisher_ns);
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn complete_overhead_record(&mut self, record_ns: u64) {
        let delta = record_ns.saturating_sub(self.overhead.last_record_wall_time_ns);
        self.overhead.last_record_wall_time_ns = record_ns;
        self.overhead.total_record_wall_time_ns = self
            .overhead
            .total_record_wall_time_ns
            .saturating_add(delta);
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn record_heartbeat_seed_deep_clone(&mut self) {
        if !self.config.enabled {
            return;
        }
        self.overhead.heartbeat_seed_deep_clone_count = self
            .overhead
            .heartbeat_seed_deep_clone_count
            .saturating_add(1);
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn record_heartbeat_worker_deep_clone(&mut self) {
        if !self.config.enabled {
            return;
        }
        self.overhead.heartbeat_worker_deep_clone_count = self
            .overhead
            .heartbeat_worker_deep_clone_count
            .saturating_add(1);
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn amend_latest_callback_return(
        &mut self,
        step: u64,
        recorded_callback_wall_time_ns: u64,
        callback_wall_time_ns: u64,
    ) {
        let delta = callback_wall_time_ns.saturating_sub(recorded_callback_wall_time_ns);
        if delta == 0 {
            return;
        }
        if self.pending_window.step_count > 0 && self.pending_window.last_step == step {
            self.pending_window.profiled_step_total_ns = self
                .pending_window
                .profiled_step_total_ns
                .saturating_add(delta);
            if let Some(window) = self
                .pending_window
                .phase_windows
                .iter_mut()
                .find(|phase| phase.id == "orchestration")
            {
                window.sum_wall_time_ns = window.sum_wall_time_ns.saturating_add(delta);
                window.max_wall_time_ns = window.max_wall_time_ns.max(callback_wall_time_ns);
            }
            self.revision = self.revision.wrapping_add(1);
            return;
        }
        let Some(sample) = self
            .samples
            .iter_mut()
            .rev()
            .find(|sample| sample.step == step && sample.span_step_count > 0)
        else {
            return;
        };
        if let Some(phase) = sample
            .phases
            .iter_mut()
            .find(|phase| phase.id == "orchestration")
        {
            phase.wall_time_ns = callback_wall_time_ns;
        }
        sample.total_ns = sample.total_ns.saturating_add(delta);
        sample.phase_sum_ns = sample.phase_sum_ns.saturating_add(delta);
        sample.profiled_step_total_ns = sample.profiled_step_total_ns.saturating_add(delta);
        sample.span_monotonic_wall_time_ns =
            sample.span_monotonic_wall_time_ns.saturating_add(delta);
        if let Some(window) = sample
            .phase_windows
            .iter_mut()
            .find(|phase| phase.id == "orchestration")
        {
            window.sum_wall_time_ns = window.sum_wall_time_ns.saturating_add(delta);
            window.max_wall_time_ns = window.max_wall_time_ns.max(callback_wall_time_ns);
            window.mean_wall_time_ns = window.sum_wall_time_ns / sample.span_step_count.max(1);
        }
        for phase in sample
            .phases
            .iter_mut()
            .chain(sample.demag_subphases.iter_mut())
        {
            if phase.id == "unattributed" {
                phase.wall_time_ns = sample.missing_ns;
            }
            phase.percent_of_total = if sample.total_ns > 0 {
                (phase.wall_time_ns as f64 / sample.total_ns as f64) * 100.0
            } else {
                0.0
            };
        }
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn snapshot(&self) -> SolverProfileSnapshot {
        let latest_samples: Vec<_> = self.samples.iter().cloned().collect();
        SolverProfileSnapshot {
            revision: self.revision,
            state: if self.config.enabled {
                "active"
            } else {
                "disabled"
            }
            .to_string(),
            config: self.config.clone(),
            preview_3d_disabled: false,
            threading: latest_samples.last().map(|sample| sample.threading.clone()),
            aggregates: aggregate_samples(&latest_samples),
            overhead: self.overhead.clone(),
            latest_samples,
            artifact_refs: self.artifact_refs.clone(),
            live_publisher: None,
        }
    }

    fn trim_samples(&mut self) {
        while self.samples.len() > self.config.max_samples {
            self.samples.pop_front();
        }
    }
}

fn aggregate_samples(samples: &[SolverProfileStepSample]) -> SolverProfileAggregates {
    if samples.is_empty() {
        return SolverProfileAggregates::default();
    }
    let sample_count = samples.len();
    let total_sum: u128 = samples.iter().map(|sample| sample.total_ns as u128).sum();
    let exchange_sum: u128 = samples
        .iter()
        .map(|sample| phase_time(&sample.phases, "exchange") as u128)
        .sum();
    let demag_sum: u128 = samples
        .iter()
        .map(|sample| phase_time(&sample.phases, "demag_total") as u128)
        .sum();
    SolverProfileAggregates {
        sample_count,
        average_total_ns: (total_sum / sample_count as u128) as u64,
        max_total_ns: samples
            .iter()
            .map(|sample| sample.total_ns)
            .max()
            .unwrap_or(0),
        average_exchange_ns: (exchange_sum / sample_count as u128) as u64,
        average_demag_ns: (demag_sum / sample_count as u128) as u64,
    }
}

fn phase(id: &str, label: &str, wall_time_ns: u64, total_ns: u64) -> SolverProfilePhaseSample {
    SolverProfilePhaseSample {
        id: id.to_string(),
        label: label.to_string(),
        wall_time_ns,
        percent_of_total: if total_ns > 0 {
            (wall_time_ns as f64 / total_ns as f64) * 100.0
        } else {
            0.0
        },
    }
}

fn phase_time(phases: &[SolverProfilePhaseSample], id: &str) -> u64 {
    phases
        .iter()
        .find(|phase| phase.id == id)
        .map(|phase| phase.wall_time_ns)
        .unwrap_or(0)
}

fn format_duration_ns(ns: u64) -> String {
    if ns >= 1_000_000_000 {
        format!("{:.3}s", ns as f64 / 1_000_000_000.0)
    } else if ns >= 1_000_000 {
        format!("{:.3}ms", ns as f64 / 1_000_000.0)
    } else if ns >= 1_000 {
        format!("{:.3}us", ns as f64 / 1_000.0)
    } else {
        format!("{ns}ns")
    }
}

fn format_bytes(value: u64) -> String {
    if value >= 1_073_741_824 {
        return format!("{:.2}GiB", value as f64 / 1_073_741_824.0);
    }
    if value >= 1_048_576 {
        return format!("{:.1}MiB", value as f64 / 1_048_576.0);
    }
    if value >= 1024 {
        return format!("{:.1}KiB", value as f64 / 1024.0);
    }
    format!("{value}B")
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::{native_solver_wall_time_ns, phase_time, SolverProfileConfig, SolverProfileState};
    use crate::types::StepStats;

    fn enabled_profile(sample_every: u64) -> SolverProfileState {
        SolverProfileState::new(SolverProfileConfig {
            enabled: true,
            sample_every,
            sample_interval_wall_ms: 0,
            max_samples: 8,
            emit_engine_log: false,
            persist_artifact: false,
        })
    }

    #[test]
    fn sparse_sample_is_one_closed_monotonic_step_interval() {
        let mut profile = enabled_profile(13);
        let start = Instant::now();

        assert!(profile
            .record_step_at(
                &StepStats {
                    step: 11,
                    wall_time_ns: 10_000_000,
                    ..StepStats::default()
                },
                start,
            )
            .is_none());
        assert!(profile
            .record_step_at(
                &StepStats {
                    step: 12,
                    wall_time_ns: 10_000_000,
                    ..StepStats::default()
                },
                start + Duration::from_millis(40),
            )
            .is_none());
        let sample = profile
            .record_step_at(
                &StepStats {
                    step: 13,
                    wall_time_ns: 10_000_000,
                    ..StepStats::default()
                },
                start + Duration::from_millis(100),
            )
            .expect("step 13 should close the interval");

        assert_eq!(sample.span_first_step, 11);
        assert_eq!(sample.span_last_step, 13);
        assert_eq!(sample.span_step_count, 3);
        // Step 11 completed at `start` after 10 ms of work, so the closed
        // interval begins at its inferred execution start and ends at step 13.
        assert_eq!(sample.span_monotonic_wall_time_ns, 110_000_000);
        assert_eq!(sample.profiled_step_total_ns, 30_000_000);
        assert_eq!(sample.unprofiled_gap_total_ns, 80_000_000);
        assert_eq!(sample.unprofiled_gap_per_step_ns, 26_666_666);
    }

    #[test]
    fn monotonic_span_is_independent_of_backwards_unix_clock() {
        let mut profile = enabled_profile(2);
        let start = Instant::now();
        assert!(profile
            .record_step_at(
                &StepStats {
                    step: 1,
                    ..StepStats::default()
                },
                start
            )
            .is_none());
        let first = profile
            .record_step_at(
                &StepStats {
                    step: 2,
                    ..StepStats::default()
                },
                start + Duration::from_millis(10),
            )
            .expect("step 2 should close the first interval");
        assert_eq!(first.span_monotonic_wall_time_ns, 10_000_000);
        profile.samples.back_mut().unwrap().sample_time_unix_ms = u64::MAX;

        assert!(profile
            .record_step_at(
                &StepStats {
                    step: 3,
                    ..StepStats::default()
                },
                start + Duration::from_millis(20),
            )
            .is_none());
        let second = profile
            .record_step_at(
                &StepStats {
                    step: 4,
                    ..StepStats::default()
                },
                start + Duration::from_millis(30),
            )
            .expect("step 4 should close the second interval");

        assert!(second.span_monotonic_wall_time_ns > 0);
        assert!(second.sample_time_unix_ms < u64::MAX);
    }

    #[test]
    fn sample_every_one_encloses_nonzero_step_work() {
        let mut profile = enabled_profile(1);
        let sample = profile
            .record_step_at(
                &StepStats {
                    step: 1,
                    wall_time_ns: 7_000_000,
                    ..StepStats::default()
                },
                Instant::now(),
            )
            .unwrap();
        assert_eq!(sample.span_step_count, 1);
        assert_eq!(sample.span_monotonic_wall_time_ns, 7_000_000);
        assert_eq!(sample.unprofiled_gap_total_ns, 0);
    }

    #[test]
    fn native_total_uses_snapshot_enclosure_then_sequential_rhs_and_relaxation() {
        let stats = StepStats {
            snapshot_wall_time_ns: 30,
            exchange_wall_time_ns: 10,
            demag_wall_time_ns: 4,
            demag_assemble_wall_time_ns: 3,
            demag_solver_apply_wall_time_ns: 5,
            extra_energy_wall_time_ns: 6,
            rhs_wall_time_ns: 7,
            relaxation_gradient_wall_time_ns: 11,
            relaxation_update_wall_time_ns: 13,
            ..StepStats::default()
        };
        assert_eq!(native_solver_wall_time_ns(&stats), 55);
        assert_eq!(
            native_solver_wall_time_ns(&StepStats {
                snapshot_wall_time_ns: 0,
                exchange_wall_time_ns: 10,
                rhs_wall_time_ns: 7,
                ..StepStats::default()
            }),
            17
        );
        assert_eq!(
            native_solver_wall_time_ns(&StepStats {
                snapshot_wall_time_ns: 50,
                exchange_wall_time_ns: 10,
                rhs_wall_time_ns: 7,
                relaxation_update_wall_time_ns: 13,
                ..StepStats::default()
            }),
            63
        );
    }

    #[test]
    fn forced_finalization_never_recounts_the_last_step() {
        let mut profile = enabled_profile(1);
        let completion = Instant::now();
        profile
            .record_step_at(
                &StepStats {
                    step: 9,
                    wall_time_ns: 100,
                    rhs_wall_time_ns: 40,
                    ..StepStats::default()
                },
                completion,
            )
            .unwrap();
        let finalization = profile
            .force_record_step_at(
                &StepStats {
                    step: 9,
                    wall_time_ns: 100,
                    rhs_wall_time_ns: 40,
                    finalization_wall_time_ns: 17,
                    ..StepStats::default()
                },
                completion + Duration::from_nanos(17),
            )
            .unwrap();
        assert_eq!(finalization.span_step_count, 0);
        assert_eq!(finalization.profiled_step_total_ns, 17);
        assert_eq!(finalization.native_solver_wall_time_ns, 0);
        assert_eq!(phase_time(&finalization.phases, "rhs_total"), 0);
        assert_eq!(phase_time(&finalization.phases, "finalization"), 17);
    }

    #[test]
    fn forced_finalization_flushes_a_pending_step_once_then_appends_one_event() {
        let mut profile = enabled_profile(2);
        let start = Instant::now();
        profile
            .record_step_at(
                &StepStats {
                    step: 2,
                    wall_time_ns: 10,
                    ..StepStats::default()
                },
                start,
            )
            .unwrap();
        assert!(profile
            .record_step_at(
                &StepStats {
                    step: 3,
                    wall_time_ns: 20,
                    ..StepStats::default()
                },
                start + Duration::from_nanos(20)
            )
            .is_none());
        profile
            .force_record_step_at(
                &StepStats {
                    step: 3,
                    wall_time_ns: 20,
                    finalization_wall_time_ns: 5,
                    ..StepStats::default()
                },
                start + Duration::from_nanos(25),
            )
            .unwrap();
        let samples = profile.snapshot().latest_samples;
        assert_eq!(samples.len(), 3);
        assert_eq!(samples[1].span_step_count, 1);
        assert_eq!(samples[1].profiled_step_total_ns, 20);
        assert_eq!(samples[1].span_monotonic_wall_time_ns, 20);
        assert_eq!(samples[1].unprofiled_gap_total_ns, 0);
        assert_eq!(samples[1].total_ns, 15);
        assert_eq!(samples[1].missing_ns, 15);
        assert_eq!(samples[2].span_step_count, 0);
        assert_eq!(samples[2].profiled_step_total_ns, 5);
        assert_eq!(samples[2].span_monotonic_wall_time_ns, 5);
    }

    #[test]
    fn callback_return_amends_an_emitted_sample_without_creating_gap() {
        let mut profile = enabled_profile(1);
        profile
            .record_step_at(
                &StepStats {
                    step: 4,
                    wall_time_ns: 20,
                    orchestration_wall_time_ns: 5,
                    ..StepStats::default()
                },
                Instant::now(),
            )
            .unwrap();
        profile.amend_latest_callback_return(4, 5, 11);
        let sample = profile.snapshot().latest_samples.pop().unwrap();
        assert_eq!(phase_time(&sample.phases, "orchestration"), 11);
        assert_eq!(sample.profiled_step_total_ns, 26);
        assert_eq!(sample.span_monotonic_wall_time_ns, 26);
        assert_eq!(sample.unprofiled_gap_total_ns, 0);
        for phase in sample.phases.iter().chain(sample.demag_subphases.iter()) {
            let expected = (phase.wall_time_ns as f64 / sample.total_ns as f64) * 100.0;
            assert!((phase.percent_of_total - expected).abs() < 1.0e-12);
        }
        let unattributed = sample
            .phases
            .iter()
            .find(|phase| phase.id == "unattributed")
            .unwrap();
        assert_eq!(unattributed.wall_time_ns, sample.missing_ns);
    }

    #[test]
    fn callback_return_amends_a_pending_sparse_interval() {
        let mut profile = enabled_profile(2);
        let start = Instant::now();
        assert!(profile
            .record_step_at(
                &StepStats {
                    step: 1,
                    wall_time_ns: 20,
                    orchestration_wall_time_ns: 5,
                    ..StepStats::default()
                },
                start,
            )
            .is_none());
        profile.amend_latest_callback_return(1, 5, 11);
        let sample = profile
            .record_step_at(
                &StepStats {
                    step: 2,
                    wall_time_ns: 10,
                    ..StepStats::default()
                },
                start + Duration::from_nanos(16),
            )
            .unwrap();
        assert_eq!(sample.profiled_step_total_ns, 36);
        assert_eq!(sample.unprofiled_gap_total_ns, 0);
        assert_eq!(
            sample
                .phase_windows
                .iter()
                .find(|window| window.id == "orchestration")
                .unwrap()
                .sum_wall_time_ns,
            11
        );
    }

    #[test]
    fn asynchronous_heartbeat_clone_owners_are_counted_separately() {
        let mut profile = enabled_profile(1);
        profile.record_heartbeat_seed_deep_clone();
        profile.record_heartbeat_worker_deep_clone();
        profile.record_heartbeat_worker_deep_clone();
        let overhead = profile.snapshot().overhead;
        assert_eq!(overhead.heartbeat_seed_deep_clone_count, 1);
        assert_eq!(overhead.heartbeat_worker_deep_clone_count, 2);
    }

    #[test]
    fn additive_interval_fields_default_for_an_old_serialized_sample() {
        let sample = super::SolverProfileStepSample::from_step_stats(&StepStats::default());
        let mut old = serde_json::to_value(sample).unwrap();
        let object = old.as_object_mut().unwrap();
        for key in [
            "span_first_step",
            "span_last_step",
            "span_step_count",
            "span_monotonic_wall_time_ns",
            "profiled_step_total_ns",
            "native_solver_wall_time_ns",
            "unprofiled_gap_total_ns",
            "unprofiled_gap_per_step_ns",
            "sample_kinds",
            "phase_windows",
            "step_update_deep_clone_count",
        ] {
            object.remove(key);
        }
        let decoded: super::SolverProfileStepSample = serde_json::from_value(old).unwrap();
        assert_eq!(decoded.span_step_count, 0);
        assert!(decoded.phase_windows.is_empty());
        assert_eq!(decoded.step_update_deep_clone_count, 0);
    }
}
