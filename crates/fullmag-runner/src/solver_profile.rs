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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SolverProfileStepSample {
    pub step: u64,
    pub sample_time_unix_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta_wall_time_ns: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unprofiled_gap_wall_time_ns: Option<u64>,
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
        let phase_sum_ns = stats
            .exchange_wall_time_ns
            .saturating_add(stats.rhs_wall_time_ns)
            .saturating_add(demag_total_ns)
            .saturating_add(stats.extra_energy_wall_time_ns)
            .saturating_add(stats.snapshot_wall_time_ns)
            .saturating_add(stats.relaxation_preconditioner_wall_time_ns)
            .saturating_add(stats.relaxation_state_copy_wall_time_ns)
            .saturating_add(stats.relaxation_state_upload_wall_time_ns)
            .saturating_add(stats.relaxation_retraction_wall_time_ns)
            .saturating_add(stats.relaxation_gradient_wall_time_ns)
            .saturating_add(stats.relaxation_metric_wall_time_ns)
            .saturating_add(stats.relaxation_line_search_wall_time_ns)
            .saturating_add(stats.relaxation_update_wall_time_ns)
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
            threading: SolverProfileThreading::from_stats(stats),
        }
    }

    pub fn compact_log_line(&self) -> String {
        format!(
            "solver-profile step={} total={} delta={} gap={} exchange={} demag={} demag.solve={} demag.policy={}/{} relax_preconditioner={} relax_prec_cache={}/{} native_ffi={} rhs={} preview={} cache={} field_copy={} artifact_enqueue={} artifact_writer={}/{} finalization={} orchestration={} sync={} gpu_sync={} control_scalar_sync={} control_scalar_d2h={} omp={}/{} omp_reason={}",
            self.step,
            format_duration_ns(self.total_ns),
            self.delta_wall_time_ns
                .map(format_duration_ns)
                .unwrap_or_else(|| "n/a".to_string()),
            self.unprofiled_gap_wall_time_ns
                .map(format_duration_ns)
                .unwrap_or_else(|| "n/a".to_string()),
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
    pub artifact_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub live_publisher: Option<LivePublisherDiagnostics>,
}

#[derive(Debug, Clone)]
pub struct SolverProfileState {
    config: SolverProfileConfig,
    revision: u64,
    samples: VecDeque<SolverProfileStepSample>,
    artifact_refs: Vec<String>,
    last_sampled_instant: Option<Instant>,
    profiled_wall_time_since_sample_ns: u64,
    pending_step_total: Option<(u64, u64)>,
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
            profiled_wall_time_since_sample_ns: 0,
            pending_step_total: None,
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
        self.profiled_wall_time_since_sample_ns = 0;
        self.pending_step_total = None;
        self.trim_samples();
        self.revision = self.revision.wrapping_add(1);
    }

    pub fn record_step(&mut self, stats: &StepStats) -> Option<SolverProfileStepSample> {
        if !self.config.enabled {
            return None;
        }
        self.account_step_total(stats);
        if self.config.sample_interval_wall_ms > 0 {
            let now = Instant::now();
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

        Some(self.push_step_sample(stats))
    }

    pub fn force_record_step(&mut self, stats: &StepStats) -> Option<SolverProfileStepSample> {
        if !self.config.enabled {
            return None;
        }
        self.account_step_total(stats);
        Some(self.push_step_sample(stats))
    }

    fn account_step_total(&mut self, stats: &StepStats) {
        if self.samples.is_empty()
            || (self.pending_step_total.is_none()
                && self.samples.back().map(|sample| sample.step) == Some(stats.step))
        {
            return;
        }
        if let Some((step, previous_total_ns)) = self.pending_step_total {
            if step == stats.step {
                self.profiled_wall_time_since_sample_ns = self
                    .profiled_wall_time_since_sample_ns
                    .saturating_sub(previous_total_ns)
                    .saturating_add(stats.wall_time_ns);
                self.pending_step_total = Some((stats.step, stats.wall_time_ns));
                return;
            }
        }
        self.profiled_wall_time_since_sample_ns = self
            .profiled_wall_time_since_sample_ns
            .saturating_add(stats.wall_time_ns);
        self.pending_step_total = Some((stats.step, stats.wall_time_ns));
    }

    fn push_step_sample(&mut self, stats: &StepStats) -> SolverProfileStepSample {
        let mut sample = SolverProfileStepSample::from_step_stats(stats);
        sample.delta_wall_time_ns = self.samples.back().and_then(|previous| {
            sample
                .sample_time_unix_ms
                .checked_sub(previous.sample_time_unix_ms)
                .map(|delta_ms| delta_ms.saturating_mul(1_000_000))
        });
        sample.unprofiled_gap_wall_time_ns = sample
            .delta_wall_time_ns
            .map(|delta| delta.saturating_sub(self.profiled_wall_time_since_sample_ns));
        self.samples.push_back(sample.clone());
        self.profiled_wall_time_since_sample_ns = 0;
        self.pending_step_total = None;
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
